import type { DatabaseConnection } from '../types.js';
import { phAt, toIso } from '../db/rows.js';

/**
 * 账号辅助流程的一次性令牌仓储。
 *
 * `email_verification_tokens` 与 `password_reset_tokens` 在 schema 里是两张
 * **结构完全相同**的表（id / user_id / token_hash / expires_at / created_at / used_at）。
 * 分开建表是刻意的 —— 邮箱验证链接和重置密码链接的权限后果完全不同，
 * 同表加 kind 列会让「一次 UPDATE 漏掉 kind 条件」变成越权风险。
 *
 * 但读取代码没必要抄两遍：本仓储用一个 kind 参数在两张表之间切换，
 * 表名只在这里出现一次，其余业务层看不到 SQL 表名。
 *
 * 明文令牌永不入库：库里只存 sha256(明文)（沿用 tokens 表的既有约定）。
 *
 * ## 消费必须是原子的
 *
 * 「查一下有没有用过，没用过就标记已用」是两个语句，中间存在竞态：
 * 用户双击邮件链接、或邮件客户端预取链接，就可能并发命中同一个令牌，
 * 而两次都通过检查 —— 验证邮箱本身幂等无害，重置密码则是**同一个令牌改两次密码**。
 * 因此 consume() 把判定条件全部写进 UPDATE 的 WHERE，靠数据库的原子性定胜负：
 * 只有一行被更新时才算成功，拿不到行就是输了。
 */

export type AccountTokenKind = 'email_verification' | 'password_reset';

const TABLES: Record<AccountTokenKind, string> = {
  email_verification: 'email_verification_tokens',
  password_reset: 'password_reset_tokens',
};

const COLUMNS = 'id, user_id, token_hash, expires_at, created_at, used_at';

export interface AccountTokenRow {
  id: string;
  userId: string;
  /** sha256(明文令牌) 小写 hex */
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface NewAccountToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

function mapRow(raw: Record<string, unknown>): AccountTokenRow {
  return {
    id: raw['id'] as string,
    userId: raw['user_id'] as string,
    tokenHash: raw['token_hash'] as string,
    expiresAt: toIso(raw['expires_at'])!,
    createdAt: toIso(raw['created_at'])!,
    usedAt: toIso(raw['used_at']),
  };
}

export class AccountTokenRepository {
  constructor(private readonly db: DatabaseConnection) {}

  private table(kind: AccountTokenKind): string {
    return TABLES[kind];
  }

  async insert(kind: AccountTokenKind, token: NewAccountToken): Promise<void> {
    const cols = ['id', 'user_id', 'token_hash', 'expires_at', 'created_at'];
    await this.db.run(
      `INSERT INTO ${this.table(kind)} (${cols.join(', ')})
       VALUES (${cols.map((_, i) => phAt(this.db.dialect, i)).join(', ')})`,
      [
        token.id,
        token.userId,
        token.tokenHash,
        token.expiresAt.toISOString(),
        token.createdAt.toISOString(),
      ],
    );
  }

  async findByHash(
    kind: AccountTokenKind,
    tokenHash: string,
  ): Promise<AccountTokenRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${this.table(kind)}
       WHERE token_hash = ${phAt(this.db.dialect, 0)}`,
      [tokenHash],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * 原子消费：仅当令牌存在、未被使用、且未过期时标记 used_at 并返回该行。
   * 任何条件不满足都返回 null —— 由调用方结合 findByHash 的结果给出精确的错误文案。
   *
   * expires_at 的比较在 PG 侧需要显式转型：列是 TIMESTAMPTZ，而参数以 ISO 字符串下发，
   * 不转型时方言推断在部分版本上会把 $n 当 text 处理（与 settingRepository 的 jsonb 同因）。
   */
  async consume(
    kind: AccountTokenKind,
    tokenHash: string,
    at: Date,
  ): Promise<AccountTokenRow | null> {
    const table = this.table(kind);
    const nowExpr =
      this.db.dialect === 'postgres'
        ? `${phAt(this.db.dialect, 2)}::timestamptz`
        : phAt(this.db.dialect, 2);
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE ${table} SET used_at = ${phAt(this.db.dialect, 0)}
       WHERE token_hash = ${phAt(this.db.dialect, 1)}
         AND used_at IS NULL
         AND expires_at > ${nowExpr}
       RETURNING ${COLUMNS}`,
      [at.toISOString(), tokenHash, at.toISOString()],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * 把该用户同类令牌中尚未使用的一次性作废。
   * 发新链接前调用，保证「只有最新那封邮件里的链接有效」——
   * 否则用户连点几次「重发」，任何一封旧邮件里的链接都能用，攻击面随时间只增不减。
   */
  async invalidateUnusedForUser(
    kind: AccountTokenKind,
    userId: string,
    at: Date,
  ): Promise<void> {
    await this.db.run(
      `UPDATE ${this.table(kind)} SET used_at = ${phAt(this.db.dialect, 0)}
       WHERE user_id = ${phAt(this.db.dialect, 1)} AND used_at IS NULL`,
      [at.toISOString(), userId],
    );
  }

  /** 清理过期令牌（启动时执行一次；表只增不减会无限膨胀） */
  async deleteExpired(kind: AccountTokenKind, before: Date): Promise<void> {
    await this.db.run(
      `DELETE FROM ${this.table(kind)}
       WHERE expires_at < ${phAt(this.db.dialect, 0)}`,
      [before.toISOString()],
    );
  }
}
