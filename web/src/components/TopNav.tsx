/**
 * 共享顶部导航（plan3 设计）：brand + 中间链接 + 右侧工具区
 * 语言下拉接 i18n.changeLanguage，持久化 localStorage「cattavern-language」。
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
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

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

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

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
            {t(link.label)}
          </Link>
        ))}
      </div>

      <div className="top-nav__right">
        <Dropdown
          placement="bottomRight"
          overlayClassName="top-nav__lang-dropdown"
          menu={{
            items: LANG_ITEMS.map((item) => ({
              key: item.key,
              label: <span>{item.label}</span>,
            })),
            onClick: ({ key }) => {
              void i18n.changeLanguage(key);
              window.localStorage.setItem('cattavern-language', key);
            },
            selectedKeys: [i18n.language || 'SCH'],
          }}
        >
          <button className="top-nav__icon-btn" title={t('common.language')}>
            <GlobalOutlined />
          </button>
        </Dropdown>
        <button
          className="top-nav__theme-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? t('common.switchToLight') : t('common.switchToDark')}
        >
          {theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
        </button>
        {isAuthenticated ? (
          <>
            {user && (user.role === 'admin' || user.role === 'super_admin') && (
              <button
                className="top-nav__icon-btn"
                onClick={() => navigate('/admin')}
                title={t('nav.admin')}
              >
                <SettingOutlined />
              </button>
            )}
            <div
              className="top-nav__avatar"
              onClick={() => navigate('/profile')}
              title={t('nav.profile')}
            >
              <SkinAvatar skinUrl={skinUrl ?? undefined} size={34} />
            </div>
            <button
              className="top-nav__icon-btn"
              onClick={() => void handleLogout()}
              title={t('auth.logout')}
            >
              <LogoutOutlined />
            </button>
          </>
        ) : (
          <button
            className="top-nav__icon-btn"
            onClick={() => navigate('/login')}
            title={t('nav.login')}
          >
            <LoginOutlined />
          </button>
        )}
      </div>
    </nav>
  );
}
