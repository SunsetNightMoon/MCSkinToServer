import type { DatabaseConnection } from '../types.js';
import { phAt } from '../db/rows.js';
import type { CachePort } from '../cache/types.js';
import { CacheKeys } from '../cache/keys.js';
import { DEFAULT_SETTINGS_CACHE_TTL_MS } from '../config.js';

/**
 * system_settings 键值表 repository（表已存在于 0001_init，无需新迁移）。
 *
 * 值语义：应用层统一以 **JSON 文本**读写（SQLite 存 TEXT、PG 存 JSONB），
 * 调用方拿到的是已经 JSON.parse 过的值，因此数字/布尔/对象都能安全往返。
 *
 * 键名沿用旧版前端的 SCREAMING_SNAKE_CASE（SITE_TITLE / LIGHT_BG_IMAGE …），
 * 这样 /api/settings/public 的形状与旧站一致，前端 siteStore 无需改协议。
 */

/**
 * 对外公开可读的设置键（站点外观与文案；凭据类键永不入此表导出）。
 *
 * ⚠️ 这里漏一个键，症状就是「管理端保存成功、刷新页面却还是旧值」——
 * 因为 getPublic 只导出白名单内的键，未列入的键写进去了但读不出来。
 * 新增任何「访客可见」的设置项时，必须同时加到这里，
 * 否则 /api/settings/public 不返回它，前端只会默默回落到默认值。
 *
 * 注意与本文件的「键名大小写」约定：全大写 SCREAMING_SNAKE_CASE。
 * 管理端表单的 Form.Item name 必须使用同样的拼写，写入与读取才能对上。
 */
export const PUBLIC_SETTING_KEYS: readonly string[] = [
  'SITE_TITLE',
  'SITE_DESCRIPTION',
  'SITE_FAVICON',
  'SITE_LOGO',
  'DEFAULT_LANGUAGE',
  'THEME',
  'LIGHT_BG_IMAGE',
  'DARK_BG_IMAGE',
  'LOGIN_BG_IMAGE',
  'LOGIN_EMBED_IMAGE',
  'VIDEO_MUTED',
  'LIGHT_BG_OVERLAY_OPACITY',
  'DARK_BG_OVERLAY_OPACITY',
  'COPYRIGHT_TEXT',
  'COPYRIGHT_BEIAN',
  'COPYRIGHT_PROJECT',
  'ALLOW_REGISTRATION',
  'REQUIRE_EMAIL_VERIFICATION',
  'ENABLE_CAPTCHA',
  // 首页文案
  'HOMEPAGE_TITLE_TEXT',
  'HOMEPAGE_TEXT',
  'HOMEPAGE_BUTTON_TEXT',
  'HOMEPAGE_BUTTONS',
  // 首页高度自定义（HTML/CSS 由管理员撰写，本来就随页面公开下发）
  'HOMEPAGE_CUSTOM_ENABLED',
  'HOMEPAGE_CUSTOM_HTML',
  'HOMEPAGE_CUSTOM_CSS',
];

function parseValue(raw: unknown): unknown {
  // PG 的 jsonb 可能已被驱动解析为 JS 值；SQLite 一定是字符串
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class SettingRepository {
  /**
   * @param cache 可选缓存端口（P5）。未注入时所有读取直连数据库，行为与本类引入缓存前完全一致。
   * @param publicTtlMs 公开设置的缓存 TTL
   */
  constructor(
    private readonly db: DatabaseConnection,
    private readonly cache?: CachePort,
    private readonly publicTtlMs: number = DEFAULT_SETTINGS_CACHE_TTL_MS,
  ) {}

  /** 全部设置（管理端读取）。**不缓存**：管理端必须看到刚写入的值 */
  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db.query<Record<string, unknown>>(
      'SELECT key, value FROM system_settings',
    );
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row['key'] as string] = parseValue(row['value']);
    }
    return result;
  }

  /**
   * 公开白名单子集（/api/settings/public），只返回已显式设置过的键。
   *
   * 走缓存：该端点是每次页面加载都会命中的高频读、且键值极少变更，
   * 写路径（setMany）会主动失效，因此不存在读到自己刚写的旧值的风险。
   */
  async getPublic(): Promise<Record<string, unknown>> {
    const cacheKey = CacheKeys.publicSettings();
    if (this.cache) {
      const cached = await this.cache.get<Record<string, unknown>>(cacheKey);
      if (cached !== undefined) return cached;
    }

    const all = await this.getAll();
    const result: Record<string, unknown> = {};
    for (const key of PUBLIC_SETTING_KEYS) {
      if (all[key] !== undefined) result[key] = all[key];
    }

    if (this.cache) {
      await this.cache.set(cacheKey, result, this.publicTtlMs);
    }
    return result;
  }

  /** 读取单个键（如注册开关判定） */
  async get(key: string): Promise<unknown> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT value FROM system_settings WHERE key = ${phAt(this.db.dialect, 0)}`,
      [key],
    );
    return rows[0] ? parseValue(rows[0]['value']) : undefined;
  }

  /** 批量 upsert（管理端保存）；值统一 JSON 序列化后写入 */
  async setMany(entries: Record<string, unknown>, at: Date): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      const json = JSON.stringify(value === undefined ? null : value);
      const iso = at.toISOString();
      const keyPh = phAt(this.db.dialect, 0);
      const valuePh = phAt(this.db.dialect, 1);
      // PG 的 jsonb 列绑定需显式转型，否则报 column is of type jsonb but expression is text
      const valueExpr =
        this.db.dialect === 'postgres' ? `${valuePh}::jsonb` : valuePh;
      await this.db.run(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES (${keyPh}, ${valueExpr}, ${phAt(this.db.dialect, 2)})
         ON CONFLICT (key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
        [key, json, iso],
      );
    }
    // 写入后失效公开缓存，避免读到旧值。缓存只用于 getPublic 的读穿透，
    // 管理端 getAll 不缓存，因此只需清这一个键。
    await this.cache?.del(CacheKeys.publicSettings());
  }
}
