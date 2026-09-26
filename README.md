# MSCTS

Minecraft Skin Texture Server 的重制工作区。这里保存对 `minecraft-skin-server-plan3` 的代码分析、重制架构和后续实施记录。

## 参考基线

- 源码目录：`G:\Skin2.catnight.top\minecraft-skin-server-plan3`
- 分析版本：`b01f29a`，分支 `master`
- 分析日期：2026-09-20
- 本次分析没有修改 plan3 源码
- plan3 工作区在分析时仍有未提交的部署相关改动：`.dockerignore`、`.env.example`、`Dockerfile`、`docker-compose.yml`、`DOCKER.md`、`start.sh`

## 文档

- [plan3 代码与架构分析](docs/plan3-analysis.md)
- [API 与数据对象清单](docs/route-inventory.md)
- [重制架构蓝图与实施顺序](docs/rebuild-blueprint.md)
- [Canonical Schema 草案](docs/schema-design.md)（v1 已评审通过；配套 `schema/postgresql/0001_init.sql` 与 `schema/sqlite/0001_init.sql`）

## 实施进度

- 2026-09-20 P0 任务 1：canonical schema 草案 v1 完成（15 表、双库 DDL、plan3 差异与数据迁移映射）。
- 2026-09-23 评审通过（§7 六项默认决策全采纳）。
- 2026-09-23 P0 任务 2：版本化迁移 runner + 双数据库 smoke test 完成。
  - `src/migrate/runner.ts`（版本表 + checksum 漂移检测 + 单迁移单事务，失败回滚并阻止启动）、`src/db/`（sqlite/postgres 适配层）、`npm run migrate` CLI。
  - 测试 5/5 全绿：SQLite 4 项 + PostgreSQL 全套（全量/幂等/漂移/回滚）。
  - 本地 PG：`INDEV/`（便携 PostgreSQL 16.4，端口 54329，无 Docker；见 `INDEV/README.md`，随开随用不常驻）。
- 2026-09-23 P0 任务 3：统一 AuthContext + AssetUrlResolver 完成。
  - `src/auth/tokens.ts` TokenService（签发/验证/吊销，token 只存 sha256，clientToken 校验，禁用用户即时失效，时钟可注入）；`src/repositories/tokenRepository.ts`（repository 层首块）；`src/errors.ts`（统一错误码）；`src/storage/`（StoragePort 端口 + 本地 provider + 内容寻址 blob key + AssetUrlResolver）。
  - 测试 12/12 全绿（token 双方言 4 项 + 存储 3 项 + 迁移 5 项）。
- 2026-09-23 P0 任务 4 + 7：TextureProfileBuilder + Yggdrasil 兼容测试套件完成。
  - `src/yggdrasil/`：textures（唯一构建器，字段顺序锁定）、uuid（边界无连字符转换）、keys（RSA 2048 自动生成/加载，SHA1withRSA）、errors（400/403/500 集中映射）、metadata、buildForProfile 组合链路；`src/repositories/profileRepository.ts`（findTextureState，rejected 素材不渲染）。
  - 固定测试向量：`tests/fixtures/yggdrasil-vector.json`（`npm run gen:vector` 重新生成，diff 需审查）。
  - 测试 20/20 全绿（新增 8 项：UUID/密钥/向量/unsigned/metadata/rejected 排除链路）。
  - 领域决策：被拒绝素材一律不出现在纹理输出（蓝图 §7.2 待决策项的安全默认）。
- 2026-09-23 P0 收尾：Express 5 骨架 + 统一认证中间件 + 健康检查 + 错误映射完成，**P0 全部达成**。
  - `src/server/`：app（工厂，依赖注入）、middleware（requireAuth / requireAdmin / requireSuperAdmin，req.context = RequestContext）、errorHandler（YggdrasilError→协议体、AppError→状态码映射、未知→500 不泄露）、main（启动生命周期：迁移失败阻止启动、SIGINT/SIGTERM 优雅关闭）。
  - 已有 HTTP 面：/health/live、/health/ready（数据库+存储探针）、/api/yggdrasil（元数据）、/uploads（静态）、/api/me（认证探针）。
  - 真实启动冒烟通过；测试 30/30 全绿；git 仓库已初始化（提交身份待用户配置）。
  - Helm/CSP 等安全加固按计划推迟到 P5。
- 2026-09-23 P1：身份链路 + Yggdrasil 端点全量接入完成。
  - `src/repositories/userRepository.ts`（user_uid：PG identity / SQLite 事务内 MAX+1）、`minecraftSessionRepository.ts`（join 短会话 30s TTL）、profileRepository 扩展角色 CRUD。
  - `src/auth/identity.ts` IdentityService：注册（单事务建用户+默认角色）、登录、封禁检查（永久/临时到期自动恢复）、Yggdrasil authenticate/refresh（换发+吊销旧 token）/validate/invalidate/signout、join 校验、角色管理（上限 3 个、改名 30 天冷却——初始命名不算改名，首次改名无冷却）。
  - `src/server/routes/yggdrasil.ts`：/authserver/* 五端点 + /sessionserver/session/minecraft/{join,hasJoined,profile/:uuid} + POST /api/profiles/minecraft 批量查询（协议端点，未命中名字不报错）。
  - `src/server/routes/identity.ts`：/api/auth/{register,login,logout} + /api/me/profiles + /api/profiles（新建/改名/删除，均挂 requireAuth）。
  - 错误映射扩展：INVALID_CREDENTIALS→401、EMAIL_TAKEN/NAME_TAKEN→409、USER_BANNED/NAME_COOLDOWN→403、NOT_FOUND→404、VALIDATION_ERROR→400；Yggdrasil 侧凭据错误统一 ForbiddenOperationException(403)。
  - 测试 38/38 全绿（identity 套件 8 项：注册/封禁/Yggdrasil 会话/join→hasJoined→profile 纹理链路/批量查询/改名冷却，SQLite + PostgreSQL 双方言）。
  - 真实服务器冒烟通过（注册→authenticate→批量查询）。
  - 跨方言占位符规约沉淀：**占位符下标不可重复**（SQLite 每个 ? 都要绑定值，PG 的 $n 重复只算一个），重复值也要用不同下标各绑一次。

## 结论摘要

plan3 已经具备可运行产品的主要功能：Yggdrasil 认证兼容、Web 注册登录、角色管理、皮肤和披风上传、审核、公开素材库、收藏、OAuth、Turnstile、Redis 缓存、S3 存储和 Docker 部署。

但它的主要问题不是功能缺失，而是多个演进阶段的实现叠加在一起：

1. 数据库 schema 同时存在迁移文件、安装向导内联 DDL、测试 DDL 和历史迁移脚本四套来源。
2. SQLite 与 PostgreSQL 的字段、类型和令牌结构没有形成一个稳定的跨数据库契约。
3. 认证、上传、权限检查和文件 URL 组装在多个路由中重复实现。
4. 生产 Docker 路径、迁移入口和前端静态文件路径与 Express 运行时约定不完全一致。
5. 前端类型和后端查询结果已经出现漂移，当前前端类型检查存在明确错误。

因此，重制工作的第一目标应是先恢复“单一事实来源”：统一数据模型、统一认证上下文、统一文件对象 URL、统一迁移入口，再逐步迁移现有功能。

## 工作约定

- `plan3-analysis.md` 记录已从代码确认的事实和风险。
- `rebuild-blueprint.md` 记录目标设计和建议，不代表已经实现。
- 任何重制任务完成后，应同步更新 API、schema、迁移和测试状态。
- 兼容 Yggdrasil 的外部协议是硬约束；内部实现可以重写。
