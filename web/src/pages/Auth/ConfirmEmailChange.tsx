import { compatFetch as fetch } from '../../utils/apiCompat'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Alert, Button, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useAuthStore } from '../../store/authStore'
import { AuthLayout } from './AuthLayout'
import type { EmailChangeConfirmResult } from '../../services/accountSecurityService'

/**
 * 邮箱变更确认落地页（0003）。
 *
 * 改邮箱会发出**两封**信（新地址验证 + 另一侧授权），两封里的链接都指向
 * `#/confirm-email-change?token=xxx`，本页按令牌自动提交：
 * - 后端的 confirm 端点在两枚令牌都消费后**就地收敛**（tryFinalize），
 *   所以「最后点击的那个人」直接看到变更完成；
 * - 只确认了一侧时展示「等待另一邮箱」，个人中心的进行中面板会轮询
 *   finalize 自愈并发点击的竞态，本页不重复做轮询。
 */

type Status = 'pending' | 'done' | 'waiting' | 'error'

export function ConfirmEmailChange() {
  const { t } = useTranslation()
  usePageTitle(t('auth.confirmChangeTitle'))
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  const [status, setStatus] = useState<Status>('pending')
  const [errorMessage, setErrorMessage] = useState('')
  const [result, setResult] = useState<EmailChangeConfirmResult | null>(null)
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
        const res = await fetch('/api/me/email-change/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const data = (await res.json().catch(() => ({}))) as Partial<EmailChangeConfirmResult> & { errorMessage?: string }
        if (!res.ok) {
          throw new Error(data.errorMessage || t('auth.confirmChangeFailed'))
        }
        setResult(data as EmailChangeConfirmResult)
        setStatus(data.completed ? 'done' : 'waiting')
      } catch (err: any) {
        setErrorMessage(err.message || t('auth.confirmChangeFailed'))
        setStatus('error')
      }
    })()
  }, [token, t])

  return (
    <AuthLayout title={t('auth.confirmChangeTitle')}>
      {status === 'pending' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin />
          <p style={{ marginTop: 16, marginBottom: 0 }}>
            {t('auth.verifying')}
          </p>
        </div>
      )}

      {status === 'done' && (
        <>
          <Alert
            message={t('auth.confirmChangeDoneTitle')}
            description={
              result?.email
                ? t('auth.confirmChangeDoneDesc', { email: result.email })
                : t('auth.confirmChangeDoneDescNoEmail')
            }
            type="success"
            showIcon
            style={{ marginBottom: 24 }}
          />
          <Button type="primary" block size="large" href="#/profile">
            {t('auth.goToProfile')}
          </Button>
        </>
      )}

      {status === 'waiting' && (
        <>
          <Alert
            message={t('auth.confirmChangeWaitingTitle')}
            description={
              result?.waitingFor === 'authorize'
                ? t('auth.confirmChangeWaitingAuthorize')
                : t('auth.confirmChangeWaitingVerify')
            }
            type="info"
            showIcon
            style={{ marginBottom: 24 }}
          />
          {isAuthenticated ? (
            <Button type="primary" block size="large" href="#/profile">
              {t('auth.confirmChangeGoProfile')}
            </Button>
          ) : (
            <Button type="primary" block size="large" href="#/login">
              {t('auth.goToLogin')}
            </Button>
          )}
          <div className="auth-card__footer" style={{ marginTop: 16 }}>
            <Link to="/">{t('auth.backToHome')}</Link>
          </div>
        </>
      )}

      {status === 'error' && (
        <>
          <Alert
            message={t('auth.confirmChangeFailed')}
            description={errorMessage}
            type="error"
            showIcon
            style={{ marginBottom: 24 }}
          />
          <Button type="primary" block size="large" href="#/profile">
            {t('auth.goToProfile')}
          </Button>
          <div className="auth-card__footer" style={{ marginTop: 16 }}>
            <Link to="/">{t('auth.backToHome')}</Link>
          </div>
        </>
      )}
    </AuthLayout>
  )
}
