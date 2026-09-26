-- ============================================================================
-- MCSTS canonical schema · 0004_captcha_challenges · PostgreSQL
--
-- 与 schema/sqlite/0004_captcha_challenges.sql 同构，仅类型不同。
-- 设计说明（为什么自托管数学题、为什么按客户端 session_id 建键、答案为什么存哈希）
-- 见 SQLite 那份的注释，此处不重复。
--
-- 类型映射：
--   TEXT(ISO-8601 UTC) -> TIMESTAMPTZ
--   TEXT(uuid)         -> UUID
--
-- 迁移文件内禁止 BEGIN/COMMIT，事务边界由迁移 runner 拥有。
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- 1. 挑战表
-- ----------------------------------------------------------------------------

CREATE TABLE captcha_challenges (
  id          UUID PRIMARY KEY,
  session_id  TEXT NOT NULL UNIQUE,
  answer_hash TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE INDEX captcha_challenges_expires_idx ON captcha_challenges (expires_at);
