/**
 * 会话工具（token 读取 + 登录态失效处理）。
 *
 * 单独成模块，是为了让 `utils/api.ts` 与 `utils/apiCompat.ts` 都能引用它
 * 而不产生循环依赖（api.ts 需要 compatFetch，apiCompat 需要这里的 token）。
 */

const AUTH_STORAGE_KEY = 'auth-storage'

let clearAuthFn: (() => void) | null = null

export function setAuthClearHandler(fn: () => void) {
  clearAuthFn = fn
}

/** 登录态失效：清 store + hash 跳转登录页 */
export function handleAuthFailure() {
  if (clearAuthFn) clearAuthFn()
  if (window.location.hash !== '#/login') {
    window.location.hash = '#/login'
  }
}

/** 读取持久化的登录 token（旧版 zustand persist key） */
export function getStoredToken(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return parsed?.state?.token || null
    }
  } catch {
    // ignore
  }
  return null
}
