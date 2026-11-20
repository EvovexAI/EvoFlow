/**
 * Main-panel control surface for /main-cdp/* (external AI / Gateway panel tool).
 *
 * Mounted as window.__evoflowPanel — Rust evaluate routes call into this object.
 */
import { collectPanelSnapshot } from './panel-snapshot.js'
import { getPanelChatBridge } from './panel-bridge.ts'

export type PanelOk<T> = { ok: true; result: T }
export type PanelErr = { ok: false; error: string; code: string }
export type PanelResult<T> = PanelOk<T> | PanelErr

type RefMap = Map<string, Element>

let lastRefs: RefMap = new Map()

function ok<T>(result: T): PanelOk<T> {
  return { ok: true, result }
}

function err(code: string, error: string): PanelErr {
  return { ok: false, error, code }
}

function resolveRef(ref: string): Element | PanelErr {
  const key = String(ref || '').trim()
  if (!key) return err('ref_not_found', 'missing ref')
  const el = lastRefs.get(key)
  if (!el || !el.isConnected) {
    return err('ref_not_found', `unknown or stale ref '${key}' (take a fresh snapshot)`)
  }
  return el
}

function setNativeValue(el: Element, text: string) {
  const anyEl = el as HTMLInputElement
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null
  if (desc?.set) desc.set.call(el, text)
  else if ('value' in anyEl) anyEl.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

export function snapshot(opts: { maxElements?: number; maxDom?: number; includeHidden?: boolean } = {}): PanelResult<{
  url: string
  title: string
  elements: unknown[]
  truncated: boolean
  dom: unknown[]
  domTruncated: boolean
}> {
  try {
    const raw = collectPanelSnapshot(opts)
    lastRefs = new Map()
    raw._nodes.forEach((node, i) => {
      lastRefs.set(`e${i + 1}`, node)
    })
    const { _nodes: _drop, ...publicSnap } = raw
    void _drop
    return ok(publicSnap)
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

export function click(ref: string): PanelResult<{ clicked: string }> {
  const elOrErr = resolveRef(ref)
  if ('ok' in elOrErr && elOrErr.ok === false) return elOrErr
  const el = elOrErr as Element
  try {
    ;(el as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'nearest' })
    ;(el as HTMLElement).focus?.()
    ;(el as HTMLElement).click?.()
    return ok({ clicked: String(ref) })
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

export function fill(
  ref: string,
  text: string,
  opts: { clear?: boolean } = {},
): PanelResult<{ filled: string; length: number }> {
  const elOrErr = resolveRef(ref)
  if ('ok' in elOrErr && elOrErr.ok === false) return elOrErr
  const el = elOrErr as Element
  try {
    ;(el as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'nearest' })
    ;(el as HTMLElement).focus?.()
    const clear = opts.clear !== false
    const next = clear ? String(text ?? '') : String((el as HTMLInputElement).value || '') + String(text ?? '')
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) {
      if ((el as HTMLElement).isContentEditable) {
        el.textContent = next
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        setNativeValue(el, next)
      }
    } else {
      return err('execution_error', `ref '${ref}' is not fillable`)
    }
    return ok({ filled: String(ref), length: next.length })
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

export function type(ref: string, text: string): PanelResult<{ typed: string; length: number }> {
  const elOrErr = resolveRef(ref)
  if ('ok' in elOrErr && elOrErr.ok === false) return elOrErr
  const el = elOrErr as Element
  try {
    ;(el as HTMLElement).focus?.()
    const base =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? String(el.value || '')
        : String(el.textContent || '')
    const next = base + String(text ?? '')
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      setNativeValue(el, next)
    } else if ((el as HTMLElement).isContentEditable) {
      el.textContent = next
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      return err('execution_error', `ref '${ref}' is not typeable`)
    }
    return ok({ typed: String(ref), length: String(text ?? '').length })
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

export function scroll(opts: {
  ref?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  y?: number
  x?: number
  amount?: number
} = {}): PanelResult<{ scrolled: boolean }> {
  try {
    const amount = Number(opts.amount) || 400
    if (opts.ref) {
      const elOrErr = resolveRef(opts.ref)
      if ('ok' in elOrErr && elOrErr.ok === false) return elOrErr
      const el = elOrErr as Element
      ;(el as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'nearest' })
      return ok({ scrolled: true })
    }
    const dx =
      opts.x != null
        ? Number(opts.x)
        : opts.direction === 'left'
          ? -amount
          : opts.direction === 'right'
            ? amount
            : 0
    const dy =
      opts.y != null
        ? Number(opts.y)
        : opts.direction === 'up'
          ? -amount
          : opts.direction === 'down'
            ? amount
            : opts.y === undefined && opts.direction == null
              ? amount
              : 0
    window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior })
    return ok({ scrolled: true })
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

export function getState(): PanelResult<Record<string, unknown>> {
  try {
    const w = window as Window & {
      __evoflowSelectedSessionKey?: string
      location: Location
    }
    let route = ''
    try {
      route = String(w.location.hash || '').replace(/^#/, '') || '/'
    } catch {
      route = ''
    }
    let rightActiveKey: string | null = null
    let rightCollapsed: boolean | null = null
    try {
      // Sync read via already-loaded module graph when available
      const storeMod = (window as Window & { __evoflowRightStageStore?: { getSnapshot: () => { activeKey: string | null; collapsed: boolean } } })
        .__evoflowRightStageStore
      if (storeMod) {
        const snap = storeMod.getSnapshot()
        rightActiveKey = snap.activeKey
        rightCollapsed = snap.collapsed
      }
    } catch {
      /* store may be unloaded */
    }
    const bridge = getPanelChatBridge()
    const streaming = typeof bridge.isStreaming === 'function' ? !!bridge.isStreaming() : false
    let title = document.title || ''
    try {
      const dump = (window as Window & { __evoflowChatLayout?: { activeTitle?: string } }).__evoflowChatLayout
      if (dump?.activeTitle) title = dump.activeTitle
    } catch {
      /* ignore */
    }
    return ok({
      route,
      href: String(w.location.href || ''),
      selectedSessionKey: String(w.__evoflowSelectedSessionKey || '').trim() || null,
      title,
      rightActiveKey,
      rightCollapsed,
      streaming,
      panelApi: true,
    })
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

/** Lightweight DOM a11y fallback; prefer Rust /main-cdp/ax for full AX tree. */
export function axTree(opts: { maxNodes?: number } = {}): PanelResult<{ nodes: object[]; truncated: boolean; source: string }> {
  const maxNodes = Math.max(1, Number(opts.maxNodes) || 200)
  try {
    const nodes: object[] = []
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
    let n: Node | null
    while ((n = walker.nextNode()) && nodes.length < maxNodes) {
      const el = n as Element
      const role = el.getAttribute('role') || el.tagName.toLowerCase()
      const name =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        (el as HTMLElement).innerText?.trim().slice(0, 80) ||
        ''
      if (!name && !el.getAttribute('role')) continue
      nodes.push({
        role,
        name: String(name).slice(0, 120),
        tag: el.tagName.toLowerCase(),
      })
    }
    return ok({ nodes, truncated: nodes.length >= maxNodes, source: 'dom-fallback' })
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

export async function dispatch(
  action: string,
  params: Record<string, unknown> = {},
): Promise<PanelResult<{ action: string; detail?: unknown }>> {
  const act = String(action || '').trim()
  if (!act) return err('execution_error', 'missing action')
  const bridge = getPanelChatBridge()
  try {
    switch (act) {
      case 'navigate': {
        const path = String(params.path || params.hash || params.route || '').trim()
        if (!path) return err('execution_error', 'navigate requires path/hash')
        const { navigate } = await import('../../router.js')
        const normalized = path.startsWith('/') ? path : `/${path}`
        navigate(normalized)
        return ok({ action: act, detail: { path: normalized } })
      }
      case 'openXiaomi': {
        const { openXiaomiRightStage } = await import('../right-stage/open-right-stage-xiaomi.ts')
        await openXiaomiRightStage({
          navigateToChat: params.navigateToChat !== false,
          voiceMode: params.voiceMode === true,
          showRightStage: params.showRightStage !== false,
        })
        return ok({ action: act })
      }
      case 'openRightStage': {
        const surface = String(params.surface || params.kind || '').trim()
        if (!surface) return err('execution_error', 'openRightStage requires surface')
        window.dispatchEvent(
          new CustomEvent('evoflow:rs-probe', {
            detail: {
              surface,
              sessionKey: params.sessionKey || null,
              forceExpand: params.forceExpand !== false,
            },
          }),
        )
        return ok({ action: act, detail: { surface } })
      }
      case 'focusComposer': {
        if (bridge.focusComposer) bridge.focusComposer()
        else {
          const el =
            document.querySelector<HTMLElement>('[data-composer-input], textarea.composer-input, .chat-composer textarea')
          el?.focus?.()
        }
        return ok({ action: act })
      }
      case 'setComposerText': {
        const text = String(params.text ?? params.value ?? '')
        if (bridge.setComposerText) bridge.setComposerText(text)
        else {
          const el = document.querySelector<HTMLTextAreaElement>(
            '[data-composer-input], textarea.composer-input, .chat-composer textarea',
          )
          if (el) {
            const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
            desc?.set?.call(el, text)
            el.dispatchEvent(new Event('input', { bubbles: true }))
          } else return err('execution_error', 'composer not found')
        }
        return ok({ action: act, detail: { length: text.length } })
      }
      case 'sendMessage': {
        const text = String(params.text ?? params.message ?? '').trim()
        if (!text) return err('execution_error', 'sendMessage requires text')
        if (bridge.sendMessage) await bridge.sendMessage(text)
        else {
          window.dispatchEvent(new CustomEvent('evoflow:panel-send', { detail: { text } }))
          return err('execution_error', 'chat bridge not registered (ChatApp not mounted)')
        }
        return ok({ action: act, detail: { length: text.length } })
      }
      case 'selectSession': {
        const sessionKey = String(params.sessionKey || params.key || '').trim()
        if (!sessionKey) return err('execution_error', 'selectSession requires sessionKey')
        if (bridge.selectSession) await bridge.selectSession(sessionKey)
        else {
          window.dispatchEvent(new CustomEvent('evoflow:panel-select-session', { detail: { sessionKey } }))
          return err('execution_error', 'chat bridge not registered (ChatApp not mounted)')
        }
        return ok({ action: act, detail: { sessionKey } })
      }
      default:
        return err('capability_unsupported', `unknown action '${act}'`)
    }
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

export type EvoflowPanelApi = {
  snapshot: typeof snapshot
  click: typeof click
  fill: typeof fill
  type: typeof type
  scroll: typeof scroll
  getState: typeof getState
  axTree: typeof axTree
  dispatch: typeof dispatch
}

export function createPanelApi(): EvoflowPanelApi {
  return { snapshot, click, fill, type, scroll, getState, axTree, dispatch }
}

export function mountPanelApi(target: Window = window): EvoflowPanelApi {
  const api = createPanelApi()
  const w = target as Window & { __evoflowPanel?: EvoflowPanelApi }
  w.__evoflowPanel = api
  return api
}
