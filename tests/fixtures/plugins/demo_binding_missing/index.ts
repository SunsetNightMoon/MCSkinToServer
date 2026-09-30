import type { PluginSetup } from '../../../../plugin-api.js';

const setup: PluginSetup = (ctx) => {
  ctx.route({ method: 'GET', path: '/ping', auth: 'public' }, (_req, res) => {
    res.json({ ok: true, plugin: ctx.pluginId });
  });
  // 故意不登记 ctx.binding() —— 声明与实现之间的缺口要能被玩家侧入口直接暴露出来
};

export default setup;
