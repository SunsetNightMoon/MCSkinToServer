/**
 * 缓存/限流的键命名空间。
 *
 * 单独放一个文件（而不是塞在 cache/index.ts 里）：仓储层只需要键名，
 * 不该因为要一个字符串常量就把 Redis 客户端拉进自己的 import 图。
 */

/** 统一前缀，避免与同库其它应用串键 */
export const KEY_PREFIX = 'mcsts';

/** 限流键 */
export const RateLimitKeys = {
  /** Yggdrasil authenticate / signout：按用户名（邮箱） */
  yggdrasilAccount: (account: string): string =>
    `${KEY_PREFIX}:rl:yggdrasil:${account.toLowerCase()}`,
  /**
   * Yggdrasil `POST /refresh`：**按来源地址**。
   *
   * 不能按用户名 —— 启动器会在 token 临近过期时自动定期刷新（HMCL 挂机时尤其频繁），
   * 按账号计数等于把正常后台行为判成攻击，症状是「挂机一阵后启动器突然掉线」。
   * 按 IP 计只压「同一出口地址的高频刷新」，且上限比登录宽松。
   */
  yggdrasilRefresh: (ip: string): string => `${KEY_PREFIX}:rl:yggrefresh:${ip}`,
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
  /** 0003：发起备用邮箱绑定：按待绑定的邮箱（同样是发信端点） */
  backupEmail: (email: string): string =>
    `${KEY_PREFIX}:rl:backup:${email.toLowerCase()}`,
  /**
   * 0003：发起邮箱变更：按**用户**而不是收件地址。
   * 一次请求要往两个地址各发一封信，按地址限流挡不住「一个账号反复发起、
   * 每次都换一个新地址」——按用户计才是真实的成本口径。
   */
  emailChange: (userId: string): string =>
    `${KEY_PREFIX}:rl:emailchange:${userId}`,
  /**
   * 0004：人机验证**出题**端点，按来源地址。
   *
   * 数学题本身没有难度，所以「批量预生成答案」只能靠限制出题速率来挡 ——
   * 这是整个验证码方案里唯一真正起作用的那道闸。
   */
  captchaGenerate: (ip: string): string => `${KEY_PREFIX}:rl:captcha:${ip}`,
} as const;

/** 缓存键 */
export const CacheKeys = {
  /** 站点公开设置（变更少、读取频繁） */
  publicSettings: (): string => `${KEY_PREFIX}:cache:settings:public`,
} as const;
