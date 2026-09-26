# MCSTS · MCSkinToServer

[简体中文](README.md) | **繁體中文** | [English](README.en.md) | [日本語](README.ja.md)

Minecraft 外置登入 + 皮膚／披風素材伺服器（Yggdrasil 協相容），`CatTavernSkins`(plan3) 的重製版。

- **目前版本：`2.3.2`**
- 版本口徑：主版本 = 重製標頭（1 = 重製前舊版，2 = 重製版）；次版本 = 季度；修訂號 = 季度內迭代序號。
- 舊版原始碼：https://github.com/SunsetNightMoon/CatTavernSkins （重製分析基準 `b01f29a`，重製未修改舊版原始碼）

## 功能一覽

- **Yggdrasil 外置登入**：`/authserver/*` + `/sessionserver/*` 全端點，HMCL 等啟動器真機驗證；RSA 簽章紋理、中繼資料多字首掛載
- **素材系統**：皮膚／披風上傳（PNG 驗證、sha256 去重、引用計數）、3D 預覽、公開素材庫、審核佇列、收藏、瀏覽／下載計數、權限矩陣（可見度 × 下載策略）
- **帳號體系**：註冊／登入、信箱驗證、找回密碼、改密碼、註銷與 15 天恢復期（UID 不重用）、備用信箱與交叉驗證改信箱、數學題驗證碼（自託管）、封禁（永久／暫時到期自愈）
- **使用者名稱模式**：全站統一 單一／多個 使用者名稱模式（超管單頁切換）、預留角色 + 30 天改名冷卻、名稱池
- **站點管理**：安裝精靈（SQLite／PostgreSQL 二選一、鎖庫不可改、預設語言、完成後行程內軟重啟即時生效）、站點設定（品牌／主題背景／自訂首頁 HTML/CSS／郵件範本）、管理儀表板統計（雙方言聚合 + 時區分桶）
- **基礎設施**：SQLite／PostgreSQL 雙方言同一 canonical schema、版本化遷移 runner、選配 Redis 限流與快取（未設定自動降級行程記憶體，核心功能不受影響）、SMTP 密碼 AES-256-GCM 加密入庫、i18n 四語言（簡中／繁中／英／日）

## 技術棧

| 端 | 技術 |
|---|---|
| 後端 | Node.js ≥ 22、Express 5、TypeScript（tsx 直跑，無編譯產物）、better-sqlite3 / pg、nodemailer、選配 Redis |
| 前端 | Vite 6、React 18、Ant Design 5（直角深色主題）、Zustand、react-router 6（HashRouter）、i18next、skinview3d |

## 快速安裝（本機開發）

需求：Node.js ≥ 22（`better-sqlite3` 為原生模組，換 Node 大版本後需 `npm rebuild better-sqlite3`）。

```bash
# 1. 安裝依賴
npm install
cd web && npm install && cd ..

# 2. 啟動後端（首次無 data/setup.json 時進入安裝模式，僅開放 /api/setup/*）
npm start

# 3. 另開一個終端機啟動前端（:5173，代理 /api、/uploads、/authserver、/sessionserver → :3000）
cd web && npm run dev
```

開啟 `http://localhost:5173`，自動進入**安裝精靈**：選語言 → 資料庫（SQLite 免設定，或 PostgreSQL 填連線）→ 選配 Redis → 選配郵件（SMTP）→ 建立超級管理員。點擊完成後後端在**同一行程內**重建並換綁埠（約幾秒），前端自動重新整理進站。

資料庫類型裝完即鎖，不可變更；換庫需刪除 `data/setup.json` 並重新初始化。

## 建置與正式部署

```bash
# 前端（產物 web/dist，交給反向代理靜態託管）
cd web && npm ci && npm run build

# 後端
npm ci
npm run migrate                          # 遷移失敗會拒絕啟動
node --import tsx src/server/main.ts
```

反向代理要點（Nginx/OpenResty 範例）：

```nginx
root /path/to/MCSTS/web/dist;
location / { try_files $uri $uri/ /index.html; }   # HashRouter 文件入口是 /
location ~ ^/(api|uploads|\.well-known)/ {          # 業務介面 + Yggdrasil + 紋理 + HMCL 命名探測
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- 反代後必須設 `TRUST_PROXY=1`（或反代層數），否則按 IP 限流會把全部用戶算進同一個桶
- 正式環境必配 `MCSTS_SECRET`（≥16 字元）：SMTP 密碼加密主金鑰，未設定則明文入庫；輪換後舊密文無法解密（刻意設計）
- **裸網域不能當認證伺服器位址**（根路徑被 SPA 佔用）：啟動器裡填 `https://<網域>/api/yggdrasil`
- 多實例部署必須配 `REDIS_URL`，否則限流退化為每實例各限一份
- 環境變數完整清單見 `.env.example`，前端變數見 `web/.env.example`

## 測試

```bash
npm test          # SQLite 基線（無需外部服務，門控用例自動 skip）
```

完整測試套件需要本機依賴時可用 `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` 開門控。目前基線：**331/331 pass / 0 fail / 0 skipped**（PG + Redis + Mailpit 全開）。

## 文件

- [第三方登入 Provider 接入指南](docs/oauth-provider-guide.md)

## 貢獻者

- [@SunsetNightMoon](https://github.com/SunsetNightMoon) — 開發與維護
- [@feifei2005](https://github.com/feifei2005) — 新舊版本協助開發（舊版貢獻記錄見 [CatTavernSkins](https://github.com/SunsetNightMoon/CatTavernSkins) 倉庫）

## 授權

[MIT License with Attribution Addendum](LICENSE)（MIT + 署名附加條款）：

- 自由與 MIT 一致：使用、複製、修改、合併、出版、分發、再授權、銷售均免費
- **附加條款**：將本軟體（含修改版）用於對外提供網站／線上服務時，站點前端必須保留清晰可見的「**Powered by MCSkinToServer**」署名，未經書面許可不得移除、遮擋或篡改；僅分發原始碼時仍只受 MIT 標準條件約束

## 致謝

- [Blessing Skin](https://github.com/bs-community/blessing-skin-server) —— 長期以来的優秀 Minecraft 皮膚站專案。本專案作為皮膚站的整體產品形態與方向受其啟發，謹此致謝並尊重該專案帶來的價值。

## AI 協助聲明

本專案在開發過程中使用了 AI 協助，使用的模型及分工如下：

| 模型 | 用途 |
|---|---|
| GPT-6 Astra | 重製版大致方向指導 |
| DeepSeek-v4.1-Flash | 程式碼建構協助 |
| GLM-5.3-Flash | 程式碼建構協助 |
| Qwen3.8-Flash | 程式碼建構協助 |
| Hy3 | 舊版 UI 設計（沿用至今） |

## 工作約定

- 重製以「單一事實來源」為核心目標：統一 schema、統一 AuthContext、統一素材 URL 組裝、統一遷移入口
- 相容 Yggdrasil 外部協定是硬約束；內部實作可以重寫
- 每批完成後同步更新 API、schema、遷移與測試狀態
