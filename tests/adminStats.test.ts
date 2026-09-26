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
import {
  StatsRepository,
  buildDayKeys,
  MAX_STATS_DAYS,
  MIN_STATS_DAYS,
  type AdminStatsDaily,
} from '../src/repositories/statsRepository.js';
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { LocalDiskStorage, blobStorageKey } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { sha256Hex } from '../src/util/crypto.js';
import { RuntimeSettings } from '../src/site/runtimeSettings.js';
import { SecretBox } from '../src/util/secretBox.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import { DEFAULT_STATS_TZ_OFFSET_MINUTES, type AppConfig } from '../src/config.js';

/**
 * P5 补：管理后台仪表盘（`/api/admin/stats` + `/api/admin/stats/daily`）。
 *
 * ## 这个文件存在的直接原因
 *
 * 仪表盘上线后是**一片空白**：卡片数字取自前端拼的接口（口径错），四张折线图
 * 因为前端把一个「写死返回六个空数组」的替身当成了后端而永远没有点。
 * 修完之后，最容易再坏掉的仍然是同一段——接口在、但口径或分桶悄悄偏了。
 * 所以这里断言的重点不是「接口返回 200」，而是：
 *
 * - **口径**：`skinCount` 必须含私有/待审/被拒（而不是公开库那套 public+approved），
 *   `userCount` 必须排除已注销；
 * - **补零与等长**：六个数组与 `days` 一一对应，没有活动的日子是 0 而不是「消失」；
 * - **时区分桶**：同一条记录在 UTC+8 与 UTC 下**必须落在不同的日子**——
 *   这条正是「北京时间凌晨的活动被算到前一天」那个坑的守门测试。
 *
 * ## 双方言
 *
 * SQLite 恒跑；PostgreSQL 由 `TEST_DATABASE_URL` 门控。PG 侧沿用共享库
 * `mcsts_smoke_test`，库里可能已有别的用例留下的数据，所以概览与趋势一律用
 * **前后差值**断言，不假定绝对数字（只有空库那条用例例外，它自带一个库）。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'password123';
/** 站点默认分桶时区（UTC+8），与 config.ts 的默认值保持一致 */
const TZ = DEFAULT_STATS_TZ_OFFSET_MINUTES;

type Dialect = 'sqlite' | 'postgres';

interface Env {
  dialect: Dialect;
  db: DatabaseConnection;
  baseUrl: string;
  stats: StatsRepository;
  identity: IdentityService;
  tokenService: TokenService;
  /** 用同一份依赖另起一个 app（用于「未注入统计仓储」这类对照） */
  listen: (overrides: Partial<AppDependencies>) => Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }>;
  close: () => Promise<void>;
}

const envs: Partial<Record<Dialect, Env>> = {};

async function makeEnv(dialect: Dialect): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), `mcsts-stats-${dialect}-`));
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
  const identity = new IdentityService({
    db,
    users,
    profiles,
    tokens: tokenService,
    sessions: new MinecraftSessionRepository(db),
  });
  const stats = new StatsRepository(db, TZ);

  const baseDeps: AppDependencies = {
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity,
    profileRepository: profiles,
    assetRepository: assets,
    minecraftSessions: new MinecraftSessionRepository(db),
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

  const listen = async (
    overrides: Partial<AppDependencies>,
  ): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
    const server = createApp({ ...baseDeps, ...overrides }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  };

  const main = await listen({});

  return {
    dialect,
    db,
    baseUrl: main.baseUrl,
    stats,
    identity,
    tokenService,
    listen,
    close: async () => {
      await main.close();
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

/** 方言占位符（测试里的裸 SQL 用；PG 是 `$1..$n`） */
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

function emailFor(dialect: Dialect, prefix: string): string {
  return `${prefix}-${dialect}-${randomUUID().replace(/-/g, '').slice(0, 8)}@test.local`;
}

/** 注册一个用户（角色可选），返回 id / token / email */
async function seedUser(
  dialect: Dialect,
  role: 'user' | 'admin' | 'super_admin',
): Promise<{ id: string; token: string; email: string }> {
  const e = env(dialect);
  const email = emailFor(dialect, 'stats');
  const res = await e.identity.register({
    email,
    password: PASSWORD,
    profileName: `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  });
  if (role !== 'user') {
    // requireAuth 的角色实时查库，故无需重签 token
    await new UserRepository(e.db).updateAdminFields(res.user.id, { role }, new Date());
  }
  assert.ok(res.token, '注册应当签发会话令牌');
  return { id: res.user.id, token: res.token.token, email };
}

/** 直接插一条素材（含其 blob），返回 assetId */
async function seedAsset(
  dialect: Dialect,
  opts: {
    ownerUserId: string;
    kind: 'skin' | 'cape';
    visibility: 'private' | 'public';
    downloadPolicy: 'owner_only' | 'public';
    reviewStatus: 'pending' | 'approved' | 'rejected';
    /** 不传则「现在」；传了用于测时区分桶 */
    createdAt?: string;
  },
): Promise<string> {
  const db = env(dialect).db;
  const assetId = randomUUID();
  const blobId = randomUUID();
  const sha = sha256Hex(`blob-${assetId}`);
  const now = opts.createdAt ?? new Date().toISOString();

  await db.run(
    `INSERT INTO blobs (id, sha256, storage_key, content_type, byte_size, width, height, created_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ph(dialect, i)).join(', ')})`,
    [blobId, sha, blobStorageKey(sha), 'image/png', 128, 64, 64, now],
  );
  await db.run(
    `INSERT INTO assets (id, owner_user_id, kind, blob_id, model_type, name, description,
       license, visibility, download_policy, review_status, created_at, updated_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => ph(dialect, i)).join(', ')})`,
    [
      assetId,
      opts.ownerUserId,
      opts.kind,
      blobId,
      // assets_model_shape 约束：cape 必须 model_type IS NULL，skin 必须 default/slim
      opts.kind === 'cape' ? null : 'default',
      `asset_${assetId.slice(0, 8)}`,
      '',
      'ARR',
      opts.visibility,
      opts.downloadPolicy,
      opts.reviewStatus,
      now,
      now,
    ],
  );
  return assetId;
}

/** 清理本次用例造的用户（PG 共用库必须自己收尾；素材随 owner 级联或显式删） */
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
// 1. 纯函数：日期序列生成
// ============================================================================

test('adminStats: buildDayKeys 升序、等长、末项为「偏移后的今天」', () => {
  // 2026-01-01T23:30Z：UTC 下还是 1 号，UTC+8 下已经是 2 号（+8 的经典跨日）
  const now = new Date('2026-01-01T23:30:00.000Z');

  const utc8 = buildDayKeys(3, 480, now);
  assert.deepEqual(utc8, ['2025-12-31', '2026-01-01', '2026-01-02']);

  const utc = buildDayKeys(3, 0, now);
  assert.deepEqual(utc, ['2025-12-30', '2025-12-31', '2026-01-01']);

  // 负偏移（UTC-5）同理，方向相反
  const utc5 = buildDayKeys(2, -300, now);
  assert.deepEqual(utc5, ['2025-12-31', '2026-01-01']);

  // 长度为 1 时就是「今天」
  assert.deepEqual(buildDayKeys(1, 480, now), ['2026-01-02']);

  // 连续、升序、无重复
  const thirty = buildDayKeys(30, 480, now);
  assert.equal(thirty.length, 30);
  for (let i = 1; i < thirty.length; i += 1) {
    const prev = Date.parse(`${thirty[i - 1]}T00:00:00.000Z`);
    const cur = Date.parse(`${thirty[i]}T00:00:00.000Z`);
    assert.equal(cur - prev, 86_400_000, `${thirty[i - 1]} → ${thirty[i]} 应当正好差一天`);
  }
});

// ============================================================================
// 2. 空库（仅 SQLite：PG 是共享库，永远不可能为空）
// ============================================================================

test('adminStats: 空库概览三个数为 0，趋势六个数组全 0 但等长', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-stats-empty-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  try {
    await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
    const stats = new StatsRepository(db, TZ);

    assert.deepEqual(await stats.overview(), {
      userCount: 0,
      skinCount: 0,
      pendingCount: 0,
    });

    const daily = await stats.daily(5);
    assert.equal(daily.days.length, 5);
    for (const key of [
      'skinUploads',
      'capeUploads',
      'userRegistrations',
      'pendingSubmissions',
      'banCounts',
    ] as const) {
      assert.deepEqual(daily[key], [0, 0, 0, 0, 0], `${key} 应当补零而不是空数组`);
    }
  } finally {
    await db.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ============================================================================
// 3. 仓储与端点（双方言）
// ============================================================================

for (const { label, enabled } of dialects) {
  const skip = !enabled;

  test(`adminStats: 概览口径——皮肤含私有/待审/被拒，用户排除已注销（${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    try {
      const owner = await seedUser(label, 'user');
      created.push(owner.id);

      const before = await e.stats.overview();

      // 快照之后再建一个账号，用来验证 userCount 的增量
      const second = await seedUser(label, 'user');
      created.push(second.id);

      // 三条皮肤：私有已过审、公开待审、私有被拒 —— 三条都必须计入 skinCount
      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'skin',
        visibility: 'private',
        downloadPolicy: 'owner_only',
        reviewStatus: 'approved',
      });
      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'skin',
        visibility: 'public',
        downloadPolicy: 'public',
        reviewStatus: 'pending',
      });
      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'skin',
        visibility: 'private',
        downloadPolicy: 'owner_only',
        reviewStatus: 'rejected',
      });
      // 一条披风：不进 skinCount，但待审计数
      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'cape',
        visibility: 'public',
        downloadPolicy: 'public',
        reviewStatus: 'pending',
      });

      const after = await e.stats.overview();
      assert.equal(after.skinCount - before.skinCount, 3, 'skinCount 必须含待审与被拒');
      assert.equal(after.pendingCount - before.pendingCount, 2, '待审 = skin 1 + cape 1');
      assert.equal(after.userCount - before.userCount, 1, '新注册的 owner 应计入');

      // 注销（软删）后不再计入 userCount，但历史趋势不受影响（见下一条用例）
      await e.db.run(
        `UPDATE users SET deleted_at = ${ph(label, 0)} WHERE id = ${ph(label, 1)}`,
        [new Date().toISOString(), owner.id],
      );
      const afterDelete = await e.stats.overview();
      assert.equal(
        afterDelete.userCount,
        before.userCount,
        'deleted_at 非空的用户不应计入 userCount',
      );
      assert.equal(afterDelete.skinCount, after.skinCount, '注销不应顺势抹掉素材计数');
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminStats: daily 六数组等长、日期升序连续、末项为偏移时区的今天（${label}）`, { skip }, async () => {
    const e = env(label);
    const daily = await e.stats.daily(7);

    assert.equal(daily.days.length, 7);
    assert.deepEqual(daily.days, buildDayKeys(7, TZ, new Date()));
    for (let i = 1; i < daily.days.length; i += 1) {
      const prev = Date.parse(`${daily.days[i - 1]}T00:00:00.000Z`);
      const cur = Date.parse(`${daily.days[i]}T00:00:00.000Z`);
      assert.equal(cur - prev, 86_400_000);
    }
    assert.match(daily.days[6]!, /^\d{4}-\d{2}-\d{2}$/);

    const numeric = [
      daily.skinUploads,
      daily.capeUploads,
      daily.userRegistrations,
      daily.pendingSubmissions,
      daily.banCounts,
    ];
    for (const arr of numeric) {
      assert.equal(arr.length, 7, '每个序列都必须与 days 等长');
      for (const n of arr) {
        assert.equal(Number.isInteger(n), true, `计数必须是整数：${n}`);
        assert.ok(n >= 0, `计数不应为负：${n}`);
      }
    }
  });

  test(`adminStats: 今天的上传/注册会进当天桶，六个序列互不错位（${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    try {
      // 先取快照，再建数据 —— 否则「增量」里算的是快照之前的事，断言等于没断言
      const before = await e.stats.daily(7);
      const last = before.days.length - 1;

      const owner = await seedUser(label, 'user');
      created.push(owner.id);
      const other = await seedUser(label, 'user');
      created.push(other.id);

      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'skin',
        visibility: 'public',
        downloadPolicy: 'public',
        reviewStatus: 'approved',
      });
      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'skin',
        visibility: 'private',
        downloadPolicy: 'owner_only',
        reviewStatus: 'pending',
      });
      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'cape',
        visibility: 'public',
        downloadPolicy: 'public',
        reviewStatus: 'pending',
      });

      const after = await e.stats.daily(7);
      assert.deepEqual(after.days, before.days, '同一时刻两次调用日期序列应一致');

      assert.equal(after.skinUploads[last]! - before.skinUploads[last]!, 2);
      assert.equal(after.capeUploads[last]! - before.capeUploads[last]!, 1);
      // 「当日提交、至今未审」：今天新提交且当前仍为 pending 的两条
      assert.equal(after.pendingSubmissions[last]! - before.pendingSubmissions[last]!, 2);
      assert.equal(after.userRegistrations[last]! - before.userRegistrations[last]!, 2);
      assert.equal(after.banCounts[last]! - before.banCounts[last]!, 0, '没封人就不该有封禁计数');

      // 错位守门：披风不能混进皮肤序列
      for (let i = 0; i < last; i += 1) {
        assert.equal(after.skinUploads[i], before.skinUploads[i], `历史第 ${i} 天不应变化`);
        assert.equal(after.capeUploads[i], before.capeUploads[i], `历史第 ${i} 天不应变化`);
      }
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminStats: 时区偏移决定分桶边界（同一条记录在两个偏移下落在不同日期，${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    try {
      const owner = await seedUser(label, 'user');
      created.push(owner.id);

      const days8 = buildDayKeys(7, TZ, new Date());
      const today = days8[6]!;
      const prev = days8[5]!;

      // UTC+8 的今天 00:00 —— 在 UTC 下还是**前一天** 16:00。
      // 这正是「北京时间凌晨的活动被算到前一天」那个坑的临界点。
      const utcInstant = `${prev}T16:00:00.000Z`;

      // 先取两份基线（同一份数据、只有偏移不同），再插行，再取一次
      const utcRepo = new StatsRepository(e.db, 0);
      const before8 = await e.stats.daily(7);
      const beforeUtc = await utcRepo.daily(7);

      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'skin',
        visibility: 'public',
        downloadPolicy: 'public',
        reviewStatus: 'approved',
        createdAt: utcInstant,
      });

      const after8 = await e.stats.daily(7);
      const afterUtc = await utcRepo.daily(7);

      const deltaAt = (arr: number[], base: number[], i: number): number =>
        (arr[i] ?? 0) - (base[i] ?? 0);

      // 站点默认时区（UTC+8）：落在「今天」
      assert.equal(after8.days[6], today);
      assert.equal(deltaAt(after8.skinUploads, before8.skinUploads, 6), 1);
      assert.equal(deltaAt(after8.skinUploads, before8.skinUploads, 5), 0);

      // UTC 视图：同一条记录落在「前一天」。
      // 这里按**日期标签**取下标而不是硬编码 5/6 —— UTC 与 UTC+8 的「今天」
      // 未必是同一天，硬编码在一天中的某些时段会假失败。
      const iUtc = afterUtc.days.indexOf(prev);
      assert.ok(iUtc >= 0, `UTC 视图应当包含 ${prev}（实际：${afterUtc.days.join(',')}）`);
      assert.equal(
        deltaAt(afterUtc.skinUploads, beforeUtc.skinUploads, iUtc),
        1,
        'UTC 视图应当把它算在前一天',
      );
      const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
      assert.equal(
        sum(afterUtc.skinUploads) - sum(beforeUtc.skinUploads),
        1,
        '两个视图都只能数到这一次上传（不多不少）',
      );
      assert.deepEqual(
        afterUtc.days,
        buildDayKeys(7, 0, new Date()),
        'UTC 视图的日期序列也应按自己的偏移生成',
      );
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminStats: days 越界/非法一律裁剪到 ${MIN_STATS_DAYS}..${MAX_STATS_DAYS}，不报 400（${label}）`, { skip }, async () => {
    const admin = await seedUser(label, 'admin');
    try {
      const cases: Array<[string, number]> = [
        ['1', 1],
        ['0', 1],
        ['-5', 1],
        ['3.7', 3],
        [`${MAX_STATS_DAYS + 10}`, MAX_STATS_DAYS],
        ['abc', 7],
        ['', 1],
      ];
      for (const [raw, expected] of cases) {
        const res = await api(label, `/api/admin/stats/daily?days=${raw}`, {
          token: admin.token,
        });
        assert.equal(res.status, 200, `days=${JSON.stringify(raw)} -> ${res.status}`);
        assert.equal(
          res.body.days.length,
          expected,
          `days=${JSON.stringify(raw)} 应裁剪为 ${expected}`,
        );
      }

      // 不带 days 时默认 7
      const dflt = await api(label, '/api/admin/stats/daily', { token: admin.token });
      assert.equal(dflt.status, 200);
      assert.equal(dflt.body.days.length, 7);
    } finally {
      await cleanup(label, [admin.id]);
    }
  });

  test(`adminStats: 端点形状与权限（无 token 401 / 普通用户 403 / 管理员 200，${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const plain = await seedUser(label, 'user');
      created.push(plain.id);
      const admin = await seedUser(label, 'admin');
      created.push(admin.id);

      // 未登录
      const anon = await api(label, '/api/admin/stats');
      assert.equal(anon.status, 401);

      // 普通用户：不能看统计
      const forbidden = await api(label, '/api/admin/stats', { token: plain.token });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.error, 'FORBIDDEN');
      const forbiddenDaily = await api(label, '/api/admin/stats/daily', {
        token: plain.token,
      });
      assert.equal(forbiddenDaily.status, 403);

      // 管理员：形状正确、三个数都是整数
      const ok = await api(label, '/api/admin/stats', { token: admin.token });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(Object.keys(ok.body).sort(), [
        'pendingCount',
        'skinCount',
        'userCount',
      ]);
      for (const n of [ok.body.userCount, ok.body.skinCount, ok.body.pendingCount]) {
        assert.equal(Number.isInteger(n), true, `概览三个数必须是整数：${JSON.stringify(ok.body)}`);
      }
      assert.ok(ok.body.userCount >= 1, '至少应当数得到刚建的两个账号');
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminStats: 未注入统计仓储时两个端点报 501 而不是 500（${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    let extra: { baseUrl: string; close: () => Promise<void> } | null = null;
    try {
      const admin = await seedUser(label, 'admin');
      created.push(admin.id);
      extra = await e.listen({ stats: undefined });

      for (const path of ['/api/admin/stats', '/api/admin/stats/daily']) {
        const res = await fetch(`${extra.baseUrl}${path}`, {
          headers: { authorization: `Bearer ${admin.token}` },
        });
        assert.equal(res.status, 501, `${path} 应报「未启用」而不是 500`);
        assert.equal(((await res.json()) as any).error, 'NOT_IMPLEMENTED');
      }
    } finally {
      await extra?.close();
      await cleanup(label, created);
    }
  });

  test(`adminStats: 仓储直调与端点结果一致（防止接线层偷偷改口径，${label}）`, { skip }, async () => {
    const e = env(label);
    const created: string[] = [];
    try {
      const admin = await seedUser(label, 'admin');
      created.push(admin.id);
      const owner = await seedUser(label, 'user');
      created.push(owner.id);
      await seedAsset(label, {
        ownerUserId: owner.id,
        kind: 'skin',
        visibility: 'private',
        downloadPolicy: 'owner_only',
        reviewStatus: 'pending',
      });

      const direct: AdminStatsDaily = await e.stats.daily(5);
      const viaHttp = await api(label, '/api/admin/stats/daily?days=5', {
        token: admin.token,
      });
      assert.equal(viaHttp.status, 200);
      assert.deepEqual(viaHttp.body, direct, '端点不得对仓储结果做任何加工');

      const directOverview = await e.stats.overview();
      const overviewHttp = await api(label, '/api/admin/stats', { token: admin.token });
      assert.deepEqual(overviewHttp.body, directOverview);
    } finally {
      await cleanup(label, created);
    }
  });
}
