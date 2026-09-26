import { compatFetch as fetch } from '../../utils/apiCompat'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Alert, Button, Form, Input, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { usePageTitle } from '../../hooks/usePageTitle'
import { AuthLayout } from './AuthLayout'

/**
 * 重置密码落地页：从重置邮件里的链接进入，携带一次性令牌。
 *
 * 与「验证邮箱」不同，这里**不自动提交** —— 提交需要一个用户自己定的新密码，
 * 没法自动完成。令牌只随表单一起送出去。
 *
 * 密码长度前端按 8 位校验，与后端 `assertValidPassword` 的 8-128 保持一致；
 * 前端若比后端宽松，用户会填完提交才被拒，且看到的还是通用错误。
 */

const MIN_PASSWORD_LENGTH = 8

export function ResetPassword() {
  const { t } = useTranslation()
  usePageTitle(t('auth.resetPasswordTitle'))
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''

  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const onFinish = async (values: { password: string }) => {
    setLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: values.password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.errorMessage || t('auth.resetFailed'))
      }
      setDone(true)
    } catch (err: any) {
      message.error(err.message || t('auth.resetFailed'))
    } finally {
      setLoading(false)
    }
  }

  const hasToken = token.trim() !== ''

  return (
    <AuthLayout title={t('auth.resetPasswordTitle')}>
      {!hasToken ? (
        <>
          <Alert
            message={t('auth.resetMissingToken')}
            description={t('auth.resetMissingTokenDesc')}
            type="error"
            showIcon
            style={{ marginBottom: 24 }}
          />
          <Button type="primary" block size="large" href="#/forgot-password">
            {t('auth.forgotPassword')}
          </Button>
        </>
      ) : done ? (
        <>
          <Alert
            message={t('auth.resetSuccessTitle')}
            description={t('auth.resetSuccessDesc')}
            type="success"
            showIcon
            style={{ marginBottom: 24 }}
          />
          <Button type="primary" block size="large" href="#/login">
            {t('auth.goToLogin')}
          </Button>
        </>
      ) : (
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Alert
            message={t('auth.resetPasswordHint')}
            type="info"
            showIcon
            style={{ marginBottom: 20 }}
          />
          <Form.Item
            label={t('auth.newPasswordLabel')}
            name="password"
            rules={[
              { required: true, message: t('auth.passwordPlaceholder') },
              {
                min: MIN_PASSWORD_LENGTH,
                message: t('auth.passwordMinLengthStrict', {
                  count: MIN_PASSWORD_LENGTH,
                }),
              },
            ]}
          >
            <Input.Password placeholder={t('auth.passwordPlaceholder')} size="large" />
          </Form.Item>

          <Form.Item
            label={t('auth.confirmPasswordLabel')}
            name="confirm"
            dependencies={['password']}
            rules={[
              { required: true, message: t('auth.confirmPasswordRequired') },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error(t('auth.passwordMismatch')))
                },
              }),
            ]}
          >
            <Input.Password placeholder={t('auth.confirmPasswordLabel')} size="large" />
          </Form.Item>

          <Form.Item style={{ marginBottom: 16 }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              size="large"
            >
              {t('auth.resetPasswordButton')}
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
