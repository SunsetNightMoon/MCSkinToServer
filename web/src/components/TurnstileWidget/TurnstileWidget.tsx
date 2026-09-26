import { useEffect, useRef, useState } from 'react'

interface TurnstileWidgetProps {
  siteKey: string
  mode: 'managed' | 'invisible'
  onVerify: (token: string) => void
  onError?: (error: string) => void
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: any) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
    }
  }
}

export function TurnstileWidget({ siteKey, mode, onVerify, onError }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [scriptLoaded, setScriptLoaded] = useState(false)

  useEffect(() => {
    const existingScript = document.querySelector('script[src="https://challenges.cloudflare.com/turnstile/v0/api.js"]')
    if (existingScript) {
      if (window.turnstile) {
        setScriptLoaded(true)
      } else {
        existingScript.addEventListener('load', () => setScriptLoaded(true))
      }
      return
    }

    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
    script.async = true
    script.defer = true
    script.onload = () => setScriptLoaded(true)
    script.onerror = () => {
      if (onError) {
        onError('Failed to load Turnstile script')
      }
    }
    document.head.appendChild(script)
  }, [onError])

  useEffect(() => {
    if (!scriptLoaded || !containerRef.current || !window.turnstile || !siteKey) return

    if (widgetIdRef.current) {
      try {
        window.turnstile.remove(widgetIdRef.current)
      } catch {}
    }

    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      mode,
      callback: (token: string) => {
        onVerify(token)
      },
      'error-callback': () => {
        if (onError) {
          onError('Turnstile verification failed')
        }
      },
      'expired-callback': () => {
        if (onError) {
          onError('Turnstile token expired')
        }
      },
    })

    return () => {
      if (widgetIdRef.current) {
        try {
          window.turnstile?.remove(widgetIdRef.current)
        } catch {}
        widgetIdRef.current = null
      }
    }
  }, [scriptLoaded, siteKey, mode, onVerify, onError])

  return <div ref={containerRef} />
}
