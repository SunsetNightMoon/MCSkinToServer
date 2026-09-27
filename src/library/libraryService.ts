import type {
  AssetRepository,
  AssetKind,
  AssetRow,
} from '../repositories/assetRepository.js';
import type { FavoriteRepository } from '../repositories/favoriteRepository.js';
import type { BlobRepository } from '../repositories/blobRepository.js';
import type { UserRepository } from '../repositories/userRepository.js';
import type { AssetUrlResolver } from '../storage/assetUrl.js';
import type { RequestContext } from '../auth/tokens.js';
import { AppError } from '../errors.js';
import { requireCanonicalUuid } from '../util/uuid.js';

/**
 * 公开库 / 收藏 / 审核 领域服务（蓝图 P3）。
 *
 * 权限矩阵（验收标准）：
 * - 查看：approved+public → 任何人；其余（pending/rejected/private）→ owner 或 admin
 * - 下载：download_policy=public 且 approved → 任何人；owner_only → owner/admin
 * - 收藏：仅 approved+public，且不能收藏自己的素材（route-inventory §5 领域规则）
 * - 审核：admin / super_admin；rejected 素材自动从公开库与 Yggdrasil 纹理响应消失
 *   （纹理链路已在仓储层排除 rejected）
 *
 * 收藏计数语义：真实收藏计数，不做"发布者默认 +1"（plan3 语义废弃，route-inventory §5
 * 明确要求重制时写入领域服务）。
 */

export type ViewerRole = RequestContext['role'] | null;

export function isAdminRole(role: ViewerRole): boolean {
  return role === 'admin' || role === 'super_admin';
}

export interface LibraryItem {
  id: string;
  kind: AssetKind;
  name: string;
  modelType: 'default' | 'slim' | null;
  license: string;
  aiGenerated: boolean;
  adminWarning: string | null;
  previewUrl: string;
  viewCount: number;
  downloadCount: number;
  favoriteCount: number;
  createdAt: string;
}

export interface LibraryPage {
  items: LibraryItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LibraryDependencies {
  assets: AssetRepository;
  favorites: FavoriteRepository;
  blobs: BlobRepository;
  users: UserRepository;
  resolver: AssetUrlResolver;
  /** 时钟可注入 */
  now?: () => Date;
}

function toLibraryItem(
  asset: AssetRow,
  previewUrl: string,
  favoriteCount: number,
): LibraryItem {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    modelType: asset.modelType,
    license: asset.license,
    aiGenerated: asset.aiGenerated,
    adminWarning: asset.adminWarning,
    previewUrl,
    viewCount: asset.viewCount,
    downloadCount: asset.downloadCount,
    favoriteCount,
    createdAt: asset.createdAt,
  };
}

export class LibraryService {
  private readonly assets: AssetRepository;
  private readonly favorites: FavoriteRepository;
  private readonly blobs: BlobRepository;
  private readonly users: UserRepository;
  private readonly resolver: AssetUrlResolver;
  private readonly now: () => Date;

  constructor(deps: LibraryDependencies) {
    this.assets = deps.assets;
    this.favorites = deps.favorites;
    this.blobs = deps.blobs;
    this.users = deps.users;
    this.resolver = deps.resolver;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * asset → 对外取件 URL。
   *
   * 公开给仓储/HTTP 层用（管理端列表与「我的素材」都要直出 previewUrl，
   * 见 `withPreviewUrls`）：它是唯一知道「blob → storageKey → publicUrl」这条链路的地方，
   * 别处再实现一遍必然漂移。
   *
   * **不碰浏览计数** —— 计数只在 `getDetail` 里做（那才是「有人打开了详情页」）。
   */
  async previewUrl(asset: AssetRow): Promise<string | null> {
    const blob = await this.blobs.findById(asset.blobId);
    return blob ? this.resolver.forBlob(blob) : null;
  }

  /**
   * 给一批资产补 `previewUrl`（**不含**任何计数副作用）。
   *
   * 为什么必须有这个批量方法：列表接口原先只返回裸 `AssetRow`，
   * 前端为了拿到图片地址只能对**每一项**再调一次 `GET /api/assets/:id` ——
   * 而那个端点会 `incrementViewCount`，于是「翻一页列表 = 每项浏览数 +1」，
   * 浏览数完全失真。列表接口直接给图片地址，这条路就不必再走。
   */
  async withPreviewUrls<T extends AssetRow>(
    assets: readonly T[],
  ): Promise<Array<T & { previewUrl: string | null }>> {
    const out: Array<T & { previewUrl: string | null }> = [];
    for (const asset of assets) {
      out.push({ ...asset, previewUrl: await this.previewUrl(asset) });
    }
    return out;
  }

  isPubliclyVisible(asset: AssetRow): boolean {
    return asset.visibility === 'public' && asset.reviewStatus === 'approved';
  }

  canView(asset: AssetRow, viewer: RequestContext | null): boolean {
    if (this.isPubliclyVisible(asset)) return true;
    if (!viewer) return false;
    return asset.ownerUserId === viewer.userId || isAdminRole(viewer.role);
  }

  async canDownload(asset: AssetRow, viewer: RequestContext | null): Promise<boolean> {
    // rejected 素材任何人都不可下载（含 owner），避免被拒内容继续流通
    if (asset.reviewStatus === 'rejected') return false;
    if (asset.downloadPolicy === 'public' && asset.reviewStatus === 'approved') {
      return true;
    }
    if (!viewer) return false;
    return asset.ownerUserId === viewer.userId || isAdminRole(viewer.role);
  }

  /** 公开库分页 */
  async listLibrary(input: {
    kind: AssetKind;
    page: number;
    pageSize: number;
    sort: 'latest' | 'views' | 'downloads';
    search?: string;
  }): Promise<LibraryPage> {
    const { items, total } = await this.assets.listPublic(input.kind, {
      page: input.page,
      pageSize: input.pageSize,
      sort: input.sort,
      search: input.search,
    });
    const counts = await this.favorites.countByAssets(items.map((a) => a.id));
    const libItems: LibraryItem[] = [];
    for (const asset of items) {
      const url = await this.previewUrl(asset);
      if (!url) continue;
      libItems.push(toLibraryItem(asset, url, counts.get(asset.id) ?? 0));
    }
    return {
      items: libItems,
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  /** 统一详情：权限矩阵 + 公开可见时浏览计数 +1（响应返回自增后的最新计数） */
  async getDetail(
    assetId: string,
    viewer: RequestContext | null,
  ): Promise<Record<string, unknown>> {
    // 格式闸门：非规范 UUID 与「素材不存在」同响应（PG 的 uuid 列会为此抛 22P02 → 兜底 500）
    requireCanonicalUuid(assetId, '素材不存在');
    const existing = await this.assets.findById(assetId);
    if (!existing || !this.canView(existing, viewer)) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    if (this.isPubliclyVisible(existing)) {
      await this.assets.incrementViewCount(existing.id);
    }
    const asset = (await this.assets.findById(assetId))!;
    const url = await this.previewUrl(asset);
    if (!url) throw new AppError('NOT_FOUND', '素材不存在');
    const favoriteCount = await this.favorites.countByAsset(asset.id);
    const owner = await this.users.findById(asset.ownerUserId);
    const isFavorited = viewer
      ? await this.favorites.exists(viewer.userId, asset.id)
      : false;
    return {
      asset: {
        ...toLibraryItem(asset, url, favoriteCount),
        description: asset.description,
        ownerUid: owner?.userUid ?? null,
        visibility: asset.visibility,
        reviewStatus: asset.reviewStatus,
        downloadPolicy: asset.downloadPolicy,
      },
      isFavorited,
      canDownload: await this.canDownload(asset, viewer),
    };
  }

  /** 下载：通过权限矩阵后 download_count +1，返回取件 URL */
  async download(
    assetId: string,
    viewer: RequestContext | null,
  ): Promise<string> {
    requireCanonicalUuid(assetId, '素材不存在');
    const asset = await this.assets.findById(assetId);
    if (!asset) throw new AppError('NOT_FOUND', '素材不存在');
    if (!(await this.canDownload(asset, viewer))) {
      throw new AppError('DOWNLOAD_FORBIDDEN', '无下载权限');
    }
    await this.assets.incrementDownloadCount(asset.id);
    const url = await this.previewUrl(asset);
    if (!url) throw new AppError('NOT_FOUND', '素材不存在');
    return url;
  }

  /** 收藏（不能收藏自己的素材；幂等） */
  async favorite(viewer: RequestContext, assetId: string): Promise<void> {
    requireCanonicalUuid(assetId, '素材不存在');
    const asset = await this.assets.findById(assetId);
    if (!asset || !this.isPubliclyVisible(asset)) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    if (asset.ownerUserId === viewer.userId) {
      throw new AppError('VALIDATION_ERROR', '不能收藏自己的素材');
    }
    if (await this.favorites.exists(viewer.userId, assetId)) return;
    await this.favorites.insert(viewer.userId, assetId, this.now());
  }

  /** 取消收藏（幂等；目标不存在时同样幂等地成功） */
  async unfavorite(viewer: RequestContext, assetId: string): Promise<void> {
    requireCanonicalUuid(assetId, '素材不存在');
    await this.favorites.delete(viewer.userId, assetId);
  }

  async getFavoriteCount(assetId: string): Promise<number> {
    requireCanonicalUuid(assetId, '素材不存在');
    return this.favorites.countByAsset(assetId);
  }

  async isFavorited(viewer: RequestContext, assetId: string): Promise<boolean> {
    requireCanonicalUuid(assetId, '素材不存在');
    return this.favorites.exists(viewer.userId, assetId);
  }

  // ---- 审核（admin / super_admin）----

  /** 审批：更新状态 + 写入审核历史；rejected 即从公开库/纹理响应消失 */
  async review(
    reviewer: RequestContext,
    assetId: string,
    status: 'approved' | 'rejected',
    reason: string | null,
  ): Promise<void> {
    requireCanonicalUuid(assetId, '素材不存在');
    const asset = await this.assets.findById(assetId);
    if (!asset) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    await this.assets.updateReviewStatus(
      assetId,
      status,
      reviewer.userId,
      reason,
      this.now(),
    );
  }

  /** 管理员警告 / AI 生成标记 */
  async moderate(
    moderator: RequestContext,
    assetId: string,
    fields: {
      adminWarning?: string | null;
      aiGenerated?: boolean;
      name?: string;
      description?: string;
      license?: string;
      visibility?: 'private' | 'public';
      downloadPolicy?: 'owner_only' | 'public';
    },
  ): Promise<void> {
    void moderator;
    requireCanonicalUuid(assetId, '素材不存在');
    const asset = await this.assets.findById(assetId);
    if (!asset) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    // 管理员编辑走这里，取值域与 owner 侧 updateOwnerFields 保持一致
    if (
      fields.visibility !== undefined &&
      fields.visibility !== 'private' &&
      fields.visibility !== 'public'
    ) {
      throw new AppError('VALIDATION_ERROR', 'visibility 必须为 private 或 public');
    }
    if (
      fields.downloadPolicy !== undefined &&
      fields.downloadPolicy !== 'owner_only' &&
      fields.downloadPolicy !== 'public'
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        'downloadPolicy 必须为 owner_only 或 public',
      );
    }
    if (
      fields.name !== undefined &&
      (fields.name.trim() === '' || fields.name.length > 64)
    ) {
      throw new AppError('VALIDATION_ERROR', '素材名称必填且不超过 64 字符');
    }
    await this.assets.updateModerationFields(assetId, fields, this.now());
  }

  async listMyFavorites(
    userId: string,
    kind?: AssetKind,
  ): Promise<Record<string, unknown>[]> {
    const list = await this.favorites.listByUser(userId, kind);
    const result: Record<string, unknown>[] = [];
    for (const entry of list) {
      const url = await this.previewUrl(entry.asset);
      if (!url) continue;
      result.push({
        ...toLibraryItem(entry.asset, url, 0),
        favoritedAt: entry.favoritedAt,
      });
    }
    return result;
  }
}
