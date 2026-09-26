import type { DatabaseConnection } from '../types.js';
import { phAt, toIso } from '../db/rows.js';
import type { AssetKind, AssetRow } from './assetRepository.js';

/**
 * favorites 表 repository —— 皮肤/披风统一收藏。
 * 领域规则（route-inventory §5 确认）：不能收藏自己的素材，由领域服务强制。
 */

export interface FavoriteRow {
  userId: string;
  assetId: string;
  createdAt: string;
}

export class FavoriteRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async insert(userId: string, assetId: string, now: Date): Promise<void> {
    await this.db.run(
      `INSERT INTO favorites (user_id, asset_id, created_at)
       VALUES (${[0, 1, 2].map((i) => phAt(this.db.dialect, i)).join(', ')})`,
      [userId, assetId, now.toISOString()],
    );
  }

  async delete(userId: string, assetId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM favorites WHERE user_id = ${phAt(this.db.dialect, 0)}
         AND asset_id = ${phAt(this.db.dialect, 1)}`,
      [userId, assetId],
    );
  }

  async exists(userId: string, assetId: string): Promise<boolean> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT 1 AS x FROM favorites
       WHERE user_id = ${phAt(this.db.dialect, 0)} AND asset_id = ${phAt(this.db.dialect, 1)}`,
      [userId, assetId],
    );
    return rows.length > 0;
  }

  async countByAsset(assetId: string): Promise<number> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS n FROM favorites WHERE asset_id = ${phAt(this.db.dialect, 0)}`,
      [assetId],
    );
    return Number(rows[0]!['n']);
  }

  /** 批量计数（公开库列表用，避免 N+1）；不在结果中的 id 计数为 0 */
  async countByAssets(assetIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (assetIds.length === 0) return map;
    const ph = (i: number) => phAt(this.db.dialect, i);
    const placeholders = assetIds.map((_, i) => ph(i)).join(', ');
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT asset_id, COUNT(*) AS n FROM favorites
       WHERE asset_id IN (${placeholders})
       GROUP BY asset_id`,
      assetIds,
    );
    for (const raw of rows) {
      map.set(raw['asset_id'] as string, Number(raw['n']));
    }
    for (const id of assetIds) {
      if (!map.has(id)) map.set(id, 0);
    }
    return map;
  }

  /** 用户收藏列表（可按 kind 过滤，时间倒序） */
  async listByUser(
    userId: string,
    kind?: AssetKind,
  ): Promise<{ asset: AssetRow; favoritedAt: string }[]> {
    const params: unknown[] = [userId];
    let kindJoin = '';
    if (kind) {
      params.push(kind);
      kindJoin = `AND a.kind = ${phAt(this.db.dialect, 1)}`;
    }
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT f.created_at AS favorited_at,
              a.id, a.owner_user_id, a.kind, a.blob_id, a.model_type, a.name,
              a.description, a.license, a.visibility, a.download_policy,
              a.review_status, a.ai_generated, a.admin_warning,
              a.view_count, a.download_count, a.created_at, a.updated_at
       FROM favorites f
       JOIN assets a ON a.id = f.asset_id
       WHERE f.user_id = ${phAt(this.db.dialect, 0)} ${kindJoin}
       ORDER BY f.created_at DESC, f.asset_id DESC`,
      params,
    );
    return rows.map((raw) => ({
      favoritedAt: toIso(raw['favorited_at'])!,
      asset: {
        id: raw['id'] as string,
        ownerUserId: raw['owner_user_id'] as string,
        kind: raw['kind'] as AssetKind,
        blobId: raw['blob_id'] as string,
        modelType: (raw['model_type'] as AssetRow['modelType']) ?? null,
        name: raw['name'] as string,
        description: (raw['description'] as string) ?? '',
        license: (raw['license'] as string) ?? 'CC0',
        visibility: raw['visibility'] as AssetRow['visibility'],
        downloadPolicy: raw['download_policy'] as AssetRow['downloadPolicy'],
        reviewStatus: raw['review_status'] as AssetRow['reviewStatus'],
        aiGenerated: raw['ai_generated'] === true || raw['ai_generated'] === 1,
        adminWarning: (raw['admin_warning'] as string | null) ?? null,
        viewCount: Number(raw['view_count'] ?? 0),
        downloadCount: Number(raw['download_count'] ?? 0),
        createdAt: toIso(raw['created_at'])!,
        updatedAt: toIso(raw['updated_at'])!,
      },
    }));
  }
}
