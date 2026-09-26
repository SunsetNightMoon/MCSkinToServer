import type { DatabaseConnection } from '../types.js';
import { phAt, toBoolean, toIso } from '../db/rows.js';

/**
 * tokens 表的 repository —— repository 层的第一个实现，确立层模式：
 * 只通过 DatabaseConnection 访问数据、占位符按方言生成、行值统一归一化。
 */

export type TokenType = 'web' | 'yggdrasil';
export type UserRole = 'user' | 'admin' | 'super_admin';

export interface TokenRow {
  id: string;
  /** sha256(明文 token) 小写 hex；明文永不入库 */
  tokenHash: string;
  tokenType: TokenType;
  clientToken: string | null;
  userId: string;
  profileId: string | null;
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** token 行 + 所属用户的关键权限字段（verify 的 JOIN 结果） */
export interface TokenWithUser {
  token: TokenRow;
  role: UserRole;
  isActive: boolean;
}

export interface NewTokenRow {
  id: string;
  tokenHash: string;
  tokenType: TokenType;
  clientToken: string | null;
  userId: string;
  profileId: string | null;
  issuedAt: Date;
  expiresAt: Date;
}

const TOKEN_COLUMNS =
  't.id, t.token_hash, t.token_type, t.client_token, t.user_id, t.profile_id, ' +
  't.issued_at, t.expires_at, t.last_used_at, t.revoked_at';

function mapTokenRow(raw: Record<string, unknown>): TokenRow {
  return {
    id: raw['id'] as string,
    tokenHash: raw['token_hash'] as string,
    tokenType: raw['token_type'] as TokenType,
    clientToken: (raw['client_token'] as string | null) ?? null,
    userId: raw['user_id'] as string,
    profileId: (raw['profile_id'] as string | null) ?? null,
    issuedAt: toIso(raw['issued_at'])!,
    expiresAt: toIso(raw['expires_at'])!,
    lastUsedAt: toIso(raw['last_used_at']),
    revokedAt: toIso(raw['revoked_at']),
  };
}

export class TokenRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async insert(t: NewTokenRow): Promise<void> {
    const cols = [
      'id',
      'token_hash',
      'token_type',
      'client_token',
      'user_id',
      'profile_id',
      'issued_at',
      'expires_at',
    ];
    await this.db.run(
      `INSERT INTO tokens (${cols.join(', ')}) VALUES (${cols
        .map((_, i) => phAt(this.db.dialect, i))
        .join(', ')})`,
      [
        t.id,
        t.tokenHash,
        t.tokenType,
        t.clientToken,
        t.userId,
        t.profileId,
        t.issuedAt.toISOString(),
        t.expiresAt.toISOString(),
      ],
    );
  }

  /** 按 hash 查 token 并联出用户角色/状态；不存在返回 null */
  async findByHashWithUser(tokenHash: string): Promise<TokenWithUser | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${TOKEN_COLUMNS}, u.role AS user_role, u.is_active AS user_is_active
       FROM tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ${phAt(this.db.dialect, 0)}`,
      [tokenHash],
    );
    const raw = rows[0];
    if (!raw) return null;
    return {
      token: mapTokenRow(raw),
      role: raw['user_role'] as UserRole,
      isActive: toBoolean(raw['user_is_active']),
    };
  }

  async revoke(tokenId: string, revokedAt: Date): Promise<void> {
    await this.db.run(
      `UPDATE tokens SET revoked_at = ${phAt(this.db.dialect, 0)}
       WHERE id = ${phAt(this.db.dialect, 1)} AND revoked_at IS NULL`,
      [revokedAt.toISOString(), tokenId],
    );
  }

  /** 吊销用户全部（或指定类型的）未吊销 token */
  async revokeAllForUser(
    userId: string,
    revokedAt: Date,
    tokenType?: TokenType,
  ): Promise<void> {
    const params: unknown[] = [revokedAt.toISOString(), userId];
    let where = `user_id = ${phAt(this.db.dialect, 1)} AND revoked_at IS NULL`;
    if (tokenType) {
      params.push(tokenType);
      where += ` AND token_type = ${phAt(this.db.dialect, params.length - 1)}`;
    }
    await this.db.run(
      `UPDATE tokens SET revoked_at = ${phAt(this.db.dialect, 0)} WHERE ${where}`,
      params,
    );
  }

  async touchLastUsed(tokenId: string, at: Date): Promise<void> {
    await this.db.run(
      `UPDATE tokens SET last_used_at = ${phAt(this.db.dialect, 0)}
       WHERE id = ${phAt(this.db.dialect, 1)}`,
      [at.toISOString(), tokenId],
    );
  }

  /** 清理已过期 token（过期清理任务使用） */
  async deleteExpired(before: Date): Promise<void> {
    await this.db.run(
      `DELETE FROM tokens WHERE expires_at < ${phAt(this.db.dialect, 0)}`,
      [before.toISOString()],
    );
  }
}
