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
  setAuth: (token: string, user: AuthUser) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      clearAuth: () => set({ token: null, user: null }),
    }),
    { name: 'mscts-auth' },
  ),
);

export function useIsAdmin(): boolean {
  const role = useAuthStore((s) => s.user?.role);
  return role === 'admin' || role === 'super_admin';
}
