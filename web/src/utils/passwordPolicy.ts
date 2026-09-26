/**
 * 密码长度口径 —— 前端唯一的权威来源。
 *
 * ## 为什么要有这个文件
 *
 * 后端的规则是 **8-128 位**（`src/auth/identity.ts` 的 `changePassword` / 注册校验，
 * 报错 `密码长度须为 8-128 位`）。但前端历史上是「三个页面各写各的」：
 *
 * | 位置 | 原值 |
 * |---|---|
 * | `Register.tsx`（注册） | `min: 6` |
 * | `SetupWizard.tsx`（初始化向导） | `min: 6` |
 * | `UserProfile.tsx`（改密码） | `newPassword.length < 6` |
 * | `ResetPassword.tsx`（重置密码） | `8`（本地常量） |
 *
 * 后果：用户在注册页填 6-7 位密码，**前端放行、后端拒绝**（`VALIDATION_ERROR`
 * 「密码长度须为 8-128 位」），看起来像"注册按钮没反应"。而且重置密码页
 * 偏偏是对的，同一个站内两套口径，最容易被当成偶发 bug。
 *
 * 现在四个页面都从这里取常量 —— 改一处即全局一致。**改这个值必须同时确认后端**，
 * 见 `src/auth/identity.ts` 里的 `password.length < 8 || password.length > 128`。
 */

/** 与后端一致的最短密码长度 */
export const MIN_PASSWORD_LENGTH = 8;

/** 与后端一致的最长密码长度（bcrypt 只取前 72 字节，但后端上限是 128，保持口径一致） */
export const MAX_PASSWORD_LENGTH = 128;
