-- ============================================================================
-- MCSTS canonical schema · 0003_username_mode_and_backup_email · SQLite
--
-- 三件事：
--
--   1) 用户名模式（users.profile_mode）
--      'single' = 单用户名（默认）。沿用 Minecraft 正版的 30 天改名冷却，
--                 且只能有 1 个 active 角色。
--      'multi'  = 多用户名。无改名冷却，活跃 + 预留合计上限 10 个角色。
--
--   2) 角色状态（profiles.status）
--      'active'   = 生效中的角色。
--      'reserved' = 预留口里的角色：多 -> 单 时被换下的角色转此状态。
--                   **数据与名字占位都保留**，否则名字会被别人抢注，
--                   而用户等满冷却期后还要用它换回来。
--
--   3) 备用邮箱（users.backup_email*）
--      主邮箱不可用时的兜底。两个邮箱**各自独立验证**；只有「要改其中一个邮箱」
--      时才启用交叉验证（另一个邮箱授权），被改的那个只收「已被更改」通知。
--
-- 存量数据处理（本文件末尾的 UPDATE）：
--   角色数 > 1 的用户，profile_mode 保持 'single' 但 profile_mode_decided_at 为 NULL
--   = 待选择。用户下次登录时必须选一个保留 ID 才能继续，其余角色转 'reserved'。
--   角色数 <= 1 的用户直接视作已选择。
--   **新注册用户由应用层在注册时写入 decided_at**（迁移管不到未来的行）。
--
-- 本文件是 schema/postgresql/0003_username_mode_and_backup_email.sql 的类型映射变体：
--   TIMESTAMPTZ -> TEXT（ISO-8601 UTC，格式 'YYYY-MM-DDTHH:MM:SS.sssZ'）
--   BOOLEAN     -> INTEGER（0/1 + CHECK）
--   UUID        -> TEXT
--
-- 迁移文件内禁止 BEGIN/COMMIT，事务边界由迁移 runner 拥有。
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- 1. users：用户名模式 + 备用邮箱
-- ----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN profile_mode TEXT NOT NULL DEFAULT 'single'
  CHECK (profile_mode IN ('single', 'multi'));

-- NULL = 存量多角色用户尚未选择保留哪个 ID（登录后强制选择）；非 NULL = 已确定
ALTER TABLE users ADD COLUMN profile_mode_decided_at TEXT;

-- 模式切换的计时基准。「切回单用户名」等操作可能需要冷却，基准放这里而不是
-- profiles 上 —— 因为切换动作本身与具体角色无关。
ALTER TABLE users ADD COLUMN mode_changed_at TEXT;

-- 备用邮箱（兜底）。可为 NULL；非空时全局唯一（见下方部分唯一索引）
ALTER TABLE users ADD COLUMN backup_email TEXT;
ALTER TABLE users ADD COLUMN backup_email_verified INTEGER NOT NULL DEFAULT 0
  CHECK (backup_email_verified IN (0, 1));
ALTER TABLE users ADD COLUMN backup_email_verified_at TEXT;

-- 部分唯一索引：只约束「已设置备用邮箱」的行，因此多行 NULL 可以共存。
-- lower() 保证大小写不同但等价的地址算同一个（与主邮箱的 users_email_lower_uidx 口径一致）。
CREATE UNIQUE INDEX users_backup_email_lower_uidx
  ON users (lower(backup_email))
  WHERE backup_email IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. profiles：角色状态
-- ----------------------------------------------------------------------------

ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'reserved'));

ALTER TABLE profiles ADD COLUMN status_changed_at TEXT;

-- 单用户名模式下查「我的 active 角色」是最高频的读，给复合索引
CREATE INDEX profiles_user_status_idx ON profiles (user_id, status);


-- ----------------------------------------------------------------------------
-- 3. 备用邮箱验证令牌
--
-- 不复用 email_verification_tokens：那张表没有位置记录「正在验证哪个地址」，
-- 而备用邮箱验证必须知道待绑定的目标地址，否则同一用户同时发起两次绑定会串。
-- ----------------------------------------------------------------------------

CREATE TABLE backup_email_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 本次验证要绑定的备用邮箱地址（小写规范化后写入）
  pending_email TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  used_at       TEXT
);

CREATE INDEX backup_email_tokens_user_idx ON backup_email_tokens (user_id);


-- ----------------------------------------------------------------------------
-- 4. 改邮箱：一次变更请求 + 两枚令牌
--
-- 为什么拆成「请求 + 两枚令牌」而不是一张大表：
--   一次改邮箱要同时驱动两件事 —— 新邮箱证明所有权（verify），
--   另一个邮箱授权这次变更（authorize）。两枚令牌生命周期独立（可能只点了其中
--   一个就放弃），把状态平铺进一行会让「部分完成」无法表达。
--
-- authorize_via 在请求创建时就固定，避免中途换授权邮箱绕过交叉验证。
-- ----------------------------------------------------------------------------

CREATE TABLE email_change_requests (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 这次要改的是哪个邮箱
  target       TEXT NOT NULL CHECK (target IN ('primary', 'backup')),
  new_email    TEXT NOT NULL,
  -- 由哪个邮箱承担交叉授权
  authorize_via TEXT NOT NULL CHECK (authorize_via IN ('primary', 'backup')),
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);

CREATE INDEX email_change_requests_user_idx ON email_change_requests (user_id);

CREATE TABLE email_change_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES email_change_requests (id) ON DELETE CASCADE,
  -- 'verify'    = 发给新邮箱，证明该地址属于本人
  -- 'authorize' = 发给另一个邮箱，授权这次变更（交叉验证）
  role       TEXT NOT NULL CHECK (role IN ('verify', 'authorize')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE INDEX email_change_tokens_user_idx ON email_change_tokens (user_id);
CREATE INDEX email_change_tokens_request_idx ON email_change_tokens (request_id);


-- ----------------------------------------------------------------------------
-- 5. 放开第三方登录的 provider 白名单
--
-- 原约束是 CHECK (provider IN ('github', 'microsoft'))，把可接入的 provider 写死在
-- schema 里。本项目**不直接接入任何第三方登录**，只预留可插拔端口；将来要接
-- bilibili / QQ 之类时不应该再被迫改一次 schema，因此这里去掉该 CHECK。
--
-- SQLite 不支持删除/修改 CHECK 约束，只能重建表。该表在代码中零引用、零数据，
-- 但重建仍按「先建新表 -> 拷数据 -> 换名」的标准做法走，保证对已有数据无损。
-- ----------------------------------------------------------------------------

CREATE TABLE oauth_accounts_new (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 不再限定取值：provider 的合法性由应用层的 registered provider 列表决定
  provider            TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  CONSTRAINT oauth_accounts_provider_uid UNIQUE (provider, provider_account_id)
);

INSERT INTO oauth_accounts_new (id, user_id, provider, provider_account_id, created_at)
  SELECT id, user_id, provider, provider_account_id, created_at FROM oauth_accounts;

DROP TABLE oauth_accounts;

ALTER TABLE oauth_accounts_new RENAME TO oauth_accounts;

CREATE INDEX oauth_accounts_user_idx ON oauth_accounts (user_id);


-- ----------------------------------------------------------------------------
-- 6. 存量回填
--
-- 只有「角色数 <= 1」的用户算已确定模式；多角色的留给用户下次登录自己选。
-- 时间格式与结构一致（ISO-8601 UTC 带毫秒），由应用的 toIso() 解析。
-- ----------------------------------------------------------------------------

UPDATE users
   SET profile_mode_decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE profile_mode_decided_at IS NULL
   AND (SELECT COUNT(*) FROM profiles p WHERE p.user_id = users.id) <= 1;
