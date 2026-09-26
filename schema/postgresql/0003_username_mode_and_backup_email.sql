-- ============================================================================
-- MCSTS canonical schema · 0003_username_mode_and_backup_email · PostgreSQL
--
-- 与 schema/sqlite/0003_username_mode_and_backup_email.sql 同构，仅类型与
-- 放开 CHECK 的手法不同。设计说明（用户名模式 / 角色状态 / 备用邮箱 / 为什么
-- 改邮箱要「一次请求 + 两枚令牌」）见 SQLite 那份的注释，此处不重复。
--
-- 类型映射：
--   TEXT(ISO-8601 UTC) -> TIMESTAMPTZ
--   INTEGER(0/1)       -> BOOLEAN
--   TEXT(uuid)         -> UUID
--
-- 迁移文件内禁止 BEGIN/COMMIT，事务边界由迁移 runner 拥有。
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- 1. users：用户名模式 + 备用邮箱
-- ----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN profile_mode TEXT NOT NULL DEFAULT 'single';
ALTER TABLE users ADD CONSTRAINT users_profile_mode_check
  CHECK (profile_mode IN ('single', 'multi'));

-- NULL = 存量多角色用户尚未选择保留哪个 ID（登录后强制选择）
ALTER TABLE users ADD COLUMN profile_mode_decided_at TIMESTAMPTZ;

-- 模式切换的计时基准
ALTER TABLE users ADD COLUMN mode_changed_at TIMESTAMPTZ;

-- 备用邮箱（兜底）
ALTER TABLE users ADD COLUMN backup_email TEXT;
ALTER TABLE users ADD COLUMN backup_email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN backup_email_verified_at TIMESTAMPTZ;

-- 部分唯一索引：只约束非 NULL 的行，多行 NULL 可以共存
CREATE UNIQUE INDEX users_backup_email_lower_uidx
  ON users (lower(backup_email))
  WHERE backup_email IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. profiles：角色状态
-- ----------------------------------------------------------------------------

ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE profiles ADD CONSTRAINT profiles_status_check
  CHECK (status IN ('active', 'reserved'));

ALTER TABLE profiles ADD COLUMN status_changed_at TIMESTAMPTZ;

CREATE INDEX profiles_user_status_idx ON profiles (user_id, status);


-- ----------------------------------------------------------------------------
-- 3. 备用邮箱验证令牌
-- ----------------------------------------------------------------------------

CREATE TABLE backup_email_tokens (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  pending_email TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ
);

CREATE INDEX backup_email_tokens_user_idx ON backup_email_tokens (user_id);


-- ----------------------------------------------------------------------------
-- 4. 改邮箱：一次变更请求 + 两枚令牌
-- ----------------------------------------------------------------------------

CREATE TABLE email_change_requests (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target        TEXT NOT NULL CHECK (target IN ('primary', 'backup')),
  new_email     TEXT NOT NULL,
  authorize_via TEXT NOT NULL CHECK (authorize_via IN ('primary', 'backup')),
  created_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ
);

CREATE INDEX email_change_requests_user_idx ON email_change_requests (user_id);

CREATE TABLE email_change_tokens (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES email_change_requests (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('verify', 'authorize')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE INDEX email_change_tokens_user_idx ON email_change_tokens (user_id);
CREATE INDEX email_change_tokens_request_idx ON email_change_tokens (request_id);


-- ----------------------------------------------------------------------------
-- 5. 放开第三方登录的 provider 白名单
--
-- 原约束把可接入的 provider 写死在 ('github','microsoft')。本项目不直接接入任何
-- 第三方登录，只预留端口；将来接 bilibili / QQ 不应再被迫改 schema，故删掉它。
--
-- PG 的约束名是建表时自动生成的，这里按「定义里提到 provider」动态查名再删，
-- 避免硬编码 <table>_<column>_check 这个命名假设在别的 PG 版本上不成立。
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'oauth_accounts'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE oauth_accounts DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;


-- ----------------------------------------------------------------------------
-- 6. 存量回填：只有「角色数 <= 1」的用户算已确定模式
-- ----------------------------------------------------------------------------

UPDATE users
   SET profile_mode_decided_at = NOW()
 WHERE profile_mode_decided_at IS NULL
   AND (SELECT COUNT(*) FROM profiles p WHERE p.user_id = users.id) <= 1;
