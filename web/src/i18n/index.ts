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

/**
 * 把浏览器/存储里的语言码归一到本项目支持的四个码（SCH/TCH/EN/JP）。
 *
 * i18next 的 navigator 探测给出的是 `zh-CN` / `en-US` / `ja-JP` 这类原始值，而
 * resources 的键只有四个码 —— 不归一等于探测永远落空（所有人一律看到简中），
 * 并且 `caches: ['localStorage']` 会把 `en-US` 这种无效码写进存储，之后每次都拿它去探测。
 */
export function normalizeLanguage(raw: string | undefined | null): string {
  const code = (raw ?? '').trim().toLowerCase()
  const exact = SUPPORTED_LANGUAGES.find((lang) => lang.code.toLowerCase() === code)
  if (exact) return exact.code
  if (code.startsWith('zh')) {
    // 繁中可能是 zh-TW / zh-HK / zh-MO / zh-Hant（含 zh-Hant-TW 这种带地区的写法）
    return /(^|-)(tw|hk|mo)|hant/.test(code) ? 'TCH' : 'SCH'
  }
  if (code.startsWith('ja')) return 'JP'
  if (code.startsWith('en')) return 'EN'
  return DEFAULT_LANGUAGE
}

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
      // 只从浏览器探测。存储键 `cattavern-language` 归 zustand 的 i18nStore 独占（值是
      // `{state:{language,userChosen},version}` 这样的 JSON），i18next 再去读它会读到一段
      // JSON 当语言码，再去写它又会把 zustand 的整份状态覆盖成裸字符串 —— 两边共用一个键
      // 必然互相踩。已存语言的恢复由 i18nStore 在模块加载时 changeLanguage 完成。
      order: ['navigator'],
      caches: [],
      convertDetectedLanguage: (lng) => normalizeLanguage(lng),
    },

    interpolation: {
      escapeValue: false,
    },

    react: {
      useSuspense: false,
    },
  })

export default i18n
