import { apiRequest } from '../utils/api'
import { useAuthStore } from '../store/authStore'
import i18n from '../i18n'

/**
 * 角色 / 衣柜服务（适配 MSCTS 端点）。
 *
 * MSCTS：
 *   GET    /api/me/profiles            → {profiles:[{id,userId,name,nameChangedAt,createdAt,updatedAt,
 *                                                     skinId,capeId,skinUrl,capeUrl,model}]}
 *   GET    /api/me/skin                → {profileId,profileName,skinUrl,model}
 *   POST   /api/profiles               {name}                新建角色（最多 3 个）
 *   POST   /api/profiles/:id/name      {name}                改名（30 天冷却 → 403 NAME_COOLDOWN）
 *   DELETE /api/profiles/:id           删除角色
 *   POST   /api/assets/:id/apply       {profileId,slot}       应用素材到槽位
 *   POST   /api/assets/:id/remove      {profileId,slot}       摘下槽位
 *   POST   /api/profiles/minecraft     [name...]              批量角色名查询（用于查重）
 *
 * 返回值保持旧页面消费的形状（snake_case），例如 Wardrobe / UserProfile 直接读
 * `data.profiles[0].name`、`primaryProfile.name_changed_at`。
 */

interface MsctsProfileRow {
  id: string
  userId: string
  name: string
  nameChangedAt: string
  createdAt: string
  updatedAt: string
  /** 当前绑定的皮肤/披风素材 ID（衣柜卡片「已应用」高亮用） */
  skinId?: string | null
  capeId?: string | null
  /** 当前皮肤/披风的直链（3D 预览用） */
  skinUrl?: string | null
  capeUrl?: string | null
  model?: 'default' | 'slim' | null
  /**
   * 0003：角色状态。`reserved` = 预留态 —— 数据与名字都还在，
   * 但当前不作为会话角色使用，也不参与名字解析（不进启动器的可选角色列表）。
   * 单用户名模式下它就是「冷却期满后可以换进来的那个 ID」。
   */
  status?: 'active' | 'reserved'
  statusChangedAt?: string | null
}

function toLegacyProfile(p: MsctsProfileRow): Record<string, any> {
  return {
    id: p.id,
    user_id: p.userId,
    name: p.name,
    name_changed_at: p.nameChangedAt,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    // 旧页面（Wardrobe / UserProfile）直接读这几个字段：
    //   currentProfile.skin_id === skin.id  → 卡片「已应用」标记
    //   profile.skin_url                    → 预览兜底（列表里找不到该素材时）
    skin_id: p.skinId ?? null,
    cape_id: p.capeId ?? null,
    skin_url: p.skinUrl ?? null,
    cape_url: p.capeUrl ?? null,
    model_type: p.model ?? 'default',
    // 0003：预留口 UI 靠这两个字段。旧字段缺失时按 active 兜底 ——
    // 老后端（0003 之前）不返回 status，此时所有角色本来也都是 active。
    status: p.status ?? 'active',
    status_changed_at: p.statusChangedAt ?? null,
  }
}

export const profileService = {
  /**
   * 检查角色名是否可用（走 MSCTS 的批量角色名查询端点）
   */
  async checkNameAvailability(name: string): Promise<{ available: boolean; message: string }> {
    const found = await apiRequest<any[]>('/api/profiles/minecraft', {
      method: 'POST',
      json: [name],
    })
    const available = !Array.isArray(found) || found.length === 0
    return {
      available,
      message: available ? i18n.t('profile.nameAvailable') : i18n.t('profile.nameTaken'),
    }
  },

  /**
   * 更新角色名称（30 天冷却由后端裁决：NAME_COOLDOWN / NAME_TAKEN）
   */
  async updateName(profileId: string, name: string): Promise<any> {
    await apiRequest(`/api/profiles/${profileId}/name`, {
      method: 'POST',
      json: { name },
    })
    return { message: i18n.t('profile.nameUpdated') }
  },

  /**
   * 新建角色（多用户名模式专属，上限 10 由后端裁决）。
   * 单用户名模式后端会以 VALIDATION_ERROR 拒绝 —— 前端入口只在 multi 显示。
   */
  async createProfile(name: string): Promise<{ profile: { id: string; name: string } }> {
    return apiRequest('/api/profiles', {
      method: 'POST',
      json: { name },
    })
  },

  /**
   * 获取当前用户信息 + 角色列表 + 默认角色皮肤（旧版 getMe 的语义）
   */
  async getMe(): Promise<any> {
    const [profilesRes, skin] = await Promise.all([
      apiRequest<{ profiles: MsctsProfileRow[] }>('/api/me/profiles'),
      apiRequest<{ profileId: string; profileName: string; skinUrl: string | null }>(
        '/api/me/skin',
      ).catch(() => null),
    ])

    return {
      user: useAuthStore.getState().user,
      skinUrl: skin?.skinUrl ?? null,
      profileName: skin?.profileName ?? null,
      profiles: (profilesRes.profiles ?? []).map(toLegacyProfile),
    }
  },

  /** 应用皮肤到角色 */
  async applySkin(profileId: string, skinId: string): Promise<any> {
    return apiRequest(`/api/assets/${skinId}/apply`, {
      method: 'POST',
      json: { profileId, slot: 'skin' },
    })
  },

  /** 应用披风到角色 */
  async applyCape(profileId: string, capeId: string): Promise<any> {
    return apiRequest(`/api/assets/${capeId}/apply`, {
      method: 'POST',
      json: { profileId, slot: 'cape' },
    })
  },

  /**
   * 移除角色皮肤。
   * MSCTS 的 remove 端点是 `POST /api/assets/:id/remove`，但服务层按 `slot` 解绑，
   * 路径上的 id 不参与判断（见 src/textures/ingest.ts#removeFromProfile），
   * 因此这里用占位 id `current`。
   */
  async removeSkin(profileId: string): Promise<any> {
    return apiRequest('/api/assets/current/remove', {
      method: 'POST',
      json: { profileId, slot: 'skin' },
    })
  },

  /** 移除角色披风（同上，id 为占位） */
  async removeCape(profileId: string): Promise<any> {
    return apiRequest('/api/assets/current/remove', {
      method: 'POST',
      json: { profileId, slot: 'cape' },
    })
  },
}
