import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { AppError } from '../src/errors.js';

/**
 * 0003 用户名模式的业务规则（服务层，双方言）。
 *
 * ## 覆盖的规则
 *
 * - 默认单用户名；单模式下只能有 1 个可用角色、不能新建、不能删掉当前生效的那个
 * - 单模式下改名与「启用预留角色」共用同一个 30 天窗口（基准 = 当前 active 的
 *   name_changed_at）→ 两者互相挡住对方
 * - 多用户名模式无冷却、活跃 + 预留合计 ≤ 10
 * - 多 -> 单 必须指定保留哪个，其余转预留；窗口从此刻开始
 * - 存量多角色用户（profile_mode_decided_at IS NULL）：除首次决定外一切写操作被拒
 * - Yggdrasil availableProfiles 只列 active
 *
 * ## 时钟
 *
 * IdentityService 接受可注入时钟，这里用一个可推进的假钟：冷却相关的用例必须能
 * 「跳过 30 天再看」，否则要么测不到正向路径，要么得真的等 —— 都不现实。
 *
 * ## 双方言
 *
 * SQLite 恒跑；PostgreSQL 由 TEST_DATABASE_URL 门控。两组用例跑同一个 exercise()，
 * 避免方言差异（0/1 vs TRUE/FALSE、RETURNING 行数）只在一边被发现。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'password123';
const DAY = 24 * 3600 * 1000;
const COOLDOWN_DAYS = 30;

interface Env {
  db: DatabaseConnection;
  users: UserRepository;
  profiles: ProfileRepository;
  identity: IdentityService;
  /** 推进假钟（毫秒） */
  advance: (ms: number) => void;
}

interface DialectCase {
  label: string;
  skip?: string;
  /** email 前缀，PG 侧按它清理共享库（只清自己造的数据） */
  emailPrefix: string;
  /** 角色名前缀，必须满足 3-16 位 [A-Za-z0-9_] */
  nameTag: string;
  setup: (t: TestContext) => Promise<Env>;
}

/** 断言抛出指定错误码，并返回该错误（便于继续断言文案） */
async function assertCode(
  fn: () => Promise<unknown>,
  code: string,
  what: string,
): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `${what}：应抛 AppError，实际 ${String(err)}`);
    assert.equal(err.code, code, `${what}：错误码应为 ${code}，实际 ${err.code}（${err.message}）`);
    return err;
  }
  throw new Error(`${what}：期望抛出 ${code}，但调用成功了`);
}

async function exercise(env: Env, emailPrefix: string, tag: string): Promise<void> {
  const { identity, profiles, users } = env;
  const rnd = randomUUID().slice(0, 4);
  let seq = 0;
  const nm = (): string => `${tag}${rnd}n${(++seq).toString(36)}`;
  const email = (who: string): string => `${emailPrefix}-${rnd}-${who}@test.local`;

  // ==========================================================================
  // A. 新账号默认单用户名：1 个 active、不能新建、改名与启用共用 30 天窗口
  // ==========================================================================

  const aEmail = email('a');
  const reg = await identity.register({
    email: aEmail,
    password: PASSWORD,
    profileName: nm(),
  });
  assert.equal(reg.user.profileMode, 'single', '新账号默认单用户名模式');
  assert.equal(
    reg.user.modeChoiceRequired,
    false,
    '新账号角色数为 0，视作模式已决定（不该弹选择框）',
  );

  let state = await identity.getProfileModeState(reg.user.id);
  assert.equal(state.mode, 'single');
  assert.equal(state.decisionRequired, false);
  assert.equal(state.maxProfiles, 10);
  assert.equal(state.activeLimit, 1, '单模式下可用角色上限为 1');
  assert.equal(state.activeCount, 1);
  assert.equal(state.reservedCount, 0);
  assert.equal(state.cooldownUntil, null, '从未改过名 → 无冷却');

  await assertCode(
    () => identity.createProfile(reg.user.id, nm()),
    'VALIDATION_ERROR',
    '单用户名模式下新建角色',
  );

  // 只有一个角色时也不允许删空（先撞「至少保留一个角色」这条）
  await assertCode(
    () => identity.deleteProfile(reg.user.id, reg.profile.id),
    'VALIDATION_ERROR',
    '删除唯一的角色',
  );

  // 首次改名免费（初始命名不算改名）→ 改名后窗口立刻开始
  await identity.renameProfile(reg.user.id, reg.profile.id, nm());
  state = await identity.getProfileModeState(reg.user.id);
  assert.notEqual(state.cooldownUntil, null, '改名应启动 30 天窗口');
  assert.equal(
    state.cooldownDaysRemaining,
    COOLDOWN_DAYS,
    '刚改名时剩余天数应为完整 30 天',
  );

  await assertCode(
    () => identity.renameProfile(reg.user.id, reg.profile.id, nm()),
    'NAME_COOLDOWN',
    '冷却期内再次改名',
  );

  // ==========================================================================
  // B. 多用户名模式：无冷却、上限 10；多 -> 单 需指定保留者并以此刻起算冷却
  // ==========================================================================

  // 单 -> 多：**刻意不设冷却**。产品上多用户名模式的规则就是「无冷却」，
  // 把切换也拦掉等于给多模式加了它不该有的限制。代价是「切到多模式改名再切回」
  // 可以绕过单模式的 30 天窗口 —— 这是两条规则叠加的必然结果，此处显式记录，
  // 免得日后有人以为是漏改。
  state = await identity.switchMode({ userId: reg.user.id, mode: 'multi' });
  assert.equal(state.mode, 'multi');
  assert.equal(state.activeLimit, 10, '多模式下可用角色上限为 10');
  assert.equal(state.reservedCount, 0);

  // 多模式下改名不受冷却限制（上面的窗口仍在，但只对单模式生效）
  await identity.renameProfile(reg.user.id, reg.profile.id, nm());
  await identity.renameProfile(reg.user.id, reg.profile.id, nm());

  await assertCode(
    () => identity.switchMode({ userId: reg.user.id, mode: 'multi' }),
    'VALIDATION_ERROR',
    '切换到当前已有模式',
  );

  // 补到 10 个（已有 1 个），第 11 个必须被拒
  const extraIds: string[] = [];
  for (let i = 0; i < 9; i += 1) {
    const created = await identity.createProfile(reg.user.id, nm());
    extraIds.push(created.id);
  }
  state = await identity.getProfileModeState(reg.user.id);
  assert.equal(state.activeCount, 10, '多模式下应能建满 10 个角色');
  await assertCode(
    () => identity.createProfile(reg.user.id, nm()),
    'VALIDATION_ERROR',
    '超过 10 个角色的上限',
  );

  // 多 -> 单 而不指定保留者：可用角色多于 1 个，必须拒绝
  await assertCode(
    () => identity.switchMode({ userId: reg.user.id, mode: 'single' }),
    'VALIDATION_ERROR',
    '多 -> 单 未指定保留角色',
  );

  // 指定一个不存在的角色当保留者 → NOT_FOUND
  await assertCode(
    () =>
      identity.switchMode({
        userId: reg.user.id,
        mode: 'single',
        keepProfileId: randomUUID(),
      }),
    'NOT_FOUND',
    '多 -> 单 指定了不存在的角色',
  );

  const keepId = extraIds[0]!;
  state = await identity.switchMode({
    userId: reg.user.id,
    mode: 'single',
    keepProfileId: keepId,
  });
  assert.equal(state.mode, 'single');
  assert.equal(state.activeCount, 1, '多 -> 单 后只应剩 1 个 active');
  assert.equal(state.reservedCount, 9, '其余 9 个应转为预留（数据与名字都保留）');
  assert.notEqual(state.cooldownUntil, null, '多 -> 单 应从此刻开始 30 天窗口');
  assert.equal(state.cooldownDaysRemaining, COOLDOWN_DAYS);

  const reservedList = await profiles.listReservedByUserId(reg.user.id);
  assert.equal(reservedList.length, 9);
  assert.ok(
    reservedList.every((p) => p.name.length > 0),
    '预留角色的名字必须保留（否则会被抢注，冷却期满就换不回来了）',
  );

  // 冷却期内启用预留角色 → MODE_COOLDOWN（与改名共用一个窗口）
  await assertCode(
    () => identity.activateReservedProfile(reg.user.id, reservedList[0]!.id),
    'MODE_COOLDOWN',
    '冷却期内启用预留角色',
  );

  // 已经是 active 的那个不能再被「启用」
  await assertCode(
    () => identity.activateReservedProfile(reg.user.id, keepId),
    'VALIDATION_ERROR',
    '启用一个已是可用状态的角色',
  );

  // 预留角色不能改名（否则单模式多了一条免费抢注通道）
  await assertCode(
    () => identity.renameProfile(reg.user.id, reservedList[0]!.id, nm()),
    'PROFILE_RESERVED',
    '给预留角色改名',
  );

  // 单模式下不能删掉当前生效的角色（删了就没有可用 ID，而恢复路径卡在冷却上）
  await assertCode(
    () => identity.deleteProfile(reg.user.id, keepId),
    'VALIDATION_ERROR',
    '单模式下删除当前生效的角色',
  );

  // 删预留角色是允许的：只是放弃一个占位，不构成身份变更
  const beforeDelete = (await identity.getProfileModeState(reg.user.id)).reservedCount;
  await identity.deleteProfile(reg.user.id, reservedList[0]!.id);
  const afterDelete = await identity.getProfileModeState(reg.user.id);
  assert.equal(afterDelete.reservedCount, beforeDelete - 1, '预留角色应可删除');
  assert.equal(afterDelete.activeCount, 1);

  // 冷却期满 → 可以启用预留角色；当前 active 转预留，窗口重新起算
  env.advance(COOLDOWN_DAYS * DAY + 2 * DAY);
  const targetReserved = (await profiles.listReservedByUserId(reg.user.id))[0]!;
  state = await identity.activateReservedProfile(reg.user.id, targetReserved.id);
  assert.equal(state.activeCount, 1);
  assert.equal(
    state.mode,
    'single',
    '启用预留角色不应改变模式',
  );
  assert.notEqual(state.cooldownUntil, null, '换 ID 后窗口应重新起算');
  assert.equal(
    state.cooldownDaysRemaining,
    COOLDOWN_DAYS,
    '刚换完 ID，剩余天数应回到完整 30 天',
  );

  const newActive = await profiles.findFirstActiveByUserId(reg.user.id);
  assert.ok(newActive);
  assert.equal(newActive.id, targetReserved.id, '被启用的角色应成为当前 active');
  const oldActive = await profiles.findById(keepId);
  assert.ok(oldActive);
  assert.equal(oldActive.status, 'reserved', '原 active 应转为预留（可再换回来）');

  // 换完再换 → 又被冷却挡住（挡住的是「换」，不是某一次具体操作）
  const anotherReserved = (await profiles.listReservedByUserId(reg.user.id))[0]!;
  await assertCode(
    () => identity.activateReservedProfile(reg.user.id, anotherReserved.id),
    'MODE_COOLDOWN',
    '刚换完 ID 又想再换',
  );

  // Yggdrasil 会话只列 active
  const session = await identity.authenticateYggdrasil({
    email: aEmail,
    password: PASSWORD,
  });
  assert.equal(
    session.availableProfiles.length,
    1,
    'availableProfiles 只能列 active 角色（预留角色选了也 join 不进去）',
  );
  assert.equal(session.availableProfiles[0]!.name, newActive.name);
  assert.equal(session.selectedProfile?.name, newActive.name);

  // ==========================================================================
  // C. 存量多角色用户：待选择状态
  // ==========================================================================

  const pendingId = randomUUID();
  const pendingEmail = email('pending');
  await env.db.transaction(async () => {
    await users.insert({
      id: pendingId,
      email: pendingEmail,
      passwordHash: 'x',
      role: 'user',
      now: new Date(),
      profileModeDecidedAt: null,
    });
    for (let i = 0; i < 3; i += 1) {
      await profiles.insert({
        id: randomUUID(),
        userId: pendingId,
        name: nm(),
        now: new Date(),
      });
    }
  });

  const pendingState = await identity.getProfileModeState(pendingId);
  assert.equal(pendingState.decisionRequired, true, '角色数 > 1 的存量用户应待选择');
  assert.equal(pendingState.decidedAt, null);
  assert.equal(pendingState.activeCount, 3, '迁移把存量角色都留成 active');

  const pendingProfiles = await profiles.listByUserId(pendingId);
  assert.equal(pendingProfiles.length, 3);

  // 待选择期间一切写操作被拒（读操作放行，前端要先能列出角色给用户选）
  for (const [what, fn] of [
    ['新建角色', () => identity.createProfile(pendingId, nm())],
    ['改名', () => identity.renameProfile(pendingId, pendingProfiles[0]!.id, nm())],
    ['删除角色', () => identity.deleteProfile(pendingId, pendingProfiles[0]!.id)],
    ['切换模式', () => identity.switchMode({ userId: pendingId, mode: 'multi' })],
    [
      '启用预留角色',
      () => identity.activateReservedProfile(pendingId, pendingProfiles[0]!.id),
    ],
  ] as const) {
    await assertCode(fn, 'MODE_CHOICE_REQUIRED', `待选择状态下${what}`);
  }

  // 选单模式但不给保留者 → 拒绝
  await assertCode(
    () => identity.decideInitialMode({ userId: pendingId, mode: 'single' }),
    'VALIDATION_ERROR',
    '选择单用户名模式但未指定保留角色',
  );
  await assertCode(
    () =>
      identity.decideInitialMode({
        userId: pendingId,
        mode: 'single',
        keepProfileId: randomUUID(),
      }),
    'NOT_FOUND',
    '指定了不存在的角色',
  );

  const keep = pendingProfiles[1]!;
  const decided = await identity.decideInitialMode({
    userId: pendingId,
    mode: 'single',
    keepProfileId: keep.id,
  });
  assert.equal(decided.decisionRequired, false, '选完就不再弹');
  assert.equal(decided.mode, 'single');
  assert.equal(decided.activeCount, 1);
  assert.equal(decided.reservedCount, 2, '其余角色应转预留');
  assert.notEqual(
    decided.cooldownUntil,
    null,
    '从 3 个可用 ID 缩到 1 个 = 一次身份变更，窗口应从此开始',
  );
  assert.notEqual(decided.decidedAt, null, '决定时刻应写回 users');

  await assertCode(
    () => identity.decideInitialMode({ userId: pendingId, mode: 'multi' }),
    'VALIDATION_ERROR',
    '重复决定模式',
  );

  // 决定之后再走普通规则：单模式下仍然不能新建
  await assertCode(
    () => identity.createProfile(pendingId, nm()),
    'VALIDATION_ERROR',
    '决定为单模式后新建角色',
  );

  // 待选择的另一条路：直接选多模式 → 全部保持 active，且不启动窗口
  const multiPendingId = randomUUID();
  await env.db.transaction(async () => {
    await users.insert({
      id: multiPendingId,
      email: email('pending2'),
      passwordHash: 'x',
      role: 'user',
      now: new Date(),
      profileModeDecidedAt: null,
    });
    for (let i = 0; i < 2; i += 1) {
      await profiles.insert({
        id: randomUUID(),
        userId: multiPendingId,
        name: nm(),
        now: new Date(),
      });
    }
  });
  const asMulti = await identity.decideInitialMode({
    userId: multiPendingId,
    mode: 'multi',
  });
  assert.equal(asMulti.mode, 'multi');
  assert.equal(asMulti.activeCount, 2, '选多模式应把角色全部保持可用');
  assert.equal(asMulti.reservedCount, 0);
  assert.equal(
    asMulti.cooldownUntil,
    null,
    '多用户名模式无冷却，首次决定也不该启动窗口',
  );
}

/** 待选择账号的密码是占位串，登录路径的 modeChoiceRequired 用直接构造校验 */
async function exercisePendingLoginFlag(
  env: Env,
  emailPrefix: string,
  tag: string,
): Promise<void> {
  const { identity, users, profiles } = env;
  const rnd = randomUUID().slice(0, 4);
  const id = randomUUID();
  const password = 'password123';
  const hash = await identity.hashPassword(password);
  const now = new Date();
  const addr = `${emailPrefix}-${rnd}-login@test.local`;
  await env.db.transaction(async () => {
    await users.insert({
      id,
      email: addr,
      passwordHash: hash,
      role: 'user',
      now,
      profileModeDecidedAt: null,
    });
    for (let i = 0; i < 2; i += 1) {
      await profiles.insert({
        id: randomUUID(),
        userId: id,
        name: `${tag}${rnd}l${i}`,
        now,
      });
    }
  });

  const login = await identity.loginWeb({ email: addr, password });
  assert.equal(
    login.user.modeChoiceRequired,
    true,
    '待选择账号登录时 modeChoiceRequired 必须为 true',
  );
  assert.equal(login.user.profileMode, 'single');
}

const cases: DialectCase[] = [
  {
    label: 'sqlite',
    emailPrefix: 'sq-pmode',
    nameTag: 'sq',
    setup: async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mscts-pmode-'));
      const db = new SqliteConnection(join(dir, 't.db'));
      await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
      t.after(async () => {
        await db.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      });
      return buildEnv(db);
    },
  },
  TEST_DATABASE_URL
    ? {
        label: 'postgres',
        emailPrefix: 'pg-pmode',
        nameTag: 'pg',
        setup: async (t) => {
          const db = PostgresConnection.connect(TEST_DATABASE_URL!);
          await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
          await db.run("DELETE FROM users WHERE email LIKE 'pg-pmode-%'");
          t.after(async () => {
            await db
              .run("DELETE FROM users WHERE email LIKE 'pg-pmode-%'")
              .catch(() => undefined);
            await db.close().catch(() => undefined);
          });
          return buildEnv(db);
        },
      }
    : {
        label: 'postgres',
        emailPrefix: 'pg-pmode',
        nameTag: 'pg',
        skip: '未设置 TEST_DATABASE_URL，跳过 PostgreSQL 用户名模式测试',
        setup: async () => {
          throw new Error('unreachable');
        },
      },
];

function buildEnv(db: DatabaseConnection): Env {
  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const tokens = new TokenService(new TokenRepository(db));
  let clock = new Date();
  const identity = new IdentityService({
    db,
    users,
    profiles,
    tokens,
    sessions: new MinecraftSessionRepository(db),
    now: () => clock,
  });
  return {
    db,
    users,
    profiles,
    identity,
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

for (const c of cases) {
  test(`profileMode: 用户名模式规则（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    await exercise(env, c.emailPrefix, c.nameTag);
    await exercisePendingLoginFlag(env, c.emailPrefix, c.nameTag);
  });
}
