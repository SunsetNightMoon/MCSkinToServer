import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { TokenService } from '../src/auth/tokens.js';
import { TokenRepository, type UserRole } from '../src/repositories/tokenRepository.js';
import { PostgresConnection } from '../src/db/postgres.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import { phAt, placeholders } from '../src/db/rows.js';
import type { DatabaseConnection } from '../src/types.js';
import { sha256Hex } from '../src/util/crypto.js';
import { runMigrations } from '../src/migrate/runner.js';
import { AssetUrlResolver, LocalDiskStorage, blobStorageKey } from '../src/storage/index.js';

/**
 * 任务 3 测试：统一 AuthContext（TokenService）+ 存储端口 / AssetUrlResolver。
 * token 套件在 SQLite 与 PostgreSQL 上都跑（PG 需 TEST_DATABASE_URL）。
 */

const SCHEMA_DIR = resolve('schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

async function insertUser(
  db: DatabaseConnection,
  opts: { id: string; uid: number; role?: UserRole; isActive?: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO users (id, user_uid, email, password_hash, role, is_active,
       email_verified, ban_permanent, created_at, updated_at)
     VALUES (${placeholders(db.dialect, 10)})`,
    [
      opts.id,
      opts.uid,
      `${opts.uid}-${randomUUID()}@test.local`,
      'x',
      opts.role ?? 'user',
      opts.isActive === false ? 0 : 1,
      0,
      0,
      now,
      now,
    ],
  );
}

async function cleanUserRows(db: DatabaseConnection): Promise<void> {
  await db.run('DELETE FROM tokens');
  await db.run('DELETE FROM users');
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
      const dir = await mkdtemp(join(tmpdir(), 'mscts-auth-'));
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
          await cleanUserRows(db);
          t.after(() => db.close().catch(() => undefined));
          return db;
        },
      }
    : {
        label: 'postgres',
        skip: '未设置 TEST_DATABASE_URL，跳过 PostgreSQL token 测试',
        setup: async () => {
          throw new Error('unreachable');
        },
      },
];

// ---------------------------------------------------------------------------
// TokenService 双方言套件
// ---------------------------------------------------------------------------

for (const c of cases) {
  test(`tokens: 签发/验证/过期/吊销/禁用（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const repo = new TokenRepository(db);
    const t0 = new Date('2026-09-23T00:00:00.000Z');
    const svc = new TokenService(repo, () => t0);
    const userId = randomUUID();
    await insertUser(db, { id: userId, uid: 1 });

    // 签发 → 验证：上下文完整，明文不入库
    const issued = await svc.issue({ tokenType: 'web', userId, ttlSeconds: 3600 });
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    const ok = await svc.verify(issued.token);
    assert.ok(ok.ok);
    assert.equal(ok.ok && ok.context.userId, userId);
    assert.equal(ok.ok && ok.context.tokenType, 'web');
    assert.equal(ok.ok && ok.context.profileId, null);
    assert.equal(ok.ok && ok.context.role, 'user');
    assert.equal(ok.ok && ok.context.tokenId, issued.tokenId);

    const stored = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM tokens',
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.token_hash, sha256Hex(issued.token));
    assert.notEqual(stored[0]?.token_hash, issued.token);

    // 未知 token
    assert.deepEqual(await svc.verify('not-a-real-token'), {
      ok: false,
      reason: 'invalid',
    });

    // 过期（时钟前移后验证）
    const svcLater = new TokenService(repo, () => new Date(t0.getTime() + 2 * 3600 * 1000));
    assert.deepEqual(await svcLater.verify(issued.token), {
      ok: false,
      reason: 'expired',
    });

    // clientToken 校验（Yggdrasil validate 语义）
    const withClient = await svc.issue({
      tokenType: 'yggdrasil',
      userId,
      clientToken: 'ct-123',
    });
    const clientOk = await svc.verify(withClient.token, 'ct-123');
    assert.ok(clientOk.ok);
    assert.equal(clientOk.ok && clientOk.context.tokenType, 'yggdrasil');
    assert.deepEqual(await svc.verify(withClient.token, 'ct-wrong'), {
      ok: false,
      reason: 'invalid',
    });

    // 吊销
    const doomed = await svc.issue({ tokenType: 'web', userId });
    assert.equal(await svc.revoke(doomed.token), true);
    assert.deepEqual(await svc.verify(doomed.token), {
      ok: false,
      reason: 'revoked',
    });
    assert.equal(await svc.revoke('no-such-token'), false);

    // 用户被停用 → token 立即失效
    const disabledUser = randomUUID();
    await insertUser(db, { id: disabledUser, uid: 2, isActive: false });
    const disabled = await svc.issue({ tokenType: 'web', userId: disabledUser });
    assert.deepEqual(await svc.verify(disabled.token), {
      ok: false,
      reason: 'user_disabled',
    });
  });

  test(`tokens: revokeAll 按类型过滤（${c.label}）`, { skip: c.skip }, async (t) => {
    const db = await c.setup(t);
    const svc = new TokenService(new TokenRepository(db));
    const userId = randomUUID();
    await insertUser(db, { id: userId, uid: 1 });

    const web = await svc.issue({ tokenType: 'web', userId });
    const ygg = await svc.issue({ tokenType: 'yggdrasil', userId });

    await svc.revokeAllForUser(userId, 'web');
    assert.deepEqual(await svc.verify(web.token), { ok: false, reason: 'revoked' });
    const yggStillOk = await svc.verify(ygg.token);
    assert.ok(yggStillOk.ok);

    await svc.revokeAllForUser(userId);
    assert.deepEqual(await svc.verify(ygg.token), { ok: false, reason: 'revoked' });
  });
}

// ---------------------------------------------------------------------------
// 存储端口 / AssetUrlResolver（纯本地，无数据库）
// ---------------------------------------------------------------------------

test('storage: local put/exists/delete + publicUrl', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mscts-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storage = new LocalDiskStorage(root, 'http://localhost:3000/uploads');
  const key = blobStorageKey('a'.repeat(64));
  assert.equal(key, `blobs/aa/${'a'.repeat(64)}.png`);

  assert.equal(await storage.exists(key), false);
  await storage.put(key, new Uint8Array([1, 2, 3]), 'image/png');
  assert.equal(await storage.exists(key), true);
  const content = await readFile(join(root, key));
  assert.deepEqual([...content], [1, 2, 3]);

  assert.equal(
    storage.publicUrl(key),
    `http://localhost:3000/uploads/${key}`,
  );

  await storage.delete(key);
  assert.equal(await storage.exists(key), false);
  await storage.delete(key); // 幂等
});

test('storage: 拒绝目录穿越 objectKey', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mscts-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storage = new LocalDiskStorage(root, 'http://x/uploads');
  await assert.rejects(
    () => storage.put('../evil.txt', new Uint8Array([1]), 'text/plain'),
    /非法 objectKey/,
  );
  await assert.rejects(
    () => storage.put('..\\evil.txt', new Uint8Array([1]), 'text/plain'),
    /非法 objectKey/,
  );
});

test('storage: blobStorageKey 格式校验', () => {
  assert.throws(() => blobStorageKey('SHORT'));
  assert.throws(() => blobStorageKey(`${'G'.repeat(64)}`));
  const resolver = new AssetUrlResolver(
    new LocalDiskStorage('whatever', 'http://x/uploads'),
  );
  const key = blobStorageKey('ab'.repeat(32));
  assert.equal(
    resolver.forBlob({ storageKey: key }),
    `http://x/uploads/${key}`,
  );
});
