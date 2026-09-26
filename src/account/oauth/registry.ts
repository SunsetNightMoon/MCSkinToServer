import type { OAuthProvider } from './types.js';

/**
 * provider 注册表（P5 批4-F）。
 *
 * 为什么是**模块级单例**而不是注入进 `AppDependencies`：
 * provider 的注册发生在「启动装配」这一步之外 —— 接入方往往在自己的启动脚本里
 * 注册（那里拿不到 `createApp` 的内部依赖），也可能在测试里临时注册。
 * 单例让「注册」与「创建 app」解耦：先注册，后 `createApp`，顺序无关。
 *
 * 代价是测试之间会互相污染，因此提供 {@link resetOAuthProviders} 供测试清理。
 * `createOAuthRouter` 另接受显式 provider 列表，测试可以完全不碰单例。
 *
 * 线程/请求安全：Node 单线程，注册只发生在启动阶段，读取是纯内存查表，
 * 运行期不存在并发写。这里不需要锁。
 */

const registry = new Map<string, OAuthProvider>();

/**
 * 注册（或覆盖）一个 provider。
 *
 * 同 id 重复注册以**后注册的为准**：接入方在开发期反复热重载时不该看到
 * 「id 已被占用」这类噪音，而覆盖语义在启动阶段是明确的。
 */
export function registerOAuthProvider(provider: OAuthProvider): void {
  if (!provider.id || provider.id.trim() === '') {
    throw new Error('OAuthProvider.id 不能为空');
  }
  registry.set(provider.id, provider);
}

/** 注销一个 provider；返回是否确实删掉了 */
export function unregisterOAuthProvider(id: string): boolean {
  return registry.delete(id);
}

/** 已注册且启用的 provider（保持注册顺序，便于前端按固定顺序展示） */
export function listOAuthProviders(): OAuthProvider[] {
  return [...registry.values()].filter((p) => p.enabled);
}

/** 按 id 取已启用的 provider；禁用或未注册都返回 null（调用方无需区分） */
export function findOAuthProvider(id: string): OAuthProvider | null {
  const found = registry.get(id);
  return found && found.enabled ? found : null;
}

/** 清空注册表。仅供测试使用。 */
export function resetOAuthProviders(): void {
  registry.clear();
}

/**
 * 前端登录页/注册页的第三方登录小格子读的是**旧版形状**的开关对象
 * （`{ github: boolean, microsoft: boolean }`，见 `web/src/pages/Auth/Login.tsx`）。
 *
 * 为不改动既有 JSX（沿用旧版界面是硬约束），这里把注册表映射回该形状：
 * - 已知键（github / microsoft）**永远出现**，未注册时为 false；
 *   保证响应形状稳定，前端读 `data.github` 不会拿到 undefined。
 * - 其余已注册且启用的 provider id 也带 `true` 一并返回。
 *   前端目前只读自己认识的两个键，多出来的键无副作用；
 *   将来前端改成按数组渲染时，这些键可平滑承接。
 *
 * 注意这里**只输出布尔开关，不输出 client id / secret / 授权地址** ——
 * 这些响应可能被缓存、被日志记录，第三方登录的公开端点不应回显任何凭据。
 */
export const LEGACY_PROVIDER_FLAGS = ['github', 'microsoft'] as const;

export function advertiseProviderFlags(
  providers: OAuthProvider[] = listOAuthProviders(),
): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const key of LEGACY_PROVIDER_FLAGS) flags[key] = false;
  for (const p of providers) {
    if (p.enabled) flags[p.id] = true;
  }
  return flags;
}

/** 通用端点用的精简描述（只暴露公开信息，不含凭据） */
export interface OAuthProviderSummary {
  id: string;
  displayName: string;
}

export function summarizeOAuthProviders(
  providers: OAuthProvider[] = listOAuthProviders(),
): OAuthProviderSummary[] {
  return providers
    .filter((p) => p.enabled)
    .map((p) => ({ id: p.id, displayName: p.displayName }));
}
