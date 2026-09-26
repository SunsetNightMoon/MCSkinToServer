import type { DatabaseConnection } from '../types.js';
import { phAt } from '../db/rows.js';

/**
 * 人机验证挑战的仓储（0004）。
 *
 * ## 三条约定
 *
 * 1. **同一 session_id 只保留最新一道题**：生成时先删旧行再插入，在**同一个事务**里
 *    完成。用 `ON CONFLICT DO UPDATE` 也行，但两个方言的冲突目标写法略有差别，
 *    而「删了再插」在两边都是同一句 SQL，读起来也没有方言分支。
 * 2. **消费必须原子**：判定（未使用、未过期）与置位（`used_at`）写在同一条 UPDATE。
 *    一道题只能校验一次 —— 否则同一个答案可以被无限次提交，等于没有验证码。
 * 3. **答案只存 sha256**：见表注释。明文答案只在生成那一刻存在于内存与响应里
 *    （响应里只有题目，连明文都不出现）。
 */
export interface CaptchaChallengeRow {
  id: string;
  /** 客户端生成的关联号 */
  sessionId: string;
  /** sha256(规范化答案) 小写 hex */
  answerHash: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface NewCaptchaChallenge {
  id: string;
  sessionId: string;
  answerHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const COLUMNS =
  'id, session_id, answer_hash, expires_at, created_at, used_at';

function mapRow(row: Record<string, unknown>): CaptchaChallengeRow {
  return {
    id: String(row['id']),
    sessionId: String(row['session_id']),
    answerHash: String(row['answer_hash']),
    expiresAt: String(row['expires_at']),
    createdAt: String(row['created_at']),
    usedAt: row['used_at'] === null || row['used_at'] === undefined
      ? null
      : String(row['used_at']),
  };
}

/** PG 上时间列是 timestamptz，绑参必须显式转型，否则报 text 与 timestamptz 不匹配 */
function timeAt(db: DatabaseConnection, index: number): string {
  return db.dialect === 'postgres'
    ? `${phAt(db.dialect, index)}::timestamptz`
    : phAt(db.dialect, index);
}

export class CaptchaRepository {
  constructor(private readonly db: DatabaseConnection) {}

  /**
   * 写入一道新题。**同一 session_id 的旧题先删掉** ——
   * 用户点「换一道」时会带新的 sessionId，但同 id 重放（脚本行为）不应留下两条记录。
   * 两句 SQL 放在同一事务里：中途失败不能留下「旧题已删、新题没写」的空洞。
   */
  async replace(challenge: NewCaptchaChallenge): Promise<void> {
    await this.db.transaction(async () => {
      const p = (i: number) => phAt(this.db.dialect, i);
      await this.db.run(
        `DELETE FROM captcha_challenges WHERE session_id = ${p(0)}`,
        [challenge.sessionId],
      );
      await this.db.run(
        `INSERT INTO captcha_challenges
           (id, session_id, answer_hash, expires_at, created_at)
         VALUES (${p(0)}, ${p(1)}, ${p(2)}, ${timeAt(this.db, 3)}, ${timeAt(this.db, 4)})`,
        [
          challenge.id,
          challenge.sessionId,
          challenge.answerHash,
          challenge.expiresAt.toISOString(),
          challenge.createdAt.toISOString(),
        ],
      );
    });
  }

  async findBySessionId(sessionId: string): Promise<CaptchaChallengeRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM captcha_challenges
       WHERE session_id = ${phAt(this.db.dialect, 0)}`,
      [sessionId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * 原子消费：仅当存在、未使用、未过期时置 `used_at` 并返回该行。
   * 返回 null 表示「这道题不可用」（不存在 / 已用过 / 已过期）——
   * 三种情况刻意不区分，避免给探测者额外信息。
   */
  async consume(
    sessionId: string,
    at: Date,
  ): Promise<CaptchaChallengeRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `UPDATE captcha_challenges SET used_at = ${timeAt(this.db, 0)}
       WHERE session_id = ${phAt(this.db.dialect, 1)}
         AND used_at IS NULL
         AND expires_at > ${timeAt(this.db, 2)}
       RETURNING ${COLUMNS}`,
      [at.toISOString(), sessionId, at.toISOString()],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** 清理过期行；生成新题时顺带调用，保证表不会无限增长 */
  async deleteExpired(before: Date): Promise<void> {
    await this.db.run(
      `DELETE FROM captcha_challenges
       WHERE expires_at < ${timeAt(this.db, 0)}`,
      [before.toISOString()],
    );
  }

  async countAll(): Promise<number> {
    const rows = await this.db.query<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM captcha_challenges',
    );
    return Number(rows[0]?.n ?? 0);
  }
}
