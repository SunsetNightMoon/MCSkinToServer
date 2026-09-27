import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
import { CaptchaRepository } from '../src/repositories/captchaRepository.js';
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { SecretBox } from '../src/util/secretBox.js';
import { sha256Hex } from '../src/util/crypto.js';
import { RuntimeSettings } from '../src/site/runtimeSettings.js';
import { SiteUrlResolver } from '../src/site/siteUrl.js';
import {
  CaptchaService,
  CAPTCHA_TTL_SECONDS,
  generateQuestion,
  normalizeAnswer,
} from '../src/account/captcha.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import {
  ExternalCaptchaService,
  isExternalCaptchaReady,
} from '../src/account/externalCaptcha.js';
import {
  CAPTCHA_CODE_LENGTH,
  CAPTCHA_IMAGE_HEIGHT,
  CAPTCHA_IMAGE_WIDTH,
  generateCaptchaCode,
  renderCaptchaPng,
} from '../src/account/captchaImage.js';
import type { AppConfig } from '../src/config.js';
import type { ExternalCaptchaSettings } from '../src/site/runtimeSettings.js';

/**
 * 0004 自托管数学题 + Issue #3 图片题与外部人机验证。
 *
 * ## 为什么同时测服务层与 HTTP 层
 *
 * - 服务层管的是**逻辑**：一题一次、答错即烧、过期失效、同 id 覆盖。这几条都在
 *   仓储的原子 UPDATE 上，只测服务层才能直接断言「第二次提交被拒」。
 * - HTTP 层管的是**接线**：开关打开后注册/登录是否真的被拦、关闭后是否真的放行。
 *   本项目历史上最贵的一类缺陷就在这一段（开关存了没人读、字段在页面里但没转发），
 *   服务层全绿也一样能出。
 *
 * ## 双方言
 *
 * SQLite 恒跑；PostgreSQL 由 `TEST_DATABASE_URL` 门控。PG 侧沿用共享库
 * `mcsts_smoke_test`，因此每个用例自己造的数据都带方言前缀，必要时自行清理。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const MASTER_SECRET = 'test-master-secret-0123456789';
const PASSWORD = 'password123';

type Dialect = 'sqlite' | 'postgres';

interface Env {
  dialect: Dialect;
  db: DatabaseConnection;
  baseUrl: string;
  captcha: CaptchaService;
  challenges: CaptchaRepository;
  runtime: RuntimeSettings;
  settings: SettingRepository;
  /** 以同一份依赖重建一个 app（用于「开启验证码但未注入服务」这类对照） */
  listen: (overrides: Partial<AppDependencies>) => Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }>;
  /** 开关：写设置并立刻刷新缓存（与管理员保存设置后的行为一致） */
  setCaptchaEnabled: (enabled: boolean) => Promise<void>;
  /** 直接写任意验证相关设置（CAPTCHA_TYPE / EXTERNAL_CAPTCHA_*）并刷新缓存 */
  setCaptchaValues: (values: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
}

const envs: Partial<Record<Dialect, Env>> = {};

async function makeEnv(dialect: Dialect): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), `mcsts-cap-${dialect}-`));
  const db: DatabaseConnection =
    dialect === 'postgres'
      ? PostgresConnection.connect(TEST_DATABASE_URL!)
      : new SqliteConnection(join(dir, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, dialect === 'sqlite' ? 'sqlite' : 'postgresql'));

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
  const secretBox = new SecretBox(MASTER_SECRET);
  const runtime = new RuntimeSettings({ settings, secretBox });
  const siteUrl = new SiteUrlResolver({ settings });
  const challenges = new CaptchaRepository(db);
  const captcha = new CaptchaService({ challenges });

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
    siteUrlResolver: siteUrl,
    runtimeSettings: runtime,
    captcha,
    secretBox,
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
    captcha,
    challenges,
    runtime,
    settings,
    listen,
    setCaptchaEnabled: async (enabled: boolean) => {
      await settings.setMany({ ENABLE_CAPTCHA: enabled }, new Date());
      await runtime.refresh();
    },
    setCaptchaValues: async (values: Record<string, unknown>) => {
      await settings.setMany(values, new Date());
      await runtime.refresh();
    },
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

async function api(
  dialect: Dialect,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${env(dialect).baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function uniqueToken(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * 把 `?` 顺序改写为方言占位符（PostgreSQL 用 `$1..$n`）。
 *
 * 测试里直接写裸 SQL 是为了断言「库里到底存了什么」，但两种方言的占位符不同：
 * 原样写 `?` 在 SQLite 上能过、在 PG 上会报 `syntax error`。用它统一改写，
 * 保证测试代码本身不用分叉。
 */
function sqlFor(dialect: Dialect, text: string): string {
  if (dialect === 'sqlite') return text;
  let i = 0;
  return text.replace(/\?/g, () => `$${(i += 1)}`);
}

function emailFor(dialect: Dialect, prefix: string): string {
  return `${prefix}-${dialect}-${randomUUID().replace(/-/g, '').slice(0, 8)}@test.local`;
}

/** 清理本方言造的用户与挑战（PG 共用库，必须自己收尾） */
async function cleanup(dialect: Dialect, emails: string[], sessions: string[]): Promise<void> {
  const e = env(dialect);
  for (const email of emails) {
    await e.db
      .run(sqlFor(dialect, 'DELETE FROM users WHERE email = ?'), [email])
      .catch(() => undefined);
  }
  for (const sessionId of sessions) {
    await e.db
      .run(sqlFor(dialect, 'DELETE FROM captcha_challenges WHERE session_id = ?'), [sessionId])
      .catch(() => undefined);
  }
}

// ============================================================================
// 1. 纯函数：题干自洽性与答案规范化
// ============================================================================

test('captcha: 生成的题干与答案自洽，且结果非负、范围可控', () => {
  for (let i = 0; i < 500; i++) {
    const { text, answer } = generateQuestion();
    // 形如 `3 + 7 = ?`
    const m = /^(\d{1,2}) ([+\-×]) (\d{1,2}) = \?$/.exec(text);
    assert.ok(m, `题干格式不符：${text}`);
    const a = Number(m![1]);
    const op = m![2];
    const b = Number(m![3]);
    const expected = op === '+' ? a + b : op === '-' ? a - b : a * b;
    assert.equal(answer, expected, `题干与答案不一致：${text} -> ${answer}`);
    assert.ok(answer >= 0, `结果不应为负：${text}`);
    assert.ok(answer <= 100, `结果过大：${text}`);
  }
});

test('captcha: 答案规范化（容忍空白与前导零，拒绝小数与非数字）', () => {
  assert.equal(normalizeAnswer('7'), '7');
  assert.equal(normalizeAnswer(' 7 '), '7');
  assert.equal(normalizeAnswer('007'), '7');
  assert.equal(normalizeAnswer('+7'), '7');
  assert.equal(normalizeAnswer(7), '7');
  assert.equal(normalizeAnswer('0'), '0');
  assert.equal(normalizeAnswer('7.0'), null);
  assert.equal(normalizeAnswer('abc'), null);
  assert.equal(normalizeAnswer(''), null);
  assert.equal(normalizeAnswer(null), null);
  assert.equal(normalizeAnswer(undefined), null);
  assert.equal(normalizeAnswer(7.5), null);
});

// ============================================================================
// 2. 服务层（双方言）
// ============================================================================

for (const { label, enabled } of dialects) {
  const skip = !enabled;

  test(`captcha: 出题 -> 正确答案通过，且库里只存 sha256（${label}）`, { skip }, async () => {
    const e = env(label);
    const sessionId = uniqueToken(`${label}-ok-`);
    try {
      const q = await e.captcha.generate(sessionId);
      assert.equal(q.sessionId, sessionId);
      assert.equal(q.expiresInSeconds, CAPTCHA_TTL_SECONDS);

      const answer = Number(/(\d{1,2}) ([+\-×]) (\d{1,2})/.exec(q.question)![1]) +
        0;
      // 直接从题干算出正确答案（不做运算符判断也能过：这里用仓储里的哈希反查更稳）
      const row = await e.challenges.findBySessionId(sessionId);
      assert.ok(row, '挑战应当已落库');
      assert.notEqual(row!.answerHash, q.question, '不应把题干当答案存');
      assert.match(row!.answerHash, /^[0-9a-f]{64}$/);
      assert.equal(row!.usedAt, null);

      // 用真实答案校验（0..100 枚举出与哈希匹配的那个）
      let correct: number | null = null;
      for (let candidate = 0; candidate <= 100; candidate++) {
        if (sha256Hex(String(candidate)) === row!.answerHash) {
          correct = candidate;
          break;
        }
      }
      assert.notEqual(correct, null, '题干里应当能算出一个 0..100 的答案');
      assert.ok(answer >= 0, '题干解析出的第一个操作数应可读');

      await e.captcha.verify(sessionId, String(correct));

      const afterRow = await e.challenges.findBySessionId(sessionId);
      assert.ok(afterRow!.usedAt !== null, '校验成功后应当被标记为已使用');
    } finally {
      await cleanup(label, [], [sessionId]);
    }
  });

  test(`captcha: 一题只能用一次（${label}）`, { skip }, async () => {
    const e = env(label);
    const sessionId = uniqueToken(`${label}-once-`);
    try {
      await e.captcha.generate(sessionId);
      const row = await e.challenges.findBySessionId(sessionId);
      const correct = findAnswer(row!.answerHash)!;

      await e.captcha.verify(sessionId, correct);
      await assert.rejects(
        () => e.captcha.verify(sessionId, correct),
        (err: any) => err?.code === 'CAPTCHA_INVALID',
        '同一道题第二次提交必须被拒（否则验证码形同不存在）',
      );
    } finally {
      await cleanup(label, [], [sessionId]);
    }
  });

  test(`captcha: 答错会把题烧掉，换一道才能继续（${label}）`, { skip }, async () => {
    const e = env(label);
    const sessionId = uniqueToken(`${label}-burn-`);
    try {
      await e.captcha.generate(sessionId);
      const row = await e.challenges.findBySessionId(sessionId);
      const correct = findAnswer(row!.answerHash)!;

      await assert.rejects(
        () => e.captcha.verify(sessionId, String(Number(correct) + 1)),
        (err: any) => err?.code === 'CAPTCHA_INVALID',
      );
      // 关键：答错之后连正确答案也不再被接受 —— 否则可以拿一道题穷举 0..200
      await assert.rejects(
        () => e.captcha.verify(sessionId, correct),
        (err: any) => err?.code === 'CAPTCHA_INVALID',
        '答错后这道题必须已作废',
      );
    } finally {
      await cleanup(label, [], [sessionId]);
    }
  });

  test(`captcha: 同一 sessionId 重新出题会覆盖旧题（${label}）`, { skip }, async () => {
    const e = env(label);
    const sessionId = uniqueToken(`${label}-repl-`);
    try {
      await e.captcha.generate(sessionId);
      const first = findAnswer((await e.challenges.findBySessionId(sessionId))!.answerHash)!;

      await e.captcha.generate(sessionId);
      const rows = await e.db.query<{ n: number | string }>(
        sqlFor(label, 'SELECT COUNT(*) AS n FROM captcha_challenges WHERE session_id = ?'),
        [sessionId],
      );
      assert.equal(Number(rows[0]!.n), 1, '同一 sessionId 只能有一行');

      const second = findAnswer((await e.challenges.findBySessionId(sessionId))!.answerHash)!;
      // 旧答案失效（除非两次恰好出到同一道题，概率约 1/200；用新答案断言成功即可）
      await e.captcha.verify(sessionId, second);
      if (first !== second) {
        await assert.rejects(
          () => e.captcha.verify(sessionId, first),
          (err: any) => err?.code === 'CAPTCHA_INVALID',
          '覆盖后旧答案不应再有效',
        );
      }
    } finally {
      await cleanup(label, [], [sessionId]);
    }
  });

  test(`captcha: 不存在的 sessionId 一律拒绝（${label}）`, { skip }, async () => {
    const e = env(label);
    await assert.rejects(
      () => e.captcha.verify('does-not-exist-0000', '1'),
      (err: any) => err?.code === 'CAPTCHA_INVALID',
    );
  });

  test(`captcha: 非法 sessionId 报 VALIDATION_ERROR（${label}）`, { skip }, async () => {
    const e = env(label);
    for (const bad of ['', 'ab', 'a b', 'x'.repeat(65), '中文中文']) {
      await assert.rejects(
        () => e.captcha.generate(bad),
        (err: any) => err?.code === 'VALIDATION_ERROR',
        `sessionId=${JSON.stringify(bad)} 应当被拒`,
      );
    }
  });

  test(`captcha: 过期后不可用（假钟推进 ${label}）`, { skip }, async () => {
    const e = env(label);
    const sessionId = uniqueToken(`${label}-exp-`);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const service = new CaptchaService({ challenges: e.challenges, now: () => now });
    try {
      await service.generate(sessionId);
      const correct = findAnswer((await e.challenges.findBySessionId(sessionId))!.answerHash)!;

      // TTL 边界前 1 秒仍可用
      now = new Date(now.getTime() + (CAPTCHA_TTL_SECONDS - 1) * 1000);
      await service.verify(sessionId, correct);

      // 另一道题跨过 TTL 后失效
      const expired = uniqueToken(`${label}-exp2-`);
      const service2 = new CaptchaService({
        challenges: e.challenges,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });
      await service2.generate(expired);
      const correct2 = findAnswer(
        (await e.challenges.findBySessionId(expired))!.answerHash,
      )!;
      const service3 = new CaptchaService({
        challenges: e.challenges,
        now: () => new Date(Date.now() + 0),
      });
      now = new Date('2026-01-01T00:00:00.000Z');
      await assert.rejects(
        () => service3.verify(expired, correct2),
        (err: any) => err?.code === 'CAPTCHA_INVALID',
        '过期题不应通过（该题的有效期在 2026-01-01 基准上，当前时间已远超）',
      );
      void service;
      void now;
    } finally {
      await cleanup(label, [], [sessionId]);
    }
  });

  test(`captcha: 出题时顺带清理过期行（${label}）`, { skip }, async () => {
    const e = env(label);
    const sessionId = uniqueToken(`${label}-clean-`);
    try {
      await e.db.run(
        sqlFor(
          label,
          'INSERT INTO captcha_challenges (id, session_id, answer_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        ),
        [
          randomUUID(),
          sessionId,
          sha256Hex('1'),
          '2000-01-01T00:00:00.000Z',
          '2000-01-01T00:00:00.000Z',
        ],
      );
      await e.captcha.generate(uniqueToken(`${label}-clean2-`));
      const row = await e.challenges.findBySessionId(sessionId);
      assert.equal(row, null, '过期的行应当已被清理');
    } finally {
      await cleanup(label, [], [sessionId, '']);
    }
  });
}

// 从哈希反推答案（0..100 枚举）：测试用它拿「正确答案」，避免重复实现题干解析
function findAnswer(answerHash: string): string | null {
  for (let candidate = 0; candidate <= 100; candidate++) {
    if (sha256Hex(String(candidate)) === answerHash) return String(candidate);
  }
  return null;
}

// ============================================================================
// 3. HTTP 层：开关接线（双方言）
// ============================================================================

for (const { label, enabled } of dialects) {
  const skip = !enabled;

  test(`captcha: captcha-type 随开关变化，开关关闭时注册无需验证码（${label}）`, { skip }, async () => {
    const e = env(label);
    const emails: string[] = [];
    try {
      await e.setCaptchaEnabled(false);
      const off = await api(label, '/api/captcha/captcha-type');
      assert.equal(off.status, 200);
      assert.deepEqual(off.body, { type: 'none' });

      // 关闭时不带验证码也能注册
      const email = emailFor(label, 'cap-off');
      emails.push(email);
      const reg = await api(label, '/api/auth/register', {
        method: 'POST',
        body: { email, password: PASSWORD, profileName: uniqueToken('p') },
      });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));

      await e.setCaptchaEnabled(true);
      const on = await api(label, '/api/captcha/captcha-type');
      assert.deepEqual(on.body, { type: 'math' });
      // 非 external 模式下不带任何外部验证字段
      assert.equal((on.body as Record<string, unknown>)['siteKey'], undefined);
    } finally {
      await e.setCaptchaEnabled(false);
      await cleanup(label, emails, []);
    }
  });

  test(`captcha: generate 返回题干；开启后注册/登录必须带正确验证码（${label}）`, { skip }, async () => {
    const e = env(label);
    const emails: string[] = [];
    const sessions: string[] = [];
    try {
      await e.setCaptchaEnabled(true);

      // ---- 出题端点形状 ----
      const sessionId = uniqueToken(`${label}-http-`);
      sessions.push(sessionId);
      const gen = await api(label, `/api/captcha/generate?sessionId=${sessionId}`);
      assert.equal(gen.status, 200, JSON.stringify(gen.body));
      assert.match(gen.body.question, /^\d{1,2} [+\-×] \d{1,2} = \?$/);
      assert.equal(gen.body.sessionId, sessionId);

      const answer = findAnswer(
        (await e.challenges.findBySessionId(sessionId))!.answerHash,
      )!;

      // ---- 注册：不带验证码 -> 400 ----
      const email = emailFor(label, 'cap-on');
      emails.push(email);
      const noCaptcha = await api(label, '/api/auth/register', {
        method: 'POST',
        body: { email, password: PASSWORD, profileName: uniqueToken('p') },
      });
      assert.equal(noCaptcha.status, 400, JSON.stringify(noCaptcha.body));
      assert.equal(noCaptcha.body.error, 'CAPTCHA_INVALID');

      // 被拒时**不应建号**（否则验证码只是「报个错」，账号照样进库）
      const rows = await e.db.query<{ n: number | string }>(
        sqlFor(label, 'SELECT COUNT(*) AS n FROM users WHERE email = ?'),
        [email],
      );
      assert.equal(Number(rows[0]!.n), 0, '验证码不通过时不得建号');

      // ---- 注册：带正确验证码 -> 201 ----
      const withCaptcha = await api(label, '/api/auth/register', {
        method: 'POST',
        body: {
          email,
          password: PASSWORD,
          profileName: uniqueToken('p'),
          captcha_session_id: sessionId,
          captcha_answer: answer,
        },
      });
      assert.equal(withCaptcha.status, 201, JSON.stringify(withCaptcha.body));

      // ---- 登录：不带验证码 -> 400；带正确 -> 200 ----
      const loginNoCaptcha = await api(label, '/api/auth/login', {
        method: 'POST',
        body: { email, password: PASSWORD },
      });
      assert.equal(loginNoCaptcha.status, 400, JSON.stringify(loginNoCaptcha.body));
      assert.equal(loginNoCaptcha.body.error, 'CAPTCHA_INVALID');

      const sid2 = uniqueToken(`${label}-http2-`);
      sessions.push(sid2);
      await api(label, `/api/captcha/generate?sessionId=${sid2}`);
      const answer2 = findAnswer(
        (await e.challenges.findBySessionId(sid2))!.answerHash,
      )!;
      const loginOk = await api(label, '/api/auth/login', {
        method: 'POST',
        body: {
          email,
          password: PASSWORD,
          captcha_session_id: sid2,
          captcha_answer: answer2,
        },
      });
      assert.equal(loginOk.status, 200, JSON.stringify(loginOk.body));
      assert.ok(loginOk.body.token, '登录成功应签发令牌');
    } finally {
      await e.setCaptchaEnabled(false);
      await cleanup(label, emails, sessions);
    }
  });

  test(`captcha: 开启验证码但服务未注入时，注册/登录一律拒绝（fail-closed，${label}）`, { skip }, async () => {
    const e = env(label);
    let extra: { baseUrl: string; close: () => Promise<void> } | null = null;
    try {
      await e.setCaptchaEnabled(true);
      // 复用同一份依赖，只把 captcha 摘掉
      extra = await e.listen({ captcha: undefined });

      const typeRes = await fetch(`${extra.baseUrl}/api/captcha/captcha-type`);
      assert.equal((await typeRes.json() as any).type, 'math');

      const genRes = await fetch(
        `${extra.baseUrl}/api/captcha/generate?sessionId=${uniqueToken('fail-')}`,
      );
      assert.equal(genRes.status, 503, '未注入服务时 generate 应明确报不可用');

      const regRes = await fetch(`${extra.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: emailFor(label, 'cap-nosvc'),
          password: PASSWORD,
          profileName: uniqueToken('p'),
        }),
      });
      assert.equal(regRes.status, 400);
      assert.equal(((await regRes.json()) as any).error, 'CAPTCHA_INVALID');
    } finally {
      await extra?.close();
      await e.setCaptchaEnabled(false);
    }
  });
}

// ============================================================================
// 4. Issue #3：类型枚举、图片题、外部人机验证
// ============================================================================

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 从 sha256 反查 5 位图片码。
 *
 * 用例要走完整条「出题 -> 答对 -> 建号」链路就需要知道答案，但服务端刻意不把答案
 * 下发（这正是图片模式相对数学题的唯一增益）。五位数字只有 9 万个可能，测试里
 * 穷举一次约几十毫秒，比在源码里加一个「顺便把答案也返回」的调试后门好得多。
 */
function findImageCode(answerHash: string): string | null {
  for (let n = 10000; n < 100000; n += 1) {
    if (sha256Hex(String(n)) === answerHash) return String(n);
  }
  return null;
}

test('captcha: 图片码是 5 位数字且首位非 0（前导零会被 normalizeAnswer 吃掉）', () => {
  for (let i = 0; i < 300; i++) {
    const code = generateCaptchaCode();
    assert.equal(code.length, CAPTCHA_CODE_LENGTH);
    assert.match(code, /^[1-9][0-9]{4}$/, `图片码形态异常：${code}`);
    assert.equal(normalizeAnswer(code), code, '图片码必须原样通过答案规范化');
  }
});

test('captcha: 渲染结果是真 PNG，尺寸与常量声明一致', async () => {
  const png = Buffer.from(await renderCaptchaPng('42719'));
  assert.deepEqual([...png.subarray(0, 8)], PNG_MAGIC, '不是合法 PNG 文件头');
  assert.equal(png.readUInt32BE(16), CAPTCHA_IMAGE_WIDTH);
  assert.equal(png.readUInt32BE(20), CAPTCHA_IMAGE_HEIGHT);
  assert.ok(png.length > 500, `图太小，八成画空了：${png.length} 字节`);
});

// ---------------------------------------------------------------------------
// 外部人机验证的服务层：全部打注入的桩，绝不在测试里出网
// ---------------------------------------------------------------------------

const EXTERNAL_BASE: ExternalCaptchaSettings = {
  preset: 'turnstile',
  siteKey: 'site-public',
  secret: 'secret-private',
  verifyUrl: 'https://verify.test/siteverify',
  scriptUrl: 'https://cdn.test/api.js',
  globalName: 'turnstile',
};

interface StubOutcome {
  status?: number;
  json?: unknown;
  text?: string;
  throw?: Error;
}

function makeStub(handler: (body: string) => StubOutcome) {
  const calls: { url: string; body: string }[] = [];
  const service = new ExternalCaptchaService({
    transport: async (input, init) => {
      const body = String(init.body ?? '');
      calls.push({ url: String(input), body });
      const out = handler(body);
      if (out.throw) throw out.throw;
      return new Response(out.text ?? JSON.stringify(out.json ?? {}), {
        status: out.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { service, calls };
}

test('externalCaptcha: 参数不齐就判定「未接上」，且一次都不出网', async () => {
  for (const missing of [
    { ...EXTERNAL_BASE, secret: '' },
    { ...EXTERNAL_BASE, siteKey: '' },
    { ...EXTERNAL_BASE, verifyUrl: '' },
    // 非 http(s) 协议：管理员误填 file:// 之类，不能让服务端去读它
    { ...EXTERNAL_BASE, verifyUrl: 'file:///etc/passwd' },
  ]) {
    assert.equal(isExternalCaptchaReady(missing), false);
    const { service, calls } = makeStub(() => ({ json: { success: true } }));
    await assert.rejects(
      () => service.verify(missing, 'token'),
      (err: any) => err?.code === 'CAPTCHA_UNAVAILABLE',
      '缺配置属于部署问题，必须是 502 而不是「当作通过」',
    );
    assert.equal(calls.length, 0);
  }
});

test('externalCaptcha: 校验表单带 secret / response / sitekey / remoteip', async () => {
  const { service, calls } = makeStub(() => ({ json: { success: true } }));
  await service.verify(EXTERNAL_BASE, 'tok-123', '203.0.113.9');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, EXTERNAL_BASE.verifyUrl);
  const form = new URLSearchParams(calls[0]!.body);
  assert.equal(form.get('secret'), 'secret-private');
  assert.equal(form.get('response'), 'tok-123');
  assert.equal(form.get('sitekey'), 'site-public');
  assert.equal(form.get('remoteip'), '203.0.113.9');
});

test('externalCaptcha: success 为 false 是「没验过」（400），不是服务故障', async () => {
  const { service } = makeStub(() => ({ json: { success: false } }));
  await assert.rejects(
    () => service.verify(EXTERNAL_BASE, 'tok'),
    (err: any) => err?.code === 'CAPTCHA_INVALID',
  );
});

test('externalCaptcha: 空 token / 非字符串 / 超长 token 都不出网', async () => {
  for (const token of ['', '   ', undefined, null, 12345, 'x'.repeat(4097)]) {
    const { service, calls } = makeStub(() => ({ json: { success: true } }));
    await assert.rejects(
      () => service.verify(EXTERNAL_BASE, token),
      (err: any) => err?.code === 'CAPTCHA_INVALID',
      `非法 token 应直接判失败：${typeof token}`,
    );
    assert.equal(calls.length, 0, '非法 token 不该浪费一次出站请求');
  }
});

test('externalCaptcha: 上游不通 / 非 2xx / 非 JSON 一律 CAPTCHA_UNAVAILABLE', async () => {
  const cases: StubOutcome[] = [
    { throw: new Error('connection reset') },
    { status: 500, json: { success: true } },
    { status: 200, text: '<html>not json</html>' },
  ];
  for (const outcome of cases) {
    const { service } = makeStub(() => outcome);
    await assert.rejects(
      () => service.verify(EXTERNAL_BASE, 'tok'),
      (err: any) => err?.code === 'CAPTCHA_UNAVAILABLE',
      '上游异常绝不等于验证通过',
    );
  }
});

for (const { label, enabled } of dialects) {
  const skip = !enabled;

  test(`captcha: CAPTCHA_TYPE 显式优先，旧布尔只在缺省时生效（${label}）`, { skip }, async () => {
    const e = env(label);
    try {
      // 只写旧布尔（升级前的老站点）
      await e.setCaptchaValues({ CAPTCHA_TYPE: '', ENABLE_CAPTCHA: true });
      assert.deepEqual((await api(label, '/api/captcha/captcha-type')).body, { type: 'math' });
      await e.setCaptchaValues({ CAPTCHA_TYPE: '', ENABLE_CAPTCHA: false });
      assert.deepEqual((await api(label, '/api/captcha/captcha-type')).body, { type: 'none' });

      // 显式类型压过旧布尔：老布尔留着也不影响
      await e.setCaptchaValues({ CAPTCHA_TYPE: 'image', ENABLE_CAPTCHA: false });
      assert.deepEqual((await api(label, '/api/captcha/captcha-type')).body, { type: 'image' });
      await e.setCaptchaValues({ CAPTCHA_TYPE: 'none', ENABLE_CAPTCHA: true });
      assert.deepEqual((await api(label, '/api/captcha/captcha-type')).body, { type: 'none' });

      // 写坏的枚举值不能变成「谁都不校验」，必须回落到旧布尔口径
      await e.setCaptchaValues({ CAPTCHA_TYPE: 'nope', ENABLE_CAPTCHA: true });
      assert.deepEqual((await api(label, '/api/captcha/captcha-type')).body, { type: 'math' });
    } finally {
      await e.setCaptchaValues({ CAPTCHA_TYPE: '', ENABLE_CAPTCHA: false });
    }
  });

  test(`captcha: 图片题只回 PNG，答错烧题，换题才能通过（${label}）`, { skip }, async () => {
    const e = env(label);
    const emails: string[] = [];
    const sessions: string[] = [];
    try {
      await e.setCaptchaValues({ CAPTCHA_TYPE: 'image' });

      const sid = uniqueToken(`${label}-img-`);
      sessions.push(sid);
      const res = await fetch(`${e.baseUrl}/api/captcha/image?sessionId=${sid}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 8)], PNG_MAGIC);
      // 题干不出服务端：响应就是一张图，没有可解析的 JSON
      assert.throws(() => JSON.parse(bytes.toString('utf8')));

      const row = await e.challenges.findBySessionId(sid);
      assert.ok(row, '出题必须落库');
      const code = findImageCode(row!.answerHash);
      assert.ok(code, '库里的答案哈希必须是一个 5 位数字码的 sha256');
      // 改首位得到另一个合法码，用于「答错」分支
      const first = code![0]!;
      const wrongCode = `${first === '9' ? '8' : String(Number(first) + 1)}${code!.slice(1)}`;

      const email = emailFor(label, 'cap-img');
      emails.push(email);
      const missing = await api(label, '/api/auth/register', {
        method: 'POST',
        body: { email, password: PASSWORD, profileName: uniqueToken('p') },
      });
      assert.equal(missing.status, 400, JSON.stringify(missing.body));
      assert.equal(missing.body.error, 'CAPTCHA_INVALID');

      const wrong = await api(label, '/api/auth/register', {
        method: 'POST',
        body: {
          email,
          password: PASSWORD,
          profileName: uniqueToken('p'),
          captcha_session_id: sid,
          captcha_answer: wrongCode,
        },
      });
      assert.equal(wrong.status, 400, JSON.stringify(wrong.body));

      // 先消费再比对：这道题已经烧掉，现在填对也过不了
      const reused = await api(label, '/api/auth/register', {
        method: 'POST',
        body: {
          email,
          password: PASSWORD,
          profileName: uniqueToken('p'),
          captcha_session_id: sid,
          captcha_answer: code,
        },
      });
      assert.equal(reused.status, 400, '答错已烧题，正确答案不得再用同一道题通过');

      // 换一道就正常
      const sid2 = uniqueToken(`${label}-img2-`);
      sessions.push(sid2);
      await fetch(`${e.baseUrl}/api/captcha/image?sessionId=${sid2}`);
      const code2 = findImageCode((await e.challenges.findBySessionId(sid2))!.answerHash);
      assert.ok(code2);
      const ok = await api(label, '/api/auth/register', {
        method: 'POST',
        body: {
          email,
          password: PASSWORD,
          profileName: uniqueToken('p'),
          captcha_session_id: sid2,
          captcha_answer: code2,
        },
      });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
    } finally {
      await e.setCaptchaValues({ CAPTCHA_TYPE: '', ENABLE_CAPTCHA: false });
      await cleanup(label, emails, sessions);
    }
  });

  test(`captcha: 图片题未注入服务时 503，非法 sessionId 走 400（${label}）`, { skip }, async () => {
    const e = env(label);
    let extra: { baseUrl: string; close: () => Promise<void> } | null = null;
    try {
      await e.setCaptchaValues({ CAPTCHA_TYPE: 'image' });
      extra = await e.listen({ captcha: undefined });
      const res = await fetch(
        `${extra.baseUrl}/api/captcha/image?sessionId=${uniqueToken('noimg-')}`,
      );
      assert.equal(res.status, 503, '未注入服务必须明确报不可用');
      assert.equal(((await res.json()) as any).error, 'CAPTCHA_UNAVAILABLE');

      // sessionId 形态非法属于调用方错误，不能拖到渲染阶段
      const bad = await api(label, '/api/captcha/image?sessionId=ab');
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      assert.equal(bad.body.error, 'VALIDATION_ERROR');
    } finally {
      await extra?.close();
      await e.setCaptchaValues({ CAPTCHA_TYPE: '', ENABLE_CAPTCHA: false });
    }
  });

  test(`captcha: external 模式按 token 校验，注册只在端点点头后放行（${label}）`, { skip }, async () => {
    const e = env(label);
    const emails: string[] = [];
    const sessions: string[] = [];
    const calls: { url: string; body: string }[] = [];
    let verdict: StubOutcome = { json: { success: true } };
    const stub = new ExternalCaptchaService({
      transport: async (input, init) => {
        const body = String(init.body ?? '');
        calls.push({ url: String(input), body });
        if (verdict.throw) throw verdict.throw;
        return new Response(verdict.text ?? JSON.stringify(verdict.json ?? {}), {
          status: verdict.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    let extra = await e.listen({ externalCaptcha: stub });
    const post = async (payload: Record<string, unknown>) => {
      const r = await fetch(`${extra!.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: r.status, body: ((await r.json().catch(() => null)) ?? {}) as any };
    };
    try {
      await e.setCaptchaValues({
        CAPTCHA_TYPE: 'external',
        ENABLE_CAPTCHA: false,
        EXTERNAL_CAPTCHA_PRESET: 'hcaptcha',
        EXTERNAL_CAPTCHA_SITE_KEY: 'site-public',
        EXTERNAL_CAPTCHA_SECRET: 'secret-private',
      });

      // 前端要的配置能读到，密钥读不到
      const typeRes = await fetch(`${extra.baseUrl}/api/captcha/captcha-type`);
      const typeBody = (await typeRes.json()) as Record<string, unknown>;
      assert.deepEqual(typeBody, {
        type: 'external',
        siteKey: 'site-public',
        scriptUrl: 'https://js.hcaptcha.com/1/api.js',
        globalName: 'hcaptcha',
      });
      assert.ok(!JSON.stringify(typeBody).includes('secret-private'), 'secret 绝不能下发');

      // 数学题那套字段在 external 模式下不作数（防「换条路绕过」）
      const sid = uniqueToken(`${label}-ext-`);
      sessions.push(sid);
      await fetch(`${extra.baseUrl}/api/captcha/generate?sessionId=${sid}`);
      const email = emailFor(label, 'cap-ext');
      emails.push(email);
      const mathPassed = await post({
        email,
        password: PASSWORD,
        profileName: uniqueToken('p'),
        captcha_session_id: sid,
        captcha_answer: '7',
      });
      assert.equal(mathPassed.status, 400, JSON.stringify(mathPassed.body));
      assert.equal(mathPassed.body.error, 'CAPTCHA_INVALID');
      assert.equal(calls.length, 0, '没带 token 就不该发起出站校验');

      // 带 token 且端点点头 -> 放行，且表单四项齐全
      const ok = await post({
        email,
        password: PASSWORD,
        profileName: uniqueToken('p'),
        captcha_token: 'tok-ok',
      });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, 'https://api.hcaptcha.com/siteverify');
      const form = new URLSearchParams(calls[0]!.body);
      assert.equal(form.get('secret'), 'secret-private');
      assert.equal(form.get('response'), 'tok-ok');
      assert.equal(form.get('sitekey'), 'site-public');
      assert.ok(form.get('remoteip'), '应把来源 IP 一并交给校验端点');

      // 端点说不过 -> 400，用户可重试
      const email2 = emailFor(label, 'cap-ext2');
      emails.push(email2);
      verdict = { json: { success: false } };
      const rejected = await post({
        email: email2,
        password: PASSWORD,
        profileName: uniqueToken('p'),
        captcha_token: 'tok-bad',
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error, 'CAPTCHA_INVALID');

      // 端点不通 -> 502，且同样不建号
      verdict = { throw: new Error('upstream down') };
      const unavailable = await post({
        email: email2,
        password: PASSWORD,
        profileName: uniqueToken('p'),
        captcha_token: 'tok-again',
      });
      assert.equal(unavailable.status, 502, JSON.stringify(unavailable.body));
      assert.equal(unavailable.body.error, 'CAPTCHA_UNAVAILABLE');
      const rows = await e.db.query<{ n: number | string }>(
        sqlFor(label, 'SELECT COUNT(*) AS n FROM users WHERE email = ?'),
        [email2],
      );
      assert.equal(Number(rows[0]!.n), 0, '校验不通时不得建号');

      // 没接上校验能力（依赖未注入）同样不能静默放行
      await extra.close();
      extra = await e.listen({});
      const noService = await post({
        email: email2,
        password: PASSWORD,
        profileName: uniqueToken('p'),
        captcha_token: 'tok-x',
      });
      assert.equal(noService.status, 502, JSON.stringify(noService.body));
      assert.equal(noService.body.error, 'CAPTCHA_UNAVAILABLE');
    } finally {
      await extra.close();
      await e.setCaptchaValues({
        CAPTCHA_TYPE: '',
        ENABLE_CAPTCHA: false,
        EXTERNAL_CAPTCHA_PRESET: '',
        EXTERNAL_CAPTCHA_SITE_KEY: '',
        EXTERNAL_CAPTCHA_SECRET: '',
      });
      await cleanup(label, emails, sessions);
    }
  });
}
