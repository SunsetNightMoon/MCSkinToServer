import type { ReactNode } from 'react'
import { Dropdown } from 'antd'
import { GlobalOutlined } from '@ant-design/icons'
import { useSiteStore } from '../../store/siteStore'
import { isVideoFile } from '../../utils/media'
import './AuthShared.css'

/**
 * 认证类页面（登录/注册/验证邮箱/忘记密码/重置密码）的共用外壳。
 *
 * 存在的理由很实际：这五个页面的背景（自定义图/视频/星空）、蒙版、语言切换、
 * 品牌区完全一致。之前只有登录与注册两页，各自抄了一份；再加三个页面就会变成
 * 五份拷贝 —— 改一次配色要动五个文件，并且必然漏掉一个。
 *
 * 这里只统一外壳，表单与文案由各页面自己提供（它们差异很大）。
 */
export function AuthLayout({
  title,
  children,
}: {
  /** 卡片标题（如「验证邮箱」） */
  title: string
  children: ReactNode
}) {
  const {
    title: siteTitle,
    logo,
    loginBgImage,
    loginEmbedImage,
    videoMuted,
    theme,
  } = useSiteStore()

  const hasCustomBg = loginBgImage && loginBgImage.trim() !== ''
  const hasEmbedImage = loginEmbedImage && loginEmbedImage.trim() !== ''
  const isBgVideo = hasCustomBg && isVideoFile(loginBgImage)
  const isEmbedVideo = hasEmbedImage && isVideoFile(loginEmbedImage)

  const langItems = [
    { key: 'SCH', label: '简体中文' },
    { key: 'TCH', label: '繁體中文' },
    { key: 'EN', label: 'English' },
    { key: 'JP', label: '日本語' },
  ]

  return (
    <div className="auth-page" data-theme={theme}>
      <div className="auth-lang-switcher">
        <Dropdown
          placement="bottomRight"
          overlayClassName="auth-lang-dropdown"
          menu={{
            items: langItems.map((item) => ({
              key: item.key,
              label: <span>{item.label}</span>,
            })),
            onClick: ({ key }) => {
              window.localStorage.setItem('cattavern-language', key)
              window.location.reload()
            },
          }}
        >
          <button type="button" className="auth-lang-switcher__btn">
            <GlobalOutlined />
          </button>
        </Dropdown>
      </div>

      {hasCustomBg ? (
        isBgVideo ? (
          <video
            className="auth-page__bg-video"
            src={loginBgImage}
            autoPlay
            loop
            muted={videoMuted}
            playsInline
          />
        ) : (
          <div
            className="auth-page__bg"
            style={{ backgroundImage: `url(${loginBgImage})` }}
          />
        )
      ) : (
        <div className="auth-page__starfield">
          <div className="starfield-bg">
            <div className="starfield-bg__stars" />
            <div className="starfield-bg__shooting-star" />
            <div className="starfield-bg__fog" />
          </div>
        </div>
      )}

      <div className="auth-page__overlay" />

      <div
        className={`auth-container ${!hasEmbedImage ? 'auth-container--no-embed' : ''}`}
      >
        {hasEmbedImage && (
          <div className="auth-embed">
            {isEmbedVideo ? (
              <video
                src={loginEmbedImage}
                className="auth-embed__video"
                autoPlay
                loop
                muted={videoMuted}
                playsInline
              />
            ) : (
              <img src={loginEmbedImage} alt="" className="auth-embed__image" />
            )}
          </div>
        )}

        <div className="auth-content">
          <div className="auth-page__logo">
            {logo ? (
              <img
                className="auth-page__logo-icon auth-page__logo-icon--img"
                src={logo}
                alt={siteTitle}
              />
            ) : (
              <div className="auth-page__logo-icon">S</div>
            )}
            <div className="auth-page__logo-text">{siteTitle}</div>
          </div>

          <div className="auth-card">
            <h2 className="auth-card__title">{title}</h2>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
