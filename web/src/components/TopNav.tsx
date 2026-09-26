/**
 * 共享顶部导航（plan3 设计）：brand + 中间链接 + 右侧工具区（主题切换 / 头像 / 登录）
 * 语言切换（GlobalOutlined + Dropdown）待 i18n 批次接入。
 */

import { Link, useNavigate, useLocation } from 'react-router-dom';
import {
  LoginOutlined,
  SunOutlined,
  MoonOutlined,
  LogoutOutlined,
  SettingOutlined,
  GlobalOutlined,
} from '@ant-design/icons';
import { Dropdown } from 'antd';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth';
import { useSiteStore } from '../store/site';
import { SkinAvatar } from './SkinAvatar';
import { api } from '../api/client';
import './TopNav.css';

export interface NavItem {
  path: string;
  label: string;
  auth?: boolean;
  admin?: boolean;
}

const LANG_ITEMS = [
  { key: 'SCH', label: '简体中文' },
  { key: 'TCH', label: '繁體中文' },
  { key: 'EN', label: 'English' },
  { key: 'JP', label: '日本語' },
];

export function TopNav({ links, brandOnClick }: { links: NavItem[]; brandOnClick?: () => void }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const skinUrl = useAuthStore((s) => s.skinUrl);
  const setSkinUrl = useAuthStore((s) => s.setSkinUrl);
  const isAuthenticated = token !== null;
  const { theme, toggleTheme } = useSiteStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [lang, setLang] = useState('SCH');

  // 登录后拉取当前用户默认角色的皮肤（头像显示）
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api<{ skinUrl: string | null }>('/api/me/skin')
      .then((res) => {
        if (!cancelled) setSkinUrl(res.skinUrl);
      })
      .catch(() => {
        /* 忽略：头像回落到默认脸 */
      });
    return () => {
      cancelled = true;
    };
  }, [token, setSkinUrl, location.pathname]);

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  const visibleLinks = links.filter((link) => {
    if (link.auth && !isAuthenticated) return false;
    if (link.admin && !(user && (user.role === 'admin' || user.role === 'super_admin'))) return false;
    return true;
  });

  const handleLogout = async (): Promise<void> => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // 忽略登出失败，本地态照清
    }
    useAuthStore.getState().clearAuth();
    navigate('/login');
  };

  return (
    <nav className="top-nav">
      <div
        className="top-nav__brand"
        onClick={() => (brandOnClick ? brandOnClick() : navigate('/'))}
      >
        <div className="top-nav__brand-logo">M</div>
        <div>
          <div className="top-nav__brand-text">MSCTS</div>
          <div className="top-nav__brand-sub">Minecraft Skin Server</div>
        </div>
      </div>

      <div className="top-nav__links">
        {visibleLinks.map((link) => (
          <Link
            key={link.path}
            to={link.path}
            className={`top-nav__link${isActive(link.path) ? ' top-nav__link--active' : ''}`}
          >
            {link.label}
          </Link>
        ))}
      </div>

      <div className="top-nav__right">
        <Dropdown
          placement="bottomRight"
          menu={{
            items: LANG_ITEMS,
            onClick: ({ key }) => setLang(key),
            selectedKeys: [lang],
          }}
        >
          <button className="top-nav__icon-btn" title="语言 Language">
            <GlobalOutlined />
          </button>
        </Dropdown>
        <button
          className="top-nav__icon-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
        >
          {theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
        </button>
        {isAuthenticated ? (
          <>
            {user && (user.role === 'admin' || user.role === 'super_admin') && (
              <button
                className="top-nav__icon-btn"
                onClick={() => navigate('/admin')}
                title="管理后台"
              >
                <SettingOutlined />
              </button>
            )}
            <div className="top-nav__avatar" title="个人中心" onClick={() => navigate('/profile')}>
              <SkinAvatar skinUrl={skinUrl ?? undefined} size={34} />
            </div>
            <button
              className="top-nav__icon-btn"
              onClick={() => void handleLogout()}
              title="登出"
            >
              <LogoutOutlined />
            </button>
          </>
        ) : (
          <button
            className="top-nav__icon-btn"
            onClick={() => navigate('/login')}
            title="登录"
          >
            <LoginOutlined />
          </button>
        )}
      </div>
    </nav>
  );
}
