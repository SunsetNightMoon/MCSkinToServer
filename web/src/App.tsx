import { Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useAuthStore } from './store/authStore'
import { useSiteStore } from './store/siteStore'
import { Layout } from './components/Layout/Layout'
import { PageLoading } from './components/PageLoading/PageLoading'
import { profileService } from './services/profileService'
import { setAuthClearHandler } from './utils/api'
// 入口页保持预加载：它是首屏，懒加载会让首屏多一个往返
import { Landing } from './pages/Landing/Landing'

/**
 * 页面级懒加载。收益来自三点：
 *  1. three + skinview3d（~509KB）只有进 3D 相关页面才下载
 *  2. recharts（~312KB）只有进管理后台才下载
 *  3. monaco（~12KB 包装层，真正的编辑器引擎）同样只在管理后台设置页下载
 * 首屏（Landing + Layout + antd）不需要以上任何一项。
 */
const Login = lazy(() => import('./pages/Auth/Login').then((m) => ({ default: m.Login })))
const Register = lazy(() => import('./pages/Auth/Register').then((m) => ({ default: m.Register })))
// 邮箱验证 / 忘记密码 / 重置密码：都由邮件里的链接落地，属于低频入口，懒加载
const VerifyEmail = lazy(() =>
  import('./pages/Auth/VerifyEmail').then((m) => ({ default: m.VerifyEmail })),
)
const VerifyBackupEmail = lazy(() =>
  import('./pages/Auth/VerifyBackupEmail').then((m) => ({ default: m.VerifyBackupEmail })),
)
const ConfirmEmailChange = lazy(() =>
  import('./pages/Auth/ConfirmEmailChange').then((m) => ({ default: m.ConfirmEmailChange })),
)
const ForgotPassword = lazy(() =>
  import('./pages/Auth/ForgotPassword').then((m) => ({ default: m.ForgotPassword })),
)
const ResetPassword = lazy(() =>
  import('./pages/Auth/ResetPassword').then((m) => ({ default: m.ResetPassword })),
)
const SkinLibrary = lazy(() =>
  import('./pages/Library/SkinLibrary').then((m) => ({ default: m.SkinLibrary })),
)
const SkinDetail = lazy(() =>
  import('./pages/SkinDetail/SkinDetail').then((m) => ({ default: m.SkinDetail })),
)
const CapeDetail = lazy(() =>
  import('./pages/CapeDetail/CapeDetail').then((m) => ({ default: m.CapeDetail })),
)
const SkinUpload = lazy(() =>
  import('./pages/Upload/SkinUpload').then((m) => ({ default: m.SkinUpload })),
)
const Wardrobe = lazy(() =>
  import('./pages/Wardrobe/Wardrobe').then((m) => ({ default: m.Wardrobe })),
)
const UserProfile = lazy(() =>
  import('./pages/Profile/UserProfile').then((m) => ({ default: m.UserProfile })),
)
const AdminDashboard = lazy(() =>
  import('./pages/Admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
)
const MySkins = lazy(() => import('./pages/MySkins/MySkins'))
const MyCapes = lazy(() => import('./pages/MySkins/MyCapes'))
const SetupWizard = lazy(() => import('./pages/Setup/SetupWizard'))

/**
 * 路由表保持旧版一致，仅去掉 MCSTS 没有后端支持的部分：
 *  - /oauth-success OAuth 回调（MCSTS 无 OAuth）
 * 页面文件仍在（构建不受影响），只是不挂路由。
 *
 * /setup 安装向导（P5 第十二批）不走 hash 路由：它由 App 顶部的安装守卫
 * 全屏接管（setupGate === 'installing' 时只渲染 <SetupWizard/>），
 * 装完之前任何 hash 路由都不可达。
 */
function App() {
  const { isAuthenticated, user, updateUser, setSkinUrl, clearAuth } = useAuthStore()

  // ---- 安装守卫（P5 第十二批）----
  // 挂载时拉一次 /api/setup/status：未完成则全屏接管、只渲染向导，
  // 任何 hash 路由都进不去（装完之前网站不该可访问）。
  // 判定以 **mode（进程真实状态）** 为准而不是 setup_completed（文件状态）：
  // 向导刚装完、后端软重启生效前，文件已落盘但业务接口还会被 403 拦。
  // 拉取失败按「已安装」处理 —— 纯前端 dev（后端未起 / 代理未配）不应被误锁。
  const [setupGate, setSetupGate] = useState<'checking' | 'installed' | 'installing'>('checking')
  useEffect(() => {
    let cancelled = false
    fetch('/api/setup/status')
      .then((r) => (r.ok ? r.json() : { setup_completed: true, mode: 'installed' }))
      .then((d) => {
        if (!cancelled) {
          setSetupGate(d?.mode === 'installed' || (d?.mode === undefined && d?.setup_completed) ? 'installed' : 'installing')
        }
      })
      .catch(() => {
        if (!cancelled) setSetupGate('installed')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 注册全局 401 处理回调（清登录态 + hash 跳登录页）
  useEffect(() => {
    setAuthClearHandler(clearAuth)
  }, [clearAuth])

  // 站点外观（logo / 背景 / 标题 / 版权）全站通用。以前只有 Landing 会拉，
  // 于是「直达 /login 或 /register」时这些值全是本地默认 —— 顶栏徽标设了也不显示。
  // 放在根组件挂载时拉一次，登录页/注册页就与首页看到同一套外观。
  useEffect(() => {
    useSiteStore.getState().loadSettings()
  }, [])

  // 应用初始化时刷新用户信息与头像
  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    const refreshUser = async () => {
      try {
        const data = await profileService.getMe()
        if (cancelled) return
        if (data.user) {
          updateUser(data.user)
        }
        if (data.skinUrl !== undefined) {
          setSkinUrl(data.skinUrl || null)
        }
      } catch (err: any) {
        if (cancelled) return
        const status = err?.response?.status ?? err?.status
        if (status === 401) {
          clearAuth()
        }
      }
    }
    refreshUser()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, updateUser, setSkinUrl, clearAuth])

  // 安装未完成：全屏只渲染向导（带布局的壳都不给 —— 装完之前没有可访问的东西）
  if (setupGate === 'checking') {
    return <PageLoading />
  }
  if (setupGate === 'installing') {
    return (
      <Suspense fallback={<PageLoading />}>
        <SetupWizard />
      </Suspense>
    )
  }

  return (
    // 外层 Suspense 覆盖不走 Layout 的懒加载路由（/login、/register）
    <Suspense fallback={<PageLoading />}>
      <Routes>
        {/* 认证路由 */}
        <Route path="/login" element={isAuthenticated ? <Navigate to="/" /> : <Login />} />
        <Route path="/register" element={isAuthenticated ? <Navigate to="/" /> : <Register />} />
        {/*
          以下三条**不随登录态重定向**（与 /login、/register 不同）：
          用户可能已登录却仍需验证邮箱或重置密码（例如登录被 EMAIL_NOT_VERIFIED 拦下后
          从邮件链接回来），把他弹回首页会让验证链接彻底失效。
        */}
        <Route path="/verify-email" element={<VerifyEmail />} />
        {/* 备用邮箱与改邮箱的邮件链接落点：同样不随登录态重定向（匿名可调，凭令牌） */}
        <Route path="/verify-backup-email" element={<VerifyBackupEmail />} />
        <Route path="/confirm-email-change" element={<ConfirmEmailChange />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* 带布局的路由 */}
        <Route element={<Layout />}>
          <Route path="/library" element={<SkinLibrary />} />
          <Route path="/skin/:id" element={<SkinDetail />} />
          <Route path="/cape/:id" element={<CapeDetail />} />
          <Route
            path="/upload"
            element={isAuthenticated ? <SkinUpload /> : <Navigate to="/login" />}
          />
          <Route
            path="/profile"
            element={isAuthenticated ? <UserProfile /> : <Navigate to="/login" />}
          />
          <Route
            path="/wardrobe"
            element={isAuthenticated ? <Wardrobe /> : <Navigate to="/login" />}
          />

          <Route
            path="/my-skins"
            element={isAuthenticated ? <MySkins /> : <Navigate to="/login" />}
          />
          <Route
            path="/my-capes"
            element={isAuthenticated ? <MyCapes /> : <Navigate to="/login" />}
          />
          {/* 管理员路由 */}
          {isAuthenticated && user && user.level >= 1 && (
            <Route path="/admin" element={<AdminDashboard />} />
          )}
        </Route>

        {/* 起始页（独立，不使用 Layout） */}
        <Route path="/" element={<Landing />} />

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Suspense>
  )
}

export default App
