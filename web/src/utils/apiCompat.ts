/**
 * 旧版 → MSCTS 兼容数据层（compatFetch）
 * ================================================================
 * 旧版界面（页面/组件/CSS/文案）是验证过的资产，本文件是它与 MSCTS 后端之间
 * **唯一**的翻译层：调用方仍然写 `/api/skins`、`/api/library/skins/:id` 这类
 * 旧路径，由这里改写为 MSCTS 端点，并把响应转回旧版期望的形状（snake_case）。
 *
 * 约定：
 * - 只有以 `/api/` 开头的相对路径会被改写；`/steve.png`、`/uploads/...`、
 *   `blob:` 等静态资源直通。
 * - 2xx 时返回"翻译后"的 JSON Response；非 2xx 时保留原状态码，并把
 *   MSCTS 的 `message` 补成旧版页面读取的 `errorMessage`。
 * - 后端没有的能力（站点设置/黑名单/验证码/OAuth/邮箱与密码管理…）返回
 *   中性默认值或 501 + `comingSoon` 文案，页面优雅降级而不是抛错。
 */

import i18n from '../i18n'
import { getStoredToken, handleAuthFailure } from './session'
import type { AssetItem } from '../api/types'

const MAX_ENRICH = 60

// ──────────────────────────── 小工具 ────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 后端暂无能力：返回 501 + 本地化“敬请期待”文案 */
function notSupported(): Response {
  const message = i18n.t('common.comingSoon')
  return jsonResponse({ error: 'NOT_IMPLEMENTED', message, errorMessage: message }, 501)
}

/** 原样透传错误（补上旧版读取的 errorMessage 字段） */
async function passthroughError(res: Response): Promise<Response> {
  const body = await res.json().catch(() => ({}))
  const message = body?.message || body?.errorMessage || `请求失败 (${res.status})`
  return jsonResponse(
    { ...body, message, errorMessage: message },
    res.status,
  )
}

async function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = getStoredToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401) handleAuthFailure()
  return res
}

/** 拉一次详情以获得 previewUrl（MSCTS 的列表接口不返回文件地址） */
async function withPreviewUrl<T extends { id: string }>(
  items: T[],
  headers?: HeadersInit,
): Promise<any[]> {
  return Promise.all(
    items.slice(0, MAX_ENRICH).map(async (item) => {
      try {
        const res = await rawFetch(`/api/assets/${item.id}`, { headers })
        if (!res.ok) return item
        const body = await res.json()
        return body?.asset ? { ...item, ...body.asset } : item
      } catch {
        return item
      }
    }),
  )
}

// ──────────────────── 旧版对象形状（snake_case） ────────────────────

function permissionLevelOf(a: any): string {
  if (a?.visibility === 'public') {
    return a?.downloadPolicy === 'public' ? 'public_downloadable' : 'public_no_download'
  }
  return 'private'
}

/** MSCTS Asset/LibraryItem → 旧版 Skin / Cape 形状 */
export function toLegacyAsset(
  a: (AssetItem & Record<string, any>) | null | undefined,
  extra: Record<string, any> = {},
): Record<string, any> {
  return {
    id: a?.id,
    user_id: a?.ownerUserId ?? '',
    user_uid: a?.ownerUid ?? 0,
    uploader_name: undefined,
    file_path: a?.previewUrl ?? '',
    name: a?.name ?? '',
    description: a?.description ?? '',
    model_type: a?.modelType ?? 'default',
    license_type: a?.license ?? 'CC0',
    permission_level: permissionLevelOf(a),
    is_public: a?.visibility === 'public',
    is_downloadable: a?.downloadPolicy === 'public',
    approval_status: a?.reviewStatus ?? 'approved',
    download_count: a?.downloadCount ?? 0,
    view_count: a?.viewCount ?? 0,
    created_at: a?.createdAt ?? '',
    is_ai_generated: a?.aiGenerated ? 1 : 0,
    admin_warning: a?.adminWarning ?? null,
    warning_set_by_level: null,
    favorite_count: a?.favoriteCount ?? 0,
    ...extra,
  }
}

const ROLE_LEVEL: Record<string, number> = { user: 0, admin: 1, super_admin: 2 }

/** MSCTS UserRow → 旧版 UserRecord（管理后台用户列表） */
function toLegacyUserRow(u: any): Record<string, any> {
  return {
    id: u?.id,
    user_uid: u?.userUid ?? 0,
    email: u?.email ?? '',
    role: u?.role ?? 'user',
    level: ROLE_LEVEL[u?.role] ?? 0,
    is_active: u?.isActive ? 1 : 0,
    email_verified: u?.emailVerified ? 1 : 0,
    banned_until: u?.banPermanent ? 'permanent' : (u?.bannedUntil ?? null),
    ban_reason: u?.banReason ?? null,
    created_at: u?.createdAt ?? '',
    last_login_at: u?.lastLoginAt ?? null,
  }
}

/** 旧版 permission_level → MSCTS visibility / downloadPolicy */
function toPolicy(level: string | undefined): { visibility: string; downloadPolicy: string } {
  if (level === 'public_downloadable') return { visibility: 'public', downloadPolicy: 'public' }
  if (level === 'public_no_download') return { visibility: 'public', downloadPolicy: 'owner_only' }
  return { visibility: 'private', downloadPolicy: 'owner_only' }
}

function levelToRole(level: unknown): 'user' | 'admin' | 'super_admin' {
  const n = Number(level)
  if (n >= 2) return 'super_admin'
  if (n >= 1) return 'admin'
  return 'user'
}

/** 供管理员"启用/停用"取反用：缓存最近一次用户列表 */
let adminUsersCache: Record<string, boolean> = {}

// ──────────────────────────── 主入口 ────────────────────────────

export async function compatFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const method = (
    init.method ||
    (typeof input === 'string' || input instanceof URL ? 'GET' : input.method) ||
    'GET'
  ).toUpperCase()

  // 非 /api/ 路径（静态资源、blob、外链）直通
  if (!url.startsWith('/api/')) {
    return fetch(input as RequestInfo, init)
  }

  const [rawPath, rawQuery = ''] = url.split('?')
  const path = rawPath.replace(/\/+$/, '') || rawPath
  const query = new URLSearchParams(rawQuery)
  const headers = init.headers

  const json = (data: unknown) => jsonResponse(data)

  // ── 站点设置：MSCTS 已实现 /api/settings/public（system_settings 表），
  //    形状与旧站一致，走下方 fallback 原样透传，不再本地伪造默认值 ──

  let m: RegExpMatchArray | null

  // ── 公开库列表：/api/library/skins|capes → /api/library?kind= ──
  if ((m = path.match(/^\/api\/library\/(skins|capes)$/))) {
    const kind = m[1] === 'skins' ? 'skin' : 'cape'
    const page = query.get('page') || '1'
    const pageSize = query.get('limit') || query.get('pageSize') || '12'
    const sort = query.get('sort')
    const search = query.get('search')
    const target = new URLSearchParams({ kind, page, pageSize })
    if (sort) target.set('sort', sort)
    if (search) target.set('search', search)
    const res = await rawFetch(`/api/library?${target}`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    const items = (body.items ?? []).map((it: any) => toLegacyAsset(it))
    return json({
      [kind === 'skin' ? 'skins' : 'capes']: items,
      items,
      total: body.total ?? 0,
      page: body.page ?? Number(page),
      pageSize: body.pageSize ?? Number(pageSize),
    })
  }

  // ── 素材详情：/api/library/skins|capes/:id → /api/assets/:id ──
  if ((m = path.match(/^\/api\/library\/(skins|capes)\/([^/]+)$/))) {
    const id = m[2]
    const res = await rawFetch(`/api/assets/${id}`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    return json(
      toLegacyAsset(body.asset, {
        is_favorited: !!body.isFavorited,
        can_download: !!body.canDownload,
      }),
    )
  }

  // ── 收藏列表：/api/skins|/capes/favorites → /api/me/favorites ──
  if ((m = path.match(/^\/api\/(skins|capes)\/favorites$/))) {
    const kind = m[1] === 'skins' ? 'skin' : 'cape'
    const res = await rawFetch(`/api/me/favorites?kind=${kind}`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    const items = (body.favorites ?? []).map((it: any) => toLegacyAsset(it))
    return json({ [kind === 'skin' ? 'skins' : 'capes']: items, items })
  }

  // ── 收藏状态/计数 ──
  if ((m = path.match(/^\/api\/(skins|capes)\/([^/]+)\/favorite-count$/))) {
    const res = await rawFetch(`/api/assets/${m[2]}/favorite-count`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    return json({ favoriteCount: body.count ?? 0, count: body.count ?? 0 })
  }
  if ((m = path.match(/^\/api\/(skins|capes)\/([^/]+)\/is-favorited$/))) {
    const res = await rawFetch(`/api/assets/${m[2]}/is-favorited`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    return json({ isFavorited: !!body.favorited, favorited: !!body.favorited })
  }
  if ((m = path.match(/^\/api\/(skins|capes)\/([^/]+)\/favorite$/))) {
    const target = `/api/assets/${m[2]}/favorite`
    const res = await rawFetch(target, { method, headers })
    if (!res.ok) return passthroughError(res)
    return new Response(null, { status: res.status })
  }

  // ── 上传：FormData(raw PNG + 元数据) → POST /api/assets?kind=&... ──
  if (path === '/api/skins/upload' || path === '/api/skins/upload-cape') {
    const isCape = path.endsWith('upload-cape')
    const fd = init.body as FormData
    if (!(fd instanceof FormData)) {
      return jsonResponse({ error: 'VALIDATION_ERROR', errorMessage: '缺少上传内容' }, 400)
    }
    const file = (isCape ? fd.get('cape') : fd.get('skin')) as File | null
    if (!file) {
      return jsonResponse({ error: 'VALIDATION_ERROR', errorMessage: '缺少文件' }, 400)
    }
    const target = new URLSearchParams({
      kind: isCape ? 'cape' : 'skin',
      name: String(fd.get('name') ?? ''),
    })
    const description = String(fd.get('description') ?? '')
    if (description) target.set('description', description)
    const license = String(fd.get('license_type') ?? '')
    if (license) target.set('license', license)
    // 上传表单的「权限设置」：旧版用 permission_level 单字段，MSCTS 拆成
    // visibility + downloadPolicy 两个字段，这里做翻译
    const permission = fd.get('permission_level')
    if (permission) {
      const { visibility, downloadPolicy } = toPolicy(String(permission))
      target.set('visibility', visibility)
      target.set('downloadPolicy', downloadPolicy)
    }
    if (!isCape) {
      target.set('model', String(fd.get('model_type') ?? 'default') || 'default')
    }
    const res = await rawFetch(`/api/assets?${target}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: await file.arrayBuffer(),
    })
    if (!res.ok) return passthroughError(res)
    const body = await res.json().catch(() => ({}))
    return json({ ...body, url: body?.url ?? '' })
  }

  // ── 我的素材：/api/skins → /api/me/assets?kind=skin ──
  if (path === '/api/skins' && method === 'GET') {
    const res = await rawFetch('/api/me/assets?kind=skin', { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    const enriched = await withPreviewUrl<any>(body.assets ?? [], headers)
    // 旧版 MySkins / Wardrobe 期望拿到数组
    return json(enriched.map((it) => toLegacyAsset(it)))
  }
  if (path === '/api/capes/mine') {
    const res = await rawFetch('/api/me/assets?kind=cape', { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    const enriched = await withPreviewUrl<any>(body.assets ?? [], headers)
    const items = enriched.map((it) => toLegacyAsset(it))
    return json({ capes: items, items })
  }

  // ── 我的素材编辑/删除：/api/skins/:id|/api/capes/:id → /api/assets/:id ──
  if ((m = path.match(/^\/api\/(skins|capes)\/([^/]+)$/))) {
    const target = `/api/assets/${m[2]}`
    if (method === 'PUT' || method === 'PATCH') {
      const body = init.body ? JSON.parse(String(init.body)) : {}
      const { visibility, downloadPolicy } = toPolicy(body.permission_level)
      const payload: Record<string, unknown> = {}
      if (body.name !== undefined) payload.name = body.name
      if (body.description !== undefined) payload.description = body.description
      if (body.permission_level !== undefined) {
        payload.visibility = visibility
        payload.downloadPolicy = downloadPolicy
      }
      const res = await rawFetch(target, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) return passthroughError(res)
      return new Response(null, { status: res.status })
    }
    if (method === 'DELETE') {
      const res = await rawFetch(target, { method: 'DELETE', headers })
      if (!res.ok) return passthroughError(res)
      return new Response(null, { status: res.status })
    }
  }

  // ── 管理后台：统计 ──
  if (path === '/api/admin/stats') {
    try {
      const [usersRes, skinsRes, pendingSkins, pendingCapes] = await Promise.all([
        rawFetch('/api/admin/users?page=1&pageSize=1', { headers }),
        rawFetch('/api/library?kind=skin&page=1&pageSize=1', { headers }),
        rawFetch('/api/admin/reviews?kind=skin', { headers }),
        rawFetch('/api/admin/reviews?kind=cape', { headers }),
      ])
      const users = usersRes.ok ? await usersRes.json() : { total: 0 }
      const skins = skinsRes.ok ? await skinsRes.json() : { total: 0 }
      const ps = pendingSkins.ok ? await pendingSkins.json() : { items: [] }
      const pc = pendingCapes.ok ? await pendingCapes.json() : { items: [] }
      return json({
        userCount: users?.total ?? 0,
        skinCount: skins?.total ?? 0,
        pendingCount: (ps?.items?.length ?? 0) + (pc?.items?.length ?? 0),
      })
    } catch {
      return json({ userCount: 0, skinCount: 0, pendingCount: 0 })
    }
  }
  // 趋势接口无后端支持：返回空序列（图表渲染为空）
  if (path === '/api/admin/stats/daily') {
    return json({
      days: [],
      skinUploads: [],
      capeUploads: [],
      userRegistrations: [],
      pendingSubmissions: [],
      banCounts: [],
    })
  }

  // ── 管理后台：待审核列表 → /api/admin/reviews?kind= ──
  if ((m = path.match(/^\/api\/admin\/(skins|capes)\/pending$/))) {
    const kind = m[1] === 'skins' ? 'skin' : 'cape'
    const res = await rawFetch(`/api/admin/reviews?kind=${kind}`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    const enriched = await withPreviewUrl<any>(body.items ?? [], headers)
    return json(enriched.map((it) => toLegacyAsset(it)))
  }

  // ── 管理后台：审批（approve / reject）→ /api/admin/assets/:id/review ──
  if ((m = path.match(/^\/api\/admin\/(skins|capes)\/([^/]+)\/(approve|reject)$/))) {
    const status = m[3] === 'approve' ? 'approved' : 'rejected'
    const res = await rawFetch(`/api/admin/assets/${m[2]}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason: null }),
    })
    if (!res.ok) return passthroughError(res)
    return new Response(null, { status: res.status })
  }

  // ── 管理后台：警告 / AI 标记 → PATCH /api/admin/assets/:id ──
  if ((m = path.match(/^\/api\/admin\/(skins|capes)\/([^/]+)\/warning$/))) {
    const payload =
      method === 'DELETE'
        ? { adminWarning: null }
        : { adminWarning: String(JSON.parse(String(init.body))?.warning ?? '') }
    const res = await rawFetch(`/api/admin/assets/${m[2]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) return passthroughError(res)
    return new Response(null, { status: res.status })
  }
  if ((m = path.match(/^\/api\/admin\/(skins|capes)\/([^/]+)\/ai-generated$/))) {
    const body = init.body ? JSON.parse(String(init.body)) : {}
    const res = await rawFetch(`/api/admin/assets/${m[2]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiGenerated: !!body.is_ai_generated }),
    })
    if (!res.ok) return passthroughError(res)
    return new Response(null, { status: res.status })
  }

  // ── 管理后台：全量素材列表（含 private / pending / rejected） ──
  if ((m = path.match(/^\/api\/admin\/(skins|capes)$/))) {
    const kind = m[1] === 'skins' ? 'skin' : 'cape'
    const page = query.get('page') || '1'
    const pageSize = query.get('limit') || query.get('pageSize') || '20'
    const target = new URLSearchParams({ kind, page, pageSize })
    const search = query.get('search')
    if (search) target.set('search', search)
    const status = query.get('status') || query.get('approval_status')
    if (status) target.set('status', status)
    const res = await rawFetch(`/api/admin/assets?${target}`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    // 管理端列表同样需要缩略图：补一次详情拿 previewUrl
    const enriched = await withPreviewUrl<any>(body.items ?? [], headers)
    const mapped = enriched.map((it) => toLegacyAsset(it))
    return json({
      skins: mapped,
      capes: mapped,
      items: mapped,
      total: body.total ?? 0,
      page: body.page ?? Number(page),
      pageSize: body.pageSize ?? Number(pageSize),
    })
  }

  // ── 管理后台：素材编辑 / 删除（管理员可改他人素材） ──
  if ((m = path.match(/^\/api\/admin\/(skins|capes)\/([^/]+)$/))) {
    if (method === 'DELETE') {
      const res = await rawFetch(`/api/assets/${m[2]}`, { method: 'DELETE', headers })
      if (!res.ok) return passthroughError(res)
      return new Response(null, { status: res.status })
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = init.body ? JSON.parse(String(init.body)) : {}
      const payload: Record<string, unknown> = {}
      if (body.name !== undefined) payload.name = body.name
      if (body.description !== undefined) payload.description = body.description
      // 旧版表单用 license_type，MSCTS 列名是 license
      if (body.license_type !== undefined) payload.license = body.license_type
      if (body.permission_level !== undefined) {
        const { visibility, downloadPolicy } = toPolicy(String(body.permission_level))
        payload.visibility = visibility
        payload.downloadPolicy = downloadPolicy
      }
      if (body.is_ai_generated !== undefined) payload.aiGenerated = !!body.is_ai_generated
      if (body.admin_warning !== undefined) payload.adminWarning = body.admin_warning
      const res = await rawFetch(`/api/admin/assets/${m[2]}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) return passthroughError(res)
      return new Response(null, { status: res.status })
    }
    return notSupported()
  }

  // ── 管理后台：用户列表 → /api/admin/users ──
  if (path === '/api/admin/users' && method === 'GET') {
    const page = query.get('page') || '1'
    const pageSize = query.get('pageSize') || query.get('limit') || '100'
    const search = query.get('search')
    const target = new URLSearchParams({ page, pageSize })
    if (search) target.set('search', search)
    const res = await rawFetch(`/api/admin/users?${target}`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    const items = (body.items ?? []).map((u: any) => toLegacyUserRow(u))
    adminUsersCache = {}
    for (const it of body.items ?? []) adminUsersCache[it.id] = !!it.isActive
    // 旧版 UserManagement 期望直接拿到数组
    return json(items)
  }

  // ── 管理后台：用户启停 / 角色 / 封禁 ──
  if ((m = path.match(/^\/api\/admin\/users\/([^/]+)\/toggle-active$/))) {
    const id = m[1]
    const next = !(adminUsersCache[id] ?? false)
    const res = await rawFetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: next }),
    })
    if (!res.ok) return passthroughError(res)
    adminUsersCache[id] = next
    return new Response(null, { status: res.status })
  }
  if ((m = path.match(/^\/api\/admin\/users\/([^/]+)\/role$/))) {
    const body = init.body ? JSON.parse(String(init.body)) : {}
    const res = await rawFetch(`/api/admin/users/${m[1]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: levelToRole(body.level ?? body.role) }),
    })
    if (!res.ok) return passthroughError(res)
    const data = await res.json().catch(() => ({}))
    return json(data)
  }
  if ((m = path.match(/^\/api\/admin\/users\/([^/]+)\/ban$/))) {
    const body = init.body ? JSON.parse(String(init.body)) : {}
    const bannedUntil = body.bannedUntil
    const ban =
      bannedUntil === 'permanent'
        ? { permanent: true, until: null, reason: null }
        : bannedUntil
          ? { permanent: false, until: bannedUntil, reason: null }
          : null
    const res = await rawFetch(`/api/admin/users/${m[1]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ban }),
    })
    if (!res.ok) return passthroughError(res)
    return json(await res.json().catch(() => ({})))
  }
  if (path.match(/^\/api\/admin\/users\/[^/]+\/(send-verification|verify-email)$/)) {
    return notSupported()
  }

  // ── 管理后台：黑名单（无后端支持） ──
  if (path === '/api/admin/blacklist' && method === 'GET') {
    return json([])
  }
  if (path.startsWith('/api/admin/blacklist')) {
    if (method === 'GET') return json({ permanent: 0, temporary: 0, expired: 0, cleaned: 0 })
    return notSupported()
  }

  // ── 站点设置已有 MSCTS 端点（GET/PUT /api/admin/settings），不在此拦截 ──
  if (path.startsWith('/api/admin/') && !path.startsWith('/api/admin/settings')) {
    return notSupported()
  }

  // ── 验证码 / OAuth：MSCTS 未启用，返回"关闭"信号 ──
  if (path === '/api/captcha/captcha-type') {
    return json({ type: 'none' })
  }
  if (path.startsWith('/api/captcha/')) {
    return json({ question: '' })
  }
  if (path === '/api/auth/oauth/providers') {
    return json({ github: false, microsoft: false })
  }

  // ── 账号安全 ──
  // 改密码 / 注销账号 / 恢复账号 已有 MSCTS 端点，走下方 fallback 原样透传；
  // 依赖 SMTP 的邮箱验证与密码重置仍无后端，返回「敬请期待」。
  if (
    path.match(
      /^\/api\/auth\/(send-verification|send-reset-email|reset-password|verify-email)$/,
    )
  ) {
    return notSupported()
  }

  // ── 安装向导（未挂路由，兜底） ──
  if (path.startsWith('/api/setup/')) {
    return notSupported()
  }

  // ── 其余未覆盖的 /api 路径：原样透传 ──
  const fallback = await rawFetch(url, init)
  if (!fallback.ok && fallback.status !== 204) return passthroughError(fallback)
  return fallback
}

export default compatFetch
