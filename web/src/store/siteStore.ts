import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { settingBool } from '../utils/settingBool'
import { useI18nStore } from './i18nStore'

/**
 * 站点设置 store（适配 MCSTS 后端）。
 *
 * 数据源 = `GET /api/settings/public`（键名 SCREAMING_SNAKE_CASE，见
 * 后端 `PUBLIC_SETTING_KEYS`）。该端点只返回「已显式设置过」的键，
 * 未设置项保持这里的本地默认值。
 *
 * ⚠️ 键名必须与后端、管理端表单三处完全一致（全大写）：
 * 历史上管理端表单用的是 snake_case（site_title），写入后 public 白名单读不到，
 * 表现为「保存成功但页面不变」。改动键名时三处要同步。
 *
 * 仅 `theme` 持久化，storage key 为 `mcsts-site`。
 */

export const SITE_DEFAULTS = {
  title: 'MCSTS',
  description: 'MINECRAFT SKIN SERVER',
  copyrightText: '© 2024 MCSTS',
  copyrightProject: 'Powered by MCSkinToServer',
  /**
   * 允许注册的缺省值。
   * 必须与后端 `RUNTIME_SETTING_DEFAULTS.allowRegistration` 一致：
   * 页面按 true 渲染注册表单、后端按 false 拒绝注册，就会出现
   * 「表单能填、提交必失败」的诡异体验。
   */
  allowRegistration: true,
} as const

interface SiteState {
  title: string
  description: string
  /** 站点图标（顶栏徽标）。空串时顶栏回退到内置的 CSS "S" 方块 */
  logo: string

  /**
   * 是否允许注册（ALLOW_REGISTRATION）。
   * 关闭时注册页不再展示表单，改为提示「本站已关闭注册」——
   * 让用户填完整个表单才被 403 拒绝是很差的做法。
   */
  allowRegistration: boolean

  // 主题
  theme: 'light' | 'dark'

  // 背景图（区分亮暗色）；未设置时为空串 → 走星空背景
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
  setLogo: (url: string) => void
  setAllowRegistration: (allow: boolean) => void
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
      logo: '',
      allowRegistration: SITE_DEFAULTS.allowRegistration,

      theme: 'dark', // 默认暗色

      // 未设置时恒为空串 → 走星空背景
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
      setLogo: (url) => set({ logo: url }),
      setAllowRegistration: (allow) => set({ allowRegistration: allow }),
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
      // 从 MCSTS 的 /api/settings/public 拉取站点外观（键名沿用旧版 SCREAMING_SNAKE_CASE）。
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
            logo: data.SITE_LOGO || '',
            // 用容错解析：库里可能是布尔 false 或字符串 'false'，见 utils/settingBool.ts
            allowRegistration: settingBool(
              data.ALLOW_REGISTRATION,
              SITE_DEFAULTS.allowRegistration,
            ),
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
          // 站点默认显示语言（P5 第十二批）：只在用户没手动选过语言时生效。
          // applySiteDefault 内部会判 userChosen —— 访客自己切换过的语言优先。
          if (typeof data.DEFAULT_LANGUAGE === 'string' && data.DEFAULT_LANGUAGE) {
            useI18nStore.getState().applySiteDefault(data.DEFAULT_LANGUAGE)
          }
        } catch {
          // 网络异常时保持本地默认值，不打断渲染
        }
      },
    }),
    {
      name: 'mcsts-site',
      version: 1,
      // 只持久化主题，其余为本地默认
      partialize: (state) => ({ theme: state.theme }) as unknown as SiteState,
    },
  ),
)
