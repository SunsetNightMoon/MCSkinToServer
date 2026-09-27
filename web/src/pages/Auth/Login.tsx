import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Form, Input, Button, message, AutoComplete, Divider, Dropdown, Modal } from 'antd'
import { GlobalOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { SelectProps } from 'antd'
import { authService } from '../../services/authService'
import { useAuthStore, roleToLevel } from '../../store/authStore'
import { useSiteStore } from '../../store/siteStore'
import { usePageTitle } from '../../hooks/usePageTitle'
import { ExternalCaptchaWidget } from '../../components/ExternalCaptchaWidget/ExternalCaptchaWidget'
import { isVideoFile } from '../../utils/media'
import './AuthShared.css'

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

export function Login() {
  const { t } = useTranslation()
  usePageTitle(t('auth.login'))
  const [form] = Form.useForm()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const setAuth = useAuthStore((state) => state.setAuth)
  const { title, loginBgImage, loginEmbedImage, videoMuted, theme, logo } = useSiteStore()

  const hasCustomBg = loginBgImage && loginBgImage.trim() !== ''
  const hasEmbedImage = loginEmbedImage && loginEmbedImage.trim() !== ''
  const isBgVideo = hasCustomBg && isVideoFile(loginBgImage)
  const isEmbedVideo = hasEmbedImage && isVideoFile(loginEmbedImage)

  const [emailOptions, setEmailOptions] = useState<SelectProps<string>['options']>([])
  const [captchaSessionId, setCaptchaSessionId] = useState<string>('')
  const [captchaQuestion, setCaptchaQuestion] = useState<string>('')
  // 出题失败（限流/服务不可用）时的提示与加载态：没有这两项，失败就表现为空白题干
  const [captchaError, setCaptchaError] = useState<string>('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  // 后端 captcha-type 的四种取值；'none' 时整块验证码 UI 不渲染
  const [captchaType, setCaptchaType] = useState<'external' | 'image' | 'math' | 'none'>('none')
  /** 图片题的 <img> 地址（换一道时靠变化的查询参数绕开浏览器缓存） */
  const [captchaImageSrc, setCaptchaImageSrc] = useState<string>('')
  const [captchaToken, setCaptchaToken] = useState<string>('')
  const [externalSiteKey, setExternalSiteKey] = useState<string>('')
  const [externalScriptUrl, setExternalScriptUrl] = useState<string>('')
  const [externalGlobalName, setExternalGlobalName] = useState<string>('')
  const [oauthProviders, setOauthProviders] = useState<{ github: boolean; microsoft: boolean }>({ github: false, microsoft: false })
  // 账号处于注销宽限期时，登录会被拒（ACCOUNT_DELETED）；此处保留凭据用于一键恢复
  const [deletedAccount, setDeletedAccount] = useState<{ email: string; password: string; message: string } | null>(null)
  const [restoring, setRestoring] = useState(false)
  /**
   * 邮箱未验证（EMAIL_NOT_VERIFIED）：此时凭据是对的，但站点要求先验证邮箱。
   * 用户已经在登录页了，必须能就地重发验证邮件，否则他只能去翻收件箱里那封旧信。
   */
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null)
  const [resending, setResending] = useState(false)

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

  const loadCaptcha = async (
    // 首次出题是在拿到 captcha-type 的同一刻触发的，那时 state 还没更新，
    // 所以类型必须由调用方显式给，不能只读 captchaType
    type: 'external' | 'image' | 'math' | 'none' = captchaType,
  ) => {
    setCaptchaLoading(true)
    setCaptchaError('')
    const sessionId = Math.random().toString(36).substring(2, 15)
    try {
      if (type === 'image') {
        // 图片题不走 JSON：题干与答案都不该出现在响应体里，<img> 直接吃这个 URL。
        // t 参数只为绕开浏览器缓存 —— 同一个 sessionId 换一道时不能拿到旧图。
        setCaptchaSessionId(sessionId)
        setCaptchaQuestion('')
        setCaptchaImageSrc(`/api/captcha/image?sessionId=${sessionId}&t=${Date.now()}`)
        return
      }
      const response = await fetch(`/api/captcha/generate?sessionId=${sessionId}`)
      // 必须查 response.ok：拿到 429/503 时若照旧读 data.question，题干会渲染成
      // 一个空白输入框 —— 用户填不出、也看不到任何提示，登录这条路就堵死了。
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
          // siteKey 可以公开（它只标识站点在对方服务里的身份）；secret 永远只在服务端
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
    // 而且会把「为什么失败」掩盖成一句笼统的登录失败。这里先拦住并说清原因。
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
      const loginData: any = {
        email: values.email,
        password: values.password,
      }

      if (captchaType === 'external') {
        loginData.captcha_token = captchaToken
      } else if (captchaType !== 'none') {
        // math 与 image 回传的是同一对字段（sessionId + 答案），后端共用一条校验路径
        loginData.captcha_session_id = captchaSessionId
        loginData.captcha_answer = values.captcha_answer
      }

      const data = await authService.login(loginData)

      const profileName = data.profileName || null
      const profileId = data.profiles?.[0]?.id || null
      setAuth(data.accessToken, data.user, data.skinUrl, profileName, profileId)

      message.success(t('auth.loginSuccess'))
      navigate('/')
    } catch (error: any) {
      const code = error.response?.data?.error
      const msg = error.response?.data?.errorMessage || t('auth.loginFailed')
      if (code === 'ACCOUNT_DELETED') {
        // 账号已注销但仍在 15 天宽限期内：不开错误提示，改为弹恢复入口
        setDeletedAccount({
          email: values.email,
          password: values.password,
          message: msg,
        })
      } else if (code === 'EMAIL_NOT_VERIFIED') {
        // 不是「登录失败」，而是「还差一步」：弹重发入口而不是报错
        setUnverifiedEmail(values.email)
      } else {
        message.error(msg)
      }
      if (captchaType === 'math' || captchaType === 'image') {
        // 答错（或密码错）都要换一道：后端一次一题，旧题已被消费
        loadCaptcha()
      } else {
        // 外部验证的 token 同样是一次性的，清掉让用户重新勾一次
        setCaptchaToken('')
      }
    } finally {
      setLoading(false)
    }
  }

  // 宽限期内恢复已注销账号：成功后直接建立会话
  const handleRestoreAccount = async () => {
    if (!deletedAccount) return
    setRestoring(true)
    try {
      const response = await fetch('/api/auth/restore-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: deletedAccount.email,
          password: deletedAccount.password,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.errorMessage || t('auth.restoreFailed'))
      }

      const skin = await fetch('/api/me/skin', {
        headers: { Authorization: `Bearer ${data.token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)

      setAuth(
        data.token,
        {
          id: data.user.id,
          user_uid: data.user.userUid,
          email: data.user.email,
          role: data.user.role,
          level: roleToLevel(data.user.role),
          is_active: true,
          email_verified: data.user.emailVerified,
          banned_until: null,
        },
        skin?.skinUrl ?? null,
        skin?.profileName ?? data.profile?.name ?? null,
        data.profile?.id ?? null,
      )

      message.success(t('auth.restoreSuccess'))
      setDeletedAccount(null)
      navigate('/')
    } catch (err: any) {
      message.error(err.message || t('auth.restoreFailed'))
    } finally {
      setRestoring(false)
    }
  }

  /** 重发验证邮件（未登录状态：后端按请求体邮箱处理） */
  const handleResendVerification = async () => {
    if (!unverifiedEmail) return
    setResending(true)
    try {
      const res = await fetch('/api/auth/send-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: unverifiedEmail }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.errorMessage || t('auth.resendVerificationFailed'))
      }
      message.success(t('auth.resendVerificationSent'))
      setUnverifiedEmail(null)
    } catch (err: any) {
      message.error(err.message || t('auth.resendVerificationFailed'))
    } finally {
      setResending(false)
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
          <h2 className="auth-card__title">{t('auth.login')}</h2>

          <Form form={form} layout="vertical" onFinish={onFinish}>
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
              rules={[{ required: true, message: t('auth.passwordPlaceholder') }]}
            >
              <Input.Password placeholder={t('auth.passwordPlaceholder')} size="large" />
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
                      // 图片题：图本身就是题干。加载失败必须说清 —— 否则只剩一个
                      // 破图标，用户不知道是网络问题还是本站没配好。
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
                {t('auth.loginButton')}
              </Button>
            </Form.Item>

            <div className="auth-card__footer">
              <Link to="/forgot-password">{t('auth.forgotPassword')}</Link>
            </div>

            <div className="auth-card__footer">
              <span>{t('auth.noAccount')} </span>
              <Link to="/register">{t('auth.registerNow')}</Link>
            </div>
          </Form>

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

      {/* 注销宽限期内的恢复入口 */}
      <Modal
        open={deletedAccount !== null}
        title={t('auth.restoreAccount')}
        okText={t('auth.restoreAccount')}
        cancelText={t('common.cancel')}
        confirmLoading={restoring}
        onOk={handleRestoreAccount}
        onCancel={() => setDeletedAccount(null)}
      >
        <p style={{ marginBottom: 0 }}>{deletedAccount?.message}</p>
      </Modal>

      {/* 邮箱未验证：就地重发，避免用户只能去翻旧邮件 */}
      <Modal
        open={unverifiedEmail !== null}
        title={t('auth.emailNotVerifiedTitle')}
        okText={t('auth.resendVerification')}
        cancelText={t('common.cancel')}
        confirmLoading={resending}
        onOk={handleResendVerification}
        onCancel={() => setUnverifiedEmail(null)}
      >
        <p style={{ marginBottom: 0 }}>
          {t('auth.emailNotVerifiedDesc', { email: unverifiedEmail ?? '' })}
        </p>
      </Modal>
    </div>
  )
}
