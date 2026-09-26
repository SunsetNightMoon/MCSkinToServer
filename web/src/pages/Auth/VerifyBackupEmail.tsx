import { compatFetch as fetch } from '../../utils/apiCompat'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Alert, Button, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { usePageTitle } from '../../hooks/usePageTitle'
import { AuthLayout } from './AuthLayout'

/**
 * 备用邮箱验证落地页（0003）。
 *
 * 邮件链接形如 `https://<站点根>/#/verify-backup-email?token=xxx`。
 * 与 /verify-email 同一交互口径：进入即自动提交令牌，不让用户再点一次。
 * 一次性令牌用 ref 加锁，挡掉 React 严格模式的双次 effect。
 */

type Status = 'pending' | 'success' | 'error'

export function VerifyBackupEmail() {
  const { t } = useTranslation()
  usePageTitle(t('auth.verifyBackupTitle'))
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''

  const [status, setStatus] = useState<Status>('pending')
  const [errorMessage, setErrorMessage] = useState('')
  const [email, setEmail] = useState('')
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
        const res = await fetch('/api/me/backup-email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.errorMessage || t('auth.verifyBackupFailed'))
        }
        setEmail(data.email ?? '')
        setStatus('success')
      } catch (err: any) {
        setErrorMessage(err.message || t('auth.verifyBackupFailed'))
        setStatus('error')
      }
    })()
  }, [token, t])

  return (
    <AuthLayout title={t('auth.verifyBackupTitle')}>
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
            message={t('auth.verifyBackupSuccessTitle')}
            description={
              email
                ? t('auth.verifyBackupSuccessDesc', { email })
                : t('auth.verifyBackupSuccessDescNoEmail')
            }
            type="success"
            showIcon
            style={{ marginBottom: 24 }}
          />
          {/* 与主邮箱验证不同：这里用户大概率已登录（绑定动作发生在个人中心），
              落点是个人中心而不是登录页 */}
          <Button type="primary" block size="large" href="#/profile">
            {t('auth.goToProfile')}
          </Button>
        </>
      )}

      {status === 'error' && (
        <>
          <Alert
            message={t('auth.verifyBackupFailed')}
            description={errorMessage}
            type="error"
            showIcon
            style={{ marginBottom: 24 }}
          />
          <Button type="primary" block size="large" href="#/profile">
            {t('auth.resendFromProfile')}
          </Button>
          <div className="auth-card__footer" style={{ marginTop: 16 }}>
            <Link to="/">{t('auth.backToHome')}</Link>
          </div>
        </>
      )}
    </AuthLayout>
  )
}
