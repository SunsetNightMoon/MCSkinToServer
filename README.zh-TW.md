# MCSTS · MCSkinToServer

[简体中文](README.md) | **繁體中文** | [English](README.en.md) | [日本語](README.ja.md)

Minecraft 外置登入 + 皮膚／披風素材伺服器（Yggdrasil 協相容），`CatTavernSkins`(plan3) 的重製版。

- **目前版本：`2.3.5`**
- 版本口徑：主版本 = 重製標頭（1 = 重製前舊版，2 = 重製版）；次版本 = 季度；修訂號 = 季度內迭代序號。
- 舊版原始碼：https://github.com/SunsetNightMoon/CatTavernSkins （重製分析基準 `b01f29a`，重製未修改舊版原始碼）

## 功能一覽

- **Yggdrasil 外置登入**：`/authserver/*` + `/sessionserver/*` 全端點，HMCL 等啟動器真機驗證；RSA 簽章紋理、中繼資料多字首掛載
- **素材系統**：皮膚／披風上傳（PNG 驗證、sha256 去重、引用計數）、3D 預覽、公開素材庫、審核佇列、收藏、瀏覽／下載計數、權限矩陣（可見度 × 下載策略）
- **帳號體系**：註冊／登入、信箱驗證、找回密碼、改密碼、註銷與 15 天恢復期（UID 不重用）、備用信箱與交叉驗證改信箱、人機驗證（不啟用 / 數學題 / 服務端圖片 / 外部驗證服務）、封禁（永久／暫時到期自愈）
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
# 啟動器填裸域名時靠 ALI 頭發現 API 位址：根路徑由 SPA 接管，後端的回應頭到不了這裡
location = / { add_header X-Authlib-Injector-API-Location /api/yggdrasil always; try_files /index.html =404; }
location ~ ^/(api|uploads|\.well-known)/ {          # 業務介面 + Yggdrasil + 紋理 + ALI 風格元資料
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- 反代後必須設 `TRUST_PROXY=1`（或反代層數），否則按 IP 限流會把全部用戶算進同一個桶
- 正式環境必配 `MCSTS_SECRET`（≥16 字元）：憑證類設定鍵（`SMTP_PASS`、`EXTERNAL_CAPTCHA_SECRET`）的加密主金鑰，未設定則明文入庫；輪換後舊密文無法解密（刻意設計）
- **認證伺服器位址填 `https://<網域>/api/yggdrasil` 最穩**；加了上面的 ALI 頭後裸網域也能被啟動器解析。站點顯示名來自元資料的 `meta.serverName`（即站點標題），改標題後需在啟動器帳戶頁點重新整理重取元資料
- 多實例部署必須配 `REDIS_URL`，否則限流退化為每實例各限一份
- 密碼強度由 `BCRYPT_COST` 決定（預設 10，鉗制 10-14；越界會鉗制/回落並打一條警告，不會讓服務起不來）。調高後**存量帳號在下次登入成功時自動重算**（cost 就寫在雜湊字串裡，而那一刻明文正在手上），不必強制改密碼；調低不會把已有雜湊降級。代價是純 JS 實作下 cost 每 +1 耗時約翻倍：本機實測登入一次從約 80ms（cost 10）變約 340ms（cost 12），低配 VPS 更慢，所以預設值不動、由管理員按自己的機器決定
- 匿名協議端點 `POST /api/profiles/minecraft`（角色名 → UUID）按來源 IP 限流，預設 60 次/分鐘：不限流等於允許無限速遍歷全站角色名與 UUID，而閾值收緊就會誤傷進服時的正常客戶端與共用出口地址，所以取寬鬆值。所有按 IP 計的限流都依賴 `TRUST_PROXY` 配對
- 環境變數完整清單見 `.env.example`，前端變數見 `web/.env.example`

## 人機驗證

註冊與登入要用哪種人機驗證，在「管理面板 → 系統設定 → 註冊設定」裡選，取值存在站點設定 `CAPTCHA_TYPE`：`none` / `math` / `image` / `external`。舊站點只寫過布林 `ENABLE_CAPTCHA` 時按 `true → math`、`false → none` 推導，升級不改變既有行為。

| 方式 | 是否出網 | 訪客 IP 去向 | 定位 |
|---|---|---|---|
| `math` 數學題 | 否 | 本站 | 題干明文下發，只擋不解析回應的腳本 |
| `image` 圖片題 | 否 | 本站 | 題干只出現在 PNG 裡，擋讀 JSON 的腳本 |
| `external` 外部服務 | 是 | 所設定的驗證端點 | 由所選服務決定，能對抗真實自動化 |

- 自託管兩種（`math` / `image`）都只用於**攔腳本**，對打碼平台和人工註冊無效；好處是零外部依賴、零合規負擔。圖片題由 sharp 在本機以向量筆畫繪製，不連線、不讀取系統字型（精簡容器裡沒字型也不會畫成空白圖），因此不會出現「部分機器上驗證碼永遠答不對」。
- `external` 刻意做成「預設 + 全部可改」，不綁定廠商：選 Cloudflare Turnstile / hCaptcha / Google reCAPTCHA 只是把推薦值填進 `EXTERNAL_CAPTCHA_VERIFY_URL` / `EXTERNAL_CAPTCHA_SCRIPT_URL` / `EXTERNAL_CAPTCHA_GLOBAL_NAME`，三項任一項都能改成自建中繼或其他可達地址；`custom` 預設表示三項全部自己給。
- 需要廠商簽名的服務（騰訊天御、阿里雲人機驗證、網易易盾、GeeTest v4）不符合本專案使用的「表單 POST + 布林 `success`」共同形狀，未內建；擴展位是 `src/account/externalCaptcha.ts` 的驗證入口。
- 前端腳本地址受站點 CSP 約束時，需把該網域加入 `script-src`。
- 驗證金鑰 `EXTERNAL_CAPTCHA_SECRET` 與 SMTP 密碼同等待遇：AES-256-GCM 加密入庫、管理端只回 `<KEY>_SET` 旗標、公開端點不下發，留空儲存不會清空已存金鑰。
- 外部端點不可達時註冊/登入回傳 **502 `CAPTCHA_UNAVAILABLE`**，絕不靜默放行；答案錯誤或 token 過期是 400 `CAPTCHA_INVALID`，使用者換一道即可。
- 出題限流 `CAPTCHA_GENERATE_RATE_LIMIT_*`（預設 10 次 / 5 分鐘 / 來源地址）由數學題與圖片題共用，換條路刷不出額外配額。

## 素材跨網域讀取

`/uploads` 的紋理預設**僅對同網域與站點自身來源**開放跨網域讀取。此前這裡寫死 `Access-Control-Allow-Origin: *`，等於允許任何站點的腳本把本站素材讀進 canvas 原樣摳走。

- 站點設定 `UPLOAD_CORS_ORIGINS`：逗號或換行分隔的來源清單（僅寫網域按 `https://` 處理）。留空 = 最嚴；填 `*` = 退回全放行。認不出的項會被逐項丟棄，不會讓整條白名單失效。
- 同網域判定用請求自己的 `Host`，不依賴 `BASE_URL` 是否設定 —— 管理員沒填站點根時，自家頭像與 3D 預覽也不該因此圖裂。
- **素材掛在獨立圖床/CDN 網域下時，必須把頁面所在來源寫進白名單**，否則 `crossOrigin="anonymous"` 的紋理會直接載入失敗（不只是畫布被污染）。
- `/uploads` 的回應一律帶 `Vary: Origin`。前置 CDN/反代若**不按 Origin 分鍵**，會把 A 來源的回應快取後發給 B 來源，表現為「我這邊好、他那邊圖裂」。做不到就三選一：素材與頁面同網域、給 `/uploads` 關掉 CDN 快取、或退回 `*`。
- 這**不是熱鏈防護**：`<img>` 引用圖片不走 CORS，他人嵌圖照樣顯示、頻寬照樣消耗。

### 要防熱鏈（Referer）該怎麼做

熱鏈只能靠閘道/CDN 依 Referer 判定，本倉庫刻意不實作（每台主機的策略不同，屬個例）。nginx 範例：

```nginx
location ~ ^/uploads/ {
  # 無 Referer 必須放行：直接開啟、隱私模式、Referrer-Policy 降級都沒有 Referer
  valid_referers none blocked server_names ~\.example\.com$;
  if ($invalid_referer) { return 403; }
  proxy_pass http://mcsts_backend;   # 或 alias 到本機目錄
}
```

三條邊界：Referer 只是請求標頭，非瀏覽器客戶端可以隨便填，**擋君子不擋小人**；Yggdrasil 客戶端取紋理同樣可能不帶 Referer，規則要按 `location` 精確圈定，別把啟動器一起擋了；要更硬就換簽名 URL / 時效 token，那要改整條素材鏈路，不在靜態目錄這一層。

## 測試

```bash
npm test          # SQLite 基線（無需外部服務，門控用例自動 skip）
```

完整測試套件需要本機依賴時可用 `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` 開門控。目前基線：**392/392 pass / 0 fail / 0 skipped**（PG + Redis + Mailpit 全開）。

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
