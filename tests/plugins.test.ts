import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

import { SqliteConnection } from '../src/db/sqlite.js';
import { PostgresConnection } from '../src/db/postgres.js';
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
import { SiteUrlResolver } from '../src/site/siteUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';
import { PluginHost } from '../src/plugins/loader.js';
import { canonicalString, sign } from '../src/plugins/hmac.js';

/**
 * 插件系统（P6 第一批）验收。
 *
 * 夹具插件在 `tests/fixtures/plugins/`，它们**只 import `plugin-api.d.ts` 的类型**，
 * 所以这套测试同时证明「仓库外的作者只靠契约文件就能干活」。哪天夹具被迫去读核心实现
 * 才写得下去，那就是接口有缺口 —— 要补的是接口。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(ROOT, 'schema');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'plugins');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'password123';
const HOOK_SECRET = 'test-hook-secret-0123456789';

interface DialectCase {
  label: string;
  skip?: string;
  setup: (t: TestContext) => Promise<DatabaseConnection>;
}

const cases: DialectCase[] = [
  {
    label: 'sqlite',
    setup: async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mcsts-plugin-'));
      const db = new SqliteConnection(join(dir, 't.db'));
      await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
      t.after(async () => {
        await db.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      });
      return db;
    },
  },
  TEST_DATABASE_URL
    ? {
        label: 'postgres',
        setup: async (t) => {
          const db = PostgresConnection.connect(TEST_DATABASE_URL!);
          await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
          t.after(() => db.close().catch(() => undefined));
          return db;
        },
      }
    : {
        label: 'postgres',
        skip: '未设置 TEST_DATABASE_URL，跳过 PostgreSQL 插件测试',
        setup: async () => {
          throw new Error('unreachable');
        },
      },
];

interface HttpCtx {
  baseUrl: string;
  db: DatabaseConnection;
  host?: PluginHost;
}

async function startHttp(
  t: TestContext,
  db: DatabaseConnection,
  opts: { withHost: boolean },
): Promise<HttpCtx> {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-plugin-http-'));
  const config: AppConfig = {
    dialect: db.dialect,
    sqlitePath: '',
    databaseUrl: db.dialect === 'postgres' ? TEST_DATABASE_URL : undefined,
    migrationsRoot: SCHEMA_DIR,
    uploadDir: join(dir, 'uploads'),
    publicBaseUrl: 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: join(dir, 'keys', 'yggdrasil.pem'),
    skinDomains: ['localhost'],
  };
  const storage = new LocalDiskStorage(config.uploadDir, config.publicBaseUrl);
  const rsaKeyPair = loadOrCreateKeyPair(config.rsaPrivateKeyPath);
  const tokenService = new TokenService(new TokenRepository(db));
  const userRepository = new UserRepository(db);
  const profileRepository = new ProfileRepository(db);
  const assetRepository = new AssetRepository(db);
  const settingRepository = new SettingRepository(db);
  const siteUrl = new SiteUrlResolver({ settings: settingRepository });
  const identity = new IdentityService({
    db,
    users: userRepository,
    profiles: profileRepository,
    tokens: tokenService,
    sessions: new MinecraftSessionRepository(db),
  });
  const host = opts.withHost
    ? new PluginHost({
        db,
        settings: settingRepository,
        siteUrlResolver: siteUrl,
        tokenService,
        pluginDir: FIXTURE_DIR,
        now: () => new Date(),
      })
    : undefined;
  const deps: AppDependencies = {
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity,
    profileRepository,
    assetRepository,
    minecraftSessions: new MinecraftSessionRepository(db),
    textureBuilder: new TextureProfileBuilder(rsaKeyPair.privateKeyPem),
    assetUrlResolver: new AssetUrlResolver(storage),
    textures: new TextureService({
      db,
      storage,
      blobs: new BlobRepository(db),
      assets: assetRepository,
      profiles: profileRepository,
    }),
    library: new LibraryService({
      assets: assetRepository,
      favorites: new FavoriteRepository(db),
      blobs: new BlobRepository(db),
      users: userRepository,
      resolver: new AssetUrlResolver(storage),
    }),
    settings: settingRepository,
    plugins: host,
  };
  if (host) await host.boot();
  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return { baseUrl: `http://127.0.0.1:${port}`, db, host };
}

let seq = 0;

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/**
 * 读一次 body 并同时拿到状态与解析结果。
 *
 * 刻意做成一个函数：把 `assert.equal(res.status, 200, await res.text())` 写开看着省事，
 * 实际是**每次都把 body 读掉**（断言消息是即时求值的），后面再 res.json() 就炸
 * 「Body has already been read」。这类坑一次测试跑一半全红，最难查。
 */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

async function read(res: FetchResponse): Promise<{ status: number; text: string; json: any }> {
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function call(
  ctx: HttpCtx,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; text: string; json: any }> {
  return read(await fetch(`${ctx.baseUrl}${path}`, init));
}

async function register(ctx: HttpCtx): Promise<{
  token: string;
  userId: string;
  profileId: string;
  name: string;
}> {
  seq += 1;
  const made = await call(ctx, '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `plg${seq}-${Date.now()}@test.local`,
      password: PASSWORD,
      profileName: `plg${seq}${Math.random().toString(36).slice(2, 6)}`,
    }),
  });
  assert.equal(made.status, 201, made.text);
  const token = (made.json as { token: string }).token;
  const profiles = await call(ctx, '/api/me/profiles', { headers: auth(token) });
  assert.equal(profiles.status, 200, profiles.text);
  const first = (profiles.json as { profiles: { id: string; name: string }[] }).profiles[0]!;
  return { token, userId: (made.json as { user: { id: string } }).user.id, profileId: first.id, name: first.name };
}

async function promoteSuper(ctx: HttpCtx, userId: string): Promise<void> {
  const ph = (i: number): string => (ctx.db.dialect === 'postgres' ? `$${i + 1}` : '?');
  await ctx.db.run(
    `UPDATE users SET role = ${ph(0)} WHERE id = ${ph(1)}`,
    ['super_admin', userId],
  );
}

for (const c of cases) {
  test(`plugins: 未启用时接口根本不存在（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const ctx = await startHttp(t, db, { withHost: false });
    const ping = await call(ctx, '/api/plugins/demo_link/ping');
    assert.equal(ping.status, 404, '没启用插件系统时这个路径不该存在');
    const admin = await call(ctx, '/api/admin/plugins', { headers: auth((await register(ctx)).token) });
    // 普通用户先被角色门槛挡住；面板因此不会把插件清单泄露给非超管
    assert.ok(admin.status === 401 || admin.status === 403, `status=${admin.status}`);
  });

  test(`plugins: 加载、失败隔离与声明一致性（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const ctx = await startHttp(t, db, { withHost: true });
    const statuses = await ctx.host!.listStatuses();
    const byId = new Map(statuses.map((s) => [s.id, s]));
    assert.equal(byId.get('demo_link')?.state, 'disabled');
    assert.equal(byId.get('demo_link')?.enabled, false, '发现不等于授权：默认一律不启用');

    const admin = await register(ctx);
    await promoteSuper(ctx, admin.userId);

    const enable = await call(ctx, '/api/admin/plugins/demo_link/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
    });
    assert.equal(enable.status, 200, enable.text);

    // 一个插件 setup 抛错：它自己标 error，别的插件照常
    const broken = await call(ctx, '/api/admin/plugins/demo_broken/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
    });
    assert.equal(broken.status, 500, 'setup 抛错必须被拒');
    assert.match(String((broken.json as { message?: string }).message ?? broken.text), /夹具：setup 故意抛错/);
    assert.equal((await call(ctx, '/api/plugins/demo_link/ping')).status, 200, '不能连带打死别的插件');

    // manifest 没声明的入口 → 拒载
    const undeclared = await call(ctx, '/api/admin/plugins/demo_undeclared/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
    });
    assert.equal(undeclared.status, 500);
    assert.match(
      String((undeclared.json as { message?: string }).message ?? undeclared.text),
      /manifest 里没声明/,
      '「声明与实际行为一致」必须是技术落实',
    );

    const disable = await call(ctx, '/api/admin/plugins/demo_link/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
    });
    assert.equal(disable.status, 200, disable.text);
    assert.equal((await call(ctx, '/api/plugins/demo_link/ping')).status, 404, '停用后入口必须消失');
  });

  test(`plugins: 端到端 —— 码 + HMAC 两条证据才成立（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const ctx = await startHttp(t, db, { withHost: true });
    const admin = await register(ctx);
    await promoteSuper(ctx, admin.userId);
    await ctx.host!.enable('demo_link', admin.userId);
    await ctx.host!.setHookSecret('demo_link', HOOK_SECRET, admin.userId);

    const ping = await call(ctx, '/api/plugins/demo_link/ping');
    assert.equal(ping.status, 200, ping.text);
    assert.equal(ping.json.greeting, 'hi', '未设置时应回落到 manifest 的 default');

    const anonymous = await call(ctx, '/api/plugins/demo_link/issue', { method: 'POST' });
    assert.equal(anonymous.status, 401, 'auth:user 的入口必须要求站点会话');

    // 接口缺口实测：web token 不隐含「当前角色」，插件必须自己带上 profileId
    const noProfile = await call(ctx, '/api/plugins/demo_link/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({}),
    });
    assert.equal(noProfile.status, 400, noProfile.text);

    const issued = await call(ctx, '/api/plugins/demo_link/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ profileId: admin.profileId }),
    });
    assert.equal(issued.status, 200, issued.text);
    const token = issued.json.token as string;
    assert.match(token, /^[A-Z2-9]{8}$/, '码要短到能在游戏里手输');

    const bindPath = '/api/plugins/demo_link/hooks/bind';
    const unsigned = await call(ctx, bindPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, remote: 'xuid-1' }),
    });
    assert.equal(unsigned.status, 403, '没有签名的机器回调必须拒');

    const signed = async (
      plain: string,
      nonce: string,
      remote: string,
      secret = HOOK_SECRET,
    ): Promise<{ status: number; text: string; json: any }> => {
      const ts = String(Date.now());
      const body = { token: plain, remote };
      const signature = sign(
        canonicalString({ timestamp: ts, nonce, method: 'POST', path: bindPath, body }),
        secret,
      );
      return call(ctx, bindPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-MCSTS-Timestamp': ts,
          'X-MCSTS-Nonce': nonce,
          'X-MCSTS-Signature': signature,
        },
        body: JSON.stringify(body),
      });
    };

    const bound = await signed(token, 'nonce-aaaa1111', 'xuid-1');
    assert.equal(bound.status, 200, bound.text);

    // 同一枚码第二次必须失败：这就是原子消费的意义
    const reuse = await signed(token, 'nonce-bbbb2222', 'xuid-2');
    assert.equal(reuse.status, 400, '码已消费，不能重复绑定');

    // 换一枚码但重放旧 nonce
    const second = (
      await call(ctx, '/api/plugins/demo_link/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(admin.token) },
        body: JSON.stringify({ profileId: admin.profileId }),
      })
    ).json.token as string;
    assert.equal((await signed(second, 'nonce-aaaa1111', 'xuid-3')).status, 403, 'nonce 窗口内不可重复');

    // 密钥不对 → 403（且不与「码无效」混淆）
    const third = (
      await call(ctx, '/api/plugins/demo_link/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(admin.token) },
        body: JSON.stringify({ profileId: admin.profileId }),
      })
    ).json.token as string;
    assert.equal((await signed(third, 'nonce-cccc3333', 'xuid-4', 'wrong-secret')).status, 403);

    const bindings = await call(ctx, '/api/plugins/demo_link/bindings', { headers: auth(admin.token) });
    assert.equal(bindings.status, 200, bindings.text);
    assert.equal(bindings.json.bindings.length, 1);
    assert.equal(bindings.json.bindings[0].remote, 'xuid-1');
    assert.equal(bindings.json.bindings[0].subject, admin.profileId, '绑定要落在角色上，不是用户上');

    // 事件真的送达
    const before = await call(ctx, '/api/plugins/demo_link/renames', { headers: auth(admin.token) });
    assert.equal(before.status, 200, 'auth:admin 对超管放行');
    const renamed = await call(ctx, `/api/profiles/${admin.profileId}/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ name: `plg${seq}ren${Math.random().toString(36).slice(2, 5)}` }),
    });
    assert.equal(renamed.status, 200, renamed.text);
    const after = await call(ctx, '/api/plugins/demo_link/renames', { headers: auth(admin.token) });
    assert.ok(
      after.json.renameEvents > before.json.renameEvents,
      `改名事件必须送到插件：before=${before.json.renameEvents} after=${after.json.renameEvents}`,
    );
  });
}

test('plugins: manifest 校验拒绝非法 id 与 API 版本不匹配', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-plugin-manifest-'));
  try {
    const { readManifest } = await import('../src/plugins/manifest.js');

    const badId = join(dir, 'Bad-Id');
    await mkdir(badId, { recursive: true });
    await writeFile(
      join(badId, 'mcsts.plugin.json'),
      JSON.stringify({ id: 'Bad-Id', name: 'x', version: '1', apiVersion: 1, main: 'index.ts' }),
    );
    const first = await readManifest(badId);
    assert.equal(first.ok, false);
    if (!first.ok) assert.match(JSON.stringify(first.issues), /必须匹配/);

    const oldApi = join(dir, 'old_api');
    await mkdir(oldApi, { recursive: true });
    await writeFile(
      join(oldApi, 'mcsts.plugin.json'),
      JSON.stringify({ id: 'old_api', name: 'x', version: '1', apiVersion: 99, main: 'index.ts' }),
    );
    const second = await readManifest(oldApi);
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(JSON.stringify(second.issues), /API v99/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
