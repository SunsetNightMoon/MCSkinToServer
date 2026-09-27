import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import {
  DEFAULT_BCRYPT_COST,
  MAX_BCRYPT_COST,
  MIN_BCRYPT_COST,
  bcryptCostOf,
  needsRehash,
  resolveBcryptCost,
} from '../src/auth/password.js';
import { IdentityService } from '../src/auth/identity.js';
import type { IdentityDependencies } from '../src/auth/identity.js';

/**
 * 密码哈希强度（Issue #5）。
 *
 * 这个文件守的是两件事：
 * 1. **配置越界不能让服务起不来，也不能静默变强/变弱** —— 钳制 + 回落 + 警告。
 * 2. **cost 必须真的只有一个来源** —— 注册/改密/安装向导都从注入值走，
 *    改动前 identity.ts 与 setupService.ts 各写死一份 10，只靠注释对齐。
 */

test('password: BCRYPT_COST 缺省与脏值都回落到 10，不抛错', () => {
  assert.equal(resolveBcryptCost(undefined), DEFAULT_BCRYPT_COST);
  // 空串与纯空白是「没配」，与脏值同一路径；这两种是管理员最常写错的
  assert.equal(resolveBcryptCost(''), DEFAULT_BCRYPT_COST);
  assert.equal(resolveBcryptCost('   '), DEFAULT_BCRYPT_COST);
  assert.equal(resolveBcryptCost('abc'), DEFAULT_BCRYPT_COST);
  assert.equal(resolveBcryptCost(NaN), DEFAULT_BCRYPT_COST);
});

test('password: 越界被钳制回区间内，而不是照单全收', () => {
  assert.equal(resolveBcryptCost('4'), MIN_BCRYPT_COST, '低于 OWASP 下限要抬回来');
  assert.equal(resolveBcryptCost('9'), MIN_BCRYPT_COST);
  assert.equal(resolveBcryptCost('20'), MAX_BCRYPT_COST, 'cost 20 会让登录变成秒级');
  assert.equal(resolveBcryptCost('12'), 12);
  // 小数取整，避免把 12.7 交给 bcrypt 产生未定义行为
  assert.equal(resolveBcryptCost('12.7'), 12);
});

test('password: 能从哈希串读出 cost，读不出就判 null', async () => {
  assert.equal(bcryptCostOf(await bcrypt.hash('password1234', 4)), 4);
  assert.equal(bcryptCostOf(await bcrypt.hash('password1234', 10)), 10);
  // 2b / 2y 前缀同样是合法 bcrypt 串（不同库写出来的版本标记）
  assert.equal(bcryptCostOf('$2b$12$abcdefghijklmnopqrstuv'), 12);
  assert.equal(bcryptCostOf('$2y$06$abcdefghijklmnopqrstuv'), 6);
  assert.equal(bcryptCostOf(''), null);
  assert.equal(bcryptCostOf('sha256:deadbeef'), null);
  assert.equal(bcryptCostOf('$2a$xx$whatever'), null);
});

test('password: needsRehash 只认「低于目标」，绝不降强度', async () => {
  const legacy = await bcrypt.hash('password1234', 4);
  const current = await bcrypt.hash('password1234', 10);
  assert.equal(needsRehash(legacy, 10), true);
  assert.equal(needsRehash(current, 10), false, '同强度不重算，否则每次登录白算一遍');
  // 管理员把配置调回去时不降级：降强度不是升级
  assert.equal(needsRehash(await bcrypt.hash('password1234', 12), 10), false);
  // 认不出 cost 的串不重算（也升不了），留给告警而不是死循环
  assert.equal(needsRehash('not-a-bcrypt-hash', 12), false);
});

/** 只填必填项的最小依赖：本用例只碰 hashPassword，不碰任何仓储 */
function identityWithCost(bcryptCost?: number): IdentityService {
  return new IdentityService({
    db: {} as never,
    users: {} as never,
    profiles: {} as never,
    tokens: {} as never,
    sessions: {} as never,
    ...(bcryptCost === undefined ? {} : { bcryptCost }),
  } as IdentityDependencies);
}

test('password: hashPassword 用注入的 cost，未注入时按缺省值', async () => {
  assert.equal(bcryptCostOf(await identityWithCost(12).hashPassword('password1234')), 12);
  assert.equal(
    bcryptCostOf(await identityWithCost().hashPassword('password1234')),
    DEFAULT_BCRYPT_COST,
  );
  // 强度校验内置在 hashPassword 里：短密码一律拒绝，调用方不该自己再校验
  await assert.rejects(() => identityWithCost(10).hashPassword('short'), /密码/);
});
