import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { SqliteConnection } from '../src/db/sqlite.js';
import type { DatabaseConnection } from '../src/types.js';
import { runMigrations } from '../src/migrate/runner.js';
import { TokenService } from '../src/auth/tokens.js';
import { IdentityService, ACCOUNT_DELETE_GRACE_MS } from '../src/auth/identity.js';
import { purgeExpiredAccounts } from '../src/auth/accountLifecycle.js';
import { TokenRepository } from '../src/repositories/tokenRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { ProfileRepository } from '../src/repositories/profileRepository.js';
import { MinecraftSessionRepository } from '../src/repositories/minecraftSessionRepository.js';
import { BlobRepository } from '../src/repositories/blobRepository.js';
import { AssetRepository } from '../src/repositories/assetRepository.js';
import { SettingRepository } from '../src/repositories/settingRepository.js';
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
 * 账号生命周期：改密码 / 注销（15 天宽限期）/ 恢复 / 到期清除。
 *
 * 关键设计断言：
 *  - 改密后全部旧会话失效
 *  - 注销后登录被拒且报 ACCOUNT_DELETED；宽限期内可凭邮箱+密码恢复
 *  - 到期清除**保留 users 行**（占住 user_uid，UID 永不复用），
 *    但清空个人数据（邮箱墓碑化、密码清空、停用），并删除其素材与角色
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const PASSWORD = 'password123';
const NEW_PASSWORD = 'newpassword456';

interface Env {
  db: DatabaseConnection;
  baseUrl: string;
  identity: IdentityService;
  users: UserRepository;
  profiles: ProfileRepository;
  assets: AssetRepository;
  blobRepo: BlobRepository;
  storage: LocalDiskStorage;
  close: () => Promise<void>;
}

let env: Env;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-lifecycle-'));
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
  const identity = new IdentityService({
    db,
    users,
    profiles,
    tokens: tokenService,
    sessions: new MinecraftSessionRepository(db),
    assetUrlResolver: new AssetUrlResolver(storage),
  });

  const deps: AppDependencies = {
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
    settings: new SettingRepository(db),
  };

  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  env = {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    identity,
    users,
    profiles,
    assets,
    blobRepo: blobs,
    storage,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
});

after(async () => {
  await env?.close();
});

async function api(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${env.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function registerUser(email: string): Promise<{ id: string; token: string }> {
  const res = await env.identity.register({
    email,
    password: PASSWORD,
    profileName: `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  });
  // 未开启「要求邮箱验证」时必须签发会话；token 可空是给该开关留的
  assert.ok(res.token, '注册应当签发会话令牌');
  return { id: res.user.id, token: res.token.token };
}

/** 给某用户挂一条素材（供清除断言用） */
async function seedAssetFor(userId: string): Promise<string> {
  const ph = (i: number) => (env.db.dialect === 'postgres' ? `$${i + 1}` : '?');
  const assetId = randomUUID();
  const blobId = randomUUID();
  const sha = sha256Hex(`blob-${assetId}`);
  const now = new Date().toISOString();
  await env.db.run(
    `INSERT INTO blobs (id, sha256, storage_key, content_type, byte_size, width, height, created_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7].map(ph).join(', ')})`,
    [blobId, sha, blobStorageKey(sha), 'image/png', 128, 64, 64, now],
  );
  await env.db.run(
    `INSERT INTO assets (id, owner_user_id, kind, blob_id, model_type, name,
       visibility, download_policy, review_status, created_at, updated_at)
     VALUES (${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(ph).join(', ')})`,
    [assetId, userId, 'skin', blobId, 'default', 'doomed', 'private', 'owner_only', 'approved', now, now],
  );
  return assetId;
}

// ---------------------------------------------------------------------------
// 改密码
// ---------------------------------------------------------------------------

test('changePassword: 正常流程 —— 旧密码失效、新密码可登录、旧 token 作废', async () => {
  const email = `cp-${randomUUID()}@test.local`;
  const { token } = await registerUser(email);

  const wrongOld = await api('/api/auth/change-password', {
    method: 'POST',
    token,
    body: { oldPassword: 'not-the-password', newPassword: NEW_PASSWORD },
  });
  assert.equal(wrongOld.status, 401);
  assert.equal(wrongOld.body.error, 'INVALID_CREDENTIALS');
  // 旧前端按 errorMessage 取文案，缺失会退化成通用「操作失败」
  assert.equal(wrongOld.body.errorMessage, wrongOld.body.message);
  assert.match(wrongOld.body.errorMessage, /密码/);

  const tooShort = await api('/api/auth/change-password', {
    method: 'POST',
    token,
    body: { oldPassword: PASSWORD, newPassword: 'abc' },
  });
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.body.error, 'VALIDATION_ERROR');

  const ok = await api('/api/auth/change-password', {
    method: 'POST',
    token,
    body: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });

  // 改密吊销全部令牌：原 token 立即失效
  const afterChange = await api('/api/me', { token });
  assert.equal(afterChange.status, 401);

  // 旧密码不能登录，新密码可以
  const oldLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: NEW_PASSWORD },
  });
  assert.equal(newLogin.status, 200);
  assert.ok(newLogin.body.token);
});

// ---------------------------------------------------------------------------
// 注销 / 恢复
// ---------------------------------------------------------------------------

test('deleteAccount: 需正确密码，成功后进入宽限期并拒绝登录', async () => {
  const email = `del-${randomUUID()}@test.local`;
  const { token } = await registerUser(email);

  const wrongPw = await api('/api/auth/delete-account', {
    method: 'POST',
    token,
    body: { password: 'wrong' },
  });
  assert.equal(wrongPw.status, 401);

  const ok = await api('/api/auth/delete-account', {
    method: 'POST',
    token,
    body: { password: PASSWORD },
  });
  assert.equal(ok.status, 200);
  assert.ok(typeof ok.body.recoverableUntil === 'string');
  const graceMs = new Date(ok.body.recoverableUntil).getTime() - Date.now();
  // 15 天宽限期（留 1 小时容差）
  assert.ok(
    graceMs > ACCOUNT_DELETE_GRACE_MS - 3600_000 && graceMs <= ACCOUNT_DELETE_GRACE_MS + 1000,
    `recoverableUntil 应在 15 天后，实际差 ${graceMs}ms`,
  );

  // 原 token 作废
  assert.equal((await api('/api/me', { token })).status, 401);

  // 登录被拒且错误码为 ACCOUNT_DELETED（前端据此弹恢复入口）
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 403);
  assert.equal(login.body.error, 'ACCOUNT_DELETED');

  // 宽限期内数据未清除（可恢复）
  const row = (await env.users.findByEmail(email))!;
  assert.ok(row.deletedAt);
  assert.equal(row.purgedAt, null);
});

test('restoreAccount: 宽限期内凭邮箱+密码恢复并直接建立会话', async () => {
  const email = `restore-${randomUUID()}@test.local`;
  const { token } = await registerUser(email);
  await api('/api/auth/delete-account', {
    method: 'POST',
    token,
    body: { password: PASSWORD },
  });

  const wrongPw = await api('/api/auth/restore-account', {
    method: 'POST',
    body: { email, password: 'wrong' },
  });
  assert.equal(wrongPw.status, 401);

  const ok = await api('/api/auth/restore-account', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.user.email, email);
  assert.ok(ok.body.profile?.name, '恢复后应带回原角色');

  // 恢复后可直接用新会话访问
  const me = await api('/api/me', { token: ok.body.token });
  assert.equal(me.status, 200);

  // 且能正常登录
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200);

  const row = (await env.users.findByEmail(email))!;
  assert.equal(row.deletedAt, null);
});

test('restoreAccount: 未注销的账号调用被拒', async () => {
  const email = `alive-${randomUUID()}@test.local`;
  await registerUser(email);
  const res = await api('/api/auth/restore-account', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 到期清除
// ---------------------------------------------------------------------------

test('purgeExpiredAccounts: 到期账号被清空个人数据，但 users 行保留以占住 UID', async () => {
  const email = `purge-${randomUUID()}@test.local`;
  const { id, token } = await registerUser(email);
  const assetId = await seedAssetFor(id);

  const before = (await env.users.findById(id))!;
  const profileCountBefore = (
    await env.profiles.listByUserId(id)
  ).length;
  assert.equal(profileCountBefore, 1);
  assert.ok(before.deletedAt === null);

  // 注销后把 deleted_at 回拨到 16 天前（超过 15 天宽限期）
  await api('/api/auth/delete-account', {
    method: 'POST',
    token,
    body: { password: PASSWORD },
  });
  const oldIso = new Date(Date.now() - 16 * 86400_000).toISOString();
  await env.db.run('UPDATE users SET deleted_at = ? WHERE id = ?', [oldIso, id]);

  const result = await purgeExpiredAccounts({
    db: env.db,
    users: env.users,
    profiles: env.profiles,
    assets: env.assets,
  });
  assert.equal(result.purged, 1);
  assert.deepEqual(result.userIds, [id]);

  // users 行必须保留（否则 SQLite 侧 MAX(user_uid)+1 会复用 UID）
  const after = await env.users.findById(id);
  assert.ok(after, 'users 行必须保留');
  assert.ok(after!.purgedAt, 'purged_at 应已写入');
  assert.equal(after!.isActive, false, '账号应被停用');
  assert.equal(after!.passwordHash, '', '密码应被清空');
  assert.equal(after!.email, `deleted-uid${before.userUid}@invalid.local`, '邮箱应墓碑化');
  assert.equal(after!.userUid, before.userUid, 'user_uid 保持不变');

  // 个人数据被清除
  assert.equal((await env.profiles.listByUserId(id)).length, 0, '角色应被删除');
  assert.equal(await env.assets.findById(assetId), null, '素材应被删除');

  // 原邮箱已释放：可以用同一邮箱重新注册
  const reused = await env.identity.register({
    email,
    password: PASSWORD,
    profileName: `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  });
  assert.notEqual(reused.user.userUid, before.userUid, '新账号必须拿到新的 UID');
  assert.ok(reused.user.userUid > before.userUid);
});

test('purgeExpiredAccounts: 宽限期内与未注销的账号不被清除', async () => {
  const email = `keep-${randomUUID()}@test.local`;
  const { id, token } = await registerUser(email);
  const aliveEmail = `alive2-${randomUUID()}@test.local`;
  const alive = await registerUser(aliveEmail);

  await api('/api/auth/delete-account', {
    method: 'POST',
    token,
    body: { password: PASSWORD },
  });

  const result = await purgeExpiredAccounts({
    db: env.db,
    users: env.users,
    profiles: env.profiles,
    assets: env.assets,
  });
  assert.equal(result.purged, 0);
  assert.equal(result.userIds.length, 0);

  const stillThere = (await env.users.findById(id))!;
  assert.equal(stillThere.purgedAt, null, '宽限期内不得清除');
  assert.ok(stillThere.deletedAt);
  assert.ok((await env.users.findById(alive.id))!.purgedAt === null);
});

test('purgeExpiredAccounts: 幂等 —— 重复调用不会重复计数', async () => {
  const email = `idem-${randomUUID()}@test.local`;
  const { id, token } = await registerUser(email);
  await api('/api/auth/delete-account', {
    method: 'POST',
    token,
    body: { password: PASSWORD },
  });
  await env.db.run('UPDATE users SET deleted_at = ? WHERE id = ?', [
    new Date(Date.now() - 20 * 86400_000).toISOString(),
    id,
  ]);

  const first = await purgeExpiredAccounts({
    db: env.db,
    users: env.users,
    profiles: env.profiles,
    assets: env.assets,
  });
  assert.equal(first.purged, 1);

  const second = await purgeExpiredAccounts({
    db: env.db,
    users: env.users,
    profiles: env.profiles,
    assets: env.assets,
  });
  assert.equal(second.purged, 0, '已清除的账号不应再次计入');
});
