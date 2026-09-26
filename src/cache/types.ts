/**
 * 缓存与限流端口（P5，蓝图 §「Redis distributed rate limit/cache」）。
 *
 * 两个端口各有两种实现：
 * - Redis 实现：多进程/多实例共享（生产形态）
 * - 进程内存实现：**未配置 REDIS_URL 时的自动降级**，保证「可选依赖关闭时核心功能仍能运行」
 *
 * 选型说明：只做限流与缓存这类可丢失数据，因此不需要持久化、不需要 Redis 事务语义；
 * 端口刻意保持窄接口，避免业务层依赖具体客户端。
 */

/** 一次限流判定结果 */
export interface RateLimitResult {
  /** 是否放行 */
  allowed: boolean;
  /** 本窗口剩余可用次数（拒绝时为 0） */
  remaining: number;
  /** 本窗口的总上限，便于回写 X-RateLimit-Limit 类响应头 */
  limit: number;
  /**
   * 距本窗口重置的毫秒数。
   * 放行时用于提示「还要等多久」；拒绝时即为建议的重试等待时间。
   */
  resetAfterMs: number;
}

/**
 * 限流端口。语义为**固定窗口计数**（fixed window）：
 * 同一个 key 在 windowMs 内最多放行 limit 次，窗口到期后计数归零。
 *
 * 选固定窗口而非滑动窗口/令牌桶：认证端点的目的是防暴力破解与滥用，
 * 固定窗口实现简单、Redis 侧单条 Lua 即可原子完成，边界放行量最多翻倍是可接受代价。
 *
 * 错误契约：**允许抛错**。计数器不可用时调用方需要知情（以便记日志并按 fail-open 放行），
 * 因此这里不做静默吞异常——与 CachePort 的处理刻意相反。
 */
export interface RateLimiterPort {
  /**
   * 消费一次配额。
   * key 由调用方按业务维度拼装（如 `auth:hmcl@test.local`），端口不做命名空间处理。
   */
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;

  /** 清空某个 key 的计数（如登录成功后重置失败计数、测试收尾） */
  reset(key: string): Promise<void>;

  /** 释放连接（内存实现为空操作） */
  close(): Promise<void>;
}

/**
 * 带 TTL 的键值缓存端口；值为可 JSON 序列化的任意结构。
 *
 * 错误契约：**实现不得抛错**。缓存是非权威数据源，底层故障应降级为
 * 「读未命中 / 写丢弃」并记日志，而不是让业务请求失败。
 * （内存实现天然不抛；Redis 实现自行捕获，见 cache/redis.ts）
 */
export interface CachePort {
  /** 读取；不存在或已过期返回 undefined */
  get<T>(key: string): Promise<T | undefined>;

  /** 写入并设置存活时间 */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;

  /** 删除（幂等）；用于写操作后主动失效 */
  del(key: string): Promise<void>;

  close(): Promise<void>;
}

/** 缓存层装配结果 */
export interface CacheLayer {
  /** 'redis' = 使用了 Redis；'memory' = 降级为进程内存 */
  kind: 'redis' | 'memory';
  rateLimiter: RateLimiterPort;
  cache: CachePort;
  close(): Promise<void>;
}
