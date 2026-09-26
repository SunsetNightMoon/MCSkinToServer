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
