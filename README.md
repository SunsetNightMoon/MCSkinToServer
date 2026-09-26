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
- 2026-09-24 P4 第七批：账号生命周期 + 管理后台补齐 + 站点设置持久化 + 打包优化。
  - **账号功能**（此前是「即将上线」占位，本轮补齐）
    - 改密码 `POST /api/auth/change-password`：需旧密码（bcrypt 校验），成功后 `tokens.revokeAllForUser` 吊销该用户**全部**会话（含 Yggdrasil）；前端收到成功即 `clearAuth()` 并跳登录页，因此整体吊销不打断流程。
    - 注销 `POST /api/auth/delete-account`：需密码确认，返回 `recoverableUntil`（= 注销时刻 + 15 天）。注销后 `loginWeb` 抛 `ACCOUNT_DELETED`（HTTP 403），前端 `Login.tsx` 据此**改弹恢复 Modal** 而非错误提示。
    - 恢复 `POST /api/auth/restore-account`（免认证，邮箱+密码）：仅限宽限期内，成功后清 `deleted_at` 并直接下发新会话；对未注销账号调用返回 `VALIDATION_ERROR`。
    - **UID 不复用的关键设计**：到期清除 `purgeExpiredAccounts` 只清个人数据（素材、角色），**保留 users 行**并写 `purged_at`——因为 SQLite 侧 `user_uid` 由应用层 `MAX(user_uid)+1` 分配，物理删行会让 UID 被后续注册复用。清除同时把邮箱改为墓碑值 `deleted-uid<N>@invalid.local`、密码清空、`is_active=0`，于是原邮箱被释放但 UID 被占住。
    - 迁移 `0002_account_lifecycle.sql`（双方言）：`users` 增 `deleted_at` / `purged_at` + `users_deleted_idx`。
    - 清除入口：服务启动时调用一次（不引入定时器/Redis，符合不加重型依赖的约定）；失败不阻塞启动。
    - `errorHandler` 新增 `ACCOUNT_DELETED → 403`。
  - **管理后台补齐**
    - `GET /api/admin/assets`：全量素材列表（含 private/pending/rejected），支持 `kind` / `status` / `search` / 分页。此前管理页只能借公开库接口，**看不见私有与待审素材**。
    - `PATCH /api/admin/assets/:id` 扩展为可编辑 `name` / `description` / `license` / `visibility` / `downloadPolicy`（管理员身份即授权，不做归属校验），保留原有 `adminWarning` / `aiGenerated`。
    - `apiCompat`：`/api/admin/(skins|capes)` 从走公开库改为走新端点并补 `withPreviewUrl` 缩略图；`PUT/PATCH /api/admin/(skins|capes)/:id` 由「不支持」改为转发 `PATCH /api/admin/assets/:id`，并翻译 `license_type→license`、`permission_level→visibility+downloadPolicy`、`is_ai_generated→aiGenerated`、`admin_warning→adminWarning`。
  - **站点设置持久化**（前端此前是纯本地默认值，管理端改完刷新即丢）
    - `SettingRepository`：`system_settings` 表（0001 已存在，**无需新迁移**）；值统一按 JSON 文本读写，数字/布尔都能安全往返；upsert 用 `ON CONFLICT (key) DO UPDATE`。PG 侧 jsonb 列绑定需显式 `::jsonb` 转型，否则报 `column is of type jsonb but expression is text`。
    - `PUBLIC_SETTING_KEYS` 白名单（站点外观/文案/开关，16 个键）——非白名单键不出现在公开端点，但管理端 `getAll` 可见。
    - `GET /api/settings/public`（匿名）、`GET/PUT /api/admin/settings`（管理员）；`AppDependencies.settings` 设为可选，未注入时用空实现占位（既有测试不注入也能编译通过）。
    - `siteStore.loadSettings` 改为真实 fetch；**THEME 仅在后端有值时覆盖**，避免冲掉用户本地主题选择。
  - **前端打包优化**
    - `manualChunks` 按库族分包：`vendor-three`(509KB) / `vendor-charts`(313KB) / `vendor-monaco` / `vendor-antd`(1.06MB) / `vendor-core`(399KB)。
    - 注意坑：React 及其依赖族必须收进**同一个** chunk。最初把 `react` 单独拆出、其余落兜底 `vendor`，产生 `Circular chunk: vendor -> vendor-react -> vendor` 告警且存在 TDZ 运行时风险 → 改为单一 `vendor-core` 兜底后告警消失。
    - 路由级懒加载：除入口页 `Landing` 外全部 `React.lazy`（此前 0 处懒加载，所有页面静态 import，分包不减少首屏下载量）。`Layout` 内 `<Outlet>` 外加局部 `Suspense`，切页时导航栏/页脚/背景不闪；外层再套一个 `Suspense` 覆盖不走 Layout 的 `/login`、`/register`。
    - 效果：首屏 JS 由 **2652KB / gzip 778KB** 降至约 **1640KB / gzip 521KB**（-38% / -33%）；`three`(gzip 128KB) 与 `recharts`(gzip 85KB) 不进首屏，仅进对应页面时下载。
    - `vite preview` 补上后端代理（默认不带），使生产构建可本地联调冒烟。
  - **测试与验收**
    - 新增 `tests/accountLifecycle.test.ts`（改密码/注销/恢复/到期清除+UID 不复用/幂等）与 `tests/adminSettings.test.ts`（设置白名单与 upsert、管理端全量列表含私有、管理员编辑、权限门槛）。`npm test` 纳入两者。
    - `tests/migrations.smoke.test.ts` 原先硬编码 `applied === ['0001']`，新增迁移后失败；改为共用 `EXPECTED_MIGRATIONS` 常量，以后加迁移只改一处。
    - **修正一处此前的测试错误**：公开库真实端点是 `/api/library`，此前冒烟脚本用的 `/api/library/assets` 是 404，那条断言实际空转（`items` 取不到恒为空数组）；已改正并断言私有/待审素材不出现在公开库。
    - `npm test` **63 tests / 55 pass / 0 fail / 8 skipped**（skip 为未启用 PG 用例）；后端 `tsc --noEmit` 零错误；前端 `tsc --noEmit && vite build` 零错误。
    - 无头浏览器对**生产构建**（`vite preview` :4173）截图复核：首页、登录、素材库、衣柜（3D 模型 + 绿色「已应用」标签）、管理后台（recharts 图例渲染，趋势图空白为 MSCTS 空序列的已知降级）均正常。
  - **顺带修复：错误提示全部退化成通用文案**
    - 旧版（plan3）Web 接口错误体是 `{ error, errorMessage }`，移植过来的前端有 20+ 处按 `data.errorMessage` 取文案；MSCTS 只返回 `{ error, message }` → 全部落到 `|| t('...操作失败')` 兜底，用户看不到「密码不正确」等真实原因。
    - 修法选在**服务端**：`errorHandler` 的 `AppError` 与 500 分支冗余输出 `errorMessage: err.message`。纯增量（不影响既有 `error`/`message` 消费方），一次修好全部 20+ 处，且**不动任何页面 JSX**（符合「旧版界面一字未改」的约束）。
    - 实测：`POST /api/auth/login` 错密码返回 `{"error":"INVALID_CREDENTIALS","message":"邮箱或密码不正确","errorMessage":"邮箱或密码不正确"}`。
- 2026-09-24 P5 第一批：Redis 分布式限流 + 站点设置缓存（可选依赖，关闭时核心功能不受影响）。
  - **范围取舍**：本轮只做 Redis 限流 + 缓存。P5 蓝图里的 SMTP / Turnstile / OAuth / S3-MinIO / Docker 镜像与反代备份**本轮不做**（Docker 与既有约定冲突：生产是 OpenResty + 1Panel + PM2）。
  - **便携 Redis**：`INDEV/redis/`（zkteco-home 移植版 8.10.2，端口 63799，不入 git），`start-redis.cmd` / `stop-redis.cmd` / `ping-redis.cmd`；详见 `INDEV/README.md`（含「启动时会写 384MB 内存转储」的已知问题与规避）。
  - **端口模式**（沿用 `StoragePort` 的做法：窄接口 + 多实现 + 装配层负责降级）
    - `src/cache/types.ts`：`RateLimiterPort` / `CachePort` / `CacheLayer`。两个端口**错误契约刻意不同**——限流器允许抛错（调用方要知情并按 fail-open 放行），缓存实现**不得抛错**（缓存是非权威数据源，读不到就当未命中，不能让读接口 500）。
    - `src/cache/keys.ts` 单独成文件（只放键名常量）：仓储层要键名，但不该因为一个字符串常量就把 Redis 客户端拉进自己的 import 图。
    - `src/cache/memory.ts`：进程内存实现（懒清理阈值 1024，时钟可注入）。
    - `src/cache/redis.ts`：`RedisRateLimiter`（固定窗口 Lua）/ `RedisCache` / `createRedisCacheLayer`。
    - `src/cache/index.ts`：`createCacheLayer` 按 `REDIS_URL` 决定用哪个实现。
  - **固定窗口必须用 Lua**：`INCR` 与 `PEXPIRE` 分两条命令发，一旦 INCR 之后进程中断，该 key 永不过期、**被永久锁定**（等于把某个用户/邮箱永久封在 401 里）。脚本里 `INCR` + 首次 `PEXPIRE` + `PTTL` 一次原子完成。
  - **限流接入**（`src/server/rateLimit.ts` + `src/server/routes/{yggdrasil,identity}.ts`）
    - Yggdrasil `/authenticate`、`/signout` 按用户名（邮箱）计数；Web `/api/auth/login` 按邮箱、`/api/auth/register` 按来源 IP。
    - **显式注入才启用**：`AppDependencies.rateLimiter?` / `rateLimitSettings?` 缺省时不挂任何中间件，路由行为与加限流前完全一致——这正是既有测试（大量重复登录调用）无需改动的原因，并已用测试固化。
    - **fail-open**：计数器故障时放行并记 warning。限流是防滥用的加固层、不是鉴权本身；因缓存故障导致全站无法登录，代价远大于短时间失去限流保护。
    - `clientIp()` 用 `req.ip` 而非直接读 `X-Forwarded-For`：后者可被客户端伪造绕过按 IP 的限流。反代后取真实 IP 需设 `TRUST_PROXY`（生产 OpenResty + 1Panel 必需，`createApp` 里解析）。
    - 429 响应体：`{ error: 'TOO_MANY_REQUESTS', message, errorMessage, retryAfterSeconds }` + 标准 `Retry-After` 头。`errorMessage` 沿用 P4 的旧前端兼容约定。**未改动前端 `UserProfile.tsx` 的 429 分支**（那是旧站改名冷却语义），仅服务端统一输出。
  - **站点设置缓存**：`SettingRepository(db, cache?, publicTtlMs?)`。`getPublic()` 读穿透 + 回填，`setMany()` 主动 `del` 失效，`getAll()` **不缓存**（管理端必须看到刚写入的值）。
  - **一个真实的启动卡死缺陷（本轮发现并修复）**：node-redis 缺省 `reconnectStrategy` 无限重连，Redis 不可达时 `connect()` **永不 settle** —— 进程不报错退出，而是安静地挂着不监听端口（容器/PM2 下表现为「进程活着但服务不可用」，极难排查）。修复：`socket.reconnectStrategy` 上限 2 次重试 + `connectTimeout: 2000`，失败后 `destroy()` 清掉残留重连定时器再抛错由上层降级；`error` 事件按 5s 节流（否则重连期间刷满日志）。已固化为回归测试（断言「在有界时间内降级 + 进程仍可服务」）。
  - **测试与验收**
    - 新增 `tests/cache.test.ts`（21 项）：内存限流窗口行为与边界、内存缓存 TTL 与假值（0/false/''/null 不得当未命中）、限流中间件 429 与响应头、`enabled=false` 开关、`keyOf` 为 null 时跳过不耗配额、**fail-open**、真实 `POST /api/auth/login` 接线（第 4 次 429 且按邮箱隔离）、未注入限流器时不出现 429、设置缓存读穿透+写失效+管理端不走缓存、`RedisCache` 故障不抛错、装配降级、Redis 实现真实读写（`TEST_REDIS_URL` 门控）。
    - **修正一处此前的空转断言（重要）**：`tests/migrations.smoke.test.ts` 的 PG 分支把整个 `schema/postgresql` 目录 `cp` 到临时目录再塞一个 `0002_broken.sql`；上一批新增 `0002_account_lifecycle.sql` 后出现**版本号重复**，`runMigrations` 在应用任何迁移之前就抛错——错误信息里恰好含 "0002" 让 `assert.rejects(/0002/)` 通过，而下方的「0001 的表应保留」变成**空转断言**（表根本不存在）。因 PG 用例一直被 skip（未设 `TEST_DATABASE_URL`）所以从未暴露。修复：只复制版本号最小的真实迁移 + 用 `9999_broken.sql`，并断言 `schema_migrations` 只记录该基础版本。
    - 顺带发现并修正：`tests/assets.test.ts` 与 `tests/library.test.ts` **从未被 `npm test` 引用**（等于没在跑）；已纳入脚本，确认双方言可跑通。
    - `npm test`（SQLite）**94 tests / 79 pass / 0 fail / 15 skipped**（skip = 未设 `TEST_DATABASE_URL` / `TEST_REDIS_URL` 的门控用例）；`TEST_DATABASE_URL=… TEST_REDIS_URL=… npm run test:pg`（PG + Redis 全开）**94 pass / 0 fail / 0 skipped**。后端 `tsc --noEmit` 零错误。
    - 端到端实测（后端连真实 Redis 63799）：启动日志 `[cache] 已连接 Redis`；`AUTH_RATE_LIMIT_MAX=3` 下连续错误登录前 3 次 401、第 4 次起 429 + `Retry-After: 54` + `retryAfterSeconds`；`redis-cli keys 'mscts:*'` 可见 `mscts:rl:login:…` 与 `mscts:cache:settings:public`（PTTL≈30s，与 `SETTINGS_CACHE_TTL_MS` 一致），客户端信息显示 `lib-name=node-redis`、`cmd=eval`（确认走 Lua 脚本）；管理端 PUT 设置后缓存键被删除（`exists` 1→0）且公开端点立即返回新值。
    - 降级实测：不设 `REDIS_URL` → 内存实现 + 限流照常生效（401/401/429）；`REDIS_URL` 指向关闭端口 → 1 秒内启动完成（修复前会永久挂住），仅 1 条错误日志 + 1 条降级 warning，功能正常。
- 2026-09-24 P5 第一批装配收尾（与上条同批）。
  - `src/server/main.ts`：`createCacheLayer({ redisUrl: config.redisUrl })` → `new SettingRepository(db, cacheLayer.cache, config.settingsCacheTtlMs)` → `createApp` 传 `rateLimiter` / `rateLimitSettings: resolveRateLimit(config)` / `cache` / `settingsCacheTtlMs` → `shutdown` 里 `cacheLayer.close()`（Redis 持有 socket，不显式 quit 会让进程多撑到 3s 超时兜底）。
  - 配置项：`REDIS_URL`、`RATE_LIMIT_DISABLED`、`AUTH_RATE_LIMIT_MAX`（默认 5）、`AUTH_RATE_LIMIT_WINDOW_MS`（默认 300000）、`SETTINGS_CACHE_TTL_MS`（默认 30000）、`TRUST_PROXY`；已全部写入 `.env.example`。
  - `INDEV/run-tests.cmd`：先 `redis-cli ping` 探测，**只在 Redis 真的应答时才设 `TEST_REDIS_URL`** —— 否则 Redis 没起时门控用例会 FAIL 而不是 SKIP，属于假警报。
- 2026-09-24 P5 第一批修正：个人中心展示的「认证服务器地址」指向了前端开发服务器端口，且在生产不可用。
  - **现象**：`/profile` 的「添加 Yggdrasil 认证服务器」卡片显示 `http://localhost:5173` —— 那是**前端 dev server 端口**。
  - **根因**：`web/src/pages/Profile/UserProfile.tsx` 取 `VITE_API_URL || window.location.origin`，而 `web/` 下**没有任何 `.env` 文件** → 本地恒为 origin（5173）。
  - **实测确认这不只是"误导"，而是真的用不了**。启动器拿到地址后第一件事是 `GET <地址>` 取元数据 JSON：

    | 填法 | `GET <地址>` | `POST <地址>/authenticate` |
    |---|---|---|
    | `http://localhost:5173`（**旧显示值**） | 200 但 `content-type: text/html`（SPA 页面）✗ | **404** ✗ |
    | `http://localhost:3000` | 200 `application/json`（元数据）✓ | 200 ✓ |
    | `http://localhost:3000/api/yggdrasil`（**新显示值**） | 200 `application/json` ✓ | 200 ✓ |

    5173 之所以看着"能连"，只是因为 `vite.config.ts` 代理了 `/authserver`、`/sessionserver` 等固定前缀；而启动器拼的是规范相对路径 `/authenticate`，不在代理范围内 → 404。
  - **生产同样不成立**：站点根路径 `/` 必须留给 SPA（HashRouter 的文档入口就是 `/`），`GET /` 返回 index.html，启动器判定「这不是认证服务器」。所以**裸域名在任何部署形态下都不是合法的认证服务器地址**。
  - **修复（三处）**：
    1. 展示值改为 `<API 根>/api/yggdrasil`（`API 根` = `VITE_API_URL` 或站点 origin），并加防重拼保护（若 `VITE_API_URL` 已含 `/api/yggdrasil` 则不再追加）。该路径既能返回元数据，又落在反代必然转发的 `/api` 前缀内，两种部署形态都成立。
    2. `src/server/app.ts` 增加别名挂载 `app.use('/api/yggdrasil/authserver', yggRouter)`：不同启动器拼法不同（有的拼 `/authenticate`，有的拼 `/authserver/authenticate`），多挂一个前缀让两种都命中，避免"填了官方给的地址还是连不上"。实测两者都返回真 accessToken。
    3. 新增 `web/.env.development`（`VITE_API_URL=http://localhost:3000`，只影响 `vite dev`）+ `web/.env.example` 文档化各环境取值 + `web/src/vite-env.d.ts` 声明 `VITE_API_URL`（顺带去掉原来的 `(import.meta as any)` 强转）。
  - **说明文案**（i18n 四语言各 3 条）：地址含义（是 `/api/yggdrasil` 元数据入口、不是页面地址，启动器会先取元数据再拼认证请求）、**线上部署前提**（域名下必须转发 `/api`；站点根被前端占用时勿用裸域名）、以及仅本地开发可见的提示。
  - **验收**：四语言 `profile` 段键集完全一致（各 115 键，零缺零多）；后端与前端 `tsc --noEmit` 均零错误；`npm run build` 通过；**生产构建内不含 `localhost:3000`**（`UserProfile` chunk 只剩 `window.location.origin`），dev server 注入 `VITE_API_URL: "http://localhost:3000"`；`GET /api/yggdrasil` 200 JSON、`POST /api/yggdrasil/{authenticate,authserver/authenticate}` 均返回 43 位 accessToken、`validate` 403（无效 token 的预期）、`hasJoined` 204、`/api/profiles/minecraft` 200；`npm test` 全开 **94 pass / 0 fail / 0 skipped**；无头截图（dev :5173，简中/英/日）确认地址与三行说明正常渲染。
  - **待处理（本轮未动）**：管理端 `SystemSettings.tsx` 有「站点 URL」字段（`base_url`，默认值硬编码 `http://localhost:3000`），但后端**从不读 `BASE_URL`** —— 该字段目前是死字段（存进 `system_settings` 无人消费）。要么接上（让它成为生成验证链接与认证服务器地址的权威来源），要么移除，需单独决策。

- 2026-09-24 P5 第二批：材质库披风搜索框 + 个人中心说明精简 + 站点设置「高度自定义首页」+ **修复站点设置整体失效**。
  - **披风库搜索框**：`web/src/pages/Library/SkinLibrary.tsx` 的 `CapeGrid` 补上与皮肤标签页同口径的搜索框（前端过滤当前页的 `id` / `name` / `description`），新增 i18n 键 `library.searchCapePlaceholder` 四语言。
  - **个人中心说明精简**：移除 `/profile` 上三行部署说明（`addressSourceNote` / `deployRequirement` / `devModeHint`）的渲染与对应 i18n 键（profile 段 115 → 112 键），相关内容只保留在本 README。
  - **站点设置「高度自定义首页」**：
    - 新增 4 个设置键：`SITE_LOGO`（顶栏站标）、`HOMEPAGE_CUSTOM_ENABLED`、`HOMEPAGE_CUSTOM_HTML`、`HOMEPAGE_CUSTOM_CSS`。
    - 管理端 `SiteSettings` 卡片顶部加总开关：**关闭** → 原版选项（站点标题 / 描述 / 标签页图标 / 顶栏站标 / 首页文案 / 额外按钮）；**开启** → Monaco HTML 编辑器 + CSS 编辑器（含「原样渲染」风险提示）。
    - 首页 `Landing.tsx`：开关开启**且** HTML 非空时，用自定义 HTML 替换**首页主体**（顶栏 TopNav 保留），CSS 注入整页；HTML 为空则仍显示原版首页（避免一脚踩空变全白）。
    - 顶栏 `TopNav.tsx` 硬编码的 "S" 方块改为读 `SITE_LOGO`（空则回退内置图标）；`siteStore` / `usePageTitle` 同步读取 `SITE_LOGO` 与 `SITE_FAVICON`。
    - 安全口径（用户决策）：**原样渲染、不做净化** —— 管理员即站长，与直接改站点模板等价；管理端与编辑器均有明确提示。
  - **顺带修复的阻断性缺陷（本轮最重要的发现）：站点设置整条链路是断的，保存后既不回显也不生效。**
    - 现象：管理端表单 `Form.Item name` 用的是 **snake_case**（`site_title` / `light_bg_image` / `smtp_host` …），后端 `setMany` 原样入库；而读取一律走 **SCREAMING_SNAKE_CASE**（`PUBLIC_SETTING_KEYS` 白名单 + 前端 `data.SITE_TITLE`）。实测写入小写键后 `getPublic()` 返回 `{}`、`data.SITE_FAVICON` 为 `undefined`。
    - 影响面：**5 个卡片全部失效** —— 注册设置 3 项、站点设置 6 项、主题设置 7 项、邮件设置 8 项、版权设置 2 项，共 26 个键。
    - 另外 `PUBLIC_SETTING_KEYS` 还漏了 `SITE_FAVICON` 与 4 个 `HOMEPAGE_*`：favicon 与首页文案即使键名写对也读不出来。
    - 逃逸原因：`tests/adminSettings.test.ts` 只用大写键断言，测的是后端，从未覆盖前端真实发出的键名 → 94 个测试全绿却漏掉。
    - 修复：前端 26 个表单键名统一为 `SCREAMING_SNAKE_CASE`（82 处替换）；白名单补齐 `SITE_FAVICON` / `SITE_LOGO` / 4 个 `HOMEPAGE_*` / 3 个 `HOMEPAGE_CUSTOM_*`，并在白名单上加注释说明「漏一个键 = 保存成功但读不回来」。
  - **新增防回归测试**（`tests/adminSettings.test.ts`）：
    1. 静态检查 —— 读 `SystemSettings.tsx` 提取全部 `name="..."`，断言必须全大写；同时断言访客可见键都在 `PUBLIC_SETTING_KEYS` 内。
    2. 端到端 —— 自定义首页 9 个键写入后经 `/api/settings/public` 保真回读（含布尔 `true`）。
  - **验收（数字均为实际输出）**：
    - `tsc --noEmit` 后端 + 前端均零错误；`vite build` 通过（21.77s）
    - `npm test`（仅 SQLite）：**96 tests / 81 pass / 0 fail / 15 skipped**（新增 2 项）
    - `TEST_DATABASE_URL` + `TEST_REDIS_URL` 全开：**96 tests / 96 pass / 0 fail / 0 skipped**
    - i18n：四语言叶子键各 **968** 个完全一致；代码引用的 **883** 个键零缺失
    - 端到端（真实 HTTP）：小写键 → public 返回空（**症状复现**）；大写键 11 项全部保真回读；开关开/关切换正常；`SITE_LOGO=/steve.png` 回读正确
    - 无头截图（dev :5173，简中）：首页自定义 HTML 与 CSS 生效且顶栏保留、管理端开关两种状态（开启时显示风险提示 + Monaco 带语法高亮的编辑器）、站标替换为自定义图片、披风库搜索框出现、个人中心三行说明消失
  - **附带发现（本轮未改，待决策）**：后端**从不读取任何站点设置键** —— `ALLOW_REGISTRATION` / `REQUIRE_EMAIL_VERIFICATION` / `ENABLE_CAPTCHA` 只出现在白名单里，没有任何业务调用点。因此注册开关、邮箱验证开关、验证码开关目前是**纯装饰**（存了也没人消费）。是否接线需单独决策。

- 2026-09-24 P5 第三批：**三个注册开关接线 + 站点地址双口径（`BASE_URL` / `PUBLIC_BASE_URL`）+ 邮件子系统（SMTP / 邮箱验证 / 密码重置）**。（承接第二批的两项遗留：开关是纯装饰、`BASE_URL` 是死字段。）
  - **先决策，再动手**（用户两轮确认）：验证码走**自托管数学题**（不引 Turnstile，本批未做）；邮箱验证做**完整实现**（含 SMTP、模板、令牌生命周期、页面）；`BASE_URL` 接上做「站点根」；`SMTP_PASS` **AES 加密入库**；**分两批**执行（批 1 = 地址 + 开关 + 邮件；批 2 = 验证码）。
  - **地址双口径（这是本批的核心概念，两个地址不能合并）**：

    | | 站点根 `BASE_URL` | 素材前缀 `PUBLIC_BASE_URL` |
    |---|---|---|
    | 权威来源 | **后台设置**（管理员换域名不该要求运维改 .env 重启） | **环境变量**（静态挂载点是部署形态的一部分：本地磁盘 / 将来 S3+CDN） |
    | 用途 | 邮件里的验证/重置链接、派生 `skinDomains` | 纹理等静态资源的对外 URL |
    | 未设置时 | 回落到 `PUBLIC_BASE_URL` 反推 / `http://localhost:3000` | 由站点根推导 `${origin}/uploads` |

    合并成一个字段就无法表达「站点 URL 是域名 A、资源由 CDN 域名 B 提供」这种真实形态。实现在 `src/site/siteUrl.ts`（`SiteUrlResolver`）。
  - **同步/异步的分工（关键设计）**：`StoragePort.publicUrl()` 是**同步**方法，被 Yggdrasil 纹理 builder 等大量同步路径调用，不可能为了读一次库改成 async。因此把「读设置」收敛到显式的 `refresh()`（结果写进进程内缓存，getter 同步读缓存），TTL 30s，且**管理端保存设置后主动 refresh** → 改完立即生效，TTL 只是兜底。
  - **`SiteUrlResolver.link()` 必须生成 HashRouter 形态**：`https://host/#/verify-email?token=xxx`。写成 `https://host/verify-email` 会被静态托管 404（那里只有 `index.html`）。
  - **三个开关（含硬 bug 修复）**：
    - 新增 `src/site/runtimeSettings.ts` 作为站设置的**运行期读取器**（一次性 `getAll()` + 30s 缓存），业务层不再直接碰键名字符串：`allowRegistration()` / `requireEmailVerification()` / `enableCaptcha()` / `siteTitle()` / `smtp()` / `mailTemplate()`。
    - **修复布尔形态歧义（真 bug）**：同一个开关可能是 AntD `Switch` 提交的**布尔** `false`、旧前端提交的**字符串** `'false'`、或手工 SQL 写入的 `1`。前后端原先都用 `data.X !== 'false'` 判断，布尔 `false` 会被判成 true → **「关掉注册后重新加载，开关又显示成开启」**，而库里其实存的是 `false`。这类 bug 不报错、只在界面上撒谎。现在前端 `web/src/utils/settingBool.ts` 与后端 `toSettingBool()` 是**唯一解析入口**，并有对拍测试逐项比对两侧结果。
    - 接线点：`POST /api/auth/register` 先查 `ALLOW_REGISTRATION`（false → **403 `REGISTRATION_DISABLED`**，且**不建号**）；`POST /api/auth/login` 传 `requireEmailVerified`（未验证 → **403 `EMAIL_NOT_VERIFIED`**，前端据此展示「重发验证邮件」）。检查点刻意放在**密码校验之后、签发令牌之前** —— 放前会让未持密码者探出「这个邮箱注册过但没验证」。
    - **开启邮箱验证但 SMTP 没配时会先预检并 502 拒绝注册**：宁可现在拒绝，也不要把用户建成「登不进去、也收不到验证信」的账号（那种账号既占邮箱又只能人工放行，是最糟的失败形态）。
    - 要求邮箱验证时注册**不签发会话**（`issueSession: false`，`RegisterResult.token` 因此改为可空）。
  - **邮件子系统（全新）**：
    - `src/util/secretBox.ts`：AES-256-GCM，密文格式 `enc:v1:<iv:b64>:<tag:b64>:<ct:b64>`，密钥来自 `MSCTS_SECRET`（sha256 拉伸）。带版本前缀是为了将来换算法能识别并迁移；**容错读取**：不带前缀的历史明文原样返回（否则升级一次 SMTP 就废了），只有格式正确但认证失败才抛错。
    - `src/mail/`：`MailPort` 窄端口（测试注入内存实现即可断言「注册后确实发了一封带验证链接的邮件」）→ `MailService`（渲染）→ `SmtpMailer`（nodemailer）。**transport 按配置指纹缓存**（口令只参与 sha256 指纹），避免管理员改一次 SMTP 就重建连接池。
    - 敏感值只在 **HTTP 边界**处理：`PUT /api/admin/settings` 明文 → 密文（`encryptIfNeeded`，重复提交同一密文不会二次套娃）；`GET` 把密文换成**空串 + `SMTP_PASS_SET` 布尔**（把密文回传给浏览器毫无用处，只会让密文跟着日志、截图、前端状态到处跑）。空串回传**不覆盖**库里的真值 —— 否则管理员改个别的字段保存一次，SMTP 密码就被静默清空。
    - `src/mail/templates.ts`：**内置模板以「占位符原文」形式保存**（管理端编辑器要拿带占位符的原文，拿渲染成品等于拿一封填好某个邮箱的样例邮件）。占位符 `{{EMAIL}}` / `{{VERIFY_URL}}` / `{{RESET_URL}}` / `{{SITE_TITLE}}` / `{{YEAR}}`；宽容规则：重置邮件里出现 `{{VERIFY_URL}}` 也填入重置链接（宁可给一个能用的链接，也不要寄出含字面占位符的死信）。
    - `src/account/emailFlow.ts`：一次性令牌的两条铁律 —— **明文只出现在邮件里**（库里只存 `sha256`，32 字节随机杜绝枚举）、**消费必须原子**（判定与置位写进同一条 `UPDATE ... WHERE used_at IS NULL AND expires_at > ? RETURNING`，避免邮件客户端预取链接 + 用户点击并发命中 → 同一个令牌改两次密码）。TTL：验证 30 分钟（与邮件文案绑定）、重置 1 小时。发新链接前**作废该用户同类旧令牌**（否则连点几次「重发」，历史邮件里的链接全部有效，攻击面只增不减）。
    - **防账号枚举**：`send-verification` / `send-reset-email` 无论邮箱是否注册都返回同一个 `{ ok: true }`；这两条免认证端点分别按**收件邮箱**、消费端点按**来源 IP** 限流。
    - **重置密码顺带完成邮箱验证**（同一事务）：能点开这封邮件就已证明邮箱归属，同时也是用户卡在「未验证」状态时的自救路径（管理员没配好 SMTP 时尤其重要）。改密后在事务外 `revokeAllForUser` —— 密码变了，旧凭据（含 Yggdrasil 令牌）必须立刻失效。
  - **新增端点**：

    | 端点 | 认证 | 说明 |
    |---|---|---|
    | `POST /api/auth/send-verification` | 可选 | 已登录按会话身份、匿名按请求体 `email` |
    | `POST /api/auth/verify-email` | 匿名 | 消费验证链接；成功即表示邮箱已验证 |
    | `POST /api/auth/send-reset-email` | 可选 | 同上口径 |
    | `POST /api/auth/reset-password` | 匿名 | 同时收 `token`/`code` 与 `password`/`newPassword`（旧前端字段名分歧只支持一个的表现是「提交没反应」，极难排查） |
    | `GET /api/me/email-status` | 需登录 | 个人中心展示邮箱与验证状态 |
    | `POST /api/admin/users/:id/send-verification` | 管理员 | 代用户重发（收不到信是常态） |
    | `PUT /api/admin/users/:id/verify-email` | 管理员 | 手动放行 / 收回（`{verified:false}`） |
    | `POST /api/admin/test-smtp` | 管理员 | **失败也回 200 + `{success:false}`** —— 这是诊断按钮，用 4xx/5xx 表达「连不上」会被前端 fetch 层压成通用报错，管理员就看不到「自签证书」「认证失败」这些真正有用的原因 |
    | `GET\|PUT /api/admin/email-template` | 管理员 | GET 未配置时返回**带占位符的**内置默认 + `isDefault` |
  - **前端**：新增 `AuthLayout`（五个认证页共用外壳）+ 三个页面 `VerifyEmail`（进入即自动提交，`ref` 加锁防 React 严格模式双提交）/ `ForgotPassword`（无论邮箱是否注册都显示「已发送」）/ `ResetPassword`（二次确认用 `dependencies` + validator）。`App.tsx` 里这三条路由**不随登录态重定向** —— 否则已登录用户从邮件链接回来会被弹回首页。`Login.tsx` 增加 `EMAIL_NOT_VERIFIED` 分支 + 重发弹窗 + 「忘记密码」入口；`UserProfile.tsx` 的找回密码改为**单步发链接**（删掉原来的验证码两段式表单）。
  - **顺带修复的四个真缺陷（都不在原始需求里，是实施过程中暴露的）**：
    1. **前端开关回读口径错**（如上）：`!== 'false'` 对布尔 `false` 判为 true。
    2. **管理端 `/api/admin/email-template`、`/api/admin/test-smtp` 后端根本不存在**，且适配层没有降级 → 必然是 404（改动前 `apiCompat` 里这两条路径没有任何处理）。
    3. **`compatFetch` 把任何 401 都当成「会话失效」**：认证流端点（验证/重置/发送）的 401 是**业务结果**（令牌无效/过期/已用），接管后 `handleAuthFailure()` 会改写 hash 到 `#/login` → **点一封过期邮件里的验证链接会被踢回登录页，页面上的「链接已过期」错误卡片根本没机会渲染**；已登录用户还会被顺手清掉会话。这个缺陷是**靠截图发现的**（错误页截出来是登录页）。修在 `apiCompat` 层（`BUSINESS_401_PATHS` 白名单），所有认证流页面同时受益。
    4. **`RuntimeSettings` 缓存与仓储返回的对象共享引用**：仓储返回的对象归它自己所有，直接持有引用意味着对方原地改值会穿透进本缓存的「只读快照」语义（表现为「TTL 还没到，读到的却已是新值」）。现在入缓存前拷贝一份。
  - **验收（数字均为实际输出）**：
    - `tsc --noEmit` 后端 + 前端均**零错误**；`vite build` 通过（15.97s），三个新页面各自独立分包（`VerifyEmail` / `ForgotPassword` / `ResetPassword`）。
    - `npm test`（仅 SQLite）：**152 tests / 136 pass / 0 fail / 16 skipped**（新增 4 个测试文件共 57 项）
    - `TEST_DATABASE_URL` + `TEST_REDIS_URL` 全开：**152 tests / 152 pass / 0 fail / 0 skipped**（连续 3 次复跑一致）
    - 新增测试：`tests/emailFlow.test.ts`（端到端 HTTP：开关 403、SMTP 未配 502 且不建号、注册不签发会话、邮件链接是 `origin/#/...` 形态、令牌只存 sha256、重复消费 401、过期令牌、防枚举、重置改密 + 顺带验证 + 吊销全部会话、弱密码不消耗令牌、管理端四个端点、模板默认值带占位符、`test-smtp` 失败仍 200、PG 方言令牌仓储全流程）；`tests/siteUrl.test.ts`（11 项）；`tests/secretBox.test.ts`（9 项）；`tests/runtimeSettings.test.ts`（含前后端 `settingBool` 逐项对拍）。
    - **修了一个测试自身的抖动**：`secretBox: 密文被篡改则认证失败` 原先篡改 base64 **末位**字符 —— 末位有若干比特只用于补位、不参与解码，改动它们得到的密文字节与原文完全相同，约 1/16 概率验签通过。改为篡改**段首**（必定参与解码）并补了 tag/IV 两个用例，连续 25 次复跑稳定通过。
    - **无头截图验收（生产构建 `vite preview` + 隔离实例，非 dev server）**：注册开关关闭 → 注册页显示「本站已关闭注册」且无表单；重新开启 → 完整表单（A/B 对照）。管理端「系统设置」：**库里存布尔 `false`，界面如实显示为「关」**（这正是修复前的 bug 表现）＋ 邮箱设置卡片上 SMTP 密码输入框显示「已设置，留空表示不修改」并带「已保存的密码以密文存储，不会回显」提示（即后端回 `SMTP_PASS=''` + `SMTP_PASS_SET=true`）＋ `SMTP 安全连接` 开关正确显示为「是」。验证链接页：无效令牌显示「邮箱验证失败 / 链接无效或已被清理，请重新获取」+ 「前往登录页重新发送」（修复 #3 前这里截出来是登录页）。另：忘记密码页、重置密码页、登录页（含「忘记密码」「立即注册」入口）均正常渲染，无 i18n 缺键。
  - **遗留 / 待决策（本批未做）**：
    1. **验证码（批 2）未开始**：`ENABLE_CAPTCHA` 目前只有读取器、**无校验调用点**；`/api/captcha/*` 的 `apiCompat` 降级（`{type:'none'}` / `{question:''}`）**保留中**，待批 2 摘除。批 2 需新迁移 `0003_captcha_challenges.sql` + 仓储 + 服务 + 路由 + 前端数学题组件。
    2. **前后端密码长度口径不一致（既有缺陷，未改）**：后端要求 **8-128** 位，而前端 `Register.tsx:317`、`SetupWizard.tsx:636` 的校验规则是 `min: 6`，文案也写「至少6位」（`auth.passwordMin` / `profile.enterNewPassword` / `profile.enterNewPasswordMin6` / `profile.passwordMinLength` / `setup.validation.passwordMin`，四语言共 20 处）。后果：用户填 6-7 位密码前端放行、后端拒绝（`VALIDATION_ERROR`）。修它涉及 4 语言 × 5 键 + 2 处规则，需单独确认后再动。
    3. **`web/src/i18n/locales/nul`**（Git Bash 重定向造出的垃圾文件，内容是一份 TCH 语系重复 JSON）：普通路径、`\\?\` 扩展路径的删除与改名**全部被拒（WinError 5）**，疑似被某个进程持有句柄，需在真实终端执行 `del \\?\G:\Skin2.catnight.top\MSCTS\web\src\i18n\locales\nul`。`.gitignore` 已含 `nul`，因此不影响提交与构建，仅为整洁。
    4. **Yggdrasil `POST /refresh` 仍未接限流**：按用户名计数会误伤 HMCL 的定期刷新，要接必须按 IP 计。
    5. **`tests/identity.test.ts` 的 PG 偶发失败未定位（既有问题，本批未动该文件）**：全量运行时 `identity: …（postgres）` 极低频失败（观测到 2 次，约 1/7 次全量），**隔离单跑 25/25 + 3/3 全过**，连续 5 次全量复跑也全过。已用实验排除两项：① **限流** —— 该测试构造的 `AppConfig` 不接 `TEST_REDIS_URL`，限流器是进程内独立的；② **设置经共享 PG 库泄漏** —— 该测试的依赖里**没有** `settings`/`runtimeSettings`，实测往共享 `mscts_smoke_test` 注入 `ALLOW_REGISTRATION=false` 后它仍 8/8 通过。剩余两个可疑点：① 该文件的 `join → hasJoined → profile/:uuid` 用例只断言 `join.status === 204`，**没有断言 `authenticate` 成功**就直接取 `session.selectedProfile!.id`，任何上游异常都会退化成 `TypeError` 而非可读的失败原因（诊断性缺口）；② `findActiveByServerId` 是 `ORDER BY created_at DESC LIMIT 1`，而 `hasJoined` 在「取到的会话名 ≠ 请求 username」时按协议返回 **204**，因此同一 `serverId` 若存在重复活跃会话，会**静默变成 204** 而不是报错。建议修法（改前请确认）：补 `authenticate` 断言 + 该用例的 `serverId` 按方言唯一化。与 `tests/mailpitSmtp.test.ts` 无关。

- 2026-09-24 P5 第三批补充：**接入便携 Mailpit，把邮件链路从「替身」升级为「真实 SMTP 端到端」**。（起因：第三批的邮件流程只用 `MemoryMailer` 替身跑过 —— `nodemailer` 的 transport 建连、AUTH、From 头拼装从未经过一次真实 SMTP 事务。）
  - `INDEV/mailpit/`（便携 Mailpit v1.31.2，Go 单文件，不入 git）：SMTP `127.0.0.1:10259` + Web UI/API `127.0.0.1:18025`，配 `start-mailpit.cmd` / `stop-mailpit.cmd` / `ping-mailpit.cmd`；详见 `INDEV/README.md`。
    - **下载通道**：本机 `github.com` 直连超时（5s 无响应），但 `api.github.com` 通 —— 所以 release 资产**不能**走 `browser_download_url`，改走 **API 资产端点**（`/repos/axllent/mailpit/releases/assets/<id>` + `Accept: application/octet-stream`），它 302 到可达的 `release-assets.githubusercontent.com`。
    - **UI 端口不能用 80259**：那是「上游默认 8025 追加 9」得到的，但 80259 > 65535 超出 16 位端口上限，Go 直接报 `listen tcp: address 80259: invalid port`、HTTP 端起不来。SMTP 侧 1025→10259 有效，UI 取 8025+10000=**18025**。
  - 新增 `tests/mailpitSmtp.test.ts`（8 项，门控 `TEST_SMTP_URL` + `TEST_SMTP_API_URL`，缺则整块 skip）：走真实 SMTP 事务，并把**对端收到的报文**从 Mailpit API 读回来断言 —— SMTP 握手 + AUTH、`"显示名" <地址>` 的 From 头、链接挂在站点根（刻意让 `BASE_URL` 与请求 host 不同，用请求 host 拼就过不了）、令牌只存 sha256、重复消费 401、防枚举（未知邮箱回 `{ok:true}` 但不发信）、弱密码被拒且不消耗令牌、模板占位符在真实报文里的替换结果（含未识别占位符原样保留）。`INDEV/run-tests.cmd` 探测到 18025 有响应才开门控（没起 Mailpit 则 skip，避免假警报）。
  - **实际投递核验**（隔离后端 :3100 + 独立 SQLite 库 + 真实 Mailpit，不碰开发环境的 :3000）：注册 → Mailpit 收到 3191 字节邮件（`From: "CatTavernSkins" <noreply@cattavern.local>`、`To: e2e-user@test.local`、主题「请验证你的邮箱」）；正文链接为 `http://localhost:3100/#/verify-email?token=…`（站点根 + HashRouter 形态，未混入素材前缀）；库内令牌与 `sha256(原文)` **逐字符一致**、TTL 恰好 30 分钟；验证 200 → 重复消费 401 `TOKEN_REVOKED` → 登录 200 且 `emailVerified:true`；重置邮件未知邮箱不发信、弱密码 400 后令牌**仍可用**、改密后新密码可登录 / 旧密码 401；`SMTP_PASS` 以 `enc:v1:` 密文入库、读回 `''` + `SMTP_PASS_SET=true`；`POST /api/admin/test-smtp` 真实握手 `{success:true}`；改邮件模板后**下一封真实报文**的主题与正文占位符全部替换、`{{NOPE}}` 原样保留。
  - 验收：`tsc --noEmit` 零错误；`npm test`（无门控）**160 tests / 136 pass / 0 fail / 24 skipped**；`TEST_DATABASE_URL` + `TEST_REDIS_URL` + `TEST_SMTP_URL` + `TEST_SMTP_API_URL` 全开 **160 tests / 160 pass / 0 fail / 0 skipped**（连续 5 次复跑一致）。
  - **已知边界**：`SMTP_SECURE=true`（隐式 TLS / 465）**未被真实链路覆盖** —— Mailpit 的 TLS 需另配 `--smtp-tls-cert/--smtp-tls-key` 证书对。

- 2026-09-24 P5 第四批：**用户名模式三态（单 / 多 / 待决定）+ 备用邮箱 + 交叉验证改邮箱 + 第三方登录预留端口**。（分 8 个子批 #44–#51 执行。）
  - **用户拍板的四点决策**：
    1. **冷却** —— 单用户名模式**沿用 MC 正版的 30 天改名冷却**，且「从预留口换上另一个 ID」本质就是改 ID，**与改名共用同一个窗口**；多用户名模式**无冷却**。
    2. **存量多角色用户** —— **下次登录时强制选一个**保留，其余转 `reserved`（数据与名字占位都保留，避免被抢注），选完不再弹。
    3. **改邮箱** —— 两枚邮箱**各自独立验证**（绑定时各验各的）；**交叉验证只在「要改其中一个邮箱」时启用**：新邮箱负责 verify、另一个邮箱负责 authorize、旧邮箱**只收通知且不阻塞流程**；单邮箱账号的授权方回落到当前主邮箱自己（否则死锁）。
    4. **第三方登录** —— **只做端口 + 指南**，不实现任何真实 provider；**电话/短信验证在路由/服务/DB/i18n 中一律不出现**。

  **迁移 0003**（`schema/{sqlite,postgresql}/0003_username_mode_and_backup_email.sql`）
  - `users` 加 `profile_mode`（'single'/'multi'）、`profile_mode_decided_at`（**NULL = 存量待选择**）、`mode_changed_at`、`backup_email`、`backup_email_verified`、`backup_email_verified_at`；`profiles` 加 `status`（'active'/'reserved'）、`status_changed_at`
  - 新索引 `users_backup_email_lower_uidx`（**部分唯一** `WHERE backup_email IS NOT NULL`，允许多行 NULL 共存）、`profiles_user_status_idx`
  - 新表三张：`backup_email_tokens`（带 `pending_email`，避免同一用户两次绑定串号）、`email_change_requests`（`target` 与 `authorize_via` **在创建时固定**，防中途换授权邮箱绕过交叉验证）、`email_change_tokens`（`role` = verify / authorize）
  - **顺带放开 `oauth_accounts.provider` 的 CHECK**（原为 `IN ('github','microsoft')`，会挡住 bilibili / QQ）。SQLite 不支持删 CHECK → 按「建新表 → 拷数据 → 换名」重建；PG 用 `DO $$` 动态查约束名再删
  - **迁移验证**走真实增量路径（一次性脚本，双方言各 15 项全过）：先在只有 0001+0002 的库上造「2 角色 / 1 角色 / 0 角色」三种用户 → 再单独应用 0003 → 断言回填（多角色用户必须留 `decided_at = NULL`）、枚举约束真的在拦、备用邮箱 `lower()` 唯一性生效且多行 NULL 共存、`bilibili` 可插入、三张新表可写、删用户级联清空、重复运行被 checksum 跳过

  **模式三态（`src/auth/identity.ts`）**
  - `MAX_PROFILES_PER_USER` 3 → **10**；新增 `SINGLE_MODE_ACTIVE_LIMIT = 1`。状态定义：`'single'`+已决定 = 1 个 active，改名与启用预留**共用同一个 30 天窗口**；`'multi'`+已决定 = 无冷却，active + reserved ≤ 10；任意模式 + **未决定** = 存量中间态，除「首次决定」外一切写操作抛 **409 `MODE_CHOICE_REQUIRED`**
  - **冷却基准 = 当前 active 角色的 `name_changed_at`**（不是 users 上的时间戳）—— 改名与「把预留角色搬进来」是同一件事的两种形式，共用一个窗口才成立
  - `PublicUser` 加 `profileMode` + `modeChoiceRequired`，**放在登录/注册响应里**：前端必须在拿到会话的那一刻就知道要不要弹选择框，否则会先看到角色列表再被迟到弹窗打断
  - `createProfile`：单模式直接拒（第 2 个 ID 只能来自「曾是多模式」，否则等于绕开窗口凭空多一个可用名字）；`renameProfile`：预留角色抛 **403 `PROFILE_RESERVED`**；`deleteProfile`：单模式不许删当前 active（删了就没有可用 ID 且恢复路径卡在冷却上 = 锁死），**删预留角色允许**（放弃占位、能力减少，不构成身份变更）
  - **多 → 单**：多于 1 个 active 时必须指定保留者，其余转预留，**并从此刻开始 30 天窗口**；冷却期内启用预留抛 **403 `MODE_COOLDOWN`**。**单 → 多**：不设冷却 —— 代价如实记录：可「切到多模式改名再切回」绕过 30 天窗口，这是两条产品规则叠加的必然结果（代码注释里写明；要堵就是让「单 → 多」也要求窗口已结束，一行判断）
  - 新方法 `getProfileModeState` 一并返回上限（`maxProfiles` / `activeLimit`），不让前端硬编码 10 / 1
  - **顺手修掉一个真实脆弱点**：P1 用 `name_changed_at === created_at` 表示「从未改名」（给初始名留一次免费改名），而**同一毫秒内改名会让两者相等 → 被判定成从未改名 → 免费改名重复发放、30 天窗口不启动**。新增 `identityChangeStamp()` 把时间戳抬到严格大于 `created_at`，让判定与时钟精度解耦；`singleModeCooldown` 里 `elapsed` 下限取 0
  - **Yggdrasil 侧**：`buildSession` 改 `listActiveByUserId`（`availableProfiles` 只列 active，否则启动器给出选了也 join 不进去的选项）；`profile/:uuid` 对 reserved 回 **204**（与「角色不存在」同一响应，避免暴露「这个 ID 被某人占着只是暂时没用」）；`POST /api/profiles/minecraft` reserved 不参与名字解析；`hasJoined` **刻意不加** status 检查（会话是加入时按当时 active 的角色登记的，30 秒 TTL 内改为 204 会把已进服玩家踢掉，害处大于收益）

  **备用邮箱 + 改邮箱流程（`src/account/emailChangeFlow.ts` 新，核心）**
  - 三条分工：绑定备用邮箱 = **独立验证**；变更任一邮箱 = **交叉验证**（新地址 verify + 另一个邮箱 authorize，**两枚都消费完才生效**）；被改掉的旧邮箱 = **只收通知、不需要操作、发失败也不阻塞**
  - 有效期：备用邮箱验证 30 分钟（与模板文案绑定）；改邮箱两枚令牌 **1 小时**（用户要分别打开两个邮箱，风险由「两枚令牌」承担，而非靠缩短有效期）
  - `assertAddressAvailable` 三条约束：不与自己的另一个槽位相同（「第一 / 第二邮箱不能相同」）、不是别人的主邮箱、不是别人的备用邮箱。**不靠唯一索引兜底** —— 索引抛的是数据库错误，用户看不懂
  - 变更完成后**不吊销会话**（与 `changePassword` 不同）：改密针对「密码已泄露」，改邮箱需要同时控制新旧两个地址，攻击者拿不到旧地址点不了授权链接，吊销只会让正常用户在流程结束时被踢下线
  - **并发死锁点与自愈**：两枚链接几乎同时被点开时，两个事务可能各自只看见自己那一枚已消费（未提交写入对对方不可见），双双判定「还差另一侧」→ 变更永不生效而两枚令牌都已作废。解决三件套：`tryFinalize()` 作为**幂等收敛点**（同一事务内 `claimChangeRequest` 抢占 + 写邮箱，崩在中间也不会留下「请求已完成但邮箱没改」的死状态）；`findChangeToken()` **允许已消费的令牌继续走流程**（第三次点击即可自愈，无需人工介入）；公开 `finalizePendingChange(userId)` 供前端等待页轮询
  - `requestChange` 的「请求 + 两枚令牌」放同一事务（只建请求不建令牌 = 永远点不动的状态），发信在事务外（SMTP 不参与事务、回滚退不回已发的信）；`removeBackupEmail` **只取消依赖该槽位的请求**（无差别取消会顺手干掉与备用邮箱无关、已完成一半的主邮箱变更）

  **仓储层**
  - `userRepository`：新列 + `findByBackupEmail` / `decideMode` / `setProfileMode` / `setBackupEmail` / `markBackupEmailVerified` / `clearBackupEmail` / `updateEmail`。**`decideMode` 用 `COALESCE(profile_mode_decided_at, ?)`** 保护首次决定时间（审计信息）；**`setBackupEmail` 强制把 `verified` 归零**（否则把备用邮箱从 A 改成 B 后，B 会在没收到任何信件的情况下继承 A 的已验证身份 —— 兜底通道等于可被任意改写）；`updateEmail` 一并把 `email_verified` 置真（新址已在同一流程里由 verify 令牌证明归属，不置真会让用户在开启邮箱验证的站点上自我锁死）；`purgeUser` 顺带清空 `backup_email*`
  - `profileRepository`：新 `ProfileStatus`；`listActiveByUserId` / `listReservedByUserId` / `countActiveByUserId` / `findFirstActiveByUserId` / `setStatus` / `setStatusForAllExcept`（多→单）/ `setStatusForAll`（单→多）/ **`markNameChanged(id, at)`**（只推进改名基准、不改名字 —— 「启用预留」也是身份变更，若走 `rename()` 会让「改名」出现在与改名无关的调用栈里）。`setStatusForAll*` 都带 `AND status <> ?` → **幂等，重复调用返回 0 且不动 `status_changed_at`**（避免时间戳失真）
  - `emailChangeRepository`（新，**独立拥有三张新表**，刻意不复用 `AccountTokenRepository` —— 那张表是扁平 6 列，装不下 `pending_email` / `request_id` / `role`）。`invalidateUnusedForRequest(requestId, role)` **按角色作废**（重发新地址那封不得连带干掉授权链接，否则永远凑不齐两枚令牌）；`claimChangeRequest(id, at)`（条件 UPDATE + RETURNING）是**邮箱变更落库的唯一仲裁点**；沿用铁律：只存 sha256、消费判定与置位写进同一条 UPDATE

  **邮件模板（`src/mail/`）**
  - `MailKind` 扩到 6 类：`verify` / `reset` / `backup_verify` / `change_verify` / `change_authorize` / `change_notice`；`defaultSubject` 与 `builtinTemplateHtml` 改成 `switch`（穷尽检查，新增 kind 忘写会编译报错）
  - 新增 `{{ACTION_URL}}`（中性动作链接名）、`{{OLD_EMAIL}}` / `{{NEW_EMAIL}}`；`VERIFY_URL` / `RESET_URL` / `ACTION_URL` 三者同值，沿用既有「宽容规则」。新增 `noticeShell()`：无 CTA 按钮的正文外壳（纯通知邮件里放按钮反而让人以为要点）
  - 新增 `CUSTOMIZABLE_MAIL_KINDS`：**只有 `verify` / `reset` 走管理端自定义模板**，0003 的四类只用内置正文 —— 它们是低频账号安全通知，为每个都加一套编辑器会把管理页撑成一屏十几个模板，收益只是措辞可改

  **新增端点**

  | 端点 | 认证 | 说明 |
  |---|---|---|
  | `GET /api/me/profile-mode` | 需登录 | 模式 / 是否待决定 / 上限 / 计数 / 冷却剩余天数 |
  | `POST /api/me/profile-mode` | 需登录 | 首次决定或切换（多→单带 `keepProfileId`） |
  | `POST /api/me/profiles/:id/activate` | 需登录 | 启用预留角色（冷却期内 403 `MODE_COOLDOWN`） |
  | `POST /api/me/backup-email` | 需登录 | 发起备用邮箱绑定（按收件邮箱限流） |
  | `POST /api/me/backup-email/verify` | 匿名 | 消费备用邮箱验证令牌（按来源 IP 限流） |
  | `DELETE /api/me/backup-email` | 需登录 | 解除备用邮箱（只取消依赖该槽位的请求） |
  | `POST /api/me/email-change` | 需登录 | 发起变更（`target` = primary / backup） |
  | `POST /api/me/email-change/confirm` | 匿名 | 消费 verify 或 authorize 令牌 |
  | `POST /api/me/email-change/finalize` | 需登录 | 收敛点，前端等待页轮询 |
  | `DELETE /api/me/email-change` | 需登录 | 取消进行中的变更 |

  **前端（沿用旧版界面设计，JSX 尽量少改）**
  - 新增 `web/src/services/accountSecurityService.ts`（类型 + 11 个方法）；`profileService` 的 `MsctsProfileRow` 加 `status` / `statusChangedAt`
  - `UserProfile.tsx`：**用户名模式卡片**（模式 Tag、可用 / 预留计数、冷却 Tag；**预留口区块只在「单模式 && 有预留角色」时渲染**，按钮在冷却期内灰置）、**邮箱行扩展**（主邮箱 + 备用邮箱 + 改邮箱入口 + 补兜底提示 + 进行中面板）、**三个新弹窗**（用户名模式：含「首次选择」强制分支与「保留哪一个 ID」单选；添加备用邮箱；改邮箱两步式向导）；新增 8 秒轮询 `finalizeEmailChange` 的 effect（遵守 `document.visibilityState`，切到后台不轮询）
  - **修掉两个由 0003 才暴露出来的前端缺陷**：① 新注册用户被显示成「改名冷却中：30 天后可再次改名」且改名输入框锁死 —— 前端 `getCooldownInfo()` 只做 `name_changed_at + 30 天` 的本地估算，区分不了「从未改名」与「刚改过名」（`name_changed_at` 在 INSERT 时就写了 `created_at`），0003 让单模式真正启用 30 天规则后这个幻觉变成实际锁死；改为**以后端 `GET /api/me/profile-mode` 为准**，旧估算仅在未接后端时兜底。② `primaryProfile` 原先取 `profiles[0]`，在存在预留角色时会取到预留角色 → 改为优先取 active
  - i18n 四语言 `profile` 段新增 **54 个键**（键集四语言完全一致），`common` 段补上原缺失的 `close`

  **批4-F：第三方登录预留端口（`src/account/oauth/`）**
  - 只提供**端口 + 注册表 + 4 个端点 + 一份接入指南**，**不落地任何真实 provider，也不落地回调** —— 缺 state 校验 / 邮箱可信度判定的 OAuth 回调可被伪造成登录，半成品比没有更危险。因此入口与回调**故意返回 501 `NOT_IMPLEMENTED`**，并在错误信息里指向指南路径
  - `OAuthProvider` 契约（`id` / `displayName` / `enabled` / `authorizeUrl` / `exchangeCode`）+ 模块级 `Map` 单例（`registerOAuthProvider` / `listOAuthProviders` / `findOAuthProvider` / `resetOAuthProviders`）；**契约刻意不含 `phone` 字段**
  - `advertiseProviderFlags()` **形状稳定**：即使一个 provider 都没注册，`{ github: false, microsoft: false }` 两键也照常出现 —— 响应形状刻意保持旧版形态，前端小格子无需改
  - 端点：`GET /api/auth/oauth/providers`（带 `Cache-Control: no-store`）、`GET /api/oauth/providers`、`GET /api/auth/oauth/:providerId`、`GET /api/auth/oauth/:providerId/callback`（**注册顺序必须排在 `/providers` 之后**，否则被路由参数吃掉）
  - **顺手修掉一个真缺陷**：前端 `apiCompat.ts` 原先**写死** `{ github: false, microsoft: false }`，导致「后端注册了 provider，前端小格子永远不出现」。改为**透传**（失败或非 2xx 才降级回全 false）
  - `docs/oauth-provider-guide.md`（7 节）：提供 / 不提供什么、**硬约束不做电话短信**、默认行为、最小接入步骤（实现 `OAuthProvider` → `registerOAuthProvider` → 自行挂真实入口 / 回调）、**为什么不实现回调**（含 `oauth_identities` 表示意 + 7 项检查清单）、让更多 provider 出现、文件索引 + `OAuthCallback.tsx` 死代码警告

  **批4-G：真实 SMTP 扩展（`tests/mailpitSmtp.test.ts` 8 → 12 项）**
  - 0003 的邮件链路原先只用 `MemoryMailer` 替身跑过，本批把新增的四类邮件也推进**真实 SMTP 事务**（对端报文从 Mailpit API 读回断言）
  - 新增 4 项：备用邮箱验证邮件真实投递（主题 / 链接 HashRouter 形态、令牌只存 sha256 且只能用一次、`email-status` 的 `hasVerifiedBackup` / `backupEmailRecommended` 翻转）；改邮箱（新址收确认信、备用邮箱收授权信、旧地址只收通知且**新地址只收到 1 封**、只点一枚 `completed:false` / 两枚齐 `completed:true`、旧邮箱不再能登录）；单邮箱回落授权（`authorizeVia:'primary'` + `fallbackToSelf:true`）；**自定义模板不得污染 0003 的四类邮件**（对 `verify` 改模板生效，`backup_verify` 仍用内置主题 / 正文）
  - **踩坑**：新用例初版全部 401「缺少 Bearer token」—— 根因是 HTTP 层已把服务的 `{token:{token,expiresAt}}` 摊平成**裸字符串**，测试里还在按 `body.token.token` 取

  **验收（数字均为实际输出）**
  - `npx tsc --noEmit` 后端 + 前端**均零错误**；`npm run build` 通过（24.85s）
  - `npm test`（仅 SQLite）：**177 tests / 146 pass / 0 fail / 31 skipped**
  - `TEST_DATABASE_URL` + `TEST_REDIS_URL` + `TEST_SMTP_URL` + `TEST_SMTP_API_URL` 全开：**177 tests / 177 pass / 0 fail / 0 skipped**
  - 新增测试文件：`tests/profileModeRepository.test.ts`、`tests/profileMode.test.ts`（服务层，可推进假钟）、`tests/emailChange.test.ts`（服务层）、`tests/oauth.test.ts`（6 项，假 provider 无网络）
  - **无头截图端到端验收**（当前代码 + 开发库副本（补跑 0003）+ 独立端口（后端 :3100 / 前端 :5273）+ 真实 Mailpit，**未触碰用户的 :3000 / :5173**）：6 张截图确认默认单用户名（冷却幻觉已消失）、多用户名「可用角色 3/10」且**无预留口**、切到单模式后预留口出现且两个按钮灰置、首次选择弹窗、改邮箱向导 + 进行中面板、新主邮箱与备用邮箱均「已验证」且无残留面板。端到端链路：注册 → 多角色 → 多→单（`reservedCount:2, cooldownDaysRemaining:30`）→ 绑备用邮箱（Mailpit 收到真信、抠令牌消费成功）→ 发起改邮箱（`authorizeVia:'backup'`、两封信投递到不同地址）→ 消费两枚（第一枚 `completed:false, waitingFor:'authorize'`；第二枚 `completed:true`）→ 通知信投递到**旧地址**
  - **截图脚手架的一个坑**：Edge `--screenshot --virtual-time-budget` 下 **CSS 入场动画不会推进**，AntD 弹窗永远停在 `ant-fade-appear-active`（opacity:0）→ 表现为「DOM 里有、画面上没有」。改用 **CDP**（`--remote-debugging-port` + 真机时间 + `Page.captureScreenshot`）才截到弹窗

  **遗留 / 待决策（本批未做）**
  1. **「单 → 多」可绕过 30 天窗口**（见上「代价如实记录」）：要堵是一行判断，需产品决策
  2. **第三方登录仍无任何真实实现**：4 个端点**故意 501**；`docs/oauth-provider-guide.md` 已给出接入契约与回调检查清单，落地需另行开工
  3. **`OAuthCallback.tsx` 是死代码**（旧前端遗留，指向尚未实现的回调），指南里已标注

## P5 第五批：数学题验证码（0004）+ 三项修正

### 四项决策（先说结论）

1. **验证码自托管，不接 Cloudflare Turnstile** —— 不引外部 JS、不把访客 IP 交给第三方。因此 `/api/captcha/captcha-type` **只可能返回 `'math'` 或 `'none'`，响应里不含 `siteKey`**（旧前端的 `turnstile` 分支永远走不到，但保留不影响）。
2. **出题端点必须有自己的一套限流参数**，不能复用认证端点的 5 次/5 分钟（理由见下「实测踩到的两个缺陷」）。
3. **`POST /refresh` 限流按来源 IP，不按用户名**（理由见下）。
4. **「单 → 多」绕过 30 天窗口不修** —— 是否堵由管理员按运营需要决定，本批不动。

### 迁移 0004（双方言）

`schema/sqlite/0004_captcha_challenges.sql` + `schema/postgresql/0004_captcha_challenges.sql`，单表 `captcha_challenges`：

| 列 | 说明 |
|---|---|
| `id` | 主键（PG 为 UUID） |
| `session_id` | **UNIQUE**；由**客户端**生成并持有，后端据此找回答案 |
| `answer_hash` | 答案的 sha256（**只为避免整表被 dump 时直接泄露，不是安全边界** —— 答案空间只有 0..100，字典一查就穿） |
| `expires_at` | TTL **10 分钟**（用户在页面挂载时就取题，可能要填一会儿才提交） |
| `used_at` | 非空即已消费 |

### 仓储 / 服务 / 路由

- `src/repositories/captchaRepository.ts`：`replace()`（**事务内先 DELETE 同 `session_id` 再 INSERT**，保证「同一 sessionId 只留最新一题」）、`findBySessionId()`、`consume(sessionId, at)`（原子 `WHERE session_id=? AND used_at IS NULL AND expires_at > ?` + `RETURNING`）、`deleteExpired(before)`、`countAll()`。时间列在 PG 上需 `::timestamptz` 绑参（沿用 `phAt(db.dialect, i)` 的写法）。
- `src/account/captcha.ts`：`generateQuestion()`（`+`：1..20 加 1..20；`-`：被减数 5..30 且差 ≥4，**不出负数**；`×`：2..9 乘 2..9）、`normalizeAnswer()`（容忍空白、前导零、`+` 号与 number 入参；拒绝小数与非数字）、`CaptchaService`（`generate()` 校验 sessionId → `replace()` → 顺带 `deleteExpired()`，清理失败只 warn；`verify()` **先消费再比对**）。
- `src/server/routes/captcha.ts`：
  - `GET /api/captcha/captcha-type` → `Cache-Control: no-store` + `{ type: enabled ? 'math' : 'none' }`
  - `GET /api/captcha/generate?sessionId=…`（**按 IP 限流**）→ 未注入服务时明确 **503 `CAPTCHA_UNAVAILABLE`**（不静默给空题目）

**验证码的三条硬规则**（都有测试兜着）：

1. `session_id` 由客户端提供，后端据此找回答案；同一 id 重新出题**覆盖**旧题。
2. **先消费再比对**：答错也把题烧掉 —— 否则可以拿一道题穷举 0..200 就猜中了。
3. 不存在 / 已用过 / 已过期 / 答案错，**统一回 `CAPTCHA_INVALID`**（不区分，避免成为探测预言机）。

### 接线（`identity.ts` / `app.ts` / `main.ts` / 前端）

- `identity.ts` 新增 `assertCaptcha(body)`，**放在 `register` 与 `login` 的最前面（早于密码校验）**：开关关闭 → 直接放行；开关打开但服务未注入 → **fail-closed** 抛 `CAPTCHA_INVALID`（绝不因为部署漏配而把闸门关掉）。
- 前端 `authService.ts` 的 `register` / `login` **原先只转发 `email/password/profileName`**，页面塞进 DTO 的 `captcha_session_id` / `captcha_answer` 被静默丢弃 → 现象是「开了验证码、答对也被拒」。本批补齐转发。

### 实测踩到的两个缺陷（都已修，都有回归测试）

用真实浏览器截图验收时才暴露出来的，服务层测试全绿也发现不了：

**缺陷 1：出题端点复用了 5 次/5 分钟的限流，正常用户几步就打满。**

取证：截图里题干是**空白输入框**。手工打满后确认是 429。真人路径「进页面取一题 → 答错点换一道 → React 严格模式下挂载被调用两次」即可耗尽；且限流按 IP 计，共用出口地址（宿舍 / 机房 NAT）下多人会互相误伤。

修复：新增 `DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT`（**10 次 / 5 分钟**），可用 `CAPTCHA_GENERATE_RATE_LIMIT_MAX` / `CAPTCHA_GENERATE_RATE_LIMIT_WINDOW_MS` 覆盖，**总开关仍是 `RATE_LIMIT_DISABLED`**（排障时关一处就该全关）。

**缺陷 2：出题失败在前端是「静默死路」。**

`loadCaptcha()` 不检查 `response.ok`，把 429 的**错误响应当成功解析**，`data.question` 为 `undefined` → 渲染成空白题干，用户填不出、也看不到任何提示；更外层还有两个帮凶：

- `apiCompat.ts` 把 `/api/captcha/*` 的非 2xx **包成合成的 200**（`json({ question: '' })`），调用方看到的 `ok` 永远是 `true`，后端那份「请等 258 秒后重试」的文案被彻底吞掉；
- 改用 `Form.Item` 的 `help` 插槽显示文案时，**文字确实进了 DOM 但 antd 的 explain 动效不落定**，截图里完全看不到（与批4 记录的「虚拟时间下 AntD 入场动画不推进」是同一类问题）。

修复三处：① `apiCompat` 对 `/api/captcha/*` 改为**完全透传**（连状态码一起交回，真·网络异常才降级 503）；② `Register.tsx` / `Login.tsx` / `loadCaptcha` 检查 `ok` 与 `data.question`，失败时置错误态；③ 错误文案改用**普通 `div` + 内联样式（零动效、必现）**，并在题目未就绪时**拦住提交**（否则只会换来一句笼统的「注册失败」）。

### 密码口径统一（前后端）

原先同一站内有**两套口径**：后端 `password.length < 8 || > 128`，前端注册 / 初始化 `min: 6`、改密码 `length < 6`、重置密码本地常量 `8`。新增 `web/src/utils/passwordPolicy.ts`（`MIN_PASSWORD_LENGTH = 8` / `MAX_PASSWORD_LENGTH = 128`），注册页、初始化向导、重置密码、个人中心改密码四处全部改为引用同一常量；i18n 四语言 20 处文案由「6 位」改为「8 位」，并**删掉死键 `profile.enterNewPasswordMin6`**（无任何代码引用）。

### `web/src/i18n/locales/nul` 生成问题（第二次，不再允许出现）

**根因**：`nul` 是 Windows 的 **DOS 保留设备名**，PowerShell 的 `>` 重定向（.NET 会补 `\\?\` 前缀绕过 Win32 设备名解析）会**真的**在磁盘上建出名为 `nul` 的文件。

**实测不可删**（排查过程已记在 `tests/repoHygiene.test.ts` 文件头）：`CreateFileW(path, DELETE)` 返回 `ACCESS_DENIED`（err=5）；与「进程占用」无关（`FILE_SHARE_NONE` 独占打开**成功**、Restart Manager `RmGetList` 返回 0）；与 ACL 无关（ACL 里用户有 `Modify`）。`del` / `rm` / `Remove-Item -LiteralPath` / `[IO.File]::Delete` / `\\?\Volume{…}\` 卷 GUID 路径 / `FILE_FLAG_POSIX_SEMANTICS` / `FileDispositionInfo(Ex)` / `MoveFileEx(DELAY_UNTIL_REBOOT)` **全部失败**。

**处理**：整目录 `renameSync` 移出项目 → `mkdirSync` 重建 → 复制 4 个语言 JSON 回来（**sha256 逐文件校验一致**），`nul` 留在仓库外的 `G:\Skin2.catnight.top\.junk-i18n\locales\`。

**防复发**：新增守卫测试 `tests/repoHygiene.test.ts`，扫描 `con/prn/aux/nul/com1-9/lpt1-9`（大小写不敏感、带扩展名也算，如 `nul.txt`），跳过 `node_modules/.git/dist/coverage/data/INDEV/.workbuddy/.junk-i18n`；排在两个测试脚本的**最前面**，一旦有人再生成这类文件，套件立刻红。

### Yggdrasil `POST /refresh` 限流

原先 `authenticate` / `signout` 有 5 次/5 分钟（按用户名），`refresh` **完全没接**限流。

新增 `DEFAULT_REFRESH_RATE_LIMIT`（**30 次 / 5 分钟**）+ `REFRESH_RATE_LIMIT_MAX` / `REFRESH_RATE_LIMIT_WINDOW_MS`，限流键 `mscts:rl:yggrefresh:<ip>`。

**为什么按 IP 不按用户名**：启动器（HMCL 等）会在 accessToken 临近过期时**自动定期刷新**，按账号计数等于把正常后台行为判成攻击，症状是「挂机一阵后突然掉线，重新登录又好」，而日志里只有一串 429 —— 事后极难归因。按 IP 只压「同一出口地址的高频刷新」。

**换前缀绕不过**：本 router 被挂到 4 个前缀（`/authserver`、`/api/yggdrasil`、`/`、`/api/yggdrasil/authserver`），但限流键只取客户端地址。

`resolveCaptchaGenerateRateLimit()` 与 `resolveRefreshRateLimit()` 都**从 `resolveRateLimit()` 取总开关**，保证 `RATE_LIMIT_DISABLED=true` 能一次关全，不会出现「关掉了限流但某个端点还在挡」。

### 新增 / 改动端点

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /api/captcha/captcha-type` | 匿名 | `{ type: 'math' \| 'none' }`，`Cache-Control: no-store`，**不含 siteKey** |
| `GET /api/captcha/generate` | 匿名 | 出题；**按来源 IP 限流**（默认 10 次/5 分钟）；未注入服务时 503 `CAPTCHA_UNAVAILABLE` |

### 验收（数字均为实际输出）

- `npx tsc --noEmit` 后端 + 前端**均零错误**；`cd web && npm run build` 通过（1m 2s，chunk 体积警告为既有）
- `npm test`（仅 SQLite）：**209 tests / 167 pass / 0 fail / 42 skipped**
- `TEST_DATABASE_URL` + `TEST_REDIS_URL` + `TEST_SMTP_URL` + `TEST_SMTP_API_URL` 全开：**209 tests / 209 pass / 0 fail / 0 skipped**
- i18n 四语言各 **1073** 键，键集完全一致
- 新增测试文件：`tests/captcha.test.ts`（24 项，双方言：题干自洽 / 答案规范化 / 一题一次 / 答错即烧 / 同 id 覆盖 / 过期 / 清理 / 开关接线 / fail-closed）、`tests/repoHygiene.test.ts`（1 项，保留设备名守卫）；`tests/cache.test.ts` 补 4 项（refresh 与出题限流的键形、第 N+1 次 429、未注入限流器时行为不变、默认值与总开关解析）

**真实开发环境端到端 + 截图验收**（后端 :3000 / 前端 :5173，均自行重启）

- 后端链路：注册 → 提权 → 登录 → `PUT /api/admin/settings {ENABLE_CAPTCHA:true}` → `captcha-type` 立刻变 `'math'`（**无需重启，运行时缓存已刷新**）→ 不带验证码注册 **400 `CAPTCHA_INVALID` 且不建号** → 出题（`2 × 5 = ?`）→ 带正确答案注册 **201** → **复用已消费的题登录 → 400**
- 截图 4 张（`G:/Skin2.catnight.top/.shots/`）：`11-register-captcha-ok.png`（题干 `16 + 6 = ?` 正常渲染、密码提示经 `--force-device-scale-factor=2` 放大后确认是**「密码至少8位」**）、`14-…`/`16-error-real-message.png`（限流后题干变 `—`、答案框禁用、**红色错误文案显示后端原文「验证码请求过于频繁，请在 258 秒后重试」**）、`17-login-captcha-error.png`（登录页同样生效）
- 收尾：清空 Redis 出题限流键、关闭 `ENABLE_CAPTCHA`、删除临时管理员与全部 `.tmp-*` 脚本；开发库 `captcha_challenges` 归零、无残留测试账号
- **本批未触碰 GitHub**（`git remote -v` 为空）

## P5 第六批：管理后台仪表盘统计（迁移 0005 + 两个端点）

### 起因：一句「管理后台的仪表盘没有数据反应」

诊断只做了一件事就定位了：**直连后端**。

```
$ curl -s http://localhost:3000/api/admin/stats
{"error":"NOT_FOUND","message":"路由不存在",...}
```

`src/server/routes/` 里 grep `stats` **零命中** —— 后端从来没有这两个端点。而前端的症状是「三张卡片有数字、四张折线图全空白」，这个**不一致本身就是线索**：`apiCompat.ts` 里躺着两处「降级替身」。

| 替身 | 它做了什么 | 后果 |
|---|---|---|
| `/api/admin/stats` | 前端拼三个接口：`/api/admin/users` 的 `total` + `/api/library?kind=skin` 的 `total` + 两次 `/api/admin/reviews` 的 `items.length` | 「皮肤总数」取的是**公开素材库**的计数（只含 `public` + `approved`），管理员看到的是「站上公开了几张皮」而不是「站里有多少张皮」（实测 1，实际 3）；`/api/admin/reviews` **不分页也不带总数**，用 `items.length` 当待审计数，数据一多就是错的 |
| `/api/admin/stats/daily` | **写死返回六个空数组**（注释原文「趋势接口无后端支持」） | 四张折线图永远没有点 |

**这不是渲染坏了，是真的没给数据。** 聚合就该在数据库里做一次，而不是拉几页数据在前端数。

### 三项决策（用户拍板）

1. **封禁趋势** —— 顺手把封禁功能一起做了（时间戳缺失，见下）。
2. **皮肤总数口径** —— **全部资产，含待审与被拒**（不是公开库那套 `public` + `approved`）。
3. **待审核趋势语义** —— **当日提交、至今未审**（状态口径，已知局限见下）。

### 迁移 0005（双方言）

`schema/{sqlite,postgresql}/0005_user_banned_at.sql`：`users` 加 `banned_at`（TEXT / TIMESTAMPTZ）+ 索引 `users_banned_at_idx`。

- **语义**：非空 = 当前处于封禁中，值为**本次下达时刻**；解封必须清空；重复封禁覆盖为最新一次。
- **允许 NULL（不回填）**：存量被禁账号没有可靠的下达时间，回填一个假值会污染趋势图 —— 图上凭空多出一根柱子比空着更糟。
- **封禁功能本身早就存在**（`PATCH /api/admin/users/:id` + `IdentityService.assertNotBanned` + 登录 403 `USER_BANNED`，链路一直是对的），缺的只是这枚时间戳。

### `src/repositories/statsRepository.ts`（新）

一条 SQL 出三个数（`overview()`），三条聚合 SQL 出趋势（`daily(days)`）：

| 口径 | 定义 | 类型 |
|---|---|---|
| `userCount` | `deleted_at IS NULL` 的用户数 | 状态 |
| `skinCount` | `kind = 'skin'` 的**全部**资产（含 private / pending / rejected） | 状态 |
| `pendingCount` | `review_status = 'pending'` 的资产数（含披风） | 状态 |
| `skinUploads` / `capeUploads` | 按 `created_at` 分日的上传数 | 事件 |
| `userRegistrations` | 按 `created_at` 分日的注册数 | 事件 |
| `pendingSubmissions` | 该日创建的资产中**当前仍为** `pending` 的数量 | 状态（见下） |
| `banCounts` | `banned_at IS NOT NULL` 的账号按 `banned_at` 分日 | 状态 |

**「历史事件」与「当前状态」两种口径刻意不统一**：

- `userRegistrations` 是事件口径 —— 注册后又注销的账号仍计入当天（历史事实不会因为后来发生的事而不再是事实）。
- `pendingSubmissions` 是状态口径 —— 一条资产被审核后，**它所在那一天的计数会下降**。这不是 bug，是「提交时不留流水」这一既有设计决定的（`asset_reviews` 只在管理员审核时插入行）。要变成历史口径，需要在提交时插一条 `status='pending'` 流水；本批不做，代码注释里写明了。
- `banCounts` 同理：解封后当天计数回落。这是有意的 —— 它的用途是「现在有多少账号处于封禁中、分别从哪天开始」，而不是「历史上封过多少次」。

**时区**：时间戳以 UTC 存储，但「某天」是给人看的。按 UTC 分桶会把北京时间 00:00–08:00 的活动算到**前一天**（管理员晚上提交的东西第二天早上显示在前天的柱子上）。分桶统一按 `STATS_TZ_OFFSET_MINUTES`（默认 `480` = UTC+8）平移后再取日期，`days` 数组用**同一偏移**生成。

三个方言细节都是踩过的：

- **SQLite**：`date(${col}, ?)` —— 修正符可绑参（实测 3.49 支持），`date()` 认带 `Z` 的 ISO 文本。
- **PostgreSQL**：`timestamptz + interval` **仍是 timestamptz**，不显式 `AT TIME ZONE 'UTC'` 就按**会话 TimeZone** 渲染 → 同一份数据在不同连接上可能落到不同日期。写法固定为 `to_char((col + ($1::interval)) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`。
- **补零必须在应用层做**：SQL 的 `GROUP BY` 天生不产出没有活动的日子，直接拿结果画图会让空日子整段消失、横轴被压缩。
- **`signedInt()` 而不是 `positiveInt()`**（`src/config.ts`）：时区偏移的 `0`（UTC）与负数（UTC-5）都合法，用正整数解析会把它们静默换成 `+480`，图表日期整体偏移一天且没有任何提示。越界值**裁剪**到 -720..840 而不是报错（为可配项让服务起不来不值当）。

### 新增端点

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /api/admin/stats` | admin+ | `{ userCount, skinCount, pendingCount }` |
| `GET /api/admin/stats/daily?days=7` | admin+ | 六个等长数组；`days` 越界/非法**裁剪**到 1..90 而不报 400（展示参数不值得让整块图表报错） |
| `PATCH /api/admin/users/:id` | admin+ | 既有端点，本批起额外写 `banned_at`（封禁写入 / 解封清空 / 重复封禁覆盖） |

两个 `stats` 端点**必须排在 `/api/admin/assets/:id` 之前**，否则 `stats` 会被当成素材 id。未注入统计仓储时返回 **501 `NOT_IMPLEMENTED`**（「接线口在这里」而不是 500「代码炸了」）。

### 前端（`web/src/utils/apiCompat.ts`）

删掉两处降级替身，`/api/admin/stats` 与 `/api/admin/stats/daily` 改为**完全透传**（含状态码）。同样把 `passthroughError` 用在非 2xx 上 —— 合成的 200 会把后端真实错误一起吞掉，这是本项目第二次栽在这上面（见第五批的验证码缺陷 2）。

### 验收（数字均为实际输出）

- `npx tsc --noEmit` 后端零错误；`cd web && npm run build`（`tsc --noEmit` + vite）通过，`✓ built in 15.62s`（chunk 体积警告为既有）
- `npm test`（仅 SQLite）：**243 tests / 185 pass / 0 fail / 58 skipped**
- `TEST_DATABASE_URL` + `TEST_REDIS_URL` + `TEST_SMTP_URL` + `TEST_SMTP_API_URL` 全开：**243 tests / 243 pass / 0 fail / 0 skipped**
- 新增测试：`tests/adminStats.test.ts`（18 项，含双方言：概览口径 / 空库全 0 / 六数组等长且日期连续 / 当天分桶不错位 / **时区边界（同一行在 UTC+8 与 UTC 下必须落在不同日期）** / `days` 裁剪 / 权限 / 未注入仓储报 501 / 仓储直调与端点结果一致）、`tests/adminBan.test.ts`（16 项，含双方言：迁移默认 NULL / 封禁写入 `banned_at` 并计入当天趋势 / 被封后登录 403 / 解封清空且计数回落 / 临时封禁到期自愈 / 过去时间被拒 / 不能封自己 / 普通用户 403 / 404 / **重复封禁覆盖时间戳（假钟精确断言）**）
- 真实开发环境（后端 :3000 / 前端 :5173）：`GET /api/admin/stats` → `{"userCount":6,"skinCount":3,"pendingCount":0}`（**`skinCount` 从错误口径的 1 变为 3**）；`?days=7` → `{"days":["2026-09-19",…,"2026-09-25"],"skinUploads":[0,0,0,0,1,2,0],"userRegistrations":[0,0,0,0,2,1,3],"pendingSubmissions":[0,0,0,0,0,0,0],"banCounts":[0,0,0,0,0,0,1]}`；无 token → 401
- 截图（`G:/Skin2.catnight.top/.shots/`）：`20-admin-dashboard-BEFORE.png`（卡片 4/1/0、**四张图全空白**）→ `21-admin-dashboard-AFTER.png`（卡片 5/3/0、图有线了）→ `22/23-admin-dashboard-*.png`（卡片 **6/3/0**；上传趋势 09-23→1、09-24→2；注册趋势 09-23→2、09-24→1、09-25→3；待审核趋势全 0 平线；**封禁趋势 09-25→1**）
- 收尾：删除临时注入页 `web/public/_shot-login.html`、临时脚本与凭证、Edge 截图 profile；删除本次验证造的测试账号（`devadmin-*` / `victim-*` / `victim2-*`）
- **本批未触碰 GitHub**（`git remote -v` 为空）

---

## P5 第七批：路由审计修复（#1–#5，主题图补后端 + 计数去毒）

### 起因：一次「还有哪个没做好路由」的反向审计

用探针页对同一路径**同时**打 `compatFetch`（前端唯一数据层）与原生 `fetch`，
两边一比即可分清「后端没有」与「被兼容层兜底」。审计确认了 8 处缺陷，
用户拍板先做前 5 项（第 6 项「删死代码」暂不做）。五项：

| # | 缺陷 | 表现 | 修法 |
|---|---|---|---|
| 1 | A 组兜底拦截 | `POST /api/admin/users/:id/send-verification` 与 `PUT …/verify-email` 后端早已实现，却被兼容层的 `/api/admin/` 前缀兜底拦成 501「敬请期待」——用户管理里两个按钮点了就是这句 | `ADMIN_PASSTHROUGH` 加 `'/api/admin/users/'`（**带尾斜杠是有意的**：不带会把用户列表也放过去，绕过它自己的翻译分支） |
| 2 | 主题图上传/移除 | 系统设置里 4 组背景图按钮调的 `/api/admin/upload-theme-image` 与 `/api/admin/theme-image/:type` **后端从来没有**；展示侧（`LIGHT_BG_IMAGE` 等键）却是通的，所以症状是「设置项能用、按钮没用」 | 新增 `src/site/themeImage.ts` + admin 路由两端点（见下） |
| 3 | 黑名单假页面 | `BlacklistManagement` 依赖的 `/api/admin/blacklist` 不存在，兼容层返回**假数据**（空数组 / 全 0 统计）→ 页面永远「暂无记录」，一个看起来正常、从不反映真实状态、也不报错的死页面 | 删兼容层假数据分支；侧栏摘掉「黑名单」页签；`BlacklistManagement.tsx` 保留不挂载，等后端补表 |
| 4 | 详情页下载绕过策略与计数 | `SkinDetail.tsx:105` / `CapeDetail.tsx:93` 直接 `fetch(skin.file_path)`：owner_only 素材拿到 file_path 就能下、`download_count` 永远是 0（后台「下载数」一列因此一直全是 0） | `handleDownload` 改为先 `GET /api/assets/:id/download`（校验 `download_policy` + 计数 +1）拿地址，再走 blob 下载（跨源时 `<a download>` 会被浏览器忽略，而存储已开 ACAO）；403 的后端文案直接展示 |
| 5 | 列表预取刷高浏览数 | 兼容层 `withPreviewUrl()` 对列表**每一项**调 `GET /api/assets/:id` 补图片地址，而那个端点会 `incrementViewCount` → 「翻一页列表 = 每项浏览数 +1」（实测一个皮肤被刷到 30，真实访问 0 次） | 列表接口直出 `previewUrl`（`LibraryService.withPreviewUrls`，**不含计数副作用**）；兼容层兜底改为「键存在就不再拉详情」——用 `'previewUrl' in item` 判断而不是「值非空」，因为 blob 缺失时值是 null，再拉一次还是 null，只会白刷计数 |

### 主题图服务（`src/site/themeImage.ts`，新）

- **不建新表**：键 → 值本来就在 `system_settings`（4 个键已在公开白名单），这里只做「字节写进存储 + URL 写进设置」。
- **上传即写设置**（`remove` 同理立刻清空）：按钮语义是「换背景」，写进表单还要再点一次「保存」等于「上传完了但没生效」。
- **objectKey 带内容哈希**（`theme/<type>-<sha12>.<ext>`）：同名复用会让浏览器继续用缓存旧图；上传/移除顺手删上一版（best-effort），不会越堆越多。**旧 key 必须在写设置之前取**——写完再读只会读到新值，「删上一版」永远删不到。
- **只收 PNG/JPEG/WebP/GIF 四种位图并核对 magic bytes**，明确拒绝 SVG：SVG 是同源可执行文档（可内嵌 `<script>`），被当背景图直接打开就是 XSS 面，而这里没有任何净化手段。
- 前端**发的是 FormData**、后端收的是 **raw 字节**（本项目不用 multer，见 `assets.ts`）。拆包放在兼容层而不是改 4 组上传组件：JSX 是验证过的资产，兼容层本来就是这个翻译层。拆完**原样透传状态码**（后端成功是 201）。

### 顺带修的装配层

- `GET /api/admin/assets`、`GET /api/admin/reviews`、`/api/me/assets` 三处列表**直出 previewUrl**；`createAssetRouter` 新增可选 `library` 依赖（不注入时前端退回逐项拉详情的兜底，但正式装配必须注入）。
- 列表直出后兼容层的 `ensurePreviewUrl` 正常情况下**一次网络请求都不发**——上面探针实测 `detailRequests=0`。

### 验收（数字均为实际输出）

- `npx tsc --noEmit` 后端零错误；`cd web && npx tsc --noEmit` 零错误
- `npm test`（仅 SQLite）：**280 tests / 204 pass / 0 fail / 76 skipped**；全开门控（PG+Redis+Mailpit）：**280 tests / 280 pass / 0 fail / 0 skipped**（基线 243 → 280）
- 新增测试：`tests/themeImage.test.ts`（25 项，双方言：四类型上传落盘并立刻写设置键 / 换图删上一版 / 同内容复用同 key / 拒 SVG 与「声明 PNG 实为 JPEG」/ 空内容与非法 type / 服务层大小闸 / 移除清键删文件幂等 / 外链设置键移除不炸 / 未注入服务 501）、`tests/listPreviewUrl.test.ts`（12 项，双方言：三个列表接口直出 previewUrl / **反复拉 3 轮列表 view_count 不动** / 详情接口仍然 +1 / 私有素材详情不计数）
- 真实环境（后端 :3000 已重启加载新代码，前端 :5173）：探针页实测 `themeUpload.status=201`、`themeRemove=200`、`sendVerification → 502 SMTP_ERROR`（**本实例未配 SMTP，报错文案如实**；不再是 501「敬请期待」）、`verifyEmail=200`、`adminSkins.detailRequests=0`（旧行为是每页 N 次）、`blacklist → 501`（假数据已删）；后端直连实测 `download_count +1`、owner_only 对他人 403、验证后计数已还原
- 截图（`G:/Skin2.catnight.top/.shots/`）：`24-admin-settings-theme-AFTER.png`（主题设置出现 `theme/light-bg-<sha12>.png` 与预览图 + 移除按钮）、`25-admin-skins-thumbnails.png`（缩略图直出，浏览/下载 30/0、0/0、0/0 无虚高）、`26-admin-users.png`（用户管理页正常，侧栏已无「黑名单」）
- 收尾：删除探针页 `_probe7.html`、注入页 `_shot7.html`、`vite.verify.config.ts`、`.wbscratch-e2e/` 与 Edge profile；删除临时账号（`probe-*`/`e2e-*`）；`data/uploads/theme/` 清空、`LIGHT_BG_IMAGE` 还原为空串
- **本批未触碰 GitHub**（`git remote -v` 为空）

---

## P5 第八批：站点图标/徽标支持上传（SVG 只给图标用）

### 起因：站点设置里「站点图标 / 顶栏徽标」只是两个手填 URL 的文本框

第七批把主题背景图做通了，但 `SITE_FAVICON` / `SITE_LOGO` 还是纯文本框 ——
想换图标得自己把文件塞进静态目录再手敲路径。本批把第七批的站点图片机制**推广**：
类型注册表从 4 个背景位扩到 6 个（`favicon → SITE_FAVICON`、`logo → SITE_LOGO`），
端点、兼容层、存储路径（`theme/` 前缀）全部复用，**零新增路由**。

### 三项决策（用户拍板，2026-09-25）

1. **SVG 只给站点图标用，4 组背景图一律拒收** —— 理由不是对称而是暴露面：
   背景图/内嵌图是拿来当**页面**用的（`open()` / CSS background 铺满视口），
   SVG 被当文档打开时内嵌 `<script>` 就执行；favicon/logo 是拿来当**资源**引用的
   （`<img src>` / `<link rel=icon>` 下脚本不执行），且上传者本就是管理员，
   手填外链 SVG 的效果一模一样 —— 拦它不减少风险，只损失功能。
2. **favicon 与 logo 格式集一致**：SVG / PNG / WebP / GIF / JPEG / ICO
   （ICO 同时收 `image/x-icon` 与别名 `image/vnd.microsoft.icon`）。
3. **手填直链保留**：文本框仍在；移除做智能判断 —— 值是本服务上传的
   `theme/…` 地址才删磁盘文件，外链直链只清设置键（`removed:false`）。

### 实现

- `src/site/themeImage.ts`：`TYPE_FORMATS` 按类型声明格式集（位图集 / 图标集），
  报错文案直接从格式集生成（两处不会漂移）；新增 SVG 判定
  （BOM/空白后以 `<?xml` / `<!DOCTYPE` / `<svg` 开头，**且前 1KB 内确实出现 `<svg`** ——
  防 HTML 冒充）与 ICO 魔数判定（`00 00 01 00`）。
- `admin.ts` 的 `raw()` 解析器白名单补 `image/svg+xml` 与两种 ICO MIME
  —— **解析器清单必须 ⊇ 服务层格式集**，否则图标上传会被解析层静默丢弃（`req.body` 为空），
  服务层只会报「上传内容为空」，看不出真原因。
- `SystemSettings.tsx`（SiteSettings 卡片）：两个图标字段各加「上传 / 移除」
  （`Input` 的 `addonAfter` 挂上传按钮，沿用主题图交互）+ 预览块
  （favicon 48×48、logo 最高 48px）；`uploadIcon` / `removeIcon` 两个小工厂
  避免复制 4 份 handler。上传成功即写设置键（与主题图同语义）+ 回填表单值。
- i18n：四语言补 6 个 key（uploaded/removed/preview ×2）并改写两个 tooltip。

### 验收（数字均为实际输出）

- `npx tsc --noEmit` 后端/前端各 0 错误
- `npm test`（仅 SQLite）：**286 tests / 207 pass / 0 fail / 79 skipped**；
  全开门控：**286 tests / 286 pass / 0 fail / 0 skipped**（themeImage.test.ts 25 → 31 项：
  六个图片位上传矩阵 / favicon·logo 收 SVG（`<?xml`、`<svg`、BOM、XHTML DOCTYPE 四种形态）
  / ICO 与别名 MIME / 背景位拒 SVG·ICO / HTML 冒充 SVG 拒 / 移除清键删文件 / 外链只清键）
- 真实环境（:3000 已重启）：SVG favicon 上传 201 → `SITE_FAVICON` 立刻可读 →
  换 ICO 时上一版 `.svg` 文件被删 → 外链移除 `removed:false` 且磁盘不动 →
  logo 移除 `removed:true` 文件消失；`data/uploads/theme/` 里用户已传的三张背景图全程未动
- 截图：`G:/Skin2.catnight.top/.shots/27-admin-site-icons.png`
  （两个图标字段带上传入口 + SVG 预览 + 移除按钮）
- 收尾：删除注入页 `_shot8.html`、`.wbscratch-icon/` 与 Edge profile、临时账号（`shot-*` 本批新建者）；
  验证用 favicon/logo 已移除（键清空、文件删除）
- **本批未触碰 GitHub**（`git remote -v` 为空）

---

## P5 第九批：登录/注册页与邮件通知使用 SITE_LOGO 徽标

**起因**：用户指出「登录页以及注册页呢？Logo不同步了吗？对应的是站点图标（顶栏徽标），邮件通知的话也得使用这个」——第八批做完的站点徽标只出现在顶栏，认证页与邮件没跟上。

### 落地（前端）

- `web/src/App.tsx`：根组件挂载时统一拉一次站点设置（`useSiteStore.loadSettings()`）。
  以前只有 Landing 会拉，**直达 `/#/login`、`/#/register` 时 logo/标题全是本地默认**——这是「不同步」的真正根因，顺手修复全站。
- `web/src/pages/Auth/Login.tsx` / `Register.tsx`：logo 区条件渲染——`SITE_LOGO` 有值显示
  `<img>`（与 `AuthLayout.tsx` 同款样式），无值回退原来的「S」方块，不留空档。

### 落地（邮件）

- `src/site/runtimeSettings.ts`：`siteLogoUrl()` 读 `SITE_LOGO`，**未设置返回空串**而不是默认值——没设徽标的正确表现是邮件里不出现那张图。
- `src/mail/templates.ts`：新增两个占位符
  - `{{SITE_LOGO}}`：URL 原文（未设置=空串）
  - `{{SITE_LOGO_IMG}}`：拼好的 `<img>` 标签（56px 高、`object-fit: contain`、全内联样式——收件端对 `<style>` 支持不完整）。**为什么要 IMG 变体**：`fillPlaceholders` 只做值替换、无条件块语法，裸写 `<img src="{{SITE_LOGO}}">` 在未设置时会渲染破图。
  - `shell()` 与 `noticeShell()` 两个外壳的 header（`<h1>` 之前）都加了 `{{SITE_LOGO_IMG}}` 行。
- `src/mail/mailService.ts`：`build()` 透传 `siteLogo`。
- `web/src/pages/Admin/SystemSettings.tsx`：默认模板字符串加 `${logoImgVar}`；占位符提示区加 `{{SITE_LOGO_IMG}}` chip；i18n 四语言 +1 key（`placeholderSiteLogoImg`）。

### 验收（数字均为实际输出）

- 后端 + 前端 `tsc --noEmit` 零错误（前端曾报 `logoImgVar` 未使用——默认模板里写成了 `\${...}` 转义字面量而非插值，已修）
- 基线 `npm test`（仅 SQLite）：**286 tests / 207 pass / 0 fail / 79 skipped**
- 全开门控 `TEST_DATABASE_URL` + `TEST_REDIS_URL` + `TEST_SMTP_URL` + `TEST_SMTP_API_URL` 跑 `npm run test:pg`：
  **286 tests / 286 pass / 0 fail / 0 skipped**（漏传 SMTP 两个变量时 12 项 mailpit 端到端会 skip，别漏）
- **后端(:3000)与前端(:5173)均已重启**（按约定双端重启，不依赖 HMR）
- 真实环境：上传测试 SVG → `SITE_LOGO` 生效 → `/#/login`、`/#/register` 截图均显示同一枚徽标
  （`G:/Skin2.catnight.top/.shots/28-batch9-login-logo.png`、`29-batch9-register-logo.png`）
- 邮件实测（Mailpit）：注册触发验证信，HTML 抬头恰 1 个 `<img src=".../theme/logo-*.svg">`，
  内联样式与 `siteLogoImg()` 一致；移除 logo 后重发同款信件 → **0 个 `<img>`**，`<h1>` 前为空白，无破图
- 收尾：测试账号 `logo-batch9@` 已注销、Mailpit 已清空、`REQUIRE_EMAIL_VERIFICATION` 已还原、
  验证用 logo 已移除（键清空、磁盘文件删除）、`.wbscratch-logo/` 已删；开发库 SMTP 指向 Mailpit 的配置保留（方便后续邮件验证）
- **本批未触碰 GitHub**（`git remote -v` 为空）

---

## P5 第十批：用户名模式切换收归超级管理员（等级 0/1 被动接受，管理面板代设）

**起因**：用户要求「用户名模式仅限等级 2 使用，1 以下的用户不可自由更改切换，只能被动接受改动，列入管理面板，不影响部分功能使用」。两项决策（用户拍板）：**代改权限仅超管**（等级 1 在面板也看不到入口）；**启用预留角色（换 ID）不在此限**，所有用户照旧可用（仍受 30 天冷却约束）。

### 规则矩阵

| 操作 | 等级 0/1 | 等级 2（super_admin） |
|---|---|---|
| `GET /api/me/profile-mode` 读状态 | 200（不受限） | 200 |
| `POST /api/me/profile-mode` 自切 | **403 FORBIDDEN** | 200 |
| `GET/PUT /api/admin/users/:id/profile-mode` | **403**（等级 1 也不行） | 200 |
| 启用预留角色 / 改名 | 照旧（30 天冷却） | 照旧 |

### 落地（后端）

- `src/server/routes/identity.ts`：`POST /api/me/profile-mode` 入口加超管门槛，非 super_admin → 403（错误文案「用户名模式仅超级管理员可自行切换，请联系超级管理员在管理后台调整」）；**GET 读取不设限**（个人中心仍显示当前模式）。
- `src/auth/identity.ts`：新增 `adminSetProfileMode(actor, targetId, {mode, keepProfileId})`——actor 必须超管；复用既有状态机（未决定→首决；已决定→切换），single↔multi 的预留/保留/30 天窗口副作用原样保留。
- `src/server/routes/admin.ts`：新增两端点（`auth + requireSuperAdmin`）：
  - `GET /api/admin/users/:id/profile-mode` → `{state, activeProfiles, reservedProfiles}`（弹窗渲染用）
  - `PUT /api/admin/users/:id/profile-mode` → 代设，返回 `{ok, state}`

### 落地（前端）

- `web/src/pages/Profile/UserProfile.tsx`：等级 <2 隐藏「切换为单/多用户名」按钮，改显只读提示（`profile.modeSuperOnlyHint`）；**首决弹窗不再对等级 <2 自动弹出**（`decisionRequired && user.level >= 2`）——存量未决定账号的首决改由超管在面板完成。预留口激活、改名等其他功能不动。
- `web/src/pages/Admin/UserManagement.tsx`：新增「用户名模式」列（模式 Tag + 仅超管可见的「调整」按钮）+ 代设弹窗（当前模式、single/multi 单选、切 single 且多角色时必须选保留谁）。
- `web/src/utils/apiCompat.ts`：`toLegacyUserRow` 补 `profile_mode` 字段。
- i18n 四语言：`profile.modeSuperOnlyHint` + `admin.profileMode*`（Adjust/Title/Current/Updated 等）共 7 key。

### 测试

- `tests/adminProfileMode.test.ts`（新，7 项双方言 14）：L0/L1 自切 403、L1 调面板端点 403、超管自切 200、超管代设含状态机副作用（single→multi→single、保留角色、窗口时间戳）、未决定用户代首决路径。
- `tests/emailChange.test.ts`：走 HTTP 的模式切换用例改为**先直库提权 super_admin 再调端点**（原以等级 0 身份自切，现会 403）。

### 验收（数字均为实际输出）

- 后端 + 前端 `tsc --noEmit` 零错误
- 基线 `npm test`（仅 SQLite）：**300 tests / 214 pass / 0 fail / 86 skipped**
- 全开门控（`TEST_DATABASE_URL` + `TEST_REDIS_URL` + `TEST_SMTP_URL` + `TEST_SMTP_API_URL`）`npm run test:pg`：**300 tests / 300 pass / 0 fail / 0 skipped**
- **后端(:3000)与前端(:5173)均已重启**（按约定双端重启，不依赖 HMR）
- 真实环境 curl 矩阵：tester1(L0) 读 200 / 自切 403；hmcl(L2) 自切 multi 200 → 回切 single 200；hmcl 代设 tester1 GET 200 → PUT multi 200 → PUT single 200（用户侧同步生效）；user2 临时提权 L1：用户列表 200（功能不受影响）、模式 GET/PUT/自切全 403，测毕已还原 `user`
- 无头截图 4 张（`G:/Skin2.catnight.top/.shots/`）：`30-batch10-tester1-profile.png`（只读提示、无切换按钮）、`31-batch10-hmcl-profile.png`（有「切换为多用户名」）、`32-batch10-admin-users.png`（模式列 + 调整按钮）、`33-batch10-admin-mode-modal.png`（代设弹窗：标题/当前模式/单选两项）。截图页均以 `--dump-dom` 文本级断言复核（切换按钮计数、提示文案、弹窗标题与正文）
- 备注：面板里超管对自己那行也有「调整」按钮（等价于其自切权限，无害）；软删除用户（`logo-batch9@`）在用户列表照旧显示（既有行为），其行同样有按钮——与「编辑角色」等既有操作口径一致
- **本批未触碰 GitHub**（`git remote -v` 为空）

---

## P5 第十一批：用户名模式改为全站统一设置（超管单页切换，影响全部账号 + 改名弹窗名称池）

**起因**：用户要求「模式不准单独调整，必须是影响全部账号，用户列表不显示这个东西、个人中心那个提示也无需再显示（没有任何义务告知，属于管理者决策）」，并追加三点：**改名弹窗里显示用户名池**（名下角色名可记录、随意使用）、**锁定 ID 对所有人显示被占用**（检测可用性/启动器都要报占用，即便启动也一样）、**多用户名模式下名称池可添加角色**。三项决策（用户拍板）：① 全局切 single 时多 ID 账号**下次进个人中心强制弹窗选保留 ID**（未选择前其余角色不锁定、写操作 409）；② 名称池**展示 + 切换启用**；③ **一并做添加角色**入口。

> 本批**推翻第十批**「按账号代设」与 0003「预留名不参与解析（防探测）」两处决策：模式从「每账号一个值 + 超管代设」收敛为「全站一个值 + 超管单页切换」；锁定名从「对外不可见」翻转为「对外一律报占用」。

### 规则矩阵

| 操作 | 普通/管理员（L0/L1） | 超管（L2） |
|---|---|---|
| `GET /api/me/profile-mode` 读自己状态 | 200 | 200 |
| `POST /api/me/profile-mode` | **仅当处于「待选择」态**时可用（提交保留 ID）；已决定 → **403**（个人无切换入口） | 同左 |
| `GET /api/admin/profile-mode` 全局模式 + 影响面统计 | 403 | 200 |
| `PUT /api/admin/profile-mode` 切换全站模式 | 403 | 200（影响全部账号） |
| 启用预留角色 / 改名 | 照旧（30 天冷却） | 照旧 |
| `POST /api/profiles/minecraft` 批量名称查询（匿名） | 锁定名**报占用**（推翻 0003） | 同左 |

### 落地（后端）

- `src/site/runtimeSettings.ts`：新键 `PROFILE_MODE`（`single`/`multi`，未设置默认 `single`）。
- `src/auth/identity.ts`：
  - 注入 `settings`（`Pick<SettingRepository,'get'|'setMany'>`）+ `readGlobalProfileMode()`（未接入设置存储时回退 `single`，保证测试可构造）。
  - **删** `decideInitialMode` / `switchMode` / `adminSetProfileMode` / `adminGetProfileMode`（第十批的按账号三件套）。
  - **新增** `decideKeepId({userId, keepProfileId})`：用户侧唯一保留的模式决策——全局切 single 后进「待选择」态的账号提交保留 ID（选定者留下，其余转预留并启动 30 天窗口）。已决定账号调用 → 403。
  - **新增** `getGlobalProfileMode(actor)` / `setGlobalProfileMode(actor, mode)`（均要求超管）。`setGlobalProfileMode`：先写设置（事实源）再 `syncProfileModeForAll` 刷副本；切 single 时 `markMultiActiveUndecided` 把多活跃 ID 账号置 `decided_at = NULL`。**幂等**（已是目标模式直接返回不迁移）。设置写入与副本迁移**故意不分同一事务**（跨仓库连接事务不可靠，失败重跑即收敛）。
  - 注册初值改读全局：`users.insert({ profileMode: await this.readGlobalProfileMode() })`。
- `src/repositories/userRepository.ts`：`insert` 增 `profileMode` 字段；新增 `syncProfileModeForAll(mode, at)` / `markMultiActiveUndecided(at)` / `countProfileModeStats()`（`totalUsers` / `multiActiveUsers` / `undecidedUsers`，供切换前确认弹窗）。
- `src/server/routes/admin.ts`：**删** `GET/PUT /api/admin/users/:id/profile-mode`；**新增** `GET/PUT /api/admin/profile-mode`（`auth + superAdmin`），GET 返回 `{mode, stats}`，PUT 返回 `{ok, mode, stats}`。
- `src/server/routes/identity.ts`：`POST /api/me/profile-mode` 收窄——去掉超管门槛与 `mode` 参数，改为「待选择态提交保留 ID」专用（`decideKeepId`），请求体仅 `keepProfileId`。
- `src/server/routes/yggdrasil.ts`：批量名称查询去掉 `status === 'active'` 过滤——**预留角色同样报占用**（0003 的防探测口径被用户拍板推翻；预留角色无会话，解析出 UUID 也无法进服务器，无安全影响）。

### 落地（前端）

- `web/src/pages/Admin/ProfileModeSettings.tsx`（新）+ `AdminDashboard.tsx`：侧栏新页签「用户名模式」（仅超管）——当前模式 Tag、影响面统计三卡（账号总数 / 多 ID 账号数 / 待选择账号数）、单/多单选、切 single 时的二次确认弹窗（列出受影响账号数）、`PUT` 后刷新。
- `web/src/pages/Admin/UserManagement.tsx`：**删**「用户名模式」列 + 代设弹窗 + 全部相关 state/函数 + `UserRecord.profile_mode`。
- `web/src/utils/apiCompat.ts`：`ADMIN_PASSTHROUGH` 放行 `/api/admin/profile-mode`；`toLegacyUserRow` 去掉 `profile_mode` 映射。
- `web/src/pages/Profile/UserProfile.tsx`：
  - 模式卡片：**删**切换按钮（所有人）与「由超级管理员管理」只读提示（图5），只读显示当前模式 + 说明。
  - 首决弹窗改**单用途**「选保留 ID」（对所有人生效，去掉模式单选与 pendingMode），`decisionRequired` 即自动弹出。
  - 改名弹窗新增「我的用户名池」区块：名下全部角色名 + 状态（使用中 / 锁定中，锁定项带冷却天数提示），multi 模式下显示「添加角色」输入框（`POST /api/profiles`，上限 10）。
- `web/src/services/accountSecurityService.ts`：`saveProfileMode(mode, keepProfileId)` → `decideKeepId(keepProfileId)`（去掉 mode 参数）；`web/src/services/profileService.ts`：新增 `createProfile(name)`。
- i18n 四语言：新增 `profile.poolTitle` / `poolInUse` / `poolLocked` / `poolAdd` / `poolAddPlaceholder` / `poolAddSuccess` / `poolAddFailed` / `poolCooldownHint` + `admin.profileModePageTitle` / `profileModeApply` / `profileModeConfirmToSingle` / `profileModeStat*`；删除 `profile.modeSuperOnlyHint` / `modeSwitchTitle` / `modeFirstChoice` / `modeFirstChoiceHint` / `modeKeepWhich` / `modeKeepHint` 与 `admin.profileMode*`（Adjust/Title/Current/Updated）。

### 测试

- `tests/adminProfileMode.test.ts`（重写，4 项双方言）：L0/L1 调全局端点 403、超管 GET 200 含统计、超管 PUT multi→single 全量迁移 + 多活跃账号进待选择 + 注册初值随全局、锁定名注册冲突回归（`NAME_TAKEN`）。
- `tests/profileMode.test.ts`（改写）：`decideInitialMode`/`switchMode` 用例全部改为 `decideKeepId` 语义（已决定者 403、待选择态提交保留 ID、multi 无冷却）。
- `tests/emailChange.test.ts`（改写）：HTTP 模式用例改为「待选择态提交保留 ID」路径（不再先提权 super_admin 自切）。

### 验收（数字均为实际输出）

- 后端 + 前端 `tsc --noEmit` 零错误（测试文件改写后亦全绿）
- 基线 `npm test`（仅 SQLite）：**294 tests / 211 pass / 0 fail / 83 skipped**
- 全开门控（`TEST_DATABASE_URL` + `TEST_REDIS_URL` + `TEST_SMTP_URL` + `TEST_SMTP_API_URL`）`npm run test:pg`：**294 tests / 294 pass / 0 fail / 0 skipped**
- 后端(:3000)与前端(:5173)重启后真实环境 curl 矩阵：hmcl(L2) GET 200 / PUT multi 200 → tester1(L0) 视角同步 multi / 加角色 201 / 新用户注册初值 multi；PUT single → tester1 进待选择 / 待选择中加角色 409 / 提交保留 ID 200（其余转预留 + 启动冷却）；**锁定名**匿名批量查询出现（报占用）/ 用锁定名注册 `NAME_TAKEN` / 冷却内启用 `MODE_COOLDOWN`。测毕已还原开发库（删临时角色/用户、清 `PROFILE_MODE` 键）
- 无头截图 4 张（`G:/Skin2.catnight.top/.shots/`）：`34-batch11-admin-modepage.png`（新页签 + 影响面统计 + 保存按钮）、`34-batch11-admin-users.png`（用户列表无模式列/无调整按钮）、`34-batch11-tester1-profile.png`（个人中心无切换按钮/无超管提示，只读模式卡）、`34-batch11-tester1-pool.png`（改名弹窗「我的用户名池」+ 使用中状态）。四张均以 `--dump-dom` 文本级断言复核
- 备注：「待选择」期间只拦**写操作**（新建/改名/删角色/启用预留 → 409 `MODE_CHOICE_REQUIRED`），读操作放行（前端要先能列出角色给用户选）；名称池「添加角色」在 single 模式下不显示（单模式无多 ID 语义，换 ID 走预留口）
- **本批未触碰 GitHub**（`git remote -v` 为空）

---


## 生产部署（域名类型）

前端是 SPA（构建产物 `web/dist`），后端是同一个 Express 服务。**推荐同域部署**（把 `web/dist` 交给反代静态托管，`/api` 与 `/uploads` 转给后端）；前后端分域也能跑，但要显式设 `VITE_API_URL`（见下）。

### 反向代理必须转发的路径

| 路径前缀 | 用途 | 必填 |
|---|---|---|
| `/api` | 业务接口 **以及全部 Yggdrasil 认证端点**（页面展示的认证服务器地址就在 `/api/yggdrasil` 之下） | **必需** |
| `/uploads` | 皮肤/披风纹理静态资源 | **必需**（否则皮肤不显示） |
| `/authserver`、`/sessionserver` | Yggdrasil 的兼容前缀。页面已不再展示带这些前缀的地址，保留转发只为兼容**已按旧地址添加过账号**的启动器 | 建议 |

Nginx / OpenResty 参考写法（**未在本仓库实测**，按你实际的反代改）：

```nginx
# 前端：托管 web/dist；HashRouter 的文档入口是 /，SPA 需回落到 index.html
root /path/to/MSCTS/web/dist;
location / {
    try_files $uri $uri/ /index.html;
}

# 后端：业务接口 + Yggdrasil 认证 + 纹理（务必带 XFF，否则限流按 IP 的端点会失真）
location ~ ^/(api|uploads)/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### 与服务端环境变量相关的注意点

1. **`TRUST_PROXY`**：上面的配置带了 `X-Forwarded-For`，后端要设 `TRUST_PROXY=1`（或反代层数）才会采信，否则 `req.ip` 拿到的是**反代自身地址** → 按 IP 限流的注册端点会把所有用户算进同一个桶。反过来，**没有可信反代却开了 `TRUST_PROXY`**，客户端就能伪造 XFF 绕过限流。两者都要避免。
2. **`MSCTS_SECRET`（P5 第三批新增，生产必配）**：站点设置里 `SMTP_PASS` 的主密钥（AES-256-GCM）。**未设置时口令按明文落库**并打印一条 warn —— 功能可用但等于裸奔。至少 16 个字符，建议与 `.env` 同权限保管；**轮换主密钥后旧密文无法解密**（`decrypt` 会抛「密文解密失败」而不是静默返回空口令，这是刻意的：静默降级只会让人以为 SMTP 坏了）。
3. **`PUBLIC_BASE_URL` 与 `YGGDRASIL_SKIN_DOMAINS`**：`PUBLIC_BASE_URL` 是**素材前缀**（纹理对外 URL，如 `https://<域名>/uploads`），不是站点根；`YGGDRASIL_SKIN_DOMAINS` 留空时由**站点根**的 hostname 派生（站点根来自后台设置 `BASE_URL`，不再是本变量）。这两个都是环境变量，不是后台设置项。
4. **`SMTP_ALLOW_SELF_SIGNED=true`**（可选）：允许 SMTP 服务端使用自签证书（内网邮件网关常见）。缺省关闭，因为放行自签证书会让中间人攻击变简单。
5. **`BASE_URL`（后台设置，不是环境变量）**：站点根，是**邮件里验证/重置链接的权威来源**，也用于派生 `skinDomains`。必须填成用户实际访问的地址（`https://<域名>`，不要带路径）。漏填的后果是邮件链接指向 `http://localhost:3000`，用户点了必然打不开 —— 管理端该字段的默认值已改为「管理员当前访问的地址」，就是为了避开这个坑。

### 「认证服务器地址」是怎么算出来的（个人中心那张卡片）

代码在 `web/src/pages/Profile/UserProfile.tsx`：

```
显示值 = (VITE_API_URL || window.location.origin) + '/api/yggdrasil'
```

**为什么一定要带 `/api/yggdrasil` 这一段**：启动器拿到地址后先 `GET <地址>` 取元数据 JSON。生产部署里站点根路径 `/` 被 SPA 占用（HashRouter 的文档入口就是 `/`），`GET /` 返回 `index.html`，启动器会判定"这不是认证服务器"。而 `/api/yggdrasil` 既能返回元数据，又落在反代必然转发的 `/api` 前缀内 —— 所以**裸域名不能当认证服务器地址**（本地之所以看起来能用，是因为本地没有 SPA 占用根路径）。

| 部署形态 | `VITE_API_URL` | 页面显示 |
|---|---|---|
| **同域部署（推荐）** | 留空 | `https://<域名>/api/yggdrasil` |
| **前后端分域 / 前端只做静态托管** | `https://<后端可达地址>` | `https://<后端>/api/yggdrasil` |
| **本地开发** | `web/.env.development` 已设为 `http://localhost:3000` | `http://localhost:3000/api/yggdrasil` |

> ⚠️ 不要用前端开发服务器端口（5173）当认证服务器地址：实测 `GET /` 返回 HTML、`POST /authenticate` 404，启动器无法识别；且启动器按地址区分账号，同一后端用 5173 与 3000 添加会被视为两台不同服务器。

### 构建与启动

```bash
# 前端
cd web && npm ci && npm run build        # 产物在 web/dist，交给反代静态托管

# 后端
npm ci
npm run migrate                            # 迁移失败会拒绝启动（蓝图 §5.1）
DB_TYPE=postgres DATABASE_URL=... node --import tsx src/server/main.ts
```

- 数据库：生产用 `DB_TYPE=postgres` + `DATABASE_URL`（SQLite 仅适合单机小规模）
- 健康检查：`/health/live`（进程存活）、`/health/ready`（数据库 + 存储探针）
- **可选依赖全部关闭可用**：不配 `REDIS_URL` 时限流与缓存降级为进程内存实现、进程照常启动；但**多实例部署必须配 Redis**，否则限流退化为「每实例各限一份」（放行量 = 阈值 × 实例数）
- 环境变量完整清单见仓库根 `.env.example`，前端变量见 `web/.env.example`

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
