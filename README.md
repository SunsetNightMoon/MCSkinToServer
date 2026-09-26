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
- 2026-09-23 P1 收尾 + P2：HMCL 真机联调通过 + 上传链路完成。
  - HMCL「外置登录」对接 MSCTS 成功（认证服务器 `http://localhost:3000`，注册/登录/角色全链路真机验证）。
  - P2 依赖：sharp（PNG 解析/尺寸校验，≤2MB 皮肤 64x64|64x32、披风 64x32）。
  - `src/repositories/blobRepository.ts`（sha256 去重查询/引用计数）、`assetRepository.ts`（assets CRUD + profile_assets 绑定，ON CONFLICT 覆盖同槽）。
  - `src/textures/ingest.ts` TextureService：ingest（校验→去重→存储写入→落库，相同 sha256 复用 blob 不重复写文件）、applyToProfile/removeFromProfile（所有权+槽位类型校验）、deleteAsset（解绑→无引用时连带删 blob+文件，验收"不留不可追踪对象"）。
  - `src/server/routes/assets.ts`：POST /api/assets（raw PNG body + query 元数据，无 multer）、GET /api/me/assets、POST /api/assets/:id/{apply,remove}、DELETE /api/assets/:id。
  - 测试 42/42 全绿（新增 4 项：上传/去重/校验、应用→纹理 URL 可访问→删除清理，双方言）；E2E：登录→上传→应用→profile 协议输出→纹理取回 200。
  - 测试基建：所有测试 SCHEMA_DIR 改为 import.meta.url 定位，不再依赖进程 cwd。
- 2026-09-23 P3：公开库 / 收藏 / 审核 / 权限矩阵完成。
  - `src/library/libraryService.ts`：权限矩阵领域服务（可见：approved+public 任何人 / 其余 owner+admin；下载：download_policy=public 且 approved 任何人、owner_only 归 owner/admin、rejected 一律不可下载；收藏：仅 approved+public 且不能收藏自己的素材，真实计数语义取代 plan3 的"发布者默认 +1"）。
  - `src/repositories/favoriteRepository.ts`（含 countByAssets IN 批量防 N+1）；assetRepository 扩展 listPublic 分页排序（latest/views/downloads）、浏览/下载计数、updateReviewStatus（状态+asset_reviews 流水）、updateModerationFields、updateOwnerFields、listPending、listReviews。
  - 端点：GET /api/library（分页/排序，匿名）、GET /api/library/:id 与 /api/assets/:id（统一详情+浏览计数）、GET /api/assets/:id/download（矩阵+计数）、POST/DELETE /api/assets/:id/favorite、GET favorite-count / is-favorited、GET /api/me/favorites、PATCH /api/assets/:id（owner 改 visibility/downloadPolicy/名称/描述）、GET /api/admin/reviews、POST /api/admin/assets/:id/review、PATCH /api/admin/assets/:id（adminWarning/aiGenerated）、GET /api/admin/assets/:id/reviews。
  - `middleware.ts` 新增 optionalAuth：公开接口匿名可读，坏 token 降级匿名不报错。
  - 测试 48/48 全绿（新增 library 6 项：审核前矩阵/公开+收藏+计数/rejected 消失+流水+标记，双方言）；admin.ts 曾漏挂 requireAuth 导致全 401（requireRole 只查角色不写 context，两个中间件必须都挂）。
- 2026-09-23 P4 第一批：Web 前端迁移（Vite + React 18 + AntD 5 + Zustand）。
  - `web/`：vite 6（端口 5173，代理 /api、/uploads、/authserver、/sessionserver → localhost:3000）+ antd 5.29 + zustand 5（persist key `mscts-auth`）+ react-router-dom 6（HashRouter）+ dayjs。
  - 主题：`colorPrimary: #0078d7` + `borderRadius: 0` 全组件直角。
  - `src/api/client.ts`：统一 fetch 客户端（自动 Bearer、401 清登录态跳登录、非 2xx 抛 ApiError、apiUpload raw PNG）。
  - 页面：Login / Register（角色名 `^[A-Za-z0-9_]{3,16}$`、密码 8 位起）/ Profiles（新建+改名冷却+删除保底 1）/ Wardrobe（皮肤/披风切换、上传、应用到角色、删除）/ Library（卡片网格+分页+排序+详情 Modal 收藏/下载）。
  - 验收：`npm run build`（tsc --noEmit + vite build）零错误；vite dev 启动后代理链路实测登录 200。
  - 坑：antd 5 Select 选项属性是 `options` 不是 `items`；`React.ReactNode` 作为纯类型引用可走 UMD 全局解析（勿画蛇添足 import）。
- 2026-09-23 P4 插曲：Yggdrasil 路由多前缀挂载（HMCL 账户刷新 NOT_FOUND 修复）。
  - 现象：HMCL 添加账户填 `/api/yggdrasil` 时登录 NOT_FOUND——HMCL 会把 authenticate 等端点直接拼在所填 URL 后，而认证端点只挂在 `/authserver/` 下，根路径也无元数据。
  - 修复：yggdrasil.ts 路由改相对路径，app.ts 多前缀挂载——`/authserver/*`（原路径兼容）、`/api/yggdrasil/*`（authlib-injector 规范）、`/`（根别名，含元数据）；批量查询保持绝对路径 `/api/profiles/minecraft` 由根挂载命中。
  - 教训：Express 路由相对路径 × 多前缀挂载时，`'/api/profiles'` + `'/profiles/minecraft'` 会拼出 `/api/profiles/profiles/minecraft`（测试抓到，48/48 双方言全绿后修复完成）。
  - HMCL 填法：`http://localhost:3000/api/yggdrasil` 或裸 `http://localhost:3000` 均可。
- 2026-09-23 P4 第二批：前端沿用 plan3 设计语言重做。
  - 主题系统：暗色默认（深蓝星空背景 starfield + 玻璃拟态卡片 + #4a9eff 强调）↔ 亮色（#2563eb），AntD darkAlgorithm/defaultAlgorithm + CSS 变量 + body[data-theme]，zustand persist key `mscts-site`。
  - 布局：顶栏 TopNav（brand + 导航链接 + 主题切换/头像/登出）替代侧栏；Footer；路由加 Landing 起始页（星空 hero 右对齐 CTA）。
  - 组件：SkinAvatar（canvas 双层头部渲染，默认 Steve 脸兜底）、Skin3DViewer（skinview3d：旋转/待机/行走/奔跑/复位，详情 Modal 与应用弹窗内嵌）。
  - 页面重构：Login/Register（AuthShell 星空居中卡片）、Library（asset-card 网格 + 3D 详情）、Wardrobe（表格玻璃卡 + 应用弹窗预览）、Profiles。
  - 后端配套：/uploads 静态响应加 `Access-Control-Allow-Origin: *`（canvas 跨源读纹理必需）。
  - 语言切换（GlobalOutlined Dropdown + i18n）留待下一批；TopNav.tsx 已预留注释位。
- 2026-09-23 P4 第三批：头像真实皮肤 + 管理后台。
  - 后端：GET /api/me/skin（当前用户默认角色皮肤 URL，IdentityService 加可选 assetUrlResolver 依赖）；GET/PATCH /api/admin/users（用户列表分页搜索、封禁/解封/角色调整）；UserRepository 加 listUsers/updateAdminFields（双方言占位符规约）；错误码新增 FORBIDDEN→403。
  - 权限规则：角色调整仅 super_admin；不可修改 super_admin（除非自己是超管）；不能封禁自己。
  - 前端：TopNav 头像显示当前用户皮肤（登录/切页自动刷新）；/admin 管理后台（审核队列：通过/拒绝+理由/管理员警告/AI 标记；用户管理：搜索/封禁 7 天/自定义封禁/解封/超管调角色）；导航与顶栏齿轮入口仅管理员可见。
  - 冒烟：me/skin 返回真实皮肤 URL；封禁→登录被拒（USER_BANNED）→解封闭环通过；双方言 48/48 全绿。
- 2026-09-23 P4 第四批：对齐旧版功能可用性。
  - 上传体验：衣柜上传改完整面板（拖拽区 + 皮肤模型经典/纤细选择 + 命名 + 本地预览），修复此前无法上传纤细模型的问题。
  - 素材编辑：衣柜表格「编辑」弹窗（名称/描述/公开可见/下载策略）接入既有 PATCH /api/assets/:id。
  - 素材库：名称搜索（后端 listPublic/listLibrary 加 search 参数，双方言 lower(name) LIKE）+「我的收藏」页签（GET /api/me/favorites，卡片同构复用）。
  - 个人中心 /profile：账号信息 + 当前角色皮肤 3D 预览 + 快捷入口；顶栏头像点击跳个人中心。
- 2026-09-23 P4 第五批：旧版前端整体 1:1 移植（用户要求完全套用旧版界面功能）。
  - i18n 落地：i18next + react-i18next 四语言（SCH/TCH/EN/JP，plan3 语言文件为基底），默认简中，持久化 key `cattavern-language`；AntD locale 随语言切换；全部页面文案 t() 化。
  - 路由对齐旧版：/library 素材库（搜索/排序/分页/URL 参数恢复）、/skin/:id 与 /cape/:id 独立详情页（大 3D 预览+信息栏+收藏下载）、/upload 上传页、/my-skins /my-capes 我的上传管理、/wardrobe 衣柜（3D 组合预览）、/profile 个人中心、/admin 管理页。
  - 组件补齐：ErrorMessage、LoadingSpinner、SkinThumbnail3D、Skin3DViewer 补地面软阴影/披风鞘翅切换/背面视角。
  - 后端没有的功能（OAuth/Turnstile/改密码/邮箱验证/站点设置）不做假接口，占位「即将上线」；未改后端代码。
  - 验收：tsc + vite build 零错误；vite dev :5173 + 后端 :3000 均存活。
- 2026-09-23 P4 第六批：整包搬入旧版界面套件，用适配层桥接 MSCTS 后端。
  - 用户判定自研界面套件「漏洞非常多」，明确要求直接复用旧版界面。做法改为：把 plan3 的 22 个页面 + 组件 + i18n + store 整体拷入，**页面 JSX 一字未改**，只换数据层。
  - 新增 `web/src/utils/apiCompat.ts` 作为唯一翻译层：页面首行 `import { compatFetch as fetch } from "../../utils/apiCompat"`，由它完成旧版路径 → MSCTS 端点映射、请求/响应 snake_case ⇄ camelCase 翻译、以及无对应端点时的降级返回。
  - `store/authStore.ts` 用 `roleToLevel()` 把后端的 `user.role` 映射成旧页面直接用的 `user.level`，使 `/admin` 的 `user.level >= 1` 判断原样可用；`api.ts` 修正为 403 不再误判为登录失效。
  - `store/siteStore.ts` 去掉 `/api/settings/public` 依赖改用本地默认值，persist key `mscts-site`。
  - 路由改 HashRouter（部署免重写规则），移除 MSCTS 无后端支持的 /setup 与 /oauth-success 路由（页面文件保留不挂载）。
  - 依赖新增 axios / recharts / @monaco-editor/react，three 锁 ^0.156.1 以匹配 skinview3d 3.4.2。
  - 验收：`tsc --noEmit && vite build` 零错误（3742 modules）；dev server 下逐个请求全部 47 个 TSX/TS 模块均 200，零转换失败；`/api/library`、`/api/yggdrasil` 经 vite 代理均 200。
  - 遗留：`web/src/i18n/locales/nul`（旧仓库带入的 Windows 保留设备名文件，23717B 旧版繁中副本，不参与构建）。已尝试 rm / del \\?\ / MoveFileExW(.NET) / Python DeleteFileW 全部返回 ACCESS_DENIED，属宿主策略拦截，需用户手动删除。
- 2026-09-24 P4 第六批修正：3D 预览默认 Steve 丢失 + 衣柜「已应用」不显示。
  - 根因一（静态资源漏搬）：旧版静态资源目录是 `frontend/public`，第六批只对拍了 `web/`，整个 `public/` 没跟进 → `/steve.png` 404 → 上传页/衣柜/素材库的 3D 预览全部空白棋盘格。修复：拷回 `steve.png`、`favicon.svg`，并给 `index.html` 补回 `<link rel="icon">`。
  - 根因二（接口缺字段）：`Wardrobe.tsx:487` 用 `currentProfile?.skin_id === skin.id` 打「已应用」标记，`Wardrobe.tsx:100` 用 `profile.skin_id` 初始化选中项；但 `/api/me/profiles` 只返回 id/name/时间戳，`toLegacyProfile` 也没映射 → `skinId` 恒为 null，于是既无高亮、预览也退回不存在的 steve。
  - 后端补数据：`ProfileRepository.listTextureBindingsByUserId`（一次 LEFT JOIN 批量取全部角色的 skin/cape + 素材 ID，避免逐角色 N+1，沿用「rejected 不渲染」规则）；`IdentityService.listProfilesWithTextures` 组合 `ProfileRow` 与绑定并生成 URL；`GET /api/me/profiles` 改为返回 `skinId/capeId/skinUrl/capeUrl/model` 超集（原字段不变）。
  - 前端补映射：`profileService.toLegacyProfile` 把上述字段翻译为旧页面的 `skin_id/cape_id/skin_url/cape_url/model_type`。
  - 验收：后端 `tsc --noEmit` 零错误；前端 `tsc --noEmit && vite build` 零错误（3742 modules）；`npm test` 31 pass / 0 fail（7 skipped 为未启用的 PG 用例）；接口实测 `/api/me/profiles` 返回 `skinId=1aea0d15…`（Kagamist_MagicCat_main）与完整 `skinUrl`；无头浏览器截图确认衣柜预览显示该皮肤、卡片出现绿色「已应用」标签、上传页预览回到默认 Steve。
- 2026-09-24 P4 第六批修正二：上传页「权限设置」不生效（表单白填）。
  - 根因：旧版上传表单提交 `permission_level` 单字段，但 `apiCompat` 的上传映射只透传 name/description/license_type/model_type，**丢弃了 permission_level**；后端 `POST /api/assets` 与 `IngestInput` 也都没有 visibility / downloadPolicy，`AssetRepository.insert` 把两列硬编码为 `'private'` / `'owner_only'` → 用户选「公开可下载」上传后仍是私有。
  - 后端：`NewAssetRow` 与 `IngestInput` 增 `visibility` / `downloadPolicy`（省略时保持 `private` / `owner_only` 安全默认）；`insert` 改为读取传入值；`ingest` 增加取值域校验（非法值报 `VALIDATION_ERROR`，不静默吞掉）；`POST /api/assets` 解析对应 query 参数。
  - 前端：`apiCompat` 上传映射把 `permission_level` 经 `toPolicy()` 翻译为 `visibility` + `downloadPolicy` 后传给上传接口。
  - 注意领域规则未变：上传即可设为公开，但 `review_status` 仍是 `pending`，**公开 ≠ 自动通过审核**，仍需管理员审核后才进公开库。
  - 验收：上传 `visibility=public&downloadPolicy=public` 实测数据库落地为 `('PermProbe','public','public','pending')`（并命中 sha256 去重 `deduped=true`）；非法值 `visibility=weird` 被拒（`VALIDATION_ERROR: visibility 必须为 private 或 public`）；探查数据已清理；`npm test` 31 pass / 0 fail；前端 build 零错误。

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
