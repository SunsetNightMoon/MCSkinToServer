import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Form, Input, Button, message, Alert, AutoComplete, Divider, Dropdown } from 'antd'
import { GlobalOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { SelectProps } from 'antd'
import { authService } from '../../services/authService'
import type { RegisterDTO } from '../../types'
import { useSiteStore } from '../../store/siteStore'
import { usePageTitle } from '../../hooks/usePageTitle'
import { ExternalCaptchaWidget } from '../../components/ExternalCaptchaWidget/ExternalCaptchaWidget'
import './AuthShared.css'
import { isVideoFile } from '../../utils/media'
// 密码长度口径：与后端（8-128 位）保持一致，见 utils/passwordPolicy.ts 的说明
import { MIN_PASSWORD_LENGTH } from '../../utils/passwordPolicy'

const EMAIL_SUFFIXES = [
  '163.com',
  'gmail.com',
  'qq.com',
  'outlook.com',
  'yahoo.com',
  'hotmail.com',
  'icloud.com',
  'foxmail.com',
]

function getEmailOptions(input: string): SelectProps<string>['options'] {
  if (!input || input.includes('@')) return []
  return EMAIL_SUFFIXES.map(suffix => ({
    label: `${input}@${suffix}`,
    value: `${input}@${suffix}`,
  }))
}

export function Register() {
  const { t } = useTranslation()
  usePageTitle(t('auth.register'))
  const [form] = Form.useForm()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [captchaSessionId, setCaptchaSessionId] = useState<string>('')
  const [captchaQuestion, setCaptchaQuestion] = useState<string>('')
  // 出题失败（限流/服务不可用）时的提示与加载态：没有这两项，失败就表现为空白题干
  const [captchaError, setCaptchaError] = useState<string>('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const [emailOptions, setEmailOptions] = useState<SelectProps<string>['options']>([])
  // 后端 captcha-type 的四种取值；'none' 时整块验证码 UI 不渲染
  const [captchaType, setCaptchaType] = useState<'external' | 'image' | 'math' | 'none'>('none')
  /** 图片题的 <img> 地址（换一道时靠变化的查询参数绕开浏览器缓存） */
  const [captchaImageSrc, setCaptchaImageSrc] = useState<string>('')
  const [captchaToken, setCaptchaToken] = useState<string>('')
  const [externalSiteKey, setExternalSiteKey] = useState<string>('')
  const [externalScriptUrl, setExternalScriptUrl] = useState<string>('')
  const [externalGlobalName, setExternalGlobalName] = useState<string>('')
  const [oauthProviders, setOauthProviders] = useState<{ github: boolean; microsoft: boolean }>({ github: false, microsoft: false })

  const handleEmailSearch = (value: string) => {
    if (!value || value.includes('@')) {
      setEmailOptions([])
      return
    }
    setEmailOptions(getEmailOptions(value))
  }

  const handleEmailSelect = (value: string) => {
    form.setFieldValue('email', value)
    setEmailOptions([])
  }
  const { title, loginBgImage, loginEmbedImage, videoMuted, theme, allowRegistration, logo } = useSiteStore()

  const hasCustomBg = loginBgImage && loginBgImage.trim() !== ''
  const hasEmbedImage = loginEmbedImage && loginEmbedImage.trim() !== ''
  const isBgVideo = hasCustomBg && isVideoFile(loginBgImage)
  const isEmbedVideo = hasEmbedImage && isVideoFile(loginEmbedImage)

  const loadCaptcha = async (
    // 首次出题与拿到 captcha-type 同刻触发，那时 state 还没更新，类型必须由调用方给
    type: 'external' | 'image' | 'math' | 'none' = captchaType,
  ) => {
    setCaptchaLoading(true)
    setCaptchaError('')
    const sessionId = Math.random().toString(36).substring(2, 15)
    try {
      if (type === 'image') {
        // 图片题不走 JSON：题干与答案都不该出现在响应体里，<img> 直接吃这个 URL
        setCaptchaSessionId(sessionId)
        setCaptchaQuestion('')
        setCaptchaImageSrc(`/api/captcha/image?sessionId=${sessionId}&t=${Date.now()}`)
        return
      }
      const response = await fetch(`/api/captcha/generate?sessionId=${sessionId}`)
      // 必须查 response.ok：拿到 429/503 时若照旧读 data.question，题干会渲染成
      // 一个空白输入框 —— 用户填不出、也看不到任何提示，等于把注册整条路堵死。
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        setCaptchaSessionId('')
        setCaptchaQuestion('')
        setCaptchaError(
          data?.errorMessage || data?.message || t('auth.captchaLoadFailed'),
        )
        return
      }
      const data = await response.json()
      if (!data?.question) {
        setCaptchaSessionId('')
        setCaptchaQuestion('')
        setCaptchaError(t('auth.captchaLoadFailed'))
        return
      }
      setCaptchaSessionId(sessionId)
      setCaptchaQuestion(data.question)
    } catch (error) {
      console.error('加载验证码失败:', error)
      setCaptchaSessionId('')
      setCaptchaQuestion('')
      setCaptchaError(t('auth.captchaLoadFailed'))
    } finally {
      setCaptchaLoading(false)
    }
  }

  useEffect(() => {
    const fetchCaptchaType = async () => {
      try {
        const response = await fetch('/api/captcha/captcha-type')
        const data = await response.json()
        const nextType: 'external' | 'image' | 'math' | 'none' =
          data.type ?? 'none'
        setCaptchaType(nextType)
        if (nextType === 'external') {
          // siteKey 可以公开（它只标识本站在对方服务里的身份）；secret 永远只在服务端
          setExternalSiteKey(data.siteKey || '')
          setExternalScriptUrl(data.scriptUrl || '')
          setExternalGlobalName(data.globalName || '')
        }
        if (nextType === 'math' || nextType === 'image') {
          loadCaptcha(nextType)
        }
      } catch {
        // 问不到类型就按「不启用」处理。此时 UI 不渲染，再去出题只会白烧配额。
        setCaptchaType('none')
      }
    }
    fetchCaptchaType()
  }, [])

  useEffect(() => {
    const fetchOAuthProviders = async () => {
      try {
        const response = await fetch('/api/auth/oauth/providers')
        const data = await response.json()
        setOauthProviders(data)
      } catch {
        // ignore
      }
    }
    fetchOAuthProviders()
  }, [])

  const handleExternalVerify = useCallback((token: string) => {
    setCaptchaToken(token)
  }, [])

  const handleExternalError = useCallback(
    (reason: 'load' | 'unavailable' | 'verify' | 'expired') => {
      // 组件只给原因码，文案在这里出，四语言才能跟上
      message.error(
        reason === 'load' || reason === 'unavailable'
          ? t('auth.captchaExternalLoadFailed')
          : t('auth.captchaExternalVerifyFailed'),
      )
      setCaptchaToken('')
    },
    [t],
  )

  const onFinish = async (values: any) => {
    // 题目没就绪就提交必然是白跑一趟（后端只会回 CAPTCHA_INVALID），
    // 而且会把「为什么失败」掩盖成一句笼统的注册失败。这里先拦住并说清原因。
    if ((captchaType === 'math' || captchaType === 'image') && !captchaSessionId) {
      message.error(captchaError || t('auth.captchaLoadFailed'))
      return
    }
    // 外部验证的 token 是异步拿到的，用户手快就会在 widget 出结果前提交；
    // 后端此时只会回一句 CAPTCHA_INVALID，看不出「还没验证」。
    if (captchaType === 'external' && !captchaToken) {
      message.error(t('auth.captchaExternalPending'))
      return
    }
    setLoading(true)
    try {
      const registerData: RegisterDTO = {
        email: values.email,
        password: values.password,
        profile_name: values.profile_name,
      }

      if (captchaType === 'external') {
        registerData.captcha_token = captchaToken
      } else if (captchaType !== 'none') {
        // math 与 image 回传同一对字段（sessionId + 答案），后端共用一条校验路径
        registerData.captcha_session_id = captchaSessionId
        registerData.captcha_answer = values.captcha_answer
      }

      const result = await authService.register(registerData)

      // 站点要求邮箱验证：后端刻意不下发会话，此时不能提示「注册成功」就完事 ——
      // 用户会以为已经登录，实际还得去点邮件里的链接。
      if (result.requiresVerification) {
        if (result.verificationEmailSent === false) {
          // 账号已建成但信没发出去。如实告知，并给出重发入口所在的页面。
          message.warning(t('auth.registerVerificationMailFailed'), 8)
        } else {
          message.success(
            t('auth.registerVerificationSent', { email: values.email }),
            8,
          )
        }
        navigate('/login')
        return
      }

      if (result.isFirstUser) {
        message.success(t('auth.registerSuccessFirst'))
      } else {
        message.success(t('auth.registerSuccess'))
      }
      navigate('/login')
    } catch (error: any) {
      message.error(error.response?.data?.errorMessage || t('auth.registerFailed'))
      if (captchaType === 'math' || captchaType === 'image') {
        // 答错（或注册被拒）都要换一道：后端一次一题，旧题已被消费
        loadCaptcha()
      } else {
        setCaptchaToken('')
      }
    } finally {
      setLoading(false)
    }
  }

  const langItems = [
    { key: 'SCH', label: '简体中文' },
    { key: 'TCH', label: '繁體中文' },
    { key: 'EN', label: 'English' },
    { key: 'JP', label: '日本語' },
  ]

  return (
    <div className="auth-page" data-theme={theme}>
      {/* 语言切换 */}
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

      <div className={`auth-container ${!hasEmbedImage ? 'auth-container--no-embed' : ''}`}>
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
                alt={title}
              />
            ) : (
              <div className="auth-page__logo-icon">S</div>
            )}
            <div className="auth-page__logo-text">{title}</div>
          </div>

          <div className="auth-card">
          <h2 className="auth-card__title">{t('auth.register')}</h2>

          {/* 站点关闭注册时不渲染表单：让用户填完整张表再被 403 拒绝是最差的体验 */}
          {!allowRegistration ? (
            <Alert
              message={t('auth.registerClosedTitle')}
              description={
                <>
                  {t('auth.registerClosedDesc')}{' '}
                  <Link to="/login">{t('auth.loginNow')}</Link>
                </>
              }
              type="warning"
              showIcon
              style={{ marginBottom: 24 }}
            />
          ) : (
            <>
          <Alert
            message={t('auth.registerGuideTitle')}
            description={t('auth.registerGuideDesc')}
            type="info"
            showIcon
            style={{ marginBottom: 24 }}
          />

          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Form.Item
              label={t('auth.profileNameLabel')}
              name="profile_name"
              rules={[
                { required: true, message: t('auth.profileNameRequired') },
                { min: 3, max: 16, message: t('auth.profileNameMin') },
                { pattern: /^[a-zA-Z0-9_]+$/, message: t('auth.profileNamePattern') },
              ]}
            >
              <Input placeholder={t('auth.profileNamePlaceholder')} size="large" />
            </Form.Item>

            <Form.Item
              label={t('auth.emailLabel')}
              name="email"
              rules={[{ required: true, type: 'email', message: t('auth.emailInvalid') }]}
            >
              <AutoComplete
                options={emailOptions}
                onSearch={handleEmailSearch}
                onSelect={handleEmailSelect}
                onBlur={() => setTimeout(() => setEmailOptions([]), 200)}
                placeholder={t('auth.emailPlaceholder')}
                size="large"
              />
            </Form.Item>

            <Form.Item
              label={t('auth.passwordLabel')}
              name="password"
              rules={[
                { required: true, message: t('auth.passwordPlaceholder') },
                { min: MIN_PASSWORD_LENGTH, message: t('auth.passwordMin') },
              ]}
            >
              <Input.Password placeholder={t('auth.passwordPlaceholder') + ' ' + t('auth.passwordMin')} size="large" />
            </Form.Item>

            {captchaType === 'external' && (
              <Form.Item label={t('auth.captcha')}>
                <ExternalCaptchaWidget
                  siteKey={externalSiteKey}
                  scriptUrl={externalScriptUrl}
                  globalName={externalGlobalName}
                  onVerify={handleExternalVerify}
                  onError={handleExternalError}
                />
              </Form.Item>
            )}

            {(captchaType === 'math' || captchaType === 'image') && (
              <>
                <Form.Item
                  label={captchaType === 'image' ? t('auth.captchaImage') : t('auth.captchaMath')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {captchaType === 'image' ? (
                      // 图片题：图本身就是题干；加载失败要说清，否则只剩一个破图标
                      <img
                        src={captchaImageSrc}
                        alt={t('auth.captchaImageAlt')}
                        width={190}
                        height={64}
                        style={{ borderRadius: 6, background: '#f5f7fa', display: 'block' }}
                        onError={() => setCaptchaError(t('auth.captchaLoadFailed'))}
                      />
                    ) : (
                      <Input
                        value={captchaQuestion}
                        disabled
                        status={captchaError ? 'error' : undefined}
                        placeholder={captchaError ? '—' : undefined}
                        style={{ width: '180px', fontWeight: 'bold' }}
                        size="large"
                      />
                    )}
                    <Button onClick={() => loadCaptcha()} loading={captchaLoading} size="large">
                      {t('auth.captchaRefresh')}
                    </Button>
                  </div>
                  {/*
                    错误文案刻意用普通 div + 内联样式，不走 Form.Item 的 help 插槽。
                    实测 help 的文字确实进了 DOM，但 antd 的 explain 动效让它
                    始终不落定（截图里完全看不到），等于没有提示。这里零动效、必现。
                  */}
                  {captchaError ? (
                    <div
                      style={{
                        color: '#ff4d4f',
                        fontSize: 13,
                        lineHeight: '20px',
                        marginTop: 8,
                      }}
                    >
                      {captchaError}
                    </div>
                  ) : null}
                </Form.Item>

                <Form.Item
                  name="captcha_answer"
                  label={t('auth.captchaAnswerLabel')}
                  rules={[
                    {
                      required: true,
                      message:
                        captchaType === 'image'
                          ? t('auth.captchaImageAnswerPlaceholder')
                          : t('auth.captchaAnswerPlaceholder'),
                    },
                  ]}
                >
                  <Input
                    disabled={!captchaSessionId}
                    placeholder={
                      captchaType === 'image'
                        ? t('auth.captchaImageAnswerPlaceholder')
                        : t('auth.captchaAnswerPlaceholder')
                    }
                    style={{ width: '180px' }}
                    size="large"
                  />
                </Form.Item>
              </>
            )}

            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">
                {t('auth.registerButton')}
              </Button>
            </Form.Item>

            <div className="auth-card__footer">
              <span>{t('auth.hasAccount')} </span>
              <Link to="/login">{t('auth.loginNow')}</Link>
            </div>
          </Form>
            </>
          )}

          {(oauthProviders.github || oauthProviders.microsoft) && (
            <>
              <Divider style={{ borderColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.45)', margin: '20px 0' }}>{t('auth.thirdPartyLogin')}</Divider>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                {oauthProviders.github && (
                  <Button
                    size="large"
                    icon={
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" style={{ verticalAlign: '-2px' }}>
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                      </svg>
                    }
                    href="/api/auth/oauth/github"
                    className="oauth-btn oauth-btn--github"
                  >
                    {t('auth.githubLogin')}
                  </Button>
                )}
                {oauthProviders.microsoft && (
                  <Button
                    size="large"
                    icon={
                      <svg viewBox="0 0 21 21" width="16" height="16" style={{ verticalAlign: '-2px' }}>
                        <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                        <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                        <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                        <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                      </svg>
                    }
                    href="/api/auth/oauth/microsoft"
                    className="oauth-btn oauth-btn--microsoft"
                  >
                    {t('auth.microsoftLogin')}
                  </Button>
                )}
              </div>
            </>
          )}
          </div>
        </div>
      </div>

    </div>
  )
}
