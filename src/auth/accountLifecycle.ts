import type { DatabaseConnection } from '../types.js';
import type { AssetRepository } from '../repositories/assetRepository.js';
import type { ProfileRepository } from '../repositories/profileRepository.js';
import type { UserRepository } from '../repositories/userRepository.js';
import { ACCOUNT_DELETE_GRACE_MS } from './identity.js';
import { emitPluginEvent } from '../plugins/events.js';

/**
 * 账号宽限期到期清理（注销生命周期，对应 0002_account_lifecycle.sql）。
 *
 * 独立于 IdentityService 的原因：清理需要 AssetRepository，而身份服务不应依赖
 * 素材仓储。由服务启动时调用一次（不引入定时器），失败不阻塞启动。
 *
 * 清除内容：该用户拥有的素材、全部角色（profile_assets 随外键级联）。
 * **users 行保留**并写入 purged_at：
 *   - SQLite 的 user_uid 由应用层 MAX(user_uid)+1 分配，物理删行会让 UID 被
 *     后续注册复用，而 UID 要求永不复用；
 *   - 同时行内个人数据被清空（邮箱改墓碑值、密码清空、停用），原邮箱得以释放。
 */

export interface AccountPurgeDependencies {
  db: DatabaseConnection;
  users: UserRepository;
  profiles: ProfileRepository;
  assets: AssetRepository;
  /** 时钟可注入（测试） */
  now?: () => Date;
}

export interface AccountPurgeResult {
  /** 本次清除的账号数 */
  purged: number;
  /** 被清除的账号 id（便于日志/测试断言） */
  userIds: string[];
}

export async function purgeExpiredAccounts(
  deps: AccountPurgeDependencies,
): Promise<AccountPurgeResult> {
  const now = deps.now ? deps.now() : new Date();
  const cutoff = new Date(now.getTime() - ACCOUNT_DELETE_GRACE_MS);
  const expired = await deps.users.findExpiredDeleted(cutoff);

  for (const user of expired) {
    const profileIds = (await deps.profiles.listByUserId(user.id)).map((item) => item.id);
    await deps.db.transaction(async () => {
      await deps.assets.deleteByOwner(user.id);
      await deps.profiles.deleteByUserId(user.id);
      await deps.users.purgeUser(
        user.id,
        `deleted-uid${user.userUid}@invalid.local`,
        now,
      );
    });
    // 插件事件：整个事务已提交，插件此刻看到的库状态与这里一致
    emitPluginEvent('account.purged', { userId: user.id, profileIds });
  }

  return { purged: expired.length, userIds: expired.map((user) => user.id) };
}
