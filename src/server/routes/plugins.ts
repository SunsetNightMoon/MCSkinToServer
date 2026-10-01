import { Router } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import { requireAuth, requireSuperAdmin } from '../middleware.js';
import { AppError } from '../../errors.js';
import type { PluginHost } from '../../plugins/loader.js';
import type { ImportSource, PluginImporter } from '../../plugins/importer.js';
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
  /** GitHub 导入器；未启用插件系统时是 undefined，接口回 501 而不是假装能装 */
  importer?: PluginImporter;
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

  // ---- 玩家侧「绑定」区：只回「哪些启用的插件实现了绑定能力」，不含任何管理信息 ----
  // 刻意不挂在 /api/plugins/ 下：那一族路径的第一段被分发器当作插件 id，
  // 而 `bindings` 恰好也是合法的 id 形态 —— 放进去会得到一个永远 404 的端点。
  router.get('/api/bindings', auth, async (_req, res) => {
    res.json({ bindings: requireHost().bindingCatalog() });
  });

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

  const requireImporter = (): PluginImporter => {
    if (!deps.importer) {
      throw new AppError('NOT_IMPLEMENTED', '本实例未启用插件系统（设 MCSTS_PLUGINS=1 后重启后端）');
    }
    return deps.importer;
  };

  const sourceOf = (body: unknown): ImportSource => {
    const record = (body ?? {}) as Record<string, unknown>;
    // 只有仓库地址与子目录两项：版本号由导入器从 tag 里自动识别（见 importer.ts）。
    // 面板那一栏仍叫 `repo`，但语义放宽成「仓库地址」：owner/name、clone 地址、
    // 网页地址、镜像前缀 + 完整地址都认，认不出才报错。
    return {
      repoInput: String(record['repo'] ?? ''),
      dir: record['dir'] === undefined ? undefined : String(record['dir']),
    };
  };

  // 预览不写盘：先把「要装什么」摊给超管看（文件清单、体积、manifest 摘要、标记核对结果）
  router.post('/api/admin/plugins/import/preview', auth, superAdmin, async (req, res) => {
    const preview = await requireImporter().preview(sourceOf(req.body));
    res.json({ preview });
  });

  // 安装 = 落盘 + 发现。**不启用** —— 与「发现不等于授权」同一口径。
  // `sha` 必须带回来：预览看到的那一份 commit 和实际装进磁盘的必须是同一份。
  router.post('/api/admin/plugins/import', auth, superAdmin, async (req, res) => {
    const host = requireHost();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sha = String(body['sha'] ?? '');
    if (sha.length < 7) throw new AppError('VALIDATION_ERROR', '请先预览，再带着预览给出的 commit sha 安装');
    const result = await requireImporter().install(
      sourceOf(body),
      sha,
      req.context!.userId,
      body['replace'] === true,
    );
    await host.scan();
    await host.logImport(
      result.manifest.id,
      req.context!.userId,
      `${result.repo}@${result.tag}（${sha.slice(0, 10)}），${result.files.length} 个文件`,
    );
    res.json({ ok: true, id: result.manifest.id, sha: result.sha, files: result.files.length });
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

  // 只重载单个插件（重读 manifest + 重跑 setup），不重启站点。
  // 注意 `staleCode`：入口文件在内存里那份模块被导入之后又改过，而运行时（tsx）
  // 会把 URL 上的版本参数归一掉，模块换不下来 —— 这时「重载成功」只重跑了 setup，
  // 代码还是旧的，必须回给面板一个可信的说法。
  router.post('/api/admin/plugins/:id/reload', auth, superAdmin, async (req, res) => {
    const host = requireHost();
    const status = await host.reload(String(req.params['id'] ?? ''), req.context!.userId);
    res.json({ ok: true, state: status.state, version: status.version, staleCode: status.staleCode === true });
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
      // int 同治：清空数字框提交的是 ''，`Number('')` 会得到 0 —— 那是把有效期/上限
      // 悄悄改成 0，比「没改」危险得多，所以一并跳过（要恢复默认值请显式填数字）。
      if ((spec.type === 'secret' || spec.type === 'int') && raw === '') continue;
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
