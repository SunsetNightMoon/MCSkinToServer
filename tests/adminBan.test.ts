import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { PostgresConnection } from '../src/db/postgres.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import type { DatabaseConnection } from '../src/types.js';
import { runMigrations } from '../src/migrate/runner.js';
import { TokenService } from '../src/auth/tokens.js';
import { IdentityService } from '../src/auth/identity.js';
import { TokenRepository } from '../src/repositories/tokenRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { ProfileRepository } from '../src/repositories/profileRepository.js';
import { MinecraftSessionRepository } from '../src/repositories/minecraftSessionRepository.js';
import { BlobRepository } from '../src/repositories/blobRepository.js';
import { AssetRepository } from '../src/repositories/assetRepository.js';
import { FavoriteRepository } from '../src/repositories/favoriteRepository.js';
import { SettingRepository } from '../src/repositories/settingRepository.js';
import { StatsRepository, buildDayKeys } from '../src/repositories/statsRepository.js';
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { RuntimeSettings } from '../src/site/runtimeSettings.js';
import { SecretBox } from '../src/util/secretBox.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import { DEFAULT_STATS_TZ_OFFSET_MINUTES, type AppConfig } from '../src/config.js';

/**
 * P5 补：封禁链路与 `users.banned_at`（迁移 0005）。
 *
 * ## 为什么单独一个文件
 *
 * 封禁功能本身在 P3 就有了（`PATCH /api/admin/users/:id` + `IdentityService.assertNotBanned`），
 * 而且**一直是对的**。缺的只是**时间戳**：只有「当前是否被封」这一个状态位，
 * 没有「什么时候被封的」，所以仪表盘的「封禁趋势」没有任何数据源。
 *
 * 补上 `banned_at` 之后，这一列就成了两个口径的公共依赖，必须逐条锁住：
 *
 * - **下达即写入**：封禁响应与库里都要有这个时刻；
 * - **解封必须清空**：留着它会让趋势把解封后的日子仍算作封禁
 *   （`banCounts` 是按 `banned_at IS NOT NULL` 统计的**当前状态**口径）；
 * - **重复封禁覆盖为最新一次**：否则「第二次封禁」在图上看起来像没发生。
 *
 * 另外把「临时封禁必须给未来时间」「不能封自己」这两条既有规则一并钉住 ——
 * 它们之前没有测试覆盖。
 *
 * 双方言：SQLite 恒跑；PostgreSQL 由 `TEST_DATABASE_URL` 门控（共享库，
 * 用例自己造的数据自己清理，计数一律用差值断言）。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'password123';
const TZ = DEFAULT_STATS_TZ_OFFSET_MINUTES;

type Dialect = 'sqlite' | 'postgres';

interface Env {
  dialect: Dialect;
  db: DatabaseConnection;
  baseUrl: string;
  stats: StatsRepository;
  identity: IdentityService;
  users: UserRepository;
  profiles: ProfileRepository;
  tokenService: TokenService;
  /** 需要可控时钟时另建一个 IdentityService（同库同仓储） */
  identityAt: (now: () => Date) => IdentityService;
  close: () => Promise<void>;
}

const envs: Partial<Record<Dialect, Env>> = {};

async function makeEnv(dialect: Dialect): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), `mscts-ban-${dialect}-`));
  const db: DatabaseConnection =
    dialect === 'postgres'
      ? PostgresConnection.connect(TEST_DATABASE_URL!)
      : new SqliteConnection(join(dir, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, dialect === 'sqlite' ? 'sqlite' : 'postgresql'));

  const config: AppConfig = {
    dialect,
    sqlitePath: join(dir, 't.db'),
    migrationsRoot: SCHEMA_DIR,
    uploadDir: join(dir, 'uploads'),
    publicBaseUrl: 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: join(dir, 'keys', 'yggdrasil.pem'),
    skinDomains: ['localhost'],
    ...(dialect === 'postgres' ? { databaseUrl: TEST_DATABASE_URL } : {}),
  };

  const storage = new LocalDiskStorage(config.uploadDir, config.publicBaseUrl);
  const rsaKeyPair = loadOrCreateKeyPair(config.rsaPrivateKeyPath);
  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const assets = new AssetRepository(db);
  const blobs = new BlobRepository(db);
  const tokenService = new TokenService(new TokenRepository(db));
  const settings = new SettingRepository(db);
  const sessions = new MinecraftSessionRepository(db);

  const identityAt = (now: () => Date): IdentityService =>
    new IdentityService({ db, users, profiles, tokens: tokenService, sessions, now });
  const identity = identityAt(() => new Date());
  const stats = new StatsRepository(db, TZ);

  const deps: AppDependencies = {
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity,
    profileRepository: profiles,
    assetRepository: assets,
    minecraftSessions: sessions,
    textureBuilder: new TextureProfileBuilder(rsaKeyPair.privateKeyPem),
    assetUrlResolver: new AssetUrlResolver(storage),
    textures: new TextureService({ db, storage, blobs, assets, profiles }),
    library: new LibraryService({
      assets,
      favorites: new FavoriteRepository(db),
      blobs,
      users,
      resolver: new AssetUrlResolver(storage),
    }),
    settings,
    runtimeSettings: new RuntimeSettings({
      settings,
      secretBox: new SecretBox('test-master-secret-0123456789'),
    }),
    stats,
  };

  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    dialect,
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    stats,
    identity,
    users,
    profiles,
    tokenService,
    identityAt,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close().catch(() => undefined);
      if (dialect === 'sqlite') {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

before(async () => {
  envs.sqlite = await makeEnv('sqlite');
  if (TEST_DATABASE_URL) {
    envs.postgres = await makeEnv('postgres');
  }
});

after(async () => {
  await envs.sqlite?.close();
  await envs.postgres?.close();
});

const dialects: Array<{ label: Dialect; enabled: boolean }> = [
  { label: 'sqlite', enabled: true },
  { label: 'postgres', enabled: Boolean(TEST_DATABASE_URL) },
];

function env(dialect: Dialect): Env {
  const found = envs[dialect];
  if (!found) throw new Error(`${dialect} env not ready`);
  return found;
}

function ph(dialect: Dialect, i: number): string {
  return dialect === 'postgres' ? `$${i + 1}` : '?';
}

async function api(
  dialect: Dialect,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  const res = await fetch(`${env(dialect).baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * 把库里的时间列规范成 ISO 字符串。
 * SQLite 回来的是 TEXT，PG 的 `timestamptz` 回来的是 Date —— 两边都要能比。
 */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

async function seedUser(
  dialect: Dialect,
  role: 'user' | 'admin' | 'super_admin',
): Promise<{ id: string; token: string; email: string }> {
  const e = env(dialect);
  const email = `ban-${dialect}-${randomUUID().replace(/-/g, '').slice(0, 8)}@test.local`;
  const res = await e.identity.register({
    email,
    password: PASSWORD,
    profileName: `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  });
  if (role !== 'user') {
    await e.users.updateAdminFields(res.user.id, { role }, new Date());
  }
  assert.ok(res.token, '注册应当签发会话令牌');
  return { id: res.user.id, token: res.token.token, email };
}

/** 直接读库看 banned_at 与三个封禁字段（不走响应，避免「响应好看、库里没写」） */
async function readBanFields(
  dialect: Dialect,
  userId: string,
): Promise<{
  bannedAt: string | null;
  bannedUntil: string | null;
  banPermanent: boolean | number;
  banReason: string | null;
}> {
  const rows = await env(dialect).db.query<Record<string, unknown>>(
    `SELECT banned_at, banned_until, ban_permanent, ban_reason
       FROM users WHERE id = ${ph(dialect, 0)}`,
    [userId],
  );
  const row = rows[0] ?? {};
  return {
    bannedAt: toIso(row['banned_at']),
    bannedUntil: toIso(row['banned_until']),
    banPermanent: row['ban_permanent'] as boolean | number,
    banReason: (row['ban_reason'] ?? null) as string | null,
  };
}

async function cleanup(dialect: Dialect, userIds: string[]): Promise<void> {
  const db = env(dialect).db;
  for (const id of userIds) {
    await db
      .run(`DELETE FROM assets WHERE owner_user_id = ${ph(dialect, 0)}`, [id])
      .catch(() => undefined);
    await db.run(`DELETE FROM profiles WHERE user_id = ${ph(dialect, 0)}`, [id]).catch(() => undefined);
    await db.run(`DELETE FROM users WHERE id = ${ph(dialect, 0)}`, [id]).catch(() => undefined);
  }
}

// ============================================================================
// 迁移默认值 + 封禁写入 + 趋势 + 解封
// ============================================================================

for (const { label, enabled } of dialects) {
  const skip = !enabled;

  test(`adminBan: 新注册用户 banned_at 为 NULL（迁移默认），登录不受影响（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const user = await seedUser(label, 'user');
      created.push(user.id);

      const fields = await readBanFields(label, user.id);
      assert.equal(fields.bannedAt, null, '从未被封禁的账号不应有 banned_at');
      assert.equal(fields.bannedUntil, null);
      assert.equal(Boolean(fields.banPermanent), false);

      // 服务层与响应层都应为 null（不是 undefined、不是空字符串）
      const row = (await env(label).users.findById(user.id))!;
      assert.equal(row.bannedAt, null);

      const login = await api(label, '/api/auth/login', {
        method: 'POST',
        body: { email: user.email, password: PASSWORD },
      });
      assert.equal(login.status, 200, JSON.stringify(login.body));
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminBan: 永久封禁写入 banned_at，响应与库内一致，且当天计入 banCounts（${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    try {
      const admin = await seedUser(label, 'super_admin');
      created.push(admin.id);
      const victim = await seedUser(label, 'user');
      created.push(victim.id);

      const beforeDaily = await e.stats.daily(7);
      const last = beforeDaily.days.length - 1;
      const beforeBans = beforeDaily.banCounts[last]!;

      const issuedAt = new Date();
      const res = await api(label, `/api/admin/users/${victim.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { ban: { permanent: true, reason: '测试封禁' } },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const banned = res.body.user;
      assert.equal(banned.banPermanent, true);
      assert.equal(banned.bannedUntil, null, '永久封禁的 banned_until 必须为 NULL（约束要求）');
      assert.equal(banned.banReason, '测试封禁');
      assert.match(
        String(banned.bannedAt),
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        `bannedAt 应为 ISO-8601：${banned.bannedAt}`,
      );

      // 库里的值必须是同一个时刻（允许毫秒级先后差）
      const fields = await readBanFields(label, victim.id);
      assert.ok(fields.bannedAt, 'banned_at 应当已落库');
      const skew = Math.abs(Date.parse(fields.bannedAt!) - issuedAt.getTime());
      assert.ok(skew < 60_000, `banned_at 与下达时刻偏差过大：${fields.bannedAt}（${skew}ms）`);
      assert.equal(Boolean(fields.banPermanent), true);

      // 趋势：今天 +1
      const afterDaily = await e.stats.daily(7);
      assert.equal(
        afterDaily.banCounts[last]! - beforeBans,
        1,
        `封禁应计入 ${afterDaily.days[last]} 的 banCounts`,
      );
      assert.equal(afterDaily.days[last], buildDayKeys(1, TZ, new Date())[0]);
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminBan: 被封禁后登录 403 USER_BANNED，解封后恢复且 banned_at 被清空（${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    try {
      const admin = await seedUser(label, 'super_admin');
      created.push(admin.id);
      const victim = await seedUser(label, 'user');
      created.push(victim.id);

      const ban = await api(label, `/api/admin/users/${victim.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { ban: { permanent: true, reason: '违规' } },
      });
      assert.equal(ban.status, 200);

      const blocked = await api(label, '/api/auth/login', {
        method: 'POST',
        body: { email: victim.email, password: PASSWORD },
      });
      assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
      assert.equal(blocked.body.error, 'USER_BANNED');
      assert.match(String(blocked.body.message), /永久封禁/);

      const dailyBanned = await e.stats.daily(7);
      const last = dailyBanned.days.length - 1;
      const whileBanned = dailyBanned.banCounts[last]!;
      assert.ok(whileBanned >= 1);

      // ---- 解封 ----
      const unban = await api(label, `/api/admin/users/${victim.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { ban: null },
      });
      assert.equal(unban.status, 200, JSON.stringify(unban.body));
      assert.equal(unban.body.user.banPermanent, false);
      assert.equal(unban.body.user.bannedUntil, null);
      assert.equal(
        unban.body.user.bannedAt,
        null,
        '解封必须清空 bannedAt，否则趋势会把之后的日子仍算作封禁',
      );

      const fields = await readBanFields(label, victim.id);
      assert.equal(fields.bannedAt, null, '库里的 banned_at 也必须清空');
      assert.equal(fields.banReason, null);
      assert.equal(Boolean(fields.banPermanent), false);

      // 趋势是「当前状态」口径：解封后当天计数回落
      const dailyUnbanned = await e.stats.daily(7);
      assert.equal(
        dailyUnbanned.banCounts[last]! - whileBanned,
        -1,
        'banCounts 按 banned_at IS NOT NULL 统计，解封后应当回落',
      );

      const login = await api(label, '/api/auth/login', {
        method: 'POST',
        body: { email: victim.email, password: PASSWORD },
      });
      assert.equal(login.status, 200, JSON.stringify(login.body));
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminBan: 临时封禁（未来到期）生效、到期自动恢复（${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    try {
      const admin = await seedUser(label, 'super_admin');
      created.push(admin.id);
      const victim = await seedUser(label, 'user');
      created.push(victim.id);

      const until = new Date(Date.now() + 3_600_000).toISOString();
      const res = await api(label, `/api/admin/users/${victim.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { ban: { permanent: false, until, reason: '冷静期' } },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.user.banPermanent, false);
      assert.equal(toIso(res.body.user.bannedUntil), until);
      assert.ok(res.body.user.bannedAt, '临时封禁同样要记下达时刻');

      const blocked = await api(label, '/api/auth/login', {
        method: 'POST',
        body: { email: victim.email, password: PASSWORD },
      });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error, 'USER_BANNED');
      assert.match(String(blocked.body.message), /封禁至/);

      // 时钟推过到期时间：临时封禁应当自动失效（无需管理员解封）
      const afterExpiry = new Date(Date.now() + 7_200_000);
      const clock = e.identityAt(() => afterExpiry);
      const relogin = await clock.loginWeb({ email: victim.email, password: PASSWORD });
      assert.ok(relogin.token, '临时封禁到期后应当可以正常登录');

      // 但 banned_at 仍在（历史事实），趋势口径是「当前状态」故当天仍计 1
      const fields = await readBanFields(label, victim.id);
      assert.ok(fields.bannedAt, '到期不等于解封，banned_at 不应被自动清掉');
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminBan: 临时封禁必须给未来时间，过去时间被拒 400（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const admin = await seedUser(label, 'super_admin');
      created.push(admin.id);
      const victim = await seedUser(label, 'user');
      created.push(victim.id);

      for (const until of [new Date(Date.now() - 60_000).toISOString(), 'not-a-date']) {
        const res = await api(label, `/api/admin/users/${victim.id}`, {
          method: 'PATCH',
          token: admin.token,
          body: { ban: { permanent: false, until } },
        });
        assert.equal(res.status, 400, `until=${until} -> ${res.status}`);
        assert.equal(res.body.error, 'VALIDATION_ERROR');
      }

      // 被拒之后不得留下半套状态（否则「报错了但人已经被封」）
      const fields = await readBanFields(label, victim.id);
      assert.equal(fields.bannedAt, null);
      assert.equal(fields.bannedUntil, null);
      assert.equal(Boolean(fields.banPermanent), false);
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminBan: 不能封禁自己；普通用户无权封禁（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const admin = await seedUser(label, 'super_admin');
      created.push(admin.id);
      const plain = await seedUser(label, 'user');
      created.push(plain.id);

      const self = await api(label, `/api/admin/users/${admin.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { ban: { permanent: true } },
      });
      assert.equal(self.status, 400, JSON.stringify(self.body));
      assert.equal(self.body.error, 'VALIDATION_ERROR');
      assert.match(String(self.body.message), /自己/);

      const anon = await api(label, `/api/admin/users/${plain.id}`, {
        method: 'PATCH',
        body: { ban: { permanent: true } },
      });
      assert.equal(anon.status, 401);

      const byPlain = await api(label, `/api/admin/users/${admin.id}`, {
        method: 'PATCH',
        token: plain.token,
        body: { ban: { permanent: true } },
      });
      assert.equal(byPlain.status, 403);
      assert.equal(byPlain.body.error, 'FORBIDDEN');

      // 管理员自己没被任何一次失败请求写脏
      const fields = await readBanFields(label, admin.id);
      assert.equal(fields.bannedAt, null);
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminBan: 封禁不存在的用户报 404（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const admin = await seedUser(label, 'super_admin');
      created.push(admin.id);
      const res = await api(label, `/api/admin/users/${randomUUID()}`, {
        method: 'PATCH',
        token: admin.token,
        body: { ban: { permanent: true } },
      });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'NOT_FOUND');
    } finally {
      await cleanup(label, created);
    }
  });
}

// ============================================================================
// 重复封禁：banned_at 覆盖为最新一次（用假钟精确断言，双方言）
// ============================================================================

for (const { label, enabled } of dialects) {
  const skip = !enabled;

  test(`adminBan: 重复封禁把 banned_at 覆盖为本次下达时刻（${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    try {
      const actor = await seedUser(label, 'super_admin');
      created.push(actor.id);
      const victim = await seedUser(label, 'user');
      created.push(victim.id);

      let now = new Date('2026-03-01T10:00:00.000Z');
      const clock = e.identityAt(() => now);
      const asSuper = { userId: actor.id, role: 'super_admin' as const };

      const first = await clock.adminUpdateUser(asSuper, victim.id, {
        ban: { permanent: true, reason: '第一次' },
      });
      assert.equal(first.bannedAt, '2026-03-01T10:00:00.000Z');

      now = new Date('2026-03-05T09:30:00.000Z');
      const second = await clock.adminUpdateUser(asSuper, victim.id, {
        ban: { permanent: true, reason: '第二次' },
      });
      assert.equal(
        second.bannedAt,
        '2026-03-05T09:30:00.000Z',
        '第二次封禁必须覆盖为新的时刻，否则趋势上看不出又封了一次',
      );

      // 先封后解，再封：解封清空、新封重新写入
      now = new Date('2026-03-06T08:00:00.000Z');
      const cleared = await clock.adminUpdateUser(asSuper, victim.id, { ban: null });
      assert.equal(cleared.bannedAt, null);

      now = new Date('2026-03-07T08:00:00.000Z');
      const again = await clock.adminUpdateUser(asSuper, victim.id, {
        ban: { permanent: true },
      });
      assert.equal(again.bannedAt, '2026-03-07T08:00:00.000Z');

      const fields = await readBanFields(label, victim.id);
      assert.equal(fields.bannedAt, '2026-03-07T08:00:00.000Z', '库内应与服务层返回一致');
    } finally {
      await cleanup(label, created);
    }
  });
}
