import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
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
import { TurnstileWidget } from '../../components/TurnstileWidget/TurnstileWidget'
import './AuthShared.css'
import { isVideoFile } from '../../utils/media'

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
  const [emailOptions, setEmailOptions] = useState<SelectProps<string>['options']>([])
  // MSCTS 未启用验证码：后端返回 type='none'，此时整块验证码 UI 不渲染
  const [captchaType, setCaptchaType] = useState<'turnstile' | 'math' | 'none'>('none')
  const [turnstileToken, setTurnstileToken] = useState<string>('')
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string>('')
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
  const { title, loginBgImage, loginEmbedImage, videoMuted, theme, allowRegistration } = useSiteStore()

  const hasCustomBg = loginBgImage && loginBgImage.trim() !== ''
  const hasEmbedImage = loginEmbedImage && loginEmbedImage.trim() !== ''
  const isBgVideo = hasCustomBg && isVideoFile(loginBgImage)
  const isEmbedVideo = hasEmbedImage && isVideoFile(loginEmbedImage)

  const loadCaptcha = async () => {
    try {
      const sessionId = Math.random().toString(36).substring(2, 15)
      const response = await fetch(`/api/captcha/generate?sessionId=${sessionId}`)
      const data = await response.json()
      setCaptchaSessionId(sessionId)
      setCaptchaQuestion(data.question)
    } catch (error) {
      console.error('加载验证码失败:', error)
    }
  }

  useEffect(() => {
    const fetchCaptchaType = async () => {
      try {
        const response = await fetch('/api/captcha/captcha-type')
        const data = await response.json()
        setCaptchaType(data.type)
        if (data.type === 'turnstile' && data.siteKey) {
          setTurnstileSiteKey(data.siteKey)
        }
        if (data.type === 'math') {
          loadCaptcha()
        }
      } catch {
        loadCaptcha()
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

  const handleTurnstileVerify = useCallback((token: string) => {
    setTurnstileToken(token)
  }, [])

  const handleTurnstileError = useCallback((error: string) => {
    message.error(error)
    setTurnstileToken('')
  }, [])

  const onFinish = async (values: any) => {
    setLoading(true)
    try {
      const registerData: RegisterDTO = {
        email: values.email,
        password: values.password,
        profile_name: values.profile_name,
      }

      if (captchaType === 'turnstile') {
        registerData.turnstile_token = turnstileToken
      } else {
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
      if (captchaType === 'math') {
        loadCaptcha()
      } else {
        setTurnstileToken('')
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
            <div className="auth-page__logo-icon">S</div>
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
                { min: 6, message: t('auth.passwordMin') },
              ]}
            >
              <Input.Password placeholder={t('auth.passwordPlaceholder') + ' ' + t('auth.passwordMin')} size="large" />
            </Form.Item>

            {captchaType !== 'none' && (captchaType === 'turnstile' ? (
              <Form.Item label={t('auth.captcha')}>
                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  mode="managed"
                  onVerify={handleTurnstileVerify}
                  onError={handleTurnstileError}
                />
              </Form.Item>
            ) : (
              <>
                <Form.Item label={t('auth.captchaMath')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Input
                      value={captchaQuestion}
                      disabled
                      style={{ width: '180px', fontWeight: 'bold' }}
                      size="large"
                    />
                    <Button onClick={loadCaptcha} size="large">{t('auth.captchaRefresh')}</Button>
                  </div>
                </Form.Item>

                <Form.Item
                  name="captcha_answer"
                  label={t('auth.captchaAnswerLabel')}
                  rules={[{ required: true, message: t('auth.captchaAnswerPlaceholder') }]}
                >
                  <Input placeholder={t('auth.captchaAnswerPlaceholder')} style={{ width: '180px' }} size="large" />
                </Form.Item>
              </>
            ))}

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
