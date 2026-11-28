/**
 * Collab chat completion notify (initiator only).
 *
 * Backend: ``collab_chat_complete`` broadcast + ``evoflow_collab_chat_calls`` audit
 * + session_notifications. Panel polls recent delivered/resumed calls so desktop
 * notify works even without a live proactive SSE subscription.
 *
 * 关键：协作回执写进发起方会话后，若用户正盯着该会话，V4 常停在旧 tip
 * （catchup cooldown / thread 换绑）。这里强制 catchup + 打可对账日志。
 */

import { toast } from '../components/toast.js'
import { notifyDesktopCompletion } from './desktop-notification.js'
import { api, appendFrontendLog } from './tauri-api.js'

const POLL_MS = 15_000
const EVENT_NAME = 'evopanel:collab-chat-complete'
const LOG_PREFIX = '[collab-chat-complete]'
/** 跨重启记住已弹过的 call_id，避免网关冷启首轮 poll 失败后把历史积压全弹一遍 */
const SEEN_STORAGE_KEY = 'evopanel.collab-chat-complete.seen.v1'
const SEEN_STORAGE_MAX = 200

/** @type {ReturnType<typeof setInterval> | null} */
let _timer = null
let _listenerBound = false
/** @type {Set<string>} */
const _seen = new Set()
let _bootstrapped = false
/** @type {Map<string, ReturnType<typeof setTimeout>[]>} */
const _followupTimers = new Map()
/** Soft-wake 常比 FE 轮询更晚出结案：首次 catchup 会钉在「等回执」，需二次追平。 */
const FOLLOWUP_CATCHUP_MS = [2500, 8000]

function callId(payload) {
  return String(payload?.call_id || payload?.callId || '').trim()
}

function loadSeenFromStorage() {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY)
    if (!raw) return
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return
    for (const id of arr) {
      const s = String(id || '').trim()
      if (s) _seen.add(s)
    }
  } catch {
    /* ignore */
  }
}

function persistSeenToStorage() {
  try {
    const ids = [..._seen]
    const trimmed = ids.length > SEEN_STORAGE_MAX ? ids.slice(-SEEN_STORAGE_MAX) : ids
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
}

function rememberSeen(id) {
  const s = String(id || '').trim()
  if (!s) return
  if (_seen.has(s)) return
  _seen.add(s)
  if (_seen.size > SEEN_STORAGE_MAX) {
    const overflow = _seen.size - SEEN_STORAGE_MAX
    let n = 0
    for (const old of _seen) {
      _seen.delete(old)
      n += 1
      if (n >= overflow) break
    }
  }
  persistSeenToStorage()
}

// 模块加载即灌入上次已弹过的 id（重启后首轮 poll 失败也不该重弹）
try {
  loadSeenFromStorage()
} catch {
  /* ignore */
}

function initiatorHref(payload) {
  const sk = String(payload?.initiator_session_key || payload?.initiatorSessionKey || '').trim()
  const code = String(payload?.initiator_agent || payload?.initiatorAgent || '').trim()
  if (sk && code && sk.startsWith('proactive:')) {
    return `/proactive/${encodeURIComponent(code)}?session=${encodeURIComponent(sk)}`
  }
  if (sk) return `/?session=${encodeURIComponent(sk)}`
  if (code) return `/proactive/${encodeURIComponent(code)}`
  return '/proactive'
}

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} zh
 * @param {Record<string, unknown>} [extra]
 */
function clog(level, zh, extra = {}) {
  const at = new Date().toISOString()
  const payload = { at, event: 'collab_chat_complete_fe', zh, ...extra }
  const line = `${LOG_PREFIX} ${zh} | ${JSON.stringify(payload)}`
  try {
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
  } catch {
    /* ignore */
  }
  try {
    void appendFrontendLog?.(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', line.slice(0, 11_500))
  } catch {
    /* ignore */
  }
}

function selectedSessionKey() {
  try {
    return String(window.__evoflowSelectedSessionKey || '').trim()
  } catch {
    return ''
  }
}

function resolveWsClient() {
  try {
    return window.__evoflowWsClient || null
  } catch {
    return null
  }
}

function selectedThreadId() {
  try {
    return String(window.__evoflowSelectedThreadId || '').trim()
  } catch {
    return ''
  }
}

/**
 * Force initiator V4 timeline to catch up after backend inject/wake.
 * @param {Record<string, unknown>} payload
 */
async function refreshInitiatorTimeline(payload) {
  const initSk = String(
    payload?.initiator_session_key || payload?.initiatorSessionKey || '',
  ).trim()
  if (!initSk) {
    clog('warn', '跳过时间线刷新：无 initiator_session_key', { callId: callId(payload) })
    return
  }
  const selected = selectedSessionKey()
  // 必须真的盯着发起方才动时间线；selected 空时绝不瞎刷/贴底（非 dev 普通对话会被搅）。
  const viewingInitiator = !!selected && selected === initSk
  const ws = resolveWsClient()
  let cachedTid = ''
  try {
    cachedTid = String(ws?.getSessionThreadId?.(initSk) || '').trim()
  } catch {
    cachedTid = ''
  }
  if (!cachedTid && selected === initSk) {
    cachedTid = selectedThreadId()
  }

  let execTid = ''
  let runStatus = ''
  let openChild = null
  try {
    const { fetchSessionExecutionState, invalidateSessionRuntimeStatusCache } =
      await import('../react/lib/session-reattach.js')
    invalidateSessionRuntimeStatusCache(initSk)
    const st = await fetchSessionExecutionState(initSk, { bypassCache: true })
    execTid = String(st?.threadId || st?.thread_id || '').trim()
    runStatus = String(st?.runStatus || st?.status || '').trim()
    openChild =
      typeof st?.openChildWorkCount === 'number'
        ? st.openChildWorkCount
        : Array.isArray(st?.childWorks)
          ? st.childWorks.filter((w) =>
              ['pending', 'running'].includes(String(w?.status || '').toLowerCase()),
            ).length
          : null
  } catch (err) {
    clog('warn', 'execution/state 拉取失败', {
      initiatorSessionKey: initSk,
      error: err instanceof Error ? err.message : String(err || ''),
    })
  }

  const tidMismatch = !!(cachedTid && execTid && cachedTid !== execTid)
  clog('info', '准备刷新发起方时间线', {
    callId: callId(payload),
    initiatorSessionKey: initSk,
    selectedSessionKey: selected || null,
    viewingInitiator,
    cachedThreadId: cachedTid || null,
    execThreadId: execTid || null,
    tidMismatch,
    runStatus: runStatus || null,
    openChildWorkCount: openChild,
  })

  // 协作完成 **禁止** 强制 rebind。
  // 非 dev 实测：cached=用户正在看的 thread，exec=侧栏/ remint 后的另一条；
  // 强行换绑会把普通对话视口掐到近空/错 thread（漫剧总监 21:02 事故）。
  // remint 换绑只走正常 stream/404 路径，不归协作回执管。
  if (tidMismatch) {
    clog('warn', '发起方 thread 与 execution 不一致，协作回执不 rebind（保住当前视口）', {
      initiatorSessionKey: initSk,
      viewingThreadId: cachedTid,
      execThreadId: execTid,
    })
  }

  // 正在看就跟视口 thread；没在看只记日志，用 exec/cached 兜底做静默 catchup。
  const tid = viewingInitiator
    ? cachedTid || execTid
    : execTid || cachedTid
  if (!tid) {
    clog('warn', '无法 refreshEvoflowV4Session：无 threadId', {
      initiatorSessionKey: initSk,
    })
    return
  }
  if (!viewingInitiator) {
    // 桌面 toast 已发；别动当前普通对话的 V4/WS。
    clog('info', '用户未在看发起方，跳过 catchup/reattach/贴底', {
      initiatorSessionKey: initSk,
      threadId: tid,
      selectedSessionKey: selected || null,
    })
    try {
      window.dispatchEvent(
        new CustomEvent('evopanel:session-child-work-refresh', {
          detail: { sessionKey: initSk, reason: 'collab_chat_complete' },
        }),
      )
    } catch {
      /* ignore */
    }
    return
  }

  try {
    const { refreshEvoflowV4Session } = await import('../react/v4/V4StreamRowsBridge.js')
    refreshEvoflowV4Session(tid, { force: true, softIntervalMs: 500 })
    clog('info', '已 force catchup 发起方 V4', {
      threadId: tid,
      initiatorSessionKey: initSk,
      viewingInitiator,
    })
  } catch (err) {
    clog('error', 'refreshEvoflowV4Session 失败', {
      threadId: tid,
      error: err instanceof Error ? err.message : String(err || ''),
    })
  }

  // Soft-wake 写进 tip 后常见「数据在、视口还停在半截」——盯着发起方时强制贴底。
  try {
    window.dispatchEvent(
      new CustomEvent('evopanel:v4-follow-tip', {
        detail: {
          threadId: tid,
          sessionKey: initSk,
          reason: 'collab_chat_complete',
        },
      }),
    )
    clog('info', '已请求发起方时间线贴底', { threadId: tid })
  } catch {
    /* ignore */
  }

  // 仅在发起方确实在跑时 reattach；且只用当前视口 thread。
  const rs = String(runStatus || '').trim().toLowerCase()
  const looksActive = ['running', 'busy', 'in_progress', 'streaming', 'queued', 'pending'].includes(
    rs,
  )
  if (ws && looksActive) {
    try {
      const { reattachRunningSessionIfNeeded } = await import('../react/lib/session-reattach.js')
      await reattachRunningSessionIfNeeded({
        sessionKey: initSk,
        wsClient: ws,
        sessionRow: {
          sessionKey: initSk,
          threadId: tid,
          runStatus: runStatus,
        },
        resumeReason: 'collab_chat_complete',
        skipIfAlreadyAttached: false,
      })
      clog('info', '已 reattach 发起方 history-watch', {
        initiatorSessionKey: initSk,
        threadId: tid,
        runStatus,
      })
    } catch (err) {
      clog('warn', 'reattachRunningSessionIfNeeded 失败', {
        error: err instanceof Error ? err.message : String(err || ''),
      })
    }
  } else {
    clog('info', '发起方非 running，跳过强制 reattach（避免搅乱普通对话）', {
      initiatorSessionKey: initSk,
      threadId: tid,
      runStatus: runStatus || null,
    })
  }

  try {
    window.dispatchEvent(
      new CustomEvent('evopanel:session-child-work-refresh', {
        detail: { sessionKey: initSk, reason: 'collab_chat_complete' },
      }),
    )
  } catch {
    /* ignore */
  }

  scheduleFollowupCatchups({
    callId: callId(payload),
    initiatorSessionKey: initSk,
    threadId: tid,
    viewingInitiator,
  })
}

/**
 * smoke9 现场：FE 在 resume_woke 当下 catchup，总监结案还要再过几秒才写入。
 * 二次/三次 force catchup + 贴底，把「等回执」之后的续跑追进视口。
 * @param {{ callId?: string, initiatorSessionKey: string, threadId: string, viewingInitiator: boolean }} args
 */
function scheduleFollowupCatchups(args) {
  const initSk = String(args.initiatorSessionKey || '').trim()
  const tid = String(args.threadId || '').trim()
  if (!initSk || !tid) return
  const prev = _followupTimers.get(initSk) || []
  for (const t of prev) {
    try {
      clearTimeout(t)
    } catch {
      /* ignore */
    }
  }
  /** @type {ReturnType<typeof setTimeout>[]} */
  const next = []
  for (const delayMs of FOLLOWUP_CATCHUP_MS) {
    next.push(
      setTimeout(() => {
        void (async () => {
          const stillViewing = selectedSessionKey() === initSk
          clog('info', '二次追平发起方时间线', {
            callId: args.callId || null,
            initiatorSessionKey: initSk,
            threadId: tid,
            delayMs,
            viewingInitiator: stillViewing,
          })
          if (!stillViewing) return
          try {
            const { refreshEvoflowV4Session } = await import(
              '../react/v4/V4StreamRowsBridge.js'
            )
            refreshEvoflowV4Session(tid, { force: true, softIntervalMs: 500 })
          } catch (err) {
            clog('warn', '二次 catchup 失败', {
              delayMs,
              error: err instanceof Error ? err.message : String(err || ''),
            })
            return
          }
          try {
            window.dispatchEvent(
              new CustomEvent('evopanel:v4-follow-tip', {
                detail: {
                  threadId: tid,
                  sessionKey: initSk,
                  reason: `collab_chat_complete_followup_${delayMs}`,
                },
              }),
            )
          } catch {
            /* ignore */
          }
        })()
      }, delayMs),
    )
  }
  _followupTimers.set(initSk, next)
}

/**
 * @param {Record<string, unknown>} payload
 */
export async function handleCollabChatComplete(payload) {
  const id = callId(payload)
  if (id) {
    if (_seen.has(id)) {
      clog('info', '忽略重复回执', { callId: id })
      return
    }
    rememberSeen(id)
  }
  const title = String(payload?.title || '协作完成').trim()
  const body = String(payload?.body || payload?.summary || '').trim()
  const href = initiatorHref(payload)
  const initSk = String(
    payload?.initiator_session_key || payload?.initiatorSessionKey || '',
  ).trim()
  clog('info', '收到协作完成通知', {
    callId: id || null,
    title,
    bodyPreview: body.slice(0, 120),
    initiatorSessionKey: initSk || null,
    targetAgent: String(payload?.target_agent || payload?.targetAgent || '').trim() || null,
    selectedSessionKey: selectedSessionKey() || null,
    ok: payload?.ok !== false,
  })
  try {
    await notifyDesktopCompletion({
      title,
      body: body.slice(0, 180),
      tag: id ? `collab-chat-${id}` : `collab-chat-${Date.now()}`,
      extra: href ? { hash: href.startsWith('#') ? href : `#${href}` } : undefined,
    })
  } catch {
    /* ignore */
  }
  toast(body ? `${title}：${body.slice(0, 80)}` : title, payload?.ok === false ? 'warn' : 'info')
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { ...payload, href } }))
  } catch {
    /* ignore */
  }
  await refreshInitiatorTimeline(payload || {})
}

/**
 * Hot-reload / late open: poll bootstrap used to swallow already-delivered
 * call_ids into ``_seen`` without catching up V4. If the user is staring at
 * that initiator session, force one silent timeline refresh for the newest hit.
 * @param {Array<Record<string, unknown>>} rows
 */
async function bootstrapCatchupIfViewing(rows) {
  const selected = selectedSessionKey()
  if (!selected) return
  let newest = null
  for (const row of rows) {
    const st = String(row?.status || '').trim()
    if (!['delivered', 'resumed'].includes(st)) continue
    const initSk = String(row?.initiator_session_key || row?.initiatorSessionKey || '').trim()
    if (initSk !== selected) continue
    newest = row
    break // API returns newest-first
  }
  if (!newest) return
  clog('info', 'bootstrap 静默补刷当前发起方时间线', {
    callId: callId(newest),
    initiatorSessionKey: selected,
    status: String(newest?.status || ''),
  })
  await refreshInitiatorTimeline({
    call_id: callId(newest),
    initiator_session_key: selected,
    initiator_agent: newest?.initiator_agent,
    target_agent: newest?.target_agent,
    run_status: newest?.run_status,
  })
}

async function pollOnce() {
  if (typeof api?.proactiveListCollabChatCalls !== 'function') return
  try {
    const res = await api.proactiveListCollabChatCalls({ limit: 30 })
    const rows = Array.isArray(res?.calls) ? res.calls : []
    const wasBoot = !_bootstrapped
    for (const row of rows) {
      const st = String(row?.status || '').trim()
      if (!['delivered', 'resumed'].includes(st)) continue
      const id = callId(row)
      if (!id || _seen.has(id)) continue
      if (!_bootstrapped) {
        // 冷启动：历史 delivered/resumed 只吞进 seen，绝不 toast
        rememberSeen(id)
        continue
      }
      const target = String(row?.target_agent || '').trim()
      const ok = !['failed', 'fail', 'error', 'cancelled'].includes(
        String(row?.run_status || '').toLowerCase(),
      )
      clog('info', '轮询发现新回执', {
        callId: id,
        status: st,
        targetAgent: target || null,
        resumeWokeAt: row?.resume_woke_at || row?.resumeWokeAt || null,
      })
      await handleCollabChatComplete({
        call_id: id,
        title: ok ? `协作完成 · ${target}` : `协作异常 · ${target}`,
        body: String(row?.summary || row?.goal_preview || '').trim(),
        initiator_agent: row?.initiator_agent,
        initiator_session_key: row?.initiator_session_key,
        target_agent: target,
        target_session_key: row?.target_session_key,
        run_status: row?.run_status,
        ok,
      })
    }
    // 只有成功拉到列表才结束 bootstrap。以前 finally 无条件置 true：
    // 重启后首轮网关未就绪 → seen 空 + boot 已完成 → 下一轮把积压全当新通知弹爆。
    if (wasBoot) {
      _bootstrapped = true
      persistSeenToStorage()
      clog('info', 'bootstrap 完成：历史回执已吞，后续才弹新完成', {
        seenCount: _seen.size,
        rowCount: rows.length,
      })
      await bootstrapCatchupIfViewing(rows)
    }
  } catch (err) {
    clog('warn', '轮询 collab calls 失败（网关可能挂了）', {
      error: err instanceof Error ? err.message : String(err || ''),
      bootstrapped: _bootstrapped,
    })
    // 失败不置 _bootstrapped：下一轮仍走「吞历史」路径
  }
}

export function startCollabChatCompleteNotify() {
  if (typeof window === 'undefined') return
  window.__evoflowHandleCollabChatComplete = handleCollabChatComplete
  if (!_listenerBound) {
    _listenerBound = true
    window.addEventListener('evoflow:gateway-event', (ev) => {
      const detail = /** @type {CustomEvent} */ (ev).detail
      const type = String(detail?.type || detail?.event_type || '').trim()
      if (type !== 'collab_chat_complete') return
      const data = detail?.data && typeof detail.data === 'object' ? detail.data : detail
      clog('info', 'gateway-event 推送 collab_chat_complete', {
        callId: callId(data || {}),
      })
      void handleCollabChatComplete(data || {})
    })
  }
  if (_timer) return
  clog('info', '启动协作完成监听（SSE + 15s 轮询）')
  void pollOnce()
  _timer = setInterval(() => {
    void pollOnce()
  }, POLL_MS)
}

/** @internal vitest / 诊断 */
export function __collabChatCompleteNotifyTestReset() {
  _seen.clear()
  _bootstrapped = false
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
  _listenerBound = false
  try {
    localStorage.removeItem(SEEN_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/** @internal */
export function __collabChatCompleteNotifyTestState() {
  return {
    bootstrapped: _bootstrapped,
    seenCount: _seen.size,
    seen: [..._seen],
  }
}
