import { compatFetch as fetch } from '../../utils/apiCompat'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Alert, Button, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { usePageTitle } from '../../hooks/usePageTitle'
import { AuthLayout } from './AuthLayout'

/**
 * 邮箱验证落地页。
 *
 * 邮件里的链接形如 `https://<站点根>/#/verify-email?token=xxx`（HashRouter，
 * 路径必须在 `#` 之后，否则静态托管只会返回 404）。本页面进入即**自动提交**令牌，
 * 不要求用户再点一次按钮 —— 用户点邮件链接的意图已经足够明确，
 * 再让他在新页面上点「确认」纯属多余，而这多余的一步会实打实掉转化。
 *
 * 令牌是一次性的：重复打开同一链接会得到「已被使用」。因此提交用 ref 加锁，
 * 避免 React 严格模式下的双次 effect 把令牌消费两次（第二次必然失败并覆盖掉成功态）。
 */

type Status = 'pending' | 'success' | 'error'

export function VerifyEmail() {
  const { t } = useTranslation()
  usePageTitle(t('auth.verifyEmailTitle'))
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''

  const [status, setStatus] = useState<Status>('pending')
  const [errorMessage, setErrorMessage] = useState('')
  const [email, setEmail] = useState('')
  // 一次性令牌只能提交一次，用 ref 挡住重复提交
  const submittedRef = useRef(false)

  useEffect(() => {
    if (submittedRef.current) return
    submittedRef.current = true

    if (token.trim() === '') {
      setStatus('error')
      setErrorMessage(t('auth.verifyMissingToken'))
      return
    }

    void (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.errorMessage || t('auth.verifyFailed'))
        }
        setEmail(data.email ?? '')
        setStatus('success')
      } catch (err: any) {
        setErrorMessage(err.message || t('auth.verifyFailed'))
        setStatus('error')
      }
    })()
  }, [token, t])

  return (
    <AuthLayout title={t('auth.verifyEmailTitle')}>
      {status === 'pending' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin />
          <p style={{ marginTop: 16, marginBottom: 0 }}>
            {t('auth.verifying')}
          </p>
        </div>
      )}

      {status === 'success' && (
        <>
          <Alert
            message={t('auth.verifySuccessTitle')}
            description={
              email
                ? t('auth.verifySuccessDesc', { email })
                : t('auth.verifySuccessDescNoEmail')
            }
            type="success"
            showIcon
            style={{ marginBottom: 24 }}
          />
          <Button type="primary" block size="large" href="#/login">
            {t('auth.goToLogin')}
          </Button>
        </>
      )}

      {status === 'error' && (
        <>
          <Alert
            message={t('auth.verifyFailed')}
            description={errorMessage}
            type="error"
            showIcon
            style={{ marginBottom: 24 }}
          />
          {/* 链接过期或已被使用是常见情况，必须给出可执行的下一步：
              去登录页，那里能在登录失败时就地重发验证邮件 */}
          <Button type="primary" block size="large" href="#/login">
            {t('auth.resendFromLogin')}
          </Button>
          <div className="auth-card__footer" style={{ marginTop: 16 }}>
            <Link to="/">{t('auth.backToHome')}</Link>
          </div>
        </>
      )}
    </AuthLayout>
  )
}
