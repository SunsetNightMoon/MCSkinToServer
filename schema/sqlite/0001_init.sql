-- ============================================================================
-- MCSTS canonical schema · 0001_init · SQLite
-- 草案 v1（2026-09-20，待评审，未在任何数据库上执行）
--
-- 本文件是 schema/postgresql/0001_init.sql 的类型映射变体，结构必须等价：
--   UUID       -> TEXT（小写带连字符）
--   TIMESTAMPTZ -> TEXT（ISO-8601 UTC，如 2026-09-20T06:00:00.000Z；应用层写入）
--   BOOLEAN    -> INTEGER + CHECK (x IN (0,1))
--   JSONB      -> TEXT（JSON1）
--   user_uid identity -> 应用层在插入事务内 MAX(user_uid)+1 分配（单写者场景）
--
-- 连接要求：PRAGMA foreign_keys = ON（由数据库适配层/迁移 runner 保证）
-- 迁移文件内禁止 BEGIN/COMMIT 等事务控制语句，事务边界由迁移 runner 拥有
-- ----------------------------------------------------------------------------
-- 1. 身份与权限
-- ----------------------------------------------------------------------------

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  user_uid       INTEGER NOT NULL UNIQUE,        -- 应用层分配（插入事务内 MAX+1）
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user'
                   CHECK (role IN ('user', 'admin', 'super_admin')),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  banned_until   TEXT,
  ban_permanent  INTEGER NOT NULL DEFAULT 0 CHECK (ban_permanent IN (0, 1)),
  ban_reason     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_login_at  TEXT,
  CONSTRAINT users_ban_shape
    CHECK (NOT (ban_permanent AND banned_until IS NOT NULL))
);

CREATE UNIQUE INDEX users_email_lower_uidx ON users (lower(email));

CREATE TABLE profiles (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            TEXT NOT NULL UNIQUE,
  name_changed_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX profiles_user_idx ON profiles (user_id);

-- ----------------------------------------------------------------------------
-- 2. 文件对象与素材
-- ----------------------------------------------------------------------------

CREATE TABLE blobs (
  id           TEXT PRIMARY KEY,
  sha256       TEXT NOT NULL UNIQUE,
  storage_key  TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE assets (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('skin', 'cape')),
  blob_id         TEXT NOT NULL REFERENCES blobs (id),
  model_type      TEXT,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  license         TEXT NOT NULL DEFAULT 'CC0',
  visibility      TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'public')),
  download_policy TEXT NOT NULL DEFAULT 'owner_only'
                    CHECK (download_policy IN ('owner_only', 'public')),
  review_status   TEXT NOT NULL DEFAULT 'pending'
                    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  ai_generated    INTEGER NOT NULL DEFAULT 0 CHECK (ai_generated IN (0, 1)),
  admin_warning   TEXT,
  view_count      INTEGER NOT NULL DEFAULT 0,
  download_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CONSTRAINT assets_model_shape CHECK (
    (kind = 'skin' AND model_type IN ('default', 'slim'))
    OR (kind = 'cape' AND model_type IS NULL)
  )
);

CREATE INDEX assets_owner_idx ON assets (owner_user_id);
CREATE INDEX assets_blob_idx ON assets (blob_id);
CREATE INDEX assets_library_idx
  ON assets (kind, visibility, review_status, created_at);

CREATE TABLE profile_assets (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  asset_id    TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  slot        TEXT NOT NULL CHECK (slot IN ('skin', 'cape')),
  assigned_at TEXT NOT NULL,
  CONSTRAINT profile_assets_unique_slot UNIQUE (profile_id, slot)
);

CREATE TABLE favorites (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, asset_id)
);

CREATE INDEX favorites_asset_idx ON favorites (asset_id);

CREATE TABLE asset_reviews (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  reviewer_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  reason           TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX asset_reviews_asset_idx ON asset_reviews (asset_id);

-- ----------------------------------------------------------------------------
-- 3. 令牌与会话
-- ----------------------------------------------------------------------------

CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  token_type   TEXT NOT NULL CHECK (token_type IN ('web', 'yggdrasil')),
  client_token TEXT,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile_id   TEXT REFERENCES profiles (id) ON DELETE SET NULL,
  issued_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  CONSTRAINT tokens_expiry_shape CHECK (expires_at > issued_at)
);

CREATE INDEX tokens_user_idx ON tokens (user_id, token_type);

CREATE TABLE minecraft_sessions (
  id         TEXT PRIMARY KEY,
  token_id   TEXT NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  server_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX minecraft_sessions_lookup_idx ON minecraft_sessions (server_id, profile_id);
CREATE INDEX minecraft_sessions_expiry_idx ON minecraft_sessions (expires_at);

CREATE TABLE login_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_id     TEXT NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX login_sessions_user_idx ON login_sessions (user_id);

-- ----------------------------------------------------------------------------
-- 4. 账号辅助流程
-- ----------------------------------------------------------------------------

CREATE TABLE email_verification_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);

CREATE TABLE password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TABLE oauth_accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('github', 'microsoft')),
  provider_account_id TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  CONSTRAINT oauth_accounts_provider_uid UNIQUE (provider, provider_account_id)
);

CREATE INDEX oauth_accounts_user_idx ON oauth_accounts (user_id);

-- ----------------------------------------------------------------------------
-- 5. 黑名单与系统设置
-- ----------------------------------------------------------------------------

CREATE TABLE blacklist_entries (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('email', 'ip')),
  value      TEXT NOT NULL,
  reason     TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT blacklist_entries_uid UNIQUE (kind, value)
);

CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                     -- JSON 文本（JSON1）
  updated_at TEXT NOT NULL
);
