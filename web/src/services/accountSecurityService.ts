import { apiRequest } from '../utils/api'

/**
 * 账号安全服务（0003）：用户名模式 + 邮箱安全。
 *
 * 与 `profileService` 分开的理由：这两组能力**只**服务于个人中心的账号设置，
 * 而 profileService 服务于衣柜/角色列表（Wardrobe、MySkins 也在用）。
 * 混在一起会让「模式与邮箱」的字段污染角色列表的消费方。
 *
 * 所有方法都靠 `apiRequest` 自动附带 Bearer 会话；错误统一抛 `LegacyHttpError`，
 * 其中 `err.code` 是后端的 AppError 码 —— 调用方据此区分：
 *   MODE_COOLDOWN       单用户名模式下「换 ID」的 30 天窗口未满（403）
 *   PROFILE_RESERVED    该角色是预留态，当前不可用（403）
 *   MODE_CHOICE_REQUIRED 账号还没做过首次模式选择（409）
 */

export type ProfileMode = 'single' | 'multi'
/** 改邮箱的目标槽位：主邮箱 / 备用邮箱 */
export type EmailSlot = 'primary' | 'backup'

/** GET /api/me/profile-mode 的响应（后端 ProfileModeState 原样透传） */
export interface ProfileModeState {
  mode: ProfileMode
  /**
   * 存量多角色账号尚未做过首次选择。
   * true 时任何模式/角色写操作都会被后端以 409 拒绝，前端必须先把选择弹窗推出来。
   */
  decisionRequired: boolean
  decidedAt: string | null
  modeChangedAt: string | null
  /** 角色总数上限（两种模式共用，当前 10） */
  maxProfiles: number
  /** 可用（active）角色上限：单用户名 1，多用户名 = maxProfiles */
  activeLimit: number
  activeCount: number
  /** 预留角色数量。为 0 时界面不显示「预留口」 —— 这正是「没多用户过就看不到」的实现点 */
  reservedCount: number
  /** 单用户名模式下换 ID 的窗口结束时间；无冷却时为 null */
  cooldownUntil: string | null
  cooldownDaysRemaining: number | null
}

/** 进行中的改邮箱请求（两枚令牌各自的确认进度） */
export interface EmailPendingChange {
  id: string
  target: EmailSlot
  newEmail: string
  authorizeVia: EmailSlot
  verifyConfirmed: boolean
  authorizeConfirmed: boolean
}

/** GET /api/me/email-status 的响应 */
export interface EmailSecurityStatus {
  email: string
  emailVerified: boolean
  backupEmail: string | null
  backupEmailVerified: boolean
  /** 有无**已验证**的备用邮箱：决定改主邮箱走交叉授权还是回落授权 */
  hasVerifiedBackup: boolean
  /** 未绑定/未验证备用邮箱 → 界面提示补一个（防主邮箱失效后找不回账号） */
  backupEmailRecommended: boolean
  pendingChange: EmailPendingChange | null
}

export interface EmailChangeRequestResult {
  requestId: string
  target: EmailSlot
  newEmail: string
  authorizeVia: EmailSlot
  /** 授权信的收件地址（authorizeVia 指向的具体邮箱） */
  authorizeEmail: string
  /** 无备用邮箱时授权回落到当前主邮箱自己 —— 告知用户「两封都发到了你自己家」 */
  fallbackToSelf: boolean
  backupEmailRecommended: boolean
}

export interface EmailChangeConfirmResult {
  /** false = 只确认了一侧，还差另一侧 */
  completed: boolean
  role: 'verify' | 'authorize'
  target: EmailSlot
  newEmail: string
  waitingFor: 'verify' | 'authorize' | null
  /** completed 时才给出变更后的当前邮箱 */
  email: string | null
}

export const accountSecurityService = {
  // ---- 用户名模式 ----

  getProfileMode(): Promise<ProfileModeState> {
    return apiRequest<ProfileModeState>('/api/me/profile-mode')
  },

  /**
   * 保存模式选择。
   *
   * 首次决定与后续切换共用一个端点：当前该走哪条路由**服务端**根据
   * `decidedAt` 判断，前端不要自己猜（猜错会出现「以为在决定、实为切换」的错位）。
   * `keepProfileId` 在选 'single' 且当前 active 角色多于 1 个时必填。
   */
  saveProfileMode(
    mode: ProfileMode,
    keepProfileId?: string | null,
  ): Promise<ProfileModeState> {
    return apiRequest<ProfileModeState>('/api/me/profile-mode', {
      method: 'POST',
      json: {
        mode,
        ...(keepProfileId ? { keepProfileId } : {}),
      },
    })
  },

  /** 从预留口启用一个角色（单用户名模式下唯一的「换 ID」路径，受 30 天窗口约束） */
  activateReservedProfile(profileId: string): Promise<ProfileModeState> {
    return apiRequest<ProfileModeState>(
      `/api/me/profiles/${encodeURIComponent(profileId)}/activate`,
      { method: 'POST' },
    )
  },

  // ---- 邮箱安全 ----

  getEmailStatus(): Promise<EmailSecurityStatus> {
    return apiRequest<EmailSecurityStatus>('/api/me/email-status')
  },

  requestBackupEmail(email: string): Promise<{
    sent: boolean
    pendingEmail: string
    alreadyVerified: boolean
  }> {
    return apiRequest('/api/me/backup-email', {
      method: 'POST',
      json: { email },
    })
  },

  /** 消费备用邮箱验证链接（后端允许匿名，带上会话也无妨） */
  verifyBackupEmail(token: string): Promise<{ ok: boolean; email: string }> {
    return apiRequest('/api/me/backup-email/verify', {
      method: 'POST',
      json: { token },
    })
  },

  removeBackupEmail(): Promise<{ ok: boolean; removed: string | null }> {
    return apiRequest('/api/me/backup-email', { method: 'DELETE' })
  },

  requestEmailChange(
    target: EmailSlot,
    newEmail: string,
  ): Promise<EmailChangeRequestResult> {
    return apiRequest<EmailChangeRequestResult>('/api/me/email-change', {
      method: 'POST',
      json: { target, newEmail },
    })
  },

  confirmEmailChange(token: string): Promise<EmailChangeConfirmResult> {
    return apiRequest<EmailChangeConfirmResult>('/api/me/email-change/confirm', {
      method: 'POST',
      json: { token },
    })
  },

  /**
   * 收敛点（幂等）。
   *
   * 两枚链接被**并发**点开时，两个事务可能各自只看见自己那一枚已确认，
   * 双双判定「还差另一侧」，于是变更永远不生效。前端在「等待另一个邮箱确认」
   * 面板里轮询本端点即可自愈，用户不需要重新走一遍流程。
   */
  finalizeEmailChange(): Promise<EmailChangeConfirmResult> {
    return apiRequest<EmailChangeConfirmResult>('/api/me/email-change/finalize', {
      method: 'POST',
    })
  },

  cancelEmailChange(): Promise<{ ok: boolean; cancelled: number }> {
    return apiRequest('/api/me/email-change', { method: 'DELETE' })
  },
}
