import { useState } from 'react';
import { Form, Input, Button, App as AntdApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { AuthShell } from '../components/AuthShell';
import type { LoginResponse } from '../api/types';

export function LoginPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
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
      message.success('登录成功');
      navigate('/wardrobe');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <Form onFinish={(v) => void onFinish(v as never)} layout="vertical">
        <Form.Item
          name="email"
          label="邮箱"
          rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}
        >
          <Input placeholder="you@example.com" autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="密码" autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading} size="large">
          登录
        </Button>
      </Form>
    </AuthShell>
  );
}
