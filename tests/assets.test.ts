import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { FavoriteRepository } from '../src/repositories/favoriteRepository.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * P2 上传链路测试：PNG/尺寸校验、sha256 去重、应用/摘下槽位、
 * 删除连带清理 blob 与文件、纹理 URL 可访问。
 * 双方言：SQLite 恒跑；PostgreSQL 由 TEST_DATABASE_URL 门控。
 */

// 基于 import.meta.url 定位，避免对进程 cwd 的依赖
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const EMAIL = `skin-${Date.now()}@test.local`;
const PASSWORD = 'password123';

async function makeSkinPng(width = 64, height = 64): Promise<Buffer> {
  // 用真实像素生成 PNG（sharp 也能校验）
  return sharp({
    create: { width, height, channels: 4, background: { r: 120, g: 160, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

interface DialectCase {
  label: string;
  skip?: string;
  setup: (t: TestContext) => Promise<DatabaseConnection>;
}

const cases: DialectCase[] = [
  {
    label: 'sqlite',
    setup: async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mscts-assets-'));
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
        skip: '未设置 TEST_DATABASE_URL，跳过 PostgreSQL 上传链路测试',
        setup: async () => {
          throw new Error('unreachable');
        },
      },
];

interface HttpCtx {
  baseUrl: string;
  db: DatabaseConnection;
}

/** PG 复用 mscts_smoke_test 库，运行前清场（users 级联清 profiles/tokens/assets） */
async function wipeAll(db: DatabaseConnection): Promise<void> {
  await db.run('DELETE FROM profile_assets');
  await db.run('DELETE FROM assets');
  await db.run('DELETE FROM blobs');
  await db.run('DELETE FROM users');
}

async function startHttp(t: TestContext, db: DatabaseConnection): Promise<HttpCtx> {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-assets-http-'));
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
  const profileRepository = new ProfileRepository(db);
  const identity = new IdentityService({
    db,
    users: new UserRepository(db),
    profiles: profileRepository,
    tokens: tokenService,
    sessions: new MinecraftSessionRepository(db),
  });
  const textureService = new TextureService({
    db,
    storage,
    blobs: new BlobRepository(db),
    assets: new AssetRepository(db),
    profiles: profileRepository,
  });
  const assetRepository = new AssetRepository(db);
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
    textures: textureService,
    library: new LibraryService({
      assets: assetRepository,
      favorites: new FavoriteRepository(db),
      blobs: new BlobRepository(db),
      users: new UserRepository(db),
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

async function registerAndGetToken(ctx: HttpCtx, email: string): Promise<{ token: string; profileId: string }> {
  const res = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      // 角色名规则 3-16 位 [A-Za-z0-9_]；截前 8 位 + 随机后缀，保证同一库内多次注册不重名
      profileName: `u_${(email.split('@')[0] ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 8)}${Math.random().toString(36).slice(2, 6)}`,
    }),
  });
  assert.equal(res.status, 201, `register failed: ${await res.clone().text()}`);
  const body = (await res.json()) as { token: string; profile: { id: string } };
  return { token: body.token, profileId: body.profile.id };
}

for (const c of cases) {
  test(`assets: 上传/去重/校验（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);
    const { token } = await registerAndGetToken(ctx, EMAIL);
    const headers = { 'content-type': 'image/png', authorization: `Bearer ${token}` };

    // 上传成功 → 201 + blob 元数据 + URL
    const skin = await makeSkinPng(64, 64);
    const up1 = await fetch(`${ctx.baseUrl}/api/assets?kind=skin&model=slim&name=测试皮肤`, {
      method: 'POST',
      headers,
      body: new Uint8Array(skin),
    });
    assert.equal(up1.status, 201);
    const up1Body = (await up1.json()) as {
      asset: { id: string; kind: string; modelType: string | null; name: string };
      blob: { sha256: string; width: number; height: number };
      url: string;
      deduped: boolean;
    };
    assert.equal(up1Body.asset.kind, 'skin');
    assert.equal(up1Body.asset.modelType, 'slim');
    assert.equal(up1Body.blob.width, 64);
    assert.equal(up1Body.blob.height, 64);
    assert.equal(up1Body.deduped, false);
    assert.ok(up1Body.url.startsWith('http://localhost:3000/uploads/blobs/'));

    // 相同文件再传 → deduped=true，blob 复用（相同 sha256）
    const up2 = await fetch(`${ctx.baseUrl}/api/assets?kind=skin&name=same-file`, {
      method: 'POST',
      headers,
      body: new Uint8Array(skin),
    });
    assert.equal(up2.status, 201);
    const up2Body = (await up2.json()) as typeof up1Body;
    assert.equal(up2Body.deduped, true);
    assert.equal(up2Body.blob.sha256, up1Body.blob.sha256);

    // 库里只有一个 blob
    const blobCount = await db.query<Record<string, unknown>>('SELECT COUNT(*) AS n FROM blobs');
    assert.equal(Number(blobCount[0]!['n']), 1);

    // 错误尺寸 / 非 PNG → 400
    const badDims = await fetch(`${ctx.baseUrl}/api/assets?kind=skin&name=bad`, {
      method: 'POST',
      headers,
      body: new Uint8Array(await makeSkinPng(128, 128)),
    });
    assert.equal(badDims.status, 400);
    const badFormat = await fetch(`${ctx.baseUrl}/api/assets?kind=skin&name=bad`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` },
      body: new Uint8Array(Buffer.from('definitely-not-a-png')),
    });
    assert.equal(badFormat.status, 400);

    // 披风带 model → 400；披风尺寸 64x32 正常
    const capeBad = await fetch(
      `${ctx.baseUrl}/api/assets?kind=cape&model=slim&name=bad-cape`,
      { method: 'POST', headers, body: new Uint8Array(await makeSkinPng(64, 32)) },
    );
    assert.equal(capeBad.status, 400);
    const capeOk = await fetch(`${ctx.baseUrl}/api/assets?kind=cape&name=my-cape`, {
      method: 'POST',
      headers,
      body: new Uint8Array(await makeSkinPng(64, 32)),
    });
    assert.equal(capeOk.status, 201);
    const capeBody = (await capeOk.json()) as typeof up1Body;
    assert.equal(capeBody.asset.modelType, null);

    // 未登录 → 401
    const anon = await fetch(`${ctx.baseUrl}/api/assets?kind=skin&name=x`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(skin),
    });
    assert.equal(anon.status, 401);
  });

  test(`assets: 应用槽位 → 纹理链路 → 删除清理（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);
    const { token, profileId } = await registerAndGetToken(ctx, EMAIL);
    const headers = { 'content-type': 'image/png', authorization: `Bearer ${token}` };
    const jsonHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    // 上传 slim 皮肤并应用
    const up = await fetch(`${ctx.baseUrl}/api/assets?kind=skin&model=slim&name=skin`, {
      method: 'POST',
      headers,
      body: new Uint8Array(await makeSkinPng(64, 64)),
    });
    const { asset, url } = (await up.json()) as { asset: { id: string }; url: string };

    // 应用到角色
    const apply = await fetch(`${ctx.baseUrl}/api/assets/${asset.id}/apply`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ profileId, slot: 'skin' }),
    });
    assert.equal(apply.status, 204);

    // 纹理 URL 可访问（验收：textures 返回的 URL 在客户端可访问）
    // 注：测试服务器端口随机，把 publicBaseUrl 前缀替换为测试基地址后请求静态文件
    const texRes = await fetch(url.replace('http://localhost:3000', ctx.baseUrl));
    assert.equal(texRes.status, 200);
    assert.equal(texRes.headers.get('content-type'), 'image/png');

    // profile/:uuid 反映 SKIN + slim 元数据
    const shortId = profileId.replaceAll('-', '');
    const profileRes = await fetch(
      `${ctx.baseUrl}/sessionserver/session/minecraft/profile/${shortId}?unsigned=true`,
    );
    assert.equal(profileRes.status, 200);
    const p = (await profileRes.json()) as {
      properties: { name: string; value: string }[];
    };
    const payload = JSON.parse(
      Buffer.from(p.properties[0]!.value, 'base64').toString('utf8'),
    ) as { textures: Record<string, { url: string; metadata?: { model: string } }> };
    assert.equal(payload.textures.SKIN!.metadata!.model, 'slim');
    assert.equal(payload.textures.SKIN!.url, url);

    // 摘下 → 纹理变空
    const remove = await fetch(`${ctx.baseUrl}/api/assets/${asset.id}/remove`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ profileId, slot: 'skin' }),
    });
    assert.equal(remove.status, 204);
    const afterRemove = await fetch(
      `${ctx.baseUrl}/sessionserver/session/minecraft/profile/${shortId}?unsigned=true`,
    );
    const p2 = (await afterRemove.json()) as typeof p;
    assert.equal(Object.keys(JSON.parse(Buffer.from(p2.properties[0]!.value, 'base64').toString('utf8')).textures).length, 0);

    // 重新应用后删除素材 → 解绑 + blob/文件清理
    await fetch(`${ctx.baseUrl}/api/assets/${asset.id}/apply`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ profileId, slot: 'skin' }),
    });
    const del = await fetch(`${ctx.baseUrl}/api/assets/${asset.id}`, {
      method: 'DELETE',
      headers: jsonHeaders,
    });
    assert.equal(del.status, 204);

    const blobCount = await db.query<Record<string, unknown>>('SELECT COUNT(*) AS n FROM blobs');
    assert.equal(Number(blobCount[0]!['n']), 0);
    const assetCount = await db.query<Record<string, unknown>>('SELECT COUNT(*) AS n FROM assets');
    assert.equal(Number(assetCount[0]!['n']), 0);
    const bindingCount = await db.query<Record<string, unknown>>('SELECT COUNT(*) AS n FROM profile_assets');
    assert.equal(Number(bindingCount[0]!['n']), 0);

    // 删除后纹理 URL 不再可访问
    const goneTex = await fetch(url.replace('http://localhost:3000', ctx.baseUrl));
    assert.equal(goneTex.status, 404);

    // 他人素材不可见/不可删
    const other = await registerAndGetToken(ctx, `other-${EMAIL}`);
    const otherApply = await fetch(`${ctx.baseUrl}/api/assets/${asset.id}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${other.token}` },
      body: JSON.stringify({ profileId: other.profileId, slot: 'skin' }),
    });
    assert.equal(otherApply.status, 404);
    const otherDel = await fetch(`${ctx.baseUrl}/api/assets/${asset.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(otherDel.status, 404);
  });
}
