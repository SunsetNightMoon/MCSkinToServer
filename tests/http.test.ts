import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { TokenService } from '../src/auth/tokens.js';
import { IdentityService } from '../src/auth/identity.js';
import { TokenRepository, type UserRole } from '../src/repositories/tokenRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { ProfileRepository } from '../src/repositories/profileRepository.js';
import { MinecraftSessionRepository } from '../src/repositories/minecraftSessionRepository.js';
import { BlobRepository } from '../src/repositories/blobRepository.js';
import { AssetRepository } from '../src/repositories/assetRepository.js';
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { FavoriteRepository } from '../src/repositories/favoriteRepository.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import { runMigrations } from '../src/migrate/runner.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { publicKeyPemOneLine } from '../src/yggdrasil/keys.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { illegalArgument } from '../src/yggdrasil/errors.js';
import { AppError } from '../src/errors.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import { requireAdmin, requireSuperAdmin } from '../src/server/middleware.js';
import { errorHandler } from '../src/server/errorHandler.js';
import type { AppConfig } from '../src/config.js';

/**
 * P0 收尾：Express 骨架 / 健康检查 / 统一认证中间件 / 错误映射。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

interface TestCtx {
  baseUrl: string;
  deps: AppDependencies;
  tokenService: TokenService;
  db: SqliteConnection;
  dir: string;
  server: import('node:http').Server;
  userId: string;
  userToken: string;
  adminToken: string;
  disabledToken: string;
}

let ctx: TestCtx;

async function insertUser(
  db: SqliteConnection,
  opts: { id: string; uid: number; role?: UserRole; isActive?: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO users (id, user_uid, email, password_hash, role, is_active,
       email_verified, ban_permanent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    [
      opts.id,
      opts.uid,
      `${opts.uid}-${randomUUID()}@test.local`,
      'x',
      opts.role ?? 'user',
      opts.isActive === false ? 0 : 1,
      now,
      now,
    ],
  );
}

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-http-'));
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
  const identity = new IdentityService({
    db,
    users: new UserRepository(db),
    profiles: new ProfileRepository(db),
    tokens: tokenService,
    sessions: new MinecraftSessionRepository(db),
  });
  const assetRepository = new AssetRepository(db);
  const profileRepository = new ProfileRepository(db);
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
      users: new UserRepository(db),
      resolver: new AssetUrlResolver(storage),
    }),
  };
  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const userId = randomUUID();
  await insertUser(db, { id: userId, uid: 1 });
  const userToken = (await tokenService.issue({ tokenType: 'web', userId })).token;

  const adminId = randomUUID();
  await insertUser(db, { id: adminId, uid: 2, role: 'admin' });
  const adminToken = (
    await tokenService.issue({ tokenType: 'web', userId: adminId })
  ).token;

  const disabledId = randomUUID();
  await insertUser(db, { id: disabledId, uid: 3, isActive: false });
  const disabledToken = (
    await tokenService.issue({ tokenType: 'web', userId: disabledId })
  ).token;

  ctx = {
    baseUrl: `http://127.0.0.1:${port}`,
    deps,
    tokenService,
    db,
    dir,
    server,
    userId,
    userToken,
    adminToken,
    disabledToken,
  };
});

after(async () => {
  ctx.server.closeAllConnections();
  await new Promise<void>((r) => ctx.server.close(() => r()));
  await ctx.db.close().catch(() => undefined);
  await rm(ctx.dir, { recursive: true, force: true }).catch(() => undefined);
});

test('http: /health/live 返回 200', async () => {
  const res = await fetch(`${ctx.baseUrl}/health/live`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('http: /health/ready 检查数据库与存储', async () => {
  const res = await fetch(`${ctx.baseUrl}/health/ready`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: 'ready',
    checks: { database: 'ok', storage: 'ok' },
  });
});

test('http: /api/yggdrasil 返回元数据', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/yggdrasil`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(
    body['signaturePublickey'],
    publicKeyPemOneLine(ctx.deps.rsaKeyPair.publicKeyPem),
  );
  assert.deepEqual(body['skinDomains'], ['localhost']);
  const meta = body['meta'] as { implementation: { name: string } };
  assert.equal(meta.implementation.name, 'MSCTS');
});

test('http: /api/me 未认证 → 401', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/me`);
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, 'TOKEN_INVALID');
});

test('http: /api/me 无效 token → 401', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/me`, {
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, 'TOKEN_INVALID');
});

test('http: /api/me 有效 token → 200 上下文', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/me`, {
    headers: { authorization: `Bearer ${ctx['userToken'] as string}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { role: string; tokenType: string; profileId: string | null };
  assert.equal(body.role, 'user');
  assert.equal(body.tokenType, 'web');
  assert.equal(body.profileId, null);
});

test('http: 停用用户的 token → 403 USER_DISABLED', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/me`, {
    headers: { authorization: `Bearer ${ctx['disabledToken'] as string}` },
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, 'USER_DISABLED');
});

test('http: 未知路径 → 404', async () => {
  const res = await fetch(`${ctx.baseUrl}/no/such/route`);
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 角色门槛中间件（直接调用，构造假 req/res）
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode?: number;
  body?: unknown;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
}

function fakeRes(): FakeResponse {
  return {
    statusCode: undefined,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

test('http: 角色门槛 requireAdmin / requireSuperAdmin', () => {
  const makeReq = (role: UserRole) =>
    ({
      context: { userId: 'u', tokenId: 't', tokenType: 'web', profileId: null, role },
    }) as unknown as Request;

  const run = (
    mw: (req: Request, res: Response, next: NextFunction) => void,
    role: UserRole,
  ): { status: number | undefined; nextCalled: boolean } => {
    const res = fakeRes();
    let nextCalled = false;
    mw(makeReq(role), res as unknown as Response, () => {
      nextCalled = true;
    });
    return { status: res.statusCode, nextCalled };
  };

  const userRun = run(requireAdmin, 'user');
  assert.equal(userRun.status, 403);
  assert.equal(userRun.nextCalled, false);
  assert.equal(run(requireAdmin, 'admin').nextCalled, true);
  assert.equal(run(requireAdmin, 'super_admin').nextCalled, true);
  const adminRun = run(requireSuperAdmin, 'admin');
  assert.equal(adminRun.status, 403);
  assert.equal(adminRun.nextCalled, false);
  assert.equal(run(requireSuperAdmin, 'super_admin').nextCalled, true);
});

// ---------------------------------------------------------------------------
// 错误映射中间件（独立 mini app 直接验证）
// ---------------------------------------------------------------------------

function miniApp(): Express {
  const app = express();
  app.get('/boom-yggdrasil', () => {
    throw illegalArgument('missing credentials');
  });
  app.get('/boom-token', () => {
    throw new AppError('TOKEN_EXPIRED', '令牌已过期');
  });
  app.get('/boom-unknown', () => {
    throw new Error('secret detail');
  });
  app.use(errorHandler);
  return app;
}

test('http: 错误映射 YggdrasilError / AppError / 未知错误', async (t) => {
  const server = miniApp().listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const ygg = await fetch(`${base}/boom-yggdrasil`);
  assert.equal(ygg.status, 400);
  assert.deepEqual(await ygg.json(), {
    error: 'IllegalArgumentException',
    errorMessage: 'missing credentials',
  });

  const token = await fetch(`${base}/boom-token`);
  assert.equal(token.status, 401);
  assert.equal(((await token.json()) as { error: string }).error, 'TOKEN_EXPIRED');

  const unknown = await fetch(`${base}/boom-unknown`);
  assert.equal(unknown.status, 500);
  const body = (await unknown.json()) as { message: string };
  assert.equal(body.message, '内部错误'); // 不泄露内部细节
});
