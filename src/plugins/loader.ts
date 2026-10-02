import { readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DatabaseConnection } from '../types.js';
import type { SettingRepository } from '../repositories/settingRepository.js';
import type { ProfileRepository } from '../repositories/profileRepository.js';
import { SecretBox } from '../util/secretBox.js';
import type { SiteUrlResolver } from '../site/siteUrl.js';
import type { CachePort, RateLimiterPort } from '../cache/types.js';
import type { TokenService } from '../auth/tokens.js';
import { requireAuth, requireRole } from '../server/middleware.js';
import { AppError } from '../errors.js';
import {
  PLUGIN_API_VERSION,
  type PluginBindingActor,
  type PluginBindingInput,
  type PluginBindingListResult,
  type PluginBindingRow,
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
  /**
   * 磁盘上的入口文件比内存里那份模块实例新 —— **重载救不了这种情况**。
   * tsx 的解析器会把 `file:` URL 上的 query / hash 归一掉（实测：带 `?v=1` 与不带
   * 拿到的是同一个模块实例），所以重载只是重跑了 `setup`，编译产物还是旧的。
   * 面板必须把这件事说出来，而不是给一个「重载成功」的假象。
   */
  staleCode?: boolean;
}

export interface PluginHostDeps {
  db: DatabaseConnection;
  settings: SettingRepository;
  secretBox?: SecretBox;
  siteUrlResolver: SiteUrlResolver;
  tokenService: TokenService;
  /** 绑定页要用它校验「这个 profileId 是不是当前登录账号的角色」——插件拿不到仓储，归属判定只能由核心做 */
  profileRepository: ProfileRepository;
  /** 站点 Yggdrasil RSA 公钥（PEM）：经 ctx.site.publicKeyPem() 给插件做验签类功能 */
  publicKeyPem: () => string | null;
  /** 角色当前素材的签名纹理 property（ctx.textures）：复用核心 Yggdrasil 构建链路 */
  buildTextureProperty: (profileId: string) => Promise<import('./api.js').PluginTextureProperty | null>;
  cache?: CachePort;
  rateLimiter?: RateLimiterPort;
  pluginDir: string;
  now: () => Date;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  capabilities: PluginCapabilities;
  router: Router;
  entryPath: string;
  /** 导入那一刻入口文件的 mtime */
  entryMtimeMs: number;
  /** 拿到的模块命名空间本体：与下次导入的结果比身份，就知道运行时有没有真的换代码 */
  entryModule: unknown;
}

export class PluginHost {
  private readonly eventBus = new PluginEventBus();
  private readonly registry: PluginRegistry;
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly statuses = new Map<string, PluginStatus>();
  private readonly dirs = new Map<string, string>();
  private readonly parent = Router();
  private booted = false;
  /**
   * 重载计数：ESM 的 `import()` 按 URL 缓存模块，同一个 file URL 第二次拿到的是同一份代码。
   * 作者改完插件不该只能重启整站，所以重载时给 URL 挂一个版本参数把它隔开。
   * 只在真的重载过之后才加参数（`?v=0` 之外），避免给首启动引入不必要的 URL 变体。
   */
  private reloadSeq = 0;

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

  /**
   * 重载单个插件：重读 manifest、重新导入代码，**保持原来的启用状态**。
   *
   * 为什么要有它：插件跑在本进程里，作者改完一行代码原本只能重启整站；
   * 而重启会把「装了什么、现在什么状态」这件事和一堆无关服务一起搅动。
   * 影响面收在单个插件上，才是这个面板该有的操作粒度。
   */
  async reload(id: string, actor: string): Promise<PluginStatus> {
    const dir = this.dirs.get(id);
    if (!dir) throw new AppError('NOT_FOUND', `未发现插件：${id}`);
    const state = await this.registry.read();
    const wasEnabled = state.plugins[id]?.enabled ?? false;
    const prior = this.loaded.get(id);
    if (this.loaded.has(id)) await this.unload(id, actor);
    this.reloadSeq += 1;
    if (!wasEnabled) {
      // 没启用的插件只重读 manifest，不因为一次重载就悄悄挂进进程 —— 与「发现不等于授权」同一口径
      await this.scan();
      const status = this.statuses.get(id);
      if (!status) throw new AppError('NOT_FOUND', `未发现插件：${id}`);
      return status;
    }
    await this.loadOne(id, dir, actor, prior);
    const status = this.statuses.get(id);
    if (!status || status.state === 'error') {
      throw new AppError('CONFIG_ERROR', status?.error ?? '插件重新加载失败');
    }
    return status;
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

  /** 导入落盘后记一笔台账：面板要能回答「这东西什么时候、从哪个仓库来的」 */
  async logImport(id: string, actor: string, detail: string): Promise<void> {
    await this.registry.logImported(id, actor, detail);
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

  private async loadOne(
    id: string,
    dir: string,
    actor: string,
    /** 重载时由调用方在 unload 之前取好的旧实例（unload 会把 loaded 里的记录删掉） */
    prior?: LoadedPlugin,
  ): Promise<void> {
    try {
      const result = await readManifest(dir);
      if (!result.ok) throw new Error(result.issues.map((i) => `${i.field}: ${i.message}`).join('；'));
      const manifest = result.manifest;
      if (manifest.apiVersion !== PLUGIN_API_VERSION) {
        throw new Error(`插件要求 API v${manifest.apiVersion}，本站是 v${PLUGIN_API_VERSION}`);
      }
      const entry = resolve(dir, manifest.main);
      const entryMtimeMs = (await stat(entry)).mtimeMs;
      // Windows 下裸路径不能被 import() 接受，必须 file:// URL。
      // 这个 query 在纯 node 下确实能拿到新模块；在 tsx 下会被解析器归一掉，等于没有。
      const entryUrl =
        this.reloadSeq > 0
          ? `${pathToFileURL(entry).href}?mcsts-reload=${this.reloadSeq}`
          : pathToFileURL(entry).href;
      const imported = (await import(entryUrl)) as PluginEntry;
      /**
       * 「代码到底换没换」不靠猜运行时：入口文件 mtime 变了，而 `import()` 回来的
       * 还是**同一个模块对象**，就说明缓存没被绕开 —— 内存里跑的仍是旧代码。
       * （实测 tsx 会把 URL 上的 query / hash 归一掉，正是这种情况；纯 node 会拿到
       * 一个新命名空间对象，于是这里自动判为「已换代码」。）
       */
      const staleCode =
        prior !== undefined && prior.entryMtimeMs !== entryMtimeMs && prior.entryModule === imported;
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
          publicKeyPem: this.deps.publicKeyPem,
          buildTextureProperty: this.deps.buildTextureProperty,
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
        entryPath: entry,
        // 代码没换成功时，继续记**旧那份**的指纹：否则下一次重载会以为已经换过了
        entryMtimeMs: staleCode ? prior!.entryMtimeMs : entryMtimeMs,
        entryModule: staleCode ? prior!.entryModule : imported,
      });
      this.statuses.set(id, {
        id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        enabled: true,
        state: 'ready',
        manifest,
        staleCode,
      });
      await this.registry.logLoaded(id, actor, `${manifest.name} ${manifest.version}`).catch(() => undefined);
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
    await this.registry.logUnload(id, actor).catch(() => undefined);
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
    // 绑定页的三入口由核心提供：插件在 manifest 声明了就挂，形态校验也在核心做。
    // 声明了却没登记实现时路由照样在（回 503 说明原因），否则症状是无声 404，作者找不到线索。
    if (manifest.binding) this.attachBindingRoutes(router, manifest, caps, authed);
    return router;
  }

  private attachBindingRoutes(
    router: Router,
    manifest: PluginManifest,
    caps: PluginCapabilities,
    authed: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  ): void {
    const subject = manifest.binding!.subject;
    const notReady = (res: Response): void => {
      res.status(503).json({
        error: 'PLUGIN_UNAVAILABLE',
        message: `插件 ${manifest.id} 在 manifest 声明了 binding，但没有调用 ctx.binding() 登记实现`,
      });
    };
    /**
     * 归属判定全部在核心：插件收到的 profileId 一定属于当前会话账号，
     * 「拿别人的 profileId 绑/解绑」在结构上不可能发生，而不是靠每个作者记得查。
     */
    const actorOf = async (req: Request, profileIdRaw: string): Promise<PluginBindingActor> => {
      const user = req.context;
      if (!user) throw new AppError('TOKEN_INVALID', '未登录');
      let profileId: string | null = null;
      let profileName: string | null = null;
      if (subject === 'profile') {
        if (profileIdRaw === '') {
          throw new AppError('VALIDATION_ERROR', '这个绑定按角色绑定，请在页面上选择角色');
        }
        const profile = await this.deps.profileRepository.findById(profileIdRaw);
        if (!profile || profile.userId !== user.userId) {
          throw new AppError('FORBIDDEN', '该角色不属于当前登录账号');
        }
        if (profile.status !== 'active') {
          throw new AppError('PROFILE_RESERVED', '预留角色不能作为绑定主体');
        }
        profileId = profile.id;
        profileName = profile.name;
      }
      return { userId: user.userId, profileId, profileName, role: user.role, ip: req.ip ?? '' };
    };

    router.get(
      '/binding',
      async (req, res, next) => {
        await authed(req, res, next);
      },
      (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
          const handlers = caps.bindingHandlers;
          if (!handlers) {
            notReady(res);
            return;
          }
          const actor = await actorOf(req, String(req.query['profileId'] ?? ''));
          const result = assertBindingListResult(manifest.id, await handlers.list(actor));
          res.json({ pluginId: manifest.id, subject, ...result });
        })().catch(next);
      },
    );

    // 生成码是绑定流程里唯一能被刷的入口（一次 issue 一行令牌），按 用户+IP 限 10 次/分钟
    router.post(
      '/binding/issue',
      async (req, res, next) => {
        await authed(req, res, next);
      },
      (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
          const handlers = caps.bindingHandlers;
          if (!handlers) {
            notReady(res);
            return;
          }
          if (typeof handlers.issue !== 'function') {
            throw new AppError('NOT_IMPLEMENTED', `插件 ${manifest.id} 未开放一次性码（binding.issue=false）`);
          }
          const actor = await actorOf(req, String((req.body ?? {})['profileId'] ?? ''));
          const rl = await caps.authenticator.consumeRateLimit(
            manifest.id,
            `${actor.userId}|${actor.ip}`,
            10,
            60_000,
          );
          if (!rl.allowed) {
            res.setHeader('Retry-After', Math.ceil(rl.resetAfterMs / 1000));
            res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: '生成绑定码过于频繁，请稍后再试' });
            return;
          }
          res.json(assertBindingIssueResult(manifest.id, await handlers.issue(actor)));
        })().catch(next);
      },
    );

    router.post(
      '/binding/revoke',
      async (req, res, next) => {
        await authed(req, res, next);
      },
      (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
          const handlers = caps.bindingHandlers;
          if (!handlers) {
            notReady(res);
            return;
          }
          if (typeof handlers.revoke !== 'function') {
            throw new AppError('NOT_IMPLEMENTED', `插件 ${manifest.id} 未开放网页侧自助解绑`);
          }
          const body = (req.body ?? {}) as Record<string, unknown>;
          const bindingId = String(body['bindingId'] ?? '');
          if (bindingId === '') throw new AppError('VALIDATION_ERROR', '缺少 bindingId');
          const actor = await actorOf(req, String(body['profileId'] ?? ''));
          await handlers.revoke({ ...actor, bindingId });
          res.json({ ok: true });
        })().catch(next);
      },
    );

    // 申请制入口：玩家往页面提交一个值（如 XUID）。pattern 在核心预校验 ——
    // 声明里写了格式，插件就不该再为「页面被塞了脏值」写防御代码。
    router.post(
      '/binding/claim',
      async (req, res, next) => {
        await authed(req, res, next);
      },
      (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
          const handlers = caps.bindingHandlers;
          if (!handlers) {
            notReady(res);
            return;
          }
          if (typeof handlers.claim !== 'function') {
            throw new AppError('NOT_IMPLEMENTED', `插件 ${manifest.id} 未开放网页侧申请（claim）`);
          }
          const body = (req.body ?? {}) as Record<string, unknown>;
          const value = String(body['value'] ?? '').trim();
          if (value === '' || value.length > 128) {
            throw new AppError('VALIDATION_ERROR', 'value 必须是 1-128 个字符');
          }
          const pattern = manifest.binding?.input?.pattern;
          if (pattern && !new RegExp(pattern).test(value)) {
            throw new AppError('VALIDATION_ERROR', `输入格式不符合要求：${manifest.binding?.input?.hint ?? pattern}`);
          }
          const actor = await actorOf(req, String(body['profileId'] ?? ''));
          const rl = await caps.authenticator.consumeRateLimit(
            manifest.id,
            `claim:${actor.userId}|${actor.ip}`,
            10,
            60_000,
          );
          if (!rl.allowed) {
            res.setHeader('Retry-After', Math.ceil(rl.resetAfterMs / 1000));
            res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: '提交申请过于频繁，请稍后再试' });
            return;
          }
          const result = await handlers.claim({ ...actor, value });
          const message =
            result && typeof result === 'object' && typeof result.message === 'string'
              ? { message: result.message }
              : {};
          res.json({ ok: true, ...message });
        })().catch(next);
      },
    );
  }

  /** 玩家侧「绑定」区用：当前启用且实现了绑定能力的插件目录 */
  bindingCatalog(): PluginBindingCatalogEntry[] {
    const list: PluginBindingCatalogEntry[] = [];
    for (const [id, item] of this.loaded) {
      if (!item.manifest.binding || !item.capabilities.bindingHandlers) continue;
      list.push({
        pluginId: id,
        name: item.manifest.name,
        description: item.manifest.description,
        subject: item.manifest.binding.subject,
        revocable: typeof item.capabilities.bindingHandlers.revoke === 'function',
        claimable: typeof item.capabilities.bindingHandlers.claim === 'function',
        issuable: item.manifest.binding.issue !== false,
        input: item.manifest.binding.input,
      });
    }
    return list.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
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

export interface PluginBindingCatalogEntry {
  pluginId: string;
  name: string;
  description?: string;
  subject: 'account' | 'profile';
  revocable: boolean;
  claimable: boolean;
  /** manifest 写了 binding.issue:false 时为 false：issue 路由 501，绑定页收起生成码按钮 */
  issuable: boolean;
  input?: PluginBindingInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 绑定页契约的运行时校验。
 *
 * 形态校验放在核心而不是让页面容错插件的任意返回，是因为「界面在撒谎」比报错更难排查：
 * 页面拿到缺字段的行会渲染出半坏的列表，玩家以为绑定丢了，其实只是某行少个 label。
 * 违背契约一律 `PLUGIN_BAD_RESULT` 明确报错，文案指名是哪个插件。
 */
function assertBindingListResult(pluginId: string, value: unknown): PluginBindingListResult {
  // 用函数声明而不是箭头 const：只有声明式 never 函数能参与控制流收窄（本仓库 TS 版本 <5.7）
  function bad(why: string): never {
    throw new AppError('PLUGIN_BAD_RESULT', `插件 ${pluginId} 的 list() 返回形态不符合绑定契约：${why}`);
  }
  if (!isRecord(value) || !Array.isArray(value['bindings'])) bad('缺少 bindings 数组');
  const bindings = value['bindings'] as unknown[];
  const seen = new Set<string>();
  const rows: PluginBindingRow[] = [];
  bindings.forEach((raw, i) => {
    if (!isRecord(raw)) bad(`bindings[${i}] 必须是对象`);
    const id = String(raw['id'] ?? '');
    if (id === '') bad(`bindings[${i}].id 必须是非空字符串（它是解绑句柄）`);
    if (seen.has(id)) bad(`bindings[${i}].id 重复：${id}`);
    seen.add(id);
    if (!Array.isArray(raw['fields'])) bad(`bindings[${i}].fields 必须是数组`);
    const fields = (raw['fields'] as unknown[]).map((f, j) => {
      if (!isRecord(f)) bad(`bindings[${i}].fields[${j}] 必须是对象`);
      const label = f['label'];
      const val = f['value'];
      if (typeof label !== 'string' || typeof val !== 'string') {
        bad(`bindings[${i}].fields[${j}] 必须是 { label: string, value: string }`);
      }
      const secret = f['secret'];
      if (secret !== undefined && typeof secret !== 'boolean') {
        bad(`bindings[${i}].fields[${j}].secret 必须是布尔值（true = 页面默认打码）`);
      }
      return secret === true ? { label, value: val, secret: true } : { label, value: val };
    });
    const boundAtRaw = raw['boundAt'];
    const boundAt = typeof boundAtRaw === 'string' ? { boundAt: boundAtRaw } : {};
    const statusRaw = raw['status'];
    let status: { status: 'pending' | 'active' } | Record<string, never> = {};
    if (statusRaw !== undefined && statusRaw !== null) {
      if (statusRaw !== 'pending' && statusRaw !== 'active') {
        bad(`bindings[${i}].status 只能是 'pending' 或 'active'`);
      }
      status = { status: statusRaw as 'pending' | 'active' };
    }
    rows.push({ id, fields, ...boundAt, ...status });
  });
  const instructionsRaw = value['instructions'];
  const instructions = typeof instructionsRaw === 'string' ? { instructions: instructionsRaw } : {};
  return { bindings: rows, ...instructions };
}

function assertBindingIssueResult(
  pluginId: string,
  value: unknown,
): { code: string; expiresAt: string } {
  function bad(why: string): never {
    throw new AppError('PLUGIN_BAD_RESULT', `插件 ${pluginId} 的 issue() 返回形态不符合绑定契约：${why}`);
  }
  if (!isRecord(value)) bad('必须返回对象');
  const code = value['code'];
  const expiresAt = value['expiresAt'];
  if (typeof code !== 'string' || code.trim() === '' || code.length > 64) {
    bad('code 必须是非空且不超过 64 字符的字符串');
  }
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    bad('expiresAt 必须是可解析的时间字符串（页面用它做倒计时）');
  }
  return { code, expiresAt };
}

/** 供 bootstrap 判定「这个子系统到底要不要建」 */
export function pluginsEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MCSTS_PLUGINS'] === '1' || env['MCSTS_PLUGINS'] === 'true';
}

export { manifestFingerprint };
