# MCSTS · MCSkinToServer

**简体中文** | [繁體中文](README.zh-Hant.md) | [English](README.en.md) | [日本語](README.ja.md)

Minecraft 外置登录 + 皮肤/披风素材服务器（Yggdrasil 协议兼容），`CatTavernSkins`(plan3) 的重制版。

- **当前版本：`2.3.6`**
- 版本口径：主版本 = 重制标头（1 = 重制前旧版，2 = 重制版）；次版本 = 季度；修订号 = 季度内迭代序号。
- 旧版源码：https://github.com/SunsetNightMoon/CatTavernSkins （重制分析基线 `b01f29a`，重制未修改旧版源码）

## 功能一览

- **Yggdrasil 外置登录**：`/authserver/*` + `/sessionserver/*` 全端点，HMCL 等启动器真机验证；RSA 签名纹理、元数据多前缀挂载
- **素材系统**：皮肤/披风上传（PNG 校验、sha256 去重、引用计数）、3D 预览、公开素材库、审核队列、收藏、浏览/下载计数、权限矩阵（可见性 × 下载策略）
- **账号体系**：注册/登录、邮箱验证、主/备双邮箱与交叉验证找回、注销与 15 天恢复期（UID 不复用）、人机验证、封禁（永久/临时到期自愈）
- **用户名模式**：全站统一 单/多 用户名模式（超管单页切换），预留角色 + 30 天改名冷却，名称池
- **站点管理**：安装向导（SQLite/PostgreSQL 二选一、锁库不可改、完成后进程内软重启即时生效）、站点设置（品牌/主题背景/自定义首页 HTML/CSS/邮件模板）、管理仪表盘统计
- **基础设施**：SQLite/PostgreSQL 双方言同一 canonical schema、版本化迁移 runner、可选 Redis 限流与缓存（未配置自动降级，核心功能不受影响）、凭据类设置加密入库、i18n 四语言

## 技术栈

| 端 | 技术 |
|---|---|
| 后端 | Node.js ≥ 22、Express 5、TypeScript（tsx 直跑，无编译产物）、better-sqlite3 / pg、nodemailer、可选 Redis |
| 前端 | Vite 6、React 18、Ant Design 5（直角深色主题）、Zustand、react-router 6（HashRouter）、i18next、skinview3d |

## 快速开始（本地开发）

要求 Node.js ≥ 22（`better-sqlite3` 是原生模块，换 Node 大版本后要 `npm rebuild better-sqlite3`）。

```bash
npm install && (cd web && npm install)
npm start                    # 后端 :3000；首次无 data/setup.json 时进入安装模式
(cd web && npm run dev)      # 前端 :5173，代理 /api /uploads /authserver /sessionserver
```

打开 `http://localhost:5173` 进入**安装向导**：选语言 → 数据库 → 可选 Redis → 可选 SMTP → 建超管。完成后后端在同一进程内换绑端口，前端自动刷新进站。数据库类型装完即锁，换库需删 `data/setup.json` 重新初始化。

## 构建与生产部署

```bash
(cd web && npm ci && npm run build)   # 产物 web/dist，交给反代静态托管
npm ci && npm run migrate             # 迁移失败会拒绝启动
node --import tsx src/server/main.ts
```

反向代理配置、`TRUST_PROXY`、主密钥、多实例 Redis、密码强度、启动器地址等上线要点见 **[docs/deployment.md](docs/deployment.md)**。环境变量清单见 `.env.example` 与 `web/.env.example`。

Windows 用户可直接下载**免安装便携包**（不含 Node 运行环境，需 Node 22.x/23.x）：见 [Releases](https://github.com/SunsetNightMoon/MCSkinToServer/releases)，解压双击 `start.cmd`，浏览器打开 `http://localhost:8080`。

## 测试

```bash
npm test          # SQLite 基线，无需外部服务，门控用例自动 skip
```

全门控（PostgreSQL + Redis + Mailpit）用 `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` 打开。当前基线：**408/408 pass / 0 fail / 0 skipped**。

## 文档

- [生产部署要点](docs/deployment.md) —— 反代、主密钥、多实例、密码强度与限流阈值
- [人机验证](docs/human-verification.md) —— 四种模式的取舍、外部验证不绑定厂商、失败语义
- [邮箱与账号找回](docs/account-emails.md) —— 邮箱唯一性、备用邮箱参与登录、交叉投递
- [素材跨源读取](docs/uploads-cors.md) —— `/uploads` 白名单、CDN 的 `Vary: Origin`、Referer 配方
- [第三方登录 Provider 接入指南](docs/oauth-provider-guide.md)


## 贡献者

- [@SunsetNightMoon](https://github.com/SunsetNightMoon) — 开发与维护
- [@feifei2005](https://github.com/feifei2005) — 新旧版本协助开发（旧版贡献记录见 [CatTavernSkins](https://github.com/SunsetNightMoon/CatTavernSkins) 仓库）

## 许可

[MIT License with Attribution Addendum](LICENSE)（MIT + 署名附加条款）：自由与 MIT 一致，但将本软件（含修改版）用于对外提供网站/在线服务时，站点前端必须保留清晰可见的「**Powered by MCSkinToServer**」署名，未经书面许可不得移除、遮挡或篡改；仅分发源代码时只受 MIT 标准条件约束。

## 致谢

- [Blessing Skin](https://github.com/bs-community/blessing-skin-server) —— 长期以来的优秀 Minecraft 皮肤站项目。本项目作为皮肤站的整体产品形态与方向受其启发，谨此致谢并尊重该项目带来的价值。

## AI 协助声明

本项目在开发过程中使用了 AI 协助：

| 模型 | 用途 |
|---|---|
| GPT-6 Astra | 重制版大致方向指导 |
| DeepSeek-v4.1-Flash / GLM-5.3-Flash / Qwen3.8-Flash | 代码构建协助 |
| Hy3 | 旧版 UI 设计（沿用至今） |

## 工作约定

- 重制以「单一事实来源」为核心目标：统一 schema、统一 AuthContext、统一素材 URL 组装、统一迁移入口
- 兼容 Yggdrasil 外部协议是硬约束；内部实现可以重写
- 每批完成后同步更新 API、schema、迁移与测试状态
