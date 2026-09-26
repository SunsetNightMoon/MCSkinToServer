# minecraft-skin-server-plan3 代码分析

## 1. 分析范围与状态

本文基于 `G:\Skin2.catnight.top\minecraft-skin-server-plan3` 在 2026-09-20 的工作区状态，重点检查：

- 后端启动生命周期和 Express 中间件顺序
- Yggdrasil API 与 Web API 的边界
- 用户、角色、材质、令牌和会话的数据关系
- SQLite/PostgreSQL schema 与迁移路径
- 本地文件、S3 和主题资源的存储逻辑
- React 前端路由、状态和 API 调用方式
- 测试、构建和 Docker 部署结果

本次工作是代码分析，不对 plan3 源码进行修复。

## 2. 系统定位

plan3 是一个“Web 皮肤站 + Yggdrasil 认证服务器 + 纹理存储服务”的单体应用。

```text
Minecraft 客户端 / authlib-injector
        |
        +-- /authserver/*                 Yggdrasil 认证
        +-- /sessionserver/*              加入服务器、hasJoined、纹理 Profile
        +-- /api/profiles/minecraft        按名称批量查询 Profile
        +-- /api/user/profile/*            Yggdrasil 纹理上传和应用
        |
        v
Express app
  CORS -> Helmet -> body parser -> cookie -> static/S3 -> setup guard
        |
        +-- Web API /api/auth, /api/me/profiles
        +-- 素材 /api/skins, /api/capes, /api/library
        +-- 收藏 /api/*/favorite
        +-- 管理 /api/admin
        +-- 安装 /api/setup
        |
        +-- SQLite 或 PostgreSQL
        +-- 可选 Redis
        +-- 本地 uploads 或 S3/MinIO
        +-- RSA private/public key
```

技术栈：

| 层 | 当前实现 |
|---|---|
| 后端 | Node.js、Express、TypeScript |
| 前端 | React 18、Vite、TypeScript、Ant Design、Three.js/skinview3d |
| 数据库 | SQLite、PostgreSQL，使用自定义 `DB` 适配层 |
| 缓存 | Redis，可关闭；部分限流和验证码仍使用进程内 Map |
| 图片处理 | `sharp` |
| 认证 | Yggdrasil opaque token；Web 端复用数据库 token；没有实际 JWT 流程 |
| 外部能力 | SMTP、Cloudflare Turnstile、GitHub/Microsoft OAuth、S3 |

## 3. 启动生命周期

### 3.1 服务入口

`src/server.ts:15-61` 的启动顺序是：

1. 加载 `.env`
2. 对 SQLite 数据库做迁移前备份，并清理旧备份
3. 调用 `runMigrations`
4. 尝试连接 Redis，Redis 失败只记录错误
5. `app.listen`
6. 启动后异步执行主题图片迁移

这意味着数据库迁移是启动关键路径，但 Redis 不是关键路径。RSA 密钥并不在 `server.ts` 中生成，而由启动脚本或人工命令生成。

### 3.2 Express 初始化顺序

`src/app.ts` 的主要顺序：

1. CORS：生产环境使用 `BASE_URL`，开发环境使用 `origin: true`
2. Helmet/CSP/HSTS
3. JSON 和 URL-encoded body parser，限制为 10 MB
4. cookie parser
5. `/uploads`：本地静态目录或 S3 代理
6. 开发环境请求日志
7. `/health`
8. 生产环境静态前端目录
9. 安装守卫
10. Swagger
11. Yggdrasil 路由
12. Web 路由
13. 元数据接口和 SPA fallback
14. 404 与错误处理

安装守卫位于 `src/app.ts:197-224`。未完成安装时，只有 `/api/setup*` 和 `/health` 被放行；API 返回 403，页面请求重定向到 `/setup`。

### 3.3 当前运行时的关键假设

- `process.env.DB_TYPE` 可能被安装向导修改，数据库模块会在查询时读取它。
- 部分模块在 import 时捕获配置，例如 `src/api/textures/upload.ts:29` 的 `const useS3` 和 `src/app.ts:81` 的 `const useS3`。安装向导动态切换配置后，这些值不会自动刷新，通常必须重启服务。
- `SetupService.completeSetup` 会写回根目录 `.env`，并在运行时修改 `process.env`。这使“安装向导”和“进程启动配置”耦合在一起。

## 4. 后端模块地图

### 4.1 路由层

| 目录 | 责任 |
|---|---|
| `src/api/authserver` | Yggdrasil authenticate、refresh、validate、invalidate、signout |
| `src/api/sessionserver` | join、hasJoined、按 UUID 查询 Profile |
| `src/api/textures` | 纹理上传、应用、删除 |
| `src/api/web/auth.ts` | 注册、登录、邮箱验证、改密、密码重置、注销 |
| `src/api/web/profiles.ts` | Web 角色列表、创建、改名、删除 |
| `src/api/web/skins.ts` | 用户皮肤/披风上传、列表、修改、删除、激活 |
| `src/api/web/capes.ts` | 用户披风管理 |
| `src/api/web/library.ts` | 公开皮肤/披风列表和详情 |
| `src/api/web/favorites.ts` | 收藏和收藏列表 |
| `src/api/web/admin.ts` | 用户、素材审核、站点设置、邮件、黑名单、主题资源 |
| `src/api/web/setup.ts` | 安装状态、数据库/邮件/Redis 测试、完成安装 |
| `src/api/web/captcha.ts` | 本地算术验证码和 Turnstile |
| `src/api/web/oauth.ts` | OAuth 登录 |

路由层没有统一的认证中间件覆盖所有 Web API。部分文件直接读取 `Authorization`，部分后台路由使用 `requireAuth`，造成认证和错误状态码不一致。

### 4.2 Service 层

| Service | 现有行为 |
|---|---|
| `AuthService` | Yggdrasil 登录和令牌生命周期；额外维护一个进程内用户名限流 Map |
| `SessionService` | 保存 join 会话、处理 hasJoined、构造并签名 textures |
| `StorageService` | 本地/S3 provider 抽象 |
| `SetupService` | 安装、写 `.env`、建表、创建超级管理员、补列 |
| `OAuthService` | GitHub/Microsoft code exchange、用户资料拉取和账号绑定 |
| `EmailService` | 验证邮件、密码重置、SMTP 测试 |
| `CaptchaService` | 进程内算术题验证码；可转发到 Turnstile |
| `TurnstileService` | 调 Cloudflare siteverify |

### 4.3 Model 层

Model 是“SQL + DTO + 一部分业务规则”的混合层。`UserModel`、`ProfileModel`、`SkinModel`、`CapeModel`、`TokenModel`、`FavoriteModel`、`BlacklistModel` 和 `OAuthAccountModel` 直接调用 `DB.query`。

这样做的优点是实现快、路径短；缺点是：

- 查询语句在多个路由和模型间重复
- 授权判断分散在路由、Model 和 Service
- model 返回的是数据库原始行，跨 SQLite/PostgreSQL 的布尔值、时间和计数类型没有统一映射
- 很多函数依赖隐含字段，例如 `token` 和 `access_token` 两套令牌列

## 5. 核心业务流

### 5.1 Web 注册

`src/api/web/auth.ts:68` 开始：

1. 检查 `ALLOW_REGISTRATION`
2. 校验邮箱、密码和角色名
3. 检查角色名唯一性
4. 根据配置执行 Turnstile 或进程内算术验证码
5. 创建用户，密码由 bcrypt 哈希
6. 创建 Profile
7. 根据邮箱验证配置决定是否发送验证邮件
8. 创建 access token 并返回

注册流程在路由中完成了较多业务逻辑，用户创建和 Profile 创建没有明显的事务边界。重制时应把注册做成一个应用服务，用单个数据库事务完成用户、初始角色和令牌创建。

### 5.2 Yggdrasil authenticate

`src/api/authserver/authenticate.ts:41` 调 `AuthService.authenticate`。服务层：

1. 按 username/email 查找用户
2. 检查黑名单、活动状态、邮箱验证和密码
3. 创建 access token
4. 查询用户的所有 Profile
5. 如果只有一个 Profile，自动绑定到新令牌
6. 按 `requestUser` 返回用户信息

当前实际令牌是数据库中的随机 opaque token。虽然依赖和配置里存在 `jsonwebtoken`、`JWT_SECRET`，代码中没有实际 JWT 签发和验证流程。

### 5.3 Minecraft join / hasJoined

`src/services/SessionService.ts`：

- `joinServer` 验证 access token 和 Profile 所属关系，然后写入约 30 秒的 server session。
- `hasJoined` 按 `server_id` 取 session，核对角色名，构造 textures property，并使用 RSA 私钥签名。
- `GET /sessionserver/session/minecraft/profile/:uuid` 重复实现了几乎相同的 textures 构造逻辑，unsigned 和 signed 只是是否附带 signature 的区别。

重制时应抽出一个 `TextureProfileBuilder`，保证 `hasJoined`、按 UUID 查询和元数据响应使用同一套：

```text
Profile -> active skin/cape -> visibility policy -> public asset URL
        -> TexturesProperty -> base64 -> optional RSA signature
```

### 5.4 纹理上传

`src/api/textures/upload.ts:125` 和 `src/api/web/skins.ts:138/214` 存在两条上传体系：

- Yggdrasil 风格 `PUT /api/user/profile/:uuid/:textureType`
- Web 端 `POST /api/skins/upload`、`POST /api/skins/upload-cape`

两者都做：

1. Bearer token 验证
2. 邮箱验证检查
3. Profile 所属检查或用户身份检查
4. multer 接收 PNG
5. `sharp` 校验尺寸和格式
6. 重新编码 PNG
7. SHA-256 去重
8. 写入本地/S3
9. 写入数据库并绑定 Profile

但两条路径对名称、协议、权限、错误状态码和存储路径的处理不完全一致。重制时应只保留一个 `TextureIngestService`，Web/Yggdrasil 只是不同的输入适配器。

### 5.5 公开素材库

`src/api/web/library.ts` 调 `SkinModel.findAll` 和 `CapeModel.findPublic`。公开条件通常是：

- `is_public = true`
- `approval_status = 'approved'`

权限被同时表达为：

- `permission_level`
- `is_public`
- `is_downloadable`

这是重复状态。当前 Model 在部分更新中会同步三者，但仍有绕过同步的 SQL 路径。重制应以一个枚举字段作为事实来源，通过查询策略推导“可见”和“可下载”。

## 6. 数据模型与关系

### 6.1 逻辑实体

```text
User 1 ---- N Profile
User 1 ---- N Skin
User 1 ---- N Cape
User 1 ---- N Token
Profile N -- 0..1 active Skin
Profile N -- 0..1 active Cape
User N ---- N Skin  (skin_favorites)
User N ---- N Cape  (cape_favorites)
User 1 ---- N OAuthAccount
Token 1 --- N Session
User 1 ---- N Blacklist audit references
```

### 6.2 User

关键字段：

- `id`：应用内部用户 ID，当前代码按字符串 UUID 使用
- `user_uid`：面向站点显示的递增 UID
- `email`、`password_hash`
- `role`、`level`
- `is_active`、`email_verified`
- 邮箱验证、登录时间、封禁字段

角色权限是数字级别：

| level | 角色 |
|---:|---|
| 0 | 普通用户 |
| 1 | 管理员 |
| 2 | 超级管理员 |

同时存在 `role` 字符串和 `level` 数字。两套字段可能不一致，重制时应选择一种主权限模型，另一种只作为兼容映射或删除。

### 6.3 Profile

Profile 是 Minecraft 角色，不是用户账号。它有独立 UUID、全局唯一名称、所属用户和当前皮肤/披风引用。

当前实现支持：

- 生成随机 UUID
- 按名称生成离线 UUID
- 改名冷却
- 多 Profile
- Yggdrasil 批量按名称查询

Profile ID 在 Yggdrasil 响应中通常需要无连字符 UUID；内部数据库同时接受带连字符和无连字符相关逻辑，重制时应在边界层统一格式。

### 6.4 Skin / Cape

两者都是“素材记录 + 文件对象”的形式，主要字段：

- `id`
- `user_id`
- `file_path`
- `file_hash`
- `file_size`、`width`、`height`
- `name`、`description`
- `license_type`
- `permission_level`
- `approval_status`
- 审核人、审核时间、拒绝原因
- `download_count`、`view_count`
- AI 标记和管理员警告

皮肤额外有 `model_type`。上传时通过袖子像素检测推断 slim/default，但请求也可以提供 `model`，两者的优先级没有形成稳定的领域规则。

### 6.5 Token / Session

Token 用于两套场景：

- Yggdrasil access token
- Web 前端 Bearer token

Session 用于 Minecraft `join` 与 `hasJoined` 的短时关联。令牌生命周期和 session 生命周期目前由 Model/Service 手工管理，没有统一的 token type、scope、issued-at 访问审计或并发撤销策略。

## 7. 数据库与迁移分析

### 7.1 四个 schema 来源

当前至少有四套会影响数据库形状的来源：

1. `database/migrations/001-init-sqlite.sql`
2. `database/migrations/001-init-postgres.sql` 与后续迁移
3. `src/services/SetupService.ts:265-442` 的内联建表
4. `tests/helpers/testDb.ts` 和集成测试里的测试 DDL

此外还有 `src/scripts/migrate_to_string_ids.ts` 这类一次性重建脚本。

这导致“同一个应用、不同安装路径、不同数据库类型”可能得到不同表结构。

### 7.2 SQLite 与 PostgreSQL 的主要不一致

已确认的不一致包括：

| 项 | SQLite/Setup 路径 | PostgreSQL/迁移路径 |
|---|---|---|
| 用户 ID | 代码按文本 UUID | `UUID` |
| 布尔字段 | `INTEGER 0/1` 或混用 | `BOOLEAN` |
| Skin/Cape ID | 历史迁移曾为整数，后续迁移和 Model 按字符串 | `VARCHAR(50)` |
| Token 主键 | SQLite 同时有 `token` 和 `access_token` | 001 初始 schema 只有 `access_token` |
| 时间表达式 | SQLite 语句中出现 `datetime('now', ...)` | PostgreSQL 不支持该函数 |
| 安装向导 | SQLite 内联建表；PostgreSQL 只执行 001、007 | 启动迁移会执行另一套文件列表 |
| OAuth/AI 字段 | 依赖 012/013 | SetupService PostgreSQL 路径没有执行 012/013 |

### 7.3 PostgreSQL 令牌结构是阻塞问题

`database/migrations/001-init-postgres.sql:133-141` 的 `tokens` 表没有 `token` 列，只有 `access_token`。

但是：

- `src/models/Token.ts:35-38` 插入 `token, access_token`
- `src/services/SessionService.ts:57-59` 用 `t.token` 连接
- 通用 `002-add-token-columns.sql` 只尝试添加 `access_token`、`client_token`、`last_used_at`，没有补 `token`

因此 PostgreSQL 的认证和 session 流程不能依赖当前 schema 正常工作。这不是测试覆盖不足，而是字段契约直接冲突。

### 7.4 Session 时间函数不是跨库 SQL

`src/services/SessionService.ts:31-38` 使用：

```sql
datetime('now', '+30 seconds')
```

这是 SQLite 风格表达式。PostgreSQL 分支应改用参数化的 UTC 时间或数据库无关的应用层时间值。重制时不应在业务 SQL 中混用 SQLite 专用函数。

### 7.5 迁移执行器的问题

`src/utils/migrate.ts` 当前行为：

- 按文件名数字排序
- 通过 `sql.split(';')` 切分 SQL
- SQLite 对很多错误进行忽略
- PostgreSQL 逐语句执行，错误只打印，不一定向上抛出
- 没有迁移版本表或 checksum
- 没有统一事务边界
- 对表重建迁移使用字符串判断和特殊逻辑

`src/scripts/migrate.js` 还是一份只执行 001 的旧入口；它与 `src/utils/migrate.ts` 的多迁移实现并存。Docker `start.sh` 调用 `dist/scripts/migrate.js`，因此发布镜像实际使用哪个迁移行为取决于构建时复制和覆盖的文件。

### 7.6 安装向导建表路径

`SetupService.createTables` 的 PostgreSQL 分支只读取：

- `001-init-postgres.sql`
- `007-add-favorites-table-postgres.sql`

它不会自动执行 012 的 AI 警告字段和 013 的 OAuth 表。即使启动迁移先执行过一遍，安装向导的“清理并重建”也可能重新生成一个缺字段的 schema。

## 8. 存储与文件 URL

### 8.1 本地存储

本地文件默认放在 `UPLOAD_DIR` 下的 `skins`、`capes` 子目录，由 Express `/uploads` 静态中间件提供。

代码中同时出现以下路径形态：

- `./uploads/skins/file.png`
- `/uploads/skins/file.png`
- S3 object key，例如 `skins/file.png`
- S3 public URL 或签名 URL

不同接口会自行做 `replace(/^\.\//, '/')`，没有统一的 `AssetUrlService`。

### 8.2 S3 存储

`StorageService` 提供上传、删除、存在检查和 URL 获取，但 Yggdrasil session 响应在 `src/services/SessionService.ts` 和 `src/api/sessionserver/join.ts` 中直接根据 `file_path` 拼接 `BASE_URL`，没有统一调用 `StorageService.getFileUrl`。

因此 S3 模式下可能把 object key 当成本地 URL 返回。重制时数据库只存 object key，所有对外 URL 都通过存储 provider 生成。

### 8.3 去重语义

Skin/Cape 使用 SHA-256 去重，但当前去重粒度是全局文件哈希：

- 找到已有记录后，可能直接把已有素材绑定到另一个用户的 Profile
- 资源所有权仍指向原用户
- 公开、收藏、可下载和管理权限的语义变得不清晰

重制时应区分：

```text
Blob（不可变文件对象，按 hash 唯一）
Asset（用户拥有的素材元数据）
ProfileAssignment（角色当前使用哪个 Asset）
```

这样既能复用文件，又不会把文件所有权和素材使用权混在一起。

## 9. 前端结构

### 9.1 路由

`frontend/src/App.tsx` 提供：

- `/setup`
- `/login`
- `/register`
- `/oauth-success`
- `/`
- `/library`
- `/skin/:id`
- `/cape/:id`
- `/upload`
- `/profile`
- `/wardrobe`
- `/my-skins`
- `/my-capes`
- `/admin`

前端启动时先请求 `/api/setup/status`，再根据状态跳转安装向导或首页。认证状态保存在 Zustand store 中，登录失败和 401/403 通过 `frontend/src/utils/api.ts` 的 axios interceptor 处理；但大量页面仍直接使用 `fetch`，因此错误处理并不统一。

### 9.2 前端状态

主要 store：

- `authStore`：当前用户、token、登录状态、当前皮肤 URL
- `siteStore`：主题、站点设置、背景、版权
- `i18nStore`：语言持久化

前端使用 i18next 和多语言 JSON，管理后台有独立的管理功能和翻译键。

### 9.3 前端确认的类型错误

`frontend/src/pages/SkinDetail/SkinDetail.tsx:215-218` 把 `skin.cape_file_path` 传给 3D 预览组件，但 `frontend/src/types/index.ts:20-47` 的 `Skin` 类型没有该字段。

`npx tsc --noEmit -p frontend/tsconfig.json` 当前失败：

```text
src/pages/SkinDetail/SkinDetail.tsx(217,27): error TS2339:
Property 'cape_file_path' does not exist on type 'Skin'.
```

这说明前端接口响应、领域类型和页面组件没有统一契约。重制时应由 OpenAPI/JSON schema 或共享 TypeScript contracts 生成 API 类型，不再手工复制接口字段。

## 10. 安全与可靠性观察

### 正面能力

- bcrypt 密码哈希
- Helmet、CSP、HSTS
- multer 限制上传体积
- sharp 检查 PNG 和尺寸
- RSA 签名 textures property
- 登录/注册限流
- Turnstile 可选接入
- 管理员等级和超级管理员分离
- SQLite 启动前备份机制

### 需要重制时处理的问题

1. 限流和算术验证码的 Map 在单进程内存中，重启即丢失，多实例不共享。
2. `AuthService.ts` 和 `CaptchaService.ts` 在模块加载时创建 `setInterval`，Jest 报告 5 个 open handles，测试只能依靠 `--forceExit`。
3. Web 路由重复读取 Bearer token，错误码在 401/403 之间不一致。
4. `is_public`、`is_downloadable`、`permission_level` 三个字段有重复状态。
5. 用户 `role` 和 `level` 有重复权限来源。
6. setup 过程会写 `.env` 和重建表，缺少明确的管理员确认、事务和回滚模型。
7. CORS 生产配置直接使用 `BASE_URL`，应在配置解析阶段转换为允许的 origin 列表。
8. `express.json` 为 10 MB，而上传接口另有 2 MB 限制，body/file 预算没有统一配置对象。
9. OAuth callback 将 token 通过 query string 放到 `/oauth-success?token=...`，浏览器历史、代理和日志可能记录 access token；重制时应使用一次性 code + server-side exchange 或 httpOnly cookie。
10. 管理员删除用户和资源时，本地文件/S3 对象删除与数据库删除不是同一个事务，需要补偿任务或 orphan cleanup。

## 11. Docker 与部署分析

### 11.1 根目录多阶段 Dockerfile

根目录 `Dockerfile`：

- 前端构建产物复制到 `/app/public`
- Express 运行时却在 `src/app.ts:183` 计算 `../frontend/dist`
- 编译后的 `dist/server.js` 对应的路径是 `/app/frontend/dist`

这两个路径不一致，生产镜像中 SPA 静态文件可能无法被 Express 找到。

另外，根目录 `start.sh` 调用 `node dist/scripts/migrate.js`，而项目同时存在编译后的 `src/scripts/migrate.ts` 和旧版 `src/scripts/migrate.js`。构建阶段复制脚本可能覆盖编译产物，导致 Docker 与本地的迁移行为不同。

### 11.2 deploy 目录的第二套方案

`deploy/Dockerfile`、`deploy/docker-compose.yml`、根目录 Dockerfile 和根目录 `docker-compose.yml` 并行存在，端口、容器名称、Redis 密码、构建步骤、前端处理方式和迁移入口不完全相同。

重制时应只保留一个生产构建路径，并用 CI 构建出可运行镜像后做 smoke test：

```text
build image -> start database -> run migrations -> start app
-> GET /health -> GET frontend route -> Yggdrasil metadata
```

## 12. 测试与构建验证

### 12.1 后端类型检查

`npx tsc --noEmit` 通过，说明当前后端 TypeScript 在不写出 `dist` 的情况下可以完成类型检查。

### 12.2 后端测试

`npm test -- --runInBand` 通过：

- 8 个 test suites
- 40 个 tests

覆盖重点是：

- Web 注册、登录、`/me`
- 皮肤列表接口
- 数据库适配层
- OAuth、Storage、Captcha、Turnstile、图片工具

但 Jest 同时报告 5 个 open handles，来源是 `AuthService` 和 `CaptchaService` 的模块级定时器。

缺少的关键测试：

- PostgreSQL 真实数据库集成
- 全部迁移从零执行和重复执行
- Docker 生产镜像启动
- Yggdrasil join/hasJoined/profile 完整链路
- S3 URL 和删除链路
- OAuth callback 的 token 安全
- 角色/素材/收藏/审核的权限矩阵

### 12.3 后端直接 build

`npm run build` 在当前环境写入既有 `dist` 文件时收到多个 `EPERM`，因此不能把这次 build 结果当作源代码编译失败。无写出模式的 `npx tsc --noEmit` 已通过。

### 12.4 前端 build

`npm run build` 受到当前环境的 esbuild `spawn EPERM` 影响；独立的前端 TypeScript 检查已确认 `SkinDetail.tsx` 的 `cape_file_path` 类型错误，因此前端当前不能视为绿色。

## 13. 风险登记

| 优先级 | 风险 | 证据 | 对重制的要求 |
|---|---|---|---|
| P0 | PostgreSQL token schema 与 Model 不匹配 | `001-init-postgres.sql:133-141`、`Token.ts:35-38` | 重新定义唯一 token schema，并增加 PostgreSQL 集成测试 |
| P0 | Session 使用 SQLite 专用 `datetime` | `SessionService.ts:31-38` | 使用应用层 UTC 时间或数据库无关 SQL |
| P0 | schema 来源分裂 | `SetupService.ts:265-442`、`utils/migrate.ts`、多份 migrations | 只保留一个 schema/migration source |
| P0 | Docker 前端路径不一致 | `Dockerfile`、`app.ts:181-195` | 统一 `/app/public` 或 `/app/frontend/dist`，并做镜像 smoke test |
| P1 | setup PostgreSQL 漏执行 012/013 | `SetupService.ts:268-290` | 安装和启动共用同一迁移器 |
| P1 | 旧迁移入口与新迁移入口并存 | `src/scripts/migrate.js`、`src/utils/migrate.ts` | 删除旧入口，使用版本化迁移 |
| P1 | Web/Yggdrasil 上传逻辑重复 | `textures/upload.ts`、`web/skins.ts` | 合并为一个素材导入服务 |
| P1 | S3 key 被直接拼成 BASE_URL | `SessionService.ts`、`sessionserver/join.ts` | 统一 Asset URL provider |
| P1 | 全局 hash 去重混淆文件和素材所有权 | `SkinModel.findByHash`、`upload.ts` | 拆分 Blob、Asset、Assignment |
| P1 | 前端类型漂移 | `SkinDetail.tsx:217` | 共享契约或代码生成 |
| P2 | 内存限流/验证码无法横向扩展 | `AuthService.ts`、`CaptchaService.ts` | Redis 或可替换的 distributed store |
| P2 | OAuth token 放在 URL query | `api/web/oauth.ts:50-54` | 一次性 code 或 httpOnly cookie |
| P2 | 多套部署配置 | 根 Dockerfile、`deploy/Dockerfile`、两套 compose | 统一发布入口 |
| P2 | 模块级定时器造成测试句柄 | `AuthService.ts`、`CaptchaService.ts` | 生命周期由 app/server 管理或使用 TTL store |

## 14. 应保留、重写和删除的内容

### 建议保留

- Yggdrasil 外部端点和返回格式
- RSA signed textures property
- User 与 Minecraft Profile 分离
- PNG/尺寸验证和 `sharp` 处理
- 公开/私有/可下载的产品需求
- 审核、收藏、黑名单、邮箱验证、OAuth 和 Turnstile 的产品能力
- 3D 预览、多语言和管理后台的用户体验方向

### 建议重写

- 数据库访问层和 schema
- Token/Session 领域模型
- Web 认证中间件
- Skin/Cape 上传和存储流程
- textures property 构建器
- 文件 URL 生成
- setup/迁移/启动流程
- API contracts 和前端 API client

### 建议删除或隔离

- 运行时写 `.env` 的配置模式
- `JWT_SECRET` 与实际不使用的 JWT 依赖，除非重制明确采用 JWT
- `src/scripts/migrate.js` 旧入口
- 两套并行 Docker 发布方案
- 直接面向数据库字段的前端类型复制
- `is_public`/`is_downloadable` 与 `permission_level` 的重复事实字段

## 15. 分析结论

plan3 的产品能力和协议边界值得继承，但内部实现不适合继续叠加修补。重制应该先建立一个“协议适配器 + 稳定领域服务 + 单一 schema + 可替换存储”的模块化单体，再把现有前端页面逐步接入。

具体目标和阶段见 [重制架构蓝图与实施顺序](rebuild-blueprint.md)。
