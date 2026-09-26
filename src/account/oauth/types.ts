/**
 * 第三方登录预留端口（P5 批4-F）。
 *
 * ## 本项目做什么、不做什么
 *
 * 本项目**不直接提供**任何真实第三方登录（GitHub / Microsoft 正版 / Bilibili / QQ …）。
 * 这里只提供**接线口**：实现方（自部署者 / 二次开发者）按下面的 `OAuthProvider`
 * 契约实现自己的 provider，在进程启动时 `registerOAuthProvider()` 注册，
 * 前端登录页与注册页的「第三方登录」小格子就会自动出现并指向对应入口。
 *
 * 没有注册任何 provider 时，`GET /api/auth/oauth/providers` 返回的开关全为 false，
 * 前端整块小格子不渲染 —— 这是默认状态，也是纯 MCSTS 部署的常态。
 *
 * ## 明确不提供的能力
 *
 * 1. **任何 provider 的凭据、密钥或现成实现**（接入方自己申请、自己保管）。
 * 2. **电话 / 短信验证**。这条是硬约束：本项目的类型定义里**不存在手机号字段**，
 *    也不存在任何短信验证码端点。隐私责任无法转嫁，谁都不愿意替别人的手机号负责。
 *    `OAuthAccount` 刻意只暴露 `email` / `emailVerified`，不暴露 `phone`。
 * 3. **回调落地**。把 provider 账号映射到本地账号需要一张身份绑定表
 *    （一个本地账号 ↔ 多个 provider 身份），属于接入方的账号模型决策，
 *    不在本项目的账号模型之内。接入步骤见 `docs/oauth-provider-guide.md`。
 */

/** 生成授权地址的输入（由服务端在跳转前准备） */
export interface OAuthAuthorizeInput {
  /**
   * 回跳地址，实现方必须原样写进 `redirect_uri` 参数，
   * 且要与 `exchangeCode` 时使用的值一致，否则 provider 会拒绝换码。
   */
  redirectUri: string;
  /**
   * 防 CSRF 的一次性随机串。实现方必须把它写进 `state` 参数，
   * 并在回调时校验「回来的 state == 当初发出的 state」。
   */
  state: string;
}

/** 用授权码换用户信息的输入 */
export interface OAuthExchangeInput {
  /** 回调带回来的授权码 */
  code: string;
  /** 必须与发起授权时同一个值 */
  redirectUri: string;
  /** 回调带回来的 state，用于与发起时比对 */
  state: string;
}

/**
 * 从 provider 取回的身份信息。
 *
 * 注意这里**没有 `phone` 字段**，这是刻意的（见文件头禁止条款 2）。
 */
export interface OAuthAccount {
  /** provider 标识，应与 `OAuthProvider.id` 一致 */
  providerId: string;
  /**
   * provider 侧的**稳定**用户 ID（GitHub 是数字 id、Microsoft 是 `oid` 等）。
   * 不要用用户名或邮箱当主键 —— 它们在 provider 侧可以改。
   */
  subject: string;
  /** provider 返回的邮箱；provider 不保证提供，故可为 null */
  email: string | null;
  /**
   * provider 是否声明该邮箱已验证。
   * 接入方**只有在为 true 时**才应把邮箱当作可信地址写入本地账号，
   * 否则等于把「注册任意邮箱」的能力交给了 provider。
   */
  emailVerified: boolean;
  /** 展示名（昵称）；可能为空 */
  displayName: string | null;
  /** 头像地址；可能为空 */
  avatarUrl: string | null;
}

/** 第三方登录 provider 契约：实现这个接口即可接入 */
export interface OAuthProvider {
  /**
   * 稳定标识，用作路由片段（`/api/auth/oauth/<id>`）与前端开关的键。
   * 建议用小写字母与连字符，例如 `github` / `microsoft` / `bilibili` / `qq`。
   */
  readonly id: string;
  /** 展示名。注意：本项目前端用的是自己的 i18n 文案，此字段仅用于通用端点与日志 */
  readonly displayName: string;
  /**
   * 当前是否启用。为 false 时不出现在任何广告响应里。
   * 典型用法：接入了 provider 但凭据未配置（缺 client id / secret）时置 false，
   * 避免前端显示一个点了会报错的按钮。
   */
  readonly enabled: boolean;
  /** 生成授权页跳转地址（可含网络请求，故允许返回 Promise） */
  authorizeUrl(input: OAuthAuthorizeInput): string | Promise<string>;
  /** 用回调拿到的 code 换身份信息 */
  exchangeCode(input: OAuthExchangeInput): Promise<OAuthAccount>;
}
