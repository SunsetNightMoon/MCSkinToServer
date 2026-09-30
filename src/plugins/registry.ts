import type { SettingRepository } from '../repositories/settingRepository.js';
import type { PluginManifest } from './api.js';

/**
 * 插件状态与安装记录，全部落在现成的 `system_settings` 里。
 *
 * **刻意不建新表、不加迁移**：这套东西有做废的可能，而「回退代码不需要回退数据库」
 * 是它能不能安全做废的前提。两个键（状态 + 日志）随时可以删掉，不留结构残留。
 * 插件自己的表由插件在 `plugin_<id>_` 前缀下建，卸载时自己删。
 */

const STATE_KEY = 'PLUGINS_STATE';
const LOG_LIMIT = 60;
/**
 * 启停台账的最大留存期：15 天。
 *
 * 这张表是**排障用的**（「刚才那次启用有没有成」「这插件是谁什么时候装的」），
 * 不是审计档案。超过两周的启停记录已经没有可行动的信息，留着只会把最近的挤下去
 * —— 尤其在这套记录只存 `system_settings` 一个键、条目数还有上限的前提下。
 * 真要长期审计，那该是数据库表与另一套决定，不是把这里当日志盘用。
 */
const LOG_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

/** hooks 入口的服务器密钥：由框架托管，不让每个作者自己发明键名 */
export const HOOK_SECRET_KEY = 'HOOK_SECRET';

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  fingerprint: string;
  enabled: boolean;
  firstSeenAt: string;
  updatedAt: string;
  /** manifest 声明过 hmac 入口时才有值：密钥是否已配置（密文形态，永不下发明文） */
  hookSecretSet?: boolean;
}

export interface PluginLogEntry {
  at: string;
  actor: string;
  /**
   * `enable` / `disable` 是**超管的意图**（按下按钮、状态翻过来）；
   * `load` 才是**结果**（代码真的挂进本进程了）。以前加载成功也再记一笔 `enable`，
   * 于是一次点击留下两行同名记录，而两行都不说明「到底挂上没有」。
   */
  action: 'discover' | 'enable' | 'disable' | 'load' | 'error' | 'rotate-secret' | 'unload' | 'import';
  pluginId: string;
  detail?: string;
}

export interface PluginsState {
  plugins: Record<string, PluginRecord>;
  log: PluginLogEntry[];
}

const EMPTY: PluginsState = { plugins: {}, log: [] };

export class PluginRegistry {
  constructor(
    private readonly settings: SettingRepository,
    private readonly now: () => Date,
  ) {}

  async read(): Promise<PluginsState> {
    const raw = await this.settings.get(STATE_KEY);
    if (typeof raw !== 'object' || raw === null) return { plugins: {}, log: [] };
    const value = raw as Partial<PluginsState>;
    return {
      plugins: typeof value.plugins === 'object' && value.plugins !== null ? value.plugins : {},
      log: Array.isArray(value.log) ? value.log.slice(0, LOG_LIMIT) : [],
    };
  }

  private async write(state: PluginsState): Promise<void> {
    await this.settings.setMany({ [STATE_KEY]: state }, this.now());
  }

  /** 扫盘发现：只登记，不改 enabled —— 发现不等于授权 */
  async discovered(manifests: PluginManifest[]): Promise<void> {
    const state = await this.read();
    const at = this.now().toISOString();
    let changed = false;
    for (const manifest of manifests) {
      const existing = state.plugins[manifest.id];
      if (!existing) {
        state.plugins[manifest.id] = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          apiVersion: manifest.apiVersion,
          fingerprint: '',
          enabled: false,
          firstSeenAt: at,
          updatedAt: at,
        };
        this.pushLog(state, 'discover', manifest.id, `${manifest.name} ${manifest.version}`);
        changed = true;
      } else if (
        existing.name !== manifest.name ||
        existing.version !== manifest.version ||
        existing.apiVersion !== manifest.apiVersion
      ) {
        state.plugins[manifest.id] = {
          ...existing,
          name: manifest.name,
          version: manifest.version,
          apiVersion: manifest.apiVersion,
          updatedAt: at,
        };
        this.pushLog(state, 'discover', manifest.id, `版本变化 → ${manifest.version}`);
        changed = true;
      }
    }
    if (changed) await this.write(state);
  }

  async setEnabled(id: string, enabled: boolean, actor: string, detail?: string): Promise<void> {
    const state = await this.read();
    const record = state.plugins[id];
    if (!record) throw new Error(`未发现的插件：${id}`);
    record.enabled = enabled;
    record.updatedAt = this.now().toISOString();
    this.pushLog(state, enabled ? 'enable' : 'disable', id, detail ?? record.version, actor);
    await this.write(state);
  }

  async markHookSecret(id: string, set: boolean, actor: string): Promise<void> {
    const state = await this.read();
    const record = state.plugins[id];
    if (!record) return;
    record.hookSecretSet = set;
    record.updatedAt = this.now().toISOString();
    this.pushLog(state, 'rotate-secret', id, set ? '已生成' : '已清除', actor);
    await this.write(state);
  }

  async logError(id: string, message: string): Promise<void> {
    const state = await this.read();
    this.pushLog(state, 'error', id, message.slice(0, 300));
    await this.write(state);
  }

  /**
   * 正常卸载（停用）不是错误。以前这里借 `logError` 记一笔，
   * 于是台账上一次成功的停用显示成 `error` —— 面板唯一该可信的就是这张表。
   */
  async logUnload(id: string, actor: string): Promise<void> {
    const state = await this.read();
    this.pushLog(state, 'unload', id, `已由 ${actor} 停用`, actor);
    await this.write(state);
  }

  /** 加载成功（不改状态，只记结果）：与 `setEnabled` 的「意图」区分开 */
  async logLoaded(id: string, actor: string, detail: string): Promise<void> {
    const state = await this.read();
    this.pushLog(state, 'load', id, detail, actor);
    await this.write(state);
  }

  /** 从 GitHub 导入落盘（发现不等于授权，所以这里只到「装进目录」） */
  async logImported(id: string, actor: string, detail: string): Promise<void> {
    const state = await this.read();
    this.pushLog(state, 'import', id, detail, actor);
    await this.write(state);
  }

  /** 目录里已经没有这个插件了：把记录摘掉，避免面板挂着不存在的条目 */
  async pruneAbsent(presentIds: string[]): Promise<void> {
    const state = await this.read();
    let changed = false;
    for (const id of Object.keys(state.plugins)) {
      if (!presentIds.includes(id)) {
        delete state.plugins[id];
        this.pushLog(state, 'unload', id, '目录已移除，记录清除');
        changed = true;
      }
    }
    if (changed) await this.write(state);
  }

  private pushLog(
    state: PluginsState,
    action: PluginLogEntry['action'],
    pluginId: string,
    detail?: string,
    actor = 'system',
  ): void {
    state.log.unshift({ at: this.now().toISOString(), actor, action, pluginId, detail });
    // 条数上限之外再加**时间上限**（见 LOG_RETENTION_MS）。按时间整表过滤而不是只削尾部：
    // 站点重启、时钟回拨都可能让旧记录夹在新记录前面，只削尾巴会漏。
    const cutoff = this.now().getTime() - LOG_RETENTION_MS;
    state.log = state.log
      .filter((item) => {
        const at = Date.parse(item.at);
        return Number.isFinite(at) && at >= cutoff;
      })
      .slice(0, LOG_LIMIT);
  }
}
