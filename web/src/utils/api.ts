import axios from 'axios'
import { getStoredToken, handleAuthFailure } from './session'
import { compatFetch } from './apiCompat'

/**
 * 旧版数据层入口（已适配 MCSTS 后端）。
 *
 * - token 仍从 `auth-storage`（zustand persist）读取，见 utils/session.ts
 * - 登录态失效跳转改为 hash 路由 `#/login`（前端由 HashRouter 承载）
 * - 401/403 处理：**只对 401 清登录态**。
 *   MCSTS 的 403 被用于业务语义（NAME_COOLDOWN 改名冷却 / FORBIDDEN 权限不足 /
 *   DOWNLOAD_FORBIDDEN 无下载权限 / USER_DISABLED），若按旧版一并当作登录失效处理，
 *   会导致"改名冷却"等正常操作把用户踢下线，因此这里收窄为 401。
 */

export { getStoredToken, setAuthClearHandler, handleAuthFailure } from './session'

// ── axios 全局拦截器（旧代码里用 axios 的地方共用） ──
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      handleAuthFailure()
    }
    return Promise.reject(error)
  },
)

/** 兼容旧版 catch 块：把 MCSTS 的 {error,message} 转成 {response:{status,data:{errorMessage}}} */
export interface LegacyHttpError extends Error {
  status?: number
  code?: string
  response?: { status: number; data: Record<string, any> }
}

export function toLegacyError(status: number, body: any, fallback: string): LegacyHttpError {
  const message = body?.errorMessage || body?.message || fallback
  const err = new Error(message) as LegacyHttpError
  err.status = status
  err.code = body?.error
  err.response = {
    status,
    data: { ...(body ?? {}), errorMessage: message, error: body?.error },
  }
  return err
}

/**
 * 带认证的 JSON 请求封装（服务层用）。
 * 自动附带 Bearer token；非 2xx 抛出旧版形状的错误（error.response.data.errorMessage）。
 */
export async function apiRequest<T = any>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init
  const headers = new Headers(rest.headers)
  const token = getStoredToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  let body = rest.body
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(json)
  }

  const res = await fetch(path, { ...rest, headers, body })

  if (res.status === 401) {
    handleAuthFailure()
  }
  if (res.status === 204) {
    return undefined as unknown as T
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw toLegacyError(res.status, data, `请求失败 (${res.status})`)
  }
  return data as T
}

/**
 * 带认证的 fetch 封装（旧 SystemSettings 等页面使用）。
 * 走兼容层，保证未支持的站点设置端点也能优雅降级。
 */
export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers)
  const token = getStoredToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await compatFetch(url, { ...options, headers })

  if (response.status === 401) {
    handleAuthFailure()
  }

  return response
}
