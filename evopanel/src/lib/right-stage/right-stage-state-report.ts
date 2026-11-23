/**
 * 右栏「用户当前在看哪一页」的上报通道。
 *
 * 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新增本文件 + `POST /api/stage/right-stage/state`，把 activeKey / 标签清单
 *   上报到 gateway，模型侧用 `platform action=ui.current` 读回来。
 * 为什么（用户 2026-11-20 明确指出）：
 *   「你知道我当前右侧标签页是哪个吗？这个在你的管理体系里边能查到吗？」
 *   答案是不能 —— `grep activeKey backend --include=*.py` 命中 0 次，
 *   右栏状态此前只活在前端内存（刷新靠 sessionStorage 恢复），后端一无所知。
 *   后果有两个，都真实：
 *   ① 模型 ui.show 时不知道用户正在看什么，直接把视线抢走；
 *   ② 该复用的那一页被新开成第二个签，同一份东西出现两遍。
 *
 * 边界：
 * - 只在 store.bump() 里调（状态真变才发），并做 400ms 尾部节流，避免拖拽/流式刷屏。
 * - 全程静默失败：上报通道坏了绝不能影响右栏本身。
 * - 只发身份字段，不发 data 载荷（预览正文/消息数组不出去）。
 */

import { getCurrentRightStageSessionKey } from './right-stage-scope.js'

/**
 * 右栏当前 UI 会话键。runtime 侧在切换会话时由 setCurrentRightStageSessionKey 写入。
 * 这里用惰性 import 避免 report ←→ scope 的静态环。
 */
function readCurrentStageSessionKey(): string {
  try {
    return String(getCurrentRightStageSessionKey() || '').trim()
  } catch {
    return ''
  }
}

const REPORT_THROTTLE_MS = 400
const REPORT_ENDPOINT = '/api/stage/right-stage/state'

let timer: ReturnType<typeof setTimeout> | null = null
let pending: Record<string, unknown> | null = null
let inFlight = false
/** 在飞期间到达的最新状态；当前请求结束后必须补发一次，不许丢。 */
let queued: Record<string, unknown> | null = null

/** 只保留能标识「这是哪一页」的字段；载荷一律不出去。 */
const IDENTITY_KEYS = [
  'path',
  'name',
  'url',
  'pageUrl',
  'threadId',
  'taskId',
  'agentCode',
  'sessionKey',
  'extensionId',
  'childSessionId',
  'parentSessionId',
  // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：补 mainTaskId / subtaskId / mountId / focusId / roundId / agent_code。
  // 为什么（本轮真机实测）：ui.current 回读协作两类的签时 data 恒为 {}，
  //   模型看得见 key 却不知道「这是哪一单的主任务/哪个节点」——想复用同一签
  //   只能靠解析 key 里的字符串，等于逼调用方去猜。它们都是纯身份字段，
  //   不带任何正文载荷，加进来不违反「只发身份」的边界。
  'mainTaskId',
  'subtaskId',
  'mountId',
  'focusId',
  'roundId',
  'agent_code',
] as const

function slimData(data: unknown): Record<string, unknown> {
  const src = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of IDENTITY_KEYS) {
    const v = src[k]
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/**
 * 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：tab key 改为按 store 的真实口径计算 `${kind}:${id}`，不再读 `t.key`。
 * 为什么（重启后现网实测抓到的真缺陷）：
 *   `RightStageSurface` 上**根本没有 key 字段** —— 键是 `store.tabKeyOf(surface)`
 *   算出来的 `${kind}:${id}`（right-stage-store.ts:111）。
 *   第一版我写了 `key: String(t?.key || '')`，于是现网 `/api/stage/right-stage/state`
 *   回的是 `tabs:[{key:"",kind:"employeeProcess",...}]`、`activeKind:null`、
 *   `activeTitle:null`，而 activeKey 却有值 —— 读侧等于半瞎：
 *   模型拿到一份「有标签但全都无键、当前页类型未知」的状态，无法据此切签。
 *   单测没抓到是因为我自己造的 snapshot 里塞了 `key` 字段（自造样例不算证据）。
 * 判据：上报 payload 的 tabs[].key 必须非空且等于 `${kind}:${id}`；
 *   activeKind/activeTitle 必须由 activeKey 命中填上。
 */
function surfaceKey(t: Record<string, unknown>): string {
  const explicit = String(t?.key || '')
  if (explicit) return explicit
  const kind = String(t?.kind || '')
  const id = String(t?.id || '')
  return kind && id ? `${kind}:${id}` : ''
}

function buildPayload(snapshot: {
  tabs?: Array<Record<string, unknown>>
  activeKey?: string | null
  collapsed?: boolean
  rev?: number
}): Record<string, unknown> {
  const tabs = (Array.isArray(snapshot?.tabs) ? snapshot.tabs : []).map((t) => ({
    key: surfaceKey(t),
    kind: String(t?.kind || ''),
    title: String(t?.title || ''),
    ...(t?.sessionKey ? { sessionKey: String(t.sessionKey) } : {}),
    // 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
    // 改了什么：上报里补 ``openedBy``（这个签是谁打开的）。
    // 为什么（用户 2026-11-23 原话）：「让 AI 能看懂就可以了……这个后面主要是让 AI 看」。
    //   本函数是**手工拼 tabs** 的白名单式重建，没列进来的字段一律消失——
    //   于是就算 store 里存了 openedBy，``platform action=ui.current`` 回给模型的
    //   tabs[] 里也读不到，AI 根本看不见「谁开的签」，只能靠人悬停。
    // 判据：上报 payload 的 tabs[].openedBy 与 store 里的值逐字一致（空值不发，保持旧形态）。
    ...(t?.openedBy ? { openedBy: String(t.openedBy) } : {}),
    data: slimData(t?.data),
  }))
  const activeKey = String(snapshot?.activeKey || '') || null
  const activeTab = tabs.find((t) => t.key === activeKey) || null
  return {
    activeKey,
    activeKind: activeTab ? activeTab.kind : null,
    activeTitle: activeTab ? activeTab.title : null,
    collapsed: snapshot?.collapsed === true,
    // 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：上报里补顶层 ``sessionKey``＝右栏此刻挂在哪条会话上。
    // 为什么（本轮现网实测 13:26:37）：我在 proactive 会话发 ui.show(expand=true)，
    //   工具回执写 ``visible: true``，用户屏幕上 44 秒什么都没有；13:27:20.825
    //   用户点侧栏切到我的会话之后那签才出现。前端隔离分支是对的（后台归属只写该会话
    //   冻结记忆），错的是**回执无从判断**——它只拿到 collapsed，拿不到「右栏挂在哪条会话」。
    // 判据：顶层 sessionKey 是「用户此刻看的会话」的唯一事实，工具侧据此才能说清
    //   「这次写了但你看不见，切过去才有」。只发身份，不涉载荷正文。
    sessionKey: readCurrentStageSessionKey() || null,
    tabs,
    rev: Number(snapshot?.rev || 0),
    reportedAt: new Date().toISOString(),
  }
}

async function post(payload: Record<string, unknown>): Promise<void> {
  // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：inFlight 时不再直接 return 丢掉，而是记进 queued，等当前请求结束后补发。
  // 为什么（本轮实测抓到的真缺陷）：旧写法 `if (inFlight) return` 让**最后一次**状态
  //   在「上一次上报还没回来」时被静默丢弃，没有重试、没有排队。右栏突发 bump
  //   （连续 show/activate/close）时，最终状态可能永远上不了报 —— 于是 ui.current
  //   回读到的是中间态：模型看到 3 个签，用户屏幕上只剩 1 个。这类"读侧永远差一拍"
  //   比彻底坏掉更难发现，因为大多数时候看起来都对。
  // 判据：同一时刻最多一个在飞；在飞期间的新状态只保留最新一份，结束后必发一次。
  if (inFlight) {
    queued = payload
    return
  }
  inFlight = true
  try {
    // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：改用 gatewayFetch（走 gatewayProxy），不再自己拼 `${base}${path}`。
    // 为什么（本轮实测发现的真缺陷）：旧写法 base 缺省是 `/__evoflow`，拼出来是
    //   `/__evoflow/api/stage/right-stage/state`，而网关只挂载 `/api/stage/...`，
    //   `curl http://127.0.0.1:8382/api/stage/right-stage/state` → 404 的同时
    //   `/__evoflow/...` 在网关根本没有这个前缀（grep '/__evoflow' backend 只命中
    //   `__evoflow-log` 两条日志路由）。桌面端更糟：webview 直接 fetch 本机网关
    //   会 Failed to fetch（tauri-api 注释写明要优先 gatewayProxy）。
    //   结果就是上报**从来没送到**，ui.current 恒返回 known=false —— 能力写了等于没写。
    // 判据：URL 必须走 gatewayFetch，路径固定 `/api/stage/right-stage/state`；
    //   测试里断言「没有 /__evoflow 前缀」。
    const { gatewayFetch } = await import('../gateway-json.js')
    const res = await gatewayFetch(REPORT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 先序列化成字符串：gatewayFetch 的两条分支（Tauri invoke / 浏览器 fetch）
      // 都能直接吃 string，避免对象 body 在类型层与运行时之间来回转换。
      body: JSON.stringify(payload),
      keepalive: true,
    })
    // 非 2xx 不抛，但也不要静默当成成功——只做调试留痕，绝不影响右栏。
    if (res && typeof res === 'object' && 'ok' in res && res.ok === false) {
      warnOnce('right-stage state report rejected', res)
    }
  } catch (err) {
    warnOnce('right-stage state report failed', err)
  } finally {
    inFlight = false
    // 在飞期间被排队的最新状态：立刻补发，保证读侧最终能看到最后那个状态。
    const next = queued
    queued = null
    if (next) void post(next)
  }
}

/** 只警告一次，避免右栏每次 bump 都刷屏（网关没起时会连续失败）。 */
let warned = false
function warnOnce(msg: string, detail: unknown): void {
  if (warned) return
  warned = true
  try {
    console.warn(`[right-stage] ${msg}`, detail)
  } catch {
    /* ignore */
  }
}

/**
 * 上报当前右栏状态（尾部节流）。由 `rightStageStore.bump()` 调用。
 */
export function reportRightStageState(snapshot: unknown): void {
  try {
    pending = buildPayload(snapshot as never)
  } catch {
    return
  }
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const payload = pending
    pending = null
    if (payload) void post(payload)
  }, REPORT_THROTTLE_MS)
}

/** 测试用：立刻冲刷待发送的载荷。 */
export async function __flushRightStageStateForTest(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const payload = pending
  pending = null
  if (payload) await post(payload)
  // 在飞期间排到的那份也要排空，否则测试通道比真通道更容易丢状态（判据不一致）。
  const next = queued
  queued = null
  if (next) await post(next)
}
