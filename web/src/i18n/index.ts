import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

// 导入语言资源（去敏命名）
import EN from './locales/EN.json'
import SCH from './locales/SCH.json'
import TCH from './locales/TCH.json'
import JP from './locales/JP.json'

export const SUPPORTED_LANGUAGES = [
  { code: 'SCH', name: '简体中文' },
  { code: 'TCH', name: '繁體中文' },
  { code: 'EN', name: 'English' },
  { code: 'JP', name: '日本語' },
]

export const DEFAULT_LANGUAGE = 'SCH'

export const LANGUAGE_STORAGE_KEY = 'cattavern-language'

const resources = {
  EN: { translation: EN },
  SCH: { translation: SCH },
  TCH: { translation: TCH },
  JP: { translation: JP },
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    debug: process.env.NODE_ENV === 'development',

    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },

    interpolation: {
      escapeValue: false,
    },

    react: {
      useSuspense: false,
    },
  })

export default i18n
