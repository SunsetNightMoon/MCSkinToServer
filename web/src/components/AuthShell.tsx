/**
 * 认证页壳（plan3 风格）：星空背景 + 居中玻璃卡片 + 品牌 + 底部链接
 */

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { LoginOutlined } from '@ant-design/icons';
import { useSiteStore } from '../store/site';

export function AuthShell({ children }: { children: ReactNode }) {
  const theme = useSiteStore((s) => s.theme);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div style={{ minHeight: '100dvh', position: 'relative', overflowX: 'hidden' }}>
      {theme === 'dark' ? (
        <div className="starfield-bg">
          <div className="starfield-bg__stars" />
          <div className="starfield-bg__shooting-star" />
          <div className="starfield-bg__fog" />
        </div>
      ) : (
        <div className="light-bg" />
      )}

      <div
        style={{
          position: 'relative',
          zIndex: 10,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <div style={{ width: 380 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div
              style={{
                width: 48,
                height: 48,
                margin: '0 auto 10px',
                borderRadius: 10,
                background: 'linear-gradient(135deg, #4a9eff, #6b5ce7)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 24,
                fontWeight: 700,
                color: '#fff',
              }}
            >
              M
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
              MSCTS
            </div>
            <div style={{ color: 'var(--text-subtle)', fontSize: 13, letterSpacing: '0.1em' }}>
              MINECRAFT SKIN SERVER
            </div>
          </div>

          <div
            className="glass-card"
            style={{
              borderRadius: 10,
              padding: '24px 24px 20px',
            }}
          >
            {children}
          </div>

          <div
            style={{
              textAlign: 'center',
              marginTop: 16,
              color: 'var(--text-subtle)',
              fontSize: 13,
            }}
          >
            <Link to="/login">
              <LoginOutlined /> 已有账号？登录
            </Link>
            {' · '}
            <Link to="/register">注册新账号</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
