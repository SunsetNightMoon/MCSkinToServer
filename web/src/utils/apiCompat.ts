/**
 * 旧版 → MCSTS 兼容数据层（compatFetch）
 * ================================================================
 * 旧版界面（页面/组件/CSS/文案）是验证过的资产，本文件是它与 MCSTS 后端之间
 * **唯一**的翻译层：调用方仍然写 `/api/skins`、`/api/library/skins/:id` 这类
 * 旧路径，由这里改写为 MCSTS 端点，并把响应转回旧版期望的形状（snake_case）。
 *
 * 约定：
 * - 只有以 `/api/` 开头的相对路径会被改写；`/steve.png`、`/uploads/...`、
 *   `blob:` 等静态资源直通。
 * - 2xx 时返回"翻译后"的 JSON Response；非 2xx 时保留原状态码，并把
 *   MCSTS 的 `message` 补成旧版页面读取的 `errorMessage`。
 * - 后端没有的能力（站点设置/黑名单/验证码/邮箱与密码管理…）返回
 *   中性默认值或 501 + `comingSoon` 文案，页面优雅降级而不是抛错。
 * - 第三方登录开关（`/api/auth/oauth/providers`）**透传**给后端：
 *   它是有真实端点的预留端口，宿主注册 provider 后开关会变 true。
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

/**
 * 这些端点的 401 是**业务结果**，不是「会话失效」：
 * 一次性令牌无效/过期/已被使用、凭据不正确。它们必须原样交给页面展示，
 * 绝不能让全局登出处理接管。
 *
 * 接管了会怎样（真出现过）：用户点一封过期邮件里的验证链接 →
 * `/api/auth/verify-email` 返回 401 TOKEN_EXPIRED → handleAuthFailure() 把 hash
 * 改写成 `#/login` → 页面上的「链接已过期，请重新获取」错误卡片根本没机会渲染，
 * 用户看到的是「点链接后莫名其妙回到了登录页」。已登录的用户还会被顺手清掉会话。
 *
 * 注意 `change-password` / `delete-account` / `logout` **不在**此列：
 * 它们返回 401 时确实是登录态已死，应当走全局登出。
 */
const BUSINESS_401_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/restore-account',
  '/api/auth/register',
  '/api/auth/verify-email',
  '/api/auth/reset-password',
  '/api/auth/send-verification',
  '/api/auth/send-reset-email',
  // 备用邮箱 / 改邮箱的邮件链接消费端点：匿名可调，401 = 令牌问题（业务结果），
  // 不能被全局登出接管，否则点过期链接会被弹去登录页、错误卡片渲染不出来。
  // finalize 不在列：它要求登录，401 确实是会话已死。
  '/api/me/backup-email/verify',
  '/api/me/email-change/confirm',
]);

function isBusiness401(url: string): boolean {
  return BUSINESS_401_PATHS.has(url.split('?')[0]!.split('#')[0]!);
}

async function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = getStoredToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401 && !isBusiness401(url)) handleAuthFailure()
  return res
}

/**
 * 兜底补齐 `previewUrl`。
 *
 * MCSTS 的列表端点现在**直出** `previewUrl`（服务层 `LibraryService.withPreviewUrls`
 * 统一补，见 `/api/library`、`/api/admin/assets`、`/api/admin/reviews`、
 * `/api/me/assets`），所以正常情况下这里**一次网络请求都不会发**。
 * 保留兜底只为兼容更早的后端版本。
 *
 * 它曾经是「列表必有的一步」：对**每一项**都调 `GET /api/assets/:id` 取文件地址。
 * 而那个端点会 `incrementViewCount` —— 于是「翻一页列表 = 每项浏览数 +1」，
 * 管理端素材列表与「我的素材」都把浏览数刷高过（实测 30 → 31）。
 * 这是本条兜底必须退居其次、不能反过来当主路径用的原因。
 */
async function ensurePreviewUrl<T extends { id: string; previewUrl?: string }>(
  items: T[],
  headers?: HeadersInit,
): Promise<any[]> {
  return Promise.all(
    items.slice(0, MAX_ENRICH).map(async (item) => {
      // 用「键是否存在」判断，而不是「值非空」：后端直出的 previewUrl 可能是 null
      // （blob 记录确实缺失），再拉一次详情仍然是 null，只会白白把浏览数刷高。
      if ('previewUrl' in item) return item
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

/** MCSTS Asset/LibraryItem → 旧版 Skin / Cape 形状 */
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

/** MCSTS UserRow → 旧版 UserRecord（管理后台用户列表） */
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

/** 旧版 permission_level → MCSTS visibility / downloadPolicy */
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

  // ── 站点设置：MCSTS 已实现 /api/settings/public（system_settings 表），
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
    // 上传表单的「权限设置」：旧版用 permission_level 单字段，MCSTS 拆成
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
    const enriched = await ensurePreviewUrl<any>(body.assets ?? [], headers)
    // 旧版 MySkins / Wardrobe 期望拿到数组
    return json(enriched.map((it) => toLegacyAsset(it)))
  }
  if (path === '/api/capes/mine') {
    const res = await rawFetch('/api/me/assets?kind=cape', { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    const enriched = await ensurePreviewUrl<any>(body.assets ?? [], headers)
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

  // ── 管理后台：统计（后端已有聚合端点，直接透传）──
  //
  // 这里原先有两处「降级替身」，都是典型的「后端接了、前端看不见」：
  //
  //  1. `/api/admin/stats` 在**前端拼三个接口**凑出三个数。后果是「皮肤总数」
  //     取的是公开素材库的计数（只含 public + approved），管理员看到的是
  //     「站上公开了几张皮」而不是「站里有多少张皮」；「待审核」用
  //     `items.length`，而 `/api/admin/reviews` 不分页也不带总数，数据一多就错。
  //  2. `/api/admin/stats/daily` **写死返回六个空数组**（注释原文写着
  //     「趋势接口无后端支持」）。四张折线图因此永远是空白 —— 不是渲染坏了，
  //     而是真的没给数据。
  //
  // `GET /api/admin/stats` 与 `GET /api/admin/stats/daily` 现在都在后端
  // 一次聚合完成，透传即可；聚合口径（排除已注销用户、皮肤含待审与被拒、
  // 按日缺失补 0、分桶时区）全部由后端决定，前端不再复刻一遍。
  if (path === '/api/admin/stats' || path === '/api/admin/stats/daily') {
    const res = await rawFetch(url, init)
    if (!res.ok) return passthroughError(res)
    return json(await res.json())
  }

  // ── 管理后台：待审核列表 → /api/admin/reviews?kind= ──
  if ((m = path.match(/^\/api\/admin\/(skins|capes)\/pending$/))) {
    const kind = m[1] === 'skins' ? 'skin' : 'cape'
    const res = await rawFetch(`/api/admin/reviews?kind=${kind}`, { headers })
    if (!res.ok) return passthroughError(res)
    const body = await res.json()
    const enriched = await ensurePreviewUrl<any>(body.items ?? [], headers)
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
    // 缩略图由 `/api/admin/assets` 直出 previewUrl；这里只兜底（不再逐项拉详情刷高浏览数）
    const enriched = await ensurePreviewUrl<any>(body.items ?? [], headers)
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
      // 旧版表单用 license_type，MCSTS 列名是 license
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

  // ── 管理后台：主题背景图上传 / 移除 → MCSTS /api/admin/upload-theme-image、/theme-image/:type ──
  //
  // 后端（`src/site/themeImage.ts` + admin 路由）收的是 **raw 位图字节**
  // （`express.raw({ type: ['image/png','image/jpeg','image/webp','image/gif'] })`），
  // 而旧版 SystemSettings 发的是 `FormData`（字段名 `image`）。
  // multipart 的 body 会被 raw 解析器整体当成"不是这几种 Content-Type"而拒收，
  // 所以必须在这里拆包、按文件自身的 MIME 重发 —— 这是这条分支存在的唯一理由。
  // 拆包放在兼容层而不是改 4 组上传组件：JSX 是验证过的资产，改动面越小越好。
  if (path === '/api/admin/upload-theme-image' && method === 'POST') {
    const type = query.get('type') ?? ''
    const body = init.body
    const file =
      body instanceof FormData ? (body.get('image') as Blob | string | null) : null
    if (!file || typeof file === 'string') {
      const msg = '未收到图片文件（表单字段名应为 image）'
      return jsonResponse({ error: 'VALIDATION_ERROR', message: msg, errorMessage: msg }, 400)
    }
    const target = new URLSearchParams({ type })
    const uploadHeaders = new Headers(headers)
    uploadHeaders.set('Content-Type', file.type || 'application/octet-stream')
    const res = await rawFetch(`/api/admin/upload-theme-image?${target}`, {
      method: 'POST',
      headers: uploadHeaders,
      body: await file.arrayBuffer(),
    })
    // 原样交回状态码（后端成功是 201）：合成 200 会把「创建成功」降级成「一般成功」，
    // 和本项目其他透传分支保持同一纪律 —— 不吞状态码。
    if (!res.ok) return passthroughError(res)
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
  }
  // 移除：后端会同时清空对应设置键（`LIGHT_BG_IMAGE` 等）并删文件，
  // 所以这里纯粹是转发，不做任何本地臆测。
  if ((m = path.match(/^\/api\/admin\/theme-image\/([^/]+)$/)) && method === 'DELETE') {
    const res = await rawFetch(url, { method: 'DELETE', headers })
    if (!res.ok) return passthroughError(res)
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
  }

  // ── 管理后台：黑名单 ──
  // 旧版 `BlacklistManagement` 依赖 `/api/admin/blacklist`，MCSTS **没有**这张表也没有
  // 对应端点；这里曾经返回假数据（空数组 / 全 0 统计），于是页面上永远显示
  // 「暂无封禁记录」—— 一个看起来正常、实际上从不反映真实状态、也不会报错的死页面。
  // 假数据已删除，页签也已从管理后台侧栏摘掉（`AdminDashboard.tsx`）。
  // 若哪天真要做封禁名单，请先补后端再挂页面，别再走「前端假装有」这条路。

  // ── 已有 MCSTS 后端端点的 /api/admin/* 直接透传，其余仍未支持 ──
  // 注意：这条兜底是按前缀拦截的，新增任何 /api/admin 端点都必须同时加进白名单，
  // 否则新端点在开发环境永远返回「敬请期待」而看不出原因（后端其实是对的）。
  const ADMIN_PASSTHROUGH = [
    '/api/admin/settings',
    '/api/admin/test-smtp',
    '/api/admin/email-template',
    // 全站用户名模式（P5 第十一批）：GET 读模式+统计 / PUT 全局切换，
    // 后端原样 JSON，无需翻译 —— 与 settings 同等对待
    '/api/admin/profile-mode',
    // 代用户重发验证邮件（POST）与手动放行/收回邮箱验证（PUT）：
    // 后端 `admin.ts` 里早就实现了，但前缀兜底把它们拦成 501，
    // 于是 UserManagement 上那两个按钮点了只会弹「敬请期待」。
    // 带尾斜杠是有意的：`/api/admin/users`（列表）由上面的分支处理，
    // 前缀写成不带斜杠会把列表也一起放过去，绕过它原本的翻译逻辑。
    '/api/admin/users/',
  ]
  if (
    path.startsWith('/api/admin/') &&
    !ADMIN_PASSTHROUGH.some((prefix) => path.startsWith(prefix))
  ) {
    return notSupported()
  }

  // ── 人机验证（0004 自托管数学题） ──
  //
  // 后端已实现 `GET /api/captcha/captcha-type`（`{ type: 'math' | 'none' }`）
  // 与 `GET /api/captcha/generate?sessionId=…`（`{ question }`）。
  //
  // 为什么必须**透传**而不是在这里写死 `{ type: 'none' }`：管理员在后台打开
  // 「启用验证码」后后端会返回 `'math'`，写死 `'none'` 会让整块验证码 UI
  // **永远**不渲染 —— 后端点了灯、前端看不见。这里曾经就是写死的。
  //
  // 透传失败（旧后端没有此端点 / 网络异常 / 非 2xx）时回落 `'none'`，
  // 与「未开启验证码」的表现一致，不会把登录注册页卡住。
  if (path === '/api/captcha/captcha-type' || path.startsWith('/api/captcha/')) {
    try {
      // **完全透传，连状态码一起交回调用方。**
      //
      // 以前这里把非 2xx 包成合成的 200（`json(fallback)`），结果是调用方看到的
      // `response.ok` 永远是 true：出题端点因限流返 429、因服务未注入返 503 时，
      // 页面只会拿到一个空的 `question`，于是渲染出一个空白题干 —— 用户填不出、
      // 也看不到任何原因，注册登录整条路被静默堵死。
      // 后端这两个端点已经带明确文案，必须原样交回，让页面能说明白到底怎么了。
      return await rawFetch(url, init)
    } catch {
      // 真·网络异常（后端没起来 / 代理挂了）时请求根本没到后端，没有状态码可透传。
      // 这种情况按「未启用验证码」表现，避免把登录注册页整个卡住。
      return jsonResponse(
        path === '/api/captcha/captcha-type' ? { type: 'none' } : { question: '' },
        503,
      )
    }
  }

  // ── 第三方登录开关（预留端口） ──
  // 后端有 `GET /api/auth/oauth/providers`，返回 `{ github, microsoft, ...布尔 }`。
  // 默认部署没有注册任何 provider → 全 false → 登录/注册页的第三方登录小格子
  // 整体不渲染，与「本项目不内置第三方登录」的现状一致。
  //
  // 为什么必须**透传**而不是在这里写死 `{ github:false, microsoft:false }`：
  // 宿主可以按 `docs/oauth-provider-guide.md` 注册自己的 provider，
  // 那时后端会返回 true。写死 false 会让小格子**永远**不出现 ——
  // 后端点了灯、前端看不见，接入指南就成了空话。这里曾经就是写死的。
  //
  // 透传失败（旧后端没有此端点 / 网络异常 / 非 2xx）时回落全 false，
  // 行为与从前完全一致，不会把登录页搞挂。
  if (path === '/api/auth/oauth/providers') {
    try {
      const res = await rawFetch(url, init)
      if (!res.ok) return json({ github: false, microsoft: false })
      const data = (await res.json()) as Record<string, unknown>
      // 展开在前、归一化在后：保留 `bilibili` 之类的额外键，
      // 同时保证 github/microsoft 一定是严格布尔（前端做 `||` 判断）
      return json({
        ...data,
        github: data?.github === true,
        microsoft: data?.microsoft === true,
      })
    } catch {
      return json({ github: false, microsoft: false })
    }
  }

  // ── 账号安全 ──
  // 改密码 / 注销账号 / 恢复账号 / 邮箱验证 / 密码重置 均已有 MCSTS 端点，
  // 全部走下方 fallback 原样透传（原此处对后两者返回 notSupported 的降级已移除）。

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
