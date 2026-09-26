import { createClient, type RedisClientType } from 'redis';
import type {
  CacheLayer,
  CachePort,
  RateLimitResult,
  RateLimiterPort,
} from './types.js';

/**
 * Redis 实现：多进程/多实例共享限流计数与缓存。
 *
 * 连接策略：
 * - 懒连接不可行——限流是请求路径上的同步前置检查，因此装配时即 PING 探活
 * - **初连必须是有界的**：node-redis 的缺省 reconnectStrategy 会无限重连，
 *   Redis 不可达时 `connect()` 永不 settle，启动会永久卡住（不是报错退出，是安静地挂着）。
 *   这在容器/PM2 下表现为「进程活着但不监听端口」，极难排查，故显式设上限。
 * - 探活失败由上层捕获并降级为内存实现（见 index.ts），本文件只负责如实报错
 */

/** 初连重试上限（不含首次尝试）；超过即让 connect() 失败，交给上层降级 */
const CONNECT_RETRIES = 2;
/** 单次握手超时；对「SYN 被丢弃」型故障（防火墙）也有效 */
const CONNECT_TIMEOUT_MS = 2000;
const RECONNECT_BASE_DELAY_MS = 200;
/** 错误日志节流窗口：重连期间 'error' 会高频触发，不节流会刷满 PM2 日志 */
const ERROR_LOG_THROTTLE_MS = 5000;

/**
 * 固定窗口计数的原子实现。
 *
 * 必须用 Lua：`INCR` 与 `PEXPIRE` 分两条命令发会出现两种坏情况——
 *  1. INCR 之后进程崩溃 → key 永不过期，该 key 被**永久锁定**
 *  2. 并发下两个请求同时看到 1，重复设置过期时间（无害但浪费）
 * Redis 单线程执行脚本，整段天然原子。
 *
 * KEYS[1] = 计数键；ARGV[1] = 窗口毫秒数；返回 {当前计数, 剩余TTL毫秒}
 */
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

type AnyRedisClient = RedisClientType<Record<string, never>, Record<string, never>, Record<string, never>>;

export interface ConnectRedisOptions {
  /** 错误日志出口；缺省 console.error。内部已按 5s 节流（便于测试静音） */
  onError?: (message: string) => void;
}

/** 创建并探活一个 Redis 连接；失败时抛出便于上层降级 */
export async function connectRedis(
  url: string,
  options: ConnectRedisOptions = {},
): Promise<AnyRedisClient> {
  const onError = options.onError ?? ((message: string) => console.error(message));
  const client = createClient({
    url,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      // 有界重连：初连阶段失败几次即放弃（否则 connect() 永不 settle，启动卡死）；
      // 连上之后偶发断线仍可自愈，超出上限则断开并由上层 fail-open 兜住。
      reconnectStrategy: (retries) =>
        retries > CONNECT_RETRIES
          ? false
          : Math.min((retries + 1) * RECONNECT_BASE_DELAY_MS, 1000),
    },
  });

  // 必须挂 error 监听：EventEmitter 上未处理的 'error' 会直接终止进程
  let lastLoggedAt = 0;
  let suppressed = 0;
  client.on('error', (err: unknown) => {
    const now = Date.now();
    if (now - lastLoggedAt < ERROR_LOG_THROTTLE_MS) {
      suppressed += 1;
      return;
    }
    const tail =
      suppressed > 0 ? `（另有 ${suppressed} 条同类错误已抑制）` : '';
    lastLoggedAt = now;
    suppressed = 0;
    onError(
      `[cache] redis error: ${err instanceof Error ? err.message : String(err)}${tail}`,
    );
  });

  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    // 连接未建立时 quit() 无效；必须 destroy() 清掉残留的重连定时器，
    // 否则即使上层已降级，挂着的定时器仍会拖住进程退出。
    try {
      await client.destroy();
    } catch {
      /* 已关闭 */
    }
    throw err;
  }
  return client as AnyRedisClient;
}


export class RedisRateLimiter implements RateLimiterPort {
  private closed = false;

  constructor(private readonly client: AnyRedisClient) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    const raw = (await this.client.eval(FIXED_WINDOW_SCRIPT, {
      keys: [key],
      arguments: [String(windowMs)],
    })) as unknown;

    const [countRaw, ttlRaw] = Array.isArray(raw) ? raw : [raw, windowMs];
    const count = Number(countRaw);
    // PTTL 对无过期键返回 -1、键不存在返回 -2：都退化为「一个完整窗口」
    const ttl = Number(ttlRaw);
    const resetAfterMs = Number.isFinite(ttl) && ttl > 0 ? ttl : windowMs;

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      resetAfterMs,
    };
  }

  async reset(key: string): Promise<void> {
    await this.client.del(key);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.quit().catch(() => undefined);
  }
}

/**
 * 缓存适配器。
 *
 * **不向调用方抛错**：缓存是非权威数据源，Redis 中途断开时读不到就当未命中、
 * 写不进就放弃失效——而不是让 /api/settings/public 这类读接口 500。
 * 这与 RateLimiterPort 刻意不同：限流的失败判定（放行或拒绝）必须让调用方知情，
 * 所以那边如实抛错，由中间件统一记日志后放行（fail-open）。
 */
export class RedisCache implements CachePort {
  private lastErrorAt = 0;
  private suppressedErrors = 0;

  /**
   * 由限流器持有同一个 client，故这里不重复关闭连接。
   * @param onError 错误出口；缺省 console.error
   */
  constructor(
    private readonly client: AnyRedisClient,
    private readonly onError: (message: string) => void = (m) => console.error(m),
  ) {}

  private warn(op: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorAt < ERROR_LOG_THROTTLE_MS) {
      this.suppressedErrors += 1;
      return;
    }
    const tail =
      this.suppressedErrors > 0
        ? `（另有 ${this.suppressedErrors} 条同类错误已抑制）`
        : '';
    this.lastErrorAt = now;
    this.suppressedErrors = 0;
    this.onError(
      `[cache] ${op}失败，已按未命中处理：${
        err instanceof Error ? err.message : String(err)
      }${tail}`,
    );
  }

  async get<T>(key: string): Promise<T | undefined> {
    let raw: string | null;
    try {
      raw = await this.client.get(key);
    } catch (err) {
      this.warn('读取', err);
      return undefined;
    }
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), {
        expiration: { type: 'PX', value: Math.max(1, Math.floor(ttlMs)) },
      });
    } catch (err) {
      this.warn('写入', err);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      this.warn('删除', err);
    }
  }

  async close(): Promise<void> {
    // 与限流器共用连接，关闭由 RedisRateLimiter 统一负责
  }
}

/** 用已探活的连接装配整个 Redis 缓存层 */
export function createRedisCacheLayer(
  client: AnyRedisClient,
  onError?: (message: string) => void,
): CacheLayer {
  const rateLimiter = new RedisRateLimiter(client);
  const cache = new RedisCache(client, onError);
  return {
    kind: 'redis',
    rateLimiter,
    cache,
    async close() {
      await rateLimiter.close();
    },
  };
}
