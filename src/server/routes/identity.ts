import { Router } from 'express';
import type { IdentityService } from '../../auth/identity.js';
import type { TokenService } from '../../auth/tokens.js';
import { requireAuth } from '../middleware.js';

/**
 * Web 身份 HTTP 适配层：
 * - POST /api/auth/register  注册（成功即登录）
 * - POST /api/auth/login     登录
 * - POST /api/auth/logout    登出（吊销当前 token）
 * - GET  /api/me/profiles    角色列表
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

  // ---- 角色管理（以下均需认证）----

  const auth = requireAuth(deps.tokenService);

  router.get('/api/me/profiles', auth, async (req, res) => {
    const list = await deps.identity.listProfiles(req.context!.userId);
    res.json({ profiles: list });
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

  return router;
}
