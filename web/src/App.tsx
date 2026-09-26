import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuthStore } from './store/authStore'
import { Layout } from './components/Layout/Layout'
import { profileService } from './services/profileService'
import { setAuthClearHandler } from './utils/api'
import { Login } from './pages/Auth/Login'
import { Register } from './pages/Auth/Register'
import { Landing } from './pages/Landing/Landing'
import { SkinLibrary } from './pages/Library/SkinLibrary'
import { SkinDetail } from './pages/SkinDetail/SkinDetail'
import { CapeDetail } from './pages/CapeDetail/CapeDetail'
import { SkinUpload } from './pages/Upload/SkinUpload'
import { Wardrobe } from './pages/Wardrobe/Wardrobe'
import { UserProfile } from './pages/Profile/UserProfile'
import { AdminDashboard } from './pages/Admin/AdminDashboard'
import MySkins from './pages/MySkins/MySkins'
import MyCapes from './pages/MySkins/MyCapes'

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
  )
}

export default App
