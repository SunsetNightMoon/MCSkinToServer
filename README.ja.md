# MCSTS · MCSkinToServer

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | [English](README.en.md) | **日本語**

Minecraft アカウント外付けログイン + スキン／マントテクスチャサーバー（Yggdrasil プロトコル互換）。`CatTavernSkins`(plan3) の再構築版です。

- **現在のバージョン：`2.3.4`**
- バージョン規則：メジャー = 再構築ヘッダー（1 = 再構築前の旧版、2 = 再構築版）；マイナー = 四半期；パッチ = 四半期内のイテレーション番号。
- 旧版ソース：https://github.com/SunsetNightMoon/CatTavernSkins （分析ベースライン `b01f29a`、再構築により旧版ソースは変更していません）

## 機能一覧

- **Yggdrasil 外付けログイン**：`/authserver/*` + `/sessionserver/*` 全エンドポイント、HMCL 等のランチャーで実機検証済み；RSA 署名テクスチャ、メタデータの複数プレフィックスマウント
- **アセットシステム**：スキン／マントのアップロード（PNG 検証、sha256 重複排除、参照カウント）、3D プレビュー、公開ライブラリ、審査キュー、お気に入り、閲覧／ダウンロードカウント、権限マトリクス（公開設定 × ダウンロードポリシー）
- **アカウント体系**：登録／ログイン、メール認証、パスワード再設定・変更、退会と 15 日の復旧期間（UID は再利用なし）、バックアップメールと相互認証によるメール変更、人間認証（未使用／算数式キャプチャ／画像キャプチャ／外部認証サービス）、BAN（永久／一時は期限切れで自動解除）
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
# ランチャーがドメイン名のみを入力した際は ALI ヘッダーで API アドレスを発見する：ルートパスは SPA が占有するためバックエンドのレスポンスヘッダーは届かない
location = / { add_header X-Authlib-Injector-API-Location /api/yggdrasil always; try_files /index.html =404; }
location ~ ^/(api|uploads|\.well-known)/ {          # 業務 API + Yggdrasil + テクスチャ + ALI 形式のメタデータ
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- リバースプロキシ配下では必ず `TRUST_PROXY=1`（またはプロキシ段数）を設定。未設定だと IP ベースのレート制限が全ユーザーを同一バケットに計上します
- 本番では `MCSTS_SECRET`（16 文字以上）必須：認証情報系設定（`SMTP_PASS` と `EXTERNAL_CAPTCHA_SECRET`）の暗号化マスターキー。未設定なら平文保存、ローテーション後は旧暗号文は復号不可（意図的な設計）
- **ランチャーには `https://<ドメイン>/api/yggdrasil` を入力するのが最も確実**；上記 ALI ヘッダーを設定すればドメイン名だけでも解決できます。サーバー表示名はメタデータの `meta.serverName`（サイトタイトル）由来です。タイトル変更後はランチャーのアカウント画面でメタデータの再取得を行ってください
- マルチインスタンス構成では `REDIS_URL` が必須。未設定だとレート制限はインスタンスごとに別カウントになります
- パスワードの強度は `BCRYPT_COST` で決めます（既定 10、10-14 にクランプ。範囲外は警告を出してクランプ/フォールバックし、起動失敗にはしません）。上げると**既存アカウントも次回ログイン成功時に自動で再ハッシュ**されます（cost はハッシュ文字列に埋め込まれていて、その瞬間は平文が手元にあるため）、パスワード再設定の強制は不要です。逆に下げても既存ハッシュはダウングレードしません。代償として bcryptjs は純 JS 実装なので cost +1 で所要時間が約 2 倍になります。本機実測では 1 回のログインが約 80ms（cost 10）→ 約 340ms（cost 12）、低スペック VPS ではさらに遅いため、既定値は据え置きで管理者の機械判断に委ねます
- 匿名で使えるプロトコルエンドポイント `POST /api/profiles/minecraft`（キャラクタ名 → UUID）には送信元 IP あたりのレート制限（既定 60 回/分）をかけます。無制限だと全キャラ名と UUID を無限速で巡回されかねず、かといって締めてもサーバー参加時の正常なクライアントや共有出口アドレス（NAT）を誤爆するため、ゆるい値にしてあります。IP ベースの制限はいずれも `TRUST_PROXY` の正しい設定に依存します
- 環境変数の完全な一覧は `.env.example`（バックエンド）と `web/.env.example`（フロントエンド）を参照

## 人間認証

登録とログインに使う人間認証の方式は「管理パネル → システム設定 → 登録設定」で選び、サイト設定 `CAPTCHA_TYPE`（`none` / `math` / `image` / `external`）に保存します。従来のブール値 `ENABLE_CAPTCHA` しか書いたことのないサイトは `true → math` / `false → none` として扱われ、アップグレードで挙動は変わりません。

| 方式 | 外部通信 | 訪問者 IP の渡り先 | 位置づけ |
|---|---|---|---|
| `math` 計算問題 | しない | 本サーバー | 問題文を平文で返すため、単純なスクリプトのみ抑止 |
| `image` 画像キャプチャ | しない | 本サーバー | 問題文は PNG の中にしか出ず、JSON を読むスクリプトを抑止 |
| `external` 外部サービス | する | 設定した検証エンドポイント | 選択したサービスの防御力次第 |

- セルフホストの 2 方式（`math` / `image`）は**スクリプト抑止**が目的で、人力や破査サービスには無力です。利点は外部依存もコンプライアンス負担もゼロなこと。画像は sharp がサーバー上でベクター線分により描画するため、外部通信もシステムフォントも使いません（フォントのないミニマルイメージでも「真っ白な画像で永遠に正解できない」ことが起きません）。
- `external` は意図的に「プリセット＋全項目変更可能」で、ベンダーに縛りません。Cloudflare Turnstile / hCaptcha / Google reCAPTCHA を選ぶのは `EXTERNAL_CAPTCHA_VERIFY_URL` / `EXTERNAL_CAPTCHA_SCRIPT_URL` / `EXTERNAL_CAPTCHA_GLOBAL_NAME` に推奨値を埋めるだけで、3 項目いずれも自建リレーや到達可能な別アドレスに変えられます。`custom` は 3 項目すべてを自分で指定するプリセットです。
- ベンダー固有の署名が必要なサービス（騰訊天御、アリクラウド人間認証、網易易盾、GeeTest v4）は本プロジェクトが使う「フォーム POST + ブール `success`」の共通形状に合わないため内蔵していません。拡張点は `src/account/externalCaptcha.ts` です。
- サイトの CSP がウィジェットの読み込みを制限する場合は、そのホストを `script-src` に追加してください。
- `EXTERNAL_CAPTCHA_SECRET` は SMTP パスワードと同じ扱いで、AES-256-GCM で暗号化保存、管理画面には `<KEY>_SET` の有無だけ返し、公開エンドポイントからは一切返しません。空で保存しても既存のシークレットは消えません。
- 検証エンドポイントに到達できない場合、登録・ログインは **502 `CAPTCHA_UNAVAILABLE`** を返し、黙って通過させることはありません。回答誤りや token 失効は 400 `CAPTCHA_INVALID` で、ユーザーはやり直せます。
- 出題レート制限 `CAPTCHA_GENERATE_RATE_LIMIT_*`（既定は送信元アドレスあたり 5 分に 10 回）は計算問題と画像で共通の枠を使い、方式を乗り換えても枠は増えません。

## アセットのクロスオリジン読み取り

`/uploads` のテクスチャは、既定で**同一オリジンとサイト自身のオリジンからのみ**クロスオリジン読み取りができます。以前は `Access-Control-Allow-Origin: *` が固定で、任意のサイトのスクリプトがテクスチャを canvas に読み込んでそのまま抜き取れる状態でした。

- サイト設定 `UPLOAD_CORS_ORIGINS`：カンマまたは改行区切りのオリジン一覧（ホストのみ記載は `https://` 扱い）。空欄 = 最も厳格、`*` = 全面許可に戻す。認識できない項目は項目単位で破棄され、リスト全体が無効にはなりません。
- 同一オリジン判定はリクエスト自身の `Host` を使い、`BASE_URL` の設定に依存しません —— サイトルートを未設定でも、自サイトのアバターや 3D プレビューが壊れることはありません。
- **アセットを別ドメインの画像ホスト/CDN に置いている場合は、ページ側のオリジンをホワイトリストに追加してください。`crossOrigin="anonymous"` のテクスチャは読み込み自体が失敗します**（キャンバス汚染どころの話ではありません）。
- `/uploads` のレスポンスは常に `Vary: Origin` を返します。前置きの CDN/リバースプロキシが **Origin でキャッシュキーを分けらない**と、A のオリジン向けレスポンスを B に配って「自分は動く、相手は画像が割れる」になります。無理なら 3 択です：アセットをページと同じオリジンにする、`/uploads` の CDN キャッシュを止める、`*` に戻す。
- これは**hotlink 対策ではありません**：`<img>` による参照は CORS を通らないため、埋め込み画像はそのまま表示され、帯域もそのまま消費されます。

### hotlink を止めたい（Referer）場合の做法

Referer による判定はゲートウェイ/CDN 側で行う話で、このリポジトリでは意図的に実装していません（ホストごとに方針が違うため）。nginx の例：

```nginx
location ~ ^/uploads/ {
  # Referer なしは通す：直接アクセス・シークレットモード・Referrer-Policy のダウングレードでは Referer が付きません
  valid_referers none blocked server_names ~\.example\.com$;
  if ($invalid_referer) { return 403; }
  proxy_pass http://mcsts_backend;   # またはローカルディレクトリへの alias
}
```

押さえるべき 3 点：Referer は単なるリクエストヘッダーなので、ブラウザ以外のクライアントは自由に偽装できます（善意の利用者しか止められません）；Yggdrasil クライアントも Referer なしでテクスチャを取り得るので、`location` で厳密に範囲を決めて起動器を巻き込まないでください；より強くするなら署名 URL / 有効期限付きトークンに置き換える必要があり、それはアセット経路全体の設計変更になります。

## テスト

```bash
npm test          # SQLite ベースライン（外部サービス不要、ゲート付きケースは自動 skip）
```

フルスイートは `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` でゲートを有効化。現在のベースライン：**392/392 pass / 0 fail / 0 skipped**（PG + Redis + Mailpit 全開）。

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
