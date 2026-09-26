# MSCTS 重制架构蓝图

## 1. 目标

重制不是把 plan3 的文件重新排列，而是重新建立稳定的内部契约，同时保留用户和 Minecraft 客户端真正依赖的能力。

### 必须保留

- Yggdrasil 认证和 sessionserver 兼容
- RSA signed textures property
- 用户账号与 Minecraft Profile 分离
- 皮肤/披风上传、校验、应用、删除
- 公开素材库、权限和审核
- 管理员体系
- 邮箱验证、密码重置、OAuth、Turnstile 等可选能力
- 本地文件和 S3/MinIO 两种存储能力
- 多语言和 3D 预览

### 第一阶段不追求

- 微服务拆分
- 多个数据库运行时热切换
- 运行时修改 `.env`
- 兼容 plan3 的内部 SQL 细节
- 为历史 bug 保持行为兼容

建议采用一个模块化单体。协议、领域服务、存储和数据库边界清晰后，未来再决定是否拆服务。

## 2. 目标分层

```text
HTTP / Yggdrasil adapters
        |
Application services
        |
Domain modules
        |
Repositories / storage ports / external clients
        |
PostgreSQL (canonical) + local object storage or S3
```

### 2.1 HTTP 层

只负责：

- 解析输入
- 调用应用服务
- 转换错误
- 生成协议响应

HTTP 层不直接写 SQL，不直接删除文件，不自行判断资源所有权。

### 2.2 应用服务层

建议的服务：

- `RegisterUser`
- `LoginWebUser`
- `AuthenticateYggdrasil`
- `RefreshYggdrasilToken`
- `JoinMinecraftServer`
- `ResolveJoinedProfile`
- `GetTextureProfile`
- `IngestTexture`
- `AssignAssetToProfile`
- `PublishAsset`
- `ReviewAsset`
- `FavoriteAsset`
- `DeleteAccount`

一个业务动作由一个应用服务完成，必要时开启单个数据库事务。

### 2.3 领域模块

| 模块 | 责任 |
|---|---|
| Identity | User、密码、邮箱验证、封禁、角色权限 |
| Minecraft Profiles | Profile 名称、UUID、改名规则 |
| Yggdrasil | token、session、协议 DTO、textures 签名 |
| Assets | Skin/Cape、权限、审核、收藏、浏览/下载计数 |
| Blob Storage | 文件校验、hash、provider、公开 URL |
| Administration | 审核、管理员警告、系统设置 |
| Integrations | SMTP、OAuth、Turnstile、Redis |
| Setup | 首次初始化和配置验证，不负责运行时改 schema |

## 3. 数据模型建议

### 3.1 采用一个 canonical schema

建议以 PostgreSQL schema 为主，再为本地开发提供 SQLite 适配；不要再维护“迁移文件 + 安装向导 DDL + 测试 DDL”三套结构。

如果必须支持 SQLite：

- schema 由同一份结构定义生成
- 迁移执行器必须有版本表
- 每个数据库的差异只放在 adapter/migration driver
- CI 必须同时运行 SQLite 和 PostgreSQL

### 3.2 推荐核心表

```text
users
profiles
assets
blobs
profile_assets
tokens
login_sessions
minecraft_sessions
favorites
asset_reviews
oauth_accounts
email_verification_tokens
password_reset_tokens
blacklist_entries
system_settings
```

### 3.3 Blob 与 Asset 分离

推荐结构：

```text
blobs
  id
  sha256
  storage_key
  content_type
  byte_size
  width
  height
  created_at

assets
  id
  owner_user_id
  kind: skin | cape
  blob_id
  model_type
  name
  description
  license
  visibility
  download_policy
  review_status
  ai_generated
  admin_warning
  created_at

profile_assets
  profile_id
  asset_id
  slot: skin | cape
  assigned_at
```

这样做的好处：

- 相同文件只存一次
- 文件对象和用户拥有的素材记录分离
- 同一个 blob 可以被多个 Asset 引用
- 删除用户时可按引用计数/异步清理 blob
- S3 key 不再被当成 URL 或数据库业务 ID

### 3.4 权限字段

不要同时存三个互相推导的字段。建议：

```text
visibility: private | public
download_policy: owner_only | public
review_status: pending | approved | rejected
```

公开库查询规则：

```text
visibility = public
review_status = approved
```

下载规则：

```text
owner OR (visibility = public AND download_policy = public)
```

如果要保留 plan3 的 `public_no_download` 名称，可以在 API adapter 层映射到上述两个字段。

### 3.5 Token 统一

只保留一套 token 表结构：

```text
id
token_hash
token_type: web | yggdrasil
client_token
user_id
profile_id nullable
issued_at
expires_at
last_used_at
revoked_at
```

数据库不要保存明文 access token。外部协议仍返回随机 token，数据库只保存 hash，并提供按 hash 查询。

Yggdrasil 和 Web 可以共享 token repository，但不能共享不明确的权限语义。Web token 应有 scope 或 token type。

## 4. 存储设计

定义存储端口：

```text
put(objectKey, bytes, contentType) -> ObjectRef
delete(objectKey)
exists(objectKey)
publicUrl(objectKey) -> URL
```

数据库只保存 `objectKey` 或 `blob_id`，不保存带环境的完整 URL。

Yggdrasil textures 响应必须通过同一个 `AssetUrlResolver`：

```text
asset -> blob -> storage.publicUrl(objectKey)
```

本地和 S3 的输出格式、缓存头、Content-Type 都在 provider 层统一处理。

## 5. 配置与启动设计

### 5.1 启动时读取，运行时不改 `.env`

将配置解析为不可变对象：

```text
loadConfig()
validateConfig()
connectDatabase()
runMigrations()
createApp(config, dependencies)
listen()
```

安装向导只负责保存数据库中的 `system_settings` 或生成初始配置文件，完成后要求重启；不要在正在运行的进程中切换数据库驱动、存储 provider 或连接池。

### 5.2 单一启动命令

建议只保留：

```text
npm run build
npm run migrate
npm start
```

Docker 入口只调用编译后的同一套 migration runner，不再复制或覆盖脚本。

### 5.3 健康检查

分开提供：

- `/health/live`：进程存活
- `/health/ready`：数据库、必要存储可用
- `/health/dependencies`：Redis、SMTP 等可选依赖状态

Yggdrasil 元数据不要依赖根路径在开发/生产之间改变含义。

## 6. 协议适配策略

### 6.1 Yggdrasil adapter

将外部 DTO 与内部命令分开：

```text
AuthenticateRequest -> AuthenticateYggdrasilCommand
YggdrasilLoginResult -> AuthenticateResponse
```

外部错误必须集中映射：

| 内部错误 | Yggdrasil 响应 |
|---|---|
| 参数缺失 | 400 `IllegalArgumentException` |
| 凭据无效 | 403 `ForbiddenOperationException` |
| token 无效 | 403 `ForbiddenOperationException` |
| 找不到 Profile | 204 |
| 未找到 hasJoined session | 204 |
| 未预期服务错误 | 500 |

### 6.2 textures builder

只实现一份：

```text
buildTextureProperty(profileId, options)
```

options 至少包括：

- `unsigned`
- `includeSkin`
- `includeCape`
- `now`

签名数据的 JSON 序列化、Base64 编码和 RSA 算法必须有固定测试向量。

## 7. 认证与授权策略

### 7.1 认证上下文

统一 middleware 输出：

```text
RequestContext {
  userId
  tokenId
  tokenType
  profileId?
  roles
}
```

路由不再自己解析 `Authorization`。所有需要认证的接口都通过同一 middleware。

### 7.2 授权策略

将授权写成可测试的 policy：

```text
canViewAsset(actor, asset)
canDownloadAsset(actor, asset)
canAssignAsset(actor, asset, profile)
canReviewAsset(actor)
canManageUser(actor, target)
```

尤其要明确：

- 公开但不可下载的素材能否应用到自己的角色
- 收藏是否授予使用权
- 发布者默认收藏是否只是计数展示，还是实际关系
- 被拒绝/被删除的素材是否仍可出现在角色纹理中

## 8. 重制阶段

### P0：基础骨架和契约

目标：可以从零启动，并且数据库和协议契约稳定。

- 建立 TypeScript 项目边界和配置加载
- 选定 canonical schema
- 实现版本化 migration runner
- 实现 repository interface
- 实现统一错误类型和认证上下文
- 固定 Yggdrasil DTO 和 RSA 签名测试向量
- 添加 `/health/live`、`/health/ready`

验收：

- SQLite 和 PostgreSQL 从空库执行迁移成功
- 重复执行迁移无副作用
- migration 失败会阻止启动
- 没有运行时写 `.env`

### P1：Identity + Yggdrasil

- 用户注册/登录
- Profile 创建、查询、改名
- Yggdrasil authenticate/refresh/validate/invalidate/signout
- join/hasJoined
- `profile/:uuid`
- signed/unsigned textures

验收：

- 用真实 authlib-injector 或等价客户端完成登录和进服验证
- 令牌过期、撤销、clientToken 校验覆盖
- PostgreSQL 和 SQLite 都通过协议集成测试

### P2：Blob、Skin/Cape 和 Profile assignment

- `blobs`、`assets`、`profile_assets`
- PNG、尺寸、模型类型校验
- 本地 provider
- 上传、去重、应用、删除
- 公开 URL

验收：

- 相同文件不会重复保存 blob
- 不同用户的 Asset 所有权清晰
- 删除/替换不会留下不可追踪的对象
- textures 返回的 URL 在客户端可访问

### P3：公开库、收藏和审核

- 公开列表和详情
- visibility/download policy
- favorite
- review workflow
- 浏览/下载计数
- 管理员警告和 AI 标记

验收：

- 建立完整的 owner/favorite/public/admin 权限矩阵
- 被拒绝素材不出现在公开库和 Yggdrasil 纹理响应
- 公开不可下载与公开可下载行为可分别测试

### P4：Web 前端迁移

- 先迁移登录、注册、Profile、衣柜、上传
- 再迁移公开库和详情
- 最后迁移管理后台、主题和多语言
- 以生成的 API contracts 驱动前端类型

验收：

- 前端 TypeScript 无错误
- 不再混用无认证 fetch 和 axios 逻辑
- 401/403/429/表单错误有统一显示
- 移动端和桌面端完成关键流程回归

### P5：集成能力和发布

- Redis distributed rate limit/cache
- SMTP
- Turnstile
- OAuth
- S3/MinIO
- Docker 镜像、反向代理和备份

验收：

- 每个可选依赖关闭时核心功能仍能运行
- 开启依赖后有 integration test 或 smoke test
- Docker 与本地使用同一编译产物和迁移入口

## 9. plan3 数据迁移策略

不要直接把 plan3 的表原样搬进新 schema。建议分三步：

1. **只读盘点**
   - 导出用户、Profile、skin/cape 元数据
   - 记录真实列名、ID 类型、重复 hash、孤儿文件
   - 统计公开、审核、收藏和当前绑定关系
2. **导入 staging**
   - 先导入 users/profiles
   - 再按 hash 创建 blobs
   - 再创建 assets
   - 最后创建 profile assignments、favorites 和审核记录
3. **校验后切换**
   - 用户数量和 Profile 名称数量一致
   - 每个 asset 的 blob 存在
   - 每个公开资源的 URL 可访问
   - 所有激活的 skin/cape 在新库中存在
   - 生成迁移报告和失败清单

迁移脚本必须是可重复、可中断恢复的离线工具，不应该复用 Web 安装向导。

## 10. 最小测试矩阵

### 协议

- authenticate 成功/失败/未验证邮箱/封禁
- refresh 带和不带 selectedProfile
- validate clientToken
- invalidate/signout
- join 后 hasJoined 成功
- session 过期
- signed/unsigned profile
- 无 skin/cape 的 Profile

### 权限

- owner
- 普通登录用户
- 收藏用户
- 未登录访客
- 管理员
- 超级管理员

### 数据库

- SQLite fresh install
- PostgreSQL fresh install
- 重复迁移
- 迁移失败回滚
- 并发创建 token/profile

### 存储

- 本地上传/读取/删除
- S3 上传/读取 URL/删除
- 重复 blob
- DB 写入失败后的对象清理

### 发布

- Docker build
- Docker start
- readiness
- SPA route
- Yggdrasil endpoint
- reverse proxy 下的 public URL

## 11. 第一批可直接执行的任务

1. 新建 canonical schema 草案，先解决 `tokens`、`sessions`、`assets/blobs`。
2. 写 PostgreSQL/SQLite 双数据库的迁移 smoke test。
3. 实现统一 `AuthContext` 和 `AssetUrlResolver`。
4. 实现单一 `TextureProfileBuilder`，替换两个重复实现。
5. 实现 `IngestTextureService`，让两条上传接口共用。
6. 给 plan3 写一个只读数据盘点脚本，输出字段、记录数、重复 hash 和孤儿文件。
7. 创建 Yggdrasil compatibility test suite，先不依赖前端。
8. 确定生产镜像只使用一个 Dockerfile 和一个启动入口。

## 12. 完成标准

重制达到以下条件，才算超过 plan3 的可用性：

- 空数据库可重复、可审计地初始化
- PostgreSQL 和 SQLite 的行为差异被 adapter 隔离
- Yggdrasil 关键链路有真实集成测试
- Web 和 Yggdrasil 共享领域服务，不再复制上传和纹理逻辑
- 文件 URL 在本地和 S3 模式下都由同一接口生成
- 权限规则可通过 policy 测试解释
- 前端类型由接口契约驱动
- Docker、本地开发和测试使用同一套核心启动逻辑
