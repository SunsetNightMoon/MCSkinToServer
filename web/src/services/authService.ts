import { apiRequest } from '../utils/api'
import { roleToLevel } from '../store/authStore'
import type { User, RegisterDTO, LoginDTO } from '../types'

/**
 * 认证服务（适配 MSCTS 端点）。
 *
 * MSCTS：
 *   POST /api/auth/login    {email,password}                  → {user,profile,token,expiresAt}
 *   POST /api/auth/register {email,password,profileName}      → 同上（注册即登录）
 *   POST /api/auth/logout   （无 body，吊销当前 token）
 *   GET  /api/me/skin                                         → {profileId,profileName,skinUrl,model}
 *
 * 返回值保持旧版 Login 页面消费的形状：
 *   { accessToken, user(含 level), skinUrl, profileName, profiles:[{id,name}] }
 */

interface MsctsUser {
  id: string
  userUid: number
  email: string
  role: string
  emailVerified: boolean
}

interface MsctsAuthResponse {
  user: MsctsUser
  profile: { id: string; name: string } | null
  /**
   * 会话令牌。**可为 null**：站点开启「要求邮箱验证」时，注册成功但不签发会话，
   * 必须点完邮件里的验证链接才能登录（见后端 routes/identity.ts 的 register）。
   */
  token: string | null
  expiresAt: string | null
  /** 本次注册是否处在「需邮箱验证」流程中 */
  requiresVerification?: boolean
  /** 验证邮件是否真的发出去了（发信失败时为 false，前端要如实提示） */
  verificationEmailSent?: boolean
}

function toLegacyUser(u: MsctsUser): User {
  return {
    id: u.id,
    user_uid: u.userUid,
    email: u.email,
    role: u.role,
    level: roleToLevel(u.role),
    is_active: true,
    email_verified: u.emailVerified,
    banned_until: null,
  }
}

export const authService = {
  async register(data: RegisterDTO): Promise<any> {
    const res = await apiRequest<MsctsAuthResponse>('/api/auth/register', {
      method: 'POST',
      json: {
        email: data.email,
        password: data.password,
        profileName: data.profile_name,
        // 0004 人机验证：这几个字段**必须转发**。
        // 页面（Register.tsx）早就把 captcha_session_id / captcha_answer 放进了
        // RegisterDTO，但这里没有透传 —— 结果是「管理员开了验证码，用户答对了
        // 也照样被拒」，且前端看起来一切正常（字段在页面里、类型也对）。
        captcha_session_id: data.captcha_session_id,
        captcha_answer: data.captcha_answer,
        turnstile_token: data.turnstile_token,
      },
    })
    return {
      ...res,
      // MSCTS 没有"首个用户即超管"的语义（角色由 super_admin 手工授予）
      isFirstUser: false,
      user: toLegacyUser(res.user),
    }
  },

  async login(data: LoginDTO): Promise<any> {
    const res = await apiRequest<MsctsAuthResponse>('/api/auth/login', {
      method: 'POST',
      json: {
        email: data.email,
        password: data.password,
        // 同 register：验证码字段必须透传，否则登录在被要求验证码时必然 400
        captcha_session_id: data.captcha_session_id,
        captcha_answer: data.captcha_answer,
        turnstile_token: data.turnstile_token,
      },
    })

    // 登录后拉取默认角色皮肤（顶栏头像）
    const skin = await apiRequest<{ profileId: string; profileName: string; skinUrl: string | null }>(
      '/api/me/skin',
      { headers: { Authorization: `Bearer ${res.token}` } },
    ).catch(() => null)

    return {
      accessToken: res.token,
      expiresAt: res.expiresAt,
      user: toLegacyUser(res.user),
      skinUrl: skin?.skinUrl ?? null,
      profileName: skin?.profileName ?? res.profile?.name ?? null,
      profiles: res.profile ? [{ id: res.profile.id, name: res.profile.name }] : [],
    }
  },

  async logout(): Promise<void> {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
    } catch {
      // 服务端吊销失败也不阻塞前端登出
    }
    localStorage.removeItem('auth-storage')
  },

  async getProfile(): Promise<any> {
    return apiRequest('/api/me/skin')
  },
}
