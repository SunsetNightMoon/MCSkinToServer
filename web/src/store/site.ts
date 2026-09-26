/** 站点级状态（主题切换，沿用 plan3 的暗色默认 + 亮色覆盖设计） */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SiteTheme = 'dark' | 'light';

interface SiteState {
  theme: SiteTheme;
  toggleTheme: () => void;
}

export const useSiteStore = create<SiteState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      toggleTheme: () =>
        set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
    }),
    { name: 'mscts-site' },
  ),
);
