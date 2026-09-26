# MCSTS · MCSkinToServer

**简体中文** | [繁體中文](README.zh-TW.md) | [English](README.en.md) | [日本語](README.ja.md)

Minecraft 外置登录 + 皮肤/披风素材服务器（Yggdrasil 协议兼容），`CatTavernSkins`(plan3) 的重制版。

- **当前版本：`2.3.2`**
- 版本口径：主版本 = 重制标头（1 = 重制前旧版，2 = 重制版）；次版本 = 季度；修订号 = 季度内迭代序号。
- 旧版源码：https://github.com/SunsetNightMoon/CatTavernSkins （重制分析基线 `b01f29a`，重制未修改旧版源码）

## 功能一览

- **Yggdrasil 外置登录**：`/authserver/*` + `/sessionserver/*` 全端点，HMCL 等启动器真机验证；RSA 签名纹理、元数据多前缀挂载
- **素材系统**：皮肤/披风上传（PNG 校验、sha256 去重、引用计数）、3D 预览、公开素材库、审核队列、收藏、浏览/下载计数、权限矩阵（可见性 × 下载策略）
- **账号体系**：注册/登录、邮箱验证、找回密码、改密码、注销与 15 天恢复期（UID 不复用）、备用邮箱与交叉验证改邮箱、数学题验证码（自托管）、封禁（永久/临时到期自愈）
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
location ~ ^/(api|uploads|\.well-known)/ {          # 业务接口 + Yggdrasil + 纹理 + HMCL 命名探测
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- 反代后必须设 `TRUST_PROXY=1`（或反代层数），否则按 IP 限流把全部用户算进同一个桶
- 生产必配 `MCSTS_SECRET`（≥16 字符）：SMTP 口令加密主密钥，未设置则明文落库；轮换后旧密文无法解密（刻意设计）
- **裸域名不能当认证服务器地址**（根路径被 SPA 占用）：启动器里填 `https://<域名>/api/yggdrasil`
- 多实例部署必须配 `REDIS_URL`，否则限流退化为每实例各限一份
- 环境变量完整清单见 `.env.example`，前端变量见 `web/.env.example`

## 测试

```bash
npm test          # SQLite 基线（无需外部服务，门控用例自动 skip）
```

全量套件需要本地依赖时可用 `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` 开门控。当前基线：**331/331 pass / 0 fail / 0 skipped**（PG + Redis + Mailpit 全开）。

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
