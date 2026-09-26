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
} as const;

/** 缓存键 */
export const CacheKeys = {
  /** 站点公开设置（变更少、读取频繁） */
  publicSettings: (): string => `${KEY_PREFIX}:cache:settings:public`,
} as const;
