import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import i18n from '../i18n'
import { LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES } from '../i18n'

interface I18nState {
  language: string
  /**
   * 用户是否**手动**选过语言（P5 第十二批）。
   * 站点默认语言（DEFAULT_LANGUAGE）只在用户没主动选过时生效：
   * 访客自己点过语言切换，那是他的选择，不能被站点默认覆盖。
   */
  userChosen: boolean
  setLanguage: (lang: string) => void
  /** 站点默认语言就绪时调用：用户没选过 → 套用站点默认 */
  applySiteDefault: (lang: string) => void
}

const STORAGE_VERSION = 2

export const useI18nStore = create<I18nState>()(
  persist(
    (set, get) => ({
      language: i18n.language || 'SCH',
      userChosen: false,
      setLanguage: (lang: string) => {
        i18n.changeLanguage(lang)
        set({ language: lang, userChosen: true })
      },
      applySiteDefault: (lang: string) => {
        // 非法值 / 未设置 → 不动
        if (!SUPPORTED_LANGUAGES.some((l) => l.code === lang)) return
        // 用户已手动选过 → 尊重用户，站点默认不覆盖
        if (get().userChosen) return
        i18n.changeLanguage(lang)
        set({ language: lang })
      },
    }),
    {
      name: LANGUAGE_STORAGE_KEY,
      version: STORAGE_VERSION,
      // userChosen 缺省 false：老用户（v1 存储）视为「没手动选过」，站点默认可生效
    }
  )
)

// 初始化时同步 i18n 语言
const storedLang = useI18nStore.getState().language
if (storedLang && storedLang !== i18n.language) {
  i18n.changeLanguage(storedLang)
}
