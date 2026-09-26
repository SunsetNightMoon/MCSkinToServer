/**
 * 站点设置里「开关类」值的容错解析。
 *
 * ## 为什么需要这个函数
 *
 * 同一个开关在库里可能有三种形态：
 * - AntD `Switch` 提交的 JSON 布尔 `true` / `false`
 * - 旧版前端提交的字符串 `'true'` / `'false'`
 * - 手工 SQL 写入的 `1` / `0`
 *
 * 管理端与站点 store 原先各自用 `data.X === 'true'` 或 `data.X !== 'false'` 判断。
 * 这两种写法都只覆盖了字符串形态，**布尔 false 会被判成 true**：
 * 于是「关掉注册后重新加载，开关又显示成开启」，而库里其实存的是 false。
 * 这类 bug 不会报错、只在界面上撒谎，最难被发现。
 *
 * 本文件是唯一解析入口，语义必须与后端 `src/site/runtimeSettings.ts` 的
 * `toSettingBool` 保持一致 —— 两侧口径不一致就会出现「界面显示开、后端按关执行」。
 */

const TRUE_VALUES = new Set(['true', '1', 'on', 'yes'])
const FALSE_VALUES = new Set(['false', '0', 'off', 'no'])

/**
 * 解析开关值。
 * @param value 后端返回的原始值（`/api/settings/public` 或 `/api/admin/settings`）
 * @param fallback 无法识别时（含 undefined / null / 空串）返回的默认值
 */
export function settingBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value).trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  return fallback
}
