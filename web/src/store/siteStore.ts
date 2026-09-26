import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 站点设置 store（适配 MSCTS 后端）。
 *
 * MSCTS 没有 `/api/settings/public`，也没有站点设置管理端点，
 * 因此这里改为**本地默认值**：标题/描述/版权为固定文案，
 * 背景图恒为空串 —— 旧 Layout / Landing 的"自定义背景"分支自然不生效，
 * 走既有的星空背景实现。
 *
 * 仅 `theme` 持久化，storage key 为 `mscts-site`。
 */

export const SITE_DEFAULTS = {
  title: 'MSCTS',
  description: 'MINECRAFT SKIN SERVER',
  copyrightText: '© 2024 MSCTS',
  copyrightProject: 'Powered by MSCTS',
} as const

interface SiteState {
  title: string
  description: string

  // 主题
  theme: 'light' | 'dark'

  // 背景图（区分亮暗色）——MSCTS 无站点设置，恒为空串
  lightBgImage: string
  darkBgImage: string

  // 登录/注册页面背景图
  loginBgImage: string

  // 登录/注册页面内嵌图片（左侧展示图）
  loginEmbedImage: string

  // WebM 视频静音
  videoMuted: boolean

  // 蒙版透明度（区分亮暗色，0-100）
  lightBgOverlayOpacity: number
  darkBgOverlayOpacity: number

  // 版权设置
  copyrightText: string
  copyrightBeian: string
  copyrightProject: string

  // Actions
  setTitle: (title: string) => void
  setDescription: (description: string) => void
  setTheme: (theme: 'light' | 'dark') => void
  toggleTheme: () => void
  setLightBgImage: (url: string) => void
  setDarkBgImage: (url: string) => void
  setLoginBgImage: (url: string) => void
  setLoginEmbedImage: (url: string) => void
  setVideoMuted: (muted: boolean) => void
  setLightBgOverlayOpacity: (opacity: number) => void
  setDarkBgOverlayOpacity: (opacity: number) => void
  setCopyrightText: (text: string) => void
  setCopyrightBeian: (beian: string) => void
  setCopyrightProject: (project: string) => void
  loadSettings: () => Promise<void>
}

export const useSiteStore = create<SiteState>()(
  persist(
    (set) => ({
      title: SITE_DEFAULTS.title,
      description: SITE_DEFAULTS.description,

      theme: 'dark', // 默认暗色

      // 无站点设置来源：恒为空串 → 走星空背景
      lightBgImage: '',
      darkBgImage: '',
      loginBgImage: '',
      loginEmbedImage: '',
      videoMuted: true,

      lightBgOverlayOpacity: 30,
      darkBgOverlayOpacity: 30,

      // 版权设置
      copyrightText: SITE_DEFAULTS.copyrightText,
      copyrightBeian: '',
      copyrightProject: SITE_DEFAULTS.copyrightProject,

      setTitle: (title) => set({ title }),
      setDescription: (description) => set({ description }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () =>
        set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setLightBgImage: (url) => set({ lightBgImage: url }),
      setDarkBgImage: (url) => set({ darkBgImage: url }),
      setLoginBgImage: (url) => set({ loginBgImage: url }),
      setLoginEmbedImage: (url) => set({ loginEmbedImage: url }),
      setVideoMuted: (muted) => set({ videoMuted: muted }),
      setLightBgOverlayOpacity: (opacity) => set({ lightBgOverlayOpacity: opacity }),
      setDarkBgOverlayOpacity: (opacity) => set({ darkBgOverlayOpacity: opacity }),
      setCopyrightText: (text) => set({ copyrightText: text }),
      setCopyrightBeian: (beian) => set({ copyrightBeian: beian }),
      setCopyrightProject: (project) => set({ copyrightProject: project }),
      // 从 MSCTS 的 /api/settings/public 拉取站点外观（键名沿用旧版 SCREAMING_SNAKE_CASE）。
      // 后端只返回「已显式设置过」的键，因此未设置的项保持本地默认；
      // THEME 也只在后端有值时覆盖，避免把用户的本地主题选择冲掉。
      loadSettings: async () => {
        try {
          const res = await fetch('/api/settings/public')
          if (!res.ok) return
          const data = await res.json()
          set({
            title: data.SITE_TITLE || SITE_DEFAULTS.title,
            description: data.SITE_DESCRIPTION || SITE_DEFAULTS.description,
            ...(data.THEME
              ? { theme: data.THEME === 'light' ? 'light' : 'dark' }
              : {}),
            lightBgImage: data.LIGHT_BG_IMAGE || '',
            darkBgImage: data.DARK_BG_IMAGE || '',
            loginBgImage: data.LOGIN_BG_IMAGE || '',
            loginEmbedImage: data.LOGIN_EMBED_IMAGE || '',
            videoMuted: String(data.VIDEO_MUTED ?? 'true').toLowerCase() === 'true',
            lightBgOverlayOpacity: Number(data.LIGHT_BG_OVERLAY_OPACITY) || 30,
            darkBgOverlayOpacity: Number(data.DARK_BG_OVERLAY_OPACITY) || 30,
            copyrightText: data.COPYRIGHT_TEXT || SITE_DEFAULTS.copyrightText,
            copyrightBeian: data.COPYRIGHT_BEIAN || '',
            copyrightProject:
              data.COPYRIGHT_PROJECT || SITE_DEFAULTS.copyrightProject,
          })
        } catch {
          // 网络异常时保持本地默认值，不打断渲染
        }
      },
    }),
    {
      name: 'mscts-site',
      version: 1,
      // 只持久化主题，其余为本地默认
      partialize: (state) => ({ theme: state.theme }) as unknown as SiteState,
    },
  ),
)
