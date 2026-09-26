import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  RightOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useSiteStore } from '../../store/siteStore'
import { usePageTitle } from '../../hooks/usePageTitle'
import { TopNav } from '../../components/TopNav/TopNav'
import './Landing.css'

interface HomepageButton {
  text: string
  link: string
}

/* ---------- component ---------- */
export function Landing() {
  const { t } = useTranslation()
  usePageTitle(null)
  const navigate = useNavigate()
  const {
    title: siteTitle,
    theme,
    lightBgImage,
    darkBgImage,
  } = useSiteStore()
  const currentBgImage = theme === 'dark' ? darkBgImage : lightBgImage
  const [siteSettings, setSiteSettings] = useState({
    HOMEPAGE_TITLE_TEXT: t('landing.welcomePrefix'),
    HOMEPAGE_TEXT: t('landing.welcomeText'),
    HOMEPAGE_BUTTON_TEXT: t('landing.enterProfile'),
    HOMEPAGE_BUTTONS: '[]',
    // 高度自定义：开启后用管理端撰写的 HTML/CSS 替换首页主体（顶栏仍由系统渲染）
    HOMEPAGE_CUSTOM_ENABLED: 'false',
    HOMEPAGE_CUSTOM_HTML: '',
    HOMEPAGE_CUSTOM_CSS: '',
  })

  // 同步主题到 body
  useEffect(() => {
    document.body.setAttribute('data-theme', theme)
  }, [theme])

  // 加载 Landing 专用站点设置（背景图由 usePageTitle + siteStore 统一管理）
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const url = `/api/settings/public?_t=${Date.now()}`
        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          setSiteSettings({
            HOMEPAGE_TITLE_TEXT: String(data.HOMEPAGE_TITLE_TEXT || t('landing.welcomePrefix')),
            HOMEPAGE_TEXT: String(data.HOMEPAGE_TEXT || t('landing.welcomeText')),
            HOMEPAGE_BUTTON_TEXT: String(data.HOMEPAGE_BUTTON_TEXT || t('landing.enterProfile')),
            HOMEPAGE_BUTTONS: String(data.HOMEPAGE_BUTTONS || '[]'),
            // 后端以 JSON 文本存取，布尔或字符串两种历史形态都兼容
            HOMEPAGE_CUSTOM_ENABLED: String(
              data.HOMEPAGE_CUSTOM_ENABLED === true || data.HOMEPAGE_CUSTOM_ENABLED === 'true',
            ),
            HOMEPAGE_CUSTOM_HTML: String(data.HOMEPAGE_CUSTOM_HTML || ''),
            HOMEPAGE_CUSTOM_CSS: String(data.HOMEPAGE_CUSTOM_CSS || ''),
          })
        }
      } catch (err) {
        console.error('[Landing] 加载站点设置失败:', err)
      }
    }
    loadSettings()
  }, [t])

  // 判断是否有自定义背景（从全局 store 读取，根据主题选择）
  const hasCustomBg = currentBgImage && currentBgImage.trim() !== ''

  // 解析自定义按钮
  const extraButtons: HomepageButton[] = (() => {
    try {
      const parsed = JSON.parse(siteSettings.HOMEPAGE_BUTTONS || '[]')
      return Array.isArray(parsed) ? parsed.filter((b: any) => b.text && b.link) : []
    } catch {
      return []
    }
  })()

  // 高度自定义首页：开关开启**且**确实写入了 HTML 时才接管。
  // HTML 为空时不接管，否则开关一开首页会变成一片空白，管理员将无从下手（也给自己留了后路）。
  const customHtml = siteSettings.HOMEPAGE_CUSTOM_HTML.trim()
  const customCss = siteSettings.HOMEPAGE_CUSTOM_CSS
  const useCustomHomepage = siteSettings.HOMEPAGE_CUSTOM_ENABLED === 'true' && customHtml !== ''

  // 处理按钮点击：外部URL用新标签页打开，内部路由用 navigate
  const handleButtonClick = (link: string) => {
    if (link.startsWith('http://') || link.startsWith('https://')) {
      window.open(link, '_blank')
    } else {
      navigate(link)
    }
  }

  return (
          <div className={`landing-page ${hasCustomBg ? 'landing-page--custom-bg' : ''}`} data-theme={theme}>
        {/* Custom Background Image */}
        {hasCustomBg && (
          <div
            className="landing-custom-bg"
            style={{ backgroundImage: `url(${currentBgImage})` }}
          />
        )}

        {/* Background — starfield (only show if no custom bg and dark theme) */}
        {!hasCustomBg && theme === 'dark' && (
          <div className="starfield-bg">
            <div className="starfield-bg__stars" />
            <div className="starfield-bg__shooting-star" />
            <div className="starfield-bg__fog" />
          </div>
        )}

        {/* Top Navigation */}
        <TopNav
          brandOnClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          links={[
            { path: '/', label: t('nav.home') },
            { path: '/library', label: t('nav.library') },
            { path: '/upload', label: t('nav.upload'), auth: true },
            { path: '/wardrobe', label: t('nav.wardrobe'), auth: true },
            { path: '/profile', label: t('nav.profile'), auth: true },
            { path: '/admin', label: t('nav.admin'), auth: true, admin: true },
          ]}
        />

        {/* Hero —— 原版，或由管理端自定义 HTML 接管 */}
        {useCustomHomepage ? (
          <>
            {/* 管理员撰写的 CSS 原样注入（作用域为整页，含顶栏；可在其中用 .landing-page 等选择器收窄） */}
            {customCss.trim() !== '' ? (
              <style dangerouslySetInnerHTML={{ __html: customCss }} />
            ) : null}
            {/* 原样渲染，不做净化：管理员即站长，与直接改站点模板等价 */}
            <div className="landing-custom" dangerouslySetInnerHTML={{ __html: customHtml }} />
          </>
        ) : (
          <section className="landing-hero">
            <div className="landing-hero__content">
              <h1 className="landing-hero__title">
                {siteSettings.HOMEPAGE_TITLE_TEXT}
                <br />
                <span className="landing-hero__title-accent">{siteTitle}</span>
              </h1>
              <p className="landing-hero__subtitle">
                {siteSettings.HOMEPAGE_TEXT}
              </p>
              <div className="landing-hero__cta">
                <button
                  className="landing-hero__btn landing-hero__btn--primary"
                  onClick={() => navigate('/profile')}
                >
                  {siteSettings.HOMEPAGE_BUTTON_TEXT} <RightOutlined />
                </button>
                {extraButtons.map((btn, idx) => (
                  <button
                    key={idx}
                    className="landing-hero__btn landing-hero__btn--secondary"
                    onClick={() => handleButtonClick(btn.link)}
                  >
                    {btn.text}
                    <LinkOutlined style={{ fontSize: 12, marginLeft: 4 }} />
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

      </div>
  )
}
