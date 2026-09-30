/**
 * 夹具插件：证明「一个仓库外的作者只靠 plugin-api.d.ts + guide 就能写出功能插件」。
 *
 * 刻意**不 import 任何核心内部模块** —— 如果哪天这里被迫去 import 核心实现才能干活，
 * 那就是接口有缺口，要补的是接口而不是这个插件。
 */
import type { PluginContext, PluginSetup } from '../../../../plugin-api.js';

let renameEvents = 0;
const bindings: { subject: string; remote: string }[] = [];

const setup: PluginSetup = async (ctx: PluginContext) => {
  const table = ctx.table('bindings');
  // 占位符两边不一样（SQLite 是 ?，PG 是 $1）：作者只需要看 ctx.db.dialect，
  // 不必读核心源码 —— 这正是接口该提供的信息
  const ph = (i: number): string => (ctx.db.dialect === 'postgres' ? `$${i + 1}` : '?');
  await ctx.db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       subject TEXT PRIMARY KEY,
       remote  TEXT NOT NULL,
       bound_at TEXT NOT NULL
     )`,
  );
  // 第四批契约加了 status 列；共用库上老表可能已存在，ALTER 撞重复列就跳过
  try {
    await ctx.db.run(`ALTER TABLE ${table} ADD COLUMN status TEXT`);
  } catch {
    /* 列已存在 */
  }

  ctx.events.on('profile.renamed', (payload) => {
    renameEvents += 1;
    ctx.logger.info('看到改名事件', { to: payload.to });
  });

  ctx.route({ method: 'GET', path: '/ping', auth: 'public' }, async (_req, res) => {
    const greeting = (await ctx.settings.get<string>('GREETING')) ?? 'hi';
    res.json({
      ok: true,
      plugin: ctx.pluginId,
      greeting,
      origin: await ctx.site.publicOrigin(),
      hasPublicKey: (await ctx.site.publicKeyPem()) !== null,
    });
  });

  ctx.route({ method: 'POST', path: '/issue', auth: 'user' }, async (req, res) => {
    // 接口缺口实测出来的：**web token 不带 profileId**（那是启动器选定角色的概念，
    // 见 RequestContext 注释），所以「按角色绑定」的插件必须由页面自己把 profileId 传上来。
    // 这里不静默回落到 userId —— 回落会让绑定落在错误的粒度上，而且没人知道。
    const subject = String(req.body['profileId'] ?? '');
    if (subject === '') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '缺少 profileId（web 会话不隐含角色）' });
      return;
    }
    const issued = await ctx.tokens.issue({ subject, ttlMs: 300_000, data: { by: req.user?.userId } });
    res.json(issued);
  });

  ctx.route({ method: 'GET', path: '/bindings', auth: 'user' }, async (_req, res) => {
    res.json({ bindings: await ctx.db.query(`SELECT subject, remote FROM ${table}`) });
  });

  ctx.route({ method: 'GET', path: '/renames', auth: 'admin' }, (_req, res) => {
    res.json({ renameEvents });
  });

  ctx.hook({ method: 'POST', path: '/bind', auth: 'hmac' }, async (req, res) => {
    const token = String(req.body['token'] ?? '');
    const remote = String(req.body['remote'] ?? '');
    const consumed = await ctx.tokens.consume(token);
    if (!consumed || remote === '') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '码无效或缺少远端身份' });
      return;
    }
    await ctx.db.run(
      `INSERT INTO ${table} (subject, remote, bound_at, status) VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, 'active')
       ON CONFLICT (subject) DO UPDATE SET remote = excluded.remote, status = 'active'`,
      [consumed.subject, remote, new Date().toISOString()],
    );
    bindings.push({ subject: consumed.subject, remote });
    res.json({ ok: true, subject: consumed.subject });
  });

  // 服务器实测到该远端身份真的登进来了 → 把网页侧的待确认申请签发为生效（签证模型）
  ctx.hook({ method: 'POST', path: '/confirm', auth: 'hmac' }, async (req, res) => {
    const remote = String(req.body['remote'] ?? '');
    if (remote === '') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '缺少 remote' });
      return;
    }
    await ctx.db.run(
      `UPDATE ${table} SET status = 'active', bound_at = ${ph(0)} WHERE remote = ${ph(1)} AND status = 'pending'`,
      [new Date().toISOString(), remote],
    );
    const rows = await ctx.db.query<{ subject: unknown }>(
      `SELECT subject FROM ${table} WHERE remote = ${ph(0)}`,
      [remote],
    );
    res.json({ ok: rows.length > 0, subject: rows.length > 0 ? String(rows[0]!['subject']) : null });
  });

  // ---- 通用绑定页（账号设置区）：核心完成会话鉴权 + 角色归属校验，这里只管数据 ----
  ctx.binding({
    async list(actor) {
      // subject='profile'：actor.profileId 一定是当前账号名下已验属的活跃角色
      const rows = await ctx.db.query<{ remote: unknown; bound_at: unknown; status: unknown }>(
        `SELECT remote, bound_at, status FROM ${table} WHERE subject = ${ph(0)}`,
        [actor.profileId],
      );
      return {
        bindings: rows.map((r) => ({
          id: String(r.remote),
          fields: [{ label: '远端身份', value: String(r.remote) }],
          boundAt: String(r.bound_at),
          status: (r.status === 'pending' ? 'pending' : 'active') as 'pending' | 'active',
        })),
        instructions: `在游戏里输入 /demo link {{code}} 完成绑定（角色 ${actor.profileName}）`,
      };
    },
    async claim(actor) {
      // value 已由核心按 manifest 的 pattern 校验过；这里只处理业务冲突
      const existing = await ctx.db.query<{ subject: unknown; status: unknown }>(
        `SELECT subject, status FROM ${table} WHERE remote = ${ph(0)}`,
        [actor.value],
      );
      const hit = existing[0];
      if (hit && String(hit.subject) !== String(actor.profileId)) {
        return { message: `该远端身份已被占用（状态：${String(hit.status)}）` };
      }
      await ctx.db.run(
        `INSERT INTO ${table} (subject, remote, bound_at, status) VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, 'pending')
         ON CONFLICT (subject) DO UPDATE SET remote = excluded.remote, status = 'pending'`,
        [actor.profileId, actor.value, new Date().toISOString()],
      );
      return { message: '申请已记录，进服后自动生效' };
    },
    async issue(actor) {
      const ttl = Number((await ctx.settings.get('LINK_TTL_SECONDS')) ?? 300) * 1000;
      const issued = await ctx.tokens.issue({
        subject: String(actor.profileId),
        ttlMs: ttl,
        data: { by: actor.userId },
      });
      return { code: issued.token, expiresAt: issued.expiresAt };
    },
    async revoke(actor) {
      // 解绑是玩家本人（网页侧）的操作；profileId 已由核心验属，这里连它一起当条件
      await ctx.db.run(
        `DELETE FROM ${table} WHERE subject = ${ph(0)} AND remote = ${ph(1)}`,
        [actor.profileId, actor.bindingId],
      );
      const at = bindings.findIndex((b) => b.subject === actor.profileId && b.remote === actor.bindingId);
      if (at >= 0) bindings.splice(at, 1);
    },
  });

  return () => {
    renameEvents = 0;
    bindings.length = 0;
  };
};

export default setup;
