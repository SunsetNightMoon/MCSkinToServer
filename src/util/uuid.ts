import { AppError } from '../errors.js';

/**
 * 数据库主键格式闸门。
 *
 * 背景：所有表的主键都是 `randomUUID()` 生成的规范 UUID（小写带连字符），
 * PostgreSQL 的列类型是 uuid —— 传入 `skins` 这类非 UUID 字符串时，数据库
 * 直接抛 `22P02 invalid input syntax for type uuid`，经 errorHandler 落到
 * 兜底 500；而 SQLite 按普通字符串比较、静默返回空 → 404。两个方言对同一
 * 输入行为不一致，且公开端点（`GET /api/library/:id` 等）可被匿名刷 500
 * （日志噪音 + 状态码语义错误）。
 *
 * 修法：id 进入查询前先过格式闸门，非规范 UUID 一律按「资源不存在」
 * （NOT_FOUND）处理 —— 与「格式正确但不存在」的既有行为完全一致，
 * 不额外泄露信息，也不区分方言。闸门放服务层入口（HTTP 层只解析、
 * 仓储层不该懂 HTTP 语义），一处守卫覆盖直接调用与 HTTP 调用双方。
 */

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 是否为内部规范 UUID（`randomUUID()` 的小写带连字符形态）。
 * 刻意不做大小写归一：内部 id 全部小写，这里只挡「明显不是 UUID」的
 * 输入（如路径里混进 `skins`、`not-a-uuid`、`../etc`），不做等价改写。
 */
export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID_RE.test(value);
}

/**
 * 服务层入口的格式闸门：非规范 UUID 直接抛 NOT_FOUND。
 * `message` 传该资源的「不存在」文案，与缺失分支共用同一句话，
 * 让客户端无法区分「id 格式错」与「id 不存在」。
 */
export function requireCanonicalUuid(value: string, message: string): string {
  if (!isCanonicalUuid(value)) {
    throw new AppError('NOT_FOUND', message);
  }
  return value;
}
