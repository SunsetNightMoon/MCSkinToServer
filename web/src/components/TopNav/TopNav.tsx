import { Link, useNavigate, useLocation } from 'react-router-dom'
import { LoginOutlined, SettingOutlined, SunOutlined, MoonOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../store/authStore'
import { useSiteStore } from '../../store/siteStore'
import { SkinAvatar } from '../SkinAvatar'
import { LanguageSwitcher } from '../LanguageSwitcher/LanguageSwitcher'
import './TopNav.css'

export interface NavItem {
  path: string
  label: string
  auth?: boolean
  admin?: boolean
}

interface TopNavProps {
  links: NavItem[]
  brandOnClick?: () => void
}

export function TopNav({ links, brandOnClick }: TopNavProps) {
  const { isAuthenticated, user, skinUrl, profileName } = useAuthStore()
  const { title, description, logo, theme, toggleTheme } = useSiteStore()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/'
    }
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  const visibleLinks = links.filter((link) => {
    if (link.auth && !isAuthenticated) return false
    if (link.admin && (!user || user.level < 1)) return false
    return true
  })

  const handleBrandClick = () => {
    if (brandOnClick) {
      brandOnClick()
    } else {
      navigate('/')
    }
  }

  return (
    <nav className="top-nav">
      {/* Brand */}
      <div className="top-nav__brand" onClick={handleBrandClick}>
        {/* 站点图标：管理端设置 SITE_LOGO 后用它，未设置则回退到内置的 CSS "S" 方块 */}
        {logo ? (
          <img className="top-nav__brand-logo top-nav__brand-logo--img" src={logo} alt={title} />
        ) : (
          <div className="top-nav__brand-logo">S</div>
        )}
        <div>
          <div className="top-nav__brand-text">{title}</div>
          <div className="top-nav__brand-sub">{description}</div>
        </div>
      </div>

      {/* Center Nav Links */}
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

      {/* Right: Lang / Theme Toggle / User / Login */}
      <div className="top-nav__right">
        <LanguageSwitcher
          buttonClassName="top-nav__icon-btn"
          overlayClassName="top-nav__lang-dropdown"
        />
        <button
          className="top-nav__theme-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? t('common.switchToLight') : t('common.switchToDark')}
        >
          {theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
        </button>
        {isAuthenticated ? (
          <>
            {user && user.level >= 1 && (
              <button className="top-nav__icon-btn" onClick={() => navigate('/admin')} title={t('nav.admin')}>
                <SettingOutlined />
              </button>
            )}
            <div
              className="top-nav__avatar"
              onClick={() => navigate('/profile')}
              title={profileName || user?.email || t('nav.profile')}
            >
              <SkinAvatar skinUrl={skinUrl || undefined} size={36} border={false} />
            </div>
          </>
        ) : (
          <button className="top-nav__icon-btn" onClick={() => navigate('/login')} title={t('nav.login')}>
            <LoginOutlined />
          </button>
        )}
      </div>
    </nav>
  )
}
