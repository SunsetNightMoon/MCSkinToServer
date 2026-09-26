import { Router } from 'express';
import type { IdentityService } from '../../auth/identity.js';
import type { TokenService } from '../../auth/tokens.js';
import { requireAuth } from '../middleware.js';

/**
 * Web 身份 HTTP 适配层：
 * - POST /api/auth/register  注册（成功即登录）
 * - POST /api/auth/login     登录
 * - POST /api/auth/logout    登出（吊销当前 token）
 * - POST /api/auth/change-password  修改密码（需旧密码，成功后全部会话失效）
 * - POST /api/auth/delete-account   注销账号（需密码，15 天可恢复宽限期）
 * - POST /api/auth/restore-account  恢复已注销账号（宽限期内，免认证）
 * - GET  /api/me/profiles    角色列表（含每个角色的当前皮肤/披风 ID 与 URL）
 * - GET  /api/me/skin        当前默认角色的皮肤（顶栏头像）
 * - POST /api/profiles       新建角色
 * - POST /api/profiles/:id/name  改名（30 天冷却）
 * - DELETE /api/profiles/:id 删除角色
 */

export interface IdentityRouteDependencies {
  identity: IdentityService;
  tokenService: TokenService;
}

const Bearer = 'bearer' as const;

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== Bearer || !token) return null;
  return token;
}

export function createIdentityRouter(deps: IdentityRouteDependencies): Router {
  const router = Router();

  router.post('/api/auth/register', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.identity.register({
      email: String(body['email'] ?? ''),
      password: String(body['password'] ?? ''),
      profileName: String(body['profileName'] ?? ''),
    });
    res.status(201).json({
      user: result.user,
      profile: result.profile,
      token: result.token.token,
      expiresAt: result.token.expiresAt,
    });
  });

  router.post('/api/auth/login', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.identity.loginWeb({
      email: String(body['email'] ?? ''),
      password: String(body['password'] ?? ''),
    });
    res.json({
      user: result.user,
      profile: result.profile,
      token: result.token.token,
      expiresAt: result.token.expiresAt,
    });
  });

  router.post('/api/auth/logout', async (req, res) => {
    const token = bearerToken(req.headers.authorization);
    if (token) {
      await deps.tokenService.revoke(token);
    }
    res.status(204).end();
  });

  /**
   * 恢复已注销账号（15 天宽限期内）。此时用户已无有效令牌，所以不挂认证；
   * 用邮箱+密码验证身份，成功后直接下发新会话。
   */
  router.post('/api/auth/restore-account', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.identity.restoreAccount({
      email: String(body['email'] ?? ''),
      password: String(body['password'] ?? ''),
    });
    res.json({
      user: result.user,
      profile: result.profile,
      token: result.token.token,
      expiresAt: result.token.expiresAt,
    });
  });

  // ---- 角色管理（以下均需认证）----

  const auth = requireAuth(deps.tokenService);

  router.get('/api/me/profiles', auth, async (req, res) => {
    const list = await deps.identity.listProfilesWithTextures(req.context!.userId);
    res.json({ profiles: list });
  });

  /** 当前用户默认角色的皮肤（顶栏头像） */
  router.get('/api/me/skin', auth, async (req, res) => {
    const skin = await deps.identity.getMySkin(req.context!.userId);
    res.json(skin);
  });

  router.post('/api/profiles', auth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profile = await deps.identity.createProfile(
      req.context!.userId,
      String(body['name'] ?? ''),
    );
    res.status(201).json({ profile });
  });

  router.post('/api/profiles/:id/name', auth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profile = await deps.identity.renameProfile(
      req.context!.userId,
      String(req.params['id'] ?? ''),
      String(body['name'] ?? ''),
    );
    res.json({ profile });
  });

  router.delete('/api/profiles/:id', auth, async (req, res) => {
    await deps.identity.deleteProfile(
      req.context!.userId,
      String(req.params['id'] ?? ''),
    );
    res.status(204).end();
  });

  // ---- 账号生命周期（改密 / 注销）----

  /** 修改密码：需旧密码；成功后该用户全部会话（含 Yggdrasil）失效 */
  router.post('/api/auth/change-password', auth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.identity.changePassword({
      userId: req.context!.userId,
      oldPassword: String(body['oldPassword'] ?? ''),
      newPassword: String(body['newPassword'] ?? ''),
    });
    res.json({ ok: true });
  });

  /** 注销账号：需密码确认，进入 15 天可恢复宽限期 */
  router.post('/api/auth/delete-account', auth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.identity.deleteAccount({
      userId: req.context!.userId,
      password: String(body['password'] ?? ''),
    });
    res.json(result);
  });

  return router;
}
