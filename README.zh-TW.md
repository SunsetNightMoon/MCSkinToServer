# MCSTS · MCSkinToServer

**繁體中文** | [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

Minecraft 外置登入 + 皮膚／披風素材伺服器（Yggdrasil 協議相容），`CatTavernSkins`(plan3) 的重製版。

- **目前版本：`2.3.6`**
- 版本口徑：主版本 = 重製標頭（1 = 重製前舊版，2 = 重製版）；次版本 = 季度；修訂號 = 季度內迭代序號。
- 舊版原始碼：https://github.com/SunsetNightMoon/CatTavernSkins （重製分析基線 `b01f29a`，重製未修改舊版原始碼）

## 功能一覽

- **Yggdrasil 外置登入**：`/authserver/*` + `/sessionserver/*` 全端點，HMCL 等啟動器真機驗證；RSA 簽章紋理、中繼資料多字首掛載
- **素材系統**：皮膚／披風上傳（PNG 驗證、sha256 去重、引用計數）、3D 預覽、公開素材庫、審核佇列、收藏、瀏覽／下載計數、權限矩陣（可見性 × 下載策略）
- **帳號體系**：註冊／登入、信箱驗證、主／備雙信箱與交叉驗證找回、註銷與 15 天恢復期（UID 不重用）、人機驗證、封禁（永久／暫時到期自愈）
- **使用者名稱模式**：全站統一 單/多 使用者名稱模式（超管單頁切換）、預留角色 + 30 天改名冷卻、名稱池
- **站點管理**：安裝精靈（SQLite/PostgreSQL 二選一、鎖庫不可改、完成後行程內軟重啟即時生效）、站點設定（品牌／主題背景／自訂首頁 HTML/CSS／郵件範本）、管理儀表板統計
- **基礎設施**：SQLite/PostgreSQL 雙方言同一 canonical schema、版本化遷移 runner、選擇性 Redis 限流與快取（未設定自動降級，核心功能不受影響）、憑證類設定加密入庫、i18n 四語言

## 技術棧

| 端 | 技術 |
|---|---|
| 後端 | Node.js ≥ 22、Express 5、TypeScript（tsx 直跑，無編譯產物）、better-sqlite3 / pg、nodemailer、選擇性 Redis |
| 前端 | Vite 6、React 18、Ant Design 5（直角深色主題）、Zustand、react-router 6（HashRouter）、i18next、skinview3d |

## 快速安裝（本機開發）

需要 Node.js ≥ 22（`better-sqlite3` 為原生模組，換 Node 大版本後需 `npm rebuild better-sqlite3`）。

```bash
npm install && (cd web && npm install)
npm start                    # 後端 :3000；首次無 data/setup.json 時進入安裝模式
(cd web && npm run dev)      # 前端 :5173，代理 /api /uploads /authserver /sessionserver
```

開啟 `http://localhost:5173` 進入**安裝精靈**：選語言 → 資料庫 → 選擇性 Redis → 選擇性 SMTP → 建立超級管理員。完成後後端在同一行程內換綁埠，前端自動重新整理進站。資料庫類型裝完即鎖，換庫需刪 `data/setup.json` 重新初始化。

## 建置與正式部署

```bash
(cd web && npm ci && npm run build)   # 產物 web/dist，交給反代靜態託管
npm ci && npm run migrate             # 遷移失敗會拒絕啟動
node --import tsx src/server/main.ts
```

反向代理設定、`TRUST_PROXY`、主金鑰、多實例 Redis、密碼強度、啟動器地址等上線要點見 **[docs/deployment.md](docs/deployment.md)**。環境變數清單見 `.env.example` 與 `web/.env.example`。

Windows 使用者可直接下載**免安裝便攜包**（不含 Node 執行環境，需 Node 22.x/23.x）：見 [Releases](https://github.com/SunsetNightMoon/MCSkinToServer/releases)，解壓後雙擊 `start.cmd`，瀏覽器開啟 `http://localhost:8080`。

## 測試

```bash
npm test          # SQLite 基線，無需外部服務，門控用例自動 skip
```

全門控（PostgreSQL + Redis + Mailpit）用 `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` 開啟。目前基線：**408/408 pass / 0 fail / 0 skipped**。

## 文件

- [正式部署要點](docs/deployment.md) —— 反代、主金鑰、多實例、密碼強度與限流閾值
- [人機驗證](docs/human-verification.md) —— 四種模式的取捨、外部驗證不綁定廠商、失敗語意
- [信箱與帳號找回](docs/account-emails.md) —— 信箱唯一性、備用信箱參與登入、交叉投遞
- [素材跨網域讀取](docs/uploads-cors.md) —— `/uploads` 白名單、CDN 的 `Vary: Origin`、Referer 配方
- [第三方登入 Provider 接入指南](docs/oauth-provider-guide.md)

上述文件目前僅以簡體中文撰寫。


## 貢獻者

- [@SunsetNightMoon](https://github.com/SunsetNightMoon) — 開發與維護
- [@feifei2005](https://github.com/feifei2005) — 新舊版本協助開發（舊版貢獻紀錄見 [CatTavernSkins](https://github.com/SunsetNightMoon/CatTavernSkins) 倉庫）

## 授權

[MIT License with Attribution Addendum](LICENSE)（MIT + 署名附加條款）：自由與 MIT 一致，但將本軟體（含修改版）用於對外提供網站／線上服務時，站點前端必須保留清晰可見的「**Powered by MCSkinToServer**」署名，未經書面許可不得移除、遮擋或竄改；僅分發原始碼時只受 MIT 標準條件約束。

## 致謝

- [Blessing Skin](https://github.com/bs-community/blessing-skin-server) —— 長期以來的優秀 Minecraft 皮膚站專案。本專案作為皮膚站的整體產品形態與方向受其啟發，謹此致謝並尊重該專案帶來的價值。

## AI 協助聲明

本專案在開發過程中使用了 AI 協助：

| 模型 | 用途 |
|---|---|
| GPT-6 Astra | 重製版大致方向指導 |
| DeepSeek-v4.1-Flash / GLM-5.3-Flash / Qwen3.8-Flash | 程式碼建構協助 |
| Hy3 | 舊版 UI 設計（沿用至今） |

## 工作約定

- 重製以「單一事實來源」為核心目標：統一 schema、統一 AuthContext、統一素材 URL 組裝、統一遷移入口
- 相容 Yggdrasil 外部協議是硬約束；內部實作可以重寫
- 每批完成後同步更新 API、schema、遷移與測試狀態
