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
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { RuntimeSettings } from '../src/site/runtimeSettings.js';
import { SecretBox } from '../src/util/secretBox.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * P5 第十一批：用户名模式收归**全站统一设置**。
 *
 * 产品规则（用户拍板）：
 * - 模式不再按账号各自设置：超管在管理面板切换 `GET|PUT /api/admin/profile-mode`，
 *   影响全部账号；等级 0/1 面板端点 → 403。
 * - 个人中心没有任何切换入口：`POST /api/me/profile-mode` 只剩「选保留 ID」
 *   一个用途（全局切到 single 后被强制选择的账号用），已决定账号调用 → 403。
 * - 全局切到 single：名下有多个使用中 ID 的账号 decided_at 置 NULL（待选择），
 *   写操作被 409 拦，选完其余 ID 转锁定（reserved）并启动 30 天窗口。
 * - **锁定的 ID 对所有人显示已占用**：`POST /api/profiles/minecraft` 批量查询
 *   纳入 reserved（推翻 0003 的防探测口径）。
 * - 预留口启用不受影响（仍受 30 天冷却约束）。
 * - 注册初值跟全局走：全局 multi 时注册的新账号 mode=multi、可直接加角色。
 *
 * 双方言：SQLite 恒跑；PostgreSQL 由 `TEST_DATABASE_URL` 门控（共享库，
 * 用例自己造的数据自己清理）。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'password123';

type Dialect = 'sqlite' | 'postgres';

interface Env {
  dialect: Dialect;
  db: DatabaseConnection;
  baseUrl: string;
  identity: IdentityService;
  users: UserRepository;
  profiles: ProfileRepository;
  settings: SettingRepository;
  close: () => Promise<void>;
}

const envs: Partial<Record<Dialect, Env>> = {};

async function makeEnv(dialect: Dialect): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), `mcsts-pmode-${dialect}-`));
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

  const identity = new IdentityService({
    db,
    users,
    profiles,
    tokens: tokenService,
    sessions,
    // 全局模式读写（注册初值 + 管理面板切换）——与 main.ts 装配一致
    settings,
    now: () => new Date(),
  });

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
  };

  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    dialect,
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    identity,
    users,
    profiles,
    settings,
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

function randomName(): string {
  return `pm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function seedUser(
  dialect: Dialect,
  role: 'user' | 'admin' | 'super_admin',
): Promise<{ id: string; token: string; email: string; profileName: string }> {
  const e = env(dialect);
  const email = `pm-${dialect}-${randomUUID().replace(/-/g, '').slice(0, 8)}@test.local`;
  const profileName = randomName();
  const res = await e.identity.register({
    email,
    password: PASSWORD,
    profileName,
  });
  if (role !== 'user') {
    await e.users.updateAdminFields(res.user.id, { role }, new Date());
  }
  assert.ok(res.token, '注册应当签发会话令牌');
  return { id: res.user.id, token: res.token.token, email, profileName };
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

/** 把 system_settings 里的全局模式清回未设置（恢复默认 single），避免污染共享 PG 库 */
async function resetGlobalMode(dialect: Dialect): Promise<void> {
  const db = env(dialect).db;
  await db
    .run(`DELETE FROM system_settings WHERE key = ${ph(dialect, 0)}`, ['PROFILE_MODE'])
    .catch(() => undefined);
}

for (const { label, enabled } of dialects) {
  const skip = !enabled;

  test(`adminProfileMode: 全局端点仅超管可用，L2 可读当前模式与统计（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const normal = await seedUser(label, 'user');
      const adminUser = await seedUser(label, 'admin');
      const superUser = await seedUser(label, 'super_admin');
      created.push(normal.id, adminUser.id, superUser.id);

      for (const [who, user] of [
        ['等级0', normal],
        ['等级1', adminUser],
      ] as const) {
        const get = await api(label, '/api/admin/profile-mode', { token: user.token });
        assert.equal(get.status, 403, `${who} 读全局模式应被拒`);
        assert.equal(get.body.error, 'FORBIDDEN');

        const put = await api(label, '/api/admin/profile-mode', {
          method: 'PUT',
          token: user.token,
          body: { mode: 'multi' },
        });
        assert.equal(put.status, 403, `${who} 切全局模式应被拒`);
        assert.equal(put.body.error, 'FORBIDDEN');
      }

      const detail = await api(label, '/api/admin/profile-mode', { token: superUser.token });
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.mode, 'single', '未设置时默认 single');
      assert.equal(detail.body.stats.totalUsers >= 3, true, '统计应包含本次造的账号');
      assert.equal(typeof detail.body.stats.multiActiveUsers, 'number');
      assert.equal(typeof detail.body.stats.undecidedUsers, 'number');
    } finally {
      await cleanup(label, created);
      await resetGlobalMode(label);
    }
  });

  test(`adminProfileMode: 切 multi 全量生效（副本刷平 + 注册初值跟全局 + 可加角色），幂等（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const normal = await seedUser(label, 'user');
      const superUser = await seedUser(label, 'super_admin');
      created.push(normal.id, superUser.id);

      // 切到 multi
      const put = await api(label, '/api/admin/profile-mode', {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'multi' },
      });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal(put.body.mode, 'multi');
      assert.equal(put.body.ok, true);

      // 既有用户的模式副本被刷平：个人视角已是 multi、可加角色
      const mine = await api(label, '/api/me/profile-mode', { token: normal.token });
      assert.equal(mine.status, 200);
      assert.equal(mine.body.mode, 'multi');
      assert.equal(mine.body.activeLimit, 10);
      const added = await api(label, '/api/profiles', {
        method: 'POST',
        token: normal.token,
        body: { name: randomName() },
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));

      // 注册初值跟全局：multi 站点的新账号直接是 multi
      const fresh = await seedUser(label, 'user');
      created.push(fresh.id);
      const freshState = await api(label, '/api/me/profile-mode', { token: fresh.token });
      assert.equal(freshState.body.mode, 'multi', '注册初值应读取全局设置');
      const freshAdd = await api(label, '/api/profiles', {
        method: 'POST',
        token: fresh.token,
        body: { name: randomName() },
      });
      assert.equal(freshAdd.status, 201, 'multi 全局下新账号应能直接加角色');

      // 幂等：重复设同一模式不报错、不产生副作用
      const again = await api(label, '/api/admin/profile-mode', {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'multi' },
      });
      assert.equal(again.status, 200);
      assert.equal(again.body.mode, 'multi');

      // 无效模式值 → 400
      const bad = await api(label, '/api/admin/profile-mode', {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'chaos' },
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'VALIDATION_ERROR');
    } finally {
      await cleanup(label, created);
      await resetGlobalMode(label);
    }
  });

  test(`adminProfileMode: 切 single 强制多 ID 账号选择保留者；锁定名对所有人显示占用（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const normal = await seedUser(label, 'user'); // 将拥有 2 个 ID
      const single = await seedUser(label, 'user'); // 只有 1 个 ID（对照组）
      const adminUser = await seedUser(label, 'admin');
      const superUser = await seedUser(label, 'super_admin');
      created.push(normal.id, single.id, adminUser.id, superUser.id);

      // 全局 multi 下给 normal 加第 2 个角色
      await api(label, '/api/admin/profile-mode', {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'multi' },
      });
      const secondName = randomName();
      const added = await api(label, '/api/profiles', {
        method: 'POST',
        token: normal.token,
        body: { name: secondName },
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      const keepId = added.body.profile.id as string;

      // 切回 single：normal（2 个活跃 ID）进入待选择；single/admin/超管不受影响
      const back = await api(label, '/api/admin/profile-mode', {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'single' },
      });
      assert.equal(back.status, 200, JSON.stringify(back.body));
      assert.equal(back.body.mode, 'single');
      assert.equal(back.body.stats.multiActiveUsers >= 1, true);

      const normalState = await api(label, '/api/me/profile-mode', { token: normal.token });
      assert.equal(normalState.body.mode, 'single');
      assert.equal(normalState.body.decisionRequired, true, '多 ID 账号应待选择');
      const singleState = await api(label, '/api/me/profile-mode', { token: single.token });
      assert.equal(singleState.body.decisionRequired, false, '单 ID 账号不受影响');

      // 待选择期间写操作被 409 拦
      const blocked = await api(label, '/api/profiles', {
        method: 'POST',
        token: normal.token,
        body: { name: randomName() },
      });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error, 'MODE_CHOICE_REQUIRED');

      // 已决定的账号连「选择」端点都进不去（403）——它只服务待选择账号
      const decidedTry = await api(label, '/api/me/profile-mode', {
        method: 'POST',
        token: single.token,
        body: {},
      });
      assert.equal(decidedTry.status, 403);
      assert.equal(decidedTry.body.error, 'FORBIDDEN');

      // 待选择账号提交保留者 → 200；原第一个角色转锁定、30 天窗口启动
      const firstProfileId = (await env(label).profiles.listActiveByUserId(normal.id))[0]!.id;
      const decide = await api(label, '/api/me/profile-mode', {
        method: 'POST',
        token: normal.token,
        body: { keepProfileId: keepId },
      });
      assert.equal(decide.status, 200, JSON.stringify(decide.body));
      assert.equal(decide.body.decisionRequired, false);
      assert.equal(decide.body.activeCount, 1);
      assert.equal(decide.body.reservedCount, 1, '未选中的 ID 应转锁定');
      assert.notEqual(decide.body.cooldownUntil, null, '2 个可用 ID 缩到 1 个，窗口应启动');

      // 锁定名对所有人显示占用（含匿名批量查询 —— 第十一批推翻 0003 口径）
      const lookup = await api(label, '/api/profiles/minecraft', {
        method: 'POST',
        body: [secondName],
      });
      assert.equal(lookup.status, 200);
      assert.equal(
        Array.isArray(lookup.body) && lookup.body.some((p: any) => p.name === secondName),
        true,
        `锁定的 ID 应出现在批量查询里：${JSON.stringify(lookup.body)}`,
      );

      // 锁定名也挡注册/改名（既有行为，回归确认）
      await assert.rejects(
        () =>
          env(label).identity.register({
            email: `pm-${label}-conflict-${randomUUID().slice(0, 6)}@test.local`,
            password: PASSWORD,
            profileName: secondName,
          }),
        (err: any) => err.code === 'NAME_TAKEN',
        '用被锁定的角色名注册应被 NAME_TAKEN 拒绝',
      );
    } finally {
      await cleanup(label, created);
      await resetGlobalMode(label);
    }
  });

  test(`adminProfileMode: 预留口启用不受全局切换影响，冷却内 MODE_COOLDOWN（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const normal = await seedUser(label, 'user');
      const superUser = await seedUser(label, 'super_admin');
      created.push(normal.id, superUser.id);

      // multi → 加一个 → single → 选保留第二个
      await api(label, '/api/admin/profile-mode', {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'multi' },
      });
      const second = await api(label, '/api/profiles', {
        method: 'POST',
        token: normal.token,
        body: { name: randomName() },
      });
      assert.equal(second.status, 201);
      const keepId = second.body.profile.id as string;
      await api(label, '/api/admin/profile-mode', {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'single' },
      });
      const decide = await api(label, '/api/me/profile-mode', {
        method: 'POST',
        token: normal.token,
        body: { keepProfileId: keepId },
      });
      assert.equal(decide.status, 200);

      // 冷却内启用锁定的第一个角色：被 MODE_COOLDOWN 拦（不是 FORBIDDEN ——
      // 预留口与全局切换是两条独立规则，前者对所有人可用）
      const firstId = (await env(label).profiles.listReservedByUserId(normal.id))[0]!.id;
      const activate = await api(label, `/api/me/profiles/${firstId}/activate`, {
        method: 'POST',
        token: normal.token,
      });
      assert.equal(activate.status, 403);
      assert.equal(activate.body.error, 'MODE_COOLDOWN');
    } finally {
      await cleanup(label, created);
      await resetGlobalMode(label);
    }
  });
}
