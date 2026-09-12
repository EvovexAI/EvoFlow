import { useEffect, useState } from 'react'

/** Module cache so later mounts skip the async hop after first resolve. */
let cachedGatewayBase: string | undefined

/**
 * Resolve Gateway origin for absolute `/api/...` asset URLs (avatars, etc.).
 *
 * In Vite browser-dev, `getGatewayBaseUrl()` returns `''` (same-origin proxy).
 * In installed Tauri, it returns `http://127.0.0.1:<port>` — relative `/api`
 * paths would otherwise hit the webview origin and 404.
 *
 * When `override` is a non-empty string, it wins and `ready` is immediate.
 */
export function useGatewayBaseUrl(override?: string): { baseUrl: string; ready: boolean } {
  const hasOverride = Boolean(override && String(override).trim())
  const [baseUrl, setBaseUrl] = useState(() =>
    hasOverride ? String(override).trim() : cachedGatewayBase ?? '',
  )
  const [ready, setReady] = useState(() => hasOverride || cachedGatewayBase !== undefined)

  useEffect(() => {
    if (hasOverride) {
      setBaseUrl(String(override).trim())
      setReady(true)
      return
    }
    if (cachedGatewayBase !== undefined) {
      setBaseUrl(cachedGatewayBase)
      setReady(true)
      return
    }
    let cancelled = false
    void import('../../lib/tauri-api.js')
      .then(async (mod) => {
        const b = (await mod.getGatewayBaseUrl()) || ''
        cachedGatewayBase = b
        if (!cancelled) {
          setBaseUrl(b)
          setReady(true)
        }
      })
      .catch(() => {
        cachedGatewayBase = ''
        if (!cancelled) {
          setBaseUrl('')
          setReady(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [hasOverride, override])

  return { baseUrl: hasOverride ? String(override).trim() : baseUrl, ready }
}
