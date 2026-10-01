import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
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
import { PluginRegistry } from '../src/plugins/registry.js';
import type { PluginManifest } from '../src/plugins/api.js';
import { PluginImporter } from '../src/plugins/importer.js';
import { canonicalString, sign } from '../src/plugins/hmac.js';
import { emitPluginEvent } from '../src/plugins/events.js';
import { goodRepo, startFakeGitHub } from './support/fakeGitHub.js';

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
  importer?: PluginImporter;
}

async function startHttp(
  t: TestContext,
  db: DatabaseConnection,
  opts: {
    withHost: boolean;
    pluginDir?: string;
    /** 给了就同时建一个指向假 GitHub 的导入器，用来跑「预览→安装→启用→入口」全链路 */
    importerBases?: { apiBase: string; rawBase: string };
  },
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
  const pluginDir = opts.pluginDir ?? FIXTURE_DIR;
  const host = opts.withHost
    ? new PluginHost({
        db,
        settings: settingRepository,
        siteUrlResolver: siteUrl,
        tokenService,
        profileRepository,
        publicKeyPem: () => rsaKeyPair.publicKeyPem,
        buildTextureProperty: async (profileId: string) => {
          const state = await profileRepository.findTextureState(profileId);
          if (!state) return null;
          const { buildForProfile } = await import('../src/yggdrasil/buildForProfile.js');
          const prop = buildForProfile(
            new TextureProfileBuilder(rsaKeyPair.privateKeyPem),
            state,
            new AssetUrlResolver(storage),
          );
          return { value: prop.value, signature: prop.signature ?? null };
        },
        pluginDir,
        now: () => new Date(),
      })
    : undefined;
  const importer = opts.importerBases
    ? new PluginImporter({
        pluginDir,
        now: () => new Date(),
        apiBase: opts.importerBases.apiBase,
        rawBase: opts.importerBases.rawBase,
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
    pluginImporter: importer,
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
  return { baseUrl: `http://127.0.0.1:${port}`, db, host, importer };
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
    const cat = await call(ctx, '/api/bindings', { headers: auth((await register(ctx)).token) });
    assert.equal(cat.status, 501, `未启用时绑定页目录回 501 说明原因：${cat.status} ${cat.text}`);
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

    // 启停台账：一次成功的停用不该记成 error，一次点击也不该留下两行同名 enable。
    // 面板把这张表当作「装了什么、谁动的、挂上没有」的唯一凭据。
    const log = await ctx.host!.log();
    assert.equal(
      log.filter((e) => e.pluginId === 'demo_link' && e.action === 'enable').length,
      1,
      '按下启用只记一条意图',
    );
    assert.ok(
      log.some((e) => e.pluginId === 'demo_link' && e.action === 'load'),
      '加载成功要单独记一条结果',
    );
    assert.ok(
      log.some((e) => e.pluginId === 'demo_link' && e.action === 'disable'),
      '停用要有记录',
    );
    assert.ok(
      log.some((e) => e.pluginId === 'demo_link' && e.action === 'unload'),
      '卸载应记成 unload',
    );
    assert.ok(
      !log.some((e) => e.pluginId === 'demo_link' && e.action === 'error' && /停用/.test(e.detail ?? '')),
      '正常卸载不该记成 error',
    );

    // 设置：manifest 只带 key/default，**当前值**在 GET .../settings 里。
    // 面板曾经只渲染 manifest，于是表单永远显示成「什么都没配」。
    const put = await call(ctx, '/api/admin/plugins/demo_link/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ LINK_TTL_SECONDS: 600 }),
    });
    assert.equal(put.status, 200, put.text);
    const loaded = await call(ctx, '/api/admin/plugins/demo_link/settings', { headers: auth(admin.token) });
    assert.equal(loaded.status, 200, loaded.text);
    const ttl = (loaded.json.settings as { key: string; value?: unknown }[]).find(
      (s) => s.key === 'LINK_TTL_SECONDS',
    );
    assert.equal(ttl?.value, 600, '保存后要读得回当前值');

    // 清空数字框提交的是 ''：`Number('')` 会得到 0，那是把有效期悄悄改成 0
    const cleared = await call(ctx, '/api/admin/plugins/demo_link/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ LINK_TTL_SECONDS: '' }),
    });
    assert.equal(cleared.status, 200, cleared.text);
    const after = await call(ctx, '/api/admin/plugins/demo_link/settings', { headers: auth(admin.token) });
    assert.equal(
      (after.json.settings as { key: string; value?: unknown }[]).find((s) => s.key === 'LINK_TTL_SECONDS')
        ?.value,
      600,
      '空串按「没改」处理，不能落成 0',
    );
  });

  /**
   * 「重载」到底能做什么：重跑 setup 可以，换掉已导入的模块不行。
   *
   * tsx 的解析器会把 `file:` URL 上的 query / hash 归一掉（实测 `?v=1` 与不带 query
   * 拿到同一个模块对象），所以磁盘上的代码改了也换不进正在运行的进程。
   * 面板不能在这种情况下报「重载成功」—— 那会让人以为新代码已经生效。
   * 这里用「入口 mtime 变了、而 import 回来的还是同一个模块」判定 stale。
   */
  test(`plugins: 重载只重跑 setup，换不掉模块时必须标 stale（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    // 改文件必须在临时副本上做：夹具目录是 git 里的资产
    const dir = await mkdtemp(join(tmpdir(), 'mcsts-plugin-reload-'));
    const copy = join(dir, 'plugins');
    await cp(FIXTURE_DIR, copy, { recursive: true });
    const ctx = await startHttp(t, db, { withHost: true, pluginDir: copy });

    const admin = await register(ctx);
    await promoteSuper(ctx, admin.userId);
    const enable = await call(ctx, '/api/admin/plugins/demo_link/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
    });
    assert.equal(enable.status, 200, enable.text);

    const entry = join(copy, 'demo_link', 'index.ts');
    await writeFile(entry, `${await readFile(entry, 'utf8')}\n// 重载用例改过的一行\n`, 'utf8');
    // mtime 显式推到未来，不靠「写入总该比导入晚几毫秒」这种时序运气
    const future = new Date(Date.now() + 60_000);
    await utimes(entry, future, future);

    const reload = await call(ctx, '/api/admin/plugins/demo_link/reload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
    });
    assert.equal(reload.status, 200, reload.text);
    assert.equal(reload.json.staleCode, true, '磁盘代码已变而模块没换，要标 stale 而不是重载成功');

    const again = await call(ctx, '/api/admin/plugins/demo_link/reload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
    });
    assert.equal(again.json.staleCode, true, '连续重载不能把 stale 标记洗掉');

    // 但插件确实还活着：setup 重跑过，入口照常服务
    assert.equal((await call(ctx, '/api/plugins/demo_link/ping')).status, 200);
  });

  /**
   * 导入的全链路：空目录 → 预览 → 安装 → 启用 → 入口真的能服务。
   *
   * 单独成一条是因为 `tests/pluginImport.test.ts` 只验导入器自己的判断，
   * 而「装完之后站点能不能用起来」跨了四五个接缝（路由、扫描、台账、加载器）。
   * 用户口径是「需要得知实际使用是否可行才可以正式投放仓库」，这条就是那个答案。
   */
  test(`plugins: 导入端到端 —— 预览→安装→启用→入口可用（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const sandbox = await mkdtemp(join(tmpdir(), 'mcsts-import-e2e-'));
    const pluginsDir = join(sandbox, 'plugins');
    await mkdir(pluginsDir, { recursive: true });

    const repo = goodRepo('import_e2e');
    const gh = await startFakeGitHub(repo);
    t.after(() => gh.close());

    const ctx = await startHttp(t, db, {
      withHost: true,
      pluginDir: pluginsDir,
      importerBases: { apiBase: gh.apiBase, rawBase: gh.rawBase },
    });
    const admin = await register(ctx);
    await promoteSuper(ctx, admin.userId);
    const json = { 'content-type': 'application/json' };

    // 起点：插件目录是空的，一个都没有
    assert.equal((await ctx.host!.listStatuses()).length, 0, '测试实例应当从空目录开始');

    const preview = await call(ctx, '/api/admin/plugins/import/preview', {
      method: 'POST',
      headers: { ...json, ...auth(admin.token) },
      body: JSON.stringify({ repo: 'https://github.com/acme/demo-plugin.git' }),
    });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.json.preview.manifest.id, 'import_e2e');
    assert.equal(preview.json.preview.tag, 'v0.1.0', '请求里没有 tag 字段：版本要由后端自动识别');
    assert.equal(preview.json.preview.marker.ok, true, '识别代号标记应当核对通过');

    // 没带 sha 就不给装：预览与安装之间必须钉住同一份 commit
    const blind = await call(ctx, '/api/admin/plugins/import', {
      method: 'POST',
      headers: { ...json, ...auth(admin.token) },
      body: JSON.stringify({ repo: 'https://github.com/acme/demo-plugin.git' }),
    });
    assert.equal(blind.status, 400, '缺 sha 的安装请求要被拒');

    const install = await call(ctx, '/api/admin/plugins/import', {
      method: 'POST',
      headers: { ...json, ...auth(admin.token) },
      body: JSON.stringify({ repo: 'https://github.com/acme/demo-plugin.git', sha: preview.json.preview.sha }),
    });
    assert.equal(install.status, 200, install.text);
    assert.equal(install.json.files, 3, 'manifest + 入口 + README');

    const imported = (await ctx.host!.listStatuses()).find((item) => item.id === 'import_e2e');
    assert.equal(imported?.state, 'disabled', '导入只到「发现」，不自动启用');
    assert.ok(
      (await ctx.host!.log()).some((item) => item.action === 'import' && item.pluginId === 'import_e2e'),
      '台账要留下导入记录',
    );

    const enable = await call(ctx, '/api/admin/plugins/import_e2e/enable', {
      method: 'POST',
      headers: { ...json, ...auth(admin.token) },
    });
    assert.equal(enable.status, 200, enable.text);

    const ping = await call(ctx, '/api/plugins/import_e2e/ping');
    assert.equal(ping.status, 200, ping.text);
    assert.equal(ping.json.plugin, 'import_e2e', '装进来的插件要真能服务请求');

    // 来源记录跟着落盘，面板与事后排查都靠它
    const provenance = JSON.parse(
      await readFile(join(pluginsDir, 'import_e2e', '.mcsts-import.json'), 'utf8'),
    ) as { repo: string; tag: string; sha: string };
    assert.deepEqual(
      [provenance.repo, provenance.tag, provenance.sha],
      ['acme/demo-plugin', 'v0.1.0', preview.json.preview.sha],
    );
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
    /**
     * 夹具的 `/bindings` 回的是**全表**（它只是个测试替身，没有按调用者过滤），
     * 而 PostgreSQL 用例共用同一个库、插件表不会在建库时清空 —— 于是「长度等于 1」
     * 实际上是在断言「这台机器上一次跑干净过」。按 subject 取自己那条来断言：
     * 要验的本来就是「绑定落在这个角色上、远端身份是 xuid-1、且只有一条」。
     */
    const mine = (bindings.json.bindings as { subject: string; remote: string }[]).filter(
      (row) => row.subject === admin.profileId,
    );
    assert.equal(mine.length, 1, '每个角色一条绑定，重复绑定不该另起一行');
    assert.equal(mine[0]?.remote, 'xuid-1');
    assert.equal(mine[0]?.subject, admin.profileId, '绑定要落在角色上，不是用户上');

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

  test(`plugins: 通用绑定页 —— 核心验属、统一入口与形态契约（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const ctx = await startHttp(t, db, { withHost: true });
    const admin = await register(ctx);
    await promoteSuper(ctx, admin.userId);
    const other = await register(ctx);

    const userAuth = auth(admin.token);
    const jsonHeaders = { 'content-type': 'application/json' };

    // PostgreSQL 用例共用同一个库：启停意图存在 system_settings 里，前面用例留下的
    // 「demo_link 已启用」会在本用例 boot 时自动加载进目录。开头先把要用的插件归零，
    // 结尾再复位 —— 断言「目录为空」才不是在赌这台机器上次跑干净了。
    for (const id of ['demo_link', 'demo_binding_missing', 'demo_binding_badresult', 'demo_binding_undeclared', 'demo_binding_claim_no_input', 'demo_binding_issue_off', 'demo_binding_issue_off_handler']) {
      await ctx.host!.disable(id, admin.userId).catch(() => undefined);
    }
    t.after(async () => {
      for (const id of ['demo_link', 'demo_binding_missing', 'demo_binding_badresult', 'demo_binding_issue_off']) {
        await ctx.host!.disable(id, admin.userId).catch(() => undefined);
      }
    });

    // ---- 发现目录：玩家侧「绑定」区靠它决定显示什么 ----
    const anonCatalog = await call(ctx, '/api/bindings');
    assert.equal(anonCatalog.status, 401, '目录含插件名与描述，未登录不该给');
    const emptyCatalog = await call(ctx, '/api/bindings', { headers: auth(admin.token) });
    assert.equal(emptyCatalog.status, 200, emptyCatalog.text);
    assert.deepEqual(emptyCatalog.json.bindings, [], '启用的绑定插件为零时目录为空');

    await ctx.host!.enable('demo_link', admin.userId);
    await ctx.host!.setHookSecret('demo_link', HOOK_SECRET, admin.userId);
    const catalog = await call(ctx, '/api/bindings', { headers: auth(admin.token) });
    const entry = (catalog.json.bindings as Record<string, unknown>[]).find(
      (item) => item.pluginId === 'demo_link',
    );
    assert.ok(entry, `目录里应有 demo_link：${catalog.text}`);
    assert.equal(entry.subject, 'profile', '页面据此决定是否给角色选择器');
    assert.equal(entry.revocable, true, '登记了 revoke 才有解绑按钮');
    assert.equal(entry.claimable, true, '登记了 claim 才有申请输入框');
    assert.equal(
      (entry.input as { pattern?: string }).pattern,
      '^[0-9]{6,21}$',
      '目录要把 input 声明带给页面（前端按它做即时格式提示）',
    );

    // 站点公钥经 ctx.site.publicKeyPem() 暴露（夹具把它报在 /ping 里）——伴生插件验签证用
    const ping = await call(ctx, '/api/plugins/demo_link/ping');
    assert.equal(ping.json.hasPublicKey, true, '测试台装配了真实 RSA 密钥对，公钥必须可读');

    // ctx.textures.buildProperty：角色不存在 → null；存在 → 签名 property（无皮肤时 textures 为空对象）
    const texUnknown = await call(ctx, `/api/plugins/demo_link/tex?profileId=00000000-0000-0000-0000-000000000000`, {
      headers: userAuth,
    });
    assert.equal(texUnknown.status, 200, texUnknown.text);
    assert.equal(texUnknown.json.property, null, '查不到的角色应回 null 而不是报错');
    const texMine = await call(ctx, `/api/plugins/demo_link/tex?profileId=${admin.profileId}`, {
      headers: userAuth,
    });
    assert.equal(texMine.status, 200, texMine.text);
    assert.equal(typeof texMine.json.property?.value, 'string');
    assert.equal(typeof texMine.json.property?.signature, 'string', '测试台有私钥，property 必须已签名');
    const payload = JSON.parse(Buffer.from(texMine.json.property.value, 'base64').toString('utf8'));
    assert.equal(payload.profileName, admin.name, 'value 里的身份要和角色对得上');

    // ---- issue：归属判定在核心，不在插件 ----
    const anonIssue = await call(ctx, '/api/plugins/demo_link/binding/issue', { method: 'POST' });
    assert.equal(anonIssue.status, 401);
    const noProfile = await call(ctx, '/api/plugins/demo_link/binding/issue', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({}),
    });
    assert.equal(noProfile.status, 400, `subject=profile 缺 profileId 必须 400：${noProfile.text}`);
    const foreignProfile = await call(ctx, '/api/plugins/demo_link/binding/issue', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: other.profileId }),
    });
    assert.equal(foreignProfile.status, 403, '拿别人的角色必须被核心挡住，插件根本看不到这次调用');

    const issued = await call(ctx, '/api/plugins/demo_link/binding/issue', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: admin.profileId }),
    });
    assert.equal(issued.status, 200, issued.text);
    assert.match(issued.json.code, /^[A-Z2-9]{8}$/, '绑定页要显示能在游戏里手输的短码');
    assert.ok(!Number.isNaN(Date.parse(issued.json.expiresAt)), 'expiresAt 供页面倒计时');

    // ---- 服务器侧消费码（复用 HMAC 链路）→ 绑定出现在列表里 ----
    const bindPath = '/api/plugins/demo_link/hooks/bind';
    const ts = String(Date.now());
    const nonce = `np-${Date.now()}`;
    const body = { token: issued.json.code, remote: 'xuid-page-1' };
    const signature = sign(
      canonicalString({ timestamp: ts, nonce, method: 'POST', path: bindPath, body }),
      HOOK_SECRET,
    );
    const bound = await call(ctx, bindPath, {
      method: 'POST',
      headers: {
        ...jsonHeaders,
        'X-MCSTS-Timestamp': ts,
        'X-MCSTS-Nonce': nonce,
        'X-MCSTS-Signature': signature,
      },
      body: JSON.stringify(body),
    });
    assert.equal(bound.status, 200, bound.text);

    const list = await call(
      ctx,
      `/api/plugins/demo_link/binding?profileId=${admin.profileId}`,
      { headers: userAuth },
    );
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.pluginId, 'demo_link');
    assert.equal(list.json.subject, 'profile');
    const row = (list.json.bindings as Record<string, unknown>[]).find(
      (item) => item.id === 'xuid-page-1',
    );
    assert.ok(row, `列表里应有刚绑定的行：${list.text}`);
    const fields = row.fields as { label: string; value: string }[];
    assert.equal(fields[0]?.value, 'xuid-page-1', 'fields 是页面渲染的键值对');
    assert.equal(typeof row.boundAt, 'string');
    assert.match(String(list.json.instructions), /{{code}}/, '指令文案带 {{code}} 占位，页面负责替换');

    // ---- 解绑：只有网页侧能自助；revoke 没登记 / 缺参都有明确回话 ----
    const noBindingId = await call(ctx, '/api/plugins/demo_link/binding/revoke', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: admin.profileId }),
    });
    assert.equal(noBindingId.status, 400, `缺 bindingId 必须 400：${noBindingId.text}`);
    const revoked = await call(ctx, '/api/plugins/demo_link/binding/revoke', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: admin.profileId, bindingId: 'xuid-page-1' }),
    });
    assert.equal(revoked.status, 200, revoked.text);
    const afterRevoke = await call(
      ctx,
      `/api/plugins/demo_link/binding?profileId=${admin.profileId}`,
      { headers: userAuth },
    );
    assert.equal(afterRevoke.status, 200, afterRevoke.text);
    assert.deepEqual(afterRevoke.json.bindings, [], '解绑后列表应回到空');

    // ---- 申请制（claim）：网页提交值 → 待确认 → 服务器实测进服时签发 ----
    const claimBadPattern = await call(ctx, '/api/plugins/demo_link/binding/claim', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: admin.profileId, value: 'not-a-number' }),
    });
    assert.equal(claimBadPattern.status, 400, `pattern 由核心预校验：${claimBadPattern.text}`);
    const claimForeign = await call(ctx, '/api/plugins/demo_link/binding/claim', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: other.profileId, value: '1234567890' }),
    });
    assert.equal(claimForeign.status, 403, 'claim 同样吃核心的归属校验');
    const claimed = await call(ctx, '/api/plugins/demo_link/binding/claim', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: admin.profileId, value: '1234567890' }),
    });
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(typeof claimed.json.message, 'string', '插件回执文案原样透传');
    const pendingList = await call(
      ctx,
      `/api/plugins/demo_link/binding?profileId=${admin.profileId}`,
      { headers: userAuth },
    );
    assert.equal(pendingList.json.bindings[0]?.status, 'pending', '申请后应是待确认');

    const confirmPath = '/api/plugins/demo_link/hooks/confirm';
    const cts = String(Date.now());
    const cnonce = `nc-${Date.now()}`;
    const cbody = { remote: '1234567890' };
    const csign = sign(
      canonicalString({ timestamp: cts, nonce: cnonce, method: 'POST', path: confirmPath, body: cbody }),
      HOOK_SECRET,
    );
    const confirmed = await call(ctx, confirmPath, {
      method: 'POST',
      headers: {
        ...jsonHeaders,
        'X-MCSTS-Timestamp': cts,
        'X-MCSTS-Nonce': cnonce,
        'X-MCSTS-Signature': csign,
      },
      body: JSON.stringify(cbody),
    });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.json.ok, true);
    assert.equal(confirmed.json.subject, admin.profileId, '签发要返回申请落在哪个角色');
    const activeList = await call(
      ctx,
      `/api/plugins/demo_link/binding?profileId=${admin.profileId}`,
      { headers: userAuth },
    );
    assert.equal(activeList.json.bindings[0]?.status, 'active', '进服确认后应签发为生效');
    await call(ctx, '/api/plugins/demo_link/binding/revoke', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: admin.profileId, bindingId: '1234567890' }),
    });

    // 没登记 claim 的插件：claim 端点 501（demo_binding_badresult 只有 list/issue）
    await ctx.host!.enable('demo_binding_badresult', admin.userId);
    const claimUnsupported = await call(ctx, '/api/plugins/demo_binding_badresult/binding/claim', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ value: '123456' }),
    });
    assert.equal(claimUnsupported.status, 501, `未登记 claim 不该有得提交：${claimUnsupported.text}`);

    // ---- 声明了 binding 却没登记实现：503 说明原因，而不是无声 404 ----
    await ctx.host!.enable('demo_binding_missing', admin.userId);
    const missingList = await call(ctx, '/api/plugins/demo_binding_missing/binding', {
      headers: userAuth,
    });
    assert.equal(missingList.status, 503, `声明未实现要 503 带说明：${missingList.text}`);
    assert.match(String(missingList.json.message), /ctx\.binding/, '报错要指名插件没登记实现');
    const catalogAfterMissing = await call(ctx, '/api/bindings', { headers: auth(admin.token) });
    assert.ok(
      !(catalogAfterMissing.json.bindings as Record<string, unknown>[]).some(
        (item) => item.pluginId === 'demo_binding_missing',
      ),
      '没有实现的插件不该出现在玩家侧目录里',
    );

    // ---- 返回形态违背契约：核心收口成 PLUGIN_BAD_RESULT，页面不会渲染半坏列表 ----
    await ctx.host!.enable('demo_binding_badresult', admin.userId);
    const badList = await call(ctx, '/api/plugins/demo_binding_badresult/binding', {
      headers: userAuth,
    });
    assert.equal(badList.status, 500, `list() 返回不合契约要报错而不是渲染半坏页面：${badList.text}`);
    assert.equal(badList.json.error, 'PLUGIN_BAD_RESULT');
    assert.match(String(badList.json.message), /list\(\).*bindings\[0\]\.id/, '文案要指名哪个插件哪个函数哪一行数据');
    const badIssue = await call(ctx, '/api/plugins/demo_binding_badresult/binding/issue', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({}),
    });
    assert.equal(badIssue.status, 500, badIssue.text);
    assert.match(String(badIssue.json.message), /issue\(\) 返回形态/, 'issue 的形态校验与 list 分开报错');

    // ---- 没声明 binding 就调 ctx.binding()：拒载（声明可核对绑定页同样生效）----
    const undeclaredEnable = await call(ctx, '/api/admin/plugins/demo_binding_undeclared/enable', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
    });
    assert.equal(undeclaredEnable.status, 500, '未声明就登记绑定必须拒载');
    assert.match(
      String((undeclaredEnable.json as { message?: string }).message ?? ''),
      /没有声明 binding/,
      undeclaredEnable.text,
    );
    // 没声明 input 就登记 claim()：同一条「声明可核」也管输入框
    const claimNoInputEnable = await call(ctx, '/api/admin/plugins/demo_binding_claim_no_input/enable', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
    });
    assert.equal(claimNoInputEnable.status, 500, '未声明 input 就登记 claim 必须拒载');
    assert.match(
      String((claimNoInputEnable.json as { message?: string }).message ?? ''),
      /binding 没声明 input/,
      claimNoInputEnable.text,
    );

    // ---- binding.issue=false：纯申请制的完整契约 ----
    const issueOffEnable = await call(ctx, '/api/admin/plugins/demo_binding_issue_off/enable', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
    });
    assert.equal(issueOffEnable.status, 200, issueOffEnable.text);
    const offCatalog = await call(ctx, '/api/bindings', { headers: auth(admin.token) });
    const offEntry = (offCatalog.json.bindings as Record<string, unknown>[]).find(
      (item) => item.pluginId === 'demo_binding_issue_off',
    );
    assert.ok(offEntry, 'issue:false 的插件照样进目录（申请制入口还在）');
    assert.equal(offEntry.issuable, false, '声明 issue:false → 目录 issuable=false，页面收起生成码按钮');
    const offIssue = await call(ctx, '/api/plugins/demo_binding_issue_off/binding/issue', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: admin.profileId }),
    });
    assert.equal(offIssue.status, 501, 'issue:false 时核心路由必须 501，而不是跑到不存在的处理器');
    const offClaim = await call(ctx, '/api/plugins/demo_binding_issue_off/binding/claim', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
      body: JSON.stringify({ profileId: admin.profileId, value: '6500001112223334' }),
    });
    assert.equal(offClaim.status, 200, offClaim.text);
    const offListBefore = await call(
      ctx,
      `/api/plugins/demo_binding_issue_off/binding?profileId=${admin.profileId}`,
      { headers: auth(admin.token) },
    );
    assert.equal(offListBefore.json.bindings.length, 1, 'claim 后应有一条待确认');
    // 角色被换下（多→单 / 单模式换 ID）→ 插件收到事件丢弃绑定，XUID 释放
    emitPluginEvent('profile.reserved', { userId: admin.userId, profileId: admin.profileId, name: admin.name });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const offListAfter = await call(
      ctx,
      `/api/plugins/demo_binding_issue_off/binding?profileId=${admin.profileId}`,
      { headers: auth(admin.token) },
    );
    assert.equal(offListAfter.json.bindings.length, 0, 'profile.reserved 必须送达插件并丢弃该角色的绑定');

    // 反向：声明了 issue:false 还登记 issue() → 死代码，拒载
    const offHandlerEnable = await call(ctx, '/api/admin/plugins/demo_binding_issue_off_handler/enable', {
      method: 'POST',
      headers: { ...jsonHeaders, ...userAuth },
    });
    assert.equal(offHandlerEnable.status, 500, 'issue:false 却登记 issue() 必须拒载');
    assert.match(
      String((offHandlerEnable.json as { message?: string }).message ?? ''),
      /issue:false/,
      offHandlerEnable.text,
    );
    const catalogFinal = await call(ctx, '/api/bindings', { headers: auth(admin.token) });
    assert.ok(
      !(catalogFinal.json.bindings as Record<string, unknown>[]).some(
        (item) => item.pluginId === 'demo_binding_undeclared',
      ),
      '拒载的插件不该进目录',
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

/**
 * 启停台账的留存期：15 天。
 *
 * 这张表存在 `system_settings` 的单个键里，条目数还有上限 —— 不剪时间，
 * 两周前的记录会把「刚才那次启用有没有成」挤出面板。它是排障工具，不是审计档案。
 */
test('plugins: 启停台账最多留 15 天', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-plugin-log-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
  try {
    let clock = new Date('2026-04-01T00:00:00.000Z');
    const registry = new PluginRegistry(new SettingRepository(db), () => new Date(clock));
    const manifest = {
      id: 'log_probe',
      name: '台账探针',
      version: '0.1.0',
      apiVersion: 1,
      main: 'index.ts',
    } as PluginManifest;

    await registry.discovered([manifest]);
    assert.equal((await registry.read()).log.length, 1, '发现时记一条');

    // 14 天 23 小时：还在留存期内，不能被剪
    clock = new Date('2026-04-15T23:00:00.000Z');
    await registry.setEnabled('log_probe', true, 'actor-1');
    assert.ok(
      (await registry.read()).log.some((item) => item.action === 'discover'),
      '未满 15 天的记录要留着',
    );

    // 超期之后，任何一次写入都要把过期的整表清掉
    clock = new Date('2026-04-20T00:00:00.000Z');
    await registry.setEnabled('log_probe', false, 'actor-1');
    const log = (await registry.read()).log;
    assert.ok(
      !log.some((item) => item.action === 'discover'),
      `超过 15 天的记录要被剪掉，实际剩 ${JSON.stringify(log.map((i) => i.action))}`,
    );
    assert.ok(log.every((item) => item.action === 'enable' || item.action === 'disable'));
  } finally {
    await db.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
