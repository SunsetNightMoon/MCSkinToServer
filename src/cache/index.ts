import { MemoryCache, MemoryRateLimiter } from './memory.js';
import { connectRedis, createRedisCacheLayer } from './redis.js';
import type { CacheLayer } from './types.js';

export * from './types.js';
export { KEY_PREFIX, RateLimitKeys, CacheKeys } from './keys.js';
export { MemoryCache, MemoryRateLimiter } from './memory.js';
export { RedisCache, RedisRateLimiter, connectRedis, createRedisCacheLayer } from './redis.js';

export interface CacheLayerOptions {
  /** 未设置时直接使用内存实现 */
  redisUrl?: string;
  /** 时钟可注入（测试内存实现的窗口行为） */
  now?: () => number;
  /** 一般信息日志出口；缺省 console.log */
  log?: (message: string) => void;
  /** 错误日志出口；缺省 console.error */
  onError?: (message: string) => void;
}

/** 纯内存层（不尝试连接 Redis） */
export function createMemoryCacheLayer(now?: () => number): CacheLayer {
  const rateLimiter = new MemoryRateLimiter(now);
  const cache = new MemoryCache(now);
  return {
    kind: 'memory',
    rateLimiter,
    cache,
    async close() {
      await rateLimiter.close();
      await cache.close();
    },
  };
}

/**
 * 装配缓存层：有 REDIS_URL 就走 Redis，否则降级为进程内存。
 *
 * 降级策略（对应 P5 验收「每个可选依赖关闭时核心功能仍能运行」）：
 * - **未配置** REDIS_URL → 内存实现，属正常配置，只记一条 info
 * - **配置了但连不上** → 记 warning 后仍用内存实现，**进程照常启动**
 *   取舍：可用性优先。生产多实例下这意味着限流退化为「每实例各限一份」，
 *   日志里的 warning 是唯一提示，因此用 WARN 级别并打出 URL。
 */
export async function createCacheLayer(
  options: CacheLayerOptions = {},
): Promise<CacheLayer> {
  const log = options.log ?? ((message: string) => console.log(message));
  const redisUrl = options.redisUrl?.trim();

  if (!redisUrl) {
    log('[cache] REDIS_URL 未设置，限流与缓存使用进程内存实现（多实例不共享计数）');
    return createMemoryCacheLayer(options.now);
  }

  try {
    const client = await connectRedis(redisUrl, { onError: options.onError });
    log(`[cache] 已连接 Redis：${redisUrl}`);
    return createRedisCacheLayer(client, options.onError);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    (options.onError ?? console.warn)(
      `[cache] 连接 Redis 失败（${redisUrl}）：${reason}；` +
        '已降级为进程内存实现，限流在多实例下不共享计数',
    );
    return createMemoryCacheLayer(options.now);
  }
}
