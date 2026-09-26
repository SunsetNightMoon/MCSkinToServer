-- ============================================================================
-- MCSTS canonical schema · 0005_user_banned_at · PostgreSQL
--
-- 给封禁补一个**时间戳**（与 sqlite/0005_user_banned_at.sql 结构等价）：
--   banned_at 非空 = 该账号当前处于封禁状态，值为本次封禁生效时刻
--   解封时必须一并清空；重新封禁时覆盖为新时刻
--
-- 详细语义与取舍见 SQLite 变体的文件头。
--
-- 类型映射：TEXT -> TIMESTAMPTZ
--
-- 迁移文件内禁止 BEGIN/COMMIT，事务边界由迁移 runner 拥有。
-- ----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN banned_at TIMESTAMPTZ;

CREATE INDEX users_banned_at_idx ON users (banned_at);
