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
import type { AppConfig } from '../src/config.js';

/**
 * 0004 自托管数学题人机验证。
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
      // 响应里不得出现 turnstile 的 siteKey（本项目不接 Turnstile）
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
