import type { PluginEventName, PluginEventPayloads } from './api.js';

/**
 * 插件事件总线。
 *
 * 两条不可商量的性质：
 * 1. **逐 listener 隔离**。一个插件的回调抛错绝不能把核心请求变成 500 —— 那是框架的
 *    缺陷，跟插件善恶无关。所以每个回调自己 catch、自己记日志、继续下一个。
 * 2. **不阻塞主流程**。事件是 fire-and-forget：核心不 await 插件的处理结果，
 *    因此插件不能靠事件改写已完成的业务决定（要改行为请走显式端点，别塞进总线）。
 *    这也是我们**不做**「可返回覆盖值的拦截器」的原因 —— 一旦允许返回，
 *    插件顺序就会影响结果，而排查难度是指数级上升。
 */

type Listener = (payload: unknown) => void | Promise<void>;

export class PluginEventBus {
  private readonly listeners = new Map<PluginEventName, Listener[]>();

  /** 整个子系统关掉时这个实例根本不会被创建，所以这里不需要再判开关 */
  private enabled = true;

  subscribe<K extends PluginEventName>(name: K, handler: Listener): void {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
  }

  /** 卸载插件时把它留下的回调全部摘掉，否则旧闭包会一直持有已销毁的 ctx */
  unsubscribeAll(names?: PluginEventName[]): void {
    if (!names) {
      this.listeners.clear();
      return;
    }
    for (const name of names) this.listeners.delete(name);
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  emit<K extends PluginEventName>(name: K, payload: PluginEventPayloads[K]): void {
    if (!this.enabled) return;
    const list = this.listeners.get(name);
    if (!list || list.length === 0) return;
    for (const handler of [...list]) {
      try {
        const out = handler(payload);
        if (out instanceof Promise) {
          out.catch((err: unknown) => {
            console.error(`[plugins] 事件 ${name} 的回调 rejected:`, errText(err));
          });
        }
      } catch (err) {
        console.error(`[plugins] 事件 ${name} 的回调抛错:`, errText(err));
      }
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 全局单例 + 空实现入口。
 *
 * 核心里的 emit 调用点必须写成一行、且**默认零开销**：子系统没开时 bus 是 undefined，
 * emitPluginEvent 直接 return。这样「做废时回退」只需要删掉那几行调用点，
 * 或者干脆留着（它是个 no-op，不留任何行为痕迹）。
 */
let bus: PluginEventBus | undefined;

export function installPluginEventBus(instance: PluginEventBus | undefined): void {
  bus = instance;
}

export function emitPluginEvent<K extends PluginEventName>(
  name: K,
  payload: PluginEventPayloads[K],
): void {
  bus?.emit(name, payload);
}
