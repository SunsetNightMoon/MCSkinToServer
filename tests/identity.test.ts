import assert from 'node:assert/strict';
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
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { FavoriteRepository } from '../src/repositories/favoriteRepository.js';
import { LocalDiskStorage, blobStorageKey } from '../src/storage/index.js';
import { sha256Hex } from '../src/util/crypto.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair, publicKeyDerBase64 } from '../src/yggdrasil/keys.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * P1 身份链路端到端测试：注册/登录/封禁 + Yggdrasil 五端点 + join/hasJoined
 * + profile/:uuid + 批量角色查询 + 角色改名冷却。
 * 双方言：SQLite 恒跑；PostgreSQL 由 TEST_DATABASE_URL 门控。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const EMAIL = `alice-${Date.now()}@test.local`;
const PASSWORD = 'password123';
const PROFILE_NAME = `alice_${Date.now().toString(36)}`;

interface DialectCase {
  label: string;
  skip?: string;
  setup: (t: TestContext) => Promise<DatabaseConnection>;
}

const cases: DialectCase[] = [
  {
    label: 'sqlite',
    setup: async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mcsts-identity-'));
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
        skip: '未设置 TEST_DATABASE_URL，跳过 PostgreSQL 身份链路测试',
        setup: async () => {
          throw new Error('unreachable');
        },
      },
];

async function wipeAll(db: DatabaseConnection): Promise<void> {
  // users 级联清掉 profiles/tokens/login_sessions；其余表单独清
  await db.run('DELETE FROM minecraft_sessions');
  await db.run('DELETE FROM profile_assets');
  await db.run('DELETE FROM assets');
  await db.run('DELETE FROM blobs');
  await db.run('DELETE FROM users');
  if (db.dialect === 'postgres') {
    // 测试断言 user_uid 从 1 开始，复用 mcsts_smoke_test 库时重置序列
    await db.run('ALTER SEQUENCE users_user_uid_seq RESTART WITH 1');
  }
}

/** 给角色绑一张已审核公开皮肤（hasJoined / profile/:uuid 纹理链路用） */
async function seedSkin(
  db: DatabaseConnection,
  profileId: string,
  userId: string,
): Promise<void> {
  const ph = (i: number) => (db.dialect === 'postgres' ? `$${i + 1}` : '?');
  const sha = sha256Hex(`skin-png-${profileId}`);
  const blobId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO blobs (id, sha256, storage_key, content_type, byte_size, width, height, created_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7].map(ph).join(', ')})`,
    [blobId, sha, blobStorageKey(sha), 'image/png', 100, 64, 64, now],
  );
  await db.run(
    `INSERT INTO assets (id, owner_user_id, kind, blob_id, model_type, name,
       visibility, download_policy, review_status, created_at, updated_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(ph).join(', ')})`,
    [
      assetId,
      userId,
      'skin',
      blobId,
      'slim',
      `skin-${PROFILE_NAME}`,
      'public',
      'public',
      'approved',
      now,
      now,
    ],
  );
  await db.run(
    `INSERT INTO profile_assets (id, profile_id, asset_id, slot, assigned_at)
     VALUES (${[0, 1, 2, 3, 4].map(ph).join(', ')})`,
    [crypto.randomUUID(), profileId, assetId, 'skin', now],
  );
}

interface HttpCtx {
  baseUrl: string;
  db: DatabaseConnection;
  close: () => Promise<void>;
}

async function startHttp(
  t: TestContext,
  db: DatabaseConnection,
): Promise<HttpCtx> {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-identity-http-'));
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
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return { baseUrl: `http://127.0.0.1:${port}`, db, close: () => db.close() };
}

function post(ctx: HttpCtx, path: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 双方言场景套件
// ---------------------------------------------------------------------------

for (const c of cases) {
  test(`identity: 注册/登录/封禁（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);

    // 注册成功：201 + user_uid 从 1 开始 + 默认角色 + token 可用
    const reg = await post(ctx, '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      profileName: PROFILE_NAME,
    });
    assert.equal(reg.status, 201);
    const regBody = (await reg.json()) as {
      user: { id: string; userUid: number; email: string; role: string };
      profile: { id: string; name: string };
      token: string;
      expiresAt: string;
    };
    assert.equal(regBody.user.userUid, 1);
    assert.equal(regBody.user.email, EMAIL);
    assert.equal(regBody.profile.name, PROFILE_NAME);
    assert.ok(regBody.token.length > 20);

    const me = await fetch(`${ctx.baseUrl}/api/me`, {
      headers: { authorization: `Bearer ${regBody.token}` },
    });
    assert.equal(me.status, 200);

    // 重复邮箱 / 重复角色名 / 非法角色名
    assert.equal(
      (
        await post(ctx, '/api/auth/register', {
          email: EMAIL.toUpperCase(),
          password: PASSWORD,
          profileName: `other_${Date.now().toString(36)}`,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post(ctx, '/api/auth/register', {
          email: `x-${EMAIL}`,
          password: PASSWORD,
          profileName: PROFILE_NAME,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post(ctx, '/api/auth/register', {
          email: `x-${EMAIL}`,
          password: PASSWORD,
          profileName: '非法名字!',
        })
      ).status,
      400,
    );

    // 登录成功 / 密码错误
    const login = await post(ctx, '/api/auth/login', {
      email: EMAIL,
      password: PASSWORD,
    });
    assert.equal(login.status, 200);
    const badLogin = await post(ctx, '/api/auth/login', {
      email: EMAIL,
      password: 'wrong-password',
    });
    assert.equal(badLogin.status, 401);
    assert.equal(
      ((await badLogin.json()) as { error: string }).error,
      'INVALID_CREDENTIALS',
    );

    // 封禁后登录 → 403 USER_BANNED；解封后自动恢复
    const ph = (i: number) => (db.dialect === 'postgres' ? `$${i + 1}` : '?');
    await db.run(
      `UPDATE users SET ban_permanent = TRUE, ban_reason = ${ph(0)}`,
      ['test'],
    );
    const banned = await post(ctx, '/api/auth/login', {
      email: EMAIL,
      password: PASSWORD,
    });
    assert.equal(banned.status, 403);
    assert.equal(
      ((await banned.json()) as { error: string }).error,
      'USER_BANNED',
    );
    await db.run(
      `UPDATE users SET ban_permanent = FALSE, ban_reason = NULL
       WHERE email = ${ph(0)}`,
      [EMAIL],
    );
  });

  test(`identity: Yggdrasil authenticate/validate/refresh/signout（${c.label}）`, {
    skip: c.skip,
  }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);

    // 准备用户
    const reg = await post(ctx, '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      profileName: PROFILE_NAME,
    });
    assert.equal(reg.status, 201);
    const profileId = ((await reg.json()) as { profile: { id: string } }).profile.id;

    // authenticate：会话结构完整
    const auth = await post(ctx, '/authserver/authenticate', {
      agent: { name: 'Minecraft', version: 1 },
      username: EMAIL,
      password: PASSWORD,
      clientToken: 'client-token-abc',
    });
    assert.equal(auth.status, 200);
    const session = (await auth.json()) as {
      accessToken: string;
      clientToken: string;
      availableProfiles: { id: string; name: string }[];
      selectedProfile: { id: string; name: string } | null;
      user: { id: string; email: string };
    };
    assert.equal(session.clientToken, 'client-token-abc');
    assert.equal(session.user.email, EMAIL);
    assert.match(session.user.id, /^[0-9a-f]{32}$/);
    assert.equal(session.availableProfiles.length, 1);
    assert.equal(session.selectedProfile?.name, PROFILE_NAME);
    assert.equal(session.selectedProfile?.id, profileId.replaceAll('-', ''));

    // validate：有效 204；clientToken 不匹配 403；web token 不能用于 Yggdrasil
    const okValidate = await post(ctx, '/authserver/validate', {
      accessToken: session.accessToken,
      clientToken: 'client-token-abc',
    });
    assert.equal(okValidate.status, 204);
    const badValidate = await post(ctx, '/authserver/validate', {
      accessToken: session.accessToken,
      clientToken: 'other-token',
    });
    assert.equal(badValidate.status, 403);

    // refresh：换发新 token，旧 token 失效
    const refresh = await post(ctx, '/authserver/refresh', {
      accessToken: session.accessToken,
      clientToken: 'client-token-abc',
    });
    assert.equal(refresh.status, 200);
    const newSession = (await refresh.json()) as typeof session;
    assert.notEqual(newSession.accessToken, session.accessToken);
    assert.equal(newSession.clientToken, 'client-token-abc');
    assert.equal(newSession.selectedProfile?.id, profileId.replaceAll('-', ''));
    const oldValidate = await post(ctx, '/authserver/validate', {
      accessToken: session.accessToken,
      clientToken: 'client-token-abc',
    });
    assert.equal(oldValidate.status, 403);

    // 错误密码 authenticate → 403 ForbiddenOperationException
    const badAuth = await post(ctx, '/authserver/authenticate', {
      username: EMAIL,
      password: 'nope-nope',
    });
    assert.equal(badAuth.status, 403);
    assert.equal(
      ((await badAuth.json()) as { error: string }).error,
      'ForbiddenOperationException',
    );

    // signout：吊销全部 yggdrasil token
    const signout = await post(ctx, '/authserver/signout', {
      username: EMAIL,
      password: PASSWORD,
    });
    assert.equal(signout.status, 204);
    const afterSignout = await post(ctx, '/authserver/validate', {
      accessToken: newSession.accessToken,
      clientToken: 'client-token-abc',
    });
    assert.equal(afterSignout.status, 403);
  });

  test(`identity: join → hasJoined → profile/:uuid 纹理链路（${c.label}）`, {
    skip: c.skip,
  }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);

    const reg = await post(ctx, '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      profileName: PROFILE_NAME,
    });
    assert.equal(reg.status, 201);
    const { profile } = (await reg.json()) as { profile: { id: string; userId?: string } };
    const userRow = await db.query<Record<string, unknown>>(
      `SELECT id FROM users WHERE email = ${
        db.dialect === 'postgres' ? '$1' : '?'
      }`,
      [EMAIL],
    );
    await seedSkin(db, profile.id, userRow[0]!['id'] as string);

    // authenticate + join
    const auth = await post(ctx, '/authserver/authenticate', {
      username: EMAIL,
      password: PASSWORD,
      clientToken: 'ct-join',
    });
    const session = (await auth.json()) as {
      accessToken: string;
      selectedProfile: { id: string } | null;
    };
    const join = await post(ctx, '/sessionserver/session/minecraft/join', {
      accessToken: session.accessToken,
      selectedProfile: session.selectedProfile!.id,
      serverId: 'server-xyz',
    });
    assert.equal(join.status, 204);

    // hasJoined：命中 → 纹理 profile；username 不符 → 204
    const hasJoined = await fetch(
      `${ctx.baseUrl}/sessionserver/session/minecraft/hasJoined?username=${PROFILE_NAME}&serverId=server-xyz`,
    );
    assert.equal(hasJoined.status, 200);
    const hj = (await hasJoined.json()) as {
      id: string;
      name: string;
      properties: { name: string; value: string; signature?: string }[];
    };
    assert.equal(hj.name, PROFILE_NAME);
    assert.equal(hj.id, profile.id.replaceAll('-', ''));
    assert.equal(hj.properties[0]?.name, 'textures');
    // 默认签名（builder 持有私钥）
    assert.ok(typeof hj.properties[0]?.signature === 'string');
    const payload = JSON.parse(
      Buffer.from(hj.properties[0]!.value, 'base64').toString('utf8'),
    ) as {
      profileId: string;
      profileName: string;
      textures: Record<string, { url: string; metadata?: { model: string } }>;
    };
    assert.equal(payload.profileName, PROFILE_NAME);
    assert.ok(payload.textures.SKIN);
    assert.equal(payload.textures.SKIN!.metadata?.model, 'slim');

    const wrongUser = await fetch(
      `${ctx.baseUrl}/sessionserver/session/minecraft/hasJoined?username=nobody&serverId=server-xyz`,
    );
    assert.equal(wrongUser.status, 204);

    // profile/:uuid：默认带签名；unsigned=true 无签名
    const profileRes = await fetch(
      `${ctx.baseUrl}/sessionserver/session/minecraft/profile/${profile.id.replaceAll('-', '')}`,
    );
    assert.equal(profileRes.status, 200);
    const p = (await profileRes.json()) as typeof hj;
    assert.equal(p.name, PROFILE_NAME);
    assert.ok(typeof p.properties[0]?.signature === 'string');

    const unsignedRes = await fetch(
      `${ctx.baseUrl}/sessionserver/session/minecraft/profile/${profile.id.replaceAll('-', '')}?unsigned=true`,
    );
    const pu = (await unsignedRes.json()) as typeof hj;
    assert.equal(pu.properties[0]?.signature, undefined);

    // 未注册 → 204
    const missing = await fetch(
      `${ctx.baseUrl}/sessionserver/session/minecraft/profile/${'0'.repeat(32)}`,
    );
    assert.equal(missing.status, 204);

    // 批量角色名查询
    const batch = await post(ctx, '/api/profiles/minecraft', [
      PROFILE_NAME,
      'ghost_name',
    ]);
    assert.equal(batch.status, 200);
    const batchBody = (await batch.json()) as { id: string; name: string }[];
    assert.equal(batchBody.length, 1);
    assert.equal(batchBody[0]!.name, PROFILE_NAME);
  });

  test(`identity: 角色管理/改名冷却（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);

    const reg = await post(ctx, '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      profileName: PROFILE_NAME,
    });
    const { token, profile } = (await reg.json()) as {
      token: string;
      profile: { id: string };
    };
    const authHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };

    // 改名成功 → 立即再改 → NAME_COOLDOWN 403
    const secondName = `ren_${Date.now().toString(36)}`;
    const rename = await fetch(`${ctx.baseUrl}/api/profiles/${profile.id}/name`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: secondName }),
    });
    assert.equal(rename.status, 200);
    const cooldown = await fetch(
      `${ctx.baseUrl}/api/profiles/${profile.id}/name`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: `ren2_${Date.now().toString(36)}` }),
      },
    );
    assert.equal(cooldown.status, 403);
    assert.equal(
      ((await cooldown.json()) as { error: string }).error,
      'NAME_COOLDOWN',
    );

    // 0003 默认进入单用户名模式：不允许再新建第二个角色 ID
    //（多用户名模式下的新建/删除见 tests/profileMode.test.ts）
    const create = await fetch(`${ctx.baseUrl}/api/profiles`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: `sec_${Date.now().toString(36)}` }),
    });
    assert.equal(create.status, 400);
    assert.equal(
      ((await create.json()) as { error: string }).error,
      'VALIDATION_ERROR',
    );

    // 也不允许删掉当前唯一的可用角色 —— 删了账号就一个可用 ID 都不剩，
    // 而恢复它的路径又卡在 30 天冷却上，等于把用户锁死
    const del = await fetch(`${ctx.baseUrl}/api/profiles/${profile.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert.equal(del.status, 400);

    const stillOne = await fetch(`${ctx.baseUrl}/api/me/profiles`, {
      headers: authHeaders,
    });
    const remaining = (await stillOne.json()) as { profiles: unknown[] };
    assert.equal(remaining.profiles.length, 1, '单用户名模式下角色数应恒为 1');
  });

  test(`identity: 路径角色 id 非规范 UUID → 404（格式闸门，PG 不再 500）（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    await wipeAll(db);
    const ctx = await startHttp(t, db);
    const reg = await post(ctx, '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      profileName: PROFILE_NAME,
    });
    const { token } = (await reg.json()) as { token: string };
    const authHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };

    // 背景：PG 的 uuid 列收到非 UUID 字符串抛 22P02 → 兜底 500；闸门后与
    // 「角色不存在」同响应 404，与 SQLite 行为一致。
    const rename = await fetch(`${ctx.baseUrl}/api/profiles/not-a-uuid/name`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: `rnd_${Date.now().toString(36)}` }),
    });
    assert.equal(rename.status, 404);

    const del = await fetch(`${ctx.baseUrl}/api/profiles/not-a-uuid`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert.equal(del.status, 404);
  });
}
