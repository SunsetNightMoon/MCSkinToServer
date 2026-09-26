/**
 * 统一 API 客户端（蓝图 P4 验收：不再混用无认证 fetch 和 axios）。
 * - 自动附带 Bearer token
 * - 401 → 清除登录态并跳转登录页（库页匿名请求除外：optionalAuth 不返回 401）
 * - 非 2xx 抛 ApiError（携带 code/message，页面用 antd message 展示）
 */

import { useAuthStore } from '../store/auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  const token = useAuthStore.getState().token;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let body = rest.body;
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }

  const res = await fetch(path, { ...rest, headers, body });

  if (res.status === 401 && !path.startsWith('/api/library')) {
    useAuthStore.getState().clearAuth();
    window.location.hash = '#/login';
    throw new ApiError(401, 'TOKEN_INVALID', '登录已失效，请重新登录');
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let code = 'HTTP_ERROR';
    let message = `请求失败 (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string; errorMessage?: string; message?: string };
      code = err.error ?? code;
      message = err.errorMessage ?? err.message ?? message;
    } catch {
      // 非 JSON 响应体，保留默认信息
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

/** raw 文件上传（Content-Type: image/png，元数据走 query） */
export async function apiUpload<T>(
  path: string,
  file: File,
): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: await file.arrayBuffer(),
  });
}
