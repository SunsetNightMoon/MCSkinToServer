/**
 * 缓存/限流的键命名空间。
 *
 * 单独放一个文件（而不是塞在 cache/index.ts 里）：仓储层只需要键名，
 * 不该因为要一个字符串常量就把 Redis 客户端拉进自己的 import 图。
 */

/** 统一前缀，避免与同库其它应用串键 */
export const KEY_PREFIX = 'mscts';

/** 限流键 */
export const RateLimitKeys = {
  /** Yggdrasil authenticate / signout：按用户名（邮箱） */
  yggdrasilAccount: (account: string): string =>
    `${KEY_PREFIX}:rl:yggdrasil:${account.toLowerCase()}`,
  /** Web 登录：按邮箱 */
  webLogin: (email: string): string =>
    `${KEY_PREFIX}:rl:login:${email.toLowerCase()}`,
  /** Web 注册：按来源地址（无 IP 时退化为 'unknown'） */
  webRegister: (ip: string): string => `${KEY_PREFIX}:rl:register:${ip}`,
  /**
   * 发送/重发验证邮件：按收件邮箱。
   * 这个端点会真的往外发信，不限流就等于给了「用别人邮箱刷信」的免费通道，
   * 而且会把我们自己的发信域名打成垃圾邮件源。
   */
  emailVerification: (email: string): string =>
    `${KEY_PREFIX}:rl:verify:${email.toLowerCase()}`,
  /** 发送重置密码邮件：按收件邮箱，理由同上 */
  passwordReset: (email: string): string =>
    `${KEY_PREFIX}:rl:reset:${email.toLowerCase()}`,
  /**
   * 消费一次性令牌（验证邮箱 / 重置密码）：按来源地址。
   * 令牌本身是 256 bit 随机值、库里只存哈希，猜不出来；这里限流纯粹是压制
   * 「拿字典扫令牌」这种没成本但很吵的行为，不承担安全职责。
   */
  tokenConsume: (ip: string): string => `${KEY_PREFIX}:rl:token:${ip}`,
} as const;

/** 缓存键 */
export const CacheKeys = {
  /** 站点公开设置（变更少、读取频繁） */
  publicSettings: (): string => `${KEY_PREFIX}:cache:settings:public`,
} as const;
