import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import i18n from '../i18n'
import { LANGUAGE_STORAGE_KEY } from '../i18n'

interface I18nState {
  language: string
  setLanguage: (lang: string) => void
}

const STORAGE_VERSION = 1

export const useI18nStore = create<I18nState>()(
  persist(
    (set) => ({
      language: i18n.language || 'SCH',
      setLanguage: (lang: string) => {
        i18n.changeLanguage(lang)
        set({ language: lang })
      },
    }),
    {
      name: LANGUAGE_STORAGE_KEY,
      version: STORAGE_VERSION,
    }
  )
)

// 初始化时同步 i18n 语言
const storedLang = useI18nStore.getState().language
if (storedLang && storedLang !== i18n.language) {
  i18n.changeLanguage(storedLang)
}
