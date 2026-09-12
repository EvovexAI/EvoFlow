/**
 * Desktop transport audit helpers — paste in DevTools Console on Tauri.
 * Goal: no WebView Network hits to http://127.0.0.1:8070/api/... for app data.
 */

export function installDesktopTransportAudit() {
  if (typeof window === 'undefined') return () => {}
  const origFetch = window.fetch.bind(window)
  const hits = []
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input)
    if (/127\.0\.0\.1:\d+\/api\//.test(url) || /^https?:\/\/[^/]+\/api\//.test(url)) {
      const row = { url, method: init?.method || 'GET', at: new Date().toISOString(), stack: new Error().stack }
      hits.push(row)
      console.warn('[transport-audit] WebView direct Gateway fetch', row)
    }
    return origFetch(input, init)
  }
  window.__EVOFLOW_TRANSPORT_HITS__ = hits
  console.info('[transport-audit] installed. Inspect window.__EVOFLOW_TRANSPORT_HITS__ after using the app.')
  return () => {
    window.fetch = origFetch
  }
}
