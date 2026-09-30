import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';
import type { SettingRepository } from '../repositories/settingRepository.js';
import { SecretBox } from '../util/secretBox.js';
import type { SiteUrlResolver } from '../site/siteUrl.js';
import type { CachePort, RateLimiterPort } from '../cache/types.js';
import { phAt } from '../db/rows.js';
import type { TokenService } from '../auth/tokens.js';
import type {
  PluginBindingHandlers,
  PluginContext,
  PluginEndpointSpec,
  PluginEventName,
  PluginHandler,
  PluginManifest,
  PluginRouteOptions,
  PluginTokenRow,
} from './api.js';
import type { PluginEventBus } from './events.js';
import { PluginHookAuthenticator } from './hmac.js';

/**
 * 组装单个插件的 `PluginContext`（能力实现）。
 *
 * 这里刻意**不收集**注册的路由/hook，只登记意图，交给 loader 去建 Express Router：
 * 鉴权复用站点现成的 `requireAuth/requireAdmin/requireSuperAdmin`，而不是另写一套
 * token 解析 —— 两套解析逻辑迟早漂移，漂移的结果通常是「插件入口比核心入口松」。
 */

export interface CapabilityDeps {
  db: DatabaseConnection;
  settings: SettingRepository;
  secretBox?: SecretBox;
  siteUrlResolver: SiteUrlResolver;
  eventBus: PluginEventBus;
  tokenService: TokenService;
  cache?: CachePort;
  rateLimiter?: RateLimiterPort;
  now: () => Date;
}

export interface RegisteredRoute {
  kind: 'router' | 'hooks';
  options: PluginRouteOptions;
  handler: PluginHandler;
}

export interface PluginCapabilities {
  ctx: PluginContext;
  manifest: PluginManifest;
  registered: RegisteredRoute[];
  /** ctx.binding() 登记的处理函数；未登记时绑定页对该插件不可见 */
  bindingHandlers?: PluginBindingHandlers;
  /** 该插件订阅过的事件名（卸载时精确摘除） */
  subscribedEvents: PluginEventName[];
  authenticator: PluginHookAuthenticator;
  dispose: () => Promise<void>;
}

const SETTING_PREFIX = 'plugin.';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 令牌明文：4 字节随机 + 校验位，够短好手输（游戏内要打命令），也够长不可猜 */
function issuePlainToken(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function createCapabilities(deps: CapabilityDeps, manifest: PluginManifest): PluginCapabilities {
  const registered: RegisteredRoute[] = [];
  const subscribedEvents: PluginEventName[] = [];
  let bindingHandlers: PluginBindingHandlers | undefined;
  const authenticator = new PluginHookAuthenticator(deps.cache, deps.rateLimiter);
  const settingSpecs = new Map((manifest.settings ?? []).map((spec) => [spec.key, spec]));
  const declared = new Set(
    (manifest.endpoints ?? []).map((e) => `${e.kind} ${e.method} ${e.path}`),
  );
  const tokenTable = `plugin_${manifest.id}_tokens`;

  const prefixKey = (key: string): string => `${SETTING_PREFIX}${manifest.id}.${key}`;

  const ensureTokenTable = async (): Promise<void> => {
    // 一次性令牌表由框架代建：插件作者只要没被提醒，就会各自手搓一个漏了原子性的版本
    await deps.db.exec(
      `CREATE TABLE IF NOT EXISTS ${tokenTable} (
         id         TEXT PRIMARY KEY,
         subject    TEXT NOT NULL,
         token_hash TEXT NOT NULL UNIQUE,
         data       TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         created_at TEXT NOT NULL,
         used_at    TEXT
       )`,
    );
  };

  const ctx: PluginContext = {
    pluginId: manifest.id,

    table(name: string): string {
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) {
        throw new Error(`表名片段不合法：${name}（只允许小写字母、数字、下划线，且字母开头）`);
      }
      return `plugin_${manifest.id}_${name}`;
    },

    db: {
      dialect: deps.db.dialect,
      query: <T>(sql: string, params: unknown[] = []) => deps.db.query<T>(sql, params),
      run: (sql: string, params: unknown[] = []) => deps.db.run(sql, params),
      exec: (sql: string) => deps.db.exec(sql),
      transaction: <T>(fn: () => Promise<T>) => deps.db.transaction(fn),
    },

    settings: {
      async get<T>(key: string): Promise<T | undefined> {
        const raw = await deps.settings.get(prefixKey(key));
        if (raw === undefined || raw === null) return undefined;
        const spec = settingSpecs.get(key);
        if (spec?.type === 'secret') {
          // secret 型库里存的是密文；给插件明文，给面板只有 _SET
          return readSecret(deps.secretBox, raw) as T;
        }
        return raw as T;
      },
      async set(key: string, value: unknown): Promise<void> {
        const spec = settingSpecs.get(key);
        if (spec?.type === 'secret') {
          const text = typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value);
          await deps.settings.setMany(
            { [prefixKey(key)]: text === '' ? null : encryptSecret(deps.secretBox, text) },
            deps.now(),
          );
          return;
        }
        await deps.settings.setMany({ [prefixKey(key)]: value === undefined ? null : value }, deps.now());
      },
      async remove(key: string): Promise<void> {
        await deps.settings.setMany({ [prefixKey(key)]: null }, deps.now());
      },
      async getSecret(key: string): Promise<string | null> {
        const raw = await deps.settings.get(prefixKey(key));
        if (typeof raw !== 'string' || raw === '') return null;
        return readSecret(deps.secretBox, raw);
      },
    },

    tokens: {
      async issue({ subject, ttlMs, data }) {
        await ensureTokenTable();
        const plain = issuePlainToken();
        const now = deps.now();
        const expiresAt = new Date(now.getTime() + Math.min(Math.max(ttlMs, 1000), 3_600_000));
        await deps.db.run(
          `INSERT INTO ${tokenTable} (id, subject, token_hash, data, expires_at, created_at)
           VALUES (${phAt(deps.db.dialect, 0)}, ${phAt(deps.db.dialect, 1)}, ${phAt(deps.db.dialect, 2)}, ${phAt(deps.db.dialect, 3)}, ${phAt(deps.db.dialect, 4)}, ${phAt(deps.db.dialect, 5)})`,
          [
            randomUUID(),
            subject,
            sha256Hex(plain),
            JSON.stringify(data ?? {}),
            expiresAt.toISOString(),
            now.toISOString(),
          ],
        );
        return { token: plain, expiresAt: expiresAt.toISOString() };
      },

      async consume(token): Promise<PluginTokenRow | null> {
        if (typeof token !== 'string' || token.length === 0) return null;
        await ensureTokenTable();
        const now = deps.now().toISOString();
        // 判定全写进 WHERE + RETURNING：并发的第二条拿不到行，就不存在「同一枚用两次」
        const rows = await deps.db.query<Record<string, unknown>>(
          `DELETE FROM ${tokenTable}
           WHERE token_hash = ${phAt(deps.db.dialect, 0)}
             AND used_at IS NULL
             AND expires_at > ${phAt(deps.db.dialect, 1)}
           RETURNING id, subject, data, expires_at`,
          [sha256Hex(token.trim().toUpperCase()), now],
        );
        const row = rows[0];
        if (!row) return null;
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(String(row['data'] ?? '{}')) as Record<string, unknown>;
        } catch {
          data = {};
        }
        return {
          id: String(row['id']),
          subject: String(row['subject']),
          data,
          expiresAt: String(row['expires_at']),
        };
      },

      async purgeExpired(): Promise<number> {
        await ensureTokenTable();
        const before = deps.now().toISOString();
        const rows = await deps.db.query<{ n: number | string }>(
          `SELECT COUNT(*) AS n FROM ${tokenTable} WHERE expires_at <= ${phAt(deps.db.dialect, 0)}`,
          [before],
        );
        await deps.db.run(
          `DELETE FROM ${tokenTable} WHERE expires_at <= ${phAt(deps.db.dialect, 0)}`,
          [before],
        );
        return Number(rows[0]?.['n'] ?? 0);
      },
    },

    events: {
      on(name, handler) {
        if (!subscribedEvents.includes(name)) subscribedEvents.push(name);
        deps.eventBus.subscribe(name, (payload) => {
          // 总线本身已经逐回调 catch，这里不再包一层，避免错误被吞两次看不见
          return handler(payload as never);
        });
      },
    },

    site: {
      async siteTitle() {
        const value = await deps.settings.get('SITE_TITLE');
        return typeof value === 'string' && value.trim() !== '' ? value : 'Minecraft Skin Server';
      },
      async publicOrigin() {
        return deps.siteUrlResolver.originSync();
      },
    },

    logger: {
      info: (message, fields) => log('info', manifest.id, message, fields),
      warn: (message, fields) => log('warn', manifest.id, message, fields),
      error: (message, fields) => log('error', manifest.id, message, fields),
    },

    route(options, handler) {
      assertDeclared(declared, 'router', options, manifest.id);
      registered.push({ kind: 'router', options, handler });
    },

    hook(options, handler) {
      assertDeclared(declared, 'hooks', options, manifest.id);
      registered.push({ kind: 'hooks', options, handler });
    },

    binding(handlers) {
      // 与 endpoints 同一套「声明可核」：绑定页会把这个插件摆到玩家面前，
      // 超管必须能在按下启用之前从 manifest 看到这个意图。
      if (!manifest.binding) {
        throw new Error(
          `[plugin:${manifest.id}] 调用了 ctx.binding()，但 mcsts.plugin.json 没有声明 binding 字段。` +
            '请加上 { "binding": { "subject": "account" 或 "profile" } } —— 声明与实际行为一致是对超管的承诺。',
        );
      }
      if (bindingHandlers) {
        throw new Error(`[plugin:${manifest.id}] ctx.binding() 只能登记一次（重复登记会让绑定页不知道该用哪一份）`);
      }
      bindingHandlers = handlers;
    },
  };

  return {
    ctx,
    manifest,
    registered,
    // getter：登记发生在 setup 里，构造期读到的永远是 undefined
    get bindingHandlers() {
      return bindingHandlers;
    },
    subscribedEvents,
    authenticator,
    dispose: async () => {
      for (const name of subscribedEvents) deps.eventBus.unsubscribeAll([name]);
      subscribedEvents.length = 0;
      registered.length = 0;
      bindingHandlers = undefined;
    },
  };
}

function assertDeclared(
  declared: Set<string>,
  kind: PluginEndpointSpec['kind'],
  options: PluginRouteOptions,
  pluginId: string,
): void {
  const key = `${kind} ${options.method} ${options.path}`;
  if (!declared.has(key)) {
    throw new Error(
      `[plugin:${pluginId}] 注册了 manifest 里没声明的入口：${key}。` +
        '声明与实际行为一致是插件系统对超管的承诺，请把它写进 mcsts.plugin.json 的 endpoints。',
    );
  }
}

function encryptSecret(box: SecretBox | undefined, text: string): string {
  // 没有主密钥时按明文存：与 SMTP_PASS 完全同样的退化口径（功能可用优先，但会告警一次）
  return box ? box.encrypt(text) : text;
}

function readSecret(box: SecretBox | undefined, raw: unknown): string {
  const text = String(raw);
  if (!SecretBox.isEncrypted(text)) return text;
  if (!box) {
    throw new Error(
      '插件设置里有密文，但本站未配置主密钥（MCSTS_SECRET）：无法解密，请重存该密钥',
    );
  }
  return box.decrypt(text);
}

function log(
  level: 'info' | 'warn' | 'error',
  pluginId: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const tail = fields ? ` ${JSON.stringify(fields)}` : '';
  const line = `[plugin:${pluginId}] ${message}${tail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
