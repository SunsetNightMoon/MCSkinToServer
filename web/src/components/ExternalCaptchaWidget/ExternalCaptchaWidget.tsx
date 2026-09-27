import { useEffect, useRef, useState } from 'react'

/**
 * 外部人机验证组件（Issue #3）。
 *
 * ## 为什么不叫 TurnstileWidget
 *
 * 后端把外部验证做成了「端点可配、不绑定厂商」（`EXTERNAL_CAPTCHA_*`），本组件跟着
 * 一起中立化：加载哪个脚本、调哪个全局对象都由配置传进来。Turnstile / hCaptcha /
 * reCAPTCHA 的显式渲染 API 恰好是同一形状
 * （`window.<name>.render(el, { sitekey, callback, 'error-callback', 'expired-callback' })`），
 * 所以一份实现能覆盖三家；需要厂商签名的服务（腾讯天御、阿里云、易盾、GeeTest）
 * 形状不同，得另写组件，这里不假装支持。
 *
 * ## 两个实现选择
 *
 * - **脚本按 URL 去重加载**：登录页与注册页都挂本组件时不该下载两次。
 * - **加载完再轮询全局对象**：三家的 api.js 都不保证 `onload` 触发时全局对象已就绪
 *   （reCAPTCHA 还会走 `onload=` 回调参数，但那要求改脚本 URL，配置项里塞不动）。
 *   轮询比绑各自的回调约定更稳，代价是最多多等几百毫秒。
 */

export interface ExternalCaptchaWidgetProps {
  siteKey: string
  scriptUrl: string
  /** 脚本注入到 window 上的对象名：turnstile / hcaptcha / grecaptcha */
  globalName: string
  onVerify: (token: string) => void
  /** reason 是给页面翻译用的码，不在组件里写死文案 */
  onError?: (reason: 'load' | 'unavailable' | 'verify' | 'expired') => void
}

interface CaptchaApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  reset?: (widgetId: string) => void
  remove?: (widgetId: string) => void
}

/** 已发起过加载的脚本 URL → 加载结果（失败也记着，避免无限重试打网络） */
const scriptPromises = new Map<string, Promise<boolean>>()

function loadScript(url: string): Promise<boolean> {
  const existing = scriptPromises.get(url)
  if (existing) return existing

  const pending = new Promise<boolean>((resolve) => {
    if (document.querySelector(`script[src="${url}"]`)) {
      resolve(true)
      return
    }
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.defer = true
    script.onload = () => resolve(true)
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })

  scriptPromises.set(url, pending)
  return pending
}

/** 轮询等待全局对象出现；超时返回 null */
async function waitForApi(
  globalName: string,
  timeoutMs = 8000,
): Promise<CaptchaApi | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = (window as unknown as Record<string, unknown>)[globalName];
    if (candidate && typeof (candidate as CaptchaApi).render === 'function') {
      return candidate as CaptchaApi
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  return null
}

export function ExternalCaptchaWidget({
  siteKey,
  scriptUrl,
  globalName,
  onVerify,
  onError,
}: ExternalCaptchaWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const apiRef = useRef<CaptchaApi | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    if (scriptUrl === '' || globalName === '') {
      onError?.('unavailable')
      return
    }

    void (async () => {
      const loaded = await loadScript(scriptUrl)
      if (cancelled) return
      if (!loaded) {
        onError?.('load')
        return
      }
      const api = await waitForApi(globalName)
      if (cancelled) return
      if (!api) {
        onError?.('unavailable')
        return
      }
      apiRef.current = api
      setReady(true)
    })()

    return () => {
      cancelled = true
    }
  }, [scriptUrl, globalName, onError])

  useEffect(() => {
    if (!ready || !containerRef.current || !apiRef.current || siteKey === '') return

    const api = apiRef.current
    if (widgetIdRef.current) {
      try {
        api.remove?.(widgetIdRef.current)
      } catch {
        // 上一实例已被页面自己清掉，忽略
      }
    }

    widgetIdRef.current = api.render(containerRef.current, {
      sitekey: siteKey,
      callback: (token: string) => onVerify(token),
      'error-callback': () => onError?.('verify'),
      'expired-callback': () => onError?.('expired'),
    })

    return () => {
      if (widgetIdRef.current) {
        try {
          api.remove?.(widgetIdRef.current)
        } catch {
          // 同上
        }
        widgetIdRef.current = null
      }
    }
  }, [ready, siteKey, onVerify, onError])

  return <div ref={containerRef} />
}
