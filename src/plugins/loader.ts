import { readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DatabaseConnection } from '../types.js';
import type { SettingRepository } from '../repositories/settingRepository.js';
import { SecretBox } from '../util/secretBox.js';
import type { SiteUrlResolver } from '../site/siteUrl.js';
import type { CachePort, RateLimiterPort } from '../cache/types.js';
import type { TokenService } from '../auth/tokens.js';
import { requireAuth, requireRole } from '../server/middleware.js';
import { AppError } from '../errors.js';
import {
  PLUGIN_API_VERSION,
  type PluginEntry,
  type PluginManifest,
  type PluginRequest,
  type PluginResponse,
} from './api.js';
import { PluginEventBus, installPluginEventBus } from './events.js';
import { createCapabilities, type PluginCapabilities } from './capabilities.js';
import { HOOK_SECRET_KEY, PluginRegistry } from './registry.js';
import { manifestFingerprint, readManifest, type ManifestIssue } from './manifest.js';
import { NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './hmac.js';

/**
 * 插件宿主：扫盘 → 校验 manifest → 动态 import → 建 ctx → 挂路由。
 *
 * ## 为什么启停不需要重启进程
 *
 * 启动时只往 `/api/plugins` 挂**一个分发器**，每个插件的子 Router 在请求到来时才查表。
 * 启用 = 现场 import + setup + 建子 Router；禁用 = dispose + 摘掉子 Router。
 * 这样就不必去动 `main.ts` 的 listen/软重启路径 —— 那是核心最不该被插件牵动的部分。
 *
 * ## 失败隔离的落点
 *
 * import 抛错、setup 抛错、注册了未声明的入口、handler 抛错，四处各自捕获并标成该插件的
 * `error` 状态，站点其余部分照常服务。
 */

export interface PluginStatus {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  enabled: boolean;
  state: 'ready' | 'disabled' | 'error' | 'invalid';
  error?: string;
  manifest?: PluginManifest;
}

export interface PluginHostDeps {
  db: DatabaseConnection;
  settings: SettingRepository;
  secretBox?: SecretBox;
  siteUrlResolver: SiteUrlResolver;
  tokenService: TokenService;
  cache?: CachePort;
  rateLimiter?: RateLimiterPort;
  pluginDir: string;
  now: () => Date;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  capabilities: PluginCapabilities;
  router: Router;
}

export class PluginHost {
  private readonly eventBus = new PluginEventBus();
  private readonly registry: PluginRegistry;
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly statuses = new Map<string, PluginStatus>();
  private readonly dirs = new Map<string, string>();
  private readonly parent = Router();
  private booted = false;

  constructor(private readonly deps: PluginHostDeps) {
    this.registry = new PluginRegistry(deps.settings, deps.now);
  }

  /** 挂在外层的唯一入口：/api/plugins */
  get router(): Router {
    return this.parent;
  }

  async boot(): Promise<void> {
    installPluginEventBus(this.eventBus);
    this.eventBus.setEnabled(true);
    await this.scan();
    const state = await this.registry.read();
    for (const [id, record] of Object.entries(state.plugins)) {
      if (!record.enabled || !this.dirs.has(id)) continue;
      const dir = this.dirs.get(id);
      if (dir) await this.loadOne(id, dir, 'system');
    }
    this.booted = true;
    // 分发器只建一次；它按请求现查 loaded，所以启用/禁用都不必重新挂载
    this.parent.use((req, res, next) => {
      void this.dispatch(req, res, next);
    });
  }

  /** 扫插件目录：只认「子目录 + mcsts.plugin.json」这一种形态 */
  async scan(): Promise<void> {
    this.dirs.clear();
    const root = resolve(this.deps.pluginDir);
    let names: string[] = [];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // 目录不存在 = 一个插件都没装过，这是常态而不是错误
      for (const status of this.statuses.values()) this.statuses.delete(status.id);
      return;
    }
    const manifests: PluginManifest[] = [];
    for (const name of names) {
      const dir = join(root, name);
      if (!(await stat(join(dir, 'mcsts.plugin.json')).then(() => true).catch(() => false))) continue;
      const result = await readManifest(dir);
      if (!result.ok) {
        this.statuses.set(name, {
          id: name,
          name,
          version: '?',
          apiVersion: 0,
          enabled: false,
          state: 'invalid',
          error: result.issues.map((i: ManifestIssue) => `${i.field}: ${i.message}`).join('；'),
        });
        continue;
      }
      this.dirs.set(result.manifest.id, dir);
      manifests.push(result.manifest);
      if (result.manifest.id !== name) {
        // 目录名与 id 不一致只提示不拒载：拒载会让作者困惑，而 id 才是权威
        console.warn(`[plugins] 目录 ${name} 的 manifest id 是 ${result.manifest.id}，以 id 为准`);
      }
    }
    await this.registry.discovered(manifests);
    await this.registry.pruneAbsent([...this.dirs.keys()]);
    const state = await this.registry.read();
    for (const manifest of manifests) {
      const record = state.plugins[manifest.id];
      if (this.loaded.has(manifest.id)) continue;
      this.statuses.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        enabled: record?.enabled ?? false,
        state: record?.enabled ? 'error' : 'disabled',
        error: record?.enabled ? '尚未成功加载，请尝试重新启用' : undefined,
        manifest,
      });
    }
    for (const id of [...this.statuses.keys()]) {
      if (!this.dirs.has(id) && !this.loaded.has(id)) this.statuses.delete(id);
    }
  }

  async enable(id: string, actor: string): Promise<PluginStatus> {
    const dir = this.dirs.get(id);
    if (!dir) throw new AppError('NOT_FOUND', `未发现插件：${id}`);
    const existing = this.statuses.get(id);
    if (!existing?.manifest) {
      const result = await readManifest(dir);
      if (!result.ok) {
        throw new AppError(
          'VALIDATION_ERROR',
          `manifest 不合法：${result.issues.map((i) => `${i.field}: ${i.message}`).join('；')}`,
        );
      }
    }
    await this.registry.setEnabled(id, true, actor);
    await this.loadOne(id, dir, actor);
    const status = this.statuses.get(id);
    if (!status || status.state === 'error') {
      throw new AppError('CONFIG_ERROR', status?.error ?? '插件加载失败');
    }
    return status;
  }

  async disable(id: string, actor: string): Promise<void> {
    await this.registry.setEnabled(id, false, actor);
    await this.unload(id, actor);
  }

  async listStatuses(): Promise<PluginStatus[]> {
    const state = await this.registry.read();
    const list = [...this.statuses.values()];
    for (const item of list) {
      item.enabled = state.plugins[item.id]?.enabled ?? false;
      item.manifest = item.manifest ?? undefined;
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 同步快照：管理端路由要在插件未加载（没有 ctx）时也能读到 manifest */
  statusesSync(): PluginStatus[] {
    return [...this.statuses.values()];
  }

  /**
   * 直接读写某个插件的设置（不经过 ctx）。
   *
   * 必须能这样：插件处于 disabled 或加载失败时，超管仍然要能把密钥/参数填进去，
   * 否则就是「先启用才能配置，但没配置就启用失败」的死结。
   */
  async readSetting(id: string, key: string): Promise<string | number | boolean | undefined> {
    const raw = await this.deps.settings.get(`plugin.${id}.${key}`);
    if (raw === undefined || raw === null) return undefined;
    const spec = this.statuses.get(id)?.manifest?.settings?.find((item) => item.key === key);
    if (spec?.type === 'secret' && typeof raw === 'string') {
      return readMaybeSecret(this.deps.secretBox, raw);
    }
    return raw as string | number | boolean;
  }

  async writeSetting(id: string, key: string, value: unknown, isSecret: boolean): Promise<void> {
    const stored = isSecret && typeof value === 'string' && value !== ''
      ? (this.deps.secretBox ? this.deps.secretBox.encrypt(value) : value)
      : value;
    await this.deps.settings.setMany({ [`plugin.${id}.${key}`]: stored }, this.deps.now());
  }

  async log() {
    return (await this.registry.read()).log;
  }

  /** 面板用：这个插件有没有声明需要服务器密钥（hmac 入口） */
  needsHookSecret(id: string): boolean {
    return (this.statuses.get(id)?.manifest?.endpoints ?? []).some((e) => e.auth === 'hmac');
  }

  async setHookSecret(id: string, secret: string | null, actor: string): Promise<void> {
    // 密钥与 SMTP 口令同等待遇：有主密钥就加密入库，面板只回「是否已设置」
    const stored =
      secret === null ? null : this.deps.secretBox ? this.deps.secretBox.encrypt(secret) : secret;
    await this.deps.settings.setMany(
      { [`plugin.${id}.${HOOK_SECRET_KEY}`]: stored },
      this.deps.now(),
    );
    await this.registry.markHookSecret(id, secret !== null, actor);
  }

  async hookSecretSet(id: string): Promise<boolean> {
    const raw = await this.deps.settings.get(`plugin.${id}.${HOOK_SECRET_KEY}`);
    return typeof raw === 'string' && raw !== '';
  }

  private async loadOne(id: string, dir: string, actor: string): Promise<void> {
    try {
      const result = await readManifest(dir);
      if (!result.ok) throw new Error(result.issues.map((i) => `${i.field}: ${i.message}`).join('；'));
      const manifest = result.manifest;
      if (manifest.apiVersion !== PLUGIN_API_VERSION) {
        throw new Error(`插件要求 API v${manifest.apiVersion}，本站是 v${PLUGIN_API_VERSION}`);
      }
      const entry = resolve(dir, manifest.main);
      // Windows 下裸路径不能被 import() 接受，必须 file:// URL
      const imported = (await import(pathToFileURL(entry).href)) as PluginEntry;
      const setup = imported.default ?? imported.setup;
      if (typeof setup !== 'function') {
        throw new Error(`${manifest.main} 没有导出 setup 函数（默认导出或具名导出 setup 均可）`);
      }
      const capabilities = createCapabilities(
        {
          db: this.deps.db,
          settings: this.deps.settings,
          secretBox: this.deps.secretBox,
          siteUrlResolver: this.deps.siteUrlResolver,
          eventBus: this.eventBus,
          tokenService: this.deps.tokenService,
          cache: this.deps.cache,
          rateLimiter: this.deps.rateLimiter,
          now: this.deps.now,
        },
        manifest,
      );
      const returned = await setup(capabilities.ctx);
      // 作者返回的清理函数挂在 capabilities.dispose 之后：先让它自己收尾，再摘事件
      const authorDispose = typeof returned === 'function' ? returned : undefined;
      const capabilitiesWithDispose: PluginCapabilities = authorDispose
        ? {
            ...capabilities,
            dispose: async () => {
              await authorDispose();
              await capabilities.dispose();
            },
          }
        : capabilities;
      this.loaded.set(id, {
        manifest,
        capabilities: capabilitiesWithDispose,
        router: this.buildRouter(manifest, capabilitiesWithDispose),
      });
      this.statuses.set(id, {
        id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        enabled: true,
        state: 'ready',
        manifest,
      });
      await this.registry.setEnabled(id, true, actor, `${manifest.name} ${manifest.version}`).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.statuses.set(id, {
        id,
        name: this.statuses.get(id)?.name ?? id,
        version: this.statuses.get(id)?.version ?? '?',
        apiVersion: this.statuses.get(id)?.apiVersion ?? 0,
        enabled: false,
        state: 'error',
        error: message,
        manifest: this.statuses.get(id)?.manifest,
      });
      await this.registry.logError(id, message).catch(() => undefined);
      console.error(`[plugins] ${id} 加载失败（站点其余部分不受影响）：`, message);
    }
  }

  private async unload(id: string, actor: string): Promise<void> {
    const item = this.loaded.get(id);
    if (!item) return;
    try {
      await item.capabilities.dispose();
    } catch (err) {
      console.warn(`[plugins] ${id} dispose 抛错（忽略）：`, err instanceof Error ? err.message : err);
    }
    this.loaded.delete(id);
    const manifest = item.manifest;
    this.statuses.set(id, {
      id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      enabled: false,
      state: 'disabled',
      manifest,
    });
    await this.registry.logError(id, `已由 ${actor} 停用`).catch(() => undefined);
  }

  private buildRouter(manifest: PluginManifest, caps: PluginCapabilities): Router {
    const router = Router({ mergeParams: true });
    const authed = requireAuth(this.deps.tokenService);
    for (const item of caps.registered) {
      const { options, handler } = item;
      const path = item.kind === 'hooks' ? `/hooks${options.path}` : options.path;
      const chain: ((req: Request, res: Response, next: NextFunction) => void)[] = [];
      // 只有网页侧入口才走站点会话；hmac 入口是机器回调，没有 Bearer token，
      // 拿 requireAuth 拦它等于先返 401，真正的签名校验根本轮不到执行
      if (options.auth === 'user' || options.auth === 'admin' || options.auth === 'super') {
        chain.push(async (req, res, next) => {
          await authed(req, res, next);
        });
      }
      if (options.auth === 'admin') chain.push(requireRole(1));
      if (options.auth === 'super') chain.push(requireRole(2));
      if (options.auth === 'hmac') chain.push(this.hmacGate(manifest.id));
      chain.push(this.adapt(manifest.id, item.kind, handler));
      const method = options.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      (router[method] as (p: string, ...h: unknown[]) => void)(path, ...chain);
    }
    return router;
  }

  private hmacGate(pluginId: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
      void (async () => {
        const caps = this.loaded.get(pluginId)?.capabilities;
        if (!caps) {
          res.status(503).json({ error: 'PLUGIN_UNAVAILABLE', message: '插件未启用' });
          return;
        }
        const limit = caps.registered.find(
          (r) =>
            r.kind === 'hooks' &&
            r.options.method === req.method &&
            req.originalUrl.split('?')[0]?.endsWith(r.options.path),
        )?.options.rateLimit;
        const max = limit?.max ?? 30;
        const windowMs = limit?.windowMs ?? 60_000;
        const rl = await caps.authenticator.consumeRateLimit(pluginId, req.ip ?? 'unknown', max, windowMs);
        if (!rl.allowed) {
          res.setHeader('Retry-After', Math.ceil(rl.resetAfterMs / 1000));
          res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: '调用过于频繁' });
          return;
        }
        const secret = await caps.ctx.settings.getSecret(HOOK_SECRET_KEY);
        const verdict = await caps.authenticator.verify({
          secret,
          timestamp: headerOf(req, TIMESTAMP_HEADER),
          nonce: headerOf(req, NONCE_HEADER),
          signature: headerOf(req, SIGNATURE_HEADER),
          method: req.method,
          path: req.originalUrl.split('?')[0] ?? req.path,
          body: req.body,
        });
        if (!verdict.ok) {
          res.status(403).json({ error: 'PLUGIN_HOOK_REJECTED', message: `回调校验未通过：${verdict.reason}` });
          return;
        }
        next();
      })().catch((err: unknown) => next(err));
    };
  }

  private adapt(
    pluginId: string,
    kind: 'router' | 'hooks',
    handler: (req: PluginRequest, res: PluginResponse) => void | Promise<void>,
  ) {
    return (req: Request, res: Response, next: NextFunction): void => {
      void (async () => {
        const base = `/api/plugins/${pluginId}${kind === 'hooks' ? '/hooks' : ''}`;
        await handler(
          {
            method: req.method,
            path: (req.originalUrl.split('?')[0] ?? '').slice(base.length) || '/',
            params: req.params as Record<string, string>,
            query: Object.fromEntries(
              Object.entries(req.query as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            ),
            body: (req.body ?? {}) as Record<string, unknown>,
            header: (name: string) => headerOf(req, name),
            ip: req.ip ?? '',
            user: req.context
              ? {
                  userId: req.context.userId,
                  profileId: req.context.profileId,
                  role: req.context.role,
                }
              : null,
          },
          res as unknown as PluginResponse,
        );
      })().catch((err: unknown) => next(err));
    };
  }

  private async dispatch(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!this.booted) {
      res.status(503).json({ error: 'PLUGIN_UNAVAILABLE', message: '插件系统尚未就绪' });
      return;
    }
    // 挂在 /api/plugins 之下时 Express 会把挂载前缀从 req.url 里剥掉，
    // 但 originalUrl 仍带完整路径 —— 取 id 要用 url，用 originalUrl 会数错一段
    const id = req.url.split('?')[0]?.split('/').filter(Boolean)[0];
    if (!id || !/^[a-z][a-z0-9_]{1,31}$/.test(id)) {
      res.status(404).json({ error: 'NOT_FOUND', message: '插件不存在' });
      return;
    }
    const item = this.loaded.get(id);
    if (!item) {
      const status = this.statuses.get(id);
      res.status(status?.state === 'error' ? 503 : 404).json({
        error: 'PLUGIN_UNAVAILABLE',
        message: status?.state === 'error' ? `插件加载失败：${status.error ?? ''}` : '插件未启用',
      });
      return;
    }
    // 手动委托给子 Router 时，Express 不会替我们剥掉挂载段：不把 req.url 改写回
    // 插件相对路径，子 Router 里的 '/ping' 永远匹配不上（症状是整个插件 404 到兜底处理）
    const [pathname, query] = req.url.split('?');
    const rest = (pathname ?? '').slice(`/${id}`.length) || '/';
    req.url = query ? `${rest}?${query}` : rest;
    item.router(req, res, next);
  }
}

function readMaybeSecret(box: SecretBox | undefined, raw: unknown): string {
  const text = String(raw);
  if (!SecretBox.isEncrypted(text)) return text;
  if (!box) throw new Error('本站未配置主密钥（MCSTS_SECRET），无法解密插件设置中的密文');
  return box.decrypt(text);
}

function headerOf(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** 供 bootstrap 判定「这个子系统到底要不要建」 */
export function pluginsEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MCSTS_PLUGINS'] === '1' || env['MCSTS_PLUGINS'] === 'true';
}

export { manifestFingerprint };
