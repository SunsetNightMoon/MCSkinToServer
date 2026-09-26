import type { DatabaseConnection } from '../types.js';
import { phAt } from '../db/rows.js';

/**
 * system_settings 键值表 repository（表已存在于 0001_init，无需新迁移）。
 *
 * 值语义：应用层统一以 **JSON 文本**读写（SQLite 存 TEXT、PG 存 JSONB），
 * 调用方拿到的是已经 JSON.parse 过的值，因此数字/布尔/对象都能安全往返。
 *
 * 键名沿用旧版前端的 SCREAMING_SNAKE_CASE（SITE_TITLE / LIGHT_BG_IMAGE …），
 * 这样 /api/settings/public 的形状与旧站一致，前端 siteStore 无需改协议。
 */

/** 对外公开可读的设置键（站点外观与文案；凭据类键永不入此表导出） */
export const PUBLIC_SETTING_KEYS: readonly string[] = [
  'SITE_TITLE',
  'SITE_DESCRIPTION',
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
  constructor(private readonly db: DatabaseConnection) {}

  /** 全部设置（管理端读取） */
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

  /** 公开白名单子集（/api/settings/public），只返回已显式设置过的键 */
  async getPublic(): Promise<Record<string, unknown>> {
    const all = await this.getAll();
    const result: Record<string, unknown> = {};
    for (const key of PUBLIC_SETTING_KEYS) {
      if (all[key] !== undefined) result[key] = all[key];
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
  }
}
