import type { IdentityService } from '../auth/identity.js';

/**
 * 登录类端点的限流键：**按账号**取，而不是按客户端提交的那个字符串。
 *
 * 为什么不能按提交值：一个账号可以有主邮箱 + 一个已验证的备用邮箱，两者都能登录。
 * 按提交字符串取键就等于给同一个账号开了两个互不相干的桶 —— 攻击者把主邮箱的
 * 5 次/5 分钟打满后换备用邮箱接着试，定向撞库的配额直接翻倍。启动器侧
 * （Yggdrasil `username`）同理。
 *
 * 解析不出账号时（地址不存在、跨列冲突、超长畸形值）**回落到按提交值取键**：
 * 随机邮箱洪水不能挤进同一个桶，否则任何拼错邮箱或用临时邮箱的人都会被别人的
 * 尝试连坐，那才是真给用户关门的洞。
 *
 * 网页登录与启动器 authenticate/signout 共用这一份口径：两处都必须在自己的
 * 路由里先算键，而「什么算同一个账号」的判断只能有一个来源（见 resolveAuthBucketUserId）。
 */
export async function authBucketKey(
  identity: IdentityService,
  submitted: string | null,
  buildKey: (address: string) => string,
): Promise<string | null> {
  if (submitted === null) return null;
  const userId = await identity.resolveAuthBucketUserId(submitted);
  return buildKey(userId ?? submitted);
}
