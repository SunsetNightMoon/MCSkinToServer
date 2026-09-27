# MCSTS · MCSkinToServer

**简体中文** | [繁體中文](README.zh-TW.md) | [English](README.en.md) | [日本語](README.ja.md)

Minecraft 外置登录 + 皮肤/披风素材服务器（Yggdrasil 协议兼容），`CatTavernSkins`(plan3) 的重制版。

- **当前版本：`2.3.6`**
- 版本口径：主版本 = 重制标头（1 = 重制前旧版，2 = 重制版）；次版本 = 季度；修订号 = 季度内迭代序号。
- 旧版源码：https://github.com/SunsetNightMoon/CatTavernSkins （重制分析基线 `b01f29a`，重制未修改旧版源码）

## 功能一览

- **Yggdrasil 外置登录**：`/authserver/*` + `/sessionserver/*` 全端点，HMCL 等启动器真机验证；RSA 签名纹理、元数据多前缀挂载
- **素材系统**：皮肤/披风上传（PNG 校验、sha256 去重、引用计数）、3D 预览、公开素材库、审核队列、收藏、浏览/下载计数、权限矩阵（可见性 × 下载策略）
- **账号体系**：注册/登录、邮箱验证、找回密码（主/备邮箱交叉投递）、改密码、注销与 15 天恢复期（UID 不复用）、备用邮箱（验证后可用于网页与启动器登录）、交叉验证改邮箱、人机验证（不启用 / 数学题 / 服务端图片 / 外部验证服务）、封禁（永久/临时到期自愈）
- **用户名模式**：全站统一 单/多 用户名模式（超管单页切换），预留角色 + 30 天改名冷却，名称池
- **站点管理**：安装向导（SQLite/PostgreSQL 二选一、锁库不可改、默认语言、完成后进程内软重启即时生效）、站点设置（品牌/主题背景/自定义首页 HTML/CSS/邮件模板）、管理仪表盘统计（双方言聚合 + 时区分桶）
- **基础设施**：SQLite/PostgreSQL 双方言同一 canonical schema、版本化迁移 runner、可选 Redis 限流与缓存（未配置自动降级进程内存，核心功能不受影响）、SMTP 口令 AES-256-GCM 加密入库、i18n 四语言（简中/繁中/英/日）

## 技术栈

| 端 | 技术 |
|---|---|
| 后端 | Node.js ≥ 22、Express 5、TypeScript（tsx 直跑，无编译产物）、better-sqlite3 / pg、nodemailer、可选 Redis |
| 前端 | Vite 6、React 18、Ant Design 5（直角深色主题）、Zustand、react-router 6（HashRouter）、i18next、skinview3d |

## 快速安装（本地开发）

要求：Node.js ≥ 22（`better-sqlite3` 为原生模块，换 Node 大版本后需 `npm rebuild better-sqlite3`）。

```bash
# 1. 安装依赖
npm install
cd web && npm install && cd ..

# 2. 启动后端（首次无 data/setup.json 时进入安装模式，只开放 /api/setup/*）
npm start

# 3. 另开一个终端启动前端（:5173，代理 /api、/uploads、/authserver、/sessionserver → :3000）
cd web && npm run dev
```

打开 `http://localhost:5173`，自动进入**安装向导**：选语言 → 数据库（SQLite 免配置，或 PostgreSQL 填连接）→ 可选 Redis → 可选邮件（SMTP）→ 创建超级管理员。点击完成后后端在**同一进程内**重建并换绑端口（约几秒），前端自动刷新进站。

数据库类型装完即锁，不可更改；换库需删除 `data/setup.json` 并重新初始化。

## 构建与生产部署

```bash
# 前端（产物 web/dist，交给反代静态托管）
cd web && npm ci && npm run build

# 后端
npm ci
npm run migrate                          # 迁移失败会拒绝启动
node --import tsx src/server/main.ts
```

反向代理要点（Nginx/OpenResty 示例）：

```nginx
root /path/to/MCSTS/web/dist;
location / { try_files $uri $uri/ /index.html; }   # HashRouter 文档入口是 /
# 启动器填裸域名时靠 ALI 头发现 API 地址：根路径由 SPA 接管，后端的响应头到不了这里
location = / { add_header X-Authlib-Injector-API-Location /api/yggdrasil always; try_files /index.html =404; }
location ~ ^/(api|uploads|\.well-known)/ {          # 业务接口 + Yggdrasil + 纹理 + ALI 风格元数据
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- 反代后必须设 `TRUST_PROXY=1`（或反代层数），否则按 IP 限流把全部用户算进同一个桶
- 生产必配 `MCSTS_SECRET`（≥16 字符）：站点设置里凭据类键（`SMTP_PASS`、`EXTERNAL_CAPTCHA_SECRET`）的加密主密钥，未设置则明文落库；轮换后旧密文无法解密（刻意设计）
- **认证服务器地址填 `https://<域名>/api/yggdrasil` 最稳**；加了上面的 ALI 头后裸域名也能被启动器解析。站点显示名来自元数据的 `meta.serverName`（即站点标题），改标题后需在启动器账户页点刷新重取元数据
- 多实例部署必须配 `REDIS_URL`，否则限流退化为每实例各限一份
- 密码强度由 `BCRYPT_COST` 决定（缺省 10，钳制 10-14；越界钳制/回落并打警告，不会让服务起不来）。调高后**存量账号在下次登录成功时自动重算**（cost 就写在哈希串里，此刻明文可用），不必强制改密码；调低不降级。代价是纯 JS 实现下 cost 每 +1 耗时约翻倍：本机实测登录一次从约 80ms（cost 10）变约 340ms（cost 12），低配 VPS 更慢，所以默认值保持不变、由管理员按机器自行决定
- 匿名协议端点 `POST /api/profiles/minecraft`（角色名 → UUID）按来源 IP 限流，缺省 60 次/分钟：不限流就等于允许无限速遍历全站角色名与 UUID，而阈值再紧就会误伤进服时的正常客户端与共用出口地址，所以取宽松值。所有按 IP 的限流都依赖 `TRUST_PROXY` 配好
- 环境变量完整清单见 `.env.example`，前端变量见 `web/.env.example`

## 邮箱与账号找回

每个账号有主邮箱与一个可选的备用邮箱，两条口径值得单独说明。

**一个邮箱只绑一个号。** 数据库对 `lower(email)` 与 `lower(backup_email)` 各建唯一索引，所以同类重复直接被 DB 拦；但**跨列**（A 的主邮箱同时是 B 的备用邮箱）索引管不到，靠应用层查重：注册、绑备用邮箱、改邮箱三条路径都会查对方的两个槽位。万一历史数据已经造出冲突，登录**不会任选一个账号**，而是两边都按凭据错误收口 —— 否则那个地址就变成「猜中即登进某个号」的入口。

**已验证的备用邮箱是登录凭据。** 网页登录与启动器的 `authenticate` / `signout` 都接受它，大小写不敏感；用备用邮箱登录时视为满足「要求邮箱验证」这道门槛（备用邮箱存在的意义就是主邮箱收不到信时的兜底，再卡主邮箱等于把兜底堵死）。**未验证的备用邮箱不参与认证** —— 「已绑但未验证」是刷号方最爱下手的状态，给它认证能力等于开无限量入口。

**找回密码交叉投递。** 主邮箱或已验证的备用邮箱都能发起；账号有另一个已验证邮箱时，重置邮件发到**那个**邮箱，于是单个信箱失守（被拖库、被盗、长期不看）不再足以改密码。另一槽位不存在或未验证时回落到同槽投递，否则这类账号只能找超管人工处理。同理，交叉投递的重置**不会**顺带把主邮箱标成已验证 —— 那封邮件证明的是备用信箱的归属。

**已知缺口（供后续收紧）。** 登录限流按**提交的地址**分桶，因此同一账号有主/备两个独立桶，等于把「对同一账号猜密码」的配额翻倍。收紧方向是把桶归一到解析出的账号 ID，需要在认证路径内计数，本批未做。

## 人机验证

注册与登录用哪种人机验证，在「管理面板 → 系统设置 → 注册设置」里选，取值存在站点设置 `CAPTCHA_TYPE`：`none` / `math` / `image` / `external`。老站点只写过布尔 `ENABLE_CAPTCHA` 时按 `true → math`、`false → none` 推导，升级不改变既有行为。

| 方式 | 是否出网 | 访客 IP 去向 | 定位 |
|---|---|---|---|
| `math` 数学题 | 否 | 本站 | 题干明文下发，只挡不解析响应的脚本 |
| `image` 图片题 | 否 | 本站 | 题干只出现在 PNG 里，挡读 JSON 的脚本 |
| `external` 外部服务 | 是 | 所配置的校验端点 | 由所选服务决定，能对抗真实自动化 |

- 自托管两种（`math` / `image`）都只用于**拦脚本**，对打码平台和人工注册无效；优点是零外部依赖、零合规负担。图片题由 sharp 在本机用矢量笔画绘制，不联网、不读取系统字体（精简容器里没字体也不会画成空白图），因此不会出现「部分机器上验证码永远答不对」。
- `external` 刻意做成「预设 + 全部可改」，不绑定厂商：选 Cloudflare Turnstile / hCaptcha / Google reCAPTCHA 只是把推荐值填进 `EXTERNAL_CAPTCHA_VERIFY_URL` / `EXTERNAL_CAPTCHA_SCRIPT_URL` / `EXTERNAL_CAPTCHA_GLOBAL_NAME`，三项任一项都能改成自建中转或其他可达地址；`custom` 预设表示三项全部自己给。
- 需要厂商签名的服务（腾讯天御、阿里云人机验证、网易易盾、GeeTest v4）不符合本项目使用的「表单 POST + 布尔 `success`」共同形状，未内置；扩展位是 `src/account/externalCaptcha.ts` 的校验入口。
- 前端脚本地址受站点 CSP 约束时，需把该域名加入 `script-src`。
- 校验密钥 `EXTERNAL_CAPTCHA_SECRET` 与 SMTP 口令同等待遇：AES-256-GCM 加密入库、管理端只回 `<KEY>_SET` 标志、公开端点不下发，留空保存不会清空已存密钥。
- 外部端点不可达时注册/登录返回 **502 `CAPTCHA_UNAVAILABLE`**，绝不静默放行；答案错或 token 过期是 400 `CAPTCHA_INVALID`，用户换一道即可。
- 出题限流 `CAPTCHA_GENERATE_RATE_LIMIT_*`（默认 10 次 / 5 分钟 / 来源地址）由数学题与图片题共用，换条路刷不出额外配额。

## 素材跨源读取

`/uploads` 的纹理默认**只对同源与站点自身来源**开放跨源读取。此前这里写死 `Access-Control-Allow-Origin: *`，等于允许任何站点的脚本把本站素材读进 canvas 原样抠走。

- 站点设置 `UPLOAD_CORS_ORIGINS`：逗号或换行分隔的来源列表（只写域名按 `https://` 处理）。留空 = 最严；填 `*` = 退回全放行。认不出的项被逐项丢弃，不会让整条白名单失效。
- 同源判定用请求自己的 `Host`，不依赖 `BASE_URL` 是否配置 —— 管理员没配站点根时，自家头像与 3D 预览也不该因此图裂。
- **素材挂在独立图床/CDN 域名下时，必须把页面所在来源写进白名单**，否则 `crossOrigin="anonymous"` 的纹理会直接加载失败（不只是画布被污染）。
- `/uploads` 的响应一律带 `Vary: Origin`。前置 CDN/反代若**不按 Origin 分键**，会把 A 来源的响应缓存后发给 B 来源，表现为「我这边好、他那边图裂」。做不到就三选一：素材与页面同源、给 `/uploads` 关掉 CDN 缓存、或退回 `*`。
- 这**不是热链防护**：`<img>` 引用图片不走 CORS，别人嵌图照样显示、带宽照样消耗。

### 要防热链（Referer）该怎么做

热链只能靠网关/CDN 按 Referer 判定，本仓库刻意不实现（每台主机的策略不同，属个例）。nginx 示例：

```nginx
location ~ ^/uploads/ {
  # 无 Referer 必须放行：直接打开、隐私模式、Referrer-Policy 降级都没有 Referer
  valid_referers none blocked server_names ~\.example\.com$;
  if ($invalid_referer) { return 403; }
  proxy_pass http://mcsts_backend;   # 或 alias 到本地目录
}
```

三条边界：Referer 只是请求头，非浏览器客户端可以随便填，**挡君子不挡小人**；Yggdrasil 客户端取纹理同样可能不带 Referer，规则要按 `location` 精确圈定，别把启动器一起挡了；要更硬就换签名 URL / 时效 token，那要改整条素材链路，不在静态目录这一层。

## 测试

```bash
npm test          # SQLite 基线（无需外部服务，门控用例自动 skip）
```

全量套件需要本地依赖时可用 `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` 开门控。当前基线：**408/408 pass / 0 fail / 0 skipped**（PG + Redis + Mailpit 全开）。

## 文档

- [第三方登录 Provider 接入指南](docs/oauth-provider-guide.md)

## 贡献者

- [@SunsetNightMoon](https://github.com/SunsetNightMoon) — 开发与维护
- [@feifei2005](https://github.com/feifei2005) — 新旧版本协助开发（旧版贡献记录见 [CatTavernSkins](https://github.com/SunsetNightMoon/CatTavernSkins) 仓库）

## 许可

[MIT License with Attribution Addendum](LICENSE)（MIT + 署名附加条款）：

- 自由与 MIT 一致：使用、复制、修改、合并、出版、分发、再许可、销售均免费
- **附加条款**：将本软件（含修改版）用于对外提供网站/在线服务时，站点前端必须保留清晰可见的「**Powered by MCSkinToServer**」署名，未经书面许可不得移除、遮挡或篡改；仅分发源代码时只受 MIT 标准条件约束

## 致谢

- [Blessing Skin](https://github.com/bs-community/blessing-skin-server) —— 长期以来的优秀 Minecraft 皮肤站项目。本项目作为皮肤站的整体产品形态与方向受其启发，谨此致谢并尊重该项目带来的价值。

## AI 协助声明

本项目在开发过程中使用了 AI 协助，使用的模型及分工如下：

| 模型 | 用途 |
|---|---|
| GPT-6 Astra | 重制版大致方向指导 |
| DeepSeek-v4.1-Flash | 代码构建协助 |
| GLM-5.3-Flash | 代码构建协助 |
| Qwen3.8-Flash | 代码构建协助 |
| Hy3 | 旧版 UI 设计（沿用至今） |

## 工作约定

- 重制以「单一事实来源」为核心目标：统一 schema、统一 AuthContext、统一素材 URL 组装、统一迁移入口
- 兼容 Yggdrasil 外部协议是硬约束；内部实现可以重写
- 每批完成后同步更新 API、schema、迁移与测试状态
