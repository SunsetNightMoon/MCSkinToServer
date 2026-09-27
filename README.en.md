# MCSTS · MCSkinToServer

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | **English** | [日本語](README.ja.md)

A Minecraft external login (Yggdrasil-compatible) + skin/cape texture server. A rebuild of `CatTavernSkins` (plan3).

- **Current version: `2.3.6`**
- Versioning scheme: major = rebuild header (1 = pre-rebuild, 2 = rebuilt); minor = quarter of the year; patch = iteration within the quarter.
- Legacy source: https://github.com/SunsetNightMoon/CatTavernSkins (analysis baseline `b01f29a`; the rebuild never modified the legacy code)

## Features

- **Yggdrasil external login**: full `/authserver/*` + `/sessionserver/*` endpoint set, verified on real launchers (HMCL etc.); RSA-signed textures, metadata mounted under multiple prefixes
- **Asset system**: skin/cape upload (PNG validation, sha256 dedup, reference counting), 3D preview, public library, review queue, favorites, view/download counters, permission matrix (visibility × download policy)
- **Accounts**: register/login, email verification, primary + backup email with cross-verified recovery, account deletion with 15-day recovery (UIDs never reused), human verification, bans (permanent / temporary with self-healing expiry)
- **Username modes**: site-wide single/multi username mode (switchable by super admin on one page), reserved profiles + 30-day rename cooldown, name pool
- **Site management**: install wizard (SQLite or PostgreSQL — locked after install, in-process soft restart to apply instantly), site settings (branding / theme backgrounds / custom homepage HTML/CSS / email templates), admin dashboard stats
- **Infrastructure**: one canonical schema for SQLite/PostgreSQL, versioned migration runner, optional Redis rate limiting & caching (auto-degrades, core features unaffected), credential settings encrypted at rest, i18n in 4 languages

## Tech Stack

| Side | Technology |
|---|---|
| Backend | Node.js ≥ 22, Express 5, TypeScript (run directly via tsx, no build output), better-sqlite3 / pg, nodemailer, optional Redis |
| Frontend | Vite 6, React 18, Ant Design 5 (sharp-corner dark theme), Zustand, react-router 6 (HashRouter), i18next, skinview3d |

## Quick Start (local development)

Requirement: Node.js ≥ 22 (`better-sqlite3` is a native module; run `npm rebuild better-sqlite3` after switching major Node versions).

```bash
npm install && (cd web && npm install)
npm start                    # backend :3000; first run without data/setup.json enters install mode
(cd web && npm run dev)      # frontend :5173, proxies /api /uploads /authserver /sessionserver
```

Open `http://localhost:5173` — the **install wizard** starts: language → database → optional Redis → optional SMTP → create the super admin. On completion the backend rebinds the port **in the same process** and the frontend reloads into the site. The database type is locked after installation; to switch, delete `data/setup.json` and re-initialize.

## Build & Production Deployment

```bash
(cd web && npm ci && npm run build)   # output in web/dist, served statically via reverse proxy
npm ci && npm run migrate             # refuses to boot if migration fails
node --import tsx src/server/main.ts
```

Reverse-proxy configuration, `TRUST_PROXY`, the master secret, multi-instance Redis, password hashing and launcher addresses are covered in **[docs/deployment.md](docs/deployment.md)**. Environment variables: `.env.example` (backend) and `web/.env.example` (frontend).

Windows users can download the **portable package** (bundled without a Node runtime; requires Node 22.x/23.x): see [Releases](https://github.com/SunsetNightMoon/MCSkinToServer/releases) — unzip, double-click `start.cmd`, open `http://localhost:8080`.

## Testing

```bash
npm test          # SQLite baseline, no external services needed; gated cases auto-skip
```

Enable gates with `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_SMTP_URL` / `TEST_SMTP_API_URL` for the full suite. Current baseline: **408/408 pass / 0 fail / 0 skipped** (PG + Redis + Mailpit all on).

## Documentation

- [Production deployment essentials](docs/deployment.md) — reverse proxy, master secret, multi-instance, password hashing and rate limit thresholds
- [Human verification](docs/human-verification.md) — the four modes and their trade-offs, vendor-free external verification, failure semantics
- [Email addresses and account recovery](docs/account-emails.md) — email uniqueness, backup email as a credential, cross-delivered resets
- [Cross-origin asset reads](docs/uploads-cors.md) — the `/uploads` allowlist, `Vary: Origin` under a CDN, Referer recipe
- [Third-party login provider guide](docs/oauth-provider-guide.md)

The guides above are currently written in Simplified Chinese.

## Contributors

- [@SunsetNightMoon](https://github.com/SunsetNightMoon) — development & maintenance
- [@feifei2005](https://github.com/feifei2005) — development assistance for both legacy and rebuilt versions (legacy contributions in the [CatTavernSkins](https://github.com/SunsetNightMoon/CatTavernSkins) repository)

## License

[MIT License with Attribution Addendum](LICENSE) (MIT + attribution clause): same freedoms as MIT, but when running this software (modified or not) as a public website or online service, the frontend MUST keep a clearly visible "**Powered by MCSkinToServer**" attribution — it may not be removed, obscured, or altered without prior written permission. Source-code-only distribution remains subject to standard MIT terms.

## Acknowledgments

- [Blessing Skin](https://github.com/bs-community/blessing-skin-server) — a long-standing excellent Minecraft skin site project. The overall product form and direction of this skin server were inspired by it; we acknowledge and respect the value it has brought.

## AI Assistance Disclosure

This project used AI assistance during development:

| Model | Role |
|---|---|
| GPT-6 Astra | general direction guidance for the rebuild |
| DeepSeek-v4.1-Flash / GLM-5.3-Flash / Qwen3.8-Flash | code construction assistance |
| Hy3 | legacy UI design (carried over to this day) |

## Working Conventions

- The rebuild's core goal is a "single source of truth": unified schema, unified AuthContext, unified asset URL assembly, unified migration entry
- Yggdrasil external protocol compatibility is a hard constraint; internal implementation may be rewritten
- After each batch, keep API, schema, migrations, and test status in sync
