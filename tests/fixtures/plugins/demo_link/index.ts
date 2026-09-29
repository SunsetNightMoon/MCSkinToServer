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
  await ctx.db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       subject TEXT PRIMARY KEY,
       remote  TEXT NOT NULL,
       bound_at TEXT NOT NULL
     )`,
  );

  ctx.events.on('profile.renamed', (payload) => {
    renameEvents += 1;
    ctx.logger.info('看到改名事件', { to: payload.to });
  });

  ctx.route({ method: 'GET', path: '/ping', auth: 'public' }, async (_req, res) => {
    const greeting = (await ctx.settings.get<string>('GREETING')) ?? 'hi';
    res.json({ ok: true, plugin: ctx.pluginId, greeting, origin: await ctx.site.publicOrigin() });
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
    // 占位符两边不一样（SQLite 是 ?，PG 是 $1）：作者只需要看 ctx.db.dialect，
    // 不必读核心源码 —— 这正是接口该提供的信息
    const ph = (i: number): string =>
      ctx.db.dialect === 'postgres' ? `$${i + 1}` : '?';
    await ctx.db.run(
      `INSERT INTO ${table} (subject, remote, bound_at) VALUES (${ph(0)}, ${ph(1)}, ${ph(2)})
       ON CONFLICT (subject) DO UPDATE SET remote = excluded.remote`,
      [consumed.subject, remote, new Date().toISOString()],
    );
    bindings.push({ subject: consumed.subject, remote });
    res.json({ ok: true, subject: consumed.subject });
  });

  return () => {
    renameEvents = 0;
    bindings.length = 0;
  };
};

export default setup;
