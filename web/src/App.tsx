import { Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense, useEffect } from 'react'
import { useAuthStore } from './store/authStore'
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

/**
 * 路由表保持旧版一致，仅去掉 MSCTS 没有后端支持的部分：
 *  - /setup        安装向导（MSCTS 无 setup 端点）
 *  - /oauth-success OAuth 回调（MSCTS 无 OAuth）
 * 页面文件仍在（构建不受影响），只是不挂路由。
 */
function App() {
  const { isAuthenticated, user, updateUser, setSkinUrl, clearAuth } = useAuthStore()

  // 注册全局 401 处理回调（清登录态 + hash 跳登录页）
  useEffect(() => {
    setAuthClearHandler(clearAuth)
  }, [clearAuth])

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

  return (
    // 外层 Suspense 覆盖不走 Layout 的懒加载路由（/login、/register）
    <Suspense fallback={<PageLoading />}>
      <Routes>
        {/* 认证路由 */}
        <Route path="/login" element={isAuthenticated ? <Navigate to="/" /> : <Login />} />
        <Route path="/register" element={isAuthenticated ? <Navigate to="/" /> : <Register />} />

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
