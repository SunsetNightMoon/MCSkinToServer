# MCSTS · MCSkinToServer

[简体中文](README.md) | [繁體中文](README.zh-Hant.md) | [English](README.en.md) | **日本語**

Minecraft アカウント外付けログイン + スキン／マントテクスチャサーバー（Yggdrasil プロトコル互換）。`CatTavernSkins`(plan3) の再構築版です。

- **現在のバージョン：`v2-26.3.7`**（読み方は `26.3.7`）
- バージョン規則：`v2-26.3.7` の四要素は順に、再構築版ヘッダー `2`（`1` = 再構築前の旧版、`2` = 再構築版）、年 `26`（2026 年）、四半期 `3`、四半期内のイテレーション番号 `7`（次の四半期に入ると `1` にリセット）。表記・表示は常に `v2-` を付けます。package ファイルの semver 欄だけが `26.3.7` を保存します。
- 旧版ソース：https://github.com/SunsetNightMoon/CatTavernSkins （分析ベースライン `b01f29a`、再構築により旧版ソースは変更していません）

## 機能一覧

- **Yggdrasil 外付けログイン**：`/authserver/*` + `/sessionserver/*` 全エンドポイント、HMCL 等のランチャーで実機検証済み；RSA 署名テクスチャ、メタデータの複数プレフィックスマウント
- **アセットシステム**：スキン／マントのアップロード（PNG 検証、sha256 重複排除、参照カウント）、3D プレビュー、公開ライブラリ、審査キュー、お気に入り、閲覧／ダウンロードカウント、権限マトリクス（公開設定 × ダウンロードポリシー）
- **アカウント体系**：登録／ログイン、メール認証、メイン／予備メールの相互認証による復旧、退会と 15 日の復旧期間（UID は再利用なし）、人間認証、BAN（永久／一時は期限切れで自動解除）
- **ユーザー名モード**：サイト全体の単一／複数ユーザー名モード（スーパー管理者が 1 ページで切替）、予約プロフィール + 30 日の名前変更クールダウン、名前プール
- **サイト管理**：インストールウィザード（SQLite／PostgreSQL の二者択一、インストール後はロック、完了後にプロセス内ソフトリブートで即時反映）、サイト設定（ブランド／テーマ背景／カスタムトップページ HTML/CSS／メールテンプレート）、管理ダッシュボード統計
- **インフラ**：SQLite／PostgreSQL 二方言で同一の canonical スキーマ、バージョン管理マイグレーションランナー、任意で Redis のレート制限とキャッシュ（未設定なら自動降格、中核機能は影響なし）、認証情報系設定の暗号化保存、i18n 4 言語

## 技術スタック

| 層 | 技術 |
|---|---|
| バックエンド | Node.js ≥ 22、Express 5、TypeScript（tsx で直接実行、ビルド成果物なし）、better-sqlite3 / pg、nodemailer、任意で Redis |
| フロントエンド | Vite 6、React 18、Ant Design 5（角丸なしのダークテーマ）、Zustand、react-router 6（HashRouter）、i18next、skinview3d |

## クイックインストール（ローカル開発）

必要条件：Node.js ≥ 22（`better-sqlite3` はネイティブモジュールのため、Node のメジャーバージョン変更後に `npm rebuild better-sqlite3` が必要）。

```bash
npm install && (cd web && npm install)
npm start                    # バックエンド :3000、data/setup.json が無い初回はインストールモード
(cd web && npm run dev)      # フロントエンド :5173、/api・/uploads・/authserver・/sessionserver をプロキシ
```

`http://localhost:5173` を開くと**インストールウィザード**が起動します：言語 → データベース → 任意で Redis → 任意で SMTP → スーパー管理者作成。完了後、バックエンドは**同一プロセス内**でポートを再バインドし、フロントエンドは自動でリロードされてサイトに入ります。データベース種別はインストール直後からロックされ変更不可。切り替えるには `data/setup.json` を削除して再初期化してください。

## ビルドと本番デプロイ

```bash
(cd web && npm ci && npm run build)   # 成果物 web/dist をリバースプロキシで静的配信
npm ci && npm run migrate             # マイグレーション失敗時は起動を拒否
node --import tsx src/server/main.ts
```

リバースプロキシの設定、`TRUST_PROXY`、マスターシークレット、マルチインスタンスの Redis、パスワード強度、ランチャーの入力先など、運用開始時の要点は **[docs/deployment.md](docs/deployment.md)** にまとめました。環境変数一覧は `.env.example`（バックエンド）と `web/.env.example`（フロントエンド）を参照してください。

Windows では**インストール不要のポータブル版**（Node 実行環境は同梱せず、Node 22.x/23.x が必要）を利用できます：[Releases](https://github.com/SunsetNightMoon/MCSkinToServer/releases) から展開して `start.cmd` をダブルクリックし、`http://localhost:8080` を開いてください。

## テスト

```bash
npm test          # SQLite ベースライン（外部サービス不要、ゲート付きケースは自動 skip）
```

フルスイートは `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` でゲートを有効化します。現在のベースライン：**408/408 pass / 0 fail / 0 skipped**（PG + Redis + Mailpit 全開）。

## ドキュメント

- [本番デプロイの要点](docs/deployment.md) —— リバースプロキシ、マスターシークレット、マルチインスタンス、パスワード強度とレート制限の閾値
- [人間認証](docs/human-verification.md) —— 4 方式のトレードオフ、ベンダーに縛られない外部認証、失敗時の挙動
- [メールアドレスとアカウント復旧](docs/account-emails.md) —— アドレスの一意性、予備メールによるログイン、別メールへの送信
- [アセットのクロスオリジン読み取り](docs/uploads-cors.md) —— `/uploads` のホワイトリスト、CDN における `Vary: Origin`、Referer の做法
- [サードパーティログイン Provider 接続ガイド](docs/oauth-provider-guide.md)

上記のガイドは現在簡体字中国語のみで提供しています。

## 貢献者

- [@SunsetNightMoon](https://github.com/SunsetNightMoon) — 開発と保守
- [@feifei2005](https://github.com/feifei2005) — 新旧バージョンの開発協力（旧版の貢献記録は [CatTavernSkins](https://github.com/SunsetNightMoon/CatTavernSkins) リポジトリ参照）

## ライセンス

[MIT License with Attribution Addendum](LICENSE)（MIT + 帰属表示の追加条項）：自由は MIT と同一（使用・複製・改変・統合・出版・配布・再ライセンス・販売は無償）ですが、本ソフトウェア（改変の有無を問わず）で一般公開されるウェブサイト／オンラインサービスを提供する場合、フロントエンドに明確に表示される「**Powered by MCSkinToServer**」帰属表示を維持する必要があり、書面の許可なく削除・隠蔽・改変はできません。ソースコードのみの配布は従来の MIT 条件が適用されます。

## 謝辞

- [Blessing Skin](https://github.com/bs-community/blessing-skin-server) —— 長年続く優れた Minecraft スキンサイトプロジェクト。本プロジェクトのスキンサイトとしての全体像と方向性は同プロジェクトから着想を得ており、その価値に敬意を表し感謝します。

## AI 支援に関する声明

本プロジェクトは開発過程で AI の支援を使用しました。

| モデル | 用途 |
|---|---|
| GPT-6 Astra | 再構築版の大まかな方向付け |
| DeepSeek-v4.1-Flash / GLM-5.3-Flash / Qwen3.8-Flash | コード構築支援 |
| Hy3 | 旧版 UI デザイン（現在も踏襲） |

## 開発規約

- 再構築の中核目標は「単一信頼情報源」：スキーマ統一、AuthContext 統一、アセット URL 組み立て統一、マイグレーション入口統一
- Yggdrasil 外部プロトコル互換はハード制約；内部実装は書き換え可
- 各バッチ完了後に API・スキーマ・マイグレーション・テスト状況を同期更新
