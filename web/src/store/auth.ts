/** 认证状态（Zustand + persist，沿用 plan3 的 auth-storage 约定） */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  userUid: number;
  email: string;
  role: 'user' | 'admin' | 'super_admin';
  emailVerified: boolean;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  /** 当前用户默认角色的皮肤 URL（顶栏头像） */
  skinUrl: string | null;
  setAuth: (token: string, user: AuthUser) => void;
  setSkinUrl: (url: string | null) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      skinUrl: null,
      setAuth: (token, user) => set({ token, user }),
      setSkinUrl: (skinUrl) => set({ skinUrl }),
      clearAuth: () => set({ token: null, user: null, skinUrl: null }),
    }),
    { name: 'mscts-auth' },
  ),
);

export function useIsAdmin(): boolean {
  const role = useAuthStore((s) => s.user?.role);
  return role === 'admin' || role === 'super_admin';
}
