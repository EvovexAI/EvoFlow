/**
 * 小V / platform 写操作后的页面实时刷新总线。
 * 各模块页订阅后做局部 reload；未订阅时回退 softReloadCurrentRoute。
 */
import { getCurrentRoute, reloadCurrentRoute } from '../router.js'

export const PAGE_LIVE_REFRESH_EVENT = 'evoflow:page-live-refresh'

/**
 * @typedef {{
 *   domains?: string[],
 *   source?: string,
 *   route?: string,
 *   soft?: boolean,
 *   reason?: string,
 * }} PageLiveRefreshDetail
 */

/**
 * @param {PageLiveRefreshDetail} [detail]
 */
export function emitPageLiveRefresh(detail = {}) {
  const payload = {
    domains: Array.isArray(detail.domains) ? detail.domains.map(String) : [],
    source: String(detail.source || 'xiaomi'),
    route: String(detail.route || getCurrentRoute() || ''),
    soft: detail.soft !== false,
    reason: String(detail.reason || ''),
    at: Date.now(),
  }
  try {
    window.dispatchEvent(new CustomEvent(PAGE_LIVE_REFRESH_EVENT, { detail: payload }))
  } catch (e) {
    console.warn('[page-live-refresh] emit failed', e)
  }
  return payload
}

/**
 * @param {(detail: PageLiveRefreshDetail & { at?: number }) => void | Promise<void>} handler
 * @param {{ domains?: string[], routes?: RegExp[] }} [opts]
 * @returns {() => void}
 */
export function subscribePageLiveRefresh(handler, opts = {}) {
  const wantDomains = Array.isArray(opts.domains)
    ? opts.domains.map((d) => String(d).toLowerCase())
    : null
  const routeRes = Array.isArray(opts.routes) ? opts.routes : null

  const onEvent = (ev) => {
    const detail = ev?.detail || {}
    const domains = Array.isArray(detail.domains) ? detail.domains.map((d) => String(d).toLowerCase()) : []
    if (wantDomains && wantDomains.length) {
      const hit = domains.length === 0 || domains.some((d) => wantDomains.includes(d))
      if (!hit) return
    }
    if (routeRes && routeRes.length) {
      const route = String(detail.route || getCurrentRoute() || '')
      if (!routeRes.some((re) => re.test(route))) return
    }
    try {
      void handler(detail)
    } catch (e) {
      console.warn('[page-live-refresh] handler failed', e)
    }
  }

  window.addEventListener(PAGE_LIVE_REFRESH_EVENT, onEvent)
  return () => window.removeEventListener(PAGE_LIVE_REFRESH_EVENT, onEvent)
}

/** 无模块监听器时的兜底：软重载当前路由 */
export function softReloadCurrentRoute() {
  try {
    reloadCurrentRoute()
  } catch (e) {
    console.warn('[page-live-refresh] soft reload failed', e)
  }
}

/**
 * 从 platform / tool 名推断域名，便于定向刷新。
 * @param {string} actionOrTool
 * @returns {string[]}
 */
export function domainsFromPlatformAction(actionOrTool) {
  const s = String(actionOrTool || '').toLowerCase()
  if (!s) return []
  const out = new Set()
  const map = [
    [/items?/, 'items'],
    [/employees?|proactive|hire/, 'employees'],
    [/knowledge|vault/, 'knowledge'],
    [/workflow|apps?/, 'workflow'],
    [/tasks?/, 'tasks'],
    [/automation/, 'automation'],
    [/agents?/, 'agents'],
    [/skills?/, 'skills'],
    [/mcp/, 'mcp'],
    [/memory/, 'memory'],
    [/experience/, 'experience'],
    [/approvals?/, 'approvals'],
    [/settings|appearance|models?/, 'settings'],
  ]
  for (const [re, domain] of map) {
    if (re.test(s)) out.add(domain)
  }
  // platform.domain.action
  const m = s.match(/^platform[._]([a-z]+)/i) || s.match(/^([a-z]+)[._]/)
  if (m?.[1]) out.add(m[1].toLowerCase())
  return [...out]
}
