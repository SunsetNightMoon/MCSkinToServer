import type {
  CachePort,
  RateLimitResult,
  RateLimiterPort,
} from './types.js';

/**
 * 进程内存实现：未配置 REDIS_URL 时的自动降级路径。
 *
 * 已知局限（必须清楚，勿在高可用场景误用）：
 * - 多进程/多实例不共享计数 —— 每个进程各算各的，实际放行量是 limit × 进程数
 * - 进程重启即清空
 * 对单机开发与小规模部署够用；生产多实例必须配 REDIS_URL。
 */

/** 内存表的清理阈值：条目数超过它就顺带清理过期项，避免无界增长 */
const SWEEP_THRESHOLD = 1024;

interface WindowEntry {
  count: number;
  /** 本窗口结束时刻（epoch ms） */
  resetAt: number;
}

export class MemoryRateLimiter implements RateLimiterPort {
  private readonly windows = new Map<string, WindowEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    const now = this.now();
    let entry = this.windows.get(key);

    // 无记录或已过窗口 → 开新窗口
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, entry);
      this.sweepIfNeeded(now);
    }

    entry.count += 1;
    const allowed = entry.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - entry.count),
      limit,
      resetAfterMs: Math.max(0, entry.resetAt - now),
    };
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  async close(): Promise<void> {
    this.windows.clear();
  }

  /** 仅在体积超标时扫描，均摊成本可忽略 */
  private sweepIfNeeded(now: number): void {
    if (this.windows.size <= SWEEP_THRESHOLD) return;
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= now) this.windows.delete(key);
    }
  }
}

interface CacheEntry {
  value: unknown;
  /** 过期时刻（epoch ms） */
  expiresAt: number;
}

export class MemoryCache implements CachePort {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    this.sweepIfNeeded();
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  private sweepIfNeeded(): void {
    if (this.entries.size <= SWEEP_THRESHOLD) return;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
