import { randomBytes, randomUUID } from 'node:crypto';
import type {
  TokenRepository,
  TokenType,
  UserRole,
} from '../repositories/tokenRepository.js';
import { sha256Hex } from '../util/crypto.js';

/**
 * 认证上下文核心（蓝图 §7.1）。
 *
 * 框架无关：未来 Express middleware 与 Yggdrasil validate/refresh 端点
 * 都调用这里，不再各自解析 Authorization / 重复实现令牌检查。
 *
 * 安全约定（schema-design §1.6）：
 * - 明文 token 仅在 issue() 返回值中出现一次，数据库只存 sha256
 * - 查找一律按 token_hash（唯一索引）
 */

export type { TokenType, UserRole };

export interface RequestContext {
  userId: string;
  tokenId: string;
  tokenType: TokenType;
  /** Yggdrasil selectedProfile 绑定；web token 为 null */
  profileId: string | null;
  role: UserRole;
}

export type VerifyFailureReason =
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'user_disabled';

export type VerifyResult =
  | { ok: true; context: RequestContext }
  | { ok: false; reason: VerifyFailureReason };

export interface IssueTokenInput {
  tokenType: TokenType;
  userId: string;
  profileId?: string | null;
  /** Yggdrasil clientToken 原样存储（回显用，非凭据） */
  clientToken?: string | null;
  ttlSeconds?: number;
}

export interface IssuedToken {
  /** 明文 token —— 只此一次 */
  token: string;
  tokenId: string;
  expiresAt: string;
}

const DEFAULT_TTL_SECONDS: Record<TokenType, number> = {
  web: 30 * 24 * 3600,
  yggdrasil: 90 * 24 * 3600,
};

export class TokenService {
  constructor(
    private readonly repo: TokenRepository,
    /** 时钟可注入，测试无需 sleep */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: IssueTokenInput): Promise<IssuedToken> {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const now = this.now();
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS[input.tokenType];
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    await this.repo.insert({
      id,
      tokenHash: sha256Hex(token),
      tokenType: input.tokenType,
      clientToken: input.clientToken ?? null,
      userId: input.userId,
      profileId: input.profileId ?? null,
      issuedAt: now,
      expiresAt,
    });

    return { token, tokenId: id, expiresAt: expiresAt.toISOString() };
  }

  /**
   * 验证令牌并返回请求上下文。
   * @param expectedClientToken Yggdrasil validate 场景：提供时必须与存储的 clientToken 一致
   */
  async verify(
    token: string,
    expectedClientToken?: string | null,
  ): Promise<VerifyResult> {
    const found = await this.repo.findByHashWithUser(sha256Hex(token));
    if (!found) return { ok: false, reason: 'invalid' };

    const { token: row, role, isActive } = found;
    if (!isActive) return { ok: false, reason: 'user_disabled' };
    if (row.revokedAt) return { ok: false, reason: 'revoked' };
    if (
      expectedClientToken != null &&
      row.clientToken !== expectedClientToken
    ) {
      return { ok: false, reason: 'invalid' };
    }
    if (new Date(row.expiresAt).getTime() <= this.now().getTime()) {
      return { ok: false, reason: 'expired' };
    }

    return {
      ok: true,
      context: {
        userId: row.userId,
        tokenId: row.id,
        tokenType: row.tokenType,
        profileId: row.profileId,
        role,
      },
    };
  }

  /** 吊销单个明文 token；token 不存在返回 false */
  async revoke(token: string): Promise<boolean> {
    const found = await this.repo.findByHashWithUser(sha256Hex(token));
    if (!found) return false;
    await this.repo.revoke(found.token.id, this.now());
    return true;
  }

  /** 登出所有设备（signout）；可限定 token 类型 */
  async revokeAllForUser(userId: string, tokenType?: TokenType): Promise<void> {
    await this.repo.revokeAllForUser(userId, this.now(), tokenType);
  }

  async touch(tokenId: string): Promise<void> {
    await this.repo.touchLastUsed(tokenId, this.now());
  }
}
