import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
import { SettingRepository, PUBLIC_SETTING_KEYS } from '../src/repositories/settingRepository.js';
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { FavoriteRepository } from '../src/repositories/favoriteRepository.js';
import { LocalDiskStorage, blobStorageKey } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { sha256Hex } from '../src/util/crypto.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * P4 管理后台补齐 + 站点设置持久化。
 *
 * 覆盖：
 *  - /api/settings/public 匿名可读、白名单裁剪
 *  - /api/admin/settings  管理员读写、upsert 覆盖、键名校验
 *  - /api/admin/assets    全量列表（含 private/pending，公开库看不见）
 *  - PATCH /api/admin/assets/:id 管理员编辑元数据
 *
 * 双方言：SQLite 恒跑；PostgreSQL 由 TEST_DATABASE_URL 门控。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'password123';

interface Env {
  db: DatabaseConnection;
  baseUrl: string;
  tokenService: TokenService;
  close: () => Promise<void>;
}

async function buildEnv(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-admin-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  const config: AppConfig = {
    dialect: 'sqlite',
    sqlitePath: join(dir, 't.db'),
    migrationsRoot: SCHEMA_DIR,
    uploadDir: join(dir, 'uploads'),
    publicBaseUrl: 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: join(dir, 'keys', 'yggdrasil.pem'),
    skinDomains: ['localhost'],
  };
  const storage = new LocalDiskStorage(config.uploadDir, config.publicBaseUrl);
  const rsaKeyPair = loadOrCreateKeyPair(config.rsaPrivateKeyPath);
  const tokenService = new TokenService(new TokenRepository(db));
  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const assets = new AssetRepository(db);
  const blobs = new BlobRepository(db);
  const resolver = new AssetUrlResolver(storage);

  const deps: AppDependencies = {
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity: new IdentityService({
      db,
      users,
      profiles,
      tokens: tokenService,
      sessions: new MinecraftSessionRepository(db),
    }),
    profileRepository: profiles,
    assetRepository: assets,
    minecraftSessions: new MinecraftSessionRepository(db),
    textureBuilder: new TextureProfileBuilder(rsaKeyPair.privateKeyPem),
    assetUrlResolver: resolver,
    textures: new TextureService({ db, storage, blobs, assets, profiles }),
    library: new LibraryService({
      assets,
      favorites: new FavoriteRepository(db),
      blobs,
      users,
      resolver,
    }),
    settings: new SettingRepository(db),
  };

  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    tokenService,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** 插入一条素材（含其 blob），返回 assetId */
async function seedAsset(
  db: DatabaseConnection,
  opts: {
    ownerUserId: string;
    kind: 'skin' | 'cape';
    name: string;
    visibility: 'private' | 'public';
    downloadPolicy: 'owner_only' | 'public';
    reviewStatus: 'pending' | 'approved' | 'rejected';
  },
): Promise<string> {
  const ph = (i: number) => (db.dialect === 'postgres' ? `$${i + 1}` : '?');
  const assetId = randomUUID();
  const blobId = randomUUID();
  const sha = sha256Hex(`blob-${assetId}`);
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO blobs (id, sha256, storage_key, content_type, byte_size, width, height, created_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7].map(ph).join(', ')})`,
    [blobId, sha, blobStorageKey(sha), 'image/png', 128, 64, 64, now],
  );
  await db.run(
    `INSERT INTO assets (id, owner_user_id, kind, blob_id, model_type, name, description,
       license, visibility, download_policy, review_status, created_at, updated_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(ph).join(', ')})`,
    [
      assetId,
      opts.ownerUserId,
      opts.kind,
      blobId,
      // assets_model_shape 约束：cape 必须 model_type IS NULL，skin 必须 default/slim
      opts.kind === 'cape' ? null : 'default',
      opts.name,
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

/** 注册一个用户并返回其 id + token */
async function seedUser(
  env: Env,
  email: string,
  role: 'user' | 'admin' | 'super_admin',
): Promise<{ id: string; token: string }> {
  const identity = new IdentityService({
    db: env.db,
    users: new UserRepository(env.db),
    profiles: new ProfileRepository(env.db),
    tokens: env.tokenService,
    sessions: new MinecraftSessionRepository(env.db),
  });
  const res = await identity.register({
    email,
    password: PASSWORD,
    profileName: `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  });
  if (role !== 'user') {
    // requireAuth 的角色来自 findByHashWithUser（实时查库），故无需重签 token
    await new UserRepository(env.db).updateAdminFields(
      res.user.id,
      { role },
      new Date(),
    );
  }
  return { id: res.user.id, token: res.token.token };
}

interface Ctx extends Env {
  userToken: string;
  adminToken: string;
  adminId: string;
  userId: string;
  privateSkinId: string;
  pendingCapeId: string;
  publicSkinId: string;
}

const ctx: { sqlite?: Ctx } = {};
/** 与 ctx.sqlite 指向同一对象；单独保存一份，保证播种失败时也能关闭服务 */
let envRef: Env | undefined;

async function setupDialect(env: Env): Promise<Ctx> {
  const user = await seedUser(env, `user-${randomUUID()}@test.local`, 'user');
  const admin = await seedUser(env, `admin-${randomUUID()}@test.local`, 'admin');
  const privateSkinId = await seedAsset(env.db, {
    ownerUserId: user.id,
    kind: 'skin',
    name: 'Private Skin',
    visibility: 'private',
    downloadPolicy: 'owner_only',
    reviewStatus: 'approved',
  });
  const pendingCapeId = await seedAsset(env.db, {
    ownerUserId: user.id,
    kind: 'cape',
    name: 'Pending Cape',
    visibility: 'public',
    downloadPolicy: 'public',
    reviewStatus: 'pending',
  });
  const publicSkinId = await seedAsset(env.db, {
    ownerUserId: admin.id,
    kind: 'skin',
    name: 'Public Skin',
    visibility: 'public',
    downloadPolicy: 'public',
    reviewStatus: 'approved',
  });
  return {
    ...env,
    userToken: user.token,
    adminToken: admin.token,
    adminId: admin.id,
    userId: user.id,
    privateSkinId,
    pendingCapeId,
    publicSkinId,
  };
}

before(async () => {
  const env = await buildEnv();
  // 先登记：若下面的播种抛错，after 仍能关闭 HTTP 服务（否则进程挂住不退出）
  envRef = env;
  ctx.sqlite = await setupDialect(env);
});

after(async () => {
  await envRef?.close();
});

/** 取当前方言环境（本文件目前只跑 SQLite；PG 由 TEST_DATABASE_URL 另行门控） */
function env(): Ctx {
  if (!ctx.sqlite) throw new Error('env not ready');
  return ctx.sqlite;
}

async function api(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${env().baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ---------------------------------------------------------------------------
// 站点设置
// ---------------------------------------------------------------------------

test('settings: 未设置时公开端点返回空对象', async () => {
  const res = await api('/api/settings/public');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {});
});

test('settings: 匿名不能读写管理端点', async () => {
  assert.equal((await api('/api/admin/settings')).status, 401);
  assert.equal(
    (await api('/api/admin/settings', { method: 'PUT', body: { SITE_TITLE: 'x' } })).status,
    401,
  );
});

test('settings: 普通用户访问管理端点 → 403', async () => {
  const res = await api('/api/admin/settings', { token: env().userToken });
  assert.equal(res.status, 403);
});

test('settings: 管理员保存后公开端点回读，类型保真', async () => {
  const payload = {
    SITE_TITLE: '测试站点',
    LIGHT_BG_OVERLAY_OPACITY: 0.35,
    VIDEO_MUTED: true,
    ENABLE_CAPTCHA: false,
  };
  const saved = await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: payload,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved, 4);

  const pub = await api('/api/settings/public');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.SITE_TITLE, '测试站点');
  assert.equal(pub.body.LIGHT_BG_OVERLAY_OPACITY, 0.35);
  assert.equal(pub.body.VIDEO_MUTED, true);
  assert.equal(pub.body.ENABLE_CAPTCHA, false);
});

test('settings: 重复 PUT 为 upsert，不产生重复行', async () => {
  await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: { SITE_TITLE: '第一次' },
  });
  await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: { SITE_TITLE: '第二次' },
  });
  const pub = await api('/api/settings/public');
  assert.equal(pub.body.SITE_TITLE, '第二次');

  const rows = await env().db.query<Record<string, unknown>>(
    'SELECT COUNT(*) AS c FROM system_settings WHERE key = ?',
    ['SITE_TITLE'],
  );
  assert.equal(Number(rows[0]!['c']), 1);
});

test('settings: 非白名单键不出现在公开端点，但管理端可见', async () => {
  await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: { INTERNAL_SECRET_NOTE: 'do-not-expose' },
  });
  const pub = await api('/api/settings/public');
  assert.equal(pub.body.INTERNAL_SECRET_NOTE, undefined);

  const all = await api('/api/admin/settings', { token: env().adminToken });
  assert.equal(all.status, 200);
  assert.equal(all.body.INTERNAL_SECRET_NOTE, 'do-not-expose');
});

test('settings: 请求体非对象 / 键名超长 → 400', async () => {
  const notObject = await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: ['a', 'b'],
  });
  assert.equal(notObject.status, 400);
  assert.equal(notObject.body.error, 'VALIDATION_ERROR');

  const tooLong = await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: { ['K'.repeat(80)]: 1 },
  });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, 'VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 管理端全量素材列表
// ---------------------------------------------------------------------------

test('admin assets: 匿名 401 / 普通用户 403', async () => {
  assert.equal((await api('/api/admin/assets')).status, 401);
  assert.equal(
    (await api('/api/admin/assets', { token: env().userToken })).status,
    403,
  );
});

test('admin assets: 可见 private 与 pending 全部素材', async () => {
  const res = await api('/api/admin/assets', { token: env().adminToken });
  assert.equal(res.status, 200);
  const items = res.body.items as any[];
  assert.equal(res.body.total, 3);
  assert.equal(items.length, 3);
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes(env().privateSkinId));
  assert.ok(ids.includes(env().pendingCapeId));
  assert.ok(ids.includes(env().publicSkinId));

  // 公开库（真实路径是 /api/library，不是 /api/library/assets）只应看到已审核公开皮肤
  const pub = await api('/api/library');
  assert.equal(pub.status, 200);
  const pubIds = (pub.body.items as any[]).map((i) => i.id);
  assert.ok(!pubIds.includes(env().privateSkinId));
  assert.ok(!pubIds.includes(env().pendingCapeId));
  assert.ok(pubIds.includes(env().publicSkinId));
});

test('admin assets: 条目含 visibility / downloadPolicy / reviewStatus', async () => {
  const res = await api('/api/admin/assets', { token: env().adminToken });
  const item = (res.body.items as any[])[0];
  assert.ok('visibility' in item);
  assert.ok('downloadPolicy' in item);
  assert.ok('reviewStatus' in item);
  assert.ok('ownerUserId' in item);
});

test('admin assets: kind / status / search 过滤', async () => {
  const capes = await api('/api/admin/assets?kind=cape', { token: env().adminToken });
  assert.deepEqual(
    (capes.body.items as any[]).map((i) => i.kind),
    ['cape'],
  );
  const pending = await api('/api/admin/assets?status=pending', { token: env().adminToken });
  assert.deepEqual(
    (pending.body.items as any[]).map((i) => i.id),
    [env().pendingCapeId],
  );
  const searched = await api('/api/admin/assets?search=private', {
    token: env().adminToken,
  });
  assert.deepEqual(
    (searched.body.items as any[]).map((i) => i.id),
    [env().privateSkinId],
  );
});

test('admin assets: 分页生效', async () => {
  const page1 = await api('/api/admin/assets?page=1&pageSize=2', { token: env().adminToken });
  assert.equal((page1.body.items as any[]).length, 2);
  assert.equal(page1.body.total, 3);
  const page2 = await api('/api/admin/assets?page=2&pageSize=2', { token: env().adminToken });
  assert.equal((page2.body.items as any[]).length, 1);
});

// ---------------------------------------------------------------------------
// 管理员编辑素材
// ---------------------------------------------------------------------------

async function readAsset(id: string): Promise<Record<string, unknown>> {
  const rows = await env().db.query<Record<string, unknown>>(
    `SELECT name, description, license, visibility, download_policy, admin_warning, ai_generated
     FROM assets WHERE id = ?`,
    [id],
  );
  return rows[0]!;
}

test('admin assets: PATCH 编辑元数据并落库', async () => {
  const res = await api(`/api/admin/assets/${env().privateSkinId}`, {
    method: 'PATCH',
    token: env().adminToken,
    body: {
      name: 'Renamed Skin',
      description: '被管理员改写过',
      license: 'CC-BY-SA-4.0',
      visibility: 'public',
      downloadPolicy: 'public',
      adminWarning: '请注意来源',
      aiGenerated: true,
    },
  });
  assert.equal(res.status, 204);

  const row = await readAsset(env().privateSkinId);
  assert.equal(row['name'], 'Renamed Skin');
  assert.equal(row['description'], '被管理员改写过');
  assert.equal(row['license'], 'CC-BY-SA-4.0');
  assert.equal(row['visibility'], 'public');
  assert.equal(row['download_policy'], 'public');
  assert.equal(row['admin_warning'], '请注意来源');
  assert.ok(row['ai_generated'] === 1 || row['ai_generated'] === true);
});

test('admin assets: adminWarning 可被清空为 null', async () => {
  const res = await api(`/api/admin/assets/${env().privateSkinId}`, {
    method: 'PATCH',
    token: env().adminToken,
    body: { adminWarning: null, aiGenerated: false },
  });
  assert.equal(res.status, 204);
  const row = await readAsset(env().privateSkinId);
  assert.equal(row['admin_warning'], null);
  assert.ok(row['ai_generated'] === 0 || row['ai_generated'] === false);
});

test('admin assets: 非法 visibility / downloadPolicy → 400', async () => {
  const badVis = await api(`/api/admin/assets/${env().privateSkinId}`, {
    method: 'PATCH',
    token: env().adminToken,
    body: { visibility: 'weird' },
  });
  assert.equal(badVis.status, 400);
  assert.equal(badVis.body.error, 'VALIDATION_ERROR');

  const badPolicy = await api(`/api/admin/assets/${env().privateSkinId}`, {
    method: 'PATCH',
    token: env().adminToken,
    body: { downloadPolicy: 'everyone' },
  });
  assert.equal(badPolicy.status, 400);
});

test('admin assets: 不存在的素材 → 404', async () => {
  const res = await api('/api/admin/assets/does-not-exist', {
    method: 'PATCH',
    token: env().adminToken,
    body: { name: 'x' },
  });
  assert.equal(res.status, 404);
});

test('admin assets: 普通用户 PATCH → 403', async () => {
  const res = await api(`/api/admin/assets/${env().publicSkinId}`, {
    method: 'PATCH',
    token: env().userToken,
    body: { name: 'hacked' },
  });
  assert.equal(res.status, 403);
  const row = await readAsset(env().publicSkinId);
  assert.equal(row['name'], 'Public Skin');
});

// ---------------------------------------------------------------------------
// PostgreSQL（由 TEST_DATABASE_URL 门控）
// ---------------------------------------------------------------------------

test('admin/settings: PostgreSQL 方言', { skip: TEST_DATABASE_URL ? false : '未设置 TEST_DATABASE_URL' }, async () => {
  const db = PostgresConnection.connect(TEST_DATABASE_URL!);
  await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
  // 清空后再跑一遍同样的仓库级断言（jsonb 转型是这里的关键风险点）
  await db.run('DELETE FROM system_settings');
  const settings = new SettingRepository(db);
  await settings.setMany(
    { SITE_TITLE: 'PG 站点', LIGHT_BG_OVERLAY_OPACITY: 0.5, VIDEO_MUTED: true },
    new Date('2026-01-01T00:00:00.000Z'),
  );
  const pub = await settings.getPublic();
  assert.equal(pub['SITE_TITLE'], 'PG 站点');
  assert.equal(pub['LIGHT_BG_OVERLAY_OPACITY'], 0.5);
  assert.equal(pub['VIDEO_MUTED'], true);

  // upsert 语义
  await settings.setMany({ SITE_TITLE: 'PG 覆盖' }, new Date('2026-01-02T00:00:00.000Z'));
  assert.equal((await settings.getPublic())['SITE_TITLE'], 'PG 覆盖');

  await db.run('DELETE FROM system_settings');
  await db.close();
});

// ---------------------------------------------------------------------------
// 键名口径防回归
//
// 历史缺陷：管理端表单 Form.Item name 写的是 snake_case（site_title），
// 后端 setMany 原样入库，而读取一律走 SCREAMING_SNAKE_CASE（白名单 + 前端 data.SITE_TITLE）
// → 保存返回 200、页面刷新却永远是默认值，且 94 个测试全绿（因为后端测试只用大写键）。
// 下面两项做静态与端到端双重守卫。
// ---------------------------------------------------------------------------

test('settings: 管理端表单键名必须全大写，且访客可见键都在公开白名单内', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = await readFile(
    join(repoRoot, 'web', 'src', 'pages', 'Admin', 'SystemSettings.tsx'),
    'utf8',
  );
  const names = [...src.matchAll(/name="([A-Za-z0-9_]+)"/g)].map((m) => m[1] as string);
  assert.ok(names.length >= 20, `应能提取到全部表单字段名，实际 ${names.length} 个`);

  const lowercase = names.filter((n) => n !== n.toUpperCase());
  assert.deepEqual(lowercase, [], '管理端表单存在非全大写的字段名，写入后读不回来');

  // 访客可见的键必须列入公开白名单，否则 getPublic 不导出 → 前端永远回落默认值
  const mustBePublic = [
    'SITE_TITLE',
    'SITE_DESCRIPTION',
    'SITE_FAVICON',
    'SITE_LOGO',
    'HOMEPAGE_TITLE_TEXT',
    'HOMEPAGE_TEXT',
    'HOMEPAGE_BUTTON_TEXT',
    'HOMEPAGE_BUTTONS',
    'HOMEPAGE_CUSTOM_ENABLED',
    'HOMEPAGE_CUSTOM_HTML',
    'HOMEPAGE_CUSTOM_CSS',
  ];
  for (const key of mustBePublic) {
    assert.ok(
      PUBLIC_SETTING_KEYS.includes(key),
      `${key} 未列入 PUBLIC_SETTING_KEYS，保存后将无法通过 /api/settings/public 回读`,
    );
  }
});

test('settings: 高度自定义首页相关键可保存并经公开端点保真回读', async () => {
  const payload = {
    SITE_LOGO: '/logo.png',
    SITE_FAVICON: '/icon.svg',
    HOMEPAGE_TITLE_TEXT: '欢迎来到',
    HOMEPAGE_TEXT: 'WELCOME',
    HOMEPAGE_BUTTON_TEXT: '进入个人中心',
    HOMEPAGE_BUTTONS: '[{"text":"A","link":"/a"}]',
    HOMEPAGE_CUSTOM_ENABLED: true,
    HOMEPAGE_CUSTOM_HTML: '<section class="my-hero">hello</section>',
    HOMEPAGE_CUSTOM_CSS: '.my-hero{color:red}',
  };
  const saved = await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: payload,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved, Object.keys(payload).length);

  const pub = await api('/api/settings/public');
  assert.equal(pub.status, 200);
  for (const [key, value] of Object.entries(payload)) {
    assert.deepEqual(pub.body[key], value, `${key} 未能经公开端点保真回读`);
  }
});
