/**
 * 站点设置里 `HOMEPAGE_BUTTONS`（首页额外按钮）的容错解析。
 *
 * ## 为什么需要这个函数
 *
 * 这个值在库里/接口上有两种真实形态，且都必须能吃：
 * - **JSON 字符串** `'[{"text":"…","link":"…"}]'`：管理端保存时走
 *   `JSON.stringify(buttons)`，后端 `setMany` 再 `JSON.stringify` 一次，
 *   读取端 `parseValue` 解一层 → 拿到的仍是字符串。
 * - **已解析数组** `[{"text":"…","link":"…"}]`：早期版本 / 手工 SQL 直接写入
 *   数组本体，后端 jsonb / parseValue 原样解出 → 拿到的就是 JS 数组
 *   （生产域名服务器上正是这一形态）。
 *
 * 改动前两处读取都直接 `JSON.parse(raw)`。当 raw 已经是数组时，`JSON.parse`
 * 会先把数组隐式转成字符串 `'[object Object]'` 再解析 —— 必然抛错，被 catch
 * 吞掉后回落到 `[]`。症状就是：明明存了按钮，管理页永远显示「当前 0 个」、
 * 首页也不渲染，看起来像「额外按钮无法保存」。
 *
 * 与 `settingBool` 同一纪律：唯一解析入口，两种形态都要覆盖，解析不出来才回落空数组。
 */

export interface HomepageButton {
  text: string
  link: string
}

/** 把后端返回的任意形态值归一化为按钮数组（无法识别时返回空数组） */
export function parseHomepageButtons(value: unknown): HomepageButton[] {
  let list: unknown = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return []
    try {
      list = JSON.parse(trimmed)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ text: String(item.text ?? ''), link: String(item.link ?? '') }))
}
