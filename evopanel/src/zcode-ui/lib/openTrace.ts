/**
 * 「点开会话 → 内容上屏」全链路分段计时与归因。
 *
 * ## 为什么单独一个模块
 * `v4-lifecycle-log.ts` 记的是**事件流**（发生了什么）；这里记的是**耗时分解**
 * （每一步各花了多久、超阈值没有、慢在哪、为什么慢）。排查「有时秒开、有时要几秒」
 * 需要后者：光有事件顺序看不出「卡在哪一步」。
 *
 * ## 覆盖的阶段（按真实调用顺序）
 * ```
 * click            用户点击侧栏会话
 *   ↓
 * ensure_thread    若会话还没有 threadId，ensure-chat-thread 补齐（常见于新建/未落库会话）
 *   ↓
 * acquire          V4 数据层租约挂上（命中缓存 = 立刻可显示；cold = 要等首帧）
 *   ↓
 * subscribe        POST /api/v4/conversation/subscribe（含服务端 hydration 拉库）
 *   ↓
 * subscribe_ack    服务端 ACK 返回
 *   ↓
 * frame_snapshot   frames SSE 收到首帧 snapshot
 *   ↓
 * store_apply      投影 store 应用 snapshot（rows 进入 state）
 *   ↓
 * render           React 提交该会话的 DOM
 *   ↓
 * paint            浏览器真正上屏（requestAnimationFrame 之后）
 * ```
 *
 * ## 阈值（超了就打 warn/error 并附归因）
 * 每个阶段有 `warn` / `error` 两档阈值。总耗时另有 `totalWarn` / `totalError`。
 * 默认值按「本地桌面 + SQLite 库」的合理量级给：>800ms 算偏慢，>2500ms 算异常。
 *
 * ## 落点
 * 1. DevTools Console：`[v4-open]` 前缀，每步一行，带 `+Nms` 与阶段名
 * 2. 桌面端：`~/.evoflow/logs/frontend-YYYY-MM-DD.log`（经 logV4Life 转发）
 * 3. `window.__evoflowOpenTrace`：当前这次打开的分段明细（对象 + 数组）
 * 4. localStorage `EVOFLOW_OPEN_TRACE_RING`：最近 N 次打开的历史（便于对比快/慢两次）
 *
 * 关闭：localStorage.setItem('EVOFLOW_OPEN_TRACE_LOG', '0')
 */

// 本模块刻意不依赖前端 React 树：zcode-ui 的 projection store 也要写分段，
// 而 vendored 树不反向依赖 src/react（见 tsconfig paths 别名边界）。
// 因此 console 落盘走动态 import，避免静态依赖把两棵树绑在一起。

const PREFIX = '[v4-open]'
const RING_MAX = 30
const LS_RING_KEY = 'EVOFLOW_OPEN_TRACE_RING'
const LS_ENABLE_KEY = 'EVOFLOW_OPEN_TRACE_LOG'

/** 一个打开链路的阶段标识。 */
export type OpenStage =
  | 'click'
  | 'ensure_thread'
  | 'acquire'
  | 'subscribe'
  | 'subscribe_ack'
  | 'frame_snapshot'
  | 'store_apply'
  | 'render'
  | 'paint'

export type OpenStageStatus = 'ok' | 'warn' | 'error' | 'pending'

export type OpenStageRecord = {
  stage: OpenStage
  /** 相对点击时刻的毫秒数。 */
  atMs: number
  /** 本阶段自身耗时（相对上一个阶段）。 */
  durationMs: number
  status: OpenStageStatus
  /** 中文说明：这步干了什么。 */
  label: string
  /** 超阈值 / 异常时的归因（慢在哪、为什么）。 */
  reason?: string
  detail?: Record<string, unknown>
}

export type OpenTraceRecord = {
  /** 本次打开的唯一 id（同一会话多次打开也能区分）。 */
  traceId: string
  sessionKey: string
  threadId?: string
  startedAt: number
  endedAt?: number
  /** 总耗时（ms）。未结束时为 undefined。 */
  totalMs?: number
  status: OpenStageStatus
  /** 最慢的一段（阶段名 + 耗时）。 */
  slowest?: { stage: OpenStage; durationMs: number } | null
  /** 汇总归因：慢在哪 + 为什么。 */
  verdict?: string
  stages: OpenStageRecord[]
  detail?: Record<string, unknown>
}

/** 各阶段的告警/错误阈值（ms）。未列出的阶段用默认值。 */
const STAGE_THRESHOLDS: Partial<Record<OpenStage, { warn: number; error: number }>> = {
  // ensure-thread 会打一次网络请求（创建/查询 thread），慢一点是正常的但不该过秒。
  ensure_thread: { warn: 1200, error: 3000 },
  // 冷订阅 ACK 要等服务端 hydrate 拉库（读 SQLite transcript）。
  subscribe: { warn: 1200, error: 3000 },
  subscribe_ack: { warn: 600, error: 1500 },
  // SSE 首帧：服务端要 build snapshot（含大 JSON 序列化）。
  frame_snapshot: { warn: 1500, error: 4000 },
  // 帧到达后到 React 上屏：纯渲染开销，不该慢。
  store_apply: { warn: 400, error: 1000 },
  render: { warn: 800, error: 2000 },
  paint: { warn: 400, error: 1000 },
}

const DEFAULT_WARN_MS = 800
const DEFAULT_ERROR_MS = 2500

/** 总耗时阈值。 */
const TOTAL_WARN_MS = 1200
const TOTAL_ERROR_MS = 3000

/** 一次打开的运行时状态。 */
type OpenTraceState = {
  traceId: string
  sessionKey: string
  threadId?: string
  startedAt: number
  lastAt: number
  endedAt?: number
  /** 结束时写入的状态与归因（供进行中→结束的同步）。 */
  endedStatus?: OpenStageStatus
  endedVerdict?: string
  stages: OpenStageRecord[]
  ended: boolean
}

let current: OpenTraceState | null = null
const ring: OpenTraceRecord[] = []

let traceCounter = 0

function enabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(LS_ENABLE_KEY) !== '0'
  } catch {
    return true
  }
}

function thresholdsFor(stage: OpenStage): { warn: number; error: number } {
  return STAGE_THRESHOLDS[stage] ?? { warn: DEFAULT_WARN_MS, error: DEFAULT_ERROR_MS }
}

/**
 * 转发到 v4-life 日志（落盘 frontend log + stream-compare）。
 * 动态 import：避免 zcode-ui 静态依赖 src/react 侧模块。
 */
function forwardToV4Life(input: {
  event: string
  sessionKey: string
  threadId?: string
  level: 'info' | 'warn' | 'error'
  zh: string
  detail?: Record<string, unknown>
}): void {
  try {
    void import('../../react/lib/v4-lifecycle-log.js')
      .then((m) =>
        m.logV4Life({
          event: input.event,
          sessionKey: input.sessionKey,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          level: input.level,
          zh: input.zh,
          detail: input.detail,
          skipDedupe: true,
        }),
      )
      .catch(() => {
        /* 落盘失败不挡主路径 */
      })
  } catch {
    /* best-effort */
  }
}

/** 归因文案：把「慢」翻译成人能看懂的原因。 */
function explainSlowStage(
  stage: OpenStage,
  detail: Record<string, unknown> | undefined,
): string {
  const d = detail ?? {}
  switch (stage) {
    case 'ensure_thread':
      return (
        '会话还没有 threadId，点开时必须先向服务端 ensure-chat-thread 补齐（一次网络往返 + 可能落库）。' +
        '补齐期间界面没有 threadId 可订阅，只能转圈。若这一段就超秒，通常是「会话刚建还没落库」' +
        '或服务端 DB 忙；先看 ensure-thread 返回的 threadId 是否为空。'
      )
    case 'acquire':
      return (
        'V4 数据层挂载租约慢：要么共享层里有同会话的 projection store 被锁住，' +
        '要么本机渲染线程被其它任务（如首帧大 JSON 解析、其它会话的 store）占住。' +
        `看 detail.openKind：cold 说明是新建 store（后面还要等首帧），warm/keep_warm 说明复用了缓存。` +
        `当前 openKind=${String(d.openKind ?? '?')}。`
      )
    case 'subscribe':
      return (
        'POST /api/v4/conversation/subscribe 服务端处理慢：冷会话服务端要先 hydrate（读 SQLite transcript ' +
        '把历史转成 v4 行）再回 ACK。这段是**服务端/数据库**耗时，不是前端渲染问题。' +
        `看 detail.hydrateMs：若它占了大部分，就是 hydrate 拉库慢（大会话 transcript 大 / DB 锁）。` +
        `当前 hydrateMs=${String(d.hydrateMs ?? '未上报')}。`
      )
    case 'subscribe_ack':
      return (
        'ACK 返回后到前端拿到之间慢：通常是网络或 Gateway 排队。' +
        '若 subscribe 的服务端耗时很短但这一段长，说明卡在传输/事件循环，而不是数据库。'
      )
    case 'frame_snapshot':
      return (
        '首帧 snapshot 迟迟不到：服务端已经 ACK，但 frames SSE 没有把 initial 帧推过来。' +
        '常见原因：① SSE 连接刚建立还没拿到帧（看 sse_connected 是否晚于 subscribe）；' +
        '② 首帧很大，SSE 正在拼接未闭合的大帧（看 sse_frame_assemble / restKiB）；' +
        '③ 订阅与 ACK 之间发生了重订阅替换，旧订阅的帧被丢弃（看 mode 是不是 resume）。'
      )
    case 'store_apply':
      return (
        '首帧到了但投影 apply 慢：帧很大（JSON.parse + 逐行投影）时会出现。' +
        `看 detail.rowCount：帧越大越慢，这是纯前端 CPU 问题。当前行数≈${String(d.rowCount ?? '?')}。`
      )
    case 'render':
      return (
        'React 提交这段历史慢：大会话要一次性挂载大量行、测量行高、渲染工具卡。' +
        '属于前端渲染成本，与网络无关。'
      )
    case 'paint':
      return (
        'DOM 已提交但浏览器没及时上屏：主线程被占（其它任务/大列表测量），或发生了长任务。'
      )
    default:
      return `阶段 ${stage} 超时。`
  }
}

function finalizeStage(
  stage: OpenStage,
  durationMs: number,
  label: string,
  detail: Record<string, unknown> | undefined,
  forceReason?: string,
): OpenStageRecord {
  const { warn, error } = thresholdsFor(stage)
  let status: OpenStageStatus = 'ok'
  let reason: string | undefined

  if (durationMs >= error) {
    status = 'error'
    reason = forceReason ?? explainSlowStage(stage, detail)
  } else if (durationMs >= warn) {
    status = 'warn'
    reason = forceReason ?? explainSlowStage(stage, detail)
  }
  if (forceReason && !reason) reason = forceReason

  const rec: OpenStageRecord = {
    stage,
    atMs: current ? Math.max(0, Date.now() - current.startedAt) : 0,
    durationMs,
    status,
    label,
    ...(reason ? { reason } : {}),
    ...(detail && Object.keys(detail).length ? { detail } : {}),
  }
  return rec
}

function pushStage(rec: OpenStageRecord): void {
  if (!current) return
  current.stages.push(rec)
  current.lastAt = Date.now()
  // 进行中的 trace 也要能实时看到（UI 面板轮询 getOpenTraceRing）。
  syncLiveTrace()
}

/** 把进行中的 trace 同步到环形缓冲尾部（未结束时 status=pending）。 */
function syncLiveTrace(): void {
  if (!current) return
  const live: OpenTraceRecord = {
    traceId: current.traceId,
    sessionKey: current.sessionKey,
    ...(current.threadId ? { threadId: current.threadId } : {}),
    startedAt: current.startedAt,
    stages: [...current.stages],
    status: current.ended ? (current.endedStatus ?? 'pending') : 'pending',
    verdict: current.ended ? (current.endedVerdict ?? '') : '进行中…',
  }
  // 已在缓冲里（同一 traceId）就替换，否则追加。
  const idx = ring.findIndex((r) => r.traceId === live.traceId)
  if (idx >= 0) ring[idx] = live
  else ring.push(live)
  while (ring.length > RING_MAX) ring.shift()
  persistRing()
}

/** 环形缓冲落盘（localStorage + window 全局）。 */
function persistRing(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_RING_KEY, JSON.stringify(ring.slice(-RING_MAX)))
    }
  } catch {
    /* quota */
  }
  try {
    if (typeof window !== 'undefined') {
      ;(window as Window & { __evoflowOpenTrace?: OpenTraceRecord[] }).__evoflowOpenTrace = [...ring]
    }
  } catch {
    /* ignore */
  }
}

/**
 * 开始记录一次「点开会话」。
 * 重复调用（例如同一会话被点了两次）会开新的一条 trace，旧的那条标记为 interrupted。
 */
export function beginOpenTrace(sessionKey: string, opts?: { threadId?: string | null }): string {
  const sk = String(sessionKey || '').trim()
  traceCounter += 1
  const traceId = `ot-${Date.now().toString(36)}-${traceCounter}`
  const threadId = String(opts?.threadId || '').trim() || undefined
  if (current && !current.ended) {
    // 旧 trace 被顶掉：补一条收尾，别让面板显示成「永远没结束」。
    const rec = finalizeStage('click', Math.max(0, Date.now() - current.lastAt), '被新的点击打断', {
      interrupted: true,
    })
    rec.status = 'warn'
    rec.reason = '这次打开被下一次点击打断（上一次没走完就切走了）。'
    pushStage(rec)
    current.ended = true
    current.endedAt = Date.now()
    current.endedStatus = 'warn'
    current.endedVerdict = '这次打开被下一次点击打断（上一次没走完就切走了）。'
    archiveCurrent()
  }
  current = {
    traceId,
    sessionKey: sk,
    ...(threadId ? { threadId } : {}),
    startedAt: Date.now(),
    lastAt: Date.now(),
    stages: [],
    ended: false,
  }
  // click 阶段本身耗时为 0（锚点），但仍要入表，方便后续对齐。
  pushStage(
    finalizeStage('click', 0, '用户点击侧栏会话', {
      sessionKey: sk,
    }),
  )
  if (enabled()) {
    console.info(`${PREFIX} 点击会话 ${sk}（计时锚点已打，后续每步带 +Nms）`, {
      traceId,
      sessionKey: sk,
    })
  }
  return traceId
}

/**
 * 记一个阶段完成。
 * `detail` 里带上耗时/行数/字节等上下文，归因会引用这些字段。
 */
export function markOpenStage(
  stage: OpenStage,
  label: string,
  detail?: Record<string, unknown>,
  opts?: { reason?: string; durationMs?: number },
): void {
  if (!current || current.ended) return
  const now = Date.now()
  const durationMs = opts?.durationMs ?? Math.max(0, now - current.lastAt)
  const rec = finalizeStage(stage, durationMs, label, detail, opts?.reason)
  pushStage(rec)

  if (!enabled()) return
  const since = rec.atMs
  const line = `${PREFIX} +${since}ms ${stage} (${durationMs}ms) ${label}${
    rec.reason ? ` — ${rec.reason}` : ''
  }`
  const payload = {
    traceId: current.traceId,
    sessionKey: current.sessionKey,
    stage,
    sinceClickMs: since,
    durationMs,
    status: rec.status,
    ...(detail ?? {}),
  }
  if (rec.status === 'error') console.error(line, payload)
  else if (rec.status === 'warn') console.warn(line, payload)
  else console.info(line, payload)

  forwardToV4Life({
    event: `open_${stage}`,
    sessionKey: current.sessionKey,
    ...(current.threadId ? { threadId: current.threadId } : {}),
    level: rec.status === 'error' ? 'error' : rec.status === 'warn' ? 'warn' : 'info',
    zh: `【打开分段】+${since}ms ${stage} 耗时 ${durationMs}ms — ${label}${
      rec.reason ? `。原因：${rec.reason}` : ''
    }`,
    detail: { traceId: current.traceId, durationMs, ...(detail ?? {}) },
  })
}

/** 绑定 threadId 到当前 trace（ensure-thread 返回后调用）。 */
export function bindOpenTraceThread(threadId: string | null | undefined): void {
  if (!current || current.ended) return
  const t = String(threadId || '').trim()
  if (!t) return
  current.threadId = t
}

/** 当前 trace 是否仍在进行中。 */
export function isOpenTraceActive(): boolean {
  return !!current && !current.ended
}

/**
 * 结束本次打开：算总耗时、最慢阶段、汇总归因。
 * 正常情况下在 React 上屏后调用。
 */
export function endOpenTrace(opts?: {
  status?: 'ok' | 'warn' | 'error'
  reason?: string
  detail?: Record<string, unknown>
}): void {
  if (!current || current.ended) return
  const now = Date.now()
  const totalMs = Math.max(0, now - current.startedAt)

  let status: OpenStageStatus = 'ok'
  let reason = opts?.reason

  if (!reason) {
    if (totalMs >= TOTAL_ERROR_MS) {
      status = 'error'
      reason = `总耗时 ${totalMs}ms 超过异常阈值 ${TOTAL_ERROR_MS}ms。`
    } else if (totalMs >= TOTAL_WARN_MS) {
      status = 'warn'
      reason = `总耗时 ${totalMs}ms 超过偏慢阈值 ${TOTAL_WARN_MS}ms。`
    }
  }
  if (opts?.status) status = opts.status

  // 最慢阶段：排除 click 锚点（恒为 0）。
  let slowest: OpenTraceRecord['slowest'] = null
  for (const s of current.stages) {
    if (s.stage === 'click') continue
    if (!slowest || s.durationMs > slowest.durationMs) {
      slowest = { stage: s.stage, durationMs: s.durationMs }
    }
  }
  if (slowest && slowest.durationMs > 0) {
    const s = current.stages.find((x) => x.stage === slowest!.stage);
    if (s?.reason && !reason) reason = s.reason
  }

  const verdict =
    reason ||
    `总耗时 ${totalMs}ms，各阶段都在阈值内（正常）。${
      slowest ? `最慢的一段是 ${slowest.stage}（${slowest.durationMs}ms）。` : ''
    }`

  const rec: OpenTraceRecord = {
    traceId: current.traceId,
    sessionKey: current.sessionKey,
    ...(current.threadId ? { threadId: current.threadId } : {}),
    startedAt: current.startedAt,
    endedAt: now,
    totalMs,
    status,
    slowest,
    verdict,
    stages: [...current.stages],
    ...(opts?.detail ? { detail: opts.detail } : {}),
  }

  current.ended = true
  current.endedAt = now
  current.endedStatus = status
  current.endedVerdict = verdict
  archiveCurrent(rec)

  if (enabled()) {
    const line = `${PREFIX} 完成：总耗时 ${totalMs}ms（status=${status}）${verdict}`
    const payload = { traceId: rec.traceId, sessionKey: rec.sessionKey, totalMs, status }
    if (status === 'error') console.error(line, payload)
    else if (status === 'warn') console.warn(line, payload)
    else console.info(line, payload)

    forwardToV4Life({
      event: 'open_done',
      sessionKey: rec.sessionKey,
      ...(rec.threadId ? { threadId: rec.threadId } : {}),
      level: status === 'error' ? 'error' : status === 'warn' ? 'warn' : 'info',
      zh: `【打开完成】总耗时 ${totalMs}ms（status=${status}）。${verdict}`,
      detail: {
        traceId: rec.traceId,
        totalMs,
        slowestStage: slowest?.stage ?? null,
        slowestMs: slowest?.durationMs ?? null,
        stages: current.stages.map((s) => ({
          stage: s.stage,
          ms: s.durationMs,
          status: s.status,
        })),
      },
    })
  }
}

/** 归档到环形缓冲 + localStorage（按 traceId 覆盖，避免同一次打开出现两条）。 */
function archiveCurrent(rec?: OpenTraceRecord): void {
  const snapshot: OpenTraceRecord =
    rec ?? {
      traceId: current?.traceId ?? '',
      sessionKey: current?.sessionKey ?? '',
      ...(current?.threadId ? { threadId: current.threadId } : {}),
      startedAt: current?.startedAt ?? Date.now(),
      endedAt: current?.endedAt ?? Date.now(),
      totalMs: current ? (current.endedAt ?? Date.now()) - current.startedAt : 0,
      status: current?.endedStatus ?? 'warn',
      verdict:
        current?.endedVerdict ?? '这次打开没有走完（被中断或异常）。',
      stages: current ? [...current.stages] : [],
    }
  const idx = ring.findIndex((r) => r.traceId === snapshot.traceId)
  if (idx >= 0) ring[idx] = snapshot
  else ring.push(snapshot)
  while (ring.length > RING_MAX) ring.shift()
  persistRing()
}

/** 供 UI 面板读取：最近 N 次打开的完整分段。 */
export function getOpenTraceRing(): OpenTraceRecord[] {
  return [...ring]
}

/** 供 UI 面板读取：当前正在进行的那次（未结束）。 */
export function getCurrentOpenTrace(): OpenTraceRecord | null {
  if (!current) return null
  return {
    traceId: current.traceId,
    sessionKey: current.sessionKey,
    ...(current.threadId ? { threadId: current.threadId } : {}),
    startedAt: current.startedAt,
    stages: [...current.stages],
    status: 'pending',
    verdict: '进行中…',
  }
}

/** 清空历史（UI 面板的「清空」按钮）。 */
export function clearOpenTraceRing(): void {
  ring.length = 0
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_RING_KEY)
  } catch {
    /* ignore */
  }
  try {
    if (typeof window !== 'undefined') {
      ;(window as Window & { __evoflowOpenTrace?: OpenTraceRecord[] }).__evoflowOpenTrace = []
    }
  } catch {
    /* ignore */
  }
}

/** 供测试：重置模块级状态。 */
export function __resetOpenTraceForTest(): void {
  current = null
  ring.length = 0
}
