import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import {
  ThemeImageService,
  MAX_THEME_IMAGE_BYTES,
} from '../src/site/themeImage.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * 主题背景图上传/移除（P5 第七批补）。
 *
 * ## 这个文件存在的直接原因
 *
 * 管理后台「主题设置」里那 4 组背景图按钮调的是
 * `POST /api/admin/upload-theme-image?type=…` 与 `DELETE /api/admin/theme-image/:type`，
 * 而**后端从来没有这两个路由**（前端兼容层把它们兜底成 501「敬请期待」）。
 * 展示侧（`LIGHT_BG_IMAGE` 等键在白名单里、前台会读）一直是通的，
 * 所以症状是「设置项能用、按钮没用」—— 比整块功能缺失更难发现。
 *
 * 断言的重点不是「返回了 200」，而是几件只要写错就**没有症状**的事：
 *
 * - **上传必须立刻写设置键**：按钮语义是「换背景」。只落盘不写键 = 上传成功但没生效。
 * - **换图必须删掉上一版**：objectKey 带内容哈希，不删就永远堆在存储里，
 *   而且是那种「不报错、不看目录就发现不了」的堆积。
 * - **必须核对 magic bytes**：只看 Content-Type 的话，把一个 HTML/SVG 存成
 *   `theme/xxx.png` 就能被同源 `open()` 当页面执行 —— 背景图是个 XSS 面。
 * - **移除必须同时清设置键**：只删文件会让前台继续引用一个 404 的地址。
 *
 * ## 双方言
 *
 * SQLite 恒跑；PostgreSQL 由 `TEST_DATABASE_URL` 门控。PG 侧沿用共享库
 * `mcsts_smoke_test`，里面可能已有其他用例的数据，所以不断言「全空」，
 * 每个用例只关心自己那一个设置键、自己那一次上传的对象键。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'password123';

type Dialect = 'sqlite' | 'postgres';

interface Env {
  dialect: Dialect;
  db: DatabaseConnection;
  baseUrl: string;
  config: AppConfig;
  storage: LocalDiskStorage;
  settings: SettingRepository;
  identity: IdentityService;
  tokenService: TokenService;
  /** 用同一份依赖另起一个 app（用于「未注入主题图服务」这类对照） */
  listen: (overrides: Partial<AppDependencies>) => Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }>;
  close: () => Promise<void>;
}

const envs: Partial<Record<Dialect, Env>> = {};

async function makeEnv(dialect: Dialect): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), `mcsts-theme-${dialect}-`));
  const db: DatabaseConnection =
    dialect === 'postgres'
      ? PostgresConnection.connect(TEST_DATABASE_URL!)
      : new SqliteConnection(join(dir, 't.db'));
  await runMigrations(
    db,
    join(SCHEMA_DIR, dialect === 'sqlite' ? 'sqlite' : 'postgresql'),
  );

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
    themeImages: new ThemeImageService({ storage, settings }),
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
    config,
    storage,
    settings,
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

// ---------------------------------------------------------------------------
// 字节样本：只要求「通过 magic bytes」，不需要真的是可解码图片
// ---------------------------------------------------------------------------

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a---', 'utf8');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
const SVG_OK = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
  'utf8',
);

/** 上传一张主题图（原始字节，与前端兼容层转换后发出的请求形状一致） */
async function upload(
  dialect: Dialect,
  type: string,
  bytes: Buffer,
  contentType: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(
    `${env(dialect).baseUrl}/api/admin/upload-theme-image?type=${encodeURIComponent(type)}`,
    { method: 'POST', headers, body: bytes },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function remove(
  dialect: Dialect,
  type: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(
    `${env(dialect).baseUrl}/api/admin/theme-image/${encodeURIComponent(type)}`,
    { method: 'DELETE', headers },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function publicSetting(dialect: Dialect, key: string): Promise<unknown> {
  const res = await fetch(`${env(dialect).baseUrl}/api/settings/public`);
  const body = (await res.json()) as Record<string, unknown>;
  return body[key];
}

/** 由对外 URL 反推磁盘路径（publicBaseUrl 是 `…/uploads`） */
function diskPathOf(dialect: Dialect, url: string): string {
  const key = url.split('/uploads/')[1] ?? '';
  return join(env(dialect).config.uploadDir, key);
}

async function seedUser(
  dialect: Dialect,
  role: 'user' | 'admin',
): Promise<{ id: string; token: string }> {
  const e = env(dialect);
  const res = await e.identity.register({
    email: `theme-${randomUUID()}@test.local`,
    password: PASSWORD,
    profileName: `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  });
  if (role === 'admin') {
    await new UserRepository(e.db).updateAdminFields(
      res.user.id,
      { role },
      new Date(),
    );
  }
  assert.ok(res.token, '注册应当签发会话令牌');
  return { id: res.user.id, token: res.token.token };
}

/** 4 组背景图 + 2 个站点图标：上传按类型走，展示按设置键走 */
const CASES: Array<{ type: string; key: string }> = [
  { type: 'light-bg', key: 'LIGHT_BG_IMAGE' },
  { type: 'dark-bg', key: 'DARK_BG_IMAGE' },
  { type: 'login-bg', key: 'LOGIN_BG_IMAGE' },
  { type: 'login-embed', key: 'LOGIN_EMBED_IMAGE' },
  { type: 'favicon', key: 'SITE_FAVICON' },
  { type: 'logo', key: 'SITE_LOGO' },
];

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

for (const { label, enabled } of dialects) {
  test(`[${label}] theme: 匿名上传/移除一律 401`, { skip: !enabled }, async () => {
    assert.equal((await upload(label, 'light-bg', PNG, 'image/png')).status, 401);
    assert.equal((await remove(label, 'light-bg')).status, 401);
  });

  test(`[${label}] theme: 普通用户不能上传（403，不是 401）`, { skip: !enabled }, async () => {
    const user = await seedUser(label, 'user');
    const before = await publicSetting(label, 'LIGHT_BG_IMAGE');
    const res = await upload(label, 'light-bg', PNG, 'image/png', user.token);
    assert.equal(res.status, 403);
    // 关键：越权请求不能改到站点外观（PG 共享库里有别的用例的残留值，
    // 所以断言的是「前后没变」，不是「等于某个具体值」）
    assert.equal(await publicSetting(label, 'LIGHT_BG_IMAGE'), before);
  });
}

// ---------------------------------------------------------------------------
// 上传：落盘 + 立刻写设置键
// ---------------------------------------------------------------------------

for (const { label, enabled } of dialects) {
  test(`[${label}] theme: 四个背景位 + 两个图标位都能上传，落盘且立刻写进对应设置键`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');

    for (const { type, key } of CASES) {
      const res = await upload(label, type, PNG, 'image/png', admin.token);
      assert.equal(res.status, 201, `${type} 应上传成功：${JSON.stringify(res.body)}`);
      assert.equal(res.body.type, type);
      assert.match(
        String(res.body.url),
        new RegExp(`/theme/${type}-[0-9a-f]{12}\\.png$`),
        `${type} 的对象键应带内容哈希`,
      );

      // ① 字节真的落盘了
      assert.ok(
        existsSync(diskPathOf(label, String(res.body.url))),
        `${type} 的文件应写在磁盘上`,
      );
      // ② 设置键被立刻写入（不用再点「保存」）
      assert.equal(
        await publicSetting(label, key),
        res.body.url,
        `${type} 上传后应立即写进 ${key}`,
      );
    }
  });

  test(`[${label}] theme: 换图会删掉上一版对象，不留垃圾`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const first = await upload(label, 'dark-bg', PNG, 'image/png', admin.token);
    assert.equal(first.status, 201);
    const firstPath = diskPathOf(label, String(first.body.url));
    assert.ok(existsSync(firstPath));

    // 内容不同 → 哈希不同 → objectKey 不同
    const second = await upload(
      label,
      'dark-bg',
      Buffer.concat([PNG, Buffer.from([1, 2, 3, 4, 5])]),
      'image/png',
      admin.token,
    );
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.url, first.body.url);

    assert.ok(
      !existsSync(firstPath),
      '上一版文件应被删除（否则存储只增不减，且不看不出来）',
    );
    assert.ok(existsSync(diskPathOf(label, String(second.body.url))));
    assert.equal(await publicSetting(label, 'DARK_BG_IMAGE'), second.body.url);
  });

  test(`[${label}] theme: 同内容重复上传不报错，指向同一个对象`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const a = await upload(label, 'login-bg', GIF, 'image/gif', admin.token);
    const b = await upload(label, 'login-bg', GIF, 'image/gif', admin.token);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(
      a.body.url,
      b.body.url,
      '内容哈希相同 → objectKey 相同，不必（也不该）删掉自己',
    );
    assert.ok(existsSync(diskPathOf(label, String(a.body.url))));
  });
}

// ---------------------------------------------------------------------------
// 上传：拒绝路径
// ---------------------------------------------------------------------------

for (const { label, enabled } of dialects) {
  test(`[${label}] theme: 拒绝 SVG（同源可执行文档）`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    // 背景图/内嵌图四个位都拒：它们是拿来当「页面」用的，SVG 被打开就是 XSS 面
    for (const bg of ['light-bg', 'dark-bg', 'login-bg', 'login-embed']) {
      for (const ct of ['image/svg+xml', 'text/xml', 'text/html']) {
        const res = await upload(label, bg, SVG, ct, admin.token);
        assert.equal(res.status, 400, `${bg} + ${ct} 必须被拒绝`);
        assert.equal(res.body.error, 'VALIDATION_ERROR');
      }
    }
  });

  test(`[${label}] theme: Content-Type 与字节码不符时拒绝（改后缀绕不过去）`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    // 声明 PNG，实际是 JPEG 头
    const res = await upload(label, 'light-bg', JPEG, 'image/png', admin.token);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'VALIDATION_ERROR');
    // 反过来：声明 JPEG 但内容是文本
    const res2 = await upload(label, 'light-bg', SVG, 'image/jpeg', admin.token);
    assert.equal(res2.status, 400);
  });

  test(`[${label}] theme: 空内容 / 非法 type 都返回 400`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const empty = await upload(
      label,
      'light-bg',
      Buffer.alloc(0),
      'image/png',
      admin.token,
    );
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'VALIDATION_ERROR');

    const bad = await upload(label, 'not-a-type', PNG, 'image/png', admin.token);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'VALIDATION_ERROR');
  });

  test(`[${label}] theme: 服务层拦住超过上限的文件`, { skip: !enabled }, async () => {
    // 走服务层直调：HTTP 层 `raw({limit})` 也会拦，但那条路径抛的是 body-parser
    // 的 413，错误文案不受我们控制；这里验的是「服务层自己也有一道闸」。
    const e = env(label);
    const service = new ThemeImageService({
      storage: e.storage,
      settings: e.settings,
    });
    await assert.rejects(
      () =>
        service.upload(
          'light-bg',
          new Uint8Array(MAX_THEME_IMAGE_BYTES + 1),
          'image/png',
        ),
      (err: any) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 站点图标（favicon / logo）：SVG 与 ICO 只给这两个位用
// ---------------------------------------------------------------------------

for (const { label, enabled } of dialects) {
  test(`[${label}] icon: favicon/logo 收 SVG（含 BOM 与 <svg 开头），写 SITE_* 设置键`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const samples: Array<{ bytes: Buffer; name: string }> = [
      {
        bytes: Buffer.from(
          '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
          'utf8',
        ),
        name: '<?xml 开头的标准 SVG',
      },
      { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'), name: '<svg 开头（无 xml 声明）' },
      {
        bytes: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'),
        ]),
        name: '带 UTF-8 BOM 的 SVG',
      },
    ];
    for (const [type, key] of [
      ['favicon', 'SITE_FAVICON'],
      ['logo', 'SITE_LOGO'],
    ] as const) {
      for (const s of samples) {
        const res = await upload(label, type, s.bytes, 'image/svg+xml', admin.token);
        assert.equal(
          res.status,
          201,
          `${type} + ${s.name} 应上传成功：${JSON.stringify(res.body)}`,
        );
        assert.match(String(res.body.url), /\.svg$/, '扩展名必须是 .svg（不信任文件名）');
        assert.equal(await publicSetting(label, key), res.body.url, `${key} 应被立刻写入`);
      }
    }
  });

  test(`[${label}] icon: favicon 收 ICO（含别名 MIME）；HTML 冒充 SVG 被拒`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    // ICO 魔数：00 00 01 00
    const ico = Buffer.from([0, 0, 1, 0, 1, 0, 0x10, 0x10]);
    let lastUrl = '';
    for (const ct of ['image/x-icon', 'image/vnd.microsoft.icon']) {
      const res = await upload(label, 'favicon', ico, ct, admin.token);
      assert.equal(res.status, 201, `${ct} 应被接受`);
      assert.match(String(res.body.url), /\.ico$/, '扩展名必须是 .ico');
      lastUrl = String(res.body.url);
    }
    // 内容相同 → 哈希相同 → 两次上传指向同一个对象，设置键指向它
    assert.equal(await publicSetting(label, 'SITE_FAVICON'), lastUrl);

    // HTML 冒充：<!DOCTYPE html> 里没有 <svg，必须拒
    const html = Buffer.from(
      '<!DOCTYPE html><html><body><p>not an svg</p></body></html>',
      'utf8',
    );
    const fake = await upload(label, 'favicon', html, 'image/svg+xml', admin.token);
    assert.equal(fake.status, 400, 'HTML 冒充 SVG 必须被拒');
    assert.equal(fake.body.error, 'VALIDATION_ERROR');

    // XHTML（<?xml + <svg）是合法 SVG
    const xhtml = Buffer.from(
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"/>',
      'utf8',
    );
    const ok = await upload(label, 'logo', xhtml, 'image/svg+xml', admin.token);
    assert.equal(ok.status, 201, `XHTML 形式的 SVG 应被接受：${JSON.stringify(ok.body)}`);
  });

  test(`[${label}] icon: 移除 favicon 清键删文件；外链直链只清键不动磁盘`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const up = await upload(label, 'favicon', SVG_OK, 'image/svg+xml', admin.token);
    assert.equal(up.status, 201);
    const path = diskPathOf(label, String(up.body.url));
    assert.ok(existsSync(path));

    const del = await remove(label, 'favicon', admin.token);
    assert.equal(del.status, 200);
    assert.equal(del.body.removed, true);
    assert.equal(await publicSetting(label, 'SITE_FAVICON'), '');
    assert.ok(!existsSync(path), '上传的图标文件应被删除（省空间）');

    // 手填外链：移除只清设置键，磁盘上没有可删的东西
    await env(label).settings.setMany(
      { SITE_LOGO: 'https://cdn.example.com/brand/logo.png' },
      new Date(),
    );
    const del2 = await remove(label, 'logo', admin.token);
    assert.equal(del2.status, 200);
    assert.equal(del2.body.removed, false, '外链没有本服务文件，removed=false');
    assert.equal(await publicSetting(label, 'SITE_LOGO'), '');
  });
}

// ---------------------------------------------------------------------------
// 移除
// ---------------------------------------------------------------------------

for (const { label, enabled } of dialects) {
  test(`[${label}] theme: 移除会清空设置键并删掉文件，重复移除幂等`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const up = await upload(label, 'login-embed', PNG, 'image/png', admin.token);
    assert.equal(up.status, 201);
    const path = diskPathOf(label, String(up.body.url));
    assert.ok(existsSync(path));

    const del = await remove(label, 'login-embed', admin.token);
    assert.equal(del.status, 200);
    assert.equal(del.body.removed, true);
    assert.equal(
      await publicSetting(label, 'LOGIN_EMBED_IMAGE'),
      '',
      '移除后设置键必须是空串 —— 否则前台继续引用一个 404 地址',
    );
    assert.ok(!existsSync(path), '文件应被删除');

    const again = await remove(label, 'login-embed', admin.token);
    assert.equal(again.status, 200);
    assert.equal(again.body.removed, false, '没有文件可删时返回 removed=false，仍应成功');
  });

  test(`[${label}] theme: 设置键指向外部 URL 时移除不炸`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    // 管理员手填的外链（不是本服务上传的）—— 反推 objectKey 会失败
    await env(label).settings.setMany(
      { LIGHT_BG_IMAGE: 'https://cdn.example.com/some/other/bg.png' },
      new Date(),
    );
    const del = await remove(label, 'light-bg', admin.token);
    assert.equal(del.status, 200);
    assert.equal(del.body.removed, false);
    assert.equal(await publicSetting(label, 'LIGHT_BG_IMAGE'), '');
  });

  test(`[${label}] theme: 非法 type 的移除请求返回 400`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const res = await remove(label, 'nope', admin.token);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'VALIDATION_ERROR');
  });
}

// ---------------------------------------------------------------------------
// 可选依赖：未注入主题图服务
// ---------------------------------------------------------------------------

test('theme: 未注入主题图服务时端点回 501（而不是 500）', async () => {
  const e = env('sqlite');
  const admin = await seedUser('sqlite', 'admin');
  const alt = await e.listen({ themeImages: undefined });
  try {
    const res = await fetch(
      `${alt.baseUrl}/api/admin/upload-theme-image?type=light-bg`,
      {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          authorization: `Bearer ${admin.token}`,
        },
        body: PNG,
      },
    );
    assert.equal(res.status, 501);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['error'], 'NOT_IMPLEMENTED');

    const del = await fetch(`${alt.baseUrl}/api/admin/theme-image/light-bg`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(del.status, 501);
  } finally {
    await alt.close();
  }
});
