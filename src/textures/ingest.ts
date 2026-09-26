import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';
import { AppError } from '../errors.js';
import { sha256Hex } from '../util/crypto.js';
import { blobStorageKey } from '../storage/keys.js';
import type { StoragePort } from '../storage/types.js';
import {
  BlobRepository,
  type BlobRow,
} from '../repositories/blobRepository.js';
import {
  AssetRepository,
  type AssetKind,
  type AssetRow,
  type ModelType,
} from '../repositories/assetRepository.js';
import type { ProfileRepository } from '../repositories/profileRepository.js';

/**
 * IngestTextureService（蓝图 P2）：皮肤/披风上传的唯一入口。
 * 统一 plan3 中两条重复的上传路径：
 *   校验（PNG/尺寸/大小）→ sha256 去重 → 存储写入 → 单事务落库（blob + asset）
 *
 * 校验规则：
 * - 必须 PNG，≤ 2MB
 * - 皮肤：64x64（现代）或 64x32（旧版兼容）
 * - 披风：64x32
 * - model_type 仅皮肤允许（default/slim），披风必须为空（schema CHECK 同款约束）
 * - 相同 sha256 不再写文件、复用已有 blob（验收：相同文件不重复保存）
 */

const MAX_BYTES = 2 * 1024 * 1024;
const SKIN_DIMENSIONS: ReadonlyArray<readonly [number, number]> = [
  [64, 64],
  [64, 32],
];
const CAPE_DIMENSIONS: ReadonlyArray<readonly [number, number]> = [[64, 32]];

export interface IngestInput {
  ownerUserId: string;
  kind: AssetKind;
  modelType?: ModelType | null;
  name: string;
  description?: string;
  license?: string;
  aiGenerated?: boolean;
  /** 上传时即指定可见性（Web 上传表单的「权限设置」）；省略则私有 */
  visibility?: 'private' | 'public';
  /** 上传时即指定下载策略；省略则仅本人可下载 */
  downloadPolicy?: 'owner_only' | 'public';
  buffer: Buffer;
}

export interface IngestResult {
  asset: AssetRow;
  blob: BlobRow;
  /** true = 命中 sha256 去重，未重复写文件/建 blob */
  deduped: boolean;
}

export class IngestError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
    this.name = 'IngestError';
  }
}

export interface TextureServiceDependencies {
  db: DatabaseConnection;
  storage: StoragePort;
  blobs: BlobRepository;
  assets: AssetRepository;
  profiles: ProfileRepository;
}

export class TextureService {
  private readonly db: DatabaseConnection;
  private readonly storage: StoragePort;
  private readonly blobs: BlobRepository;
  private readonly assets: AssetRepository;
  private readonly profiles: ProfileRepository;

  constructor(deps: TextureServiceDependencies) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.blobs = deps.blobs;
    this.assets = deps.assets;
    this.profiles = deps.profiles;
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const { buffer, kind } = input;

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new IngestError('缺少文件内容');
    }
    if (buffer.length > MAX_BYTES) {
      throw new IngestError('文件超过 2MB 限制');
    }

    let width: number;
    let height: number;
    try {
      const meta = await sharp(buffer).metadata();
      if (meta.format !== 'png') {
        throw new IngestError('只接受 PNG 格式');
      }
      width = meta.width!;
      height = meta.height!;
    } catch (err) {
      if (err instanceof IngestError) throw err;
      throw new IngestError('无法解析图片内容');
    }

    const allowed =
      kind === 'skin' ? SKIN_DIMENSIONS : CAPE_DIMENSIONS;
    if (!allowed.some(([w, h]) => w === width && h === height)) {
      throw new IngestError(
        kind === 'skin'
          ? '皮肤尺寸必须为 64x64 或 64x32'
          : '披风尺寸必须为 64x32',
      );
    }

    if (kind === 'cape' && input.modelType != null) {
      throw new IngestError('披风没有模型类型');
    }
    if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 64) {
      throw new IngestError('素材名称必填且不超过 64 字符');
    }

    // 上传即指定权限（Web 上传表单）；与 updateOwnerFields 的取值域保持一致
    if (
      input.visibility !== undefined &&
      input.visibility !== 'private' &&
      input.visibility !== 'public'
    ) {
      throw new IngestError('visibility 必须为 private 或 public');
    }
    if (
      input.downloadPolicy !== undefined &&
      input.downloadPolicy !== 'owner_only' &&
      input.downloadPolicy !== 'public'
    ) {
      throw new IngestError('downloadPolicy 必须为 owner_only 或 public');
    }

    // sha256 去重：命中则复用 blob，不重复写文件
    const sha = sha256Hex(buffer);
    const existing = await this.blobs.findBySha256(sha);
    let blob: BlobRow;
    let deduped = false;

    if (existing) {
      blob = existing;
      deduped = true;
    } else {
      const id = randomUUID();
      const contentType = 'image/png';
      const storageKey = blobStorageKey(sha);
      await this.storage.put(storageKey, new Uint8Array(buffer), contentType);
      blob = {
        id,
        sha256: sha,
        storageKey,
        contentType,
        byteSize: buffer.length,
        width,
        height,
        createdAt: new Date().toISOString(),
      };
      await this.blobs.insert({ ...blob, now: new Date() });
    }

    const assetId = randomUUID();
    const now = new Date();
    await this.assets.insert({
      id: assetId,
      ownerUserId: input.ownerUserId,
      kind,
      blobId: blob.id,
      modelType: kind === 'skin' ? (input.modelType ?? 'default') : null,
      name: input.name.trim(),
      description: input.description,
      license: input.license,
      visibility: input.visibility,
      downloadPolicy: input.downloadPolicy,
      now,
    });

    const asset = (await this.assets.findById(assetId))!;
    return { asset, blob, deduped };
  }

  /** 应用到角色槽位（衣柜语义：同槽覆盖）。素材与角色都必须归当前用户所有 */
  async applyToProfile(input: {
    userId: string;
    assetId: string;
    profileId: string;
    slot: AssetKind;
  }): Promise<void> {
    const asset = await this.assets.findById(input.assetId);
    if (!asset || asset.ownerUserId !== input.userId) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    if (asset.kind !== input.slot) {
      throw new AppError('VALIDATION_ERROR', `槽位类型不匹配：该素材是 ${asset.kind}`);
    }
    const profile = await this.profiles.findById(input.profileId);
    if (!profile || profile.userId !== input.userId) {
      throw new AppError('NOT_FOUND', '角色不存在');
    }
    await this.assets.assign(
      randomUUID(),
      profile.id,
      asset.id,
      input.slot,
      new Date(),
    );
  }

  /** 摘下角色槽位上的纹理 */
  async removeFromProfile(input: {
    userId: string;
    profileId: string;
    slot: AssetKind;
  }): Promise<void> {
    const profile = await this.profiles.findById(input.profileId);
    if (!profile || profile.userId !== input.userId) {
      throw new AppError('NOT_FOUND', '角色不存在');
    }
    await this.assets.unassign(input.profileId, input.slot);
  }

  /** owner 修改素材元数据（可见性 / 下载策略 / 名称 / 描述） */
  async updateOwnerFields(
    userId: string,
    assetId: string,
    fields: {
      name?: string;
      description?: string;
      visibility?: 'private' | 'public';
      downloadPolicy?: 'owner_only' | 'public';
    },
  ): Promise<void> {
    const asset = await this.assets.findById(assetId);
    if (!asset || asset.ownerUserId !== userId) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    const patch: Parameters<AssetRepository['updateOwnerFields']>[1] = {};
    if (fields.name !== undefined) {
      const name = String(fields.name).trim();
      if (name.length === 0 || name.length > 64) {
        throw new AppError('VALIDATION_ERROR', '素材名称必填且不超过 64 字符');
      }
      patch.name = name;
    }
    if (fields.description !== undefined) {
      patch.description = String(fields.description);
    }
    if (fields.visibility !== undefined) {
      if (fields.visibility !== 'private' && fields.visibility !== 'public') {
        throw new AppError('VALIDATION_ERROR', 'visibility 必须为 private 或 public');
      }
      patch.visibility = fields.visibility;
    }
    if (fields.downloadPolicy !== undefined) {
      if (fields.downloadPolicy !== 'owner_only' && fields.downloadPolicy !== 'public') {
        throw new AppError('VALIDATION_ERROR', 'downloadPolicy 必须为 owner_only 或 public');
      }
      patch.downloadPolicy = fields.downloadPolicy;
    }
    await this.assets.updateOwnerFields(assetId, patch, new Date());
  }

  /**
   * 删除素材：profile_assets 由 FK CASCADE 解绑；blob 在无引用后连带删除，
   * 保证"删除不留下不可追踪的对象"（蓝图 P2 验收）。
   */
  async deleteAsset(userId: string, assetId: string): Promise<void> {
    const asset = await this.assets.findById(assetId);
    if (!asset || asset.ownerUserId !== userId) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    await this.assets.delete(asset.id);

    if ((await this.blobs.countAssetReferences(asset.blobId)) === 0) {
      const blob = await this.blobs.findById(asset.blobId);
      await this.blobs.delete(asset.blobId);
      if (blob) {
        await this.storage.delete(blob.storageKey);
      }
    }
  }
}
