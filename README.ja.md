# MCSTS · MCSkinToServer

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | [English](README.en.md) | **日本語**

Minecraft アカウント外付けログイン + スキン／マントテクスチャサーバー（Yggdrasil プロトコル互換）。`CatTavernSkins`(plan3) の再構築版です。

- **現在のバージョン：`2.3.2`**
- バージョン規則：メジャー = 再構築ヘッダー（1 = 再構築前の旧版、2 = 再構築版）；マイナー = 四半期；パッチ = 四半期内のイテレーション番号。
- 旧版ソース：https://github.com/SunsetNightMoon/CatTavernSkins （分析ベースライン `b01f29a`、再構築により旧版ソースは変更していません）

## 機能一覧

- **Yggdrasil 外付けログイン**：`/authserver/*` + `/sessionserver/*` 全エンドポイント、HMCL 等のランチャーで実機検証済み；RSA 署名テクスチャ、メタデータの複数プレフィックスマウント
- **アセットシステム**：スキン／マントのアップロード（PNG 検証、sha256 重複排除、参照カウント）、3D プレビュー、公開ライブラリ、審査キュー、お気に入り、閲覧／ダウンロードカウント、権限マトリクス（公開設定 × ダウンロードポリシー）
- **アカウント体系**：登録／ログイン、メール認証、パスワード再設定・変更、退会と 15 日の復旧期間（UID は再利用なし）、バックアップメールと相互認証によるメール変更、算数式キャプチャ（セルフホスト）、BAN（永久／一時は期限切れで自動解除）
- **ユーザー名モード**：サイト全体の単一／複数ユーザー名モード（スーパー管理者が 1 ページで切替）、予約プロフィール + 30 日の名前変更クールダウン、名前プール
- **サイト管理**：インストールウィザード（SQLite／PostgreSQL の二者択一、インストール後はロック、デフォルト言語、完了後にプロセス内ソフトリブートで即時反映）、サイト設定（ブランド／テーマ背景／カスタムトップページ HTML/CSS／メールテンプレート）、管理ダッシュボード統計（二方言集計 + タイムゾーンバケット）
- **インフラ**：SQLite／PostgreSQL 二方言で同一の canonical スキーマ、バージョン管理マイグレーションランナー、任意で Redis のレート制限とキャッシュ（未設定ならプロセス内メモリに自動降格、中核機能は影響なし）、SMTP パスワードの AES-256-GCM 暗号化保存、i18n 4 言語（簡体字／繁体字中国語、英語、日本語）

## 技術スタック

| 層 | 技術 |
|---|---|
| バックエンド | Node.js ≥ 22、Express 5、TypeScript（tsx で直接実行、ビルド成果物なし）、better-sqlite3 / pg、nodemailer、任意で Redis |
| フロントエンド | Vite 6、React 18、Ant Design 5（角丸なしのダークテーマ）、Zustand、react-router 6（HashRouter）、i18next、skinview3d |

## クイックインストール（ローカル開発）

必要条件：Node.js ≥ 22（`better-sqlite3` はネイティブモジュールのため、Node のメジャーバージョン変更後に `npm rebuild better-sqlite3` が必要）。

```bash
# 1. 依存関係のインストール
npm install
cd web && npm install && cd ..

# 2. バックエンド起動（data/setup.json がない初回はインストールモードになり、/api/setup/* のみ公開）
npm start

# 3. 別のターミナルでフロントエンド起動（:5173、/api・/uploads・/authserver・/sessionserver を :3000 へプロキシ）
cd web && npm run dev
```

`http://localhost:5173` を開くと**インストールウィザード**が自動起動：言語 → データベース（SQLite は設定不要、PostgreSQL は接続情報を記入）→ 任意で Redis → 任意でメール（SMTP）→ スーパー管理者作成。完了後、バックエンドは**同一プロセス内**で再構築・ポート再バインドし（数秒）、フロントエンドは自動でリロードされてサイトに入ります。

データベース種別はインストール直後からロックされ変更不可。切り替えるには `data/setup.json` を削除して再初期化してください。

## ビルドと本番デプロイ

```bash
# フロントエンド（成果物 web/dist をリバースプロキシで静的配信）
cd web && npm ci && npm run build

# バックエンド
npm ci
npm run migrate                          # マイグレーション失敗時は起動を拒否
node --import tsx src/server/main.ts
```

リバースプロキシの要点（Nginx/OpenResty 例）：

```nginx
root /path/to/MCSTS/web/dist;
location / { try_files $uri $uri/ /index.html; }   # HashRouter のドキュメント入口は /
location ~ ^/(api|uploads)/ {                       # 業務 API + Yggdrasil + テクスチャ
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- リバースプロキシ配下では必ず `TRUST_PROXY=1`（またはプロキシ段数）を設定。未設定だと IP ベースのレート制限が全ユーザーを同一バケットに計上します
- 本番では `MCSTS_SECRET`（16 文字以上）必須：SMTP パスワード暗号化のマスターキー。未設定なら平文保存、ローテーション後は旧暗号文は復号不可（意図的な設計）
- **トップレベルのドメイン名は認証サーバー URL として使用不可**（ルートパスは SPA が占有）：ランチャーには `https://<ドメイン>/api/yggdrasil` を入力
- マルチインスタンス構成では `REDIS_URL` が必須。未設定だとレート制限はインスタンスごとに別カウントになります
- 環境変数の完全な一覧は `.env.example`（バックエンド）と `web/.env.example`（フロントエンド）を参照

## テスト

```bash
npm test          # SQLite ベースライン（外部サービス不要、ゲート付きケースは自動 skip）
```

フルスイートは `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` でゲートを有効化。現在のベースライン：**324/324 pass / 0 fail / 0 skipped**（PG + Redis + Mailpit 全開）。

## ドキュメント

- [サードパートログイン Provider 接続ガイド](docs/oauth-provider-guide.md)

## 貢献者

- [@SunsetNightMoon](https://github.com/SunsetNightMoon) — 開発と保守
- [@feifei2005](https://github.com/feifei2005) — 新旧バージョンの開発協力（旧版の貢献記録は [CatTavernSkins](https://github.com/SunsetNightMoon/CatTavernSkins) リポジトリ参照）

## ライセンス

[MIT License with Attribution Addendum](LICENSE)（MIT + 帰属表示の追加条項）：

- 自由は MIT と同一：使用・複製・改変・統合・出版・配布・再ライセンス・販売はすべて無償
- **追加条項**：本ソフトウェア（改変の有無を問わず）で一般公開されるウェブサイト／オンラインサービスを提供する場合、フロントエンドに明確に表示される「**Powered by MCSkinToServer**」帰属表示を維持する必要があります。書面の許可なく削除・隠蔽・改変はできません。ソースコードのみの配布は従来の MIT 条件が適用されます

## 謝辞

- [Blessing Skin](https://github.com/bs-community/blessing-skin-server) —— 長年続く優れた Minecraft スキンサイトプロジェクト。本プロジェクトのスキンサイトとしての全体像と方向性は同プロジェクトから着想を得ており、その価値に敬意を表し感謝します。

## AI 支援に関する声明

本プロジェクトは開発過程で AI の支援を使用しました。モデルと役割は以下の通りです：

| モデル | 用途 |
|---|---|
| GPT-6 Astra | 再構築版の大まかな方向付け |
| DeepSeek-v4.1-Flash | コード構築支援 |
| GLM-5.3-Flash | コード構築支援 |
| Qwen3.8-Flash | コード構築支援 |
| Hy3 | 旧版 UI デザイン（現在も踏襲） |

## 開発規約

- 再構築の中核目標は「単一信頼情報源」：スキーマ統一、AuthContext 統一、アセット URL 組み立て統一、マイグレーション入口統一
- Yggdrasil 外部プロトコル互換はハード制約；内部実装は書き換え可
- 各バッチ完了後に API・スキーマ・マイグレーション・テスト状況を同期更新
