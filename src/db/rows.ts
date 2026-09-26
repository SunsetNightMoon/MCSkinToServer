import type { Dialect } from '../types.js';

/**
 * 行值与占位符的跨方言工具。
 *
 * 时间约定（schema-design §1.4）：应用层写入 UTC ISO 字符串；
 * PostgreSQL 读取 TIMESTAMPTZ 返回 Date，SQLite 返回 TEXT —— 统一归一化为 ISO 字符串。
 */

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function phAt(dialect: Dialect, index: number): string {
  return dialect === 'postgres' ? `$${index + 1}` : '?';
}

export function placeholders(dialect: Dialect, count: number): string {
  return Array.from({ length: count }, (_, i) => phAt(dialect, i)).join(', ');
}

/** SQLite 返回 INTEGER 0/1，PostgreSQL 返回 boolean —— 统一为 boolean */
export function toBoolean(value: unknown): boolean {
  return value === true || value === 1;
}
