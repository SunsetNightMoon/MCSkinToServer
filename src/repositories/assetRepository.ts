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
        'private',
        'owner_only',
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
    opts: { page: number; pageSize: number; sort: 'latest' | 'views' | 'downloads' },
  ): Promise<{ items: AssetRow[]; total: number }> {
    const where = `kind = ${phAt(this.db.dialect, 0)} AND visibility = 'public' AND review_status = 'approved'`;
    const totalRows = await this.db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS n FROM assets WHERE ${where}`,
      [kind],
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
       LIMIT ${phAt(this.db.dialect, 1)} OFFSET ${phAt(this.db.dialect, 2)}`,
      [kind, opts.pageSize, offset],
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
    fields: { adminWarning?: string | null; aiGenerated?: boolean },
    now: Date,
  ): Promise<void> {
    const sets: string[] = [`updated_at = ${phAt(this.db.dialect, 0)}`];
    const params: unknown[] = [now.toISOString()];
    if (fields.adminWarning !== undefined) {
      params.push(fields.adminWarning);
      sets.push(`admin_warning = ${phAt(this.db.dialect, params.length - 1)}`);
    }
    if (fields.aiGenerated !== undefined) {
      // PG boolean 列不能绑整数，SQLite 不接受 boolean —— 按方言给值
      params.push(
        this.db.dialect === 'postgres'
          ? fields.aiGenerated
          : fields.aiGenerated
            ? 1
            : 0,
      );
      sets.push(`ai_generated = ${phAt(this.db.dialect, params.length - 1)}`);
    }
    await this.db.run(
      `UPDATE assets SET ${sets.join(', ')} WHERE id = ${phAt(this.db.dialect, params.length)}`,
      [...params, assetId],
    );
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
