-- ============================================================================
-- MSCTS canonical schema · 0005_user_banned_at · SQLite
--
-- 给封禁补一个**时间戳**。
--
-- 为什么必须补：`banned_until` 只能表达「封到哪天」，`ban_permanent` 只能表达
-- 「是否永久」—— 两者都回答不了「**这条封禁是什么时候下的**」。管理后台的
-- 「封禁趋势」折线图需要按日统计新增封禁，没有这个列就只能一路填 0。
--
-- 语义（三列必须一起理解）：
--   banned_at     非空 = 该账号当前处于封禁状态，值为本次封禁生效时刻
--   ban_permanent 解封时清空，与 banned_at 同生共死
--   banned_until  临时封禁的到期时刻（永久封禁时为 NULL）
--
-- 解封（含临时封禁到期后管理员手动解封）**必须把 banned_at 一并清空**，
-- 否则下一次封禁前这段时间会被误算成「仍在封禁」。重新封禁时覆盖为新时刻。
--
-- 为什么允许 NULL（而不是 DEFAULT 当前时间）：存量被禁账号在 0005 之前
-- 没有可考的下达时间，回填任何假值都会污染趋势图。历史空缺就让它空着。
--
-- 本文件是 schema/postgresql/0005_user_banned_at.sql 的类型映射变体：
--   TIMESTAMPTZ -> TEXT（ISO-8601 UTC，应用层写入）
--
-- 迁移文件内禁止 BEGIN/COMMIT，事务边界由迁移 runner 拥有。
-- ----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN banned_at TEXT;

-- 封禁趋势按 banned_at 分日聚合
CREATE INDEX users_banned_at_idx ON users (banned_at);
