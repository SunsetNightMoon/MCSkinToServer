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
 * P5 第十批：用户名模式「超管专属」规则。
 *
 * 产品规则（用户拍板）：
 * - 自助决定/切换（`POST /api/me/profile-mode`）仅 **super_admin**；
 *   等级 0/1 → 403。读取（GET）不受限 —— 个人中心要显示当前模式。
 * - 等级 0/1 只能「被动接受」：由超管在管理面板代设
 *   （`GET/PUT /api/admin/users/:id/profile-mode`，均仅 super_admin）。
 * - **预留口启用不受本规则影响**（所有用户可用，仍受 30 天冷却约束）——
 *   用例 4 特意断言它被冷却拦下（MODE_COOLDOWN）而不是被新守卫拦下（FORBIDDEN）。
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
  close: () => Promise<void>;
}

const envs: Partial<Record<Dialect, Env>> = {};

async function makeEnv(dialect: Dialect): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), `mscts-pmode-${dialect}-`));
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
): Promise<{ id: string; token: string; email: string }> {
  const e = env(dialect);
  const email = `pm-${dialect}-${randomUUID().replace(/-/g, '').slice(0, 8)}@test.local`;
  const res = await e.identity.register({
    email,
    password: PASSWORD,
    profileName: randomName(),
  });
  if (role !== 'user') {
    await e.users.updateAdminFields(res.user.id, { role }, new Date());
  }
  assert.ok(res.token, '注册应当签发会话令牌');
  return { id: res.user.id, token: res.token.token, email };
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
// 自助切换仅超管
// ============================================================================

for (const { label, enabled } of dialects) {
  const skip = !enabled;

  test(`adminProfileMode: 等级0/1 不能自助切换（403），读取不受限（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const normal = await seedUser(label, 'user');
      const adminUser = await seedUser(label, 'admin');
      created.push(normal.id, adminUser.id);

      for (const [who, user] of [
        ['等级0', normal],
        ['等级1', adminUser],
      ] as const) {
        const read = await api(label, '/api/me/profile-mode', { token: user.token });
        assert.equal(read.status, 200, `${who} 读取模式状态应放行`);
        assert.equal(read.body.mode, 'single');

        const write = await api(label, '/api/me/profile-mode', {
          method: 'POST',
          token: user.token,
          body: { mode: 'multi' },
        });
        assert.equal(write.status, 403, `${who} 自助切换应被拒：${JSON.stringify(write.body)}`);
        assert.equal(write.body.error, 'FORBIDDEN');

        // 状态没有被偷偷改动
        const after = await api(label, '/api/me/profile-mode', { token: user.token });
        assert.equal(after.body.mode, 'single');
      }
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminProfileMode: 超管仍可自助切换（single <-> multi）（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const superUser = await seedUser(label, 'super_admin');
      created.push(superUser.id);

      let res = await api(label, '/api/me/profile-mode', {
        method: 'POST',
        token: superUser.token,
        body: { mode: 'multi' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.mode, 'multi');
      assert.equal(res.body.activeLimit, 10);

      res = await api(label, '/api/me/profile-mode', {
        method: 'POST',
        token: superUser.token,
        body: { mode: 'single' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.mode, 'single');
      assert.equal(res.body.activeLimit, 1);
    } finally {
      await cleanup(label, created);
    }
  });

  // ==========================================================================
  // 面板代设（仅超管）
  // ==========================================================================

  test(`adminProfileMode: 面板端点仅超管可用（等级0/1 → 403）（${label}）`, { skip }, async () => {
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
        const get = await api(label, `/api/admin/users/${normal.id}/profile-mode`, {
          token: user.token,
        });
        assert.equal(get.status, 403, `${who} 查看模式详情应被拒`);
        assert.equal(get.body.error, 'FORBIDDEN');

        const put = await api(label, `/api/admin/users/${normal.id}/profile-mode`, {
          method: 'PUT',
          token: user.token,
          body: { mode: 'multi' },
        });
        assert.equal(put.status, 403, `${who} 代设模式应被拒`);
      }

      const detail = await api(label, `/api/admin/users/${normal.id}/profile-mode`, {
        token: superUser.token,
      });
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.state.mode, 'single');
      assert.equal(detail.body.state.decisionRequired, false);
      assert.equal(detail.body.activeProfiles.length, 1);
      assert.equal(detail.body.reservedProfiles.length, 0);
      assert.ok(detail.body.activeProfiles[0].name, '详情应带角色名供弹窗渲染');
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminProfileMode: 超管代设 single->multi->single（保留指定角色/冷却/转预留）（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const target = await seedUser(label, 'user');
      const superUser = await seedUser(label, 'super_admin');
      created.push(target.id, superUser.id);

      // 1) 代设 multi
      let res = await api(label, `/api/admin/users/${target.id}/profile-mode`, {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'multi' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.state.mode, 'multi');

      // 2) 相同模式 → 400（复用 switchMode 的「当前已是」）
      res = await api(label, `/api/admin/users/${target.id}/profile-mode`, {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'multi' },
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error, 'VALIDATION_ERROR');

      // 3) 目标自己（等级0）仍不能切回 —— 被动接受
      res = await api(label, '/api/me/profile-mode', {
        method: 'POST',
        token: target.token,
        body: { mode: 'single' },
      });
      assert.equal(res.status, 403);

      // 4) 目标在 multi 下再建一个角色
      const extra = await api(label, '/api/profiles', {
        method: 'POST',
        token: target.token,
        body: { name: randomName() },
      });
      assert.equal(extra.status, 201, JSON.stringify(extra.body));
      const keepId = extra.body.profile.id as string;

      // 5) 切回 single 但不指定保留 → 400
      res = await api(label, `/api/admin/users/${target.id}/profile-mode`, {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'single' },
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));

      // 6) 指定保留 → 200：另一个转预留、起 30 天冷却
      res = await api(label, `/api/admin/users/${target.id}/profile-mode`, {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'single', keepProfileId: keepId },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.state.mode, 'single');
      assert.equal(res.body.state.activeCount, 1);
      assert.equal(res.body.state.reservedCount, 1);
      assert.notEqual(res.body.state.cooldownUntil, null);

      // 7) 预留口启用对等级0「仍然可用」——这里被冷却拦下，
      //    错误码必须是 MODE_COOLDOWN（功能可达）而不是 FORBIDDEN（被新守卫拦）
      const listed = await api(label, '/api/me/profiles', { token: target.token });
      const reserved = (listed.body.profiles as Array<{ id: string; status: string }>).find(
        (p) => p.status === 'reserved',
      );
      assert.ok(reserved, '另一个角色应转预留');
      res = await api(label, `/api/me/profiles/${reserved!.id}/activate`, {
        method: 'POST',
        token: target.token,
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'MODE_COOLDOWN');
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminProfileMode: 未首次决定的目标走 decide 路径（旧账号首决）（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const target = await seedUser(label, 'user');
      const superUser = await seedUser(label, 'super_admin');
      created.push(target.id, superUser.id);

      // 造两个可用角色，再把「首次决定」标记清掉 —— 模拟 0003 之前的存量账号
      let res = await api(label, `/api/admin/users/${target.id}/profile-mode`, {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'multi' },
      });
      assert.equal(res.status, 200);
      const extra = await api(label, '/api/profiles', {
        method: 'POST',
        token: target.token,
        body: { name: randomName() },
      });
      assert.equal(extra.status, 201);
      const keepId = extra.body.profile.id as string;

      await env(label).db.run(
        `UPDATE users SET profile_mode_decided_at = NULL WHERE id = ${ph(label, 0)}`,
        [target.id],
      );

      const before = await api(label, '/api/me/profile-mode', { token: target.token });
      assert.equal(before.body.decisionRequired, true, '清掉首决标记后应显示待决定');

      // 代设 single + 指定保留 → 走 decideInitialMode：落 decided_at、另一角色转预留、起冷却
      res = await api(label, `/api/admin/users/${target.id}/profile-mode`, {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'single', keepProfileId: keepId },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.state.mode, 'single');
      assert.equal(res.body.state.decisionRequired, false);
      assert.equal(res.body.state.reservedCount, 1);
      assert.notEqual(res.body.state.decidedAt, null);
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminProfileMode: 目标不存在 404；非法 mode 400（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const target = await seedUser(label, 'user');
      const superUser = await seedUser(label, 'super_admin');
      created.push(target.id, superUser.id);

      let res = await api(label, `/api/admin/users/${randomUUID()}/profile-mode`, {
        token: superUser.token,
      });
      assert.equal(res.status, 404);

      res = await api(label, `/api/admin/users/${target.id}/profile-mode`, {
        method: 'PUT',
        token: superUser.token,
        body: { mode: 'nonsense' },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'VALIDATION_ERROR');
    } finally {
      await cleanup(label, created);
    }
  });

  test(`adminProfileMode: 服务层防御 —— 非超管 actor 被拒（${label}）`, { skip }, async () => {
    const created: string[] = [];
    try {
      const target = await seedUser(label, 'user');
      created.push(target.id);

      for (const role of ['user', 'admin'] as const) {
        await assert.rejects(
          () =>
            env(label).identity.adminSetProfileMode(
              { userId: 'actor', role },
              target.id,
              { mode: 'multi' },
            ),
          (err: any) => err && err.code === 'FORBIDDEN',
          `${role} 调 adminSetProfileMode 应 FORBIDDEN`,
        );
        await assert.rejects(
          () =>
            env(label).identity.adminGetProfileMode({ userId: 'actor', role }, target.id),
          (err: any) => err && err.code === 'FORBIDDEN',
          `${role} 调 adminGetProfileMode 应 FORBIDDEN`,
        );
      }
    } finally {
      await cleanup(label, created);
    }
  });
}
