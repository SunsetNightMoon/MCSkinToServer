import type { PluginSetup } from '../../../../plugin-api.js';

type Row = { remote: unknown; status: unknown };

const setup: PluginSetup = async (ctx) => {
  const table = ctx.table('bindings');
  const ph = (i: number): string => (ctx.db.dialect === 'postgres' ? `$${i + 1}` : '?');
  await ctx.db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       subject TEXT PRIMARY KEY,
       remote  TEXT NOT NULL,
       status  TEXT NOT NULL
     )`,
  );

  ctx.events.on('profile.reserved', async (payload) => {
    await ctx.db.run(`DELETE FROM ${table} WHERE subject = ${ph(0)}`, [payload.profileId]);
  });

  ctx.binding({
    async list(actor) {
      const rows = await ctx.db.query<Row>(
        `SELECT remote, status FROM ${table} WHERE subject = ${ph(0)}`,
        [actor.profileId],
      );
      return {
        bindings: rows.map((r) => ({
          id: String(r.remote),
          fields: [{ label: '远端身份', value: String(r.remote) }],
          status: (r.status === 'pending' ? 'pending' : 'active') as 'pending' | 'active',
        })),
      };
    },
    async claim(actor) {
      await ctx.db.run(
        `INSERT INTO ${table} (subject, remote, status) VALUES (${ph(0)}, ${ph(1)}, 'pending')
         ON CONFLICT (subject) DO UPDATE SET remote = excluded.remote, status = 'pending'`,
        [actor.profileId, actor.value],
      );
      return { message: '申请已记录' };
    },
    async revoke(actor) {
      await ctx.db.run(`DELETE FROM ${table} WHERE subject = ${ph(0)} AND remote = ${ph(1)}`, [
        actor.profileId,
        actor.bindingId,
      ]);
    },
  });
};

export default setup;
