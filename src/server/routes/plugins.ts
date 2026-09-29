import { Router } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import { requireAuth, requireSuperAdmin } from '../middleware.js';
import { AppError } from '../../errors.js';
import type { PluginHost } from '../../plugins/loader.js';
import type { PluginManifest } from '../../plugins/api.js';
import { generateHookSecret } from '../../plugins/hmac.js';

/**
 * 插件管理端接口（**仅超级管理员**）。
 *
 * 权限定在 super_admin 而不是 admin：装插件等于往本站进程里加代码，
 * 这个决定不该由「能审素材」的管理员做出。
 *
 * 面板要能在按下启用之前看清：这个插件会暴露哪些 HTTP 入口、声明依赖什么外部组件、
 * 需要哪些设置 —— 所以这里回的是 manifest 本体，而不只是一个名字。
 */

export interface PluginRouteDependencies {
  tokenService: TokenService;
  plugins?: PluginHost;
}

interface SettingValue {
  key: string;
  label: string;
  hint?: string;
  type: string;
  value?: string | number | boolean | null;
  /** secret 型只回「是否已设置」，明文永不下发 */
  set?: boolean;
  default?: string | number | boolean;
}

export function createPluginRouter(deps: PluginRouteDependencies): Router {
  const router = Router();
  const auth = requireAuth(deps.tokenService);
  const superAdmin = requireSuperAdmin;

  const requireHost = (): PluginHost => {
    if (!deps.plugins) {
      throw new AppError(
        'NOT_IMPLEMENTED',
        '本实例未启用插件系统（设 MCSTS_PLUGINS=1 后重启后端）',
      );
    }
    return deps.plugins;
  };

  const manifestOf = (host: PluginHost, id: string): PluginManifest | undefined =>
    (host.statusesSync().find((item) => item.id === id) ?? {}).manifest;

  router.get('/api/admin/plugins', auth, superAdmin, async (_req, res) => {
    const host = requireHost();
    const statuses = await host.listStatuses();
    const hookSecretSet: Record<string, boolean> = {};
    for (const item of statuses) {
      hookSecretSet[item.id] = host.needsHookSecret(item.id)
        ? await host.hookSecretSet(item.id)
        : false;
    }
    res.json({ statuses, log: await host.log(), hookSecretSet });
  });

  router.post('/api/admin/plugins/scan', auth, superAdmin, async (_req, res) => {
    await requireHost().scan();
    res.json({ ok: true });
  });

  router.post('/api/admin/plugins/:id/enable', auth, superAdmin, async (req, res) => {
    const host = requireHost();
    const id = String(req.params['id'] ?? '');
    await host.enable(id, req.context!.userId);
    res.json({ ok: true });
  });

  router.post('/api/admin/plugins/:id/disable', auth, superAdmin, async (req, res) => {
    const host = requireHost();
    await host.disable(String(req.params['id'] ?? ''), req.context!.userId);
    res.json({ ok: true });
  });

  router.get('/api/admin/plugins/:id/settings', auth, superAdmin, async (req, res) => {
    const host = requireHost();
    const manifest = manifestOf(host, String(req.params['id'] ?? ''));
    if (!manifest) throw new AppError('NOT_FOUND', '插件不存在');
    const items: SettingValue[] = [];
    for (const spec of manifest.settings ?? []) {
      const value = await host.readSetting(manifest.id, spec.key);
      if (spec.type === 'secret') {
        items.push({
          key: spec.key,
          label: spec.label,
          hint: spec.hint,
          type: spec.type,
          set: typeof value === 'string' && value !== '',
        });
      } else {
        items.push({
          key: spec.key,
          label: spec.label,
          hint: spec.hint,
          type: spec.type,
          value: value ?? spec.default ?? null,
        });
      }
    }
    res.json({ settings: items });
  });

  router.put('/api/admin/plugins/:id/settings', auth, superAdmin, async (req, res) => {
    const host = requireHost();
    const manifest = manifestOf(host, String(req.params['id'] ?? ''));
    if (!manifest) throw new AppError('NOT_FOUND', '插件不存在');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const specs = new Map((manifest.settings ?? []).map((s) => [s.key, s]));
    for (const [key, raw] of Object.entries(body)) {
      const spec = specs.get(key);
      if (!spec) throw new AppError('VALIDATION_ERROR', `该插件未声明设置项：${key}`);
      if (raw === undefined) continue;
      // 空串 = 「没改」而不是「刻意清空」：与 SMTP_PASS / EXTERNAL_CAPTCHA_SECRET 同一口径，
      // 否则管理员改别的字段顺手保存一次就把密钥清了，而且没有任何提示。
      if (spec.type === 'secret' && raw === '') continue;
      const value =
        spec.type === 'int'
          ? Number(raw)
          : spec.type === 'bool'
            ? raw === true || raw === 'true'
            : String(raw);
      if (spec.type === 'int' && !Number.isFinite(value as number)) {
        throw new AppError('VALIDATION_ERROR', `${key} 必须是数字`);
      }
      await host.writeSetting(manifest.id, spec.key, value, spec.type === 'secret');
    }
    res.json({ ok: true, saved: Object.keys(body).length });
  });

  router.post('/api/admin/plugins/:id/hook-secret', auth, superAdmin, async (req, res) => {
    const host = requireHost();
    const id = String(req.params['id'] ?? '');
    if (!host.needsHookSecret(id)) {
      throw new AppError('VALIDATION_ERROR', '该插件没有声明需要服务器密钥的回调入口');
    }
    const action = String((req.body ?? {})['action'] ?? 'generate');
    if (action === 'clear') {
      await host.setHookSecret(id, null, req.context!.userId);
      res.json({ ok: true, cleared: true });
      return;
    }
    const secret = generateHookSecret();
    await host.setHookSecret(id, secret, req.context!.userId);
    // 明文只在这次响应里出现一次：面板提示「复制好，之后再也看不到」
    res.json({ ok: true, secret });
  });

  return router;
}
