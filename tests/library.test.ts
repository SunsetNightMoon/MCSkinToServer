import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
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
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * P3 权限矩阵测试（蓝图验收）：
 * - owner/favorite/public/admin 可见性与下载矩阵
 * - 被拒绝素材从公开库与下载消失
 * - 收藏规则：不能收藏自己的素材、真实计数
 * - 审核流水与管理员警告/AI 标记
 * 双方言：SQLite 恒跑；PostgreSQL 由 TEST_DATABASE_URL 门控。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'password123';

interface DialectCase {
  label: string;
  skip?: string;
  setup: (t: TestContext) => Promise<DatabaseConnection>;
}

const cases: DialectCase[] = [
  {
    label: 'sqlite',
    setup: async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mscts-lib-'));
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
        skip: '未设置 TEST_DATABASE_URL，跳过 PostgreSQL 公开库测试',
        setup: async () => {
          throw new Error('unreachable');
        },
      },
];

async function makeSkinPng(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 80, b: 80, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

interface HttpCtx {
  baseUrl: string;
  db: DatabaseConnection;
}

async function startHttp(t: TestContext, db: DatabaseConnection): Promise<HttpCtx> {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-lib-http-'));
  const config: AppConfig = {
    dialect: db.dialect,
    sqlitePath: '',
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
  const deps: AppDependencies = {
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity: new IdentityService({
      db,
      users: userRepository,
      profiles: profileRepository,
      tokens: tokenService,
      sessions: new MinecraftSessionRepository(db),
    }),
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
  };
  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return { baseUrl: `http://127.0.0.1:${port}`, db };
}

let nameSeq = 0;

async function register(ctx: HttpCtx, role: 'user' | 'admin' = 'user'): Promise<{ token: string; userId: string }> {
  nameSeq += 1;
  const email = `lib${nameSeq}-${Date.now()}@test.local`;
  const res = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      profileName: `lib${nameSeq}${Math.random().toString(36).slice(2, 6)}`,
    }),
  });
  const body = (await res.json()) as { token: string; user: { id: string } };
  assert.equal(res.status, 201, `register failed: ${JSON.stringify(body)}`);
  if (role === 'admin') {
    await ctx.db.run('UPDATE users SET role = ?', ['admin']);
  }
  return { token: body.token, userId: body.user.id };
}

async function uploadSkin(ctx: HttpCtx, token: string, name: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/api/assets?kind=skin&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` },
    body: new Uint8Array(await makeSkinPng()),
  });
  assert.equal(res.status, 201, `upload failed: ${await res.clone().text()}`);
  return ((await res.json()) as { asset: { id: string } }).asset.id;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

for (const c of cases) {
  test(`library: 审核前不可见矩阵（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const ctx = await startHttp(t, db);
    const owner = await register(ctx);
    const viewer = await register(ctx);
    const admin = await register(ctx, 'admin');
    const assetId = await uploadSkin(ctx, owner.token, 'pending-skin');

    // 公开库空
    const lib = await fetch(`${ctx.baseUrl}/api/library?kind=skin`);
    assert.equal(((await lib.json()) as { total: number }).total, 0);

    // pending 素材：匿名/普通用户不可见，owner/admin 可见
    assert.equal((await fetch(`${ctx.baseUrl}/api/assets/${assetId}`)).status, 404);
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/${assetId}`, { headers: auth(viewer.token) })).status,
      404,
    );
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/${assetId}`, { headers: auth(owner.token) })).status,
      200,
    );
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/${assetId}`, { headers: auth(admin.token) })).status,
      200,
    );

    // 下载：owner_only 默认策略 → 匿名/viewer 403，owner/admin 200
    const dl = (tok?: string) =>
      fetch(`${ctx.baseUrl}/api/assets/${assetId}/download`, {
        headers: tok ? auth(tok) : undefined,
      });
    assert.equal((await dl()).status, 403);
    assert.equal((await dl(viewer.token)).status, 403);
    assert.equal((await dl(owner.token)).status, 200);
    assert.equal((await dl(admin.token)).status, 200);

    // 审核操作只有 admin 能做
    const review = await fetch(`${ctx.baseUrl}/api/admin/assets/${assetId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(viewer.token) },
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(review.status, 403);

    // admin 通过审核
    const approve = await fetch(`${ctx.baseUrl}/api/admin/assets/${assetId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ status: 'approved', reason: 'ok' }),
    });
    assert.equal(approve.status, 204);
  });

  test(`library: 公开可见/收藏/浏览计数（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const ctx = await startHttp(t, db);
    const owner = await register(ctx);
    const viewer = await register(ctx);
    const admin = await register(ctx, 'admin');
    const assetId = await uploadSkin(ctx, owner.token, 'lib-skin');

    await fetch(`${ctx.baseUrl}/api/admin/assets/${assetId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ status: 'approved' }),
    });

    // 公开库出现（default download_policy=owner_only 不影响"可见"）
    const lib = await fetch(`${ctx.baseUrl}/api/library?kind=skin`);
    const libBody = (await lib.json()) as {
      total: number;
      items: { id: string; previewUrl: string; favoriteCount: number; name: string }[];
    };
    assert.equal(libBody.total, 1);
    assert.equal(libBody.items[0]!.id, assetId);
    assert.ok(libBody.items[0]!.previewUrl.includes('/uploads/blobs/'));
    assert.equal(libBody.items[0]!.name, 'lib-skin');

    // 匿名详情可见，浏览计数递增
    await fetch(`${ctx.baseUrl}/api/assets/${assetId}`);
    const detail = await fetch(`${ctx.baseUrl}/api/assets/${assetId}`);
    const detailBody = (await detail.json()) as {
      asset: { viewCount: number; favoriteCount: number };
      canDownload: boolean;
    };
    assert.equal(detailBody.asset.viewCount, 2);
    assert.equal(detailBody.canDownload, false);

    // 收藏规则：不能收藏自己的；别人的可以；计数真实
    const ownFav = await fetch(`${ctx.baseUrl}/api/assets/${assetId}/favorite`, {
      method: 'POST',
      headers: auth(owner.token),
    });
    assert.equal(ownFav.status, 400);

    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/${assetId}/favorite`, { method: 'POST', headers: auth(viewer.token) })).status,
      204,
    );
    const count = await fetch(`${ctx.baseUrl}/api/assets/${assetId}/favorite-count`);
    assert.equal(((await count.json()) as { count: number }).count, 1);
    assert.equal(
      ((await (await fetch(`${ctx.baseUrl}/api/assets/${assetId}/is-favorited`, { headers: auth(viewer.token) })).json()) as { favorited: boolean }).favorited,
      true,
    );
    const favList = await fetch(`${ctx.baseUrl}/api/me/favorites?kind=skin`, {
      headers: auth(viewer.token),
    });
    assert.equal(((await favList.json()) as { favorites: unknown[] }).favorites.length, 1);

    // 取消收藏 → 0
    await fetch(`${ctx.baseUrl}/api/assets/${assetId}/favorite`, {
      method: 'DELETE',
      headers: auth(viewer.token),
    });
    assert.equal(
      ((await (await fetch(`${ctx.baseUrl}/api/assets/${assetId}/favorite-count`)).json()) as { count: number }).count,
      0,
    );

    // owner 公开下载策略 → 匿名可下载，计数 +1
    await fetch(`${ctx.baseUrl}/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth(owner.token) },
      body: JSON.stringify({ downloadPolicy: 'public' }),
    });
    const dl = await fetch(`${ctx.baseUrl}/api/assets/${assetId}/download`);
    assert.equal(dl.status, 200);
    const detail2 = (await (await fetch(`${ctx.baseUrl}/api/assets/${assetId}`)).json()) as {
      asset: { downloadCount: number };
      canDownload: boolean;
    };
    assert.equal(detail2.asset.downloadCount, 1);
    assert.equal(detail2.canDownload, true);
  });

  test(`library: rejected 从公开库/下载消失 + 审核流水/标记（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const ctx = await startHttp(t, db);
    const owner = await register(ctx);
    const admin = await register(ctx, 'admin');

    const goodId = await uploadSkin(ctx, owner.token, 'good-skin');
    const badId = await uploadSkin(ctx, owner.token, 'bad-skin');
    for (const id of [goodId, badId]) {
      await fetch(`${ctx.baseUrl}/api/admin/assets/${id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(admin.token) },
        body: JSON.stringify({ status: 'approved' }),
      });
    }
    await fetch(`${ctx.baseUrl}/api/assets/${badId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth(owner.token) },
      body: JSON.stringify({ downloadPolicy: 'public' }),
    });

    // 拒绝 bad-skin + 打 AI 标记和管理员警告
    const reject = await fetch(`${ctx.baseUrl}/api/admin/assets/${badId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ status: 'rejected', reason: '质量不合格' }),
    });
    assert.equal(reject.status, 204);
    await fetch(`${ctx.baseUrl}/api/admin/assets/${goodId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ aiGenerated: true, adminWarning: '疑似搬运' }),
    });

    // 公开库只剩 good-skin
    const lib = (await (await fetch(`${ctx.baseUrl}/api/library?kind=skin`)).json()) as {
      total: number;
      items: { id: string; aiGenerated: boolean; adminWarning: string | null }[];
    };
    assert.equal(lib.total, 1);
    assert.equal(lib.items[0]!.id, goodId);
    assert.equal(lib.items[0]!.aiGenerated, true);
    assert.equal(lib.items[0]!.adminWarning, '疑似搬运');

    // rejected 不可下载（即使 downloadPolicy=public）
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/${badId}/download`)).status,
      403,
    );
    // rejected 详情 owner 仍可见（但不在公开库）
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/${badId}`, { headers: auth(owner.token) })).status,
      200,
    );

    // 审核流水：bad-skin 两条（approved → rejected）
    const history = await fetch(`${ctx.baseUrl}/api/admin/assets/${badId}/reviews`, {
      headers: auth(admin.token),
    });
    const reviews = ((await history.json()) as { reviews: { status: string }[] }).reviews;
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0]!.status, 'rejected');
    assert.equal(reviews[1]!.status, 'approved');
  });
}
