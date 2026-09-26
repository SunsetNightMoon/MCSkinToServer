-- ============================================================================
-- MSCTS canonical schema · 0004_captcha_challenges · SQLite
--
-- 自托管「数学题」人机验证（批 2）。
--
-- ## 为什么自托管而不是接 Turnstile
--
-- 项目定位是自托管皮肤站，不引入外部 JS/服务依赖（也避免把访问者的 IP 交给第三方）。
-- 数学题挡不住有决心的攻击者，但能挡掉绝大多数脚本式批量注册 —— 这是它的目标。
-- 前端（旧版遗留 UI）本来就支持 `type: 'turnstile' | 'math' | 'none'` 三态，
-- 后端只要按开关返回 `math` 即可，页面一行不用改。
--
-- ## 为什么按 session_id 建键
--
-- 挑战号由**客户端生成**（旧版前端用 `Math.random().toString(36)` 生成 sessionId，
-- 提交时回传 `captcha_session_id`），响应里只有题目文本。后端必须按这个 id 找回
-- 当时的答案，否则旧前端无法工作。
--
-- session_id 由客户端提供意味着它可以被选择甚至碰撞，因此：
--   * 同一个 session_id 只保留最新一道题（生成时覆盖）。
--   * 校验同时要求「未使用」与「未过期」，且消费是原子的（见仓储层）。
--   * 生成端点按来源 IP 限流 —— 这是真正限制「批量预生成答案」的地方。
--
-- ## 答案为什么存哈希
--
-- 答案空间很小（0..~200），哈希挡不住穷举 —— **这不是安全边界**。存哈希只有一个
-- 作用：表被 dump 或整行被打进日志时，不会直接暴露「当时那道题的答案」。
-- 与项目内其它一次性凭据（令牌只存 sha256）保持同一习惯。
--
-- 本文件是 schema/postgresql/0004_captcha_challenges.sql 的类型映射变体：
--   TIMESTAMPTZ -> TEXT（ISO-8601 UTC，格式 'YYYY-MM-DDTHH:MM:SS.sssZ'）
--   UUID        -> TEXT
--
-- 迁移文件内禁止 BEGIN/COMMIT，事务边界由迁移 runner 拥有。
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- 1. 挑战表
-- ----------------------------------------------------------------------------

CREATE TABLE captcha_challenges (
  id          TEXT PRIMARY KEY,
  -- 客户端生成的关联号；唯一，同一 id 只保留最新一道题
  session_id  TEXT NOT NULL UNIQUE,
  -- sha256(规范化答案) 小写 hex。防的是「表被读走时答案直接可见」，不是穷举
  answer_hash TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  -- 非 NULL = 已消费。一道题只能用来校验一次（无论成功与否）
  used_at     TEXT
);

-- 清理过期行时按此索引扫（生成新题时顺带清理，保证表不会无限增长）
CREATE INDEX captcha_challenges_expires_idx ON captcha_challenges (expires_at);
