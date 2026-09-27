import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { SqliteConnection } from '../src/db/sqlite.js';
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
import { RuntimeSettings, parseOriginList } from '../src/site/runtimeSettings.js';
import { SiteUrlResolver } from '../src/site/siteUrl.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * `/uploads` 的跨源读取控制（Issue #4）。
 *
 * ## 为什么值得单独一批
 *
 * 改动前这里写死 `Access-Control-Allow-Origin: *`，等于对全世界放开「把本站纹理
 * 读进 canvas 原样抠走」。这批把它收敛成白名单回显，风险点全在**接线**上：
 * 回显错了是缓存串味，回显太严是自家站点头像/3D 预览整片图裂 —— 两种都只在
 * 特定来源组合下才复现。所以这里按真实 HTTP 请求逐条断言响应头，而不是只测纯函数。
 *
 * ## 只跑 SQLite
 *
 * 本文件测的是静态资源中间件的响应头，一行 SQL 都不碰（建库只为凑齐 createApp
 * 的依赖），因此不做双方言循环。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

/** 一个最小合法 PNG（1×1 透明像素），只要能让 express.static 真的把文件发出去 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Env {
  baseUrl: string;
  settings: SettingRepository;
  runtime: RuntimeSettings;
  siteUrl: SiteUrlResolver;
  apply: (values: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
}

let env: Env;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcsts-cors-'));
  const db = new SqliteConnection(join(root, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  const uploadDir = join(root, 'uploads');
  await mkdir(join(uploadDir, 'blobs'), { recursive: true });
  await writeFile(join(uploadDir, 'blobs', 'probe.png'), PNG_1X1);

  const config: AppConfig = {
    dialect: 'sqlite',
    sqlitePath: join(root, 't.db'),
    migrationsRoot: SCHEMA_DIR,
    uploadDir,
    publicBaseUrl: 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: join(root, 'keys', 'ygg.pem'),
    skinDomains: ['localhost'],
    // 静态资源限流/缓存都不需要，留空即用内置兜底
    rateLimit: { enabled: false },
  };

  const storage = new LocalDiskStorage(config.uploadDir, config.publicBaseUrl);
  const rsaKeyPair = loadOrCreateKeyPair(config.rsaPrivateKeyPath);
  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const assets = new AssetRepository(db);
  const blobs = new BlobRepository(db);
  const tokenService = new TokenService(new TokenRepository(db));
  const settings = new SettingRepository(db);
  const runtime = new RuntimeSettings({ settings });
  const siteUrl = new SiteUrlResolver({ settings });

  const server = createApp({
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
    runtimeSettings: runtime,
    siteUrlResolver: siteUrl,
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  env = {
    baseUrl: `http://127.0.0.1:${port}`,
    settings,
    runtime,
    siteUrl,
    apply: async (values) => {
      await settings.setMany(values, new Date());
      // 管理端保存设置后两个缓存都会立刻失效，测试要跟真实行为一致
      await Promise.all([runtime.refresh(), siteUrl.refresh()]);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
});

after(async () => {
  await env?.close();
});

/** 请求探针图片，返回状态与两个关键响应头 */
async function probe(origin?: string): Promise<{
  status: number;
  acao: string | null;
  vary: string | null;
}> {
  const res = await fetch(`${env.baseUrl}/uploads/blobs/probe.png`, {
    headers: origin ? { origin } : {},
  });
  // 必须把 body 读完，否则 keep-alive 连接会让后续断言拿到半截响应
  await res.arrayBuffer();
  return {
    status: res.status,
    acao: res.headers.get('access-control-allow-origin'),
    vary: res.headers.get('vary'),
  };
}

// ---------------------------------------------------------------------------
// 纯函数：白名单解析
// ---------------------------------------------------------------------------

test('uploadsCors: 白名单容忍多种写法，并逐项归一化', () => {
  assert.deepEqual(parseOriginList('https://a.test'), ['https://a.test']);
  // 逗号、分号、换行、空格混着写都能拆
  assert.deepEqual(parseOriginList('https://a.test, https://b.test;c.test\nd.test'), [
    'https://a.test',
    'https://b.test',
    'https://c.test',
    'https://d.test',
  ]);
  // 只写域名按 https 补协议；尾斜杠与路径丢掉；重复项去掉
  assert.deepEqual(parseOriginList('https://a.test/uploads/ https://a.test'), ['https://a.test']);
  // JSON 数组形态（管理员用 SQL 直接写库时可能出现）
  assert.deepEqual(parseOriginList(['https://a.test', 'b.test']), [
    'https://a.test',
    'https://b.test',
  ]);
});

test('uploadsCors: 认不出的项丢掉，而不是让整条白名单失效', () => {
  assert.deepEqual(parseOriginList('not a url, https://ok.test, ://bad, https://'), [
    'https://ok.test',
  ]);
  // 非 http(s) 协议绝不能进白名单（file:、javascript: 之类）
  assert.deepEqual(parseOriginList('file:///etc/passwd javascript:alert(1)'), []);
  assert.deepEqual(parseOriginList(''), []);
  assert.deepEqual(parseOriginList(undefined), []);
  assert.deepEqual(parseOriginList(null), []);
});

test('uploadsCors: * 是唯一的「退回全放行」写法', () => {
  assert.deepEqual(parseOriginList('*'), ['*']);
  // * 一旦出现就以它为准，不再看其余项
  assert.deepEqual(parseOriginList('https://a.test, *'), ['*']);
});

// ---------------------------------------------------------------------------
// HTTP：真实响应头
// ---------------------------------------------------------------------------

test('uploadsCors: 文件仍能正常取到，且每个响应都带 Vary: Origin', async () => {
  const hit = await probe();
  assert.equal(hit.status, 200);
  assert.equal(hit.vary, 'Origin');

  const withOrigin = await probe('https://evil.test');
  assert.equal(withOrigin.status, 200, '白名单外只是不给 CORS 头，图片本身仍是公开资源');
  assert.equal(withOrigin.vary, 'Origin');
});

test('uploadsCors: 不带 Origin 的请求不下发 ACAO（热链与启动器取图不受影响）', async () => {
  const res = await probe();
  assert.equal(res.acao, null);
});

test('uploadsCors: 同源请求放行，且不依赖 BASE_URL 是否配置', async () => {
  // 故意不设 BASE_URL：站点根会落到兜底值，此时同源判定必须仍然救回自家站点
  const same = await probe(env.baseUrl);
  assert.equal(same.acao, env.baseUrl, '同源应当回显自己的来源，头像/3D 预览才不会裂');
});

test('uploadsCors: 白名单外的来源拿不到 ACAO，白名单内的按归一化值回显', async () => {
  try {
    await env.apply({ UPLOAD_CORS_ORIGINS: 'https://friend.test, cdn.test' });

    const denied = await probe('https://stranger.test');
    assert.equal(denied.acao, null);

    assert.equal((await probe('https://friend.test')).acao, 'https://friend.test');
    // 裸域名按 https 补齐 → 管理员写 cdn.test 也能匹配 https 站点
    assert.equal((await probe('https://cdn.test')).acao, 'https://cdn.test');
    // 回显的是归一化值，不是请求头原文（带路径/尾斜杠也不能把任意串写进响应）
    assert.equal((await probe('https://FRIEND.test/uploads/')).acao, 'https://friend.test');
  } finally {
    await env.apply({ UPLOAD_CORS_ORIGINS: '' });
  }
});

test('uploadsCors: 站点自身来源（BASE_URL）恒放行，素材挂独立图床时不需要额外配置', async () => {
  try {
    await env.apply({ BASE_URL: 'https://skin.example' });
    assert.equal((await probe('https://skin.example')).acao, 'https://skin.example');
    assert.equal((await probe('https://elsewhere.example')).acao, null);
  } finally {
    await env.apply({ BASE_URL: '' });
  }
});

test('uploadsCors: 配成 * 时退回全放行，但 Vary: Origin 仍在', async () => {
  try {
    await env.apply({ UPLOAD_CORS_ORIGINS: '*' });
    const res = await probe('https://anyone.test');
    assert.equal(res.acao, '*');
    assert.equal(res.vary, 'Origin');
  } finally {
    await env.apply({ UPLOAD_CORS_ORIGINS: '' });
  }
});

test('uploadsCors: 白名单清空即回到最严状态（只有同源与站点根能读）', async () => {
  await env.apply({ UPLOAD_CORS_ORIGINS: '' });
  assert.equal((await probe('https://friend.test')).acao, null);
  assert.equal((await probe(env.baseUrl)).acao, env.baseUrl);
});
