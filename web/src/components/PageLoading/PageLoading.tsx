/**
 * 路由懒加载占位。刻意不依赖 antd：本组件处在懒加载边界上，
 * 引入 Spin 等组件会把 antd 拉进首屏依赖图（实际上 antd 已被 Layout 引入，
 * 但保持零依赖可避免这个组件被未来重构牵连）。
 */
import './PageLoading.css'

export function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <div className="page-loading__spinner" />
      <span className="page-loading__text">Loading…</span>
    </div>
  )
}
