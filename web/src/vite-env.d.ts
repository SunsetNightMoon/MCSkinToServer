/// <reference types="vite/client" />

/**
 * Vite 环境变量声明。
 *
 * 原本 `UserProfile.tsx` 用 `(import.meta as any).env.VITE_API_URL` 绕过类型检查；
 * 有了本文件即可写惯用的 `import.meta.env.VITE_API_URL`，并获得补全与拼写检查。
 * `interface` 与 vite/client 的声明会合并，因此 DEV / PROD / MODE / BASE_URL 依然可用。
 */
interface ImportMetaEnv {
  /**
   * Yggdrasil 认证服务器（API 根）地址。
   *
   * 该值会直接展示给用户，并作为可拖拽的 authlib-injector 地址，因此必须填
   * 用户与启动器真正能访问到的后端地址：
   * - 本地开发：由 `.env.development` 设为 `http://localhost:3000`（后端端口）
   * - 生产：留空 → 回落到 `window.location.origin`（站点自身域名），
   *   前提是反向代理已转发 /authserver、/sessionserver 等前缀（见 docs/deployment.md）
   */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** 构建期注入的应用版本号（vite.config.ts define ← web/package.json version） */
declare const __APP_VERSION__: string
