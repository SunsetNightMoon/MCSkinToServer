import type { DatabaseConnection } from '../types.js';
import { phAt, toIso, placeholders } from '../db/rows.js';

/**
 * profiles 表 repository。
 * P0 覆盖 Yggdrasil 纹理链路查询；P1 扩展身份链路 CRUD。
 */

/**
 * 角色状态（0003）。
 *
 * - 'active'  ：生效中的角色。Yggdrasil availableProfiles / 皮肤站的「我的角色」
 *               只呈现这一种。
 * - 'reserved'：预留口里的角色。**多 -> 单** 时被换下的角色转此状态，
 *               数据与名字占位都保留（否则名字会被别人抢注，而用户等满冷却后
 *               还要用它换回来）。与 active 的关键差别是「当前不可用」。
 */
export type ProfileStatus = 'active' | 'reserved';

export interface ProfileRow {
  id: string;
  userId: string;
  name: string;
  nameChangedAt: string;
  createdAt: string;
  updatedAt: string;
  status: ProfileStatus;
  /** 非空 = 最近一次状态变更时刻（NULL 表示建成后从未变更过状态） */
  statusChangedAt: string | null;
}

export interface NewProfileRow {
  id: string;
  userId: string;
  name: string;
  now: Date;
  /** 缺省 'active'（注册时的默认角色、多用户模式下新建的角色都是 active） */
  status?: ProfileStatus;
}

const PROFILE_COLUMNS =
  'id, user_id, name, name_changed_at, created_at, updated_at, status, status_changed_at';

function mapProfileRow(raw: Record<string, unknown>): ProfileRow {
  return {
    id: raw['id'] as string,
    userId: raw['user_id'] as string,
    name: raw['name'] as string,
    nameChangedAt: toIso(raw['name_changed_at'])!,
    createdAt: toIso(raw['created_at'])!,
    updatedAt: toIso(raw['updated_at'])!,
    status: (raw['status'] as ProfileStatus | null) ?? 'active',
    statusChangedAt: toIso(raw['status_changed_at']),
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
  /**
   * 角色状态（0003）。协议层据此判定「这个角色当前可不可用」：
   * reserved 的角色名字还被占着但当前不可用，不该出现在 availableProfiles /
   * 按名字批量查询的结果里，也不该再按 UUID 解析出纹理。
   * 一并查出来是为了让调用方不必再补一次 findById。
   */
  status: ProfileStatus;
  skin: ProfileTextureAsset | null;
  cape: ProfileTextureAsset | null;
}

/**
 * 单个角色当前绑定的纹理，带素材 ID。
 * 与 ProfileTextureState 的差别：多返回 assetId，供 Web 端做「已应用」高亮
 * （前端用素材 ID 比对卡片），Yggdrasil 协议链路不需要 ID 所以走另一条查询。
 */
export interface ProfileTextureBinding {
  profileId: string;
  skinAssetId: string | null;
  skin: ProfileTextureAsset | null;
  capeAssetId: string | null;
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
      `INSERT INTO profiles (id, user_id, name, name_changed_at, created_at, updated_at, status)
       VALUES (${placeholders(this.db.dialect, 6)}, ${phAt(this.db.dialect, 6)})`,
      [
        profile.id,
        profile.userId,
        profile.name,
        now,
        now,
        now,
        profile.status ?? 'active',
      ],
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

  // ---- 0003：角色状态 ----

  /**
   * 用户名下**生效中**的角色（Yggdrasil 可选项、皮肤站「我的角色」）。
   * reserved 的角色刻意不在此列 —— 它的名字还被占着，但当前不可用。
   */
  async listActiveByUserId(userId: string): Promise<ProfileRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles
       WHERE user_id = ${phAt(this.db.dialect, 0)} AND status = 'active'
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    return rows.map(mapProfileRow);
  }

  /** 预留口里的角色（单用户名模式下展示用） */
  async listReservedByUserId(userId: string): Promise<ProfileRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles
       WHERE user_id = ${phAt(this.db.dialect, 0)} AND status = 'reserved'
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    return rows.map(mapProfileRow);
  }

  /** 生效中的角色数（单模式上限判定用） */
  async countActiveByUserId(userId: string): Promise<number> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS n FROM profiles
       WHERE user_id = ${phAt(this.db.dialect, 0)} AND status = 'active'`,
      [userId],
    );
    return Number(rows[0]!['n']);
  }

  /** 用户名下最早的 **active** 角色（Yggdrasil 登录默认 selectedProfile） */
  async findFirstActiveByUserId(userId: string): Promise<ProfileRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles
       WHERE user_id = ${phAt(this.db.dialect, 0)} AND status = 'active'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [userId],
    );
    return rows[0] ? mapProfileRow(rows[0]) : null;
  }

  async setStatus(
    profileId: string,
    status: ProfileStatus,
    at: Date,
  ): Promise<void> {
    await this.db.run(
      `UPDATE profiles SET status = ${phAt(this.db.dialect, 0)},
         status_changed_at = ${phAt(this.db.dialect, 1)},
         updated_at = ${phAt(this.db.dialect, 2)}
       WHERE id = ${phAt(this.db.dialect, 3)}`,
      [status, at.toISOString(), at.toISOString(), profileId],
    );
  }

  /**
   * 批量置状态：用户名下**除 keepProfileId 之外**的角色全部改成 status。
   * 用于「多 -> 单」把被换下的角色一次性转 reserved。返回受影响行数。
   */
  async setStatusForAllExcept(
    userId: string,
    keepProfileId: string,
    status: ProfileStatus,
    at: Date,
  ): Promise<number> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE profiles SET status = ${phAt(this.db.dialect, 0)},
         status_changed_at = ${phAt(this.db.dialect, 1)},
         updated_at = ${phAt(this.db.dialect, 2)}
       WHERE user_id = ${phAt(this.db.dialect, 3)}
         AND id <> ${phAt(this.db.dialect, 4)}
         AND status <> ${phAt(this.db.dialect, 5)}
       RETURNING id`,
      [
        status,
        at.toISOString(),
        at.toISOString(),
        userId,
        keepProfileId,
        status,
      ],
    );
    return rows.length;
  }

  /**
   * 批量置状态：用户名下所有角色改成 status。
   * 用于「单 -> 多」把预留口里的角色全部放回 active。
   * `status <> ?` 条件让重复调用不产生无谓写入（幂等，且不动 status_changed_at）。
   */
  async setStatusForAll(
    userId: string,
    status: ProfileStatus,
    at: Date,
  ): Promise<number> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE profiles SET status = ${phAt(this.db.dialect, 0)},
         status_changed_at = ${phAt(this.db.dialect, 1)},
         updated_at = ${phAt(this.db.dialect, 2)}
       WHERE user_id = ${phAt(this.db.dialect, 3)}
         AND status <> ${phAt(this.db.dialect, 4)}
       RETURNING id`,
      [status, at.toISOString(), at.toISOString(), userId, status],
    );
    return rows.length;
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

  /**
   * 只推进改名计时基准，不改名字（0003）。
   *
   * 「启用预留角色」是一次身份变更 —— 名字没变，但账号当前使用的 ID 变了。
   * 它必须同样启动 30 天冷却，否则用户可以连续换 ID（每次换一个预留角色），
   * 单用户名模式的冷却就成了摆设。走 rename() 也能达到效果（把名字写成同名），
   * 但那会让「改名」这个名字出现在一份与改名无关的调用栈里，日后必被误读。
   */
  async markNameChanged(id: string, at: Date): Promise<void> {
    await this.db.run(
      `UPDATE profiles SET name_changed_at = ${phAt(this.db.dialect, 0)},
         updated_at = ${phAt(this.db.dialect, 1)}
       WHERE id = ${phAt(this.db.dialect, 2)}`,
      [at.toISOString(), at.toISOString(), id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run(
      `DELETE FROM profiles WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
  }

  /** 删除某用户全部角色（账号宽限期到期清除用）；profile_assets 由外键级联清理 */
  async deleteByUserId(userId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM profiles WHERE user_id = ${phAt(this.db.dialect, 0)}`,
      [userId],
    );
  }

  // ---- 纹理链路（P0）----

  async findTextureState(profileId: string): Promise<ProfileTextureState | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT p.name AS profile_name, p.status AS profile_status,
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
      status: (row['profile_status'] as ProfileStatus | null) ?? 'active',
      skin: skinKey
        ? { storageKey: skinKey, modelType: skinModel ?? null }
        : null,
      cape: capeKey ? { storageKey: capeKey, modelType: null } : null,
    };
  }

  /**
   * 用户全部角色的纹理绑定（一次查询，避免逐角色 N+1）。
   * 未绑定的槽位由 LEFT JOIN 产出 null；rejected 素材不渲染（与 findTextureState 同一规则）。
   */
  async listTextureBindingsByUserId(
    userId: string,
  ): Promise<ProfileTextureBinding[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT p.id AS profile_id,
              s.id AS skin_asset_id, s.model_type AS skin_model, sb.storage_key AS skin_key,
              c.id AS cape_asset_id, cb.storage_key AS cape_key
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
       WHERE p.user_id = ${phAt(this.db.dialect, 0)}
       ORDER BY p.created_at ASC, p.id ASC`,
      [userId],
    );

    return rows.map((row) => {
      const skinKey = row['skin_key'] as string | null;
      const capeKey = row['cape_key'] as string | null;
      const skinModel = row['skin_model'] as 'default' | 'slim' | null;
      return {
        profileId: row['profile_id'] as string,
        skinAssetId: (row['skin_asset_id'] as string | null) ?? null,
        skin: skinKey
          ? { storageKey: skinKey, modelType: skinModel ?? null }
          : null,
        capeAssetId: (row['cape_asset_id'] as string | null) ?? null,
        cape: capeKey ? { storageKey: capeKey, modelType: null } : null,
      };
    });
  }
}
