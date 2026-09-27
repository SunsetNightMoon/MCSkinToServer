import { compatFetch as fetch } from '../../utils/apiCompat'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Form, Input, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { usePageTitle } from '../../hooks/usePageTitle'
import { AuthLayout } from './AuthLayout'

/**
 * 忘记密码：填写邮箱 → 发送重置链接。
 *
 * 无论邮箱是否注册过，界面一律显示「已发送」。这是与后端配套的做法
 * （后端 sendReset 对不存在的邮箱静默成功）—— 否则这个免认证页面就成了
 * 「批量试探邮箱是否注册过」的工具。
 *
 * 因此这里**不显示投递地址**：账号绑定了另一个已验证邮箱时，邮件会交叉投到那个
 * 信箱（单个信箱失守不足以改密码）。把地址回显出来等于替探测者确认「这个账号存在」，
 * 也会让收件人去翻错的那个邮箱。
 */
export function ForgotPassword() {
  const { t } = useTranslation()
  usePageTitle(t('auth.forgotPassword'))
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  const onFinish = async (values: { email: string }) => {
    setLoading(true)
    try {
      const res = await fetch('/api/auth/send-reset-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: values.email }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.errorMessage || t('auth.sendResetFailed'))
      }
      setSent(true)
    } catch (err: any) {
      message.error(err.message || t('auth.sendResetFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout title={t('auth.forgotPassword')}>
      {sent ? (
        <>
          <Alert
            message={t('auth.resetEmailSentTitle')}
            description={t('auth.resetEmailSentDesc')}
            type="success"
            showIcon
            style={{ marginBottom: 24 }}
          />
          <Button block size="large" href="#/login">
            {t('auth.goToLogin')}
          </Button>
        </>
      ) : (
        <Form layout="vertical" onFinish={onFinish}>
          <Alert
            message={t('auth.forgotPasswordHint')}
            type="info"
            showIcon
            style={{ marginBottom: 20 }}
          />
          <Form.Item
            label={t('auth.emailLabel')}
            name="email"
            rules={[
              { required: true, type: 'email', message: t('auth.emailInvalid') },
            ]}
          >
            <Input placeholder={t('auth.emailPlaceholder')} size="large" />
          </Form.Item>

          <Form.Item style={{ marginBottom: 16 }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              size="large"
            >
              {t('auth.sendResetEmail')}
            </Button>
          </Form.Item>

          <div className="auth-card__footer">
            <Link to="/login">{t('auth.backToLogin')}</Link>
          </div>
        </Form>
      )}
    </AuthLayout>
  )
}
