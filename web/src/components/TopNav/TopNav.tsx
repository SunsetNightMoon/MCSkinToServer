import { Link, useNavigate, useLocation } from 'react-router-dom'
import { LoginOutlined, SettingOutlined, SunOutlined, MoonOutlined, GlobalOutlined } from '@ant-design/icons'
import { Dropdown } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../store/authStore'
import { useSiteStore } from '../../store/siteStore'
import { SkinAvatar } from '../SkinAvatar'
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

const LANG_ITEMS = [
  { key: 'SCH', label: '简体中文' },
  { key: 'TCH', label: '繁體中文' },
  { key: 'EN', label: 'English' },
  { key: 'JP', label: '日本語' },
]

export function TopNav({ links, brandOnClick }: TopNavProps) {
  const { isAuthenticated, user, skinUrl, profileName } = useAuthStore()
  const { title, description, theme, toggleTheme } = useSiteStore()
  const { t, i18n } = useTranslation()
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
        <div className="top-nav__brand-logo">S</div>
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
        <Dropdown
          placement="bottomRight"
          overlayClassName="top-nav__lang-dropdown"
          menu={{
            items: LANG_ITEMS.map((item) => ({
              key: item.key,
              label: <span>{item.label}</span>,
            })),
            onClick: ({ key }) => {
              i18n.changeLanguage(key)
              window.localStorage.setItem('cattavern-language', key)
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
