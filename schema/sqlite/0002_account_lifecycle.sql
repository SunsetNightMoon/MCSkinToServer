-- ============================================================================
-- MCSTS canonical schema · 0002_account_lifecycle · SQLite
--
-- 账号注销生命周期：
--   deleted_at 非空      = 已注销，处于 15 天可恢复宽限期
--   超过宽限期后由应用层清除个人数据（email 改为墓碑值、密码清空），
--   并写入 purged_at；**用户行本身保留**，用于占住 user_uid。
--
-- 为什么保留行：SQLite 侧的 user_uid 由应用层 MAX(user_uid)+1 分配，
-- 物理删除会让 UID 被后来的注册复用，而 UID 要求永不复用。
-- 本文件是 schema/postgresql/0002_account_lifecycle.sql 的类型映射变体：
--   TIMESTAMPTZ -> TEXT（ISO-8601 UTC，应用层写入）
--
-- 迁移文件内禁止 BEGIN/COMMIT，事务边界由迁移 runner 拥有。
-- ----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN purged_at  TEXT;

-- 宽限期扫描（到期清理）与登录判定都会按 deleted_at 过滤
CREATE INDEX users_deleted_idx ON users (deleted_at);
