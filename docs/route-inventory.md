# API 与数据对象清单

本文是 plan3 的外部接口和领域对象索引，供重制时做兼容检查。

## 1. Yggdrasil 接口

| 方法 | 路径 | 作用 | 主要实现 |
|---|---|---|---|
| `GET` | `/api/yggdrasil` | Yggdrasil 元数据 | `src/app.ts` |
| `GET`/开发态 | `/` | 开发环境返回元数据；生产环境返回 SPA | `src/app.ts` |
| `POST` | `/authserver/authenticate` | 用户名/密码换 access token | `src/api/authserver/authenticate.ts` |
| `POST` | `/authserver/refresh` | 刷新 access token | 同上 |
| `POST` | `/authserver/validate` | 验证 token | 同上 |
| `POST` | `/authserver/invalidate` | 吊销单个 token | 同上 |
| `POST` | `/authserver/signout` | 用户名/密码登出全部 token | 同上 |
| `POST` | `/sessionserver/session/minecraft/join` | 保存客户端 join session | `src/api/sessionserver/join.ts` |
| `GET` | `/sessionserver/session/minecraft/hasJoined` | 服务端验证玩家加入 | 同上 |
| `GET` | `/sessionserver/session/minecraft/profile/:uuid` | 按 Profile UUID 返回 textures | 同上 |
| `POST` | `/api/profiles/minecraft` | 按名称批量查询 Profile | `src/api/sessionserver/profile.ts` |
| `PUT` | `/api/user/profile/:uuid/:textureType` | 上传 skin/cape | `src/api/textures/upload.ts` |
| `POST` | `/api/user/profile/:uuid/skin` | 旧/兼容皮肤应用路径 | 同上 |
| `POST` | `/api/user/profile/:uuid/cape` | 旧/兼容披风应用路径 | 同上 |
| `DELETE` | `/api/user/profile/:uuid/skin` | 移除角色皮肤 | 同上 |
| `DELETE` | `/api/user/profile/:uuid/cape` | 移除角色披风 | 同上 |

### Yggdrasil 重制约束

- Profile ID 对外需要兼容无连字符 UUID。
- `authenticate` 的 `availableProfiles`、`selectedProfile` 字段必须保持兼容。
- `join` 成功返回 204。
- `hasJoined` 未找到时返回 204。
- `profile/:uuid` 必须支持 `unsigned=true`。
- textures property 的 JSON 字段、Base64 编码和 RSA 签名行为要保持兼容。
- 纹理 URL 必须是 Minecraft 客户端可访问的公开 URL。

## 2. Web 认证与账号

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/auth/register` | 注册用户和初始角色 |
| `POST` | `/api/auth/login` | Web 登录 |
| `GET` | `/api/auth/me` | 当前用户 |
| `POST` | `/api/auth/send-verification` | 发送验证邮件 |
| `GET` | `/api/auth/verify-email` | 验证邮箱 |
| `POST` | `/api/auth/change-password` | 修改密码 |
| `POST` | `/api/auth/send-reset-email` | 发送重置邮件 |
| `POST` | `/api/auth/reset-password` | 重置密码 |
| `POST` | `/api/auth/delete-account` | 删除账号 |
| `GET` | `/api/auth/oauth/providers` | 查询可用 OAuth provider |
| `GET` | `/api/auth/oauth/:provider` | 发起 OAuth |
| `GET` | `/api/auth/oauth/:provider/callback` | OAuth 回调 |

## 3. Profile

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/me/profiles` | 当前用户角色列表 |
| `POST` | `/api/me/profiles` | 创建角色 |
| `GET` | `/api/me/profiles/check-name` | 检查角色名 |
| `PUT` | `/api/me/profiles/:uuid/name` | 改名 |
| `DELETE` | `/api/me/profiles/:uuid` | 删除角色 |

## 4. 素材与素材库

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/skins` | 当前用户皮肤列表 |
| `POST` | `/api/skins/upload` | Web 上传皮肤 |
| `POST` | `/api/skins/upload-cape` | Web 上传披风 |
| `POST` | `/api/skins/:skinId/activate/:uuid` | 将皮肤应用到角色 |
| `PUT` | `/api/skins/:skinId` | 修改皮肤元数据 |
| `DELETE` | `/api/skins/:skinId` | 删除皮肤 |
| `GET` | `/api/capes/mine` | 当前用户披风列表 |
| `PUT` | `/api/capes/:capeId` | 修改披风元数据 |
| `DELETE` | `/api/capes/:capeId` | 删除披风 |
| `GET` | `/api/library/skins` | 公开皮肤分页 |
| `GET` | `/api/library/skins/:id` | 公开皮肤详情 |
| `GET` | `/api/library/capes` | 公开披风分页 |
| `GET` | `/api/library/capes/:id` | 公开披风详情 |

## 5. 收藏

| 方法 | 路径 |
|---|---|
| `POST` | `/api/skins/:id/favorite` |
| `DELETE` | `/api/skins/:id/favorite` |
| `GET` | `/api/skins/favorites` |
| `GET` | `/api/skins/:id/favorite-count` |
| `GET` | `/api/skins/:id/is-favorited` |
| `POST` | `/api/capes/:id/favorite` |
| `DELETE` | `/api/capes/:id/favorite` |
| `GET` | `/api/capes/favorites` |
| `GET` | `/api/capes/:id/favorite-count` |
| `GET` | `/api/capes/:id/is-favorited` |

当前产品语义是发布者默认拥有一条收藏计数，普通用户不能收藏自己的素材；重制时应把这一规则明确写入领域服务和测试。

## 6. 安装、设置和安全能力

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/setup/status` | 安装状态 |
| `POST` | `/api/setup/test-db` | 测试数据库 |
| `POST` | `/api/setup/test-email` | 测试 SMTP |
| `POST` | `/api/setup/test-redis` | 测试 Redis |
| `POST` | `/api/setup/complete` | 完成安装 |
| `GET` | `/api/captcha/generate` | 生成算术验证码 |
| `POST` | `/api/captcha/verify` | 验证算术验证码 |
| `POST` | `/api/captcha/verify-turnstile` | 验证 Turnstile |
| `GET` | `/api/captcha/captcha-type` | 查询当前验证码类型 |
| `GET` | `/api/settings/public` | 公开站点设置 |
| `GET` | `/health` | 健康检查 |

## 7. 管理员 API

实现文件：`src/api/web/admin.ts`。

主要分组：

- `stats`、`stats/daily`
- 用户列表、启用/停用、改角色、封禁、邮箱验证和重新发送验证
- 待审核皮肤和披风
- 所有皮肤和披风的管理员列表、修改和删除
- SMTP 和邮件模板
- 站点设置和主题背景上传
- 黑名单查询、添加、删除、清理过期记录
- AI 生成标记和管理员警告

权限：

- `requireAuth`：需要有效 Bearer token
- `requireAdmin`：`level >= 1`
- `requireSuperAdmin`：`level >= 2`

## 8. 数据表索引

### 核心表

| 表 | 主要字段 | 关系 |
|---|---|---|
| `users` | id、user_uid、email、password_hash、role、level、状态 | 根用户实体 |
| `profiles` | id、name、user_id、skin_id、cape_id | Minecraft 角色 |
| `skins` | id、user_id、file_path、file_hash、权限、审核 | 皮肤素材 |
| `capes` | id、user_id、file_path、file_hash、权限、审核 | 披风素材 |
| `tokens` | access/client token、user_id、profile_id、过期时间 | 认证会话 |
| `sessions` | server_id、access_token、profile_id、过期时间 | join/hasJoined 短会话 |
| `system_config` | key/value | 安装和站点设置 |

### 扩展表

| 表 | 作用 |
|---|---|
| `skin_favorites` | 用户收藏皮肤 |
| `cape_favorites` | 用户收藏披风 |
| `blacklist` | 邮箱/IP 封禁 |
| `oauth_accounts` | 第三方账号绑定 |
| `skin_tags` | PostgreSQL 初始 schema 中存在的标签表，但当前 Web 业务没有完整闭环 |

## 9. 重制时的兼容检查顺序

1. 先用真实客户端验证元数据、authenticate、join、hasJoined、profile。
2. 再验证 Web 注册、登录、创建 Profile、上传和应用皮肤。
3. 再验证公开库、收藏、审核、S3。
4. 最后验证 OAuth、Turnstile、SMTP、管理员设置和 Docker。

不要先以页面能打开作为完成标准；对这个项目来说，Yggdrasil session 链路才是最重要的外部兼容面。
