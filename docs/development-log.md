# 开发实施日志

本文件是 MCSTS 重制的按批次实施记录（原 README「实施进度」全量迁于此，内容未删改）。
各批验收数字均为当时的实际输出。当前进展概要见 README。

---

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
  - HMCL「外置登录」对接 MCSTS 成功（认证服务器 `http://localhost:3000`，注册/登录/角色全链路真机验证）。
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
  - `web/`：vite 6（端口 5173，代理 /api、/uploads、/authserver、/sessionserver → localhost:3000）+ antd 5.29 + zustand 5（persist key `mcsts-auth`）+ react-router-dom 6（HashRouter）+ dayjs。
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
  - 主题系统：暗色默认（深蓝星空背景 starfield + 玻璃拟态卡片 + #4a9eff 强调）↔ 亮色（#2563eb），AntD darkAlgorithm/defaultAlgorithm + CSS 变量 + body[data-theme]，zustand persist key `mcsts-site`。
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
- 2026-09-23 P4 第六批：整包搬入旧版界面套件，用适配层桥接 MCSTS 后端。
  - 用户判定自研界面套件「漏洞非常多」，明确要求直接复用旧版界面。做法改为：把 plan3 的 22 个页面 + 组件 + i18n + store 整体拷入，**页面 JSX 一字未改**，只换数据层。
  - 新增 `web/src/utils/apiCompat.ts` 作为唯一翻译层：页面首行 `import { compatFetch as fetch } from "../../utils/apiCompat"`，由它完成旧版路径 → MCSTS 端点映射、请求/响应 snake_case ⇄ camelCase 翻译、以及无对应端点时的降级返回。
  - `store/authStore.ts` 用 `roleToLevel()` 把后端的 `user.role` 映射成旧页面直接用的 `user.level`，使 `/admin` 的 `user.level >= 1` 判断原样可用；`api.ts` 修正为 403 不再误判为登录失效。
  - `store/siteStore.ts` 去掉 `/api/settings/public` 依赖改用本地默认值，persist key `mcsts-site`。
  - 路由改 HashRouter（部署免重写规则），移除 MCSTS 无后端支持的 /setup 与 /oauth-success 路由（页面文件保留不挂载）。
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
    - 无头浏览器对**生产构建**（`vite preview` :4173）截图复核：首页、登录、素材库、衣柜（3D 模型 + 绿色「已应用」标签）、管理后台（recharts 图例渲染，趋势图空白为 MCSTS 空序列的已知降级）均正常。
  - **顺带修复：错误提示全部退化成通用文案**
    - 旧版（plan3）Web 接口错误体是 `{ error, errorMessage }`，移植过来的前端有 20+ 处按 `data.errorMessage` 取文案；MCSTS 只返回 `{ error, message }` → 全部落到 `|| t('...操作失败')` 兜底，用户看不到「密码不正确」等真实原因。
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
    - 端到端实测（后端连真实 Redis 63799）：启动日志 `[cache] 已连接 Redis`；`AUTH_RATE_LIMIT_MAX=3` 下连续错误登录前 3 次 401、第 4 次起 429 + `Retry-After: 54` + `retryAfterSeconds`；`redis-cli keys 'mcsts:*'` 可见 `mcsts:rl:login:…` 与 `mcsts:cache:settings:public`（PTTL≈30s，与 `SETTINGS_CACHE_TTL_MS` 一致），客户端信息显示 `lib-name=node-redis`、`cmd=eval`（确认走 Lua 脚本）；管理端 PUT 设置后缓存键被删除（`exists` 1→0）且公开端点立即返回新值。
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
    - `src/util/secretBox.ts`：AES-256-GCM，密文格式 `enc:v1:<iv:b64>:<tag:b64>:<ct:b64>`，密钥来自 `MCSTS_SECRET`（sha256 拉伸）。带版本前缀是为了将来换算法能识别并迁移；**容错读取**：不带前缀的历史明文原样返回（否则升级一次 SMTP 就废了），只有格式正确但认证失败才抛错。
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
    3. **`web/src/i18n/locales/nul`**（Git Bash 重定向造出的垃圾文件，内容是一份 TCH 语系重复 JSON）：普通路径、`\\?\` 扩展路径的删除与改名**全部被拒（WinError 5）**，疑似被某个进程持有句柄，需在真实终端执行 `del \\?\G:\Skin2.catnight.top\MSCTS\web\src\i18n\locales\nul`（此处 `MSCTS` 是磁盘目录名，不随项目缩写改名）。`.gitignore` 已含 `nul`，因此不影响提交与构建，仅为整洁。
    4. **Yggdrasil `POST /refresh` 仍未接限流**：按用户名计数会误伤 HMCL 的定期刷新，要接必须按 IP 计。
    5. **`tests/identity.test.ts` 的 PG 偶发失败未定位（既有问题，本批未动该文件）**：全量运行时 `identity: …（postgres）` 极低频失败（观测到 2 次，约 1/7 次全量），**隔离单跑 25/25 + 3/3 全过**，连续 5 次全量复跑也全过。已用实验排除两项：① **限流** —— 该测试构造的 `AppConfig` 不接 `TEST_REDIS_URL`，限流器是进程内独立的；② **设置经共享 PG 库泄漏** —— 该测试的依赖里**没有** `settings`/`runtimeSettings`，实测往共享 `mcsts_smoke_test` 注入 `ALLOW_REGISTRATION=false` 后它仍 8/8 通过。剩余两个可疑点：① 该文件的 `join → hasJoined → profile/:uuid` 用例只断言 `join.status === 204`，**没有断言 `authenticate` 成功**就直接取 `session.selectedProfile!.id`，任何上游异常都会退化成 `TypeError` 而非可读的失败原因（诊断性缺口）；② `findActiveByServerId` 是 `ORDER BY created_at DESC LIMIT 1`，而 `hasJoined` 在「取到的会话名 ≠ 请求 username」时按协议返回 **204**，因此同一 `serverId` 若存在重复活跃会话，会**静默变成 204** 而不是报错。建议修法（改前请确认）：补 `authenticate` 断言 + 该用例的 `serverId` 按方言唯一化。与 `tests/mailpitSmtp.test.ts` 无关。

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
  - 新增 `web/src/services/accountSecurityService.ts`（类型 + 11 个方法）；`profileService` 的 `McstsProfileRow` 加 `status` / `statusChangedAt`
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

新增 `DEFAULT_REFRESH_RATE_LIMIT`（**30 次 / 5 分钟**）+ `REFRESH_RATE_LIMIT_MAX` / `REFRESH_RATE_LIMIT_WINDOW_MS`，限流键 `mcsts:rl:yggrefresh:<ip>`。

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

## P5 第十二批：安装向导（沿用旧版 OOBE 界面 + 安装分流 + 库类型锁定 + 默认语言）

**起因**：用户复述硬要求 ——「沿用旧版的安装向导；数据库选择一旦完成不可更改；确保实际可通过向导指定数据库（SQLite / PostgreSQL，MySQL 不支持）；添加语言选择作为站点默认显示语言（兼容多语言玩家）」。本批曾做到一半因故中断（后查明为 Node 双运行时导致 better-sqlite3 ABI 不匹配 + 探针页缺 React Refresh preamble），代码收进 stash 备份后于同日恢复并完成。

### 规则矩阵

| 场景 | 判定 | 行为 |
|---|---|---|
| 无 `data/setup.json` + 无存量库文件 | `installing` | 不连库不迁移，只起最小应用（`/api/setup/*` + `/health`），业务 API 一律 403 `SETUP_REQUIRED` |
| 无 `setup.json` 但 SQLite 文件已有内容 / env 配了 `DB_TYPE=postgres` | `auto` | 照常迁移，启动后按现状**补写** `setup.json`（`source:"auto"`），存量环境不打回重装 |
| 有 `setup.json` | `installed` | 正常模式；**库类型以记录为准**，env 改 `DB_TYPE` 无效（`DATABASE_URL` 仍可临时覆盖连接串） |
| 装完再调 `POST /api/setup/complete` | — | 403（不可更改）；正常模式下 complete 路由整体摘除（404） |

### 落地（后端）

- `src/setup/setupState.ts`（新）：`setup.json` 读写 + 结构校验（`version/db.type/sqlitePath|pg/defaultLanguage/redis/source`）。
- `src/setup/setupService.ts`（新）：`testDbConnection`（PG 真连一遍；MySQL 明确拒绝）、`testRedis`、`testEmail`、`completeSetup`（校验管理员输入 → 现场连目标库 → 跑全量迁移 → 单事务建超管+默认角色 → 写站点设置（`SITE_TITLE`/`DEFAULT_LANGUAGE`）与 `setup.json`）；`recordExistingEnvironment`（auto 补写）。**建超管不走 `IdentityService.register`**（安装期无 token/限流/全局模式，直接按 register 的字段语义落库）。
- `src/server/setupApp.ts` + `src/server/routes/setup.ts`（新）：安装模式最小应用（JSON body 解析 + 限宽 + 错误映射）；端点 `GET /api/setup/status`、`POST /api/setup/{test-db,test-redis,test-email,complete}`（全部匿名 + 限流）。
- `src/config.ts`：`installMode` 三分流 + `envRedisUrl`（向导里选了 Redis 则从 `setup.json` 派生连接串，env 显式值优先）；`src/errors.ts`：`SETUP_REQUIRED`→403（403 而非 503：「服务器是好的，只是还没装」对前端可行动）。
- `src/server/app.ts`：正常模式下也提供 `GET /api/setup/status`（只读记录，前端守卫在任何形态同形可拉）。
- `src/repositories/settingRepository.ts`：`DEFAULT_LANGUAGE` 进公开设置白名单。

### 落地（前端，沿用旧版 OOBE 向导界面）

- `web/src/App.tsx`：安装守卫 —— 挂载时拉 `/api/setup/status`，未完成则**全屏只渲染 `<SetupWizard/>`**（任何 hash 路由不可达）；拉取失败按已安装处理（纯前端 dev 不误锁）。
- `web/src/pages/Setup/SetupWizard.tsx`：步骤 2 新增「默认显示语言」（四语言下拉）；步骤 3 数据库类型仅 **SQLite（推荐）/ PostgreSQL** 两选项 + 不可更改警告 Alert；`complete` 载荷带 `default_language`。
- `web/src/store/i18nStore.ts`：persist 升 v2，新增 `userChosen` —— **站点默认语言只在用户没主动选过时生效**（`applySiteDefault`）；`siteStore` 消费 `DEFAULT_LANGUAGE`。

### 恢复时修掉的两个中断根因

1. **探针页 React Refresh preamble**：`public/` 下的 HTML 不被 `transformIndexHtml` 处理，JSX 模块求值抛 `@vitejs/plugin-react can't detect preamble` → 手工内联与插件注入逐字一致的 preamble 后恢复（探针为 `[TEMP-VERIFY]` 脚手架，验收后已删，SetupWizard 的 `initialStep/forcedDbType` 探针 props 一并摘除）。
2. **`verify-install-live.mjs` 缺 PG 临时库生命周期**：头注释承诺「会 DROP 临时库」但从未实现，且不会建库 → 补 `ensurePgDb`（跑前 CREATE，幂等）/ `dropPgDb`（finally `DROP ... WITH (FORCE)`）。另：本机 shell 默认 Node 24 与 better-sqlite3 的 ABI 127 不匹配（`ERR_DLOPEN_FAILED`），测试与服务一律用项目运行时的 Node 22.22.2。

### 验收（数字均为实际输出）

- 后端 + 前端 `tsc --noEmit` 零错误；`web` `npm run build` 通过（13.85s）
- 全开门控（PG + Redis + Mailpit）`INDEV/run-tests.cmd`：**319 tests / 319 pass / 0 fail / 0 skipped**（含新 `tests/setupService.test.ts` + `tests/setupHttp.test.ts`）
- **真实安装 E2E**（`node scripts/verify-install-live.mjs`，起真实 main.ts 驱动真实 HTTP）：
  - SQLite 路径：全新目录 → installing → complete → 重启 installed → 超管登录 200 → `/health/ready` database=ok；装完再 complete → 403
  - PostgreSQL 路径（便携 PG :54329，trust 空密码）：同上全绿，`setup.json` 锁 `postgresql`；`test-db` 空密码走无认证（`buildPgUrl` 刻意不写 `:password` 段）
  - MySQL：`test-db` 明确返回不支持；向导 UI 无此选项
  - 默认语言：向导选 JP → `setup.json.defaultLanguage=JP` + 公开设置 `DEFAULT_LANGUAGE=JP` 双落地
- 存量开发环境（`:3000`）重启后走 `auto`：自动补写 `data/setup.json`（`source:"auto"`、锁 sqlite），`/api/setup/status` → `setup_completed:true`，正常站点不受影响
- UI 截图 2 张（`.shots/`）：`35-batch12-wizard-step2-language.png`（站点名称 + 默认显示语言下拉）、`35-batch12-wizard-step3-postgresql.png`（仅 SQLite/PostgreSQL 两 radio + 不可更改警告 + PG 连接字段），均带文本级 DOM 断言复核
- **本批未触碰 GitHub**（`git remote -v` 为空）

### 补充：进程内软重启（用户实测后补的生效闭环）

**起因**：用户真实走完向导后管理面板满屏加载失败。根因是「装完 ≠ 生效」：`complete` 只落盘 `setup.json`，当前进程仍是安装模式（业务 API 继续 403），而前端守卫只看 `setup_completed`（文件状态）就放行进面板。用户拍板的目标流程：**前端点完成只发一次信号 → 后端带着刚落盘的 setup.json 原地重启 → status 报告进程真实模式 → 前端「正在配置中」轮询到已生效后几秒自动刷新进入站点**。

- `src/server/bootstrap.ts`（新）：从 `main.ts` 抽出正常模式完整装配 `buildInstalledApp(config)`（连库→迁移→auto 补写→依赖装配→createApp，只构建不 listen）。启动路径与软重启路径共用一份装配，防漂移。
- `src/server/main.ts`：installing 分支挂 `onInstalled` 回调做**软重启**——先 `buildInstalledApp` **构建成功**才关旧 setupApp、同端口换绑新 app（装配失败时旧服务仍在、status 仍报 installing，前端停在「正在配置中」而不是白屏死站）；换绑后 SIGINT/SIGTERM 改挂新服务。
- `src/server/routes/setup.ts`：status 增加 **`mode:'installing'`（进程真实状态）**，与 `setup_completed`（文件状态）区分；complete 成功响应 `finish` 后才触发软重启（保证信号有回执）。`src/server/app.ts`：正常模式 status 报 `mode:'installed'`。
- `web/src/App.tsx`：守卫改按 `mode` 判定（无 mode 的旧后端回落 `setup_completed`，兼容纯前端 dev 拉取失败按已装）。
- `web/src/pages/Setup/SetupWizard.tsx`：完成页改为生效状态机 `waiting`（转圈「正在配置中」，每秒轮询 status，换绑瞬间连接被拒属预期继续等）→ `live`（已生效，2.5s 后自动整页刷新进站）→ `timeout`（90s 兜底给手动按钮）。四语言包补 `activating/activatingDesc/autoRedirectDesc/activateTimeoutDesc`。
- 同批修掉向导两处体验问题：① 边角统一 —— 向导整体包 `ConfigProvider`（`darkAlgorithm` + `borderRadius:0` token），自有样式残留的 2/4px 圆角全部归零，输入框/下拉/弹层/Alert 与全站直角语言一致；② PG 数据库密码不再强制必填（后端 `buildPgUrl` 本就支持空密码走 trust 认证，前端校验与后端能力对齐，补「可留空」提示）。
- 验收：后端+前端 `tsc` 零错误；`tests/setup*` 25/25；全门控 `INDEV/run-tests.cmd` **319/319 pass / 0 fail / 0 skipped**；`verify-install-live.mjs` 新增软重启断言后 SQLite 与 PostgreSQL 两条路径全绿（**同一进程未手动重启**，complete 后 status.mode 翻为 `installed`、`/api/settings/public` 直接 200、再 complete 被拒 404；阶段 2 硬重启回归不受影响）


---

## P5 第十三批：人机验证三态（Issue #3）

GitHub Issue #3 的原始诉求是「生产站开着注册却没有验证码」。实测线上 `/api/settings/public` 与设置形态后确认：`CAPTCHA` 只有布尔开关、只有数学题一种实现，且题干明文下发。用户选择的路线是**三种都做、做成可选项**，并追加「保留国内外第三方人机验证端点，从不绑定，让管理者有更多的选择」。

> 本批**推翻此前「本项目不接 Turnstile」的三处文档口径**（`src/server/routes/captcha.ts` 头注释、`tests/captcha.test.ts` 断言注释、前端 `TurnstileWidget` 的既成事实）。推翻的不是「不依赖厂商」这一点，而是实现方式：外部验证以**预设 + 四项全可改**的形态存在，任何厂商都只是 `EXTERNAL_CAPTCHA_*` 的一组默认值，仓库本身不绑定它，也不为它写死端点。

### 规则矩阵

| 场景 | `none` | `math` | `image` | `external` |
|---|---|---|---|---|
| `GET /api/captcha/captcha-type` | `{type:'none'}` | `{type:'math'}` | `{type:'image'}` | `{type,siteKey,scriptUrl,globalName}`（**不含 secret**） |
| 出题端点 | `generate` 明文题干 | 同左 | `GET /api/captcha/image` 回 PNG，题干不出服务端 | 无（token 由外部脚本给） |
| 提交字段 | 无 | `captcha_session_id` + `captcha_answer` | 同左 | `captcha_token` |
| 校验失败 | — | 400 `CAPTCHA_INVALID`（一次一题，答错即烧） | 同左 | 400 `CAPTCHA_INVALID`（token 空/端点说不过） |
| 能力缺失 / 上游不通 | — | 服务未注入 → 400 fail-closed | 同左 | **502 `CAPTCHA_UNAVAILABLE`**（未注入、缺配置、超时、非 2xx、非 JSON） |
| 访客 IP 去向 | 本站 | 本站 | 本站 | 所配置的校验端点 |
| 旧站点（只写过 `ENABLE_CAPTCHA`） | `false → none` | `true → math` | — | — |

三条硬规则（一次一题、先消费再比对、四类失败同一文案）由 `math` 与 `image` **共用同一套仓储与 `verify`**，图片模式没有另开一条校验路径。

### 落地（后端）

- `src/site/runtimeSettings.ts`：新键 `CAPTCHA_TYPE`（`none|math|image|external`）+ `EXTERNAL_CAPTCHA_{PRESET,SITE_KEY,SECRET,VERIFY_URL,SCRIPT_URL,GLOBAL_NAME}`；`captchaType()` 在枚举未写时按旧布尔推导，写坏的枚举值同样回落旧口径（**绝不因脏值变成「谁都不校验」**）；`EXTERNAL_CAPTCHA_PRESETS` 内置 turnstile/hcaptcha/recaptcha 三组默认值，`externalCaptcha()` 做「预设填默认、管理员显式值优先、空串视为未写」的合并，secret 走 `SecretBox` 解密且兼容历史明文。
- `src/account/captchaImage.ts`（新）：图片题渲染器。数字用**手写矢量笔画路径**画，不用 `<text>` —— `<text>` 依赖系统字体，精简容器（alpine-slim/distroless）里会画成空白图，用户永远答不对且只在部分机器复现。先试过七段数码管段位表，实测 `1`/`7` 旋转后不可辨认，故改手写笔画。sharp 已是硬依赖（`src/textures/ingest.ts`），无新增依赖。
- `src/account/captcha.ts`：`generateImage()` 与 `generate()` 共用私有 `issue()`（replace + 顺带清过期）；`requireSessionId` 提到模块级复用。
- `src/account/externalCaptcha.ts`（新）：只依赖「表单 POST（`secret`+`response`+`sitekey`+`remoteip`）→ 布尔 `success`」这一共同形状，因此换厂商、换自建中转都只是改配置。两条硬约束：默认 5s 超时（这是挂在注册/登录路径上的出站 HTTP）、失败绝不静默放行。协议锁死 http/https，**刻意不拦内网地址**（指向自建/内网校验服务正是这项能力存在的理由）。需要厂商签名的服务（天御/阿里云/易盾/GeeTest v4）不在此形状内，未预先塞无法验证的代码，扩展位写在注释里。
- `src/errors.ts` + `src/server/errorHandler.ts`：新增 `CAPTCHA_UNAVAILABLE` → 502，与 `SMTP_ERROR` 同一类「上游故障」；刻意与 `CAPTCHA_INVALID` 分开，否则管理员会把「本站验不了」当成「用户填错」。
- `src/server/routes/captcha.ts`：`captcha-type` 按类型给形状、`image` 端点与 `generate` **共用出题限流**（两者烧同一张表，分开限流等于给「一条路打满换另一条」留口子）、未注入服务回 503 而不是空题。
- `src/server/routes/identity.ts`：`assertCaptcha` 改为按 `captchaType()` 分派；external 分支只认 `captcha_token`，且数学题字段在这条路上不作数（防换条路绕过）。
- `src/server/routes/settings.ts`：`EXTERNAL_CAPTCHA_SECRET` 进 `ENCRYPTED_KEYS` 与 `SECRET_KEYS`（与 `SMTP_PASS` 同待遇：写入加密、回传脱敏 + `<KEY>_SET`）。`/api/settings/public` 是白名单式，新键默认不公开。

### 落地（前端）

- `web/src/components/ExternalCaptchaWidget/`（新）取代 `TurnstileWidget/`（删）：脚本地址、全局对象名、siteKey 全部由配置传入，脚本按 URL 去重复用，`waitForApi` 轮询到 `render` 就绪再挂载；失败只给**原因码**（`load`/`unavailable`/`verify`/`expired`），文案留在页面层，四语言才跟得上。
- `Login.tsx` / `Register.tsx`：三态渲染（外部 widget / 图片 `<img>` / 数学题只读输入框），提交前分别拦住「token 还没拿到」与「题目没就绪」，失败后 external 清 token、自托管换一道。图片 `<img>` 带 `onError` 提示，避免只剩一个破图标。
- `SystemSettings.tsx`：`ENABLE_CAPTCHA` 开关换成四选一 Select，选 image 出「本机绘制/只拦脚本」提示，选 external 出「会把访客 IP 交给端点、不通时 502」警告 + 预设与四项配置；密钥框留空即保留已存值（占位文案由 `<KEY>_SET` 驱动）。
- `SkinUpload.tsx`：删掉那段**永远走不到的 turnstile 死代码**（后端从未返回过 `'turnstile'`，上传链路也不校验验证码），顺带去掉 `authService` 与 `RegisterDTO`/`LoginDTO` 里没人消费的 `turnstile_token` 字段，改传 `captcha_token`。
- i18n 四语言各补 29 个键，同时删掉因上述死代码而失效的 `admin.enableCaptcha*` 与 `upload.pleaseCompleteCaptcha`。

### 验收（数字均为实际输出）

- 后端 `npm run typecheck` 与前端 `tsc --noEmit` 零错误；`web` 生产构建通过。
- 单测：SQLite 基线 **372 用例 / 282 pass / 0 fail / 90 skipped**；全门控（PG + Redis + Mailpit）**372/372 pass / 0 fail / 0 skipped**。本批新增 18 个用例：图片码形态与 PNG 尺寸、external 的 6 条服务层分支（缺配置不出网、表单四项、success=false、非法 token、上游不通/非 2xx/非 JSON）、`CAPTCHA_TYPE` 显式优先与脏值回落、图片题端到端（含「答错烧题后正确答案也不再放行」）、external 端到端（含未注入服务 502 与「校验不通不建号」）、`runtimeSettings` 类型与预设合并、`EXTERNAL_CAPTCHA_SECRET` 密文入库/脱敏/留空不覆盖。
- 浏览器实测（便携包站点 + 本地验证桩，三种模式逐一过）：
  - `image`：注册页 PNG 实际渲染成人眼可读的 5 位数字（截图核对 `17602`/`21987`），答对 → 注册成功；答错 → 提示「人机验证答案不正确，请换一道重试」并自动换一道；`login` 同样被拦（空答案时出必填提示）。
  - `external`：管理端填自建桩的校验地址/脚本地址/全局名后，注册页加载本地脚本并渲染出自定义 widget，提交后桩服务收到 `secret`+`response`+`sitekey`+`remoteip` 四项齐全的表单并放行；把校验地址改到死端口 → 502 `CAPTCHA_UNAVAILABLE`；把脚本地址改到死端口 → 页面出「人机验证组件加载失败…」而不是一片空白；管理端密钥框显示为空 + 占位「留空则保留已保存的密钥」。
  - `math`：题干明文（`28 - 17 = ?`）正常作答登录成功，确认旧模式未被本批改坏。
  - `none`（默认）：注册/登录页整块验证码 UI 不渲染，与升级前一致。
- 收尾：临时实例、验证桩与 `.tmp-*` 脚本全部删除，不留测试账号。

## P5 第十四批：/uploads 跨源读取白名单（Issue #4）

Issue #4 报的是「`/uploads` 写死 `Access-Control-Allow-Origin: *`」。核对后先订正了它的前提：**这条头与热链、带宽无关** —— `<img>` 引用图片不走 CORS，别人嵌图照样显示；`*` 真正放开的是「第三方页面把本站纹理读进 canvas 原样抠走」（本站 `SkinThumbnail3D` 的 `toDataURL` 正是同一条能力）。用户据此拍板：收敛成白名单回显，Referer 防盗链**不进代码**，只在 README 写清怎么做（每台主机策略不同，属个例）。

### 规则矩阵

| 请求来源 | 白名单留空（默认） | 白名单含该来源 | 白名单填 `*` |
|---|---|---|---|
| 无 `Origin`（直接打开、`<img>` 热链、启动器取纹理） | 200，不发 ACAO | 200，不发 ACAO | 200，`ACAO: *` |
| 同源（`Origin` == 请求自身 `Host`） | 回显该来源 | 回显该来源 | `*` |
| 站点自身来源（`BASE_URL` 解析出的 origin） | 回显该来源 | 回显该来源 | `*` |
| 其它来源 | **不发 ACAO**（跨源读像素被拒） | 回显该来源 | `*` |
| 任意来源 | — | — | `*` |

`/uploads` 的每个响应**无论命中与否都带 `Vary: Origin`**：回显具体来源等于让同一 URL 的响应随来源变化，共享缓存不按来源分键就会把 A 的响应发给 B，表现为「我这边好、他那边图裂」。

### 落地（后端）

- `src/site/runtimeSettings.ts`：新键 `UPLOAD_CORS_ORIGINS` + 导出 `parseOriginList()`。分隔符只认逗号/分号/换行，**刻意不认空格** —— 认空格的话管理员手滑写的 `not a url` 会被拆成 `https://not`、`https://a`、`https://url` 三个「看着合法」的来源写进白名单，那是静默放宽而不是丢垃圾项；含空格的整项交给 URL 解析直接判失败。认不出的项逐项丢弃，不让一条脏值废掉整张表；`*` 命中即短路。
- `src/server/uploadsCors.ts`（新）：中间件形态挂在 `express.static` 之前。三条判定依次是「请求自身 Host 的同源」「`SiteUrlResolver` 的站点根」「管理员白名单」，命中才回显**归一化后的值**（绝不把请求头原文写进响应）。同源那条不依赖 `BASE_URL` 是否配置，避免「没配站点根 → 自家站点头像整片裂」这种新引入的故障。
- `src/server/app.ts`：`/uploads` 的 `setHeaders: res.set('Access-Control-Allow-Origin','*')` 移除，改为挂中间件；`maxAge` 等其余语义不变。

### 落地（前端）

- `SystemSettings.tsx`：「站点设置」卡末尾加 `UPLOAD_CORS_ORIGINS` 多行输入，tooltip 直接写明「不防热链，要防热链去网关按 Referer 处理」——管理员最容易把这两件事混为一谈，写完白名单发现带宽没降还以为功能坏了。
- i18n 四语言各补 3 个键（label / tooltip / placeholder）。

### 文档

- 四语言 README 新增「素材跨源读取」一节：默认策略、独立图床/CDN 必须把页面来源加进白名单、`Vary: Origin` 与 CDN 分键的三选一处置、以及「这不是热链防护」。
- 另加一小节「要防热链（Referer）该怎么做」，给 nginx `valid_referers` 示例并写清三条边界：无 Referer 必须放行（直接访问/隐私模式/Referrer-Policy 降级都没有 Referer）、Yggdrasil 客户端取纹理也可能不带 Referer（规则要按 `location` 精确圈定，别把启动器挡了）、Referer 可被非浏览器客户端伪造（挡君子不挡小人，要更硬得换签名 URL）。
- `.env.example` 标注 `UPLOAD_CORS_ORIGINS` 属站点设置而非环境变量。

### 验收（数字均为实际输出）

- 后端与前端 `tsc` 零错误。
- 单测：新增 `tests/uploadsCors.test.ts` 10 项（白名单解析 4 项 + 真实 HTTP 响应头 6 项），并接入 `npm test` / `npm run test:pg` 脚本清单。SQLite 基线 **382 用例 / 292 pass / 0 fail / 90 skipped**；全门控（PG + Redis + Mailpit）**382/382 pass / 0 fail / 0 skipped**。
- 真实实例实测（后端 :3100 提供 `/uploads`，另起 :8081 当「第三方站点」做 canvas 读回）：
  - 响应头矩阵：`Origin: http://localhost:8081` 留空时 `ACAO=<none>`；配 `BASE_URL=http://localhost:8080` 后该来源回显、8081 仍被拒；白名单填 `http://localhost:8081, cdn.test` 后 8081 与 `https://cdn.test`（裸域名补协议）都回显、`https://evil.test` 仍被拒；填 `*` 时回显 `*`。**每一次改设置都立即生效，无需重启**，且所有分支都带 `Vary: Origin`。
  - 浏览器（白名单为空的严格态）：`fetch(mode:'cors')` → `TypeError Failed to fetch`；`crossOrigin="anonymous"` 的 `<img>` → 加载失败；**而无 `crossOrigin` 的 `<img>` 照常显示 64×64** —— 正好实证「CORS 不防热链」这句判断。
  - 浏览器（把 :8081 加入白名单后）：`canvas.toDataURL()` 读出 398 字节 dataURL、`getImageData` 也拿到像素，说明白名单命中时跨源读纹理完全可用（自家 3D 预览同理不受影响）。
- 收尾：临时实例、探针页与 `.tmp-*` 全部删除。

## P5 第十五批：密码强度可配 + 匿名端点限流（Issue #5）

Issue #5 是安全测试留下的两条「信息级备忘」，都不是缺陷而是权衡。用户对两条的拍板是：**bcrypt cost 做成可配、默认值不动、并补上存量哈希的平滑升级**；**批量角色名查询按 IP 60 次/分钟限流**。

### 落地（bcrypt）

- `src/auth/password.ts`（新）：强度的唯一来源。`resolveBcryptCost()` 把 `BCRYPT_COST` 钳制到 10-14，脏值/空值回落 10，**越界只钳制并打一条警告，绝不抛错** —— 装到一半服务起不来，比登录慢 200ms 严重得多。另导出 `bcryptCostOf()`（从 `$2a$10$…` 读 cost）与 `needsRehash()`。
- 改动前 `src/auth/identity.ts` 与 `src/setup/setupService.ts` 各写死一份 `const BCRYPT_COST = 10`，后者只靠一句注释与前者的值对齐。现在 `AppConfig.bcryptCost` ← 环境变量，`IdentityService` 通过依赖注入拿它，安装向导读 `deps.config.bcryptCost`，注册 / 改密 / 向导三条写入路径不可能再各自漂移。
- **rehash-on-login**：`IdentityService.upgradePasswordHash()` 在登录校验通过、且账号确实可登录之后，若存量哈希 cost 低于目标就用此刻手上的明文重算并写库。三条边界：只在登录路径调用（改密路径随后本来就要写新哈希，那里重算是白算）；写库失败只留警告、不阻断登录；**只升不降**（管理员把配置调回去时不重写，否则每次登录都白算一遍）。
- 为什么不直接把默认抬到 12：bcryptjs 是纯 JS 实现，cost 每 +1 耗时约翻倍。本机（16 核）实测 cost 10 → 校验 78ms / 生成 118ms，cost 12 → 342ms / 313ms，即登录一次从约 80ms 变约 340ms，低配 VPS 更糟。强度是「机器 + 威胁模型」的部署决策，所以给旋钮、默认值保持 10（OWASP 下限）不变。

### 落地（限流）

- `POST /api/profiles/minecraft` 此前**完全无限流**，而它是匿名可用的协议端点（角色名 → UUID，单次 ≤10 名），等于允许无限速遍历全站角色名与 UUID。
- 沿用同路由已有的三件套：`config.ts` 加 `DEFAULT_PROFILE_LOOKUP_RATE_LIMIT`（60 次/60 秒）与 `resolveProfileLookupRateLimit()`、`cache/keys.ts` 加 `RateLimitKeys.yggdrasilProfileLookup(ip)`、路由挂 `profileLookupLimit`。
- **按 IP 而不是按名字/账号**，与 `/refresh` 同一口径：真客户端进服时也会打这个端点，共用出口地址（宿舍/机房 NAT）下多人同时进服会落在同一个键上，收紧就会误伤玩家。阈值取宽松值。
- 键只取客户端地址，而真实 app 把同一个 router 挂了 4 个前缀（`/authserver`、`/api/yggdrasil`、`/`、`/api/yggdrasil/authserver`）—— 换前缀拿不到第二份配额，这一点专门写了用例钉住。
- 与其余限流同样受 `RATE_LIMIT_DISABLED` 总开关管；未注入 limiter 时恒放行（可选依赖语义，也是既有大量测试不受影响的原因）。

### 验收（数字均为实际输出）

- 后端 `tsc` 零错误。
- 新增 `tests/password.test.ts` 5 项（缺省与脏值回落、越界钳制、cost 解析含 2b/2y 前缀、needsRehash 只升不降、hashPassword 用注入值且内置强度校验）；`tests/identity.test.ts` 双方言各 1 项 rehash-on-login（cost 4 旧哈希 → 密码错误时不动哈希 → 正确登录后升到 10 且换了串 → 再登录不重复重写）；`tests/cache.test.ts` 3 项（未注入 limiter 全放行、按 IP 超限 429 `TOO_MANY_REQUESTS`、双挂载前缀共用同一份配额）。
- SQLite 基线 **392 用例 / 301 pass / 0 fail / 91 skipped**；全门控（PG + Redis + Mailpit）**392/392 pass / 0 fail / 0 skipped**。
- 文档：`.env.example` 补 `BCRYPT_COST`（含实测毫秒数与「调低不降级」）与 `PROFILE_LOOKUP_RATE_LIMIT_*`；四语言 README 部署要点各加两条（强度权衡、匿名端点限流与 `TRUST_PROXY` 依赖），基线数字同步到 392。

## P5 第十六批：备用邮箱参与登录 + 邮箱唯一性收口

用户直接需求（不是 Issue）：「备用邮箱参与跟主邮箱一样的登录（包括启动器登录），并检查邮箱查重是否生效，确保邮箱都绑一个号，杜绝重复注册」。

### 核对现状时的两个发现

1. **查重确实生效，但只到列内**。`users_email_lower_uidx`（`lower(email)`）与 `users_backup_email_lower_uidx`（`lower(backup_email)`，带 `IS NOT NULL` 条件）两个唯一索引都在，所以同类重复由 DB 拦。跨列（A 的主邮箱 == B 的备用邮箱）索引管不到，此前只有 `emailChangeFlow.assertAddressAvailable()` 补了检查 —— 改邮箱/绑备用这条路径是完整的。
2. **注册路径漏了跨列查重**：`register()` 只查 `findByEmail`，不查 `findByBackupEmail`，于是可以拿别人已绑定的备用邮箱注册成主邮箱 —— 这才是「一个邮箱绑两个号」的真实入口。备用邮箱一旦能登录，这个口子必须堵。

另外确认：**「已绑但未验证」这个状态在正常流程里不落进 `users` 表**。`users.backup_email` 只在 `verifyBackupEmail()` 点完链接时写入（并同时置 verified），pending 状态只活在 `backup_email_tokens` 里。所以未验证的绑定既不占位、也不参与认证；用户担心的「拿未验证绑定做无限量入口」在数据模型层面本就不成立，但认证查询仍显式加了 `backup_email_verified` 条件作为防线（防旁路写入/历史数据）。

### 规则矩阵

| 场景 | 主邮箱 | 已验证备用邮箱 | 未验证备用邮箱 |
|---|---|---|---|
| 网页登录 | 可以 | **可以**（本批新增） | 不行，与「账号不存在」同一口径 |
| 启动器 `authenticate` / `signout` | 可以 | **可以** | 不行 |
| `REQUIRE_EMAIL_VERIFICATION` 门槛 | 需主邮箱已验证 | **视为满足**（备用就是主邮箱收不到信时的兜底） | — |
| 找回密码发起 | 可以 | **可以** | 不行 |
| 找回密码投递 | 有已验证备用 → 投备用 | 投主邮箱 | — |
| 注册占用 | 唯一索引 + 应用层 | **注册侧新增查重**（别人已绑的备用邮箱不能拿来注册） | — |
| 登录限流分桶 | 按提交地址 | 按提交地址（**同一账号两个桶，已知缺口**） | — |

**冲突不任选**：若历史脏数据已造出「同一地址命中两个账号」，`findForLogin` 返回 `conflict`，登录两边都按凭据错误收口 —— 否则那个地址就成了「猜中即登进某个号」的入口。冲突只记一条服务端日志（数据不变量被破坏需要人工核查），对客户端不给任何区别，免得这个端点变成冲突探测器。

### 落地（后端）

- `src/repositories/userRepository.ts`：新增 `findForLogin(address)` → `{user, slot, conflict}`，SQL 一条：`lower(email)=?` 或 `lower(backup_email)=? AND backup_email_verified=<1|TRUE>`（三处占位符各绑一次同一个值，SQLite 不吃重复下标）。
- `src/auth/identity.ts`：
  - `resolveLoginAccount()` 统一收口「查不到 / 非字符串 / 冲突」三种情况，`loadUserForAuth`（网页登录、恢复账号）与 `assertYggdrasilCredentials`（启动器）都走它。
  - `loginWeb` 的邮箱验证门槛加 `&& !viaBackup`：用已验证备用邮箱登录即放行。
  - `register()` 补 `findByBackupEmail` 查重。
  - rehash-on-login 与登录路径共用，备用邮箱登录同样承担升级（很多账号只在启动器里登录）。
- `src/account/emailFlow.ts`：
  - `sendReset` 改走 `findForLogin`（主/备都能发起，冲突与查不到同样静默成功，保持防枚举）。
  - `resetDeliveryTarget()`：优先投「另一个已验证槽位」，没有则回落同槽。
  - `resetPassword` 只在**没有已验证备用邮箱**时才顺带置 `email_verified` —— 交叉投递的那封信证明的是备用信箱的归属，把主邮箱标成已验证是在撒谎。宁可少标，绝不假造。

### 落地（前端）

- 登录页邮箱框占位改为「主邮箱或已验证的备用邮箱」（antd AutoComplete 的占位符是独立节点 `.ant-select-selection-placeholder`，不是 input 的 `placeholder` 属性 —— 实测时按属性查会误判成没生效）。
- 找回密码页：提示写明两个地址都能填、且邮件可能投到另一个邮箱；**提交后的成功提示不再回显投递地址**（`sentTo` 改为 `sent`）—— 回显等于替探测者确认账号存在，也会让收件人去翻错的那个邮箱。
- 个人中心备用邮箱说明补一句「验证通过后可像主邮箱一样登录网页与启动器」。
- i18n 四语言：新增 1 键（`auth.loginEmailPlaceholder`）+ 改写 3 键（`forgotPasswordHint` / `resetEmailSentDesc` / `profile.backupEmailExplain`）。

### 验收（数字均为实际输出）

- 后端与前端 `tsc` 零错误，web 生产构建通过。
- 新增 `tests/backupEmailLogin.test.ts` 16 项（SQLite 8 项 + PG 门控 8 项），接入 `npm test` / `test:pg`：备用邮箱登录（含大小写）、未验证不参与认证、冲突不任选、门槛放行、注册查重、交叉投递两个方向、无备用时回落同槽并照旧置位、备用登录路径的哈希升级。
- 套件：SQLite **408 用例 / 309 pass / 0 fail / 99 skipped**；全门控（PG + Redis + Mailpit）**408/408 pass / 0 fail / 0 skipped**。既有 392 项无一回归。
- 真实实例 + Mailpit 实测：注册 `beuser@csp.local` → 绑 `besec@csp.local` → 点掉真实验证邮件里的链接（`/api/me/backup-email/verify` 200）→ 打开「要求邮箱验证」后：主邮箱登录 **403 `EMAIL_NOT_VERIFIED`**、备用邮箱登录 **200**；启动器 `/authserver/authenticate` 用备用邮箱 **200**、用未验证地址 **403 Invalid credentials**；用备用邮箱注册 **409 `EMAIL_TAKEN`**（文案「该邮箱已被其他账号用作备用邮箱」）；用主邮箱发起找回密码后 Mailpit 里只有一封「重置密码」且收件人是备用邮箱（交叉投递实证）。浏览器侧：登录页用备用邮箱提交 → `登录成功！` 并落到首页；找回密码页提示与成功文案均为新口径。
- 已知缺口按用户口径**只记录不实现**：登录限流按提交地址分桶，同一账号有主/备两份配额；收紧方向是归一到解析出的账号 ID（要在认证路径内计数）。四语言 README 的「邮箱与账号找回」小节末尾明确写了这一条。

## P5 第十七批：README 瘦身为介绍型，文档内容拆入 docs/

### 动机

README 一路加到 182 行，绝大部分是**文档型**内容（反代配置、验证码四种模式、邮箱规则、CORS 语义），而它的定位是**介绍型**：一眼看清这是什么、怎么装、怎么跑。用户口径：「无需解释一堆更改的东西，缩减内容变成可跳转阅读文档」。

### 落地

- 新增四份专题文档（简体中文，从 README 原文迁移并补全，未删减信息）：
  - `docs/deployment.md` —— 反代配置与 `TRUST_PROXY`、`MCSTS_SECRET`、启动器地址与 `meta.serverName`、多实例 Redis、`BCRYPT_COST`（含实测耗时）、匿名端点限流阈值、跨源与 CDN、人机验证配置入口
  - `docs/human-verification.md` —— 四种模式取舍、图片题为何用矢量笔画而非系统字体、三条硬规则、外部验证的预设与可改项、失败语义、SSRF 边界
  - `docs/account-emails.md` —— 一个邮箱只绑一个号（含跨列冲突不任选）、已验证备用邮箱参与登录、找回密码交叉投递、已知缺口（按提交地址分桶）
  - `docs/uploads-cors.md` —— CORS 管什么不管什么、放行规则、`UPLOAD_CORS_ORIGINS` 语义、CDN 必须按 Origin 分键、`## Referer 配方`（不进仓库，只给 nginx 做法与三条边界）
- 四语言 README 统一为 **96 行左右**、同一小节骨架（功能一览 / 技术栈 / 快速开始 / 构建与生产部署 / 测试 / 文档 / 贡献者 / 许可 / 致谢 / AI 协助声明 / 工作约定）：部署细节压成一行跳转链接，「文档」小节只列五份对外指南（`deployment` / `human-verification` / `account-emails` / `uploads-cors` / `oauth-provider-guide`）。`docs/development-log.md` 与其他内部文档留在仓库但 README 不链接展示（沿用既有对外口径）。
- 便携包下载与版本口径留在 README（属于「这是什么、怎么拿到」），细节不再展开。
- 英文与日文 README 在「文档」小节注明这些指南当前仅有简体中文。

### 验收（数字均为实际输出）

- 四份 README 小节骨架一致（各 95–97 行，差异只在语言备注行）；`2.3.6` 与基线 `408/408 pass / 0 fail / 0 skipped` 在四语言全部保留，无历史版本号残留。
- 全部相对链接与锚点逐一校验通过（含 `docs/uploads-cors.md#referer-配方`、`docs/deployment.md` 等交叉引用），无断链；文档里的每个设置键、索引名、环境变量名都回到 `schema/`、`src/site/runtimeSettings.ts`、`.env.example` 核对过。
- 语言串味扫描：`README.zh-Hant.md` / `README.en.md` / `README.ja.md` 均无简体字残留；行尾统一 CRLF（与仓库既有 README/文档一致）。
- 迁移时逐条回到代码核对文档事实，纠正三处：
  - `docs/human-verification.md` 的图片题耗时原写「单张 2–7KB、p50 约 7ms、p95 约 14ms」是估算值，重新实测（Node 22.22.2，`renderCaptchaPng` 60 张）后改为 **190×64、5.3–6.8KB、p50 4.3ms / p95 7.6ms / max 8.7ms**。
  - `docs/uploads-cors.md` 的放行表原写「无 `Origin` + 白名单 `*` → `ACAO: *`」，与 `src/server/uploadsCors.ts` 实际顺序不符（无 Origin 在判白名单之前就 `next()`），改为三列都是「不发 ACAO」并补一句原因。
  - 外部验证小标题原写「四项全可改」，实际只有 `verifyUrl` / `scriptUrl` / `globalName` 三项由预设填入（`siteKey` / `secret` 永远由管理员给），改为「预设只填三项，其余全部可改」。
- 三处代码注释里指向 README 已消失小节的指针改指 `docs/deployment.md`（`src/server/routes/settings.ts`、`web/src/pages/Profile/UserProfile.tsx`、`web/src/vite-env.d.ts`），`src/server/uploadsCors.ts` 的 Referer 配方指针改指 `docs/uploads-cors.md`。
- 本批为文档改动：后端与前端 `tsc` 零错误，SQLite 基线 **408 用例 / 309 pass / 0 fail / 99 skipped** 与改动前一致（无既有用例断言 README 内容）。

## P5 第十八批：认证页语言切换补完 + 版本号改用 `v2-26.3.6` 口径

### 语言切换：从四份各写一套收敛成一份

改之前同一个功能有四份实现，而且互相不一致：

| 位置 | 列表来源 | 切换方式 | 显示当前语言 | 走 store |
|---|---|---|---|---|
| `TopNav` | 自己写死 4 项 | `i18n.changeLanguage` + 手写 localStorage | 有 | 否 |
| `AuthLayout` | 自己写死 4 项 | 写 localStorage + **整页 reload** | 无 | 否 |
| `Login` / `Register` | 各抄一份 | 同上 | 无 | 否 |
| `LanguageSwitcher` 组件 | `SUPPORTED_LANGUAGES` | `setLanguage` | 有 | 是 |

那个唯一正确的 `LanguageSwitcher` 组件是**死代码**（没人 import）。三处绕过 store 的写法有个实际后果：`userChosen` 永远是 false，而站点默认语言的生效条件正是「访客没主动选过」—— 于是访客自己挑的语言会在下次进站时被站点默认盖掉。

现在：

- `LanguageSwitcher` 重写为 Dropdown 形态（四语言取 `SUPPORTED_LANGUAGES`、`selectedKeys` 高亮当前、点击走 `useI18nStore.setLanguage`、不再整页 reload），样式类名由外部传入以复用认证页与顶栏两套既有外观。
- `AuthLayout` 与 `TopNav` 都用它；`Login.tsx` / `Register.tsx` 连同各自抄的外壳（背景图/视频、蒙版、星空、嵌入图、logo、语言按钮、卡片骨架）一起搬进 `AuthLayout`，两页从 620/548 行降到 518/447 行，页面差异只剩表单与 Modal。
- `i18n` 的探测顺序改成只看 `navigator` 并加 `convertDetectedLanguage` 归一（`zh-TW/zh-HK/zh-MO/zh-Hant*` → TCH，其余 `zh*` → SCH，`ja*` → JP，`en*` → EN，其他 → SCH）。此前 resources 的键是四个码，而 navigator 给的是 `zh-CN` 这类原始值，**永远匹配不上**，探测等于失效。
- 顺带修掉一个存储键冲突：`caches: ['localStorage']` 让 i18next 往 `cattavern-language` 写裸字符串，而 zustand persist 用同一个键存 `{state:{language,userChosen},version}` —— 两边互相踩（i18next 读到一段 JSON 当语言码，或把整份 store 状态覆盖成裸串）。持久化现在只归 i18nStore 一家。

**未收敛的一处（刻意）**：`SetupWizard` 底部那个语言下拉仍是自己的实现。它跑在安装完成前、样式是内联的深色底、选项文案走 `setup.lang.*` 键，而且它问的问题不同（「这个站点默认给访客什么语言」而不是「我要换语言」），塞进同一个组件反而把两种语义搅在一起。

### 版本号口径改为 `v2-26.3.6`

四段依次是：重制版标头 `2`（`1` = 重制前旧版）、年份 `26`、季度 `3`、季度内迭代序号 `6`；**进入下一季度迭代号重置为 1**。读出来是 `26.3.6`，书写与显示一律带 `v2-`。

- npm 要求 `version` 是合法 semver（三段），四段号装不下，所以 `package.json` / `web/package.json` 与两个 lock 存 `26.3.6`，标头由展示层拼：`web/vite.config.ts` 的 `__APP_VERSION__`（页脚渲染成 `v2-26.3.6`）、`src/yggdrasil/metadata.ts` 的 `implementation.version`（`2-26.3.6`）。
- 四语言 README 的版本行与版本口径行同步改写。
- 加了漂移守卫 `版本号：包内 semver 与对外的 v2- 代号必须同源`（`tests/repoHygiene.test.ts`）：比对根/前端两个 package.json、校验三段格式、比对元数据里的代号、并确认四语言 README 都含 `v2-<version>`。这类「一个版本散在多处」的口径，漏一处就会变成页脚与启动器各说一套。

### 验收（数字均为实际输出）

- 后端与前端 `tsc` 零错误，web 生产构建通过（10.87s）。
- SQLite 基线：**409 用例 / 310 pass / 0 fail / 99 skipped**（比上批多 1 项，即新增的版本漂移守卫）。
- 浏览器实测（:5173 真实实例）：登录页外壳改由 `AuthLayout` 提供后仍完整（logo、站点名、卡片标题、表单、注册/忘记密码链接）；语言下拉四项齐全且高亮当前语言；切到 English 后卡片标题变 `Login`、字段变 `Email`、`document.title` 同步，**没有整页 reload**；刷新后仍是英文（持久化生效，且 `userChosen` 已置位）；注册页在英文下整页文案（含注册须知 Alert）全翻译，切繁體中文得 `註冊` / `角色名`，最后复位简体中文。顶栏（nav 变体）四项齐全、当前项高亮、`title` 提示为「语言」。
- 版本显示：页脚实测渲染为 `v2-26.3.6`，「Powered by MCSkinToServer」署名照常在场；`buildMetadataDto` 单跑输出 `implementation = {"name":"MCSTS","version":"2-26.3.6"}`。
- 为让 `__APP_VERSION__` 生效重启了 vite dev（:5173，新 PID 31856），后端 :3000 未动。

### 发版（v2-26.3.7）

- 迭代号进位：`v2-26.3.6 → v2-26.3.7`（11 处逐行改，守卫测试当场拦住一次「只改了包、README 与元数据没跟上」的漏改）。
- tag `v2-26.3.7` 打在 `bbe5fa3`；Release 标题按固定口径 `MCSkinToServer v2-26.3.7`，挂 x64 + arm64 两个便携包，并按「只保留最新版」删掉 v2.3.6 那两个资产。
- 中途一次口径反复：我先把版本进位到 `.7`，用户看到线上 README 后质疑「本次就是 6」，于是本地退回 `.6` 重出了包；随后确认那是误触、按正常迭代走，又进回 `.7`。**教训记在这里**：`.6` 已经挂在上一版发版上，同一次发版不可能既是 `.6` 又是 `.7`；tag 因为还没有任何 Release 引用，用「删远端 tag + 重打」而非 `--force` 移动。
- 便携包冒烟（临时目录真跑包内启动器，SQLite 走完向导）13 项全通过：安装模式 → 同进程软重启 → 超管登录 → 元数据 `2-26.3.7` → 管理端写设置 → 切图片题 → sharp 真出 PNG（6026 字节）→ `/uploads` 的 `Vary: Origin` → `/authserver/authenticate` 正确拒绝。
- 出包时发现的架构卫生问题：arm64 包里躺着 `node_modules/esbuild/lib/downloaded-@esbuild-win32-x64-esbuild.exe`（esbuild 安装期在本机 x64 上下的回退缓存），真正生效的是 `@esbuild/win32-arm64/esbuild.exe`。**出包脚本现在会先删掉 `esbuild/lib/downloaded-*`，再逐个原生文件核 PE 头**（x64 全 `0x8664`、arm64 全 `0xaa64`，各 5 个）。历史包（含已发的 v2.3.6）里都有这个多余文件，因 Windows on ARM 可模拟执行 x64，未造成功能故障。
- arm64 包**未在本机实跑**（构建机是 x64，跑不了 arm64 二进制），功能冒烟只在 x64 上做过 —— 这条边界写进了 Release 正文。


## P5 第十九批：修复「收藏的皮肤/披风无法使用」（线上紧急）

### 症状与根因

用户在衣柜的「收藏」页选中别人公开的皮肤或披风点使用，一律得到「素材不存在」；素材即便设成「不可下载、仅收藏」也一样。

根因是一处所有权独占判断：`src/textures/ingest.ts` 的 `applyToProfile` 写着「素材与角色都必须归当前用户所有」，`asset.ownerUserId !== userId` 就抛 `NOT_FOUND('素材不存在')`。而衣柜收藏页里**全部**是别人的素材，所以这条路径从上线起就没通过一次。错误文案还是「素材不存在」而不是「无权使用」，排查时很容易误判成素材被删。

不是第二处坑：确认过 `listMyFavorites` 返回的是 `toLibraryItem(entry.asset, …)`，前端 `toLegacyAsset` 映射的 `id` 就是素材 id，衣柜传给 apply 的没错 —— 只有这一处判断错了。

### 口径订正

应用到角色**不是**下载原件：别人已公开且过审的素材正是「收藏后使用」的对象。所以规则改成「角色必须归自己；素材是『自己的』或『已公开且过审的』二者之一即可」。下载策略不参与这里的判断（那是 `/download` 的口径，见 `canDownload`）。私有 / 待审 / 被拒的素材仍然不可用，且仍统一收口成 404「素材不存在」，不透露存在性。

「已公开且过审」这条判断此前只在 `LibraryService` 里以方法形式存在，纹理侧没法复用，于是又各写一套。现在提为 `src/library/libraryService.ts` 的模块级 `isPubliclyVisible(asset)`（与既有的 `isAdminRole` 同一形态），`canView` / 浏览计数 / 收藏 / 应用四处共用，方法版删除。

纹理读取链路本来就不看所有权（`findTextureState` 只排除 `rejected`），所以绑定一旦写入就能出图，不需要额外改动。

### 验收（数字均为实际输出）

- 新增回归用例 `library: 收藏的素材可以应用到角色`（SQLite + PG 门控各 1 项）：owner 上传 → 设公开 → admin 过审 → viewer 收藏 → **apply 204** → `/api/me/skin` 真出 `skinUrl`（不是只写了一行绑定）；再验「没收藏的人同样能用公开素材」（收藏是书签不是授权）、槽位类型不匹配仍 400、owner 收回公开后第三人 apply 得 404。
- 补测试脚手架的一处失真：`tests/library.test.ts` 造 `IdentityService` 时漏传 `assetUrlResolver`（生产 `bootstrap.ts` 是传的），导致 `/api/me/skin` 永远回 `skinUrl:null` —— 第一次跑新用例就是被它挡住的。已补上。
- 后端与前端 `tsc` 零错误。SQLite 基线 **411 用例 / 311 pass / 0 fail / 100 skipped**；全门控（PG + Redis + Mailpit）**411/411 pass / 0 fail / 0 skipped**。
- **未做浏览器实测**：本地开发实例的 :3000 由用户的环境持有，重启它需要复用其启动密钥，我没有去探测进程参数。回归用例走的是真实 HTTP 端点（衣柜调用的同一个 `POST /api/assets/:id/apply`），但画面上没有逐屏看过。

## P6 第一批：插件系统接口与框架（仅 Dev，未推 master）

### 定位与责任边界（用户口径）

- 项目**只提供接口**给开发者做功能性插件；**安装与启用是超级管理员的决定**，插件行为由安装者负责。
- 因此刻意**不做**签名校验、权限审批、沙盒 —— 那是把安装者的责任往项目身上揽，而且进程内 ESM 本来关不住，假安全感比说清楚更糟。
- 项目负责的是另外四件事：接口稳定（`PLUGIN_API_VERSION` 闸门）、声明可核（注册未声明的入口直接拒载）、看得见（面板摊开 manifest 的入口/依赖/设置/启停记录）、炸不穿（加载失败与回调抛错不影响站点和别的插件）。
- 通道：接口与框架走 Dev，功能测试完全才推 master；第一个真实插件（基岩身份绑定）走本地 spellcard 通道，不进 git —— 它的作用是**对练**，逼接口补齐缺口。

### 为「做废」留的回溯准备

- **核心迁移链一个文件都不加**：插件状态与启停记录存在现成的 `system_settings`（两个键），插件表由插件在 `plugin_<id>_` 前缀下自建自删。回退代码不需要回退数据库。
- **默认关**：`MCSTS_PLUGINS` 未设时连 `PluginHost` 都不建，`/api/plugins` 不存在。
- **启停不动 listen 路径**：启动时只往 `/api/plugins` 挂一个分发器，按请求现查已加载插件；因此不需要软重启，也不碰 `main.ts` 的换绑时序。
- **接缝清单**（做废时逐条删除即可）：
  1. `src/config.ts`：`plugins?: { enabled; dir }` 一个字段（可选，所以 18 个测试文件的 config 字面量都不用改）；
  2. `src/server/bootstrap.ts`：建 `PluginHost` + `await pluginHost?.boot()` + deps 传 `plugins`；
  3. `src/server/app.ts`：`plugins?: PluginHost` 一个依赖字段 + 两行挂载；
  4. 事件 emit 共 4 处单行：`identity.ts` 注册/改名/删除、`accountLifecycle.ts` 清除；都走 `emitPluginEvent()`，未启用时是 no-op；
  5. `src/server/routes/plugins.ts` + `web/src/pages/Admin/PluginManagement.tsx` + 面板菜单一项 + i18n `plugins` 段（四语言各 36 键 + `admin.plugins`）；
  6. 新增文件本体：`src/plugins/**`、`plugin-api.d.ts`、`docs/plugin-api-guide.md`、`tests/plugins.test.ts`、`tests/fixtures/plugins/**`。

### 接口定型过程中被实测逼出来的四处

1. **web token 不隐含角色**。`RequestContext.profileId` 只在启动器选定角色时有值，网页 token 是 null。所以「按角色绑定」的插件必须自己带 `profileId` —— 夹具的 `/issue` 现在缺它就 400，而不是静默回落到 userId（回落会让绑定落在错误粒度上且无人知晓）。
2. **`auth:'hmac'` 不能挂 `requireAuth`**。原先「非 public 一律要 Bearer」，机器回调没有 Bearer，先返 401，签名校验根本轮不到执行。
3. **手动委托子 Router 要改写 `req.url`**。Express 不会替我们剥挂载段，子 Router 里的 `/ping` 永远匹配不上（症状是整个插件 404 到兜底）。
4. **未配 Redis 时防重放不能静默消失**。nonce 记录加了进程内存兜底 —— 可选依赖关掉之后安全属性直接没了，是最坏的一种降级。

另外修了一处测试脚手架自己的坑：`assert.equal(res.status, 200, await res.text())` 看着省事，实际**每次都把 body 读掉**（断言消息即时求值），后面再 `.json()` 就炸「Body has already been read」。现在统一走一个 `read()` 助手。

### 验收（数字均为实际输出）

- 后端与前端 `tsc` 零错误，web 生产构建通过。
- 新增 `tests/plugins.test.ts` 7 项（SQLite 4 项真跑 + PG 门控 3 项 skip→可跑），接入 `npm test` / `test:pg`：未启用时入口不存在、发现不等于授权（默认 disabled）、setup 抛错只标该插件且别的插件照常、注册未声明入口被拒、停用后入口消失、端到端「码 + HMAC 两条证据」（无签名 403 / 绑定 200 / 同码二次 400 / 重放 nonce 403 / 密钥不对 403 / 绑定落在角色 UUID 上 / 改名事件送达插件）、manifest 拒绝非法 id 与 API 版本不匹配。
- SQLite 基线：**418 用例 / 315 pass / 0 fail / 103 skipped**。
- 全门控（PG + Redis + Mailpit）：**418/418 pass / 0 fail / 0 skipped**，插件用例在 PostgreSQL 上同样通过（含 `DELETE ... RETURNING` 的原子消费与 `ON CONFLICT` 建表）。
- 夹具插件 `tests/fixtures/plugins/demo_link` 只 `import type` 自仓库根的 `plugin-api.d.ts`，**不 import 任何核心模块** —— 它是「仓库外作者」的替身，上面第 1 条缺口就是它逼出来的。

## P6 第二批：面板收敛、GitHub 导入，与肉眼验收逼出来的六处缺陷（仅 Dev，未推 master）

### 这一批做了什么

- **面板版式收敛（用户口径）**：卡片只留「描述 + 版本要求」，底部控件恒为 启用/关闭 · 重载 · 设置；入口表、外部依赖、设置表单、服务器密钥全部收进设置弹窗的三个页签。原来一张卡把 5 列入口表 + 3 条依赖告警 + 设置表单全摊在页面上，超管扫一眼就关掉了 —— 台账要能管得住，先得看得完。
- **单插件重载**：`POST /api/admin/plugins/:id/reload`，重读 manifest + 重跑 `setup`，保持启用状态；未启用的插件只重读 manifest，不会因为一次重载就悄悄挂进进程。
- **GitHub 导入**（`src/plugins/importer.ts`）：识别代号标记 + 只接受 tag + 预览/安装两步。信任模型见 `docs/plugin-api-guide.md` §8。

### 肉眼逐屏验收逼出来的六处（每一处都是「后端是对的、界面在撒谎」）

1. **兼容层前缀兜底把 `/api/admin/plugins` 拦成 501**。`apiCompat.ts` 末尾那条「凡没进 `ADMIN_PASSTHROUGH` 的 `/api/admin/*` 一律返回敬请期待」的兜底，文件里本来就写着「新增端点必须同时加白名单」—— 注释是对的，只是没人会去翻。症状极难归因：面板显示「插件目录里没有任何插件」，而直接 curl 是 200 且插件 `ready`。补白名单一项，并加**会红的守卫**：`tests/repoHygiene.test.ts` 扫后端所有 `/api/admin/<资源>`，凡在兼容层毫无提及就失败（实测删掉白名单那一行，守卫立刻报出 `/api/admin/plugins（plugins.ts）`）。
2. **`App.useApp()` 在没有 `<App>` provider 时是静默 no-op**。antd 5.29 的 `AppContext` 默认值是 `{message:{}, notification:{}, modal:{}}`，本站从没挂过 `<App>`，于是 `useApp()` 拿到三个空对象 —— 密钥确实生成了、接口 200，界面上什么都不显示，报错提示也全哑。改用静态 `message` / `Modal.info`（与其余管理页同一写法）。
3. **设置表单永远显示成「什么都没配」**：面板只渲染 `manifest.settings`（只有 key/label/default），而从不调已有的 `GET /api/admin/plugins/:id/settings` —— 当前值在另一个端点里躺着。合并之后，当前值直接填进输入框而不是当 placeholder（灰字提示会被读成「示例值」）。
4. **清空数字框保存会把有效期改成 0**：`Number('') === 0` 且 `Number.isFinite(0)` 为真，于是「我没填」被静默写成「设成 0」。现在 int 与 secret 同口径 —— 空串按「没改」处理。
5. **台账把成功记成错误**：正常停用借 `logError` 记了一笔 `error`，面板唯一该可信的那张表里混进假警报；而启用一次记两条同名 `enable`，两条都不说明「到底挂上没有」。现在 `enable`/`disable` 是**意图**、`load`/`unload` 是**结果**。
6. **弹窗在亮色下白底白字**：站点没有 antd 的 `ConfigProvider` 暗色算法，主题全靠 CSS 覆盖，而亮色覆盖写成 `.layout-page[data-theme="light"] …` —— Modal 是 React portal，挂在 `.layout-page` **外面**，选择器进不去，暗色默认的白色文字就漏进了亮色弹窗。补齐 body 级亮色规则（typography / divider / tabs / table / input-number / alert / badge），另补暗色缺的 `.ant-card-actions`（原本一整条纯白操作条）与 `.ant-input-number`（原本一块白格子）。

### 「重载」到底能做什么（本批最值得记的一条）

想当然的做法是给入口 URL 挂 `?mcsts-reload=N` 绕开 ESM 缓存。**实测不成立**：纯 node 下 query 确实能拿到新模块（`a.count=1, b.count=2`），但 tsx 的解析器会把 `file:` URL 上的 query 与 hash 一起归一掉，两次 import 拿到的是**同一个模块对象**。本站全程用 tsx 跑（没有构建产物），所以重载换不掉代码。

没有把这件事藏进「重载成功」里，而是让它**自证**：导入时记下入口文件的 mtime 与模块对象本体，重载后如果 mtime 变了而 `import()` 回来的还是同一个对象，就标 `staleCode`，面板直说「内存里跑的还是旧代码，需要重启站点」。判定与运行时无关 —— 哪天换成纯 node 跑，模块对象会变，标记自动不出现。测试用「改文件 + 显式把 mtime 推到未来」来断言，不靠写入时序的运气。

### GitHub 导入的取舍

- **识别代号 = 仓库内标记文件** `.mcsts-plugin/<id>.json`，四个字段与 manifest 逐项比对（含 `repository` 必须等于所请求的仓库）。它证明的是「这个仓库认领了这个代号」，**不是**「这份代码无害」—— 后者本来就无法由站点担保（§0 责任边界）。
- **只接受 tag**，并且解析成 commit sha 之后所有取文件都按 sha 走；安装时再解析一次并比对，tag 被重打过就中止。
- 只允许文本扩展名，单文件 ≤ 512 KB / 总量 ≤ 4 MB / 文件数 ≤ 200，出现二进制或未知类型整包被拒；清单被 GitHub 截断（超大仓库）也直接拒。
- 每个文件按 git blob sha 逐字节核对下载结果；装完目录里留一份 `.mcsts-import.json`（仓库、tag、sha、文件哈希、谁在什么时候装的）。
- **安装 = 落盘 + 发现，不自动启用**；已装同名插件必须显式勾选替换才动。
- 上游不通（DNS/连不上/限流）与仓库不合规分成两个码：`PLUGIN_IMPORT_UNREACHABLE` → 502、`PLUGIN_IMPORT_REJECTED` → 400。以前网络异常会冒成 500「内部错误」，超管对着四个字只能猜；现在文案里带出 `err.cause` 的 message 与 code（`fetch failed：Connect Timeout Error … UND_ERR_CONNECT_TIMEOUT`）。

### 接缝清单增补（做废时与第一批一起删）

7. `src/plugins/importer.ts` + `tests/pluginImport.test.ts` + `web/src/pages/Admin/PluginImportModal.tsx`；
8. `src/config.ts`：`plugins.dir` 之外多一个 `githubToken`（读 `MCSTS_GH_TOKEN`）；`bootstrap.ts` 建 `pluginImporter`、`app.ts` 多一个依赖字段与一行传参；
9. `src/errors.ts` 两个码 + `errorHandler.ts` 两行映射（400 / 502）；
10. `src/server/routes/plugins.ts` 的 `reload` / `import/preview` / `import` 三条路由；`registry.ts` 的 `load` / `import` 两个动作与 `logLoaded` / `logUnload` / `logImported` 三个方法。

### 顺手修掉的一处测试卫生问题

`tests/plugins.test.ts` 的端到端用例断言 `bindings.length === 1`，而夹具的 `/bindings` 回的是**全表**，PostgreSQL 用例又共用同一个库、插件表不会在建库时清空 —— 那条断言实际是在断言「这台机器上次跑干净过」，跑第二次就变 3。改成按 `subject` 取自己那条再断言（要验的本来就是「绑定落在这个角色上、远端身份是 xuid-1、且只有一条」）。

### 验收（数字均为实际输出）

- 后端与前端 `tsc` 零错误，web 生产构建通过。
- SQLite 基线：**436 用例 / 331 pass / 0 fail / 105 skipped**（第一批是 418/315/103）。
- 全门控（PG + Redis + Mailpit）：**436/436 pass / 0 fail / 0 skipped**。
- 新增 `tests/pluginImport.test.ts` 14 项：预览清单与标记核对、安装落盘与来源记录、缺标记拒装、标记与 manifest 不一致拒装、二进制文件整包拒、manifest 校验问题原样带出、tag 重打后安装中止、非法仓库名/子目录/未知 tag、monorepo 子目录只取该目录、清单截断即拒、同名已装须显式替换、下载内容与清单不符即中止、上游不通与仓库不合规分码。假 GitHub 端点抽到 `tests/support/fakeGitHub.ts`，两个测试文件共用。
- 新增守卫：`tests/repoHygiene.test.ts`「后端 /api/admin 端点必须被前端兼容层认出」—— 实测把白名单里那行删掉，守卫立刻报出 `/api/admin/plugins（plugins.ts）`。
- 新增 `tests/plugins.test.ts` 两项（双方言共 4 条）：**导入端到端**（空目录 → 预览标记通过 → 安装 3 个文件 → 只到「发现」不自动启用 → 台账留 import 记录 → 启用 → 装进来的插件真的能服务请求 → `.mcsts-import.json` 记的来源正确），以及**重载 stale 判定**。另补台账（enable/load/disable/unload 不混记）、设置读回当前值、int 空串落成 0 的回归。
- 夹具 `tests/fixtures/plugins/demo_link` 的 manifest 补了一个 int 设置项，才让「清空数字框」这条路径可测。
- 浏览器实测（隔离测试实例 :3010 + vite :5174，暗色与亮色各一遍）：卡片三控件、设置弹窗三页签、密钥一次性弹窗、重载提示、导入弹窗对真实 GitHub 的拒绝原因（`插件目录里找不到 mcsts.plugin.json`）均按预期显示。
- 真实 GitHub 冒烟：在一个真实公开仓库（`SunsetNightMoon/spellcardavive`，tag `v0.1.0`）上跑完整链路 —— 预览显示「识别代号已核对」、tag 解析成 commit sha、4 个文件 8.1 KB 带 blob；安装落盘并写出 `.mcsts-import.json`（仓库/tag/sha/谁/何时/逐文件哈希）；**只到「发现」不自动启用**；面板启用后 `GET /api/plugins/smoke_ping/ping` 真的由装进来的代码回包；在面板改该插件的设置项（问候语）后 `/ping` 立刻反映新值。
- 同一次实测还暴露两处：① 上游偶发不通时导入返回 502 且**原因只有一条 3 秒就消失的 toast**，长文案根本来不及看 —— 失败原因改为留在弹窗内的可关闭 Alert；② 该 502 的文案带出了 `err.cause`（`Connect Timeout Error … UND_ERR_CONNECT_TIMEOUT`），与「仓库不合规」的 400 分得开。

## 背景：重制动机（原 README「结论摘要」）

plan3 已经具备可运行产品的主要功能：Yggdrasil 认证兼容、Web 注册登录、角色管理、皮肤和披风上传、审核、公开素材库、收藏、OAuth、Turnstile、Redis 缓存、S3 存储和 Docker 部署。

但它的主要问题不是功能缺失，而是多个演进阶段的实现叠加在一起：

1. 数据库 schema 同时存在迁移文件、安装向导内联 DDL、测试 DDL 和历史迁移脚本四套来源。
2. SQLite 与 PostgreSQL 的字段、类型和令牌结构没有形成一个稳定的跨数据库契约。
3. 认证、上传、权限检查和文件 URL 组装在多个路由中重复实现。
4. 生产 Docker 路径、迁移入口和前端静态文件路径与 Express 运行时约定不完全一致。
5. 前端类型和后端查询结果已经出现漂移，当前前端类型检查存在明确错误。

因此，重制工作的第一目标应是先恢复"单一事实来源"：统一数据模型、统一认证上下文、统一文件对象 URL、统一迁移入口，再逐步迁移现有功能。
