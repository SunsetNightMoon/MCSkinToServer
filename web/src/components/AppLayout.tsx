/**
 * 布局壳（plan3 设计）：星空背景（暗）/ 浅色渐变（亮）+ TopNav + 内容区 + Footer
 * 主题同步到 body[data-theme]，index.css 的变量与 AntD 覆盖依赖它。
 */

import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useSiteStore } from '../store/site';
import { TopNav, type NavItem } from './TopNav';

export const NAV_LINKS: NavItem[] = [
  { path: '/', label: 'nav.home' },
  { path: '/library', label: 'nav.library' },
  { path: '/upload', label: 'nav.upload', auth: true },
  { path: '/wardrobe', label: 'nav.wardrobe', auth: true },
  { path: '/profiles', label: 'nav.profiles', auth: true },
  { path: '/profile', label: 'nav.profile', auth: true },
  { path: '/admin', label: 'nav.admin', auth: true, admin: true },
];

export function AppLayout() {
  const theme = useSiteStore((s) => s.theme);
  const location = useLocation();

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div style={{ minHeight: '100dvh', position: 'relative' }}>
      {theme === 'dark' ? (
        <div className="starfield-bg">
          <div className="starfield-bg__stars" />
          <div className="starfield-bg__shooting-star" />
          <div className="starfield-bg__fog" />
        </div>
      ) : (
        <div className="light-bg" />
      )}

      <div style={{ position: 'relative', zIndex: 10 }}>
        <TopNav links={NAV_LINKS} />
        <main
          key={location.pathname}
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            padding: '24px 24px 48px',
            minHeight: 'calc(100dvh - 64px - 90px)',
          }}
        >
          <Outlet />
        </main>
        <footer
          style={{
            textAlign: 'center',
            padding: '20px 0 28px',
            fontSize: 13,
            color: 'var(--text-subtle)',
          }}
        >
          MSCTS · Minecraft Skin Server
          <span style={{ marginLeft: 12, opacity: 0.6 }}>v0.1 Alpha</span>
        </footer>
      </div>
    </div>
  );
}
