import { compatFetch as fetch } from "../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
import { useEffect, useState, useRef } from 'react';
import { useSiteStore } from '../store/siteStore';
import { settingBool } from '../utils/settingBool';

const STORAGE_KEY = 'catTavernSkins-site-settings';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedSettings {
  title: string;
  description: string;
  // 主题设置
  lightBgImage: string;
  darkBgImage: string;
  // 登录/注册页面背景图
  loginBgImage: string;
  // 登录/注册页面内嵌图片
  loginEmbedImage: string;
  // WebM 视频静音
  videoMuted: boolean;
  lightBgOverlayOpacity: number;
  darkBgOverlayOpacity: number;
  // 网站图标（浏览器标签页）
  favicon: string;
  // 站点图标（顶栏徽标）
  logo: string;
  // 是否允许注册（决定注册页展示表单还是「已关闭注册」提示）
  allowRegistration: boolean;
}

interface StoredCache {
  data: CachedSettings;
  ts: number;
}

function readPersistentCache(): CachedSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as StoredCache;
      if (Date.now() - parsed.ts < CACHE_TTL_MS) {
        return parsed.data;
      }
    }
  } catch { /* storage disabled */ }
  return null;
}

function writePersistentCache(settings: CachedSettings) {
  try {
    const payload: StoredCache = { data: settings, ts: Date.now() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch { /* storage disabled */ }
}

const defaultSettings: CachedSettings = {
  title: 'CatTavernSkins',
  description: 'Minecraft Skin Server',
  lightBgImage: '',
  darkBgImage: '',
  loginBgImage: '',
  loginEmbedImage: '',
  videoMuted: true,
  lightBgOverlayOpacity: 30,
  darkBgOverlayOpacity: 30,
  favicon: '/favicon.svg',
  logo: '',
  // 与后端 RUNTIME_SETTING_DEFAULTS.allowRegistration 一致
  allowRegistration: true,
};

let cachedSettings: CachedSettings | null = readPersistentCache();
let fetchPromise: Promise<CachedSettings> | null = null;

/** 清除站点设置缓存（修改设置后调用） */
export function clearSiteTitleCache() {
  cachedSettings = null;
  fetchPromise = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage disabled */ }
}

function setFavicon(url: string) {
  const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null
  if (link) {
    link.href = url
  }
}

async function fetchSiteSettings(): Promise<CachedSettings> {
  if (cachedSettings !== null) return cachedSettings;
  if (fetchPromise !== null) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const res = await fetch(`/api/settings/public?_t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        cachedSettings = {
          title: String(data.SITE_TITLE || 'CatTavernSkins'),
          description: String(data.SITE_DESCRIPTION || 'Minecraft Skin Server'),
          // 主题设置（向后兼容：darkBgImage 为空时回退到 HOMEPAGE_BG_IMAGE）
          lightBgImage: String(data.LIGHT_BG_IMAGE || ''),
          darkBgImage: String(data.DARK_BG_IMAGE || data.HOMEPAGE_BG_IMAGE || ''),
          loginBgImage: String(data.LOGIN_BG_IMAGE || ''),
          loginEmbedImage: String(data.LOGIN_EMBED_IMAGE || ''),
          videoMuted: String(data.VIDEO_MUTED || 'true').toLowerCase() === 'true',
          lightBgOverlayOpacity: parseInt(data.LIGHT_BG_OVERLAY_OPACITY) || 30,
          darkBgOverlayOpacity: parseInt(data.DARK_BG_OVERLAY_OPACITY) || 30,
          favicon: String(data.SITE_FAVICON || '/favicon.svg'),
          logo: String(data.SITE_LOGO || ''),
          // 容错解析：库里可能是布尔 false 或字符串 'false'，见 utils/settingBool.ts
          allowRegistration: settingBool(data.ALLOW_REGISTRATION, true),
        };
      } else {
        cachedSettings = { ...defaultSettings };
      }
    } catch {
      cachedSettings = { ...defaultSettings };
    }
    writePersistentCache(cachedSettings);
    fetchPromise = null;
    return cachedSettings;
  })();
  return fetchPromise;
}

/**
 * 页面标题 Hook
 * @param pageTitle 页面标题（如 '个人中心'），传入 null 或空字符串则只显示站点标题
 * @returns 当前站点标题（可用于页面内显示）
 */
export function usePageTitle(pageTitle: string | null = null): string {
  const [siteTitle, setSiteTitle] = useState<string>(cachedSettings?.title || 'CatTavernSkins');
  const prevTitleRef = useRef<string>('');
  const {
    setTitle,
    setDescription,
    setLogo,
    setLightBgImage,
    setDarkBgImage,
    setLoginBgImage,
    setLoginEmbedImage,
    setVideoMuted,
    setLightBgOverlayOpacity,
    setDarkBgOverlayOpacity,
    setAllowRegistration,
  } = useSiteStore();

  useEffect(() => {
    const fullTitle =
      pageTitle && pageTitle.trim()
        ? `${pageTitle.trim()} - ${siteTitle}`
        : siteTitle;

    if (prevTitleRef.current !== fullTitle) {
      document.title = fullTitle;
      prevTitleRef.current = fullTitle;
    }

    fetchSiteSettings().then((settings) => {
      setSiteTitle(settings.title);
      setTitle(settings.title);
      setDescription(settings.description);
      setLogo(settings.logo);
      setLightBgImage(settings.lightBgImage);
      setDarkBgImage(settings.darkBgImage);
      setLoginBgImage(settings.loginBgImage);
      setLoginEmbedImage(settings.loginEmbedImage);
      setVideoMuted(settings.videoMuted);
      setLightBgOverlayOpacity(settings.lightBgOverlayOpacity);
      setDarkBgOverlayOpacity(settings.darkBgOverlayOpacity);
      setAllowRegistration(settings.allowRegistration);
      setFavicon(settings.favicon);
    });
  }, [pageTitle, siteTitle, setTitle, setDescription, setLogo, setLightBgImage, setDarkBgImage, setLoginBgImage, setLoginEmbedImage, setVideoMuted, setLightBgOverlayOpacity, setDarkBgOverlayOpacity, setAllowRegistration]);

  return siteTitle;
}
