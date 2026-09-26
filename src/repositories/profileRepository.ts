import type { DatabaseConnection } from '../types.js';
import { phAt, toIso, placeholders } from '../db/rows.js';

/**
 * profiles 表 repository。
 * P0 覆盖 Yggdrasil 纹理链路查询；P1 扩展身份链路 CRUD。
 */

export interface ProfileRow {
  id: string;
  userId: string;
  name: string;
  nameChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewProfileRow {
  id: string;
  userId: string;
  name: string;
  now: Date;
}

const PROFILE_COLUMNS =
  'id, user_id, name, name_changed_at, created_at, updated_at';

function mapProfileRow(raw: Record<string, unknown>): ProfileRow {
  return {
    id: raw['id'] as string,
    userId: raw['user_id'] as string,
    name: raw['name'] as string,
    nameChangedAt: toIso(raw['name_changed_at'])!,
    createdAt: toIso(raw['created_at'])!,
    updatedAt: toIso(raw['updated_at'])!,
  };
}

export interface ProfileTextureAsset {
  storageKey: string;
  /** 仅皮肤有值 */
  modelType: 'default' | 'slim' | null;
}

export interface ProfileTextureState {
  /** 内部规范 UUID（带连字符） */
  profileId: string;
  profileName: string;
  skin: ProfileTextureAsset | null;
  cape: ProfileTextureAsset | null;
}

/**
 * 领域规则（对应蓝图 §7.2 待决策项，本实现采用的安全默认）：
 * 纹理输出跟随角色绑定，但 review_status = 'rejected' 的素材一律不渲染
 * —— 被拒绝的内容不应出现在任何协议响应中；仍绑定的素材应走下架流程解除绑定。
 */
export class ProfileRepository {
  constructor(private readonly db: DatabaseConnection) {}

  // ---- 身份链路（P1）----

  async insert(profile: NewProfileRow): Promise<void> {
    const now = profile.now.toISOString();
    await this.db.run(
      `INSERT INTO profiles (id, user_id, name, name_changed_at, created_at, updated_at)
       VALUES (${placeholders(this.db.dialect, 6)})`,
      [profile.id, profile.userId, profile.name, now, now, now],
    );
  }

  async findById(id: string): Promise<ProfileRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
    return rows[0] ? mapProfileRow(rows[0]) : null;
  }

  async findByName(name: string): Promise<ProfileRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE name = ${phAt(this.db.dialect, 0)}`,
      [name],
    );
    return rows[0] ? mapProfileRow(rows[0]) : null;
  }

  /** 用户名下最早创建的角色（Yggdrasil 登录默认 selectedProfile） */
  async findFirstByUserId(userId: string): Promise<ProfileRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles
       WHERE user_id = ${phAt(this.db.dialect, 0)}
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [userId],
    );
    return rows[0] ? mapProfileRow(rows[0]) : null;
  }

  async listByUserId(userId: string): Promise<ProfileRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles
       WHERE user_id = ${phAt(this.db.dialect, 0)}
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    return rows.map(mapProfileRow);
  }

  async countByUserId(userId: string): Promise<number> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS n FROM profiles WHERE user_id = ${phAt(this.db.dialect, 0)}`,
      [userId],
    );
    return Number(rows[0]!['n']);
  }

  async rename(id: string, name: string, at: Date): Promise<void> {
    // 占位符下标不可重复（SQLite 每个 ? 都需要绑定值，PG 的 $n 重复只算一个）
    await this.db.run(
      `UPDATE profiles SET name = ${phAt(this.db.dialect, 0)},
         name_changed_at = ${phAt(this.db.dialect, 1)},
         updated_at = ${phAt(this.db.dialect, 2)}
       WHERE id = ${phAt(this.db.dialect, 3)}`,
      [name, at.toISOString(), at.toISOString(), id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run(
      `DELETE FROM profiles WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
  }

  // ---- 纹理链路（P0）----

  async findTextureState(profileId: string): Promise<ProfileTextureState | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT p.name AS profile_name,
              s.model_type AS skin_model, sb.storage_key AS skin_key,
              c.model_type AS cape_model, cb.storage_key AS cape_key
       FROM profiles p
       LEFT JOIN profile_assets pa_s
         ON pa_s.profile_id = p.id AND pa_s.slot = 'skin'
       LEFT JOIN assets s
         ON s.id = pa_s.asset_id AND s.review_status <> 'rejected'
       LEFT JOIN blobs sb ON sb.id = s.blob_id
       LEFT JOIN profile_assets pa_c
         ON pa_c.profile_id = p.id AND pa_c.slot = 'cape'
       LEFT JOIN assets c
         ON c.id = pa_c.asset_id AND c.review_status <> 'rejected'
       LEFT JOIN blobs cb ON cb.id = c.blob_id
       WHERE p.id = ${phAt(this.db.dialect, 0)}`,
      [profileId],
    );

    const row = rows[0];
    if (!row) return null;

    const skinKey = row['skin_key'] as string | null;
    const capeKey = row['cape_key'] as string | null;
    const skinModel = row['skin_model'] as 'default' | 'slim' | null;

    return {
      profileId,
      profileName: row['profile_name'] as string,
      skin: skinKey
        ? { storageKey: skinKey, modelType: skinModel ?? null }
        : null,
      cape: capeKey ? { storageKey: capeKey, modelType: null } : null,
    };
  }
}
