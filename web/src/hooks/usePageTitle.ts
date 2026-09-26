import { compatFetch as fetch } from "../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useEffect, useState, useRef } from 'react';
import { useSiteStore } from '../store/siteStore';
import { settingBool } from '../utils/settingBool';

/**
 * 旧版本曾把整份站点设置写进 localStorage（5 分钟 TTL）并在命中时直接返回。
 * 现在不再读写，只在启动时清掉残留 —— 否则老访客浏览器里那份「背景图为空」的旧缓存
 * 会一直存在，而清掉的活儿只能由显式的清理函数来做。
 */
const LEGACY_STORAGE_KEY = 'catTavernSkins-site-settings';

// 本模块加载时清一次：老访客浏览器里那份缓存不会再被读取，但留着只会一直躺在
// localStorage 里（下次谁再引入缓存就会被同一份脏数据咬到）。
try {
  if (typeof window !== 'undefined') window.localStorage.removeItem(LEGACY_STORAGE_KEY);
} catch { /* storage disabled */ }

interface SiteSettings {
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

const defaultSettings: SiteSettings = {
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

/**
 * 上一次拉到的设置，**只用于首屏标题的初始值**（避免标签页标题闪一下默认名）。
 * 绝不能拿它短路网络请求：背景图/图标是走 `/api/admin/upload-theme-image` 写的，
 * 缓存命中会让管理员刚上传的图迟迟不生效，界面还在展示旧的「背景图为空」。
 */
let latestSettings: SiteSettings | null = null;
/** 同一次挂载里多个页面组件共用一份请求（并发去重），不是缓存。 */
let inflight: Promise<SiteSettings> | null = null;

/**
 * 站点设置发生写入后调用：丢弃内存里的旧值，并清掉历史遗留的 localStorage 缓存。
 * 之后任何页面挂载都会重新走网络拿最新值。
 */
export function clearSiteTitleCache() {
  latestSettings = null;
  inflight = null;
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch { /* storage disabled */ }
}

function setFavicon(url: string) {
  const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null
  if (link) {
    link.href = url
  }
}

async function fetchSiteSettings(): Promise<SiteSettings> {
  if (inflight !== null) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(`/api/settings/public?_t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        latestSettings = {
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
        // 非 2xx 回落默认值，不沿用上一次的旧值：否则首屏标题会继续冒充已同步
        latestSettings = { ...defaultSettings };
      }
    } catch {
      latestSettings = { ...defaultSettings };
    }
    inflight = null;
    return latestSettings;
  })();
  return inflight;
}

/**
 * 页面标题 Hook
 * @param pageTitle 页面标题（如 '个人中心'），传入 null 或空字符串则只显示站点标题
 * @returns 当前站点标题（可用于页面内显示）
 */
export function usePageTitle(pageTitle: string | null = null): string {
  const [siteTitle, setSiteTitle] = useState<string>(latestSettings?.title || 'CatTavernSkins');
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

  // 标题同步：纯本地计算，不发请求
  useEffect(() => {
    const fullTitle =
      pageTitle && pageTitle.trim()
        ? `${pageTitle.trim()} - ${siteTitle}`
        : siteTitle;

    if (prevTitleRef.current !== fullTitle) {
      document.title = fullTitle;
      prevTitleRef.current = fullTitle;
    }
  }, [pageTitle, siteTitle]);

  // 站点设置：每次挂载拉一次网络，落到 store 的值一律来自后端（不设本地缓存）
  useEffect(() => {
    let cancelled = false;
    fetchSiteSettings().then((settings) => {
      if (cancelled) return;
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
    return () => {
      cancelled = true;
    };
    // setter 来自 zustand，引用稳定：这条 effect 只在挂载时跑一次
  }, [setTitle, setDescription, setLogo, setLightBgImage, setDarkBgImage, setLoginBgImage, setLoginEmbedImage, setVideoMuted, setLightBgOverlayOpacity, setDarkBgOverlayOpacity, setAllowRegistration]);

  return siteTitle;
}
