import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';
import { phAt, toIso } from '../db/rows.js';

/**
 * minecraft_sessions 表 repository —— Yggdrasil join / hasJoined 短会话。
 * TTL 约 30-60 秒（schema §3），过期行由清理任务删除，查询时也按 expires_at 过滤。
 */

export interface NewMinecraftSession {
  tokenId: string;
  profileId: string;
  serverId: string;
  now: Date;
  expiresAt: Date;
}

export interface ActiveMinecraftSession {
  profileId: string;
  profileName: string;
}

export class MinecraftSessionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async insert(session: NewMinecraftSession): Promise<void> {
    await this.db.run(
      `INSERT INTO minecraft_sessions (id, token_id, profile_id, server_id, created_at, expires_at)
       VALUES (${[0, 1, 2, 3, 4, 5].map((i) => phAt(this.db.dialect, i)).join(', ')})`,
      [
        randomUUID(),
        session.tokenId,
        session.profileId,
        session.serverId,
        session.now.toISOString(),
        session.expiresAt.toISOString(),
      ],
    );
  }

  /** 按 serverId 查未过期会话（hasJoined 唯一入口） */
  async findActiveByServerId(
    serverId: string,
    now: Date,
  ): Promise<ActiveMinecraftSession | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ms.profile_id AS profile_id, p.name AS profile_name
       FROM minecraft_sessions ms
       JOIN profiles p ON p.id = ms.profile_id
       WHERE ms.server_id = ${phAt(this.db.dialect, 0)}
         AND ms.expires_at > ${phAt(this.db.dialect, 1)}
       ORDER BY ms.created_at DESC
       LIMIT 1`,
      [serverId, toIso(now)],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      profileId: row['profile_id'] as string,
      profileName: row['profile_name'] as string,
    };
  }

  /** 过期清理任务使用 */
  async deleteExpired(before: Date): Promise<void> {
    await this.db.run(
      `DELETE FROM minecraft_sessions WHERE expires_at < ${phAt(this.db.dialect, 0)}`,
      [before.toISOString()],
    );
  }
}
