import type { PluginSetup } from '../../../../plugin-api.js';

const setup: PluginSetup = (ctx) => {
  ctx.binding({
    list: () => ({ bindings: [] }),
    issue: () => ({ code: 'NOPE', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    claim: () => undefined,
  });
};

export default setup;
