import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import express, { type Express } from 'express';

import { MemoryCache, MemoryRateLimiter } from '../src/cache/memory.js';
import { createCacheLayer, createMemoryCacheLayer } from '../src/cache/index.js';
import { RedisCache, createRedisCacheLayer, connectRedis } from '../src/cache/redis.js';
import { CacheKeys, KEY_PREFIX, RateLimitKeys } from '../src/cache/keys.js';
import type { CachePort, RateLimiterPort } from '../src/cache/types.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import { runMigrations } from '../src/migrate/runner.js';
import { SettingRepository } from '../src/repositories/settingRepository.js';
import { createIdentityRouter } from '../src/server/routes/identity.js';
import { createYggdrasilRouter } from '../src/server/routes/yggdrasil.js';
import { createCaptchaRouter } from '../src/server/routes/captcha.js';
import { bodyKey, clientIp, rateLimit } from '../src/server/rateLimit.js';
import { errorHandler } from '../src/server/errorHandler.js';
import { AppError } from '../src/errors.js';
import {
  DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT,
  DEFAULT_RATE_LIMIT,
  DEFAULT_REFRESH_RATE_LIMIT,
  DEFAULT_SETTINGS_CACHE_TTL_MS,
  resolveCaptchaGenerateRateLimit,
  type AppConfig,
  type RateLimitSettings,
} from '../src/config.js';
import type { DatabaseConnection } from '../src/types.js';
import type { IdentityService } from '../src/auth/identity.js';
import type { TokenService } from '../src/auth/tokens.js';

/**
 * P5 缓存/限流（Redis + 内存降级）。
 *
 * 本文件的重点不是「功能能跑」，而是三条容易被写错、写错了又很难发现的契约：
 *
 *  1. **可选依赖关闭时核心功能仍能运行**（P5 验收条件）。
 *     这里落成可执行的回归测试：Redis 不可达时必须**在有界时间内**降级为内存实现，
 *     而不是无限重连把启动挂住 —— 后者表现为「进程活着但不监听端口」，极难排查。
 *  2. **限流的错误契约是 fail-open**：计数器故障时放行，不是把认证整体打挂。
 *  3. **缓存的错误契约是不抛错**：Redis 中途断开时按未命中处理，不让读接口 500。
 *
 * Redis 实现本身由 `TEST_REDIS_URL`（或 `REDIS_URL`）门控，未设置则 skip，
 * 与 `TEST_DATABASE_URL` 门控 PostgreSQL 用例的做法一致。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_REDIS_URL =
  process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL'];

// ---------------------------------------------------------------- 工具

/** 可控时钟：内存实现的时间推进不靠 sleep */
function fakeClock(start = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** 借一个真实的空闲端口再立刻释放 —— 用于构造「确定连不上」的 Redis 地址 */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 记录调用次数的缓存，用于证明「读路径真的命中了缓存」 */
class SpyCache implements CachePort {
  readonly store = new Map<string, unknown>();
  gets = 0;
  sets = 0;
  dels = 0;

  async get<T>(key: string): Promise<T | undefined> {
    this.gets += 1;
    return this.store.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.sets += 1;
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.dels += 1;
    this.store.delete(key);
  }

  async close(): Promise<void> {
    /* noop */
  }
}

/** 临时接管 console.warn，返回捕获到的行（fail-open 会打日志，避免污染测试输出） */
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  return { lines, restore: () => (console.warn = original) };
}

async function listen(app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------- 内存限流器

test('内存限流：固定窗口内放行 limit 次，超出拒绝且 remaining 归零', async () => {
  const clock = fakeClock();
  const limiter = new MemoryRateLimiter(clock.now);

  const first = await limiter.consume('k', 3, 1000);
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 2);
  assert.equal(first.limit, 3);

  const second = await limiter.consume('k', 3, 1000);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 1);

  const third = await limiter.consume('k', 3, 1000);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  const fourth = await limiter.consume('k', 3, 1000);
  assert.equal(fourth.allowed, false, '第 4 次必须拒绝');
  assert.equal(fourth.remaining, 0, '拒绝时不得出现负数');

  await limiter.close();
});

test('内存限流：窗口到期后计数归零，resetAfterMs 随窗口推进递减', async () => {
  const clock = fakeClock();
  const limiter = new MemoryRateLimiter(clock.now);

  await limiter.consume('k', 1, 1000);
  const blocked = await limiter.consume('k', 1, 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.resetAfterMs, 1000);

  clock.advance(400);
  const stillBlocked = await limiter.consume('k', 1, 1000);
  assert.equal(stillBlocked.allowed, false);
  assert.equal(stillBlocked.resetAfterMs, 600, '剩余窗口应随时间缩短');

  clock.advance(600); // 恰好到达窗口边界
  const renewed = await limiter.consume('k', 1, 1000);
  assert.equal(renewed.allowed, true, '窗口到期即重开，边界时刻应放行');
  assert.equal(renewed.remaining, 0);

  await limiter.close();
});

test('内存限流：不同 key 互不影响；reset 立即清空计数', async () => {
  const clock = fakeClock();
  const limiter = new MemoryRateLimiter(clock.now);

  await limiter.consume('a', 1, 1000);
  const other = await limiter.consume('b', 1, 1000);
  assert.equal(other.allowed, true, 'a 用满不该影响 b');

  await limiter.reset('a');
  const afterReset = await limiter.consume('a', 1, 1000);
  assert.equal(afterReset.allowed, true, 'reset 后应重新可放行');

  await limiter.close();
});

// ---------------------------------------------------------------- 内存缓存

test('内存缓存：写入/读取/删除与 TTL 过期', async () => {
  const clock = fakeClock();
  const cache = new MemoryCache(clock.now);

  assert.equal(await cache.get('missing'), undefined);

  await cache.set('k', { n: 1 }, 500);
  assert.deepEqual(await cache.get('k'), { n: 1 });

  clock.advance(499);
  assert.deepEqual(await cache.get('k'), { n: 1 }, '未到期必须仍在');

  clock.advance(1); // 恰好到期（expiresAt <= now）
  assert.equal(await cache.get('k'), undefined, '到期即视为未命中');

  await cache.set('k2', 'v', 1000);
  await cache.del('k2');
  assert.equal(await cache.get('k2'), undefined);

  // 删除不存在的键是幂等的
  await cache.del('k2');

  await cache.close();
});

test('内存缓存：假值（0 / false / 空串 / null）不得被当成未命中', async () => {
  // 这条针对的是最常见的一类缓存 bug：读路径写成 `if (cached)` 而不是
  // `if (cached !== undefined)`，于是缓存了 0 / false / '' 的键每一轮都穿透到数据库。
  // 设置项里 LIGHT_BG_OVERLAY_OPACITY=0、VIDEO_MUTED=false 都是合法值，必然踩到。
  const clock = fakeClock();
  const cache = new MemoryCache(clock.now);

  const values = [0, false, '', null] as const;
  for (let i = 0; i < values.length; i += 1) {
    await cache.set(`k${i}`, values[i], 1000);
    assert.strictEqual(
      await cache.get(`k${i}`),
      values[i],
      `假值 ${JSON.stringify(values[i])} 必须原样返回，而不是 undefined`,
    );
  }

  await cache.close();
});

// ---------------------------------------------------------------- 限流中间件

test('限流中间件：超限返回 429 + Retry-After + retryAfterSeconds', async () => {
  const limiter = new MemoryRateLimiter();
  const app = express();
  app.use(express.json());
  app.use(
    rateLimit({ limiter, settings: { enabled: true, max: 2, windowMs: 60_000 }, keyOf: () => 'fixed' }),
  );
  app.use((_req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  const server = await listen(app);

  try {
    const first = await fetch(`${server.baseUrl}/`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-ratelimit-limit'), '2');
    assert.equal(first.headers.get('x-ratelimit-remaining'), '1');

    const second = await fetch(`${server.baseUrl}/`);
    assert.equal(second.status, 200);

    const third = await fetch(`${server.baseUrl}/`);
    assert.equal(third.status, 429);
    const retryAfter = Number(third.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After 应为 1-60 秒，实得 ${retryAfter}`);
    assert.equal(third.headers.get('x-ratelimit-remaining'), '0');

    const body = (await third.json()) as Record<string, unknown>;
    assert.equal(body['error'], 'TOO_MANY_REQUESTS');
    assert.equal(typeof body['message'], 'string');
    // 旧版前端按 errorMessage 取文案，该字段必须有且同值
    assert.equal(body['errorMessage'], body['message']);
    assert.equal(body['retryAfterSeconds'], retryAfter);
  } finally {
    await server.close();
    await limiter.close();
  }
});

test('限流中间件：enabled=false 时完全放行（排障开关）', async () => {
  const limiter = new MemoryRateLimiter();
  const app = express();
  app.use(rateLimit({ limiter, settings: { enabled: false, max: 1, windowMs: 60_000 }, keyOf: () => 'k' }));
  app.use((_req, res) => res.status(200).json({ ok: true }));
  const server = await listen(app);

  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${server.baseUrl}/`);
      assert.equal(res.status, 200, `第 ${i + 1} 次不该被限流`);
    }
  } finally {
    await server.close();
    await limiter.close();
  }
});

test('限流中间件：keyOf 返回 null 时跳过，不消耗配额', async () => {
  const limiter = new MemoryRateLimiter();
  const app = express();
  app.use(express.json());
  // 模拟「请求体缺 email」的畸形请求：应交由参数校验报 400，不占用限流配额
  app.use(
    rateLimit({
      limiter,
      settings: { enabled: true, max: 1, windowMs: 60_000 },
      keyOf: bodyKey('email', (v) => `e:${v}`),
    }),
  );
  app.use((_req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  const server = await listen(app);

  try {
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${server.baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200, '缺字段的请求应被跳过限流');
    }

    // 带字段的请求才计数
    const counted = await fetch(`${server.baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    assert.equal(counted.status, 200);
    const overLimit = await fetch(`${server.baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    assert.equal(overLimit.status, 429, '同一 email 第 2 次应被拒');
  } finally {
    await server.close();
    await limiter.close();
  }
});

test('限流中间件：计数器故障时 fail-open 放行并记 warning', async () => {
  const broken = {
    consume: async () => {
      throw new Error('redis 断开了');
    },
    reset: async () => undefined,
    close: async () => undefined,
  };
  const app = express();
  app.use(rateLimit({ limiter: broken, settings: { enabled: true, max: 1, windowMs: 1000 }, keyOf: () => 'k' }));
  app.use((_req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  const server = await listen(app);

  const warned = captureWarn();
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${server.baseUrl}/`);
      assert.equal(res.status, 200, '限流器报错必须放行，不能把认证打挂');
    }
  } finally {
    warned.restore();
    await server.close();
  }

  assert.ok(
    warned.lines.some((line) => line.includes('计数器不可用')),
    `应记录 fail-open 日志，实得：${JSON.stringify(warned.lines)}`,
  );
});

test('限流键：clientIp 优先取 req.ip，缺失时退化为 unknown', () => {
  assert.equal(clientIp({ ip: '203.0.113.7' } as never), '203.0.113.7');
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.5' } } as never), '10.0.0.5');
  assert.equal(clientIp({ socket: {} } as never), 'unknown');
});

// ---------------------------------------------------------------- 路由接线

/**
 * 用桩件装配真实路由：验证「限流器注入与否」决定路由是否挂限流，
 * 这正是让既有测试（大量重复登录调用）无需改动的原因。
 */
function loginApp(rateLimiter?: RateLimiterPort, max = 3): Express {
  const identity = {
    loginWeb: async () => {
      throw new AppError('INVALID_CREDENTIALS', '邮箱或密码不正确');
    },
  } as unknown as IdentityService;

  const app = express();
  app.use(express.json());
  app.use(
    createIdentityRouter({
      identity,
      tokenService: {} as unknown as TokenService,
      rateLimiter,
      rateLimit: { enabled: true, max, windowMs: 60_000 },
    }),
  );
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use(errorHandler);
  return app;
}

test('POST /api/auth/login：注入限流器后按邮箱计数，第 4 次 429', async () => {
  const limiter = new MemoryRateLimiter();
  const server = await listen(loginApp(limiter));

  try {
    const attempt = (): Promise<Response> =>
      fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'rl@test.local', password: 'wrong-password' }),
      });

    for (let i = 1; i <= 3; i += 1) {
      const res = await attempt();
      assert.equal(res.status, 401, `第 ${i} 次应为凭据错误`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['errorMessage'], '邮箱或密码不正确');
    }

    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    const body = (await blocked.json()) as Record<string, unknown>;
    assert.equal(body['error'], 'TOO_MANY_REQUESTS');
    assert.match(String(body['message']), /登录尝试过于频繁/);
    assert.ok(Number(body['retryAfterSeconds']) >= 1);

    // 另一个邮箱有自己的窗口，不该被上面的计数牵连
    const otherEmail = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'someone-else@test.local', password: 'wrong-password' }),
    });
    assert.equal(otherEmail.status, 401, '限流键必须按邮箱隔离');
  } finally {
    await server.close();
    await limiter.close();
  }
});

test('POST /api/auth/login：未注入限流器时行为与加限流前完全一致', async () => {
  const server = await listen(loginApp(undefined, 1));

  try {
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'rl@test.local', password: 'wrong-password' }),
      });
      assert.equal(res.status, 401, '未注入限流器时不得出现 429');
    }
  } finally {
    await server.close();
  }
});

// ------------------------------------------------- refresh 限流（按来源地址）

/**
 * `POST /refresh` 的限流键必须取**来源地址**，刻意不按用户名。
 *
 * 为什么值得专门写测试：启动器（HMCL 等）会在 accessToken 临近过期时自动
 * 定期刷新。若按账号计数，一次正常挂机就会把配额耗光，表现为「挂机一阵后
 * 启动器突然掉线，重新登录又好」，日志里只有一串 429 —— 事后极难归因。
 * 所以这里的断言不是「有没有 429」，而是「键长什么样、换 token 会不会重置」。
 */
function refreshApp(
  rateLimiter?: RateLimiterPort,
  refreshRateLimit?: RateLimitSettings,
): Express {
  const identity = {
    refreshYggdrasil: async (input: { accessToken: string; clientToken: string }) => ({
      accessToken: 'refreshed-access-token',
      clientToken: input.clientToken,
    }),
  } as unknown as IdentityService;

  const app = express();
  app.use(express.json());
  app.use(
    createYggdrasilRouter({
      identity,
      sessions: {} as never,
      profiles: {} as never,
      textureBuilder: {} as never,
      assetUrlResolver: {} as never,
      rateLimiter,
      refreshRateLimit,
    }),
  );
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use(errorHandler);
  return app;
}

/** 记录每次 consume 用到的键，便于断言「键取的是什么」 */
class RecordingRateLimiter implements RateLimiterPort {
  readonly keys: string[] = [];
  private readonly inner = new MemoryRateLimiter();

  async consume(key: string, limit: number, windowMs: number) {
    this.keys.push(key);
    return this.inner.consume(key, limit, windowMs);
  }

  async reset(key: string): Promise<void> {
    await this.inner.reset(key);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

function refreshCall(baseUrl: string, accessToken: string): Promise<Response> {
  return fetch(`${baseUrl}/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken, clientToken: 'launcher-client-token' }),
  });
}

test('POST /refresh：第 N+1 次返回 429，且限流键是来源地址而非账号', async () => {
  const limiter = new RecordingRateLimiter();
  const server = await listen(
    refreshApp(limiter, { enabled: true, max: 3, windowMs: 60_000 }),
  );

  try {
    for (let i = 1; i <= 3; i += 1) {
      const res = await refreshCall(server.baseUrl, `access-token-${i}`);
      assert.equal(res.status, 200, `第 ${i} 次应放行，实得 ${res.status}`);
    }

    // 关键：四次请求用的是**四个不同的 accessToken**，仍被同一窗口拦住
    const blocked = await refreshCall(server.baseUrl, 'access-token-4');
    assert.equal(blocked.status, 429, '同一来源地址的刷新必须共用配额');
    const body = (await blocked.json()) as Record<string, unknown>;
    assert.equal(body['error'], 'TOO_MANY_REQUESTS');
    assert.ok(Number(body['retryAfterSeconds']) >= 1);
    assert.ok(blocked.headers.get('retry-after'));

    // 键形如 `mscts:rl:yggrefresh:<ip>`，且与 token 无关
    assert.equal(limiter.keys.length, 4);
    for (const key of limiter.keys) {
      assert.equal(key, limiter.keys[0], `限流键不得随 accessToken 变化：${key}`);
      assert.match(key, /^mscts:rl:yggrefresh:/);
    }
    assert.match(limiter.keys[0]!, /^mscts:rl:yggrefresh:127\.0\.0\.1$/);

    // 另一个 IP 的窗口是独立的（这里直接用同一限流器验证隔离性）
    const other = await limiter.consume(RateLimitKeys.yggdrasilRefresh('203.0.113.9'), 3, 60_000);
    assert.equal(other.allowed, true, '不同来源地址不应共享配额');
  } finally {
    await server.close();
    await limiter.close();
  }
});

test('POST /refresh：未注入限流器时行为与加限流前完全一致', async () => {
  const server = await listen(refreshApp(undefined, { enabled: true, max: 1, windowMs: 60_000 }));

  try {
    for (let i = 0; i < 8; i += 1) {
      const res = await refreshCall(server.baseUrl, `access-token-${i}`);
      assert.equal(res.status, 200, '未注入限流器时不得出现 429');
    }
  } finally {
    await server.close();
  }
});

test('POST /refresh：默认参数为 30 次 / 5 分钟（给启动器后台刷新留余量）', () => {
  assert.equal(DEFAULT_REFRESH_RATE_LIMIT.enabled, true);
  assert.equal(DEFAULT_REFRESH_RATE_LIMIT.max, 30);
  assert.equal(DEFAULT_REFRESH_RATE_LIMIT.windowMs, 5 * 60 * 1000);
});

// ------------------------------------------- 验证码出题端点限流（按来源地址）

/**
 * `GET /api/captcha/generate` 必须有**自己的一套**限流参数。
 *
 * 回归的是实测踩到的一个坑：它原先复用认证端点的 5 次/5 分钟，结果正常用户
 * 「进页面取一题 → 答错点换一道 → 严格模式下挂载重复一次」就能打满；打满后
 * 前端因为不检查 response.ok，把 429 当成成功解析，题干渲染成空白输入框 ——
 * 用户填不出、看不到任何提示，注册整条路被堵死。
 */
function captchaApp(rateLimiter?: RateLimiterPort, generateRateLimit?: RateLimitSettings): Express {
  const captcha = {
    generate: async (sessionId: string) => ({
      sessionId,
      question: '3 + 4 = ?',
      expiresInSeconds: 600,
    }),
  };

  const app = express();
  app.use(express.json());
  app.use(createCaptchaRouter({ captcha: captcha as never, rateLimiter, generateRateLimit }));
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use(errorHandler);
  return app;
}

test('GET /api/captcha/generate：第 N+1 次返回 429，限流键按来源地址', async () => {
  const limiter = new RecordingRateLimiter();
  const server = await listen(captchaApp(limiter, { enabled: true, max: 2, windowMs: 60_000 }));

  try {
    for (let i = 1; i <= 2; i += 1) {
      const res = await fetch(`${server.baseUrl}/api/captcha/generate?sessionId=s${i}`);
      assert.equal(res.status, 200, `第 ${i} 次应放行，实得 ${res.status}`);
    }
    const blocked = await fetch(`${server.baseUrl}/api/captcha/generate?sessionId=s3`);
    assert.equal(blocked.status, 429);
    const body = (await blocked.json()) as Record<string, unknown>;
    assert.equal(body['error'], 'TOO_MANY_REQUESTS');
    assert.match(String(body['message']), /验证码请求过于频繁/);

    // 键形如 `mscts:rl:captcha:<ip>`，与 sessionId 无关
    assert.equal(limiter.keys.length, 3);
    for (const key of limiter.keys) {
      assert.equal(key, limiter.keys[0], `限流键不得随 sessionId 变化：${key}`);
      assert.match(key, /^mscts:rl:captcha:127\.0\.0\.1$/);
    }
  } finally {
    await server.close();
    await limiter.close();
  }
});

test('GET /api/captcha/generate：未注入限流器时行为与加限流前完全一致', async () => {
  const server = await listen(captchaApp(undefined, { enabled: true, max: 1, windowMs: 60_000 }));

  try {
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${server.baseUrl}/api/captcha/generate?sessionId=s${i}`);
      assert.equal(res.status, 200, '未注入限流器时不得出现 429');
    }
  } finally {
    await server.close();
  }
});

test('验证码出题限流默认参数为 10 次 / 5 分钟，且与认证端点分开', () => {
  assert.equal(DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.enabled, true);
  assert.equal(DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.max, 10);
  assert.equal(DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.windowMs, 5 * 60 * 1000);
  assert.notEqual(
    DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.max,
    DEFAULT_RATE_LIMIT.max,
    '必须比认证端点的 5 次宽松，否则正常用户几步就撞上限',
  );
});

test('出题限流解析：总开关关闭时一并关掉，避免「关了限流但验证码还在挡」', () => {
  const base = {
    dialect: 'sqlite',
    sqlitePath: ':memory:',
    migrationsRoot: '.',
    uploadDir: '.',
    publicBaseUrl: 'http://localhost/uploads',
    rsaPrivateKeyPath: './k.pem',
    skinDomains: [],
  } as unknown as AppConfig;

  assert.equal(resolveCaptchaGenerateRateLimit(base).max, 10);
  assert.equal(resolveCaptchaGenerateRateLimit(base).enabled, true);

  const disabled = { ...base, rateLimit: { enabled: false } } as unknown as AppConfig;
  assert.equal(resolveCaptchaGenerateRateLimit(disabled).enabled, false);

  const custom = {
    ...base,
    captchaGenerateRateLimit: { max: 50, windowMs: 60_000 },
  } as unknown as AppConfig;
  assert.equal(resolveCaptchaGenerateRateLimit(custom).max, 50);
  assert.equal(resolveCaptchaGenerateRateLimit(custom).windowMs, 60_000);
});

// ---------------------------------------------------------------- 设置缓存

test('SettingRepository：公开设置读穿透缓存，写路径主动失效', async () => {
  const db = new SqliteConnection(':memory:');
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  const spy = new SpyCache();
  const repo = new SettingRepository(db, spy, DEFAULT_SETTINGS_CACHE_TTL_MS);

  await repo.setMany(
    { SITE_TITLE: 'v1', LIGHT_BG_OVERLAY_OPACITY: 0.42, VIDEO_MUTED: true, PRIVATE_JUNK: 'x' },
    new Date(),
  );
  assert.ok(spy.dels >= 1, '写入后必须失效公开缓存');

  const first = await repo.getPublic();
  assert.equal(spy.sets, 1, '首次读取应回填缓存');
  assert.equal(first['SITE_TITLE'], 'v1');
  assert.equal(first['LIGHT_BG_OVERLAY_OPACITY'], 0.42, '数字必须保持数字类型');
  assert.equal(first['VIDEO_MUTED'], true, '布尔必须保持布尔类型');
  assert.equal(first['PRIVATE_JUNK'], undefined, '不在白名单的键不得经公开端点泄露');

  // 绕过仓储层直接改库：若读路径真的走缓存，此时仍应看到 v1
  await db.run('UPDATE system_settings SET value = ? WHERE key = ?', [
    JSON.stringify('v2'),
    'SITE_TITLE',
  ]);

  const cached = await repo.getPublic();
  assert.equal(cached['SITE_TITLE'], 'v1', '第二次读取应命中缓存，看不到绕过写路径的改动');
  assert.equal(spy.gets, 2, '两次读取都应问过缓存');

  // 管理端 getAll 不缓存：必须看到刚写入的值
  const adminView = await repo.getAll();
  assert.equal(adminView['SITE_TITLE'], 'v2', '管理端列表不得走缓存');

  // 走仓储写路径后缓存失效，读到新值
  await repo.setMany({ SITE_TITLE: 'v3' }, new Date());
  const afterWrite = await repo.getPublic();
  assert.equal(afterWrite['SITE_TITLE'], 'v3', '写入后必须立即读到新值');
  assert.equal(spy.sets, 2, '失效后再读应重新回填');

  await db.close();
});

test('SettingRepository：未注入缓存时行为与引入缓存前一致', async () => {
  const db = new SqliteConnection(':memory:');
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  const repo = new SettingRepository(db);
  await repo.setMany({ SITE_TITLE: 'no-cache' }, new Date());
  assert.deepEqual(await repo.getPublic(), { SITE_TITLE: 'no-cache' });

  // 直连数据库：绕过写路径的改动立即可见
  await db.run('UPDATE system_settings SET value = ? WHERE key = ?', [
    JSON.stringify('changed'),
    'SITE_TITLE',
  ]);
  assert.equal((await repo.getPublic())['SITE_TITLE'], 'changed');

  await db.close();
});

// ---------------------------------------------------------------- 缓存端口错误契约

test('RedisCache：底层连接故障时不抛错，按未命中处理', async () => {
  const boom = (): never => {
    throw new Error('connection lost');
  };
  const brokenClient = {
    get: async () => boom(),
    set: async () => boom(),
    del: async () => boom(),
  } as unknown as ConstructorParameters<typeof RedisCache>[0];

  const errors: string[] = [];
  const cache = new RedisCache(brokenClient, (message) => errors.push(message));

  assert.equal(await cache.get('k'), undefined, '读失败应退化为未命中');
  await cache.set('k', { a: 1 }, 1000); // 不得抛出
  await cache.del('k'); // 不得抛出

  assert.ok(errors.length > 0, '必须记日志，不能静默吞掉');
  assert.match(errors[0]!, /按未命中处理/);
});

// ---------------------------------------------------------------- 装配与降级

test('装配：未设置 REDIS_URL 时直接使用内存实现', async () => {
  const logs: string[] = [];
  const layer = await createCacheLayer({ log: (m) => logs.push(m) });

  assert.equal(layer.kind, 'memory');
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /REDIS_URL 未设置/);

  await layer.close();
});

test('装配：REDIS_URL 不可达时在有界时间内降级为内存（回归：曾无限重连卡死启动）', async () => {
  const port = await closedPort();
  const errors: string[] = [];
  const logs: string[] = [];

  const startedAt = Date.now();
  const layer = await createCacheLayer({
    redisUrl: `redis://127.0.0.1:${port}`,
    log: (m) => logs.push(m),
    onError: (m) => errors.push(m),
  });
  const elapsed = Date.now() - startedAt;

  try {
    assert.equal(layer.kind, 'memory', '连不上必须降级为内存，而不是让启动失败或挂住');
    assert.ok(elapsed < 15_000, `降级应在有界时间内完成，实测 ${elapsed}ms`);
    assert.equal(logs.length, 0, '降级路径不应打 info 级别的「已连接」');
    assert.ok(
      errors.some((line) => line.includes('连接 Redis 失败')),
      `应记录降级原因，实得：${JSON.stringify(errors)}`,
    );

    // 降级后功能必须可用
    const result = await layer.rateLimiter.consume('k', 1, 1000);
    assert.equal(result.allowed, true);
  } finally {
    await layer.close();
  }
});

test('装配：内存层的限流与缓存可用', async () => {
  const layer = createMemoryCacheLayer(fakeClock().now);
  assert.equal(layer.kind, 'memory');

  await layer.rateLimiter.consume('k', 1, 1000);
  assert.equal((await layer.rateLimiter.consume('k', 1, 1000)).allowed, false);

  await layer.cache.set('k', 42, 1000);
  assert.equal(await layer.cache.get<number>('k'), 42);

  await layer.close();
});

test('键名前缀：限流与缓存键集中在 mscts 命名空间，且 lowercase 归一', () => {
  assert.equal(KEY_PREFIX, 'mscts');
  assert.equal(RateLimitKeys.webLogin('A@B.C'), 'mscts:rl:login:a@b.c');
  assert.equal(RateLimitKeys.yggdrasilAccount('SomeUser'), 'mscts:rl:yggdrasil:someuser');
  assert.equal(RateLimitKeys.webRegister('127.0.0.1'), 'mscts:rl:register:127.0.0.1');
  assert.equal(CacheKeys.publicSettings(), 'mscts:cache:settings:public');
});

// ---------------------------------------------------------------- Redis 实现（门控）

test(
  'Redis：限流与缓存真实读写（需要 TEST_REDIS_URL 或 REDIS_URL）',
  { skip: TEST_REDIS_URL ? false : '未设置 TEST_REDIS_URL/REDIS_URL，跳过 Redis 实现测试' },
  async () => {
    const client = await connectRedis(TEST_REDIS_URL!, { onError: () => undefined });
    const layer = createRedisCacheLayer(client, () => undefined);
    const suffix = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const limitKey = `mscts:rl:${suffix}`;
    const cacheKey = `mscts:cache:${suffix}`;

    try {
      assert.equal(layer.kind, 'redis');

      // --- 限流：固定窗口 ---
      const first = await layer.rateLimiter.consume(limitKey, 2, 60_000);
      assert.equal(first.allowed, true);
      assert.equal(first.remaining, 1);
      assert.equal(first.limit, 2);
      assert.ok(first.resetAfterMs > 0 && first.resetAfterMs <= 60_000);

      await layer.rateLimiter.consume(limitKey, 2, 60_000);
      const third = await layer.rateLimiter.consume(limitKey, 2, 60_000);
      assert.equal(third.allowed, false, '第 3 次必须拒绝');
      assert.equal(third.remaining, 0);
      assert.ok(third.resetAfterMs > 0, '拒绝时应给出剩余等待时间');

      // 关键：Lua 脚本必须给 key 设上了 TTL，否则一旦 INCR 后中断该 key 会被永久锁定
      const ttl = await client.pTTL(limitKey);
      assert.ok(ttl > 0 && ttl <= 60_000, `计数键必须带 TTL，实得 ${ttl}`);

      await layer.rateLimiter.reset(limitKey);
      assert.equal((await layer.rateLimiter.consume(limitKey, 2, 60_000)).allowed, true);

      // --- 缓存：值往返 + TTL + 失效 ---
      assert.equal(await layer.cache.get(cacheKey), undefined);

      await layer.cache.set(cacheKey, { title: '测试', count: 3, flag: true }, 60_000);
      assert.deepEqual(await layer.cache.get(cacheKey), {
        title: '测试',
        count: 3,
        flag: true,
      });

      const cacheTtl = await client.pTTL(cacheKey);
      assert.ok(cacheTtl > 0 && cacheTtl <= 60_000, `缓存键必须带 TTL，实得 ${cacheTtl}`);

      await layer.cache.del(cacheKey);
      assert.equal(await layer.cache.get(cacheKey), undefined);
    } finally {
      await client.del([limitKey, cacheKey]).catch(() => undefined);
      await layer.close();
    }
  },
);

test(
  'Redis：装配层连上后 kind 为 redis（需要 TEST_REDIS_URL 或 REDIS_URL）',
  { skip: TEST_REDIS_URL ? false : '未设置 TEST_REDIS_URL/REDIS_URL，跳过 Redis 装配测试' },
  async () => {
    const layer = await createCacheLayer({
      redisUrl: TEST_REDIS_URL!,
      onError: () => undefined,
    });
    try {
      assert.equal(layer.kind, 'redis');
      const key = `mscts:cache:probe-${Date.now()}`;
      await layer.cache.set(key, 'ok', 5_000);
      assert.equal(await layer.cache.get<string>(key), 'ok');
      await layer.cache.del(key);
    } finally {
      await layer.close();
    }
  },
);
