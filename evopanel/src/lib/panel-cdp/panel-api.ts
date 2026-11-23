/**
 * Main-panel control surface for /main-cdp/* (external AI / Gateway panel tool).
 *
 * Mounted as window.__evoflowPanel — Rust evaluate routes call into this object.
 */
import { collectPanelSnapshot } from './panel-snapshot.js'
import { collectPanelPageDump } from './panel-page-dump.js'
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

export function snapshot(
  opts: {
    maxElements?: number
    maxDom?: number
    includeHidden?: boolean
    /** controls = clickable refs (default); page|debug = also attach visible chat transcript */
    mode?: 'controls' | 'page' | 'debug'
    maxTurns?: number
    maxCharsPerTurn?: number
  } = {},
): PanelResult<{
  url: string
  title: string
  elements: unknown[]
  truncated: boolean
  dom: unknown[]
  domTruncated: boolean
  page?: unknown
}> {
  try {
    const o = opts && typeof opts === 'object' ? opts : {}
    const raw = collectPanelSnapshot(o)
    lastRefs = new Map()
    raw._nodes.forEach((node, i) => {
      lastRefs.set(`e${i + 1}`, node)
    })
    const { _nodes: _drop, ...publicSnap } = raw
    void _drop
    const mode = String(o.mode || 'controls').toLowerCase()
    if (mode === 'page' || mode === 'debug') {
      const page = collectPanelPageDump({
        maxTurns: o.maxTurns,
        maxCharsPerTurn: o.maxCharsPerTurn,
        includeOffscreen: Boolean(o.includeHidden),
      })
      return ok({ ...publicSnap, page })
    }
    return ok(publicSnap)
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

/** Troubleshooting dump: visible turn texts + chrome state (not just eN controls). */
export function pageDump(
  opts: { maxTurns?: number; maxCharsPerTurn?: number; includeOffscreen?: boolean } = {},
): PanelResult<ReturnType<typeof collectPanelPageDump>> {
  try {
    return ok(collectPanelPageDump(opts && typeof opts === 'object' ? opts : {}))
  } catch (e) {
    return err('execution_error', String((e as Error)?.message || e))
  }
}

/**
 * V4 视口诊断（与浮层「复制诊断」同源）：结构化字段 + markdown。
 * Prefer this over asking the user to paste copy-diag.
 */
export function viewportDiag(): PanelResult<unknown> {
  try {
    const w = window as Window & {
      __evoflowV4ViewportDiag?: () => unknown
    }
    if (typeof w.__evoflowV4ViewportDiag === 'function') {
      return ok(w.__evoflowV4ViewportDiag())
    }
    return err(
      'execution_error',
      'V4 viewport diag not mounted (open chat so overlay module loads; or hot-reload frontend)',
    )
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
    let focus: Record<string, unknown> | null = null
    let recentActivity: unknown[] = []
    try {
      const hook = (
        window as Window & {
          __evoflowUiFocus?: {
            getSnapshot: () => Record<string, unknown>
            getRecent: (n?: number) => unknown[]
          }
        }
      ).__evoflowUiFocus
      if (hook?.getSnapshot) focus = hook.getSnapshot()
      if (hook?.getRecent) recentActivity = hook.getRecent(12)
    } catch {
      focus = null
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
      /** 当前界面焦点（模块 / 实体 / 知识库 id…） */
      focus,
      /** 近期点击 / 路由留痕 */
      recentActivity,
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
      case 'employeeChatSend': {
        // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：新增 action `employeeChatSend` —— 平台工具直接驱动**面板自己** chatSend。
        // 为什么（用户 2026-11-21 点破）：「我在右侧面板手打能看到实时结果，你后台触发页面上啥也看不到。」
        //   手打 = ChatApp.chatSend → live SSE 逐字流；后台 wake 那轮没有流，只能轮询快照。
        //   要「和手打完全一样」，发送动作必须发生在面板这一侧，而不是后端。
        // 判据（可反证）：面板已挂载时 mode='pane-live'（走 handleSend→chatSend）；
        //   未挂载时 mode='pending-open'（打开面板排 pending），两者都回 ok，不许静默吞。
        const paneCode = String(params.agentCode || params.agent_code || params.code || '').trim()
        const paneText = String(params.text ?? params.message ?? '').trim()
        const paneSk = String(params.sessionKey || params.session_key || '').trim()
        if (!paneCode) return err('execution_error', 'employeeChatSend requires agentCode')
        if (!paneText) return err('execution_error', 'employeeChatSend requires text')
        const bridgeMod = await import('../right-stage/employee-pane-send-bridge.js')
        const hit = bridgeMod.findEmployeePaneSenderEntry(paneCode, paneSk)
        // 【self-evolution-bot · 2026-11-22 · 第126轮 · 模型:deepseek-v4.1-flash】
        // 改了什么：发送目标由纯函数 `decidePaneSendTarget` 决定，不再直接拿 `hit.send`。
        // 为什么（本轮现网实证，2026-11-22 19:46:57，agent=case-fullstack-dev）：
        //   后端 `chat_send` 已按 busy 判据 mint 了新会话（回执带
        //   `busy_avoided_session_key` / `busy_avoided_reason=target_session_running_new_conversation_minted`），
        //   但 CDP 到面板时 exact 未命中 → code-fallback 拿到旧面板的 sender，
        //   `sender(text)` 直接把这句话写进了**正在跑**的旧会话
        //   `proactive:case-fullstack-dev:chat:dept-28baad343765`（回执 sessionKeyMatched=false）。
        //   等于「新开一条独立对话」这条修复在面板路径上完全失效，话照样插进别人的回合。
        const actualSk = hit ? hit.sessionKey : ''
        const skMatches =
          Boolean(paneSk) && Boolean(actualSk) && String(paneSk).trim() === String(actualSk).trim()
        const target = bridgeMod.decidePaneSendTarget({
          requestedSessionKey: paneSk,
          actualSessionKey: actualSk,
          matched: (hit?.matched as 'exact' | 'code-fallback' | undefined) ?? null,
          fallbackSessionKey: paneSk,
        })
        const sender = target.useSender && hit?.send ? hit.send : null
        if (sender) {
          // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
          // 改了什么：先拿 sender 的**同步返回值**判定接没接住；不 await 整轮流。
          // 为什么：① 面板 handleSend 里的 api.chatSend 是流式 POST，要等整轮流完才 resolve
          //   （几十秒到几分钟），await 会把 CDP 请求挂死到本轮结束，panel_engine 默认 60s
          //   超时一到就报 ok=false，而消息其实已发出 —— 又一个「假失败」。
          //   ② 但完全不判也不行：面板正忙时 handleSend 第一句就 return 静默丢消息，
          //   这里若回 pane-live，工具以为送达、前端又不再补发，这句话就凭空消失了。
          // 判据：send 返回 false → mode='pane-busy' → 调用方回落 pendingSend/wake。
          let accepted: unknown = true
          try {
            accepted = sender(paneText)
          } catch (e: unknown) {
            console.warn('[employeeChatSend] pane send threw', e)
            accepted = false
          }
          if (accepted === false) {
            return ok({
              action: act,
              detail: {
                mode: 'pane-busy',
                agentCode: paneCode,
                sessionKey: actualSk || null,
                requestedSessionKey: paneSk || null,
                sessionKeyMatched: skMatches,
                sessionKeyMatchedBy: hit?.matched || null,
                length: paneText.length,
              },
            })
          }
          return ok({
            action: act,
            detail: {
              mode: 'pane-live',
              agentCode: paneCode,
              sessionKey: actualSk || null,
              requestedSessionKey: paneSk || null,
              sessionKeyMatched: skMatches,
              sessionKeyMatchedBy: hit?.matched || null,
              length: paneText.length,
            },
          })
        }
        // 回落：面板没开（或指定会话与面板当前会话不一致）→ 打开右栏并排队，
        // 由面板挂载后走同一套 handleSend（它按 employeeSessionKey 挑会话）。
        // 【self-evolution-bot · 2026-11-22 · 第126轮 · 模型:deepseek-v4.1-flash】
        // 改了什么：pending-open 路径把 `paneSk` 作为 employeeSessionKey 传进去，
        //   并把 mode 细分成 `pending-open-switch`（会话不一致、需切换）与 `pending-open`。
        // 为什么：同一轮实证里 paneSk 是新 mint 的会话，而面板挂的是旧的 busy 会话；
        //   不带上键，面板挂载后仍会挑自己那条旧会话，新会话等于白开。
        const stageMod = await import('../right-stage/open-employee-process-stage.js')
        const pickedSk = String(target.pendingSessionKey || paneSk || params.employeeSessionKey || '').trim()
        const tabId = stageMod.openEmployeeProcessInRightStage(
          {
            taskId: String(params.taskId || params.task_id || '').trim(),
            agentCode: paneCode,
            roleName: String(params.roleName || params.role_name || '').trim(),
            busy: true,
            employeeSessionKey: pickedSk || undefined,
            pendingSendMessage: paneText,
          },
          { layout: 'wide', sessionKey: String(params.ownerSessionKey || '').trim() || undefined },
        )
        return ok({
          action: act,
          detail: {
            mode: target.mode,
            agentCode: paneCode,
            sessionKey: pickedSk || null,
            requestedSessionKey: paneSk || null,
            sessionKeyMatched: skMatches,
            sessionKeyMatchedBy: hit?.matched || null,
            tabId: tabId || null,
            length: paneText.length,
          },
        })
      }
      case 'viewportDiag': {
        const dump = viewportDiag()
        if (!dump.ok) return dump
        return ok({ action: act, detail: dump.result })
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
  pageDump: typeof pageDump
  viewportDiag: typeof viewportDiag
  click: typeof click
  fill: typeof fill
  type: typeof type
  scroll: typeof scroll
  getState: typeof getState
  axTree: typeof axTree
  dispatch: typeof dispatch
}

export function createPanelApi(): EvoflowPanelApi {
  return {
    snapshot,
    pageDump,
    viewportDiag,
    click,
    fill,
    type,
    scroll,
    getState,
    axTree,
    dispatch,
  }
}

export function mountPanelApi(target: Window = window): EvoflowPanelApi {
  const api = createPanelApi()
  const w = target as Window & { __evoflowPanel?: EvoflowPanelApi }
  w.__evoflowPanel = api
  // 尽早挂上 V4 视口诊断钩子（不必等浮层 React 挂载），供 /main-cdp/viewport-diag
  void import('../../react/v4/V4ViewportDebugOverlay.js').catch(() => {
    /* chat chunk optional until UI loads */
  })
  return api
}
