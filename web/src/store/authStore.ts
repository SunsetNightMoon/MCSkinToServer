import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '../types'

/**
 * 认证 store（适配 MSCTS 后端）。
 *
 * 保留旧版对外的全部接口（isAuthenticated / user / skinUrl / profileName /
 * profileId / setAuth / updateUser / setSkinUrl / setProfileName / clearAuth），
 * 只把角色模型的差异抹平：
 *   MSCTS 用 user.role ('user' | 'admin' | 'super_admin')，
 *   旧界面用 user.level (0 | 1 | 2) 做 `user.level >= 1` 判断，
 *   因此统一用 roleToLevel() 把 role 映射成 level 后落库。
 */

export type UserRole = 'user' | 'admin' | 'super_admin'

/** MSCTS 角色 → 旧版 level（供各页面 `user.level >= 1` 复用） */
export function roleToLevel(role: string | undefined | null): number {
  if (role === 'super_admin') return 2
  if (role === 'admin') return 1
  return 0
}

interface AuthState {
  token: string | null
  user: User | null
  skinUrl: string | null
  profileName: string | null
  profileId: string | null
  isAuthenticated: boolean
  setAuth: (
    token: string,
    user: User,
    skinUrl?: string | null,
    profileName?: string | null,
    profileId?: string | null,
  ) => void
  clearAuth: () => void
  updateUser: (user: Partial<User>) => void
  setProfileName: (name: string | null) => void
  setSkinUrl: (url: string | null) => void
}

// 当前缓存版本，数据结构变更时递增以丢弃旧缓存
const STORAGE_VERSION = 2

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      skinUrl: null,
      profileName: null,
      profileId: null,
      isAuthenticated: false,
      setAuth: (token, user, skinUrl = null, profileName = null, profileId = null) =>
        set({ token, user, skinUrl, profileName, profileId, isAuthenticated: true }),
      clearAuth: () =>
        set({
          token: null,
          user: null,
          skinUrl: null,
          profileName: null,
          profileId: null,
          isAuthenticated: false,
        }),
      updateUser: (userData) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...userData } : null,
        })),
      setProfileName: (name) => set({ profileName: name }),
      setSkinUrl: (url) => set({ skinUrl: url }),
    }),
    {
      name: 'auth-storage',
      version: STORAGE_VERSION,
      migrate: (persistedState: any, version) => {
        // 版本不匹配时丢弃旧缓存
        if (version !== STORAGE_VERSION) {
          return {
            token: null,
            user: null,
            skinUrl: null,
            profileName: null,
            profileId: null,
            isAuthenticated: false,
          } as AuthState
        }
        return persistedState as AuthState
      },
    },
  ),
)
