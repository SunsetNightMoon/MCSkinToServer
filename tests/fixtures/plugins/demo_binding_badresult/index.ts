import type { PluginSetup } from '../../../../plugin-api.js';

const setup: PluginSetup = (ctx) => {
  ctx.binding({
    // 行缺 id、fields 不是对象数组 —— 两个断言各打一处校验分支
    list: () => ({ bindings: [{ fields: 'nope' }] }) as never,
    issue: () => ({ code: '', expiresAt: 'not-a-date' }) as never,
  });
};

export default setup;
