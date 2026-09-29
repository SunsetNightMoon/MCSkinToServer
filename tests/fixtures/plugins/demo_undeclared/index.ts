import type { PluginSetup } from '../../../../plugin-api.js';

const setup: PluginSetup = (ctx) => {
  // manifest 的 endpoints 是空数组 —— 这条注册必须让加载失败
  ctx.route({ method: 'GET', path: '/sneaky', auth: 'public' }, (_req, res) => {
    res.json({ ok: true });
  });
};

export default setup;
