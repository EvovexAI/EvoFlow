/**
 * 用户界面焦点 / 操作留痕（给小V 与其它 Agent 共用）。
 *
 * - 当前屏：模块、路由、实体（哪个知识库 / 哪条会话…）
 * - 近期操作：路由切换、点击、选中（ring buffer）
 *
 * 前端权威；platform `ui.panel op=state` / 后续 `ui.focus` 读取同一快照。
 * 不是 DOM 全量倾倒：优先 data-ui-* 标注与路由解析。
 */
import { getCurrentRoute } from '../router.js'

/** 避免与 assistant-context 循环依赖：页面快照经 window 钩子回读。 */
function _collectPageSnap() {
  try {
    const fn = window.__evoflowCollectXiaomiPageSnapshot
    if (typeof fn === 'function') return fn() || {}
  } catch {
    /* ignore */
  }
  const route = String(getCurrentRoute() || '')
    .split('?')[0]
    .trim() || '/'
  return { route, module: '', label: '', contextType: '', contextId: '' }
}

function _extractPageLite() {
  try {
    const fn = window.__evoflowExtractPageContext
    if (typeof fn === 'function') return fn() || {}
  } catch {
    /* ignore */
  }
  return { module: '', route: String(getCurrentRoute() || '').split('?')[0] || '/' }
}

export const UI_FOCUS_EVENT = 'evoflow:ui-focus'
export const UI_ACTIVITY_EVENT = 'evoflow:ui-activity'

/** @typedef {{ at: number, type: string, module?: string, label?: string, entityId?: string, entityType?: string, detail?: string, route?: string, x?: number, y?: number, target?: string }} UiActivityRow */

/** @type {UiActivityRow[]} */
const _recent = []
const MAX = 40

let _clickBound = false

/**
 * @param {Partial<UiActivityRow> & { type: string }} detail
 */
export function emitUiActivity(detail = { type: '' }) {
  const type = String(detail.type || '').trim()
  if (!type) return
  /** @type {UiActivityRow} */
  const row = {
    at: Date.now(),
    type,
    module: detail.module ? String(detail.module) : undefined,
    label: detail.label ? String(detail.label).slice(0, 120) : undefined,
    entityId: detail.entityId ? String(detail.entityId).slice(0, 120) : undefined,
    entityType: detail.entityType ? String(detail.entityType).slice(0, 40) : undefined,
    detail: detail.detail ? String(detail.detail).slice(0, 200) : undefined,
    route: detail.route ? String(detail.route).slice(0, 160) : undefined,
    x: Number.isFinite(detail.x) ? Number(detail.x) : undefined,
    y: Number.isFinite(detail.y) ? Number(detail.y) : undefined,
    target: detail.target ? String(detail.target).slice(0, 120) : undefined,
  }
  _recent.push(row)
  while (_recent.length > MAX) _recent.shift()
  try {
    window.dispatchEvent(new CustomEvent(UI_ACTIVITY_EVENT, { detail: row }))
    // 兼容旧 page-activity 订阅方
    window.dispatchEvent(
      new CustomEvent('evoflow:page-activity', {
        detail: {
          at: row.at,
          type: row.type,
          module: row.module,
          label: row.label,
          entityId: row.entityId,
          detail: row.detail,
        },
      }),
    )
  } catch {
    /* ignore */
  }
}

/** @deprecated 用 emitUiActivity；保留别名以免旧调用方断 */
export function emitPageActivity(detail) {
  emitUiActivity(detail || { type: '' })
}

/** @param {number} [limit] */
export function getRecentUiActivities(limit = 12) {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 12))
  return _recent.slice(-n).map((r) => ({ ...r }))
}

/** @deprecated */
export function getRecentPageActivities(limit = 8) {
  return getRecentUiActivities(limit)
}

/**
 * 从 DOM / 路由拼「用户现在在哪」。
 * @returns {Record<string, unknown>}
 */
export function getUiFocusSnapshot() {
  const page = _collectPageSnap()
  const route =
    String(page.route || getCurrentRoute() || '')
      .split('?')[0]
      .trim() || '/'
  const recent = getRecentUiActivities(12)
  const ui = page.ui && typeof page.ui === 'object' ? page.ui : null
  return {
    version: 1,
    capturedAt: Date.now(),
    route,
    module: page.module || null,
    label: page.label || null,
    contextType: page.contextType || null,
    contextId: page.contextId || null,
    entity: page.chat || ui?.chatSession || null,
    ui,
    chat: page.chat || null,
    recentActivity: recent,
  }
}

function _clipText(el, n = 60) {
  if (!(el instanceof Element)) return ''
  const t = String(
    el.getAttribute('data-ui-label') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.textContent ||
      '',
  )
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function _resolveClickTarget(el) {
  if (!(el instanceof Element)) return null
  const hit =
    el.closest(
      [
        '[data-ui-track]',
        '[data-shell-session]',
        '[data-kb-id]',
        '[data-item-id]',
        '[data-code]',
        '[data-agent-code]',
        '[data-workflow-id]',
        'a[href]',
        'button',
        '[role="button"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '.react-chat-history-item',
        '.ko-card',
        '.im-card',
      ].join(','),
    ) || el

  const entityId =
    hit.getAttribute('data-ui-entity') ||
    hit.getAttribute('data-kb-id') ||
    hit.getAttribute('data-shell-session') ||
    hit.getAttribute('data-item-id') ||
    hit.getAttribute('data-code') ||
    hit.getAttribute('data-agent-code') ||
    hit.getAttribute('data-workflow-id') ||
    ''
  const entityType =
    hit.getAttribute('data-ui-type') ||
    (hit.getAttribute('data-kb-id')
      ? 'knowledge'
      : hit.getAttribute('data-shell-session')
        ? 'chat_session'
        : hit.getAttribute('data-agent-code') || hit.getAttribute('data-code')
          ? 'agent'
          : hit.getAttribute('data-item-id')
            ? 'item'
            : hit.getAttribute('data-workflow-id')
              ? 'workflow'
              : '')
  const track = hit.getAttribute('data-ui-track') || ''
  const label = _clipText(hit)
  const tag = hit.tagName.toLowerCase()
  return {
    entityId: entityId || undefined,
    entityType: entityType || undefined,
    label: label || track || tag,
    target: `${tag}${track ? `[${track}]` : ''}${entityId ? `#${entityId.slice(0, 24)}` : ''}`,
  }
}

/** 挂到 window，供 panel-cdp / platform ui.panel op=state 同步读取。 */
export function installUiFocusWindowHook() {
  try {
    window.__evoflowUiFocus = {
      getSnapshot: () => getUiFocusSnapshot(),
      getRecent: (n) => getRecentUiActivities(n),
    }
  } catch {
    /* ignore */
  }
}

/** 全局点击留痕（捕获阶段，节流）。 */
export function ensureUiFocusClickCapture() {
  installUiFocusWindowHook()
  if (_clickBound || typeof document === 'undefined') return
  _clickBound = true
  let lastAt = 0
  document.addEventListener(
    'click',
    (ev) => {
      const now = Date.now()
      if (now - lastAt < 180) return
      lastAt = now
      const t = ev.target
      if (!(t instanceof Element)) return
      // 忽略小V / 右栏内部连点噪音（仍记「打开小V」等显式 track）
      if (t.closest('#xiaomi-global-assistant, .xm-stage-pane, .xm-v4-dock, [data-right-stage-root]')) {
        if (!t.closest('[data-ui-track]')) return
      }
      const info = _resolveClickTarget(t)
      if (!info) return
      const ctx = _extractPageLite()
      emitUiActivity({
        type: 'click',
        module: ctx.module || undefined,
        route: ctx.route || undefined,
        label: info.label,
        entityId: info.entityId,
        entityType: info.entityType,
        target: info.target,
        x: typeof ev.clientX === 'number' ? ev.clientX : undefined,
        y: typeof ev.clientY === 'number' ? ev.clientY : undefined,
      })
    },
    true,
  )
}

/**
 * 路由变化时写入留痕（router 调用）。
 * @param {{ module?: string, label?: string, entityId?: string, route?: string }} ctx
 */
export function noteRouteFocus(ctx = {}) {
  emitUiActivity({
    type: 'route',
    module: ctx.module,
    label: ctx.label,
    entityId: ctx.entityId,
    route: ctx.route,
    detail: ctx.route,
  })
  try {
    window.dispatchEvent(new CustomEvent(UI_FOCUS_EVENT, { detail: getUiFocusSnapshot() }))
  } catch {
    /* ignore */
  }
}
