import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { LocalDiskStorage, blobStorageKey } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { sha256Hex } from '../src/util/crypto.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * 列表接口**直出** `previewUrl`，且拉列表不得影响 `view_count`。
 *
 * ## 这个文件存在的直接原因
 *
 * MCSTS 的列表端点原先只返回裸 `AssetRow`（没有图片地址），而旧版页面必须有缩略图。
 * 于是前端兼容层对**每一项**再调一次 `GET /api/assets/:id` 去补 —— 而那个端点会
 * `incrementViewCount`。后果是「翻一页列表 = 每项浏览数 +1」：
 * 管理员打开素材管理、用户打开自己的衣柜，预览图还没看，浏览量就涨了。
 * 实测一个皮肤被刷到 30（真实访问 0 次）。
 *
 * 修法是把「取图片地址」下沉到列表接口（`LibraryService.withPreviewUrls`），
 * 它**不含任何计数副作用**。所以这里断言的重点是成对的两条：
 *
 * - 列表接口（`/api/me/assets`、`/api/admin/assets`、`/api/admin/reviews`）
 *   必须直出 `previewUrl`，且**反复拉不动 `view_count`**；
 * - 详情接口（`GET /api/assets/:id`）**必须仍然 +1**。
 *   第二条同样重要：修 bug 时最容易顺手把计数一起删掉，那时「浏览数永远是 0」
 *   会比「偏高」更难发现。
 *
 * ## 双方言
 *
 * SQLite 恒跑；PostgreSQL 由 `TEST_DATABASE_URL` 门控（沿用共享库 `mcsts_smoke_test`）。
 * `view_count` 一律用「前后差值」断言，不假定初始为 0。
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
  close: () => Promise<void>;
}

const envs: Partial<Record<Dialect, Env>> = {};

async function makeEnv(dialect: Dialect): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), `mcsts-preview-${dialect}-`));
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
    assetUrlResolver: new AssetUrlResolver(storage),
    textures: new TextureService({ db, storage, blobs, assets, profiles }),
    library: new LibraryService({
      assets,
      favorites: new FavoriteRepository(db),
      blobs,
      users,
      resolver: new AssetUrlResolver(storage),
    }),
    settings: new SettingRepository(db),
  };

  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    dialect,
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    identity: deps.identity,
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
    viewCount?: number;
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
       license, visibility, download_policy, review_status, view_count, created_at, updated_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(ph).join(', ')})`,
    [
      assetId,
      opts.ownerUserId,
      opts.kind,
      blobId,
      // assets_model_shape 约束：cape 必须 model_type IS NULL
      opts.kind === 'cape' ? null : 'default',
      opts.name,
      '',
      'ARR',
      opts.visibility,
      opts.downloadPolicy,
      opts.reviewStatus,
      opts.viewCount ?? 0,
      now,
      now,
    ],
  );
  return assetId;
}

async function seedUser(
  dialect: Dialect,
  role: 'user' | 'admin',
): Promise<{ id: string; token: string }> {
  const e = env(dialect);
  const res = await e.identity.register({
    email: `preview-${randomUUID()}@test.local`,
    password: PASSWORD,
    profileName: `v_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
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

async function viewCountOf(dialect: Dialect, assetId: string): Promise<number> {
  const rows = await env(dialect).db.query<Record<string, unknown>>(
    `SELECT view_count FROM assets WHERE id = ${
      env(dialect).db.dialect === 'postgres' ? '$1' : '?'
    }`,
    [assetId],
  );
  return Number(rows[0]?.['view_count'] ?? -1);
}

async function api(
  dialect: Dialect,
  path: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${env(dialect).baseUrl}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** 一个皮肤/披风「形状是否带图片地址」的判定：必须是可用的字符串 URL */
function assertHasPreviewUrl(item: any, label: string): void {
  assert.equal(
    typeof item?.previewUrl,
    'string',
    `${label} 必须直出 previewUrl（字段缺失 = 前端只能逐项拉详情 = 浏览数被刷高）`,
  );
  assert.ok(
    String(item.previewUrl).includes('/blobs/'),
    `${label} 的 previewUrl 应指向存储对象，实际 ${item.previewUrl}`,
  );
}

// ---------------------------------------------------------------------------
// 列表直出 previewUrl
// ---------------------------------------------------------------------------

for (const { label, enabled } of dialects) {
  test(`[${label}] lists: /api/me/assets 直出 previewUrl（皮肤与披风）`, { skip: !enabled }, async () => {
    const user = await seedUser(label, 'user');
    const skinId = await seedAsset(env(label).db, {
      ownerUserId: user.id,
      kind: 'skin',
      name: `Mine ${randomUUID().slice(0, 8)}`,
      visibility: 'private',
      downloadPolicy: 'owner_only',
      reviewStatus: 'approved',
    });
    const capeId = await seedAsset(env(label).db, {
      ownerUserId: user.id,
      kind: 'cape',
      name: `Mine Cape ${randomUUID().slice(0, 8)}`,
      visibility: 'private',
      downloadPolicy: 'owner_only',
      reviewStatus: 'approved',
    });

    const skins = await api(label, '/api/me/assets?kind=skin', user.token);
    assert.equal(skins.status, 200);
    const mine = skins.body.assets.find((a: any) => a.id === skinId);
    assert.ok(mine, '刚建的皮肤应在自己的列表里');
    assertHasPreviewUrl(mine, '/api/me/assets?kind=skin');

    const capes = await api(label, '/api/me/assets?kind=cape', user.token);
    const myCape = capes.body.assets.find((a: any) => a.id === capeId);
    assert.ok(myCape);
    assertHasPreviewUrl(myCape, '/api/me/assets?kind=cape');
  });

  test(`[${label}] lists: /api/admin/assets 直出 previewUrl（含 private/pending）`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const owner = await seedUser(label, 'user');
    const pendingId = await seedAsset(env(label).db, {
      ownerUserId: owner.id,
      kind: 'skin',
      name: `Pending ${randomUUID().slice(0, 8)}`,
      visibility: 'private',
      downloadPolicy: 'owner_only',
      reviewStatus: 'pending',
    });

    const res = await api(label, '/api/admin/assets?kind=skin&pageSize=200', admin.token);
    assert.equal(res.status, 200);
    const item = res.body.items.find((a: any) => a.id === pendingId);
    assert.ok(item, '待审素材应在管理端列表里');
    assertHasPreviewUrl(item, '/api/admin/assets');
  });

  test(`[${label}] lists: /api/admin/reviews 直出 previewUrl`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const owner = await seedUser(label, 'user');
    const capeId = await seedAsset(env(label).db, {
      ownerUserId: owner.id,
      kind: 'cape',
      name: `Review ${randomUUID().slice(0, 8)}`,
      visibility: 'public',
      downloadPolicy: 'owner_only',
      reviewStatus: 'pending',
    });

    const res = await api(label, '/api/admin/reviews?kind=cape', admin.token);
    assert.equal(res.status, 200);
    const item = res.body.items.find((a: any) => a.id === capeId);
    assert.ok(item, '待审披风应在待审列表里');
    assertHasPreviewUrl(item, '/api/admin/reviews');
  });
}

// ---------------------------------------------------------------------------
// 计数：列表不涨，详情必涨
// ---------------------------------------------------------------------------

for (const { label, enabled } of dialects) {
  test(`[${label}] views: 反复拉三个列表不动 view_count`, { skip: !enabled }, async () => {
    const admin = await seedUser(label, 'admin');
    const owner = await seedUser(label, 'user');
    const publicSkinId = await seedAsset(env(label).db, {
      ownerUserId: owner.id,
      kind: 'skin',
      name: `Viewed ${randomUUID().slice(0, 8)}`,
      visibility: 'public',
      downloadPolicy: 'owner_only',
      reviewStatus: 'approved',
      viewCount: 7,
    });
    const pendingCapeId = await seedAsset(env(label).db, {
      ownerUserId: owner.id,
      kind: 'cape',
      name: `Viewed Cape ${randomUUID().slice(0, 8)}`,
      visibility: 'public',
      downloadPolicy: 'owner_only',
      reviewStatus: 'pending',
      viewCount: 3,
    });

    const skinBefore = await viewCountOf(label, publicSkinId);
    const capeBefore = await viewCountOf(label, pendingCapeId);

    // 各拉三遍：旧行为下这里每拉一次列表，每个可见项就 +1
    for (let i = 0; i < 3; i += 1) {
      await api(label, '/api/me/assets?kind=skin', owner.token);
      await api(label, '/api/admin/assets?kind=skin&pageSize=200', admin.token);
      await api(label, '/api/admin/reviews?kind=cape', admin.token);
    }

    assert.equal(
      await viewCountOf(label, publicSkinId),
      skinBefore,
      '拉列表不得改变 view_count —— 这正是「翻一页列表每项 +1」那个缺陷',
    );
    assert.equal(
      await viewCountOf(label, pendingCapeId),
      capeBefore,
      '待审列表同理',
    );
  });

  test(`[${label}] views: 详情接口仍然 +1（别把计数一起修掉）`, { skip: !enabled }, async () => {
    const owner = await seedUser(label, 'user');
    const assetId = await seedAsset(env(label).db, {
      ownerUserId: owner.id,
      kind: 'skin',
      name: `Detail ${randomUUID().slice(0, 8)}`,
      visibility: 'public',
      downloadPolicy: 'public',
      reviewStatus: 'approved',
      viewCount: 0,
    });

    const before = await viewCountOf(label, assetId);
    const res = await api(label, `/api/assets/${assetId}`);
    assert.equal(res.status, 200);
    assert.equal(
      await viewCountOf(label, assetId),
      before + 1,
      '打开详情页才是「一次浏览」，应 +1',
    );
  });

  test(`[${label}] views: 私有素材的详情不计数（不可见就没有浏览）`, { skip: !enabled }, async () => {
    const owner = await seedUser(label, 'user');
    const assetId = await seedAsset(env(label).db, {
      ownerUserId: owner.id,
      kind: 'skin',
      name: `Private ${randomUUID().slice(0, 8)}`,
      visibility: 'private',
      downloadPolicy: 'owner_only',
      reviewStatus: 'approved',
      viewCount: 0,
    });

    const before = await viewCountOf(label, assetId);
    const res = await api(label, `/api/assets/${assetId}`, owner.token);
    assert.equal(res.status, 200);
    assert.equal(
      await viewCountOf(label, assetId),
      before,
      '非公开可见的素材不该计入浏览数（计入等于把「私有库的翻看」也算成曝光）',
    );
  });
}
