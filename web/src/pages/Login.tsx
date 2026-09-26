import { useState } from 'react';
import { Form, Input, Button, App as AntdApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { usePageTitle } from '../hooks/usePageTitle';
import { AuthShell } from '../components/AuthShell';
import type { LoginResponse } from '../api/types';

export function LoginPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { t } = useTranslation();
  usePageTitle(t('auth.login'));
  const setAuth = useAuthStore((s) => s.setAuth);
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { email: string; password: string }): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        json: values,
      });
      setAuth(res.token, res.user);
      message.success(t('auth.loginSuccess'));
      navigate('/wardrobe');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('auth.loginFailedRetry'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <Form onFinish={(v) => void onFinish(v as never)} layout="vertical">
        <Form.Item
          name="email"
          label={t('auth.emailLabel')}
          rules={[
            { required: true, message: t('auth.emailPlaceholder') },
            { type: 'email', message: t('auth.emailInvalid') },
          ]}
        >
          <Input placeholder={t('auth.emailPlaceholder')} autoComplete="email" />
        </Form.Item>
        <Form.Item
          name="password"
          label={t('auth.passwordLabel')}
          rules={[{ required: true, message: t('auth.passwordPlaceholder') }]}
        >
          <Input.Password placeholder={t('auth.passwordPlaceholder')} autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading} size="large">
          {t('auth.loginButton')}
        </Button>
      </Form>
    </AuthShell>
  );
}
