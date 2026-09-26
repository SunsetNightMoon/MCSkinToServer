import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout, Menu } from 'antd';
import {
  UserOutlined,
  SkinOutlined,
  GlobalOutlined,
  LogoutOutlined,
  LoginOutlined,
} from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import { LoginPage } from './pages/Login';
import { RegisterPage } from './pages/Register';
import { ProfilesPage } from './pages/Profiles';
import { WardrobePage } from './pages/Wardrobe';
import { LibraryPage } from './pages/Library';
import { api } from './api/client';

const { Header, Sider, Content } = Layout;

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { user, clearAuth } = useAuthStore();

  const logout = async (): Promise<void> => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // 忽略登出失败，本地态照清
    }
    clearAuth();
    navigate('/login');
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={200} style={{ borderRight: '1px solid #f0f0f0' }}>
        <div
          style={{
            height: 48,
            lineHeight: '48px',
            textAlign: 'center',
            fontWeight: 600,
            color: '#0078d7',
            fontSize: 16,
          }}
        >
          MSCTS
        </div>
        <Menu
          mode="inline"
          defaultSelectedKeys={[location.pathname]}
          items={[
            { key: '/wardrobe', icon: <SkinOutlined />, label: <Link to="/wardrobe">我的衣柜</Link> },
            { key: '/profiles', icon: <UserOutlined />, label: <Link to="/profiles">我的角色</Link> },
            { key: '/library', icon: <GlobalOutlined />, label: <Link to="/library">公开库</Link> },
          ]}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 16,
            paddingInline: 24,
            height: 48,
            lineHeight: '48px',
          }}
        >
          <span style={{ color: '#666' }}>{user?.email}</span>
          <a onClick={() => void logout()} style={{ color: '#0078d7' }}>
            <LogoutOutlined /> 登出
          </a>
        </Header>
        <Content style={{ padding: 24, maxWidth: 1080, width: '100%', margin: '0 auto' }}>
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}

function AuthShell({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (token) return <Navigate to="/wardrobe" replace />;
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f7fa',
      }}
    >
      <div style={{ width: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <span style={{ fontSize: 22, fontWeight: 600, color: '#0078d7' }}>MSCTS</span>
          <div style={{ color: '#999', fontSize: 13 }}>Minecraft 皮肤站</div>
        </div>
        {children}
        <div style={{ textAlign: 'center', marginTop: 16, color: '#999', fontSize: 13 }}>
          <Link to="/login">
            <LoginOutlined /> 已有账号？登录
          </Link>
          {' · '}
          <Link to="/register">注册新账号</Link>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<AuthShell><LoginPage /></AuthShell>} />
        <Route path="/register" element={<AuthShell><RegisterPage /></AuthShell>} />
        <Route
          path="/wardrobe"
          element={<RequireAuth><Shell><WardrobePage /></Shell></RequireAuth>}
        />
        <Route
          path="/profiles"
          element={<RequireAuth><Shell><ProfilesPage /></Shell></RequireAuth>}
        />
        <Route path="/library" element={<Shell><LibraryPage /></Shell>} />
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </HashRouter>
  );
}
