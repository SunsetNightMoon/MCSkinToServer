import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Layout as AntLayout } from 'antd'
import { useSiteStore } from '../../store/siteStore'
import { TopNav } from '../TopNav/TopNav'
import './Layout.css'

const { Content, Footer } = AntLayout

export function Layout() {
  const location = useLocation()
  const { theme, lightBgImage, darkBgImage, lightBgOverlayOpacity, darkBgOverlayOpacity, copyrightText, copyrightBeian, copyrightProject } = useSiteStore()

  // 同步主题到 body
  useEffect(() => {
    document.body.setAttribute('data-theme', theme)
  }, [theme])

  // 根据主题选择当前背景图
  const currentBgImage = theme === 'dark' ? darkBgImage : lightBgImage
  const currentOpacity = theme === 'dark' ? darkBgOverlayOpacity : lightBgOverlayOpacity
  const hasCustomBg = currentBgImage && currentBgImage.trim() !== ''

  return (
    <div className="layout-page" data-theme={theme}>
      {/* 自定义背景图 or 星空背景 */}
      {hasCustomBg ? (
        <div
          className="layout-custom-bg"
          style={{ backgroundImage: `url(${currentBgImage})` }}
        />
      ) : (
        // 只在暗色主题显示星空背景
        theme === 'dark' && (
          <div className="starfield-bg">
            <div className="starfield-bg__stars" />
            <div className="starfield-bg__shooting-star" />
            <div className="starfield-bg__fog" />
          </div>
        )
      )}

      {/* 背景蒙版层 */}
      <div
        className="layout-overlay"
        style={{
          backgroundColor: theme === 'dark'
            ? `rgba(0, 0, 0, ${currentOpacity / 100})`
            : `rgba(255, 255, 255, ${currentOpacity / 100})`,
        }}
      />

      <AntLayout style={{ position: 'relative', zIndex: 10, background: 'transparent', minHeight: '100vh' }}>
        <TopNav
          links={[
            { path: '/', label: 'nav.home' },
            { path: '/library', label: 'nav.library' },
            { path: '/upload', label: 'nav.upload', auth: true },
            { path: '/wardrobe', label: 'nav.wardrobe', auth: true },
            { path: '/profile', label: 'nav.profile', auth: true },
            { path: '/admin', label: 'nav.admin', auth: true, admin: true },
          ]}
        />

        <Content className="layout-content">
          <div className="layout-content__inner" key={location.pathname}>
            <Outlet />
          </div>
        </Content>

        <Footer className="layout-footer">
          <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-subtle)' }}>
            <span dangerouslySetInnerHTML={{ __html: copyrightText }} />
            {copyrightBeian && (
              <span style={{ marginLeft: 12 }}>
                <a
                  href="https://beian.miit.gov.cn/#/Integrated/recordQuery"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--text-subtle)', textDecoration: 'none' }}
                >
                  {copyrightBeian}
                </a>
              </span>
            )}
            <span style={{ marginLeft: 12, opacity: 0.6 }}>
              {copyrightProject}
            </span>
          </div>
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-subtle)', opacity: 0.5, marginTop: 4 }}>
            v1.0 Alpha
          </div>
        </Footer>
      </AntLayout>
    </div>
  )
}
