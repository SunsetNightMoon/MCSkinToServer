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
} from '@ant-design/icons';
import { useAuthStore } from '../store/auth';
import { useSiteStore } from '../store/site';
import { SkinAvatar } from './SkinAvatar';
import { api } from '../api/client';
import './TopNav.css';

export interface NavItem {
  path: string;
  label: string;
  auth?: boolean;
}

export function TopNav({ links, brandOnClick }: { links: NavItem[]; brandOnClick?: () => void }) {
  const token = useAuthStore((s) => s.token);
  const isAuthenticated = token !== null;
  const { theme, toggleTheme } = useSiteStore();
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  const visibleLinks = links.filter((link) => !link.auth || isAuthenticated);

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
        <button
          className="top-nav__icon-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
        >
          {theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
        </button>
        {isAuthenticated ? (
          <>
            <div className="top-nav__avatar" title="我的衣柜" onClick={() => navigate('/wardrobe')}>
              <SkinAvatar size={34} />
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
