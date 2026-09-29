import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect } from 'react'
import { Layout, Menu, Spin, Statistic, Row, Col, Card, message } from 'antd'
import {
  DashboardOutlined,
  UserOutlined,
  SkinOutlined,
  SettingOutlined,
  AppstoreOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { useAuthStore } from '../../store/authStore'
import { useSiteStore } from '../../store/siteStore'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useTranslation } from 'react-i18next'
import UserManagement from './UserManagement'
import SkinApproval from './SkinApproval'
import CapeApproval from './CapeApproval'
import { SystemSettings } from './SystemSettings'
import ProfileModeSettings from './ProfileModeSettings'
import AdminSkinManagement from './AdminSkinManagement'
import AdminCapeManagement from './AdminCapeManagement'
import AdminErrorBoundary from './AdminErrorBoundary'
import { PluginManagement } from './PluginManagement'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'

const { Sider, Content } = Layout

interface AdminDashboardProps {}

export function AdminDashboard(_props: AdminDashboardProps) {
  const { t } = useTranslation()
  usePageTitle(t('nav.admin'))
  const { user } = useAuthStore()
  
  // 从 localStorage 读取上次的活动标签页，默认 'dashboard'
  const [activeTab, setActiveTab] = useState(() => {
    try {
      return localStorage.getItem('admin-active-tab') || 'dashboard'
    } catch {
      return 'dashboard'
    }
  })

  // 持久化 activeTab 到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem('admin-active-tab', activeTab)
    } catch (error) {
      console.error('保存管理面板标签页状态失败:', error)
    }
  }, [activeTab])

  if (!user || user.level < 1) {
    return <div>{t('admin.noPermission')}</div>
  }

  const isSuperAdmin = user.level >= 2

  const menuItems: MenuProps['items'] = [
    {
      key: 'dashboard',
      icon: <DashboardOutlined />,
      label: t('admin.dashboard'),
    },
    {
      key: 'users',
      icon: <UserOutlined />,
      label: t('admin.userManagement'),
      // level >= 1 可用（管理员以上）
    },
    {
      key: 'skins',
      icon: <SkinOutlined />,
      label: t('admin.skinApproval'),
      // level >= 1 可用
    },
    {
      key: 'capes',
      icon: <SkinOutlined />,
      label: t('admin.capeApproval'),
      // level >= 1 可用
    },
    {
      key: 'skin-management',
      icon: <AppstoreOutlined />,
      label: t('admin.skinManagement'),
      // level >= 1 可用（管理员可管理所有皮肤）
    },
    {
      key: 'cape-management',
      icon: <AppstoreOutlined />,
      label: t('admin.capeManagement'),
      // level >= 1 可用（管理员可管理所有披风）
    },
    // 「用户名模式」单独一页（P5 第十一批）：全站统一设置，仅超管可见可切
    ...(isSuperAdmin ? [{
      key: 'profile-mode',
      icon: <UserSwitchOutlined />,
      label: t('admin.profileModePageTitle'),
    }] : []),
    // 「黑名单」页签已摘除：MCSTS 既没有封禁名单表也没有 `/api/admin/blacklist` 端点，
    // 旧版页面靠兼容层返回假数据（永远「暂无记录」）撑着 —— 那是死页面。
    // 封禁能力本身在（用户管理里的封禁按钮走 PATCH /api/admin/users/:id），
    // 只是没有独立的名单页。`BlacklistManagement.tsx` 暂时保留不挂载，等后端补表再启用。
    ...(isSuperAdmin ? [{
      key: 'settings',
      icon: <SettingOutlined />,
      label: t('admin.systemSettings'),
    }] : []),
    // 插件台账（仅超管）：装插件等于往本站进程加代码，这个决定不该由管理员做出
    ...(isSuperAdmin ? [{
      key: 'plugins',
      icon: <AppstoreOutlined />,
      label: t('admin.plugins'),
    }] : []),
  ]

  const renderContent = () => {
    const content = (() => {
      switch (activeTab) {
        case 'dashboard':
          return <DashboardContent />
        case 'users':
          return <UserManagement />
        case 'skins':
          return <SkinApproval />
        case 'capes':
          return <CapeApproval />
        case 'skin-management':
          return <AdminSkinManagement />
        case 'cape-management':
          return <AdminCapeManagement />
        case 'profile-mode':
          return <ProfileModeSettings />
        case 'settings':
          return <SystemSettings />
        case 'plugins':
          return <PluginManagement />
        default:
          return <DashboardContent />
      }
    })()
    
    return <AdminErrorBoundary>{content}</AdminErrorBoundary>
  }

  return (
    <Layout style={{ minHeight: '80vh' }}>
      <Sider 
        style={{ background: 'rgba(255,255,255,0.06)' }}
      >
        <Menu
          mode="inline"
          selectedKeys={[activeTab]}
          items={menuItems}
          onClick={({ key }) => setActiveTab(key)}
          style={{ height: '100%', borderRight: 0 }}
        />
      </Sider>
      <Content style={{ padding: '20px', overflowX: 'auto' }}>
        <Spin spinning={false}>
          {renderContent()}
        </Spin>
      </Content>
    </Layout>
  )
}

// 仪表盘组件
function DashboardContent() {
  const { t } = useTranslation()
  const theme = useSiteStore((s) => s.theme)
  const isDark = theme === 'dark'

  // recharts 颜色配置
  const axisColor = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.45)'
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'
  const tooltipBg = isDark ? '#1a1a2e' : '#fff'
  const tooltipBorder = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.06)'
  const tooltipColor = isDark ? '#fff' : '#333'
  const legendColor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.65)'
  const cardTitleColor = isDark ? '#fff' : '#1a1a2e'

  const [stats, setStats] = useState({
    userCount: 0,
    skinCount: 0,
    pendingCount: 0,
  })
  const [dailyStats, setDailyStats] = useState<{
    days: string[];
    skinUploads: number[];
    capeUploads: number[];
    userRegistrations: number[];
    pendingSubmissions: number[];
    banCounts: number[];
  }>({ days: [], skinUploads: [], capeUploads: [], userRegistrations: [], pendingSubmissions: [], banCounts: [] })
  const [loading, setLoading] = useState(true)
  const [chartsLoading, setChartsLoading] = useState(true)
  const { token } = useAuthStore()

  useEffect(() => {
    loadStats()
    loadDailyStats()
  }, [])

  const loadStats = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/stats', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) throw new Error(t('common.requestFailed'))
      const data = await response.json()
      setStats(data)
    } catch (error) {
      message.error(t('admin.loadStatsFailed'))
      console.error(t('admin.loadStatsFailed') + ':', error)
    } finally {
      setLoading(false)
    }
  }

  const loadDailyStats = async () => {
    setChartsLoading(true)
    try {
      const response = await fetch('/api/admin/stats/daily?days=7', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) throw new Error(t('common.requestFailed'))
      const data = await response.json()
      setDailyStats(data)
    } catch (error) {
      message.error(t('admin.loadTrendFailed'))
      console.error(t('admin.loadTrendFailed') + ':', error)
    } finally {
      setChartsLoading(false)
    }
  }

  // 将 dailyStats 转换为 Recharts 数据格式
  const chartData = dailyStats.days.map((date, i) => ({
    date: date.slice(5), // MM-DD 格式
    fullDate: date,
    skinUploads: dailyStats.skinUploads[i] ?? 0,
    capeUploads: dailyStats.capeUploads[i] ?? 0,
    userRegistrations: dailyStats.userRegistrations[i] ?? 0,
    pendingSubmissions: dailyStats.pendingSubmissions[i] ?? 0,
    banCounts: dailyStats.banCounts[i] ?? 0,
  }))

  return (
    <div>
      <h2>{t('admin.dashboard')}</h2>

      {/* 统计卡片 */}
      <Row gutter={20} style={{ marginTop: 20 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('admin.userCount')}
              value={stats.userCount}
              loading={loading}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('admin.skinCount')}
              value={stats.skinCount}
              loading={loading}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('admin.pendingCount')}
              value={stats.pendingCount}
              loading={loading}
              valueStyle={{ color: '#faad14' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 折线图区域 */}
      <Spin spinning={chartsLoading}>
        {/* 投稿趋势：皮肤 + 披风 */}
        <Card title={t('admin.uploadTrend')} style={{ marginTop: 20 }} headStyle={{ color: cardTitleColor }}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="date" tick={{ fill: axisColor }} />
              <YAxis tick={{ fill: axisColor }} />
              <Tooltip
                contentStyle={{
                  background: tooltipBg,
                  border: `1px solid ${tooltipBorder}`,
                  color: tooltipColor,
                }}
              />
              <Legend wrapperStyle={{ color: legendColor }} />
              <Line
                type="monotone"
                dataKey="skinUploads"
                name={t('admin.skinUploads')}
                stroke="#4a9eff"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="capeUploads"
                name={t('admin.capeUploads')}
                stroke="#a78bfa"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {/* 用户注册趋势 */}
        <Card title={t('admin.registrationTrend')} style={{ marginTop: 20 }} headStyle={{ color: cardTitleColor }}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="date" tick={{ fill: axisColor }} />
              <YAxis tick={{ fill: axisColor }} />
              <Tooltip
                contentStyle={{
                  background: tooltipBg,
                  border: `1px solid ${tooltipBorder}`,
                  color: tooltipColor,
                }}
              />
              <Legend wrapperStyle={{ color: legendColor }} />
              <Line
                type="monotone"
                dataKey="userRegistrations"
                name={t('admin.newUsers')}
                stroke="#34d399"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {/* 待审核趋势 */}
        <Card title={t('admin.pendingTrend')} style={{ marginTop: 20 }} headStyle={{ color: cardTitleColor }}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="date" tick={{ fill: axisColor }} />
              <YAxis tick={{ fill: axisColor }} />
              <Tooltip
                contentStyle={{
                  background: tooltipBg,
                  border: `1px solid ${tooltipBorder}`,
                  color: tooltipColor,
                }}
              />
              <Legend wrapperStyle={{ color: legendColor }} />
              <Line
                type="monotone"
                dataKey="pendingSubmissions"
                name={t('admin.pendingNew')}
                stroke="#fbbf24"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {/* 封禁趋势 */}
        <Card title={t('admin.banTrend')} style={{ marginTop: 20 }} headStyle={{ color: cardTitleColor }}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="date" tick={{ fill: axisColor }} />
              <YAxis tick={{ fill: axisColor }} />
              <Tooltip
                contentStyle={{
                  background: tooltipBg,
                  border: `1px solid ${tooltipBorder}`,
                  color: tooltipColor,
                }}
              />
              <Legend wrapperStyle={{ color: legendColor }} />
              <Line
                type="monotone"
                dataKey="banCounts"
                name={t('admin.newBans')}
                stroke="#ff4d4f"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </Spin>
    </div>
  )
}
