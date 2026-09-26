-- ============================================================================
-- MSCTS canonical schema · 0002_account_lifecycle · PostgreSQL
--
-- 账号注销生命周期（与 sqlite/0002_account_lifecycle.sql 结构等价）：
--   deleted_at 非空 = 已注销，处于 15 天可恢复宽限期
--   超期后应用层清除个人数据并写 purged_at，用户行保留以占住 user_uid
--
-- 迁移文件内禁止 BEGIN/COMMIT，事务边界由迁移 runner 拥有。
-- ----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN purged_at  TIMESTAMPTZ;

CREATE INDEX users_deleted_idx ON users (deleted_at);
