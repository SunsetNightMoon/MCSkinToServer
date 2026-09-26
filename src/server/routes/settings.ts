import { Router } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import type { SettingRepository } from '../../repositories/settingRepository.js';
import { requireAdmin, requireAuth } from '../middleware.js';
import { AppError } from '../../errors.js';

/**
 * 站点设置 HTTP 适配层（对应 system_settings 表，无需新迁移）。
 *
 * - GET /api/settings/public   站点外观与文案（匿名可读；前端 siteStore 拉取）
 * - GET /api/admin/settings    全部设置（管理员）
 * - PUT /api/admin/settings    保存，body 为扁平键值对象 {KEY: value}
 *
 * 键名沿用旧版 SCREAMING_SNAKE_CASE，使 /api/settings/public 的响应形状
 * 与旧站一致，前端不需要改协议。
 */

export interface SettingRouteDependencies {
  tokenService: TokenService;
  settings: SettingRepository;
  /** 时钟可注入（测试） */
  now?: () => Date;
}

const MAX_KEY_LENGTH = 64;

export function createSettingRouter(deps: SettingRouteDependencies): Router {
  const router = Router();
  const now = deps.now ?? ((): Date => new Date());

  router.get('/api/settings/public', async (_req, res) => {
    res.json(await deps.settings.getPublic());
  });

  // requireAuth 写 req.context，requireAdmin 做角色门槛 —— 两个都要挂
  const auth = requireAuth(deps.tokenService);
  const admin = requireAdmin;

  router.get('/api/admin/settings', auth, admin, async (_req, res) => {
    res.json(await deps.settings.getAll());
  });

  router.put('/api/admin/settings', auth, admin, async (req, res) => {
    const body = req.body as unknown;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('VALIDATION_ERROR', '请求体必须为键值对象');
    }
    const entries = body as Record<string, unknown>;
    for (const key of Object.keys(entries)) {
      if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
        throw new AppError(
          'VALIDATION_ERROR',
          `设置键名长度必须在 1-${MAX_KEY_LENGTH} 之间`,
        );
      }
    }
    await deps.settings.setMany(entries, now());
    res.json({ ok: true, saved: Object.keys(entries).length });
  });

  return router;
}
