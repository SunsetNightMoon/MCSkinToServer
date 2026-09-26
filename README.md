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

### 与服务端环境变量相关的两个注意点

1. **`TRUST_PROXY`**：上面的配置带了 `X-Forwarded-For`，后端要设 `TRUST_PROXY=1`（或反代层数）才会采信，否则 `req.ip` 拿到的是**反代自身地址** → 按 IP 限流的注册端点会把所有用户算进同一个桶。反过来，**没有可信反代却开了 `TRUST_PROXY`**，客户端就能伪造 XFF 绕过限流。两者都要避免。
2. **`PUBLIC_BASE_URL` 与 `YGGDRASIL_SKIN_DOMAINS`**：`PUBLIC_BASE_URL` 决定纹理对外 URL 的前缀（本地默认 `http://localhost:3000/uploads`，生产必须改成 `https://<你的域名>/uploads`）；`YGGDRASIL_SKIN_DOMAINS` 留空时回落到 `PUBLIC_BASE_URL` 的 hostname。这两个都是**环境变量**，不是后台设置项。

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
