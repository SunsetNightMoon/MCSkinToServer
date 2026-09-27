import bcrypt from 'bcryptjs';

/**
 * 密码哈希强度的唯一来源（Issue #5）。
 *
 * ## 为什么要单独一个模块
 *
 * 改动前 cost 是两份各自写死的 `const BCRYPT_COST = 10`（`src/auth/identity.ts` 与
 * `src/setup/setupService.ts`），后者只靠一句注释「与前者的值保持一致」维系。
 * 注册、改密、安装向导三条写入路径只要有一条被改而另一条没跟上，就会出现
 * 「同一个站里不同账号强度不一样」，而这类不一致在生产上没有任何症状。
 * 强度因此必须从配置读出一个值，再分发给所有写入路径。
 *
 * ## 为什么是「可配 + 默认 10」而不是直接抬到 12
 *
 * bcryptjs 是纯 JS 实现，cost 每 +1 耗时约翻倍。本机（16 核）实测：
 * cost 10 → hash 118ms / compare 78ms；cost 12 → hash 313ms / compare 342ms。
 * 也即默认配置下登录一次约 80ms，提到 12 就变成约 340ms —— 低配 VPS 上还会更糟。
 * 强度是部署决策（取决于机器和威胁模型），所以给环境变量 + 区间钳制，
 * 默认值保持 10（OWASP 最低线）不变，升级与否由管理员显式决定。
 *
 * ## 存量哈希怎么升级
 *
 * cost 就写在哈希串里（`$2a$10$…`），所以「哪条还是旧强度」是可判定的：
 * 登录时已经用旧哈希校验通过、明文就在手上，此时若 cost 低于目标值就顺手重算入库
 * （见 `needsRehash` 与 `IdentityService` 的调用点）。管理员改一次环境变量，
 * 全站随用户自然登录逐步收敛，不需要强制所有人改密码。
 */

/** OWASP 当前建议的下限；再低就不给用（越界会被钳制回来） */
export const MIN_BCRYPT_COST = 10;

/** 上限：cost 15 起单次哈希就要秒级，纯 JS 实现下会把登录变成可用性事故 */
export const MAX_BCRYPT_COST = 14;

/** 未配置时的缺省强度（与改动前完全一致，避免升级即变慢） */
export const DEFAULT_BCRYPT_COST = 10;

/**
 * 把 `BCRYPT_COST` 解析成一个可用 cost。
 *
 * 越界与脏值都**钳制/回落到区间内**而不是抛错：装到一半发现服务起不来，
 * 比登录慢 200ms 严重得多；但会打一条警告，让配置错误不至于静默生效。
 */
export function resolveBcryptCost(raw: unknown): number {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return DEFAULT_BCRYPT_COST;
  const value = Number(text);
  if (!Number.isFinite(value)) {
    console.warn(`[auth] BCRYPT_COST="${text}" 不是数字，按 ${DEFAULT_BCRYPT_COST} 处理`);
    return DEFAULT_BCRYPT_COST;
  }
  const clamped = Math.min(MAX_BCRYPT_COST, Math.max(MIN_BCRYPT_COST, Math.floor(value)));
  if (clamped !== value) {
    console.warn(
      `[auth] BCRYPT_COST=${value} 超出 ${MIN_BCRYPT_COST}-${MAX_BCRYPT_COST}，按 ${clamped} 处理`,
    );
  }
  return clamped;
}

/** 从 bcrypt 哈希串里读出 cost；不是合法 bcrypt 串时返回 null */
export function bcryptCostOf(hash: string): number | null {
  // 形如 $2a$10$<22 字节盐><31 字节摘要>，也接受 2b / 2y 前缀
  const match = /^\$2[aby]\$(\d{2})\$/.exec(hash ?? '');
  if (!match) return null;
  const cost = Number(match[1]);
  return Number.isFinite(cost) ? cost : null;
}

/**
 * 这条哈希是否需要在本次登录里重算。
 *
 * 只认「低于目标强度」这一个方向：cost 比目标高（例如管理员把环境变量调回去了）
 * 时**不降级** —— 降强度不是升级，而且会让每次登录都白算一次哈希。
 */
export function needsRehash(hash: string, targetCost: number): boolean {
  const current = bcryptCostOf(hash);
  return current !== null && current < targetCost;
}

/** 按给定 cost 生成哈希；调用方不要再各自写死 cost */
export function hashPasswordWithCost(password: string, cost: number): Promise<string> {
  return bcrypt.hash(password, cost);
}
