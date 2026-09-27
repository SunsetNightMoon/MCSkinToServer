# MCSTS · MCSkinToServer

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | **English** | [日本語](README.ja.md)

A Minecraft external login (Yggdrasil-compatible) + skin/cape texture server. A rebuild of `CatTavernSkins` (plan3).

- **Current version: `2.3.4`**
- Versioning scheme: major = rebuild header (1 = pre-rebuild, 2 = rebuilt); minor = quarter of the year; patch = iteration within the quarter.
- Legacy source: https://github.com/SunsetNightMoon/CatTavernSkins (analysis baseline `b01f29a`; the rebuild never modified the legacy code)

## Features

- **Yggdrasil external login**: full `/authserver/*` + `/sessionserver/*` endpoint set, verified on real launchers (HMCL etc.); RSA-signed textures, metadata mounted under multiple prefixes
- **Asset system**: skin/cape upload (PNG validation, sha256 dedup, reference counting), 3D preview, public library, review queue, favorites, view/download counters, permission matrix (visibility × download policy)
- **Accounts**: register/login, email verification, password reset & change, account deletion with 15-day recovery (UIDs never reused), backup email with cross-verified email changes, human verification (none / self-hosted math / self-hosted image / external service), bans (permanent / temporary with self-healing expiry)
- **Username modes**: site-wide single/multi username mode (switchable by super admin on one page), reserved profiles + 30-day rename cooldown, name pool
- **Site management**: install wizard (SQLite or PostgreSQL — locked after install, default language, in-process soft restart to apply instantly), site settings (branding / theme backgrounds / custom homepage HTML/CSS / email templates), admin dashboard stats (dual-dialect aggregation + timezone bucketing)
- **Infrastructure**: one canonical schema for SQLite/PostgreSQL, versioned migration runner, optional Redis rate limiting & caching (auto-degrades to in-process memory, core features unaffected), SMTP password encrypted with AES-256-GCM, i18n in 4 languages (Simplified/Traditional Chinese, English, Japanese)

## Tech Stack

| Side | Technology |
|---|---|
| Backend | Node.js ≥ 22, Express 5, TypeScript (run directly via tsx, no build output), better-sqlite3 / pg, nodemailer, optional Redis |
| Frontend | Vite 6, React 18, Ant Design 5 (sharp-corner dark theme), Zustand, react-router 6 (HashRouter), i18next, skinview3d |

## Quick Start (local development)

Requirement: Node.js ≥ 22 (`better-sqlite3` is a native module; run `npm rebuild better-sqlite3` after switching major Node versions).

```bash
# 1. Install dependencies
npm install
cd web && npm install && cd ..

# 2. Start the backend (first run without data/setup.json enters install mode, exposing only /api/setup/*)
npm start

# 3. In another terminal, start the frontend (:5173, proxies /api, /uploads, /authserver, /sessionserver → :3000)
cd web && npm run dev
```

Open `http://localhost:5173` — the **install wizard** starts automatically: language → database (SQLite needs no config; or fill in PostgreSQL) → optional Redis → optional email (SMTP) → create the super admin. On completion the backend rebuilds itself **in the same process** and rebinds the port (a few seconds), then the frontend reloads into the site.

The database type is locked after installation; to switch, delete `data/setup.json` and re-initialize.

## Build & Production Deployment

```bash
# Frontend (output in web/dist, serve statically via reverse proxy)
cd web && npm ci && npm run build

# Backend
npm ci
npm run migrate                          # refuses to boot if migration fails
node --import tsx src/server/main.ts
```

Reverse proxy essentials (Nginx/OpenResty example):

```nginx
root /path/to/MCSTS/web/dist;
location / { try_files $uri $uri/ /index.html; }   # HashRouter document entry is /
# Launchers discover the API address from the ALI header when a bare domain is typed: the SPA owns /, so backend headers never reach it
location = / { add_header X-Authlib-Injector-API-Location /api/yggdrasil always; try_files /index.html =404; }
location ~ ^/(api|uploads|\.well-known)/ {          # business API + Yggdrasil + textures + ALI-style metadata
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- After a reverse proxy, set `TRUST_PROXY=1` (or the proxy hop count), otherwise IP-based rate limiting lumps every user into one bucket
- `MCSTS_SECRET` (≥16 chars) is required in production: master key for the credential settings (`SMTP_PASS`, `EXTERNAL_CAPTCHA_SECRET`); unset means plaintext storage; rotating it makes old ciphertexts undecryptable (by design)
- **Enter `https://<domain>/api/yggdrasil` in launchers** (most reliable); with the ALI header above a bare domain resolves too. The server display name comes from `meta.serverName` in the metadata (= site title) — hit refresh on the launcher accounts page after renaming
- Multi-instance deployments must configure `REDIS_URL`, otherwise rate limits apply per instance
- Full environment variable list: `.env.example` (backend) and `web/.env.example` (frontend)

## Human verification

Which check registration and login use is picked in "Admin panel → System settings → Registration settings" and stored as the site setting `CAPTCHA_TYPE`: `none` / `math` / `image` / `external`. Sites that only ever wrote the legacy boolean `ENABLE_CAPTCHA` keep behaving as before (`true → math`, `false → none`).

| Type | Leaves the server | Visitor IP goes to | Purpose |
|---|---|---|---|
| `math` | no | this server | question is sent in plaintext; deters naive scripts |
| `image` | no | this server | question only appears inside the PNG; deters scripts that parse JSON |
| `external` | yes | the verify endpoint you configure | whatever the chosen service defends against |

- The two self-hosted types only **deter scripts**; they do nothing against captcha-solving services or manual sign-ups. Their merit is zero external dependency and zero compliance burden. Images are drawn locally by sharp from vector strokes — no network, no system fonts — so a slim container without fonts cannot render a blank captcha.
- `external` is deliberately "preset + fully editable" rather than vendor-bound: choosing Cloudflare Turnstile / hCaptcha / Google reCAPTCHA only prefills `EXTERNAL_CAPTCHA_VERIFY_URL` / `EXTERNAL_CAPTCHA_SCRIPT_URL` / `EXTERNAL_CAPTCHA_GLOBAL_NAME`, and each of the three can be pointed at a self-hosted relay or any other reachable address; the `custom` preset means you supply all three.
- Services that require vendor request signing (Tencent Tianyu, Aliyun captcha, NetEase Yidun, GeeTest v4) do not match the shared "form POST + boolean `success`" shape used here and are not built in; the extension point is `src/account/externalCaptcha.ts`.
- If the site CSP restricts the widget script, add its host to `script-src`.
- `EXTERNAL_CAPTCHA_SECRET` is treated like the SMTP password: AES-256-GCM at rest, only a `<KEY>_SET` flag back to the admin UI, never exposed by the public endpoint, and saving an empty field keeps the stored secret.
- When the verify endpoint is unreachable, registration and login return **502 `CAPTCHA_UNAVAILABLE`** instead of silently passing; a wrong answer or expired token is 400 `CAPTCHA_INVALID` and the visitor just gets a new challenge.
- Challenge issuance is rate limited by `CAPTCHA_GENERATE_RATE_LIMIT_*` (default 10 per 5 minutes per source address), shared by math and image so switching types buys no extra quota.

## Testing

```bash
npm test          # SQLite baseline (no external services needed; gated cases auto-skip)
```

For the full suite, enable gates via `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL`. Current baseline: **372/372 pass / 0 fail / 0 skipped** (PG + Redis + Mailpit all on).

## Documentation

- [Third-party login provider guide](docs/oauth-provider-guide.md)

## Contributors

- [@SunsetNightMoon](https://github.com/SunsetNightMoon) — development & maintenance
- [@feifei2005](https://github.com/feifei2005) — development assistance for both legacy and rebuilt versions (legacy contributions in the [CatTavernSkins](https://github.com/SunsetNightMoon/CatTavernSkins) repository)

## License

[MIT License with Attribution Addendum](LICENSE) (MIT + attribution clause):

- Same freedoms as MIT: use, copy, modify, merge, publish, distribute, sublicense, and sell are all free of charge
- **Additional condition**: when running this software (modified or not) as a public website or online service, the frontend MUST keep a clearly visible "**Powered by MCSkinToServer**" attribution — it may not be removed, obscured, or altered without prior written permission. Source-code-only distribution remains subject to standard MIT terms.

## Acknowledgments

- [Blessing Skin](https://github.com/bs-community/blessing-skin-server) — a long-standing excellent Minecraft skin site project. The overall product form and direction of this skin server were inspired by it; we acknowledge and respect the value it has brought.

## AI Assistance Disclosure

This project used AI assistance during development. Models and their roles:

| Model | Role |
|---|---|
| GPT-6 Astra | general direction guidance for the rebuild |
| DeepSeek-v4.1-Flash | code construction assistance |
| GLM-5.3-Flash | code construction assistance |
| Qwen3.8-Flash | code construction assistance |
| Hy3 | legacy UI design (carried over to this day) |

## Working Conventions

- The rebuild's core goal is a "single source of truth": unified schema, unified AuthContext, unified asset URL assembly, unified migration entry
- Yggdrasil external protocol compatibility is a hard constraint; internal implementation may be rewritten
- After each batch, keep API, schema, migrations, and test status in sync
