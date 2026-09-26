import type { DatabaseConnection } from '../types.js';
import { phAt, toIso } from '../db/rows.js';

/**
 * 备用邮箱验证 + 改邮箱请求的仓储（0003）。
 *
 * ## 为什么不复用 AccountTokenRepository
 *
 * 那张表（`email_verification_tokens` / `password_reset_tokens`）是**扁平**的
 * 6 列结构：id / user_id / token_hash / expires_at / created_at / used_at。
 * 本模块的两类令牌都带额外维度，塞不进去：
 *
 * - 备用邮箱令牌要记住**正在验证哪个地址**（`pending_email`）。不同步这个目标，
 *   用户连点两次「绑定」到两个不同地址时，后点的验证邮件会唤醒前一次绑定的意图。
 * - 改邮箱令牌要挂在一张**请求**上（`request_id`），并区分 `verify` / `authorize`
 *   两种角色。一次改邮箱天然是两件事（新地址证明归属 + 另一个邮箱授权），
 *   两枚令牌生命周期独立（用户可能只点了其中一个就放弃），平铺进一行无法表达。
 *
 * 硬把这三张表合并会给「一次 UPDATE 漏掉某个条件」留下越权空间 —— 例如
 * authorize 令牌被拿去当 verify 用。表分开、条件写死在 WHERE 里，是更划算的写法。
 *
 * ## 沿用既有约定
 *
 * 1. **明文令牌永不入库**：库里只存 `sha256(明文)` 小写 hex。
 * 2. **消费必须原子**：判定（未使用、未过期）与置位（used_at）写在同一条 UPDATE，
 *    靠数据库原子性定胜负。邮箱验证本身幂等无害，但「改主邮箱」是破坏性的
 *    （旧地址立刻失效），双击链接并发命中绝不能被执行两次。
 * 3. **重发即作废旧链接**：签发新令牌前作废同类未使用令牌，否则历史邮件里的
 *    链接永久有效，攻击面只增不减。
 */

export type EmailChangeTarget = 'primary' | 'backup';
export type EmailChangeRole = 'verify' | 'authorize';

// ---- 备用邮箱验证令牌 ----

export interface BackupEmailTokenRow {
  id: string;
  userId: string;
  /** 本次验证要绑定的备用邮箱地址（小写规范化） */
  pendingEmail: string;
  /** sha256(明文令牌) 小写 hex */
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface NewBackupEmailToken {
  id: string;
  userId: string;
  pendingEmail: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

// ---- 改邮箱请求 ----

export interface EmailChangeRequestRow {
  id: string;
  userId: string;
  /** 这次要改的是哪个邮箱 */
  target: EmailChangeTarget;
  /** 目标新地址（小写规范化） */
  newEmail: string;
  /**
   * 由哪个邮箱承担交叉授权。**创建时固定**，中途不可改 ——
   * 否则用户先按「备用邮箱授权」发起、再想办法把授权方换成新邮箱自己，
   * 交叉验证就被绕过去了。
   */
  authorizeVia: EmailChangeTarget;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface NewEmailChangeRequest {
  id: string;
  userId: string;
  target: EmailChangeTarget;
  newEmail: string;
  authorizeVia: EmailChangeTarget;
  createdAt: Date;
}

// ---- 改邮箱令牌 ----

export interface EmailChangeTokenRow {
  id: string;
  userId: string;
  requestId: string;
  role: EmailChangeRole;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface NewEmailChangeToken {
  id: string;
  userId: string;
  requestId: string;
  role: EmailChangeRole;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const BACKUP_TOKEN_COLUMNS =
  'id, user_id, pending_email, token_hash, expires_at, created_at, used_at';
const REQUEST_COLUMNS =
  'id, user_id, target, new_email, authorize_via, created_at, completed_at, cancelled_at';
const CHANGE_TOKEN_COLUMNS =
  'id, user_id, request_id, role, token_hash, expires_at, created_at, used_at';

function mapBackupToken(raw: Record<string, unknown>): BackupEmailTokenRow {
  return {
    id: raw['id'] as string,
    userId: raw['user_id'] as string,
    pendingEmail: raw['pending_email'] as string,
    tokenHash: raw['token_hash'] as string,
    expiresAt: toIso(raw['expires_at'])!,
    createdAt: toIso(raw['created_at'])!,
    usedAt: toIso(raw['used_at']),
  };
}

function mapRequest(raw: Record<string, unknown>): EmailChangeRequestRow {
  return {
    id: raw['id'] as string,
    userId: raw['user_id'] as string,
    target: raw['target'] as EmailChangeTarget,
    newEmail: raw['new_email'] as string,
    authorizeVia: raw['authorize_via'] as EmailChangeTarget,
    createdAt: toIso(raw['created_at'])!,
    completedAt: toIso(raw['completed_at']),
    cancelledAt: toIso(raw['cancelled_at']),
  };
}

function mapChangeToken(raw: Record<string, unknown>): EmailChangeTokenRow {
  return {
    id: raw['id'] as string,
    userId: raw['user_id'] as string,
    requestId: raw['request_id'] as string,
    role: raw['role'] as EmailChangeRole,
    tokenHash: raw['token_hash'] as string,
    expiresAt: toIso(raw['expires_at'])!,
    createdAt: toIso(raw['created_at'])!,
    usedAt: toIso(raw['used_at']),
  };
}

/**
 * `expires_at > $n` 的比较在 PG 侧要显式转型：列是 TIMESTAMPTZ，参数以 ISO 字符串
 * 下发，不转型时个别版本会把 $n 当 text 处理（与 accountTokenRepository 同因）。
 */
function nowExpr(db: DatabaseConnection, index: number): string {
  return db.dialect === 'postgres'
    ? `${phAt(db.dialect, index)}::timestamptz`
    : phAt(db.dialect, index);
}

export class EmailChangeRepository {
  constructor(private readonly db: DatabaseConnection) {}

  // ==========================================================================
  // 1. 备用邮箱验证令牌
  // ==========================================================================

  async insertBackupEmailToken(token: NewBackupEmailToken): Promise<void> {
    await this.db.run(
      `INSERT INTO backup_email_tokens
         (id, user_id, pending_email, token_hash, expires_at, created_at)
       VALUES (${[0, 1, 2, 3, 4, 5].map((i) => phAt(this.db.dialect, i)).join(', ')})`,
      [
        token.id,
        token.userId,
        token.pendingEmail.toLowerCase(),
        token.tokenHash,
        token.expiresAt.toISOString(),
        token.createdAt.toISOString(),
      ],
    );
  }

  async findBackupEmailTokenByHash(
    tokenHash: string,
  ): Promise<BackupEmailTokenRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${BACKUP_TOKEN_COLUMNS} FROM backup_email_tokens
       WHERE token_hash = ${phAt(this.db.dialect, 0)}`,
      [tokenHash],
    );
    return rows[0] ? mapBackupToken(rows[0]) : null;
  }

  /** 原子消费：仅当存在、未使用、未过期时置 used_at 并返回该行 */
  async consumeBackupEmailToken(
    tokenHash: string,
    at: Date,
  ): Promise<BackupEmailTokenRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE backup_email_tokens SET used_at = ${phAt(this.db.dialect, 0)}
       WHERE token_hash = ${phAt(this.db.dialect, 1)}
         AND used_at IS NULL
         AND expires_at > ${nowExpr(this.db, 2)}
       RETURNING ${BACKUP_TOKEN_COLUMNS}`,
      [at.toISOString(), tokenHash, at.toISOString()],
    );
    return rows[0] ? mapBackupToken(rows[0]) : null;
  }

  /** 作废该用户未使用的备用邮箱令牌（发新链接前调用） */
  async invalidateUnusedBackupEmailTokens(
    userId: string,
    at: Date,
  ): Promise<void> {
    await this.db.run(
      `UPDATE backup_email_tokens SET used_at = ${phAt(this.db.dialect, 0)}
       WHERE user_id = ${phAt(this.db.dialect, 1)} AND used_at IS NULL`,
      [at.toISOString(), userId],
    );
  }

  async deleteExpiredBackupEmailTokens(before: Date): Promise<void> {
    await this.db.run(
      `DELETE FROM backup_email_tokens WHERE expires_at < ${phAt(this.db.dialect, 0)}`,
      [before.toISOString()],
    );
  }

  // ==========================================================================
  // 2. 改邮箱请求
  // ==========================================================================

  async insertChangeRequest(req: NewEmailChangeRequest): Promise<void> {
    await this.db.run(
      `INSERT INTO email_change_requests
         (id, user_id, target, new_email, authorize_via, created_at)
       VALUES (${[0, 1, 2, 3, 4, 5].map((i) => phAt(this.db.dialect, i)).join(', ')})`,
      [
        req.id,
        req.userId,
        req.target,
        req.newEmail.toLowerCase(),
        req.authorizeVia,
        req.createdAt.toISOString(),
      ],
    );
  }

  async findChangeRequestById(
    id: string,
  ): Promise<EmailChangeRequestRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${REQUEST_COLUMNS} FROM email_change_requests
       WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
    return rows[0] ? mapRequest(rows[0]) : null;
  }

  /** 用户当前未完成、未取消的改邮箱请求（同一时刻最多一个） */
  async findOpenChangeRequestByUser(
    userId: string,
  ): Promise<EmailChangeRequestRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${REQUEST_COLUMNS} FROM email_change_requests
       WHERE user_id = ${phAt(this.db.dialect, 0)}
         AND completed_at IS NULL
         AND cancelled_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ? mapRequest(rows[0]) : null;
  }

  /**
   * 抢占式关闭请求：仅当请求仍「未完成未取消」时写入 completed_at，
   * 抢到的返回 true。返回 false 说明别的调用者已经处理过（或请求已取消）。
   *
   * 这是邮箱变更落库的**唯一仲裁点**：判据（未完成）与写入在同一条 UPDATE 里，
   * 靠数据库原子性保证「一次变更只被落地一次」。
   */
  async claimChangeRequest(id: string, at: Date): Promise<boolean> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE email_change_requests SET completed_at = ${phAt(this.db.dialect, 0)}
       WHERE id = ${phAt(this.db.dialect, 1)}
         AND completed_at IS NULL
         AND cancelled_at IS NULL
       RETURNING id`,
      [at.toISOString(), id],
    );
    return rows.length > 0;
  }

  async completeChangeRequest(id: string, at: Date): Promise<void> {
    await this.db.run(
      `UPDATE email_change_requests SET completed_at = ${phAt(this.db.dialect, 0)}
       WHERE id = ${phAt(this.db.dialect, 1)} AND completed_at IS NULL`,
      [at.toISOString(), id],
    );
  }

  /** 取消单个请求（仅当未完成未取消） */
  async cancelChangeRequest(id: string, at: Date): Promise<boolean> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE email_change_requests SET cancelled_at = ${phAt(this.db.dialect, 0)}
       WHERE id = ${phAt(this.db.dialect, 1)}
         AND completed_at IS NULL
         AND cancelled_at IS NULL
       RETURNING id`,
      [at.toISOString(), id],
    );
    return rows.length > 0;
  }

  /**
   * 取消该用户全部未结束的请求。
   * 发起新请求前调用 —— 同时挂两个改邮箱请求会让「哪个新地址生效」取决于
   * 用户先点开哪封信，而信里的旧地址可能早已不是用户想要的。
   */
  async cancelOpenChangeRequestsForUser(
    userId: string,
    at: Date,
  ): Promise<number> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE email_change_requests SET cancelled_at = ${phAt(this.db.dialect, 0)}
       WHERE user_id = ${phAt(this.db.dialect, 1)}
         AND completed_at IS NULL
         AND cancelled_at IS NULL
       RETURNING id`,
      [at.toISOString(), userId],
    );
    return rows.length;
  }

  /** 清理长期未完成的历史请求（启动时执行；令牌已被清理，请求只是残留状态） */
  async cancelStaleOpenRequests(createdBefore: Date, at: Date): Promise<number> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE email_change_requests SET cancelled_at = ${phAt(this.db.dialect, 0)}
       WHERE completed_at IS NULL
         AND cancelled_at IS NULL
         AND created_at < ${phAt(this.db.dialect, 1)}
       RETURNING id`,
      [at.toISOString(), createdBefore.toISOString()],
    );
    return rows.length;
  }

  // ==========================================================================
  // 3. 改邮箱令牌（verify / authorize）
  // ==========================================================================

  async insertChangeToken(token: NewEmailChangeToken): Promise<void> {
    await this.db.run(
      `INSERT INTO email_change_tokens
         (id, user_id, request_id, role, token_hash, expires_at, created_at)
       VALUES (${[0, 1, 2, 3, 4, 5, 6]
         .map((i) => phAt(this.db.dialect, i))
         .join(', ')})`,
      [
        token.id,
        token.userId,
        token.requestId,
        token.role,
        token.tokenHash,
        token.expiresAt.toISOString(),
        token.createdAt.toISOString(),
      ],
    );
  }

  async findChangeTokenByHash(
    tokenHash: string,
  ): Promise<EmailChangeTokenRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${CHANGE_TOKEN_COLUMNS} FROM email_change_tokens
       WHERE token_hash = ${phAt(this.db.dialect, 0)}`,
      [tokenHash],
    );
    return rows[0] ? mapChangeToken(rows[0]) : null;
  }

  /**
   * 某请求下的全部令牌（最多两枚：verify + authorize）。
   *
   * 存在的意义是判断「两枚是不是都点过了」—— 改邮箱要两个邮箱各自确认，
   * 任何一侧单独完成都不产生效果。用 findByHash 只能问到手上这一枚，
   * 拿不到另一枚的状态。
   */
  async listChangeTokensByRequest(
    requestId: string,
  ): Promise<EmailChangeTokenRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${CHANGE_TOKEN_COLUMNS} FROM email_change_tokens
       WHERE request_id = ${phAt(this.db.dialect, 0)}
       ORDER BY created_at ASC, id ASC`,
      [requestId],
    );
    return rows.map(mapChangeToken);
  }

  /** 原子消费：仅当存在、未使用、未过期时置 used_at 并返回该行 */
  async consumeChangeToken(
    tokenHash: string,
    at: Date,
  ): Promise<EmailChangeTokenRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE email_change_tokens SET used_at = ${phAt(this.db.dialect, 0)}
       WHERE token_hash = ${phAt(this.db.dialect, 1)}
         AND used_at IS NULL
         AND expires_at > ${nowExpr(this.db, 2)}
       RETURNING ${CHANGE_TOKEN_COLUMNS}`,
      [at.toISOString(), tokenHash, at.toISOString()],
    );
    return rows[0] ? mapChangeToken(rows[0]) : null;
  }

  /**
   * 作废某请求中**同角色**的未使用令牌（重发该角色邮件前调用）。
   * 只按角色作废而非整请求：新地址那封重发不该顺手干掉另一个邮箱的授权链接，
   * 否则用户永远无法凑齐两枚令牌完成变更。
   */
  async invalidateUnusedChangeTokensForRequest(
    requestId: string,
    role: EmailChangeRole,
    at: Date,
  ): Promise<void> {
    await this.db.run(
      `UPDATE email_change_tokens SET used_at = ${phAt(this.db.dialect, 0)}
       WHERE request_id = ${phAt(this.db.dialect, 1)}
         AND role = ${phAt(this.db.dialect, 2)}
         AND used_at IS NULL`,
      [at.toISOString(), requestId, role],
    );
  }

  async deleteExpiredChangeTokens(before: Date): Promise<void> {
    await this.db.run(
      `DELETE FROM email_change_tokens WHERE expires_at < ${phAt(this.db.dialect, 0)}`,
      [before.toISOString()],
    );
  }
}
