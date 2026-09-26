import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PostgresConnection } from '../src/db/postgres.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import type { DatabaseConnection } from '../src/types.js';
import { runMigrations } from '../src/migrate/runner.js';
import { sha256Hex } from '../src/util/crypto.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { ProfileRepository } from '../src/repositories/profileRepository.js';
import { EmailChangeRepository } from '../src/repositories/emailChangeRepository.js';

/**
 * 0003 仓储层：用户名模式 / 角色状态 / 备用邮箱 / 改邮箱三表。
 *
 * ## 为什么两个方言跑**同一段**断言
 *
 * 这一层最容易出的不是逻辑错，而是**方言错**：列默认值、布尔 0/1 与 TRUE/FALSE、
 * `expires_at > $n` 需要 `::timestamptz` 转型、RETURNING 的行数语义。
 * 抄两遍断言必然只会在其中一个方言里被发现 —— 于是把场景写成一个函数，
 * 两个方言各喂一次，参数化跑；哪边红了一眼就能看出是方言问题而非逻辑问题。
 *
 * ## 这一层不测什么
 *
 * 不测冷却期判定、模式切换规则、上限 10 —— 那些是 IdentityService 的职责
 * （见 profileMode.test.ts 的服务层用例）。这里只保证「SQL 真的能跑、
 * 读写回来的形状与语义跟 schema 一致」。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const MINUTE = 60_000;

/**
 * 在给定连接上跑完整套仓储断言。`prefix` 用于隔离各用例自己造的数据
 * （PG 是共享库，只能按 email 前缀清理）。
 */
async function exercise(db: DatabaseConnection, prefix: string): Promise<void> {
  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const emailChange = new EmailChangeRepository(db);
  const t0 = new Date();
  const at = (offsetMs: number): Date => new Date(t0.getTime() + offsetMs);

  // ---------------------------------------------------------------- users

  const userId = randomUUID();
  const email = `${prefix}-u1@test.local`;
  await users.insert({
    id: userId,
    email,
    passwordHash: 'x',
    role: 'user',
    now: t0,
  });

  const fresh = await users.findById(userId);
  assert.ok(fresh, '刚插入的用户应能读回');
  assert.equal(fresh.profileMode, 'single', '默认模式应为单用户名');
  assert.notEqual(
    fresh.profileModeDecidedAt,
    null,
    '注册时角色数为 0，视作已决定模式（迁移注释的口径）',
  );
  assert.equal(fresh.modeChangedAt, null, '新账号尚未切换过模式');
  assert.equal(fresh.backupEmail, null);
  assert.equal(fresh.backupEmailVerified, false);
  assert.equal(fresh.backupEmailVerifiedAt, null);
  assert.equal(fresh.emailVerified, false);

  // 显式传 null = 待选择（存量多角色用户迁移后的形态）
  const pendingId = randomUUID();
  await users.insert({
    id: pendingId,
    email: `${prefix}-u2@test.local`,
    passwordHash: 'x',
    role: 'user',
    now: t0,
    profileModeDecidedAt: null,
  });
  const pending = await users.findById(pendingId);
  assert.ok(pending);
  assert.equal(
    pending.profileModeDecidedAt,
    null,
    '显式传 null 应写 NULL（待选择）',
  );

  // ---- 模式：decideMode 不覆盖首次决定时间，setProfileMode 不改 decided_at ----

  await users.decideMode(pendingId, 'multi', at(10 * MINUTE));
  const decided = await users.findById(pendingId);
  assert.ok(decided);
  assert.equal(decided.profileMode, 'multi');
  assert.notEqual(decided.profileModeDecidedAt, null, '首次决定应写下时间');
  const firstDecidedAt = decided.profileModeDecidedAt;

  await users.decideMode(pendingId, 'multi', at(20 * MINUTE));
  const twice = await users.findById(pendingId);
  assert.ok(twice);
  assert.equal(
    twice.profileModeDecidedAt,
    firstDecidedAt,
    'decideMode 重复调用不得覆盖首次决定时间（COALESCE 保护的是审计信息）',
  );

  await users.setProfileMode(pendingId, 'single', at(30 * MINUTE));
  const switched = await users.findById(pendingId);
  assert.ok(switched);
  assert.equal(switched.profileMode, 'single');
  assert.equal(
    switched.profileModeDecidedAt,
    firstDecidedAt,
    'setProfileMode 记录的是切换，不该动「首次决定」时间',
  );
  assert.notEqual(switched.modeChangedAt, null, '切换应写下 mode_changed_at');

  // ---- 备用邮箱：写入即回到未验证 ----

  const backup1 = `${prefix}-backup1@test.local`;
  const backup2 = `${prefix}-backup2@test.local`;

  assert.equal(
    await users.findByBackupEmail(backup1),
    null,
    '未绑定时按备用邮箱查不到任何账号',
  );

  // 故意传大写，验证仓储自己做规范化（否则部分唯一索引 lower() 会与读路径脱节）
  await users.setBackupEmail(userId, `${prefix}-BACKUP1@test.local`, at(MINUTE));
  const bound = await users.findById(userId);
  assert.ok(bound);
  assert.equal(
    bound.backupEmail,
    backup1,
    '备用邮箱应以小写形式入库（与 lower() 唯一索引口径一致）',
  );
  assert.equal(bound.backupEmailVerified, false, '刚绑定的备用邮箱未验证');

  const lookedUp = await users.findByBackupEmail(backup1.toUpperCase());
  assert.ok(lookedUp, '按备用邮箱查找应大小写不敏感');
  assert.equal(lookedUp.id, userId);

  await users.markBackupEmailVerified(userId, true, at(2 * MINUTE));
  const verified = await users.findById(userId);
  assert.ok(verified);
  assert.equal(verified.backupEmailVerified, true);
  assert.notEqual(verified.backupEmailVerifiedAt, null);

  // 关键：换成另一个地址必须把验证标志打回 false，否则兜底邮箱可被任意改写
  await users.setBackupEmail(userId, backup2, at(3 * MINUTE));
  const rebound = await users.findById(userId);
  assert.ok(rebound);
  assert.equal(rebound.backupEmail, backup2);
  assert.equal(
    rebound.backupEmailVerified,
    false,
    '改绑新地址必须回到未验证 —— 否则 B 会在没收到信的情况下继承 A 的已验证身份',
  );
  assert.equal(rebound.backupEmailVerifiedAt, null, '换绑应清掉验证时间');

  await users.clearBackupEmail(userId, at(4 * MINUTE));
  const cleared = await users.findById(userId);
  assert.ok(cleared);
  assert.equal(cleared.backupEmail, null);
  assert.equal(cleared.backupEmailVerified, false);

  // 解除后再绑原地址应当可用（唯一索引上看不到残留）
  await users.setBackupEmail(userId, backup1, at(5 * MINUTE));
  assert.ok(await users.findByBackupEmail(backup1), '解绑后原地址应可重新绑定');

  // ---- 改主邮箱：新址已验证，故 email_verified 一并为真 ----

  const newPrimary = `${prefix}-NEW-primary@test.local`;
  await users.updateEmail(userId, newPrimary, at(6 * MINUTE));
  const rePrimary = await users.findById(userId);
  assert.ok(rePrimary);
  assert.equal(rePrimary.email, newPrimary.toLowerCase(), '主邮箱应小写入库');
  assert.equal(
    rePrimary.emailVerified,
    true,
    '改主邮箱时新址已由 verify 令牌证明归属，应一并为已验证（否则用户自我锁死）',
  );
  assert.ok(
    await users.findByEmail(newPrimary.toUpperCase()),
    '改后的主邮箱应能按大小写不敏感查到',
  );

  // -------------------------------------------------------------- profiles

  const p1 = randomUUID();
  const p2 = randomUUID();
  const p3 = randomUUID();
  await profiles.insert({ id: p1, userId, name: `${prefix}_a`, now: at(7 * MINUTE) });
  await profiles.insert({ id: p2, userId, name: `${prefix}_b`, now: at(8 * MINUTE) });
  await profiles.insert({ id: p3, userId, name: `${prefix}_c`, now: at(9 * MINUTE) });

  const created = await profiles.findById(p1);
  assert.ok(created);
  assert.equal(created.status, 'active', '新建角色默认 active');
  assert.equal(created.statusChangedAt, null, '新建角色尚未变更过状态');

  assert.equal(await profiles.countByUserId(userId), 3, '总数含全部状态');
  assert.equal(await profiles.countActiveByUserId(userId), 3);
  assert.equal((await profiles.listActiveByUserId(userId)).length, 3);
  assert.equal((await profiles.listReservedByUserId(userId)).length, 0);
  const firstActive = await profiles.findFirstActiveByUserId(userId);
  assert.ok(firstActive);
  assert.equal(firstActive.id, p1, '应按 created_at 取最早的 active');

  // 多 -> 单：保留 p2，其余转预留
  const movedToReserved = await profiles.setStatusForAllExcept(
    userId,
    p2,
    'reserved',
    at(10 * MINUTE),
  );
  assert.equal(movedToReserved, 2, '除保留者外两行应被改状态');
  assert.equal((await profiles.listActiveByUserId(userId)).length, 1);
  const reserved = await profiles.listReservedByUserId(userId);
  assert.equal(reserved.length, 2);
  assert.ok(
    reserved.every((p) => p.statusChangedAt !== null),
    '转预留应写下 status_changed_at',
  );
  assert.ok(
    reserved.every((p) => p.name.length > 0),
    '转预留必须保留名字占位（否则会被抢注）',
  );
  const nowFirst = await profiles.findFirstActiveByUserId(userId);
  assert.ok(nowFirst);
  assert.equal(
    nowFirst.id,
    p2,
    'findFirstActiveByUserId 必须跳过 reserved，否则 Yggdrasil 会给出不可用的角色',
  );

  // 幂等：再按同一条件改一次不应产生写入
  assert.equal(
    await profiles.setStatusForAllExcept(userId, p2, 'reserved', at(11 * MINUTE)),
    0,
    '已是目标状态的行不该被重复写（status_changed_at 会失真）',
  );

  // 单 -> 多：预留口全部放回
  assert.equal(
    await profiles.setStatusForAll(userId, 'active', at(12 * MINUTE)),
    2,
    '两个预留角色应被放回 active',
  );
  assert.equal((await profiles.listActiveByUserId(userId)).length, 3);
  assert.equal((await profiles.listReservedByUserId(userId)).length, 0);
  assert.equal(
    await profiles.setStatusForAll(userId, 'active', at(13 * MINUTE)),
    0,
    'setStatusForAll 应幂等',
  );

  // 单个改状态
  await profiles.setStatus(p3, 'reserved', at(14 * MINUTE));
  assert.equal(await profiles.countActiveByUserId(userId), 2);
  assert.equal((await profiles.listReservedByUserId(userId)).length, 1);

  // ------------------------------------------------- 备用邮箱验证令牌

  const beToken = `${prefix}-be-plain-${randomUUID()}`;
  const beHash = sha256Hex(beToken);
  await emailChange.invalidateUnusedBackupEmailTokens(userId, at(15 * MINUTE));
  await emailChange.insertBackupEmailToken({
    id: randomUUID(),
    userId,
    pendingEmail: `${prefix}-PENDING@test.local`,
    tokenHash: beHash,
    expiresAt: at(45 * MINUTE),
    createdAt: at(15 * MINUTE),
  });

  const beFound = await emailChange.findBackupEmailTokenByHash(beHash);
  assert.ok(beFound);
  assert.equal(beFound.userId, userId);
  assert.equal(
    beFound.pendingEmail,
    `${prefix}-pending@test.local`,
    'pending_email 应小写入库：它是「正在验证哪个地址」的唯一记录，不规范化会与读路径脱节',
  );
  assert.ok(
    !Number.isNaN(new Date(beFound.expiresAt).getTime()),
    `expiresAt 应可解析成时间：${beFound.expiresAt}`,
  );
  assert.equal(beFound.usedAt, null);

  const beConsumed = await emailChange.consumeBackupEmailToken(
    beHash,
    at(16 * MINUTE),
  );
  assert.ok(beConsumed, '首次消费应成功');
  assert.notEqual(beConsumed.usedAt, null);
  assert.equal(
    await emailChange.consumeBackupEmailToken(beHash, at(17 * MINUTE)),
    null,
    '令牌不可重复消费（双击 / 邮件客户端预取）',
  );

  // 过期令牌
  const beExpiredHash = sha256Hex(`${prefix}-be-expired-${randomUUID()}`);
  await emailChange.insertBackupEmailToken({
    id: randomUUID(),
    userId,
    pendingEmail: backup1,
    tokenHash: beExpiredHash,
    expiresAt: at(-2 * MINUTE),
    createdAt: at(-3 * MINUTE),
  });
  assert.equal(
    await emailChange.consumeBackupEmailToken(beExpiredHash, at(MINUTE)),
    null,
    '过期令牌不应被消费（PG 侧依赖 ::timestamptz 转型）',
  );

  // 重发即作旧
  const beKeeperHash = sha256Hex(`${prefix}-be-keep-${randomUUID()}`);
  await emailChange.insertBackupEmailToken({
    id: randomUUID(),
    userId,
    pendingEmail: backup1,
    tokenHash: beKeeperHash,
    expiresAt: at(45 * MINUTE),
    createdAt: at(18 * MINUTE),
  });
  await emailChange.invalidateUnusedBackupEmailTokens(userId, at(19 * MINUTE));
  const beKeeper = await emailChange.findBackupEmailTokenByHash(beKeeperHash);
  assert.ok(beKeeper);
  assert.notEqual(beKeeper.usedAt, null, '重发应作废旧备用邮箱令牌');
  assert.equal(
    await emailChange.consumeBackupEmailToken(beKeeperHash, at(20 * MINUTE)),
    null,
  );

  await emailChange.deleteExpiredBackupEmailTokens(at(MINUTE));
  assert.equal(
    await emailChange.findBackupEmailTokenByHash(beExpiredHash),
    null,
    '过期令牌应被清理',
  );

  // ------------------------------------------------- 改邮箱请求 + 两枚令牌

  const requestId = randomUUID();
  await emailChange.insertChangeRequest({
    id: requestId,
    userId,
    target: 'primary',
    newEmail: `${prefix}-CHANGE@test.local`,
    authorizeVia: 'backup',
    createdAt: at(21 * MINUTE),
  });

  const req = await emailChange.findChangeRequestById(requestId);
  assert.ok(req);
  assert.equal(req.target, 'primary');
  assert.equal(
    req.newEmail,
    `${prefix}-change@test.local`,
    'new_email 应小写入库',
  );
  assert.equal(req.authorizeVia, 'backup', '授权方创建时固定');
  assert.equal(req.completedAt, null);
  assert.equal(req.cancelledAt, null);

  const openReq = await emailChange.findOpenChangeRequestByUser(userId);
  assert.ok(openReq);
  assert.equal(openReq.id, requestId);

  const verifyHash = sha256Hex(`${prefix}-verify-${randomUUID()}`);
  const authorizeHash = sha256Hex(`${prefix}-authorize-${randomUUID()}`);
  for (const [role, hash] of [
    ['verify', verifyHash],
    ['authorize', authorizeHash],
  ] as const) {
    await emailChange.insertChangeToken({
      id: randomUUID(),
      userId,
      requestId,
      role,
      tokenHash: hash,
      expiresAt: at(60 * MINUTE),
      createdAt: at(22 * MINUTE),
    });
  }

  const verifyToken = await emailChange.findChangeTokenByHash(verifyHash);
  assert.ok(verifyToken);
  assert.equal(verifyToken.role, 'verify');
  assert.equal(verifyToken.requestId, requestId);

  // 按角色作废：重发新地址那封不得顺手干掉授权链接，否则永远凑不齐两枚令牌
  await emailChange.invalidateUnusedChangeTokensForRequest(
    requestId,
    'verify',
    at(23 * MINUTE),
  );
  const afterInvalidateVerify =
    await emailChange.findChangeTokenByHash(verifyHash);
  const afterInvalidateAuthorize =
    await emailChange.findChangeTokenByHash(authorizeHash);
  assert.ok(afterInvalidateVerify);
  assert.ok(afterInvalidateAuthorize);
  assert.notEqual(afterInvalidateVerify.usedAt, null, 'verify 令牌应被作废');
  assert.equal(
    afterInvalidateAuthorize.usedAt,
    null,
    'authorize 令牌不该被 verify 的重发连带作废',
  );

  // 授权令牌可消费一次且仅一次
  assert.ok(
    await emailChange.consumeChangeToken(authorizeHash, at(24 * MINUTE)),
    '授权令牌首次消费应成功',
  );
  assert.equal(
    await emailChange.consumeChangeToken(authorizeHash, at(25 * MINUTE)),
    null,
    '授权令牌不可重复消费（改主邮箱是破坏性操作，双击必须只有一次生效）',
  );

  // 完成请求后不再算「未结束」
  await emailChange.completeChangeRequest(requestId, at(26 * MINUTE));
  const completed = await emailChange.findChangeRequestById(requestId);
  assert.ok(completed);
  assert.notEqual(completed.completedAt, null);
  assert.equal(
    await emailChange.findOpenChangeRequestByUser(userId),
    null,
    '已完成的请求不该再被当成未结束请求',
  );

  // 取消未结束请求
  const request2 = randomUUID();
  await emailChange.insertChangeRequest({
    id: request2,
    userId,
    target: 'backup',
    newEmail: backup2,
    authorizeVia: 'primary',
    createdAt: at(27 * MINUTE),
  });
  assert.equal(
    await emailChange.cancelOpenChangeRequestsForUser(userId, at(28 * MINUTE)),
    1,
    '应取消 1 个未结束请求',
  );
  assert.equal(await emailChange.findOpenChangeRequestByUser(userId), null);
  const cancelled = await emailChange.findChangeRequestById(request2);
  assert.ok(cancelled);
  assert.notEqual(cancelled.cancelledAt, null);

  // 历史残留请求清理（启动时跑）
  await emailChange.cancelStaleOpenRequests(at(29 * MINUTE), at(30 * MINUTE));
  await emailChange.deleteExpiredChangeTokens(at(MINUTE));

  // ------------------------------------------------------------- 级联清理

  await db.run(
    `DELETE FROM users WHERE id = ${db.dialect === 'postgres' ? '$1' : '?'}`,
    [userId],
  );
  assert.equal(await users.findById(userId), null);
  assert.equal(
    (await profiles.listByUserId(userId)).length,
    0,
    '删用户应级联清掉角色',
  );
  assert.equal(
    await emailChange.findBackupEmailTokenByHash(beKeeperHash),
    null,
    '删用户应级联清掉备用邮箱令牌',
  );
  assert.equal(
    await emailChange.findChangeRequestById(requestId),
    null,
    '删用户应级联清掉改邮箱请求',
  );
  assert.equal(
    await emailChange.findChangeTokenByHash(authorizeHash),
    null,
    '删用户应级联清掉改邮箱令牌',
  );

  await db.run(
    `DELETE FROM users WHERE id = ${db.dialect === 'postgres' ? '$1' : '?'}`,
    [pendingId],
  );
}

test('profileModeRepository: SQLite 方言下 0003 新列与新表读写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-repo-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  try {
    await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
    await exercise(db, 'sqlite-mode');
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'profileModeRepository: PostgreSQL 方言下 0003 新列与新表读写',
  { skip: TEST_DATABASE_URL ? false : '未设置 TEST_DATABASE_URL' },
  async () => {
    const db = PostgresConnection.connect(TEST_DATABASE_URL!);
    try {
      await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
      // 只清本用例自己造的数据：PG 是共享库，无差别清表会抹掉别的用例。
      // 断言里用到的 email 前缀都带 `pg-mode`，删用户即级联清掉三张新表。
      await db.run("DELETE FROM users WHERE email LIKE 'pg-mode-%'");
      await exercise(db, 'pg-mode');
    } finally {
      await db.run("DELETE FROM users WHERE email LIKE 'pg-mode-%'");
      await db.close();
    }
  },
);
