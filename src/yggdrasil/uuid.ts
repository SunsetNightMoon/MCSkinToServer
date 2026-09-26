import { illegalArgument } from './errors.js';

/**
 * Profile UUID 的边界格式约定（schema-design §1.3）：
 * 内部统一小写带连字符；Yggdrasil 协议对外输出/输入无连字符。
 */

/** 带连字符或无连字符 → 无连字符小写（协议输出） */
export function toShortUuid(input: string): string {
  const s = input.trim().toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(s)) {
    throw illegalArgument(`非法 Profile UUID: ${input}`);
  }
  return s;
}

/** 无连字符（协议输入）→ 内部规范格式 */
export function toCanonicalUuid(input: string): string {
  const s = input.trim().toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(s)) {
    throw illegalArgument(`非法 Profile UUID: ${input}`);
  }
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** 任何格式 → 规范格式；仅用于内部规范化（不抛协议错误） */
export function normalizeUuid(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(s) ? toCanonicalUuid(s) : null;
}
