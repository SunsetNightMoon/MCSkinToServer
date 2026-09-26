/**
 * 布局壳（plan3 设计）：星空背景（暗）/ 浅色渐变（亮）+ TopNav + 内容区 + Footer
 * 主题同步到 body[data-theme]，index.css 的变量与 AntD 覆盖依赖它。
 */

import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useSiteStore } from '../store/site';
import { TopNav, type NavItem } from './TopNav';

export const NAV_LINKS: NavItem[] = [
  { path: '/', label: '首页' },
  { path: '/library', label: '公开库' },
  { path: '/wardrobe', label: '我的衣柜', auth: true },
  { path: '/profiles', label: '我的角色', auth: true },
  { path: '/admin', label: '管理后台', auth: true, admin: true },
];

export function AppLayout() {
  const theme = useSiteStore((s) => s.theme);

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
          style={{
            maxWidth: 1080,
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
