import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';
import { phAt, toIso } from '../db/rows.js';

/**
 * assets / profile_assets 表 repository。
 * 所有权：owner_user_id 是唯一归属事实来源；绑定槽位每角色每槽最多一条（UNIQUE）。
 */

export type AssetKind = 'skin' | 'cape';
export type ModelType = 'default' | 'slim';
export type Visibility = 'private' | 'public';
export type DownloadPolicy = 'owner_only' | 'public';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface AssetRow {
  id: string;
  ownerUserId: string;
  kind: AssetKind;
  blobId: string;
  /** 仅皮肤有值 */
  modelType: ModelType | null;
  name: string;
  description: string;
  license: string;
  visibility: Visibility;
  downloadPolicy: DownloadPolicy;
  reviewStatus: ReviewStatus;
  aiGenerated: boolean;
  adminWarning: string | null;
  viewCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewAssetRow {
  id: string;
  ownerUserId: string;
  kind: AssetKind;
  blobId: string;
  modelType: ModelType | null;
  name: string;
  description?: string;
  license?: string;
  /** 上传时指定的可见性；省略则 'private'（安全默认） */
  visibility?: Visibility;
  /** 上传时指定的下载策略；省略则 'owner_only'（安全默认） */
  downloadPolicy?: DownloadPolicy;
  now: Date;
}

const ASSET_COLUMNS =
  'id, owner_user_id, kind, blob_id, model_type, name, description, license, ' +
  'visibility, download_policy, review_status, ai_generated, admin_warning, ' +
  'view_count, download_count, created_at, updated_at';

function mapAssetRow(raw: Record<string, unknown>): AssetRow {
  return {
    id: raw['id'] as string,
    ownerUserId: raw['owner_user_id'] as string,
    kind: raw['kind'] as AssetKind,
    blobId: raw['blob_id'] as string,
    modelType: (raw['model_type'] as ModelType | null) ?? null,
    name: raw['name'] as string,
    description: (raw['description'] as string) ?? '',
    license: (raw['license'] as string) ?? 'CC0',
    visibility: raw['visibility'] as Visibility,
    downloadPolicy: raw['download_policy'] as DownloadPolicy,
    reviewStatus: raw['review_status'] as ReviewStatus,
    aiGenerated: raw['ai_generated'] === true || raw['ai_generated'] === 1,
    adminWarning: (raw['admin_warning'] as string | null) ?? null,
    viewCount: Number(raw['view_count'] ?? 0),
    downloadCount: Number(raw['download_count'] ?? 0),
    createdAt: toIso(raw['created_at'])!,
    updatedAt: toIso(raw['updated_at'])!,
  };
}

export interface ProfileAssetRow {
  id: string;
  profileId: string;
  assetId: string;
  slot: AssetKind;
  assignedAt: string;
}

export class AssetRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async insert(asset: NewAssetRow): Promise<void> {
    const now = asset.now.toISOString();
    await this.db.run(
      `INSERT INTO assets (id, owner_user_id, kind, blob_id, model_type, name,
         description, license, visibility, download_policy, review_status,
         ai_generated, admin_warning, view_count, download_count, created_at, updated_at)
       VALUES (${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
         .map((i) => phAt(this.db.dialect, i))
         .join(', ')})`,
      [
        asset.id,
        asset.ownerUserId,
        asset.kind,
        asset.blobId,
        asset.modelType,
        asset.name,
        asset.description ?? '',
        asset.license ?? 'CC0',
        asset.visibility ?? 'private',
        asset.downloadPolicy ?? 'owner_only',
        'pending',
        0,
        null,
        0,
        0,
        now,
        now,
      ],
    );
  }

  async findById(id: string): Promise<AssetRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS} FROM assets WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
    return rows[0] ? mapAssetRow(rows[0]) : null;
  }

  async listByOwner(userId: string, kind?: AssetKind): Promise<AssetRow[]> {
    const params: unknown[] = [userId];
    let where = `owner_user_id = ${phAt(this.db.dialect, 0)}`;
    if (kind) {
      params.push(kind);
      where += ` AND kind = ${phAt(this.db.dialect, params.length - 1)}`;
    }
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS} FROM assets WHERE ${where} ORDER BY created_at DESC, id DESC`,
      params,
    );
    return rows.map(mapAssetRow);
  }

  async delete(id: string): Promise<void> {
    await this.db.run(
      `DELETE FROM assets WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
  }

  /**
   * 删除某用户拥有的全部素材（账号宽限期到期清除用）。
   * favorites / asset_reviews 由外键 ON DELETE CASCADE 一并清理；
   * blobs 不删——内容寻址下可能被其他用户的素材共用。
   */
  async deleteByOwner(userId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM assets WHERE owner_user_id = ${phAt(this.db.dialect, 0)}`,
      [userId],
    );
  }

  /** owner 修改自己的素材元数据（可见性/下载策略/名称/描述） */
  async updateOwnerFields(
    id: string,
    fields: {
      name?: string;
      description?: string;
      visibility?: 'private' | 'public';
      downloadPolicy?: 'owner_only' | 'public';
    },
    now: Date,
  ): Promise<void> {
    const sets: string[] = [`updated_at = ${phAt(this.db.dialect, 0)}`];
    const params: unknown[] = [now.toISOString()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = ${phAt(this.db.dialect, params.length - 1)}`);
    };
    if (fields.name !== undefined) push('name', fields.name);
    if (fields.description !== undefined) push('description', fields.description);
    if (fields.visibility !== undefined) push('visibility', fields.visibility);
    if (fields.downloadPolicy !== undefined) push('download_policy', fields.downloadPolicy);
    await this.db.run(
      `UPDATE assets SET ${sets.join(', ')} WHERE id = ${phAt(this.db.dialect, params.length)}`,
      [...params, id],
    );
  }

  // ---- 公开库（P3）----

  /** 公开库分页列表：仅 approved + public；sort = latest | views | downloads */
  async listPublic(
    kind: AssetKind,
    opts: { page: number; pageSize: number; sort: 'latest' | 'views' | 'downloads'; search?: string },
  ): Promise<{ items: AssetRow[]; total: number }> {
    const searchClause =
      opts.search && opts.search.trim() !== ''
        ? ` AND lower(name) LIKE ${phAt(this.db.dialect, 3)}`
        : '';
    const searchLike =
      opts.search && opts.search.trim() !== '' ? `%${opts.search.trim().toLowerCase()}%` : null;
    const where = `kind = ${phAt(this.db.dialect, 0)} AND visibility = 'public' AND review_status = 'approved'${searchClause}`;
    const baseArgs: unknown[] = searchLike ? [kind, searchLike] : [kind];
    const totalRows = await this.db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS n FROM assets WHERE ${where}`,
      baseArgs,
    );
    const order =
      opts.sort === 'views'
        ? 'view_count DESC, created_at DESC'
        : opts.sort === 'downloads'
          ? 'download_count DESC, created_at DESC'
          : 'created_at DESC, id DESC';
    const offset = (opts.page - 1) * opts.pageSize;
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS} FROM assets WHERE ${where}
       ORDER BY ${order}
       LIMIT ${phAt(this.db.dialect, baseArgs.length)} OFFSET ${phAt(this.db.dialect, baseArgs.length + 1)}`,
      [...baseArgs, opts.pageSize, offset],
    );
    return {
      items: rows.map(mapAssetRow),
      total: Number(totalRows[0]!['n']),
    };
  }

  async incrementViewCount(id: string): Promise<void> {
    await this.db.run(
      `UPDATE assets SET view_count = view_count + 1 WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
  }

  async incrementDownloadCount(id: string): Promise<void> {
    await this.db.run(
      `UPDATE assets SET download_count = download_count + 1 WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
  }

  // ---- 审核与管理员标记（P3）----

  /** 更新审核状态并写入 asset_reviews 历史流水（单事务由调用方决定；此处两语句顺序执行） */
  async updateReviewStatus(
    assetId: string,
    status: ReviewStatus,
    reviewerUserId: string | null,
    reason: string | null,
    now: Date,
  ): Promise<void> {
    await this.db.run(
      `UPDATE assets SET review_status = ${phAt(this.db.dialect, 0)},
         updated_at = ${phAt(this.db.dialect, 1)}
       WHERE id = ${phAt(this.db.dialect, 2)}`,
      [status, now.toISOString(), assetId],
    );
    await this.db.run(
      `INSERT INTO asset_reviews (id, asset_id, reviewer_user_id, status, reason, created_at)
       VALUES (${[0, 1, 2, 3, 4, 5].map((i) => phAt(this.db.dialect, i)).join(', ')})`,
      [randomUUID(), assetId, reviewerUserId, status, reason, now.toISOString()],
    );
  }

  async updateModerationFields(
    assetId: string,
    fields: {
      adminWarning?: string | null;
      aiGenerated?: boolean;
      /** 以下为管理员编辑他人素材的元数据能力（与 owner 侧同义） */
      name?: string;
      description?: string;
      license?: string;
      visibility?: 'private' | 'public';
      downloadPolicy?: 'owner_only' | 'public';
    },
    now: Date,
  ): Promise<void> {
    const sets: string[] = [`updated_at = ${phAt(this.db.dialect, 0)}`];
    const params: unknown[] = [now.toISOString()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = ${phAt(this.db.dialect, params.length - 1)}`);
    };
    if (fields.adminWarning !== undefined) push('admin_warning', fields.adminWarning);
    if (fields.aiGenerated !== undefined) {
      // PG boolean 列不能绑整数，SQLite 不接受 boolean —— 按方言给值
      push(
        'ai_generated',
        this.db.dialect === 'postgres'
          ? fields.aiGenerated
          : fields.aiGenerated
            ? 1
            : 0,
      );
    }
    if (fields.name !== undefined) push('name', fields.name);
    if (fields.description !== undefined) push('description', fields.description);
    if (fields.license !== undefined) push('license', fields.license);
    if (fields.visibility !== undefined) push('visibility', fields.visibility);
    if (fields.downloadPolicy !== undefined) push('download_policy', fields.downloadPolicy);
    await this.db.run(
      `UPDATE assets SET ${sets.join(', ')} WHERE id = ${phAt(this.db.dialect, params.length)}`,
      [...params, assetId],
    );
  }

  /**
   * 管理端全量素材列表（含 private 与 pending/rejected）。
   * 与 listPublic 的差别：不做可见性/审核过滤，供管理员总览与编辑入口。
   */
  async listAllForAdmin(opts: {
    kind?: AssetKind;
    reviewStatus?: ReviewStatus;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: AssetRow[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.kind) {
      args.push(opts.kind);
      where.push(`kind = ${phAt(this.db.dialect, args.length - 1)}`);
    }
    if (opts.reviewStatus) {
      args.push(opts.reviewStatus);
      where.push(`review_status = ${phAt(this.db.dialect, args.length - 1)}`);
    }
    if (opts.search) {
      args.push(`%${opts.search.toLowerCase()}%`);
      where.push(`lower(name) LIKE ${phAt(this.db.dialect, args.length - 1)}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countRows = await this.db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS total FROM assets ${whereSql}`,
      args,
    );
    const total = Number(countRows[0]!['total']);

    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS} FROM assets ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${phAt(this.db.dialect, args.length)}
       OFFSET ${phAt(this.db.dialect, args.length + 1)}`,
      [...args, opts.pageSize, (opts.page - 1) * opts.pageSize],
    );
    return { items: rows.map(mapAssetRow), total };
  }

  /** 管理员待审核列表（pending） */
  async listPending(kind?: AssetKind): Promise<AssetRow[]> {
    const params: unknown[] = [];
    let where = `review_status = 'pending'`;
    if (kind) {
      params.push(kind);
      where += ` AND kind = ${phAt(this.db.dialect, 0)}`;
    }
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS} FROM assets WHERE ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(mapAssetRow);
  }

  /** 某素材的审核历史（时间倒序） */
  async listReviews(assetId: string): Promise<
    { id: string; status: ReviewStatus; reason: string | null; reviewerUserId: string | null; createdAt: string }[]
  > {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, status, reason, reviewer_user_id, created_at
       FROM asset_reviews WHERE asset_id = ${phAt(this.db.dialect, 0)}
       ORDER BY created_at DESC, id DESC`,
      [assetId],
    );
    return rows.map((raw) => ({
      id: raw['id'] as string,
      status: raw['status'] as ReviewStatus,
      reason: (raw['reason'] as string | null) ?? null,
      reviewerUserId: (raw['reviewer_user_id'] as string | null) ?? null,
      createdAt: toIso(raw['created_at'])!,
    }));
  }

  // ---- profile_assets 绑定 ----

  async findBinding(
    profileId: string,
    slot: AssetKind,
  ): Promise<ProfileAssetRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, profile_id, asset_id, slot, assigned_at
       FROM profile_assets
       WHERE profile_id = ${phAt(this.db.dialect, 0)} AND slot = ${phAt(this.db.dialect, 1)}`,
      [profileId, slot],
    );
    const row = rows[0];
    return row
      ? {
          id: row['id'] as string,
          profileId: row['profile_id'] as string,
          assetId: row['asset_id'] as string,
          slot: row['slot'] as AssetKind,
          assignedAt: toIso(row['assigned_at'])!,
        }
      : null;
  }

  /** 应用到槽位：同槽旧绑定直接覆盖（衣柜语义），UNIQUE(profile_id, slot) */
  async assign(
    id: string,
    profileId: string,
    assetId: string,
    slot: AssetKind,
    now: Date,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO profile_assets (id, profile_id, asset_id, slot, assigned_at)
       VALUES (${[0, 1, 2, 3, 4].map((i) => phAt(this.db.dialect, i)).join(', ')})
       ON CONFLICT (profile_id, slot)
       DO UPDATE SET asset_id = ${phAt(this.db.dialect, 5)},
         assigned_at = ${phAt(this.db.dialect, 6)}`,
      [id, profileId, assetId, slot, now.toISOString(), assetId, now.toISOString()],
    );
  }

  async unassign(profileId: string, slot: AssetKind): Promise<void> {
    await this.db.run(
      `DELETE FROM profile_assets
       WHERE profile_id = ${phAt(this.db.dialect, 0)} AND slot = ${phAt(this.db.dialect, 1)}`,
      [profileId, slot],
    );
  }
}
