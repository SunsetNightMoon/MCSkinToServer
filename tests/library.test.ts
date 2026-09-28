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
      const dir = await mkdtemp(join(tmpdir(), 'mcsts-lib-'));
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

/** PG 复用 mcsts_smoke_test 库，每个测试前清场（users 级联清 profiles/tokens/assets） */
async function wipeAll(db: DatabaseConnection): Promise<void> {
  await db.run('DELETE FROM profile_assets');
  await db.run('DELETE FROM favorites');
  await db.run('DELETE FROM asset_reviews');
  await db.run('DELETE FROM assets');
  await db.run('DELETE FROM blobs');
  await db.run('DELETE FROM users');
}

async function startHttp(t: TestContext, db: DatabaseConnection): Promise<HttpCtx> {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-lib-http-'));
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
      // 生产里 IdentityService 拿得到 resolver（bootstrap.ts），本测试此前漏了 ——
      // 漏掉的直接后果是 /api/me/skin 永远回 skinUrl:null，看不出素材到底出没出图
      assetUrlResolver: new AssetUrlResolver(storage),
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
    await ctx.db.run(
      `UPDATE users SET role = ${ctx.db.dialect === 'postgres' ? '$1' : '?'}
       WHERE id = ${ctx.db.dialect === 'postgres' ? '$2' : '?'}`,
      ['admin', body.user.id],
    );
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
    await wipeAll(db);
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
    await wipeAll(db);
    const ctx = await startHttp(t, db);
    const owner = await register(ctx);
    const viewer = await register(ctx);
    const admin = await register(ctx, 'admin');
    const assetId = await uploadSkin(ctx, owner.token, 'lib-skin');
    // 领域流程：owner 发布（设为 public）→ admin 审核通过
    await fetch(`${ctx.baseUrl}/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth(owner.token) },
      body: JSON.stringify({ visibility: 'public' }),
    });

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
    await wipeAll(db);
    const ctx = await startHttp(t, db);
    const owner = await register(ctx);
    const admin = await register(ctx, 'admin');

    const goodId = await uploadSkin(ctx, owner.token, 'good-skin');
    const badId = await uploadSkin(ctx, owner.token, 'bad-skin');
    for (const id of [goodId, badId]) {
      // owner 先发布，admin 再审核通过
      await fetch(`${ctx.baseUrl}/api/assets/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...auth(owner.token) },
        body: JSON.stringify({ visibility: 'public' }),
      });
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

  test(`library: 路径 id 非规范 UUID → 404（格式闸门，PG 不再 500）（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);
    const user = await register(ctx);

    // 背景：PG 的 uuid 列收到 `not-a-uuid` 会抛 22P02，之前落到兜底 500；
    // 闸门后与「格式正确但不存在」同响应 404，且与 SQLite 行为一致。
    // 匿名可达端点
    assert.equal((await fetch(`${ctx.baseUrl}/api/library/not-a-uuid`)).status, 404);
    assert.equal((await fetch(`${ctx.baseUrl}/api/assets/not-a-uuid`)).status, 404);
    assert.equal((await fetch(`${ctx.baseUrl}/api/assets/not-a-uuid/download`)).status, 404);
    // favorite-count 语义：目标不存在 → 404（与 getDetail 对齐）
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/not-a-uuid/favorite-count`)).status,
      404,
    );

    // 登录后可达端点
    assert.equal(
      (
        await fetch(`${ctx.baseUrl}/api/assets/not-a-uuid/favorite`, {
          method: 'POST',
          headers: auth(user.token),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${ctx.baseUrl}/api/assets/not-a-uuid/favorite`, {
          method: 'DELETE',
          headers: auth(user.token),
        })
      ).status,
      404,
    );
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/not-a-uuid/is-favorited`, {
        headers: auth(user.token),
      })).status,
      404,
    );

    // 管理端审核入口同样走闸门（素材不存在文案）
    const admin = await register(ctx, 'admin');
    const review = await fetch(`${ctx.baseUrl}/api/admin/assets/not-a-uuid/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(review.status, 404);
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/admin/assets/not-a-uuid/reviews`, {
        headers: auth(admin.token),
      })).status,
      404,
    );

    // 顺带验证：合法但不存在的 UUID 仍是 404（既有行为不回归）
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/assets/00000000-0000-0000-0000-000000000000`)).status,
      404,
    );
  });
  /**
   * 回归：收藏来的素材必须能用到角色上。
   *
   * 线上表现是「收藏皮肤/披风后点使用 → 素材不存在」：`applyToProfile` 按所有权卡
   * （`asset.ownerUserId !== userId` 就 404），而衣柜收藏页里全是别人的素材，于是整条
   * 路径打死。修复后口径：素材是「自己的」或「已公开且过审的」二者之一即可用到自己角色上；
   * 下载策略不参与这里的判断（那是 /download 的口径）。
   */
  test(`library: 收藏的素材可以应用到角色（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);
    const owner = await register(ctx);
    const viewer = await register(ctx);
    const stranger = await register(ctx);
    const admin = await register(ctx, 'admin');

    const assetId = await uploadSkin(ctx, owner.token, 'fav-apply');
    await fetch(`${ctx.baseUrl}/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth(owner.token) },
      body: JSON.stringify({ visibility: 'public' }),
    });
    assert.equal(
      (
        await fetch(`${ctx.baseUrl}/api/admin/assets/${assetId}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth(admin.token) },
          body: JSON.stringify({ status: 'approved' }),
        })
      ).status,
      204,
    );

    const firstProfile = async (token: string): Promise<string> =>
      (
        (
          await (
            await fetch(`${ctx.baseUrl}/api/me/profiles`, { headers: auth(token) })
          ).json()
        ) as { profiles: { id: string }[] }
      ).profiles[0]!.id;

    const apply = (token: string, profileId: string, slot = 'skin', id = assetId) =>
      fetch(`${ctx.baseUrl}/api/assets/${id}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
        body: JSON.stringify({ profileId, slot }),
      });

    const viewerProfile = await firstProfile(viewer.token);
    assert.equal(
      (
        await fetch(`${ctx.baseUrl}/api/assets/${assetId}/favorite`, {
          method: 'POST',
          headers: auth(viewer.token),
        })
      ).status,
      204,
    );
    // 收藏 → 使用：非 owner 也能把别人公开且过审的素材用到自己角色上
    assert.equal((await apply(viewer.token, viewerProfile)).status, 204);

    // 用上之后真的出图，而不是只写了一行绑定
    const mine = (await (
      await fetch(`${ctx.baseUrl}/api/me/skin`, { headers: auth(viewer.token) })
    ).json()) as { skinUrl: string | null };
    assert.ok(mine.skinUrl, '应用到角色后应能取到皮肤 URL');

    // 收藏只是书签，不是授权门槛：没收藏的人同样能用公开且过审的素材
    assert.equal((await apply(stranger.token, await firstProfile(stranger.token))).status, 204);

    // 槽位类型不匹配仍是 400（不能把皮肤当披风用）
    assert.equal((await apply(viewer.token, viewerProfile, 'cape')).status, 400);

    // owner 收回公开后，别人再应用是 404（已绑定的不动，那是既有绑定）
    assert.equal(
      (
        await fetch(`${ctx.baseUrl}/api/assets/${assetId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...auth(owner.token) },
          body: JSON.stringify({ visibility: 'private' }),
        })
      ).status,
      204,
    );
    const latecomer = await register(ctx);
    assert.equal((await apply(latecomer.token, await firstProfile(latecomer.token))).status, 404);
  });
}
