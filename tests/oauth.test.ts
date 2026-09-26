import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import { createOAuthRouter } from '../src/server/routes/oauth.js';
import { errorHandler } from '../src/server/errorHandler.js';
import {
  advertiseProviderFlags,
  findOAuthProvider,
  listOAuthProviders,
  registerOAuthProvider,
  resetOAuthProviders,
  summarizeOAuthProviders,
  unregisterOAuthProvider,
} from '../src/account/oauth/registry.js';
import type {
  OAuthAccount,
  OAuthAuthorizeInput,
  OAuthExchangeInput,
  OAuthProvider,
} from '../src/account/oauth/types.js';
import type { AppConfig } from '../src/config.js';

/**
 * 批4-F：第三方登录预留端口。
 *
 * 这一批交付的是**接线口**，不是登录功能。因此测试的重点不是"能不能登录"，
 * 而是这类预留端口容易出的四类事故：
 *
 *   1. **路由被抢占** —— `:providerId` 把 `/providers` 吃掉，前端拿不到开关对象，
 *      整个第三方登录区块永远不出现（或出现一个 501）。
 *   2. **没注册 provider 时前端却显示按钮** —— 用户点了一个必然报错的入口。
 *   3. **凭据泄露** —— 开关/列表端点回显 client id、secret 或授权地址。
 *   4. **出现手机号 / 短信能力** —— 项目硬约束：不做电话短信验证，
 *      类型与响应里都不允许出现 phone / sms 字段。
 *
 * 另外用真实 `createApp` 起一遍：yggdrasil 路由挂在 `/`（根别名），
 * 必须确认它没有把 `/api/auth/oauth/*` 拦掉。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

/** 只实现端口契约、不做任何真实网络请求的假 provider */
function fakeProvider(
  id: string,
  opts: { enabled?: boolean; displayName?: string } = {},
): OAuthProvider {
  return {
    id,
    displayName: opts.displayName ?? id.toUpperCase(),
    enabled: opts.enabled ?? true,
    authorizeUrl(input: OAuthAuthorizeInput): string {
      return `https://example.invalid/${id}/authorize?state=${input.state}`;
    },
    async exchangeCode(_input: OAuthExchangeInput): Promise<OAuthAccount> {
      return {
        providerId: id,
        subject: 'subject-1',
        email: 'user@example.invalid',
        emailVerified: true,
        displayName: 'Tester',
        avatarUrl: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 一、注册表单元行为
// ---------------------------------------------------------------------------

test('oauth: provider 注册表', (t) => {
  t.after(() => resetOAuthProviders());

  assert.deepEqual(listOAuthProviders(), [], '初始应无 provider');

  registerOAuthProvider(fakeProvider('github'));
  registerOAuthProvider(fakeProvider('qq', { enabled: false }));

  // 禁用者不进列表；查询按 id 也拿不到（调用方无需区分"没注册"与"禁用了"）
  assert.deepEqual(
    listOAuthProviders().map((p) => p.id),
    ['github'],
    '禁用 provider 不应出现在列表里',
  );
  assert.equal(findOAuthProvider('qq'), null, '禁用 provider 查询应返回 null');
  assert.equal(findOAuthProvider('nope'), null);
  assert.equal(findOAuthProvider('github')?.displayName, 'GITHUB');

  // 同 id 覆盖：后注册的为准（开发期热重载不该看到"id 已占用"噪音）
  registerOAuthProvider(fakeProvider('github', { displayName: 'GitHub 第二版' }));
  assert.equal(findOAuthProvider('github')?.displayName, 'GitHub 第二版');
  assert.equal(listOAuthProviders().length, 1, '覆盖不应新增条目');

  assert.equal(unregisterOAuthProvider('github'), true);
  assert.equal(unregisterOAuthProvider('github'), false, '重复注销应返回 false');
  assert.deepEqual(listOAuthProviders(), []);
});

test('oauth: 空 id 拒绝注册', (t) => {
  t.after(() => resetOAuthProviders());
  assert.throws(
    () => registerOAuthProvider(fakeProvider('')),
    /id 不能为空/,
    '空 id 会让路由变成 /api/auth/oauth/ ，必须拒绝',
  );
  assert.throws(() => registerOAuthProvider(fakeProvider('   ')));
});

test('oauth: 开关对象形状稳定', (t) => {
  t.after(() => resetOAuthProviders());

  // 未注册任何 provider：两个已知键都必须在且为 false，
  // 否则前端 `data.github` 拿到 undefined，`undefined || undefined` 仍为假 ——
  // 行为上侥幸正确，但响应契约不稳定，将来 `!== false` 之类的判断会踩坑
  assert.deepEqual(advertiseProviderFlags(), { github: false, microsoft: false });

  registerOAuthProvider(fakeProvider('github'));
  assert.deepEqual(advertiseProviderFlags(), { github: true, microsoft: false });

  // 非旧版已知 id 也一并带上 true：前端目前只读 github/microsoft，
  // 多出来的键无副作用，将来改数组渲染时可平滑承接
  registerOAuthProvider(fakeProvider('bilibili', { displayName: '哔哩哔哩' }));
  assert.deepEqual(advertiseProviderFlags(), {
    github: true,
    microsoft: false,
    bilibili: true,
  });

  // 禁用者不进开关
  registerOAuthProvider(fakeProvider('qq', { enabled: false }));
  assert.equal(advertiseProviderFlags()['qq'], undefined);

  assert.deepEqual(summarizeOAuthProviders(), [
    { id: 'github', displayName: 'GITHUB' },
    { id: 'bilibili', displayName: '哔哩哔哩' },
  ]);
});

// ---------------------------------------------------------------------------
// 二、路由层（注入 provider 列表，不碰全局注册表）
// ---------------------------------------------------------------------------

test('oauth: 端点行为（注入 provider）', async (t) => {
  let providers: OAuthProvider[] = [];

  const app = express();
  app.use(createOAuthRouter({ providers: () => providers }));
  app.use(errorHandler);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const get = async (
    path: string,
  ): Promise<{ status: number; body: Record<string, unknown>; raw: string; cc: string | null }> => {
    const res = await fetch(`${base}${path}`);
    const raw = await res.text();
    return {
      status: res.status,
      body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      raw,
      cc: res.headers.get('cache-control'),
    };
  };

  // ---- 什么都没注册：前端小格子必须整体消失 ----
  const empty = await get('/api/auth/oauth/providers');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { github: false, microsoft: false });
  assert.equal(empty.cc, 'no-store', '开关不能被中间层缓存成过期的 true');

  const emptyList = await get('/api/oauth/providers');
  assert.equal(emptyList.status, 200);
  assert.deepEqual(emptyList.body, { providers: [] }, '默认应是无 provider');

  // 未注册的入口是"不存在"，不是"未实现"
  assert.equal((await get('/api/auth/oauth/github')).status, 404);

  // ---- 注册一个启用的 provider ----
  providers = [fakeProvider('github', { displayName: 'GitHub' })];

  const on = await get('/api/auth/oauth/providers');
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { github: true, microsoft: false });

  const list = await get('/api/oauth/providers');
  assert.deepEqual(list.body, { providers: [{ id: 'github', displayName: 'GitHub' }] });

  /**
   * 路由顺序的核心断言：`/api/auth/oauth/providers` 必须命中开关处理器，
   * 而不是被 `/api/auth/oauth/:providerId` 当成 providerId='providers' 吃掉。
   * 一旦被吃掉，前端会收到 501，第三方登录区块在不该出现的时候出现。
   */
  assert.equal(
    on.body['github'],
    true,
    '/providers 被 :providerId 抢占（说明路由注册顺序错了）',
  );

  // 入口与回调：地址是对的、能力没实现 → 501，且消息要可行动（含文档路径）
  const entry = await get('/api/auth/oauth/github');
  assert.equal(entry.status, 501);
  assert.equal(entry.body['error'], 'NOT_IMPLEMENTED');
  assert.match(
    String(entry.body['message']),
    /oauth-provider-guide\.md/,
    '501 消息必须指向接入文档，否则部署者不知道下一步做什么',
  );

  const cb = await get('/api/auth/oauth/github/callback');
  assert.equal(cb.status, 501);
  assert.equal(cb.body['error'], 'NOT_IMPLEMENTED');

  // 没注册的 provider 仍然是 404（确实没有这个入口）
  assert.equal((await get('/api/auth/oauth/qq')).status, 404);
  assert.equal((await get('/api/auth/oauth/qq/callback')).status, 404);

  // ---- 禁用 provider：既不广告，入口也不存在 ----
  providers = [fakeProvider('github', { enabled: false })];
  assert.deepEqual((await get('/api/auth/oauth/providers')).body, {
    github: false,
    microsoft: false,
  });
  assert.deepEqual((await get('/api/oauth/providers')).body, { providers: [] });
  assert.equal(
    (await get('/api/auth/oauth/github')).status,
    404,
    '禁用的 provider 不该留一个点了报错的入口',
  );

  // ---- 凭据与隐私：响应里不得出现秘钥、手机号、短信 ----
  providers = [fakeProvider('github')];
  const leakCheck = [
    (await get('/api/auth/oauth/providers')).raw,
    (await get('/api/oauth/providers')).raw,
    (await get('/api/auth/oauth/github')).raw,
  ].join('\n');
  for (const forbidden of [
    'client_secret',
    'clientSecret',
    'access_token',
    'accessToken',
    'phone',
    'sms',
    '手机',
    '短信',
  ]) {
    assert.equal(
      leakCheck.includes(forbidden),
      false,
      `预留端口响应中不得出现 ${forbidden}（凭据 / 电话短信是硬禁止项）`,
    );
  }
});

/**
 * 端口契约的静态检查：类型层面就不允许出现手机号。
 *
 * 用「条件类型 + 赋值」而不是运行期断言 —— 一旦有人往 `OAuthAccount` 里加
 * `phone` / `mobile` / `msisdn`，`ForbiddenAccountKey` 就不再是 `never`，
 * 下面的类型变成 `false`，把 `true` 赋给它会让 `npm run typecheck` 直接失败。
 * 运行期断言挡不住这种改动（多出来的字段不会被任何断言看到）。
 */
test('oauth: OAuthAccount 不含手机号字段（编译期约束）', () => {
  type ForbiddenAccountKey = Extract<
    keyof OAuthAccount,
    'phone' | 'phoneNumber' | 'mobile' | 'msisdn'
  >;
  const noPhoneField: [ForbiddenAccountKey] extends [never] ? true : false = true;
  assert.equal(noPhoneField, true);

  const sample: OAuthAccount = {
    providerId: 'github',
    subject: 's',
    email: null,
    emailVerified: false,
    displayName: null,
    avatarUrl: null,
  };
  assert.deepEqual(Object.keys(sample).includes('phone'), false);
});

// ---------------------------------------------------------------------------
// 三、真实 createApp 装配：确认根挂载的 yggdrasil 路由没有抢占本前缀
// ---------------------------------------------------------------------------

test('oauth: 真实 app 装配下的端点', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-oauth-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
  t.after(async () => {
    await db.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

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
  const identity = new IdentityService({
    db,
    users,
    profiles,
    tokens: tokenService,
    sessions: new MinecraftSessionRepository(db),
  });
  const assetRepository = new AssetRepository(db);

  // 动态列表：同一个 app 实例内既能验"默认隐藏"，也能验"注册后出现"
  let providers: OAuthProvider[] = [];

  const deps: AppDependencies = {
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity,
    profileRepository: profiles,
    assetRepository,
    minecraftSessions: new MinecraftSessionRepository(db),
    textureBuilder: new TextureProfileBuilder(rsaKeyPair.privateKeyPem),
    assetUrlResolver: new AssetUrlResolver(storage),
    textures: new TextureService({
      db,
      storage,
      blobs: new BlobRepository(db),
      assets: assetRepository,
      profiles,
    }),
    library: new LibraryService({
      assets: assetRepository,
      favorites: new FavoriteRepository(db),
      blobs: new BlobRepository(db),
      users,
      resolver: new AssetUrlResolver(storage),
    }),
    oauthProviders: () => providers,
  };

  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? {} : JSON.parse(raw) };
  };

  // 默认（无 provider）—— 与"本项目不做第三方登录"的现状一致
  const before = await get('/api/auth/oauth/providers');
  assert.equal(before.status, 200, '根挂载的 yggdrasil 路由不得抢占此路径');
  assert.deepEqual(before.body, { github: false, microsoft: false });
  assert.deepEqual((await get('/api/oauth/providers')).body, { providers: [] });

  // 宿主注册后小格子出现（同一进程、无需重启）
  providers = [fakeProvider('github', { displayName: 'GitHub' })];
  assert.deepEqual((await get('/api/auth/oauth/providers')).body, {
    github: true,
    microsoft: false,
  });

  // 顺带确认前端契约里的另一个键也能被点亮
  providers = [...providers, fakeProvider('microsoft', { displayName: 'Microsoft' })];
  assert.deepEqual((await get('/api/auth/oauth/providers')).body, {
    github: true,
    microsoft: true,
  });

  // 未带会话也应可读（登录页在未登录时就要渲染或隐藏小格子）
  assert.equal((await get('/api/auth/oauth/providers')).status, 200);

  // 与既有 Yggdrasil 根别名不冲突：元数据仍然正常
  const meta = await get('/api/yggdrasil');
  assert.equal(meta.status, 200);
  assert.ok(Array.isArray(meta.body['skinDomains']));

  // 未注册的 provider 依然 404；注册未实现的入口 501
  assert.equal((await get('/api/auth/oauth/nope')).status, 404);
  assert.equal((await get('/api/auth/oauth/github')).status, 501);

  // 用户名模式端点（0003）不受影响，确认挂载顺序没打乱既有路由
  assert.equal((await get('/api/me/profile-mode')).status, 401, '无会话应 401 而非 404');
});
