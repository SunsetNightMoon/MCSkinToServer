import { useState } from 'react';
import { Card, Form, Input, Button, App as AntdApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import type { LoginResponse } from '../api/types';

export function RegisterPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: {
    email: string;
    password: string;
    profileName: string;
  }): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<LoginResponse>('/api/auth/register', {
        method: 'POST',
        json: values,
      });
      setAuth(res.token, res.user);
      message.success('注册成功，已自动登录');
      navigate('/wardrobe');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '注册失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card bordered>
      <Form onFinish={(v) => void onFinish(v as never)} layout="vertical">
        <Form.Item
          name="email"
          label="邮箱"
          rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}
        >
          <Input placeholder="you@example.com" autoComplete="email" />
        </Form.Item>
        <Form.Item
          name="password"
          label="密码"
          rules={[
            { required: true, message: '请输入密码' },
            { min: 8, message: '密码至少 8 位' },
          ]}
        >
          <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="profileName"
          label="初始角色名"
          rules={[
            { required: true, message: '请输入角色名' },
            { pattern: /^[A-Za-z0-9_]{3,16}$/, message: '3-16 位字母/数字/下划线' },
          ]}
          extra="游戏内显示名称，注册后 30 天内可免费修改一次"
        >
          <Input placeholder="Steve_Minecraft" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading}>
          注册
        </Button>
      </Form>
    </Card>
  );
}
