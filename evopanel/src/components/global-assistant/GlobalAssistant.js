/**
 * 小V全局浮动助手 · 主 UI（vanilla，挂在 #app 外层，路由切换不卸载）
 */
import { navigate, getCurrentRoute } from '../../router.js'
import { toast } from '../toast.js'
import { showConfirm } from '../modal.js'
import {
  formatShortcutDisplay,
  getShortcutBinding,
  shortcutMatchesEvent,
} from '../../lib/keyboard-shortcuts.js'
import { extractPageContext, shouldHideAssistant, moduleGuideSuggestions, edgeCoachTip, collectXiaomiPageSnapshot } from './assistant-context.js'
import {
  getState,
  patchState,
  subscribe,
  markAttentionRead,
  getContactDraft,
  setContactDraft,
} from './assistant-store.js'
import {
  fetchAssistantDashboard,
  fetchEmployeeThread,
  parseTaskTime,
  delegateToEmployee,
  requestEmployeeUpdate,
  createMeeting,
  startMeetingDiscussion,
  pollMeetingTasks,
  pollMeetingTurns,
  mentionMeeting,
  concludeMeeting,
} from './assistant-api.js'
import { greetingByHour } from './assistant-rules.js'
import { toTaskStatusGroup } from '../../lib/task-status-label.js'
import {
  ensureXiaomiSession,
  bindXiaomiStreamListener,
  sendXiaomiChat,
  stopXiaomiChat,
  startXiaomiNewRound,
  startXiaomiNewChat,
  switchXiaomiSession,
  refreshXiaomiSessionList,
  syncXiaomiPageContext,
  fingerprintXiaomiPageSnap,
  XIAOMI_AGENT,
} from './assistant-session.js'
import {
  startFeishuEmployeeScan,
  unbindFeishuEmployee,
} from '../../lib/feishu-employee-bind.js'
import {
  registerXiaomiVoiceSendHandler,
  unregisterXiaomiVoiceSendHandler,
  registerXiaomiVoicePartialHandler,
  unregisterXiaomiVoicePartialHandler,
} from '../../lib/background-voice-bridge.js'
import { mountAgentAvatar } from '../../lib/mount-agent-ui.js'
import { mountProactiveLiveProcess } from '../proactive-live-process.js'
import { api, getGatewayBaseUrl } from '../../lib/tauri-api.js'
import { mountAiRoundtableRoom } from './mount-ai-roundtable.js'
import { mountXiaomiChatThread, unmountXiaomiChatThread } from './mount-xiaomi-chat-thread.js'
import { mountXiaomiSessionDebug, unmountXiaomiSessionDebug } from './mount-xiaomi-session-debug.js'
import { wsClient } from '../../lib/ws-client.js'

function unmountXiaomiPanelReactHosts() {
  unmountXiaomiChatThread()
  unmountXiaomiSessionDebug()
}
import {
  isMeetingTtsMuted,
  toggleMeetingTtsMuted,
  syncMeetingTts,
  resetMeetingTtsSession,
  stopMeetingTts,
  enableMeetingTtsFromUserGesture,
} from '../../lib/meeting-tts.js'
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtRel(iso) {
  if (!iso) return ''
  try {
    const d = parseTaskTime(iso)
    if (!d) return ''
    const sec = Math.round((Date.now() - d.getTime()) / 1000)
    if (sec < 0) {
      // 未来时间多半是时区误解析，回退绝对时间
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    if (sec < 60) return '刚刚'
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
    if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function pageContext() {
  const st = getState()
  if (!st.contextPinned) return { route: '', contextType: '', contextId: '', label: '', module: '' }
  if (st.contextOverride) return st.contextOverride
  return extractPageContext()
}

/** @returns {'dock' | 'float'} */
function resolvePanelLayout(st = getState()) {
  const pref = String(st.panelLayoutPref || 'auto')
  if (pref === 'float') return 'float'
  // auto / dock：统一右侧栏（边缘条入口），不再默认悬浮球
  return 'dock'
}

/** 是否用「工作栏」精简壳（无联系人轨 / 引导 chips） */
function isWorkbenchDock(st = getState()) {
  return resolvePanelLayout(st) === 'dock'
}

const COACH_ROUTE_COOLDOWN_MS = 40_000

function resolveEdgeCoach(st = getState()) {
  const tip = edgeCoachTip()
  if (!tip) return null
  const dismissed = Array.isArray(st.coachDismissed) ? st.coachDismissed : []
  if (dismissed.includes(tip.id)) return null
  return tip
}

function syncDockChrome(st = getState()) {
  const docked = !!(st.isOpen && !st.isMinimized && resolvePanelLayout(st) === 'dock')
  try {
    document.documentElement.classList.toggle('is-xm-docked', docked)
    document.documentElement.style.setProperty('--xm-dock-width', docked ? '400px' : '0px')
  } catch {
    /* ignore */
  }
  syncShellXiaomiActive(docked || !!(st.isOpen && !st.isMinimized))
}

let _root = null
let _pollTimer = null
let _meetingPollTimer = null
let _unsub = null
let _routeBound = false
/** 拖动后抑制一次 click 打开 */
let _suppressFabOpen = false
/** 单击延迟打开，避免与双击「恢复默认」抢事件 */
let _fabOpenTimer = null
/** @type {null | { pointerId: number, startX: number, startY: number, originLeft: number, originTop: number, moved: boolean }} */
let _fabDrag = null
/** @type {ReturnType<typeof mountProactiveLiveProcess> | null} */
let _liveProcess = null
/** agent_code(lower) → listAgents 行（头像权威来源） */
let _avatarByCode = new Map()
let _gatewayBaseCache = ''
let _avatarMountSeq = 0
let _mroomAvatarMountSeq = 0
let _avatarIndexAt = 0

const FAB_SIZE = 56
const FAB_MARGIN = 12
const FAB_DRAG_THRESHOLD = 6
const FAB_OPEN_DELAY_MS = 260
const RAIL_AVATAR_SIZE = 32
const MROOM_AVATAR_SIZE = 68
const MROOM_AVATAR_SPEAKING = 84
const AVATAR_INDEX_TTL_MS = 30_000

const WORK_STATUS_LABEL = {
  working: '工作中',
  waiting: '等待中',
  blocked: '受阻',
  offline: '请假/离线',
  error: '异常',
  idle: '空闲',
}

function ensureLiveProcess() {
  if (!_liveProcess) _liveProcess = mountProactiveLiveProcess(document.body)
  return _liveProcess
}

async function ensureGatewayBase() {
  if (!_gatewayBaseCache) {
    try {
      _gatewayBaseCache = await getGatewayBaseUrl()
    } catch {
      _gatewayBaseCache = ''
    }
  }
  return _gatewayBaseCache
}

async function refreshAvatarIndex({ force = false } = {}) {
  if (!force && _avatarByCode.size && Date.now() - _avatarIndexAt < AVATAR_INDEX_TTL_MS) return
  try {
    const agents = await api.listAgents()
    const map = new Map()
    for (const a of agents || []) {
      const code = String(a?.agent_code || a?.name || '').trim().toLowerCase()
      if (code) map.set(code, a)
    }
    _avatarByCode = map
    _avatarIndexAt = Date.now()
  } catch {
    /* keep previous */
  }
}

function resolveAvatarAgent(code, roleHint = null) {
  const key = String(code || '').trim().toLowerCase()
  const fromAgents = key ? _avatarByCode.get(key) : null
  const role = roleHint || findAgent(code)
  return {
    agent_code: code,
    agent_name:
      fromAgents?.agent_name ||
      fromAgents?.name ||
      role?.role_name ||
      code,
    avatar: fromAgents?.avatar ?? role?.avatar ?? null,
    avatar_meta: fromAgents?.avatar_meta ?? role?.avatar_meta ?? null,
    tts_speaker: fromAgents?.tts_speaker ?? role?.tts_speaker ?? null,
    has_avatar_file: fromAgents?.has_avatar_file ?? role?.has_avatar_file,
    avatar_rev: fromAgents?.avatar_rev ?? null,
  }
}

function mountRailAvatars() {
  if (!_root) return
  const seq = ++_avatarMountSeq
  void (async () => {
    const baseUrl = await ensureGatewayBase()
    await refreshAvatarIndex()
    if (seq !== _avatarMountSeq || !_root) return
    _root.querySelectorAll('[data-xm-avatar]').forEach((el) => {
      if (!(el instanceof HTMLElement)) return
      const code = String(el.getAttribute('data-xm-avatar') || '').trim()
      if (!code) return
      const size = Number(el.getAttribute('data-avatar-size') || RAIL_AVATAR_SIZE) || RAIL_AVATAR_SIZE
      mountAgentAvatar(el, {
        agent: resolveAvatarAgent(code),
        agentCode: code,
        size,
        baseUrl,
      })
    })
  })()
}

/** 会议室座位头像：不与侧栏 mount 序号互相取消，重建 DOM 后必调 */
function mountMeetingRoomAvatars() {
  if (!_root) return
  const room = _root.querySelector('.xm-mroom')
  if (!room) return
  const seq = ++_mroomAvatarMountSeq
  void (async () => {
    const baseUrl = await ensureGatewayBase()
    await refreshAvatarIndex()
    if (seq !== _mroomAvatarMountSeq || !_root) return
    const live = _root.querySelector('.xm-mroom')
    if (!live) return
    live.querySelectorAll('[data-xm-avatar]').forEach((el) => {
      if (!(el instanceof HTMLElement)) return
      const code = String(el.getAttribute('data-xm-avatar') || '').trim()
      if (!code) return
      const size = Number(el.getAttribute('data-avatar-size') || MROOM_AVATAR_SIZE) || MROOM_AVATAR_SIZE
      mountAgentAvatar(el, {
        agent: resolveAvatarAgent(code),
        agentCode: code,
        size,
        baseUrl,
      })
    })
  })()
}

function seatInitial(nameOrCode) {
  const s = String(nameOrCode || '?').trim()
  return (s.charAt(0) || '?').toUpperCase()
}

/** 过滤值班工作汇报等噪声（兼容历史「交班」文案），会议 UI 只展示口头汇报 */
function formatMeetingReply(text) {
  let raw = String(text || '').trim()
  if (!raw) return ''
  const bad = [
    '[feishu·值班交班摘要]',
    '[feishu·工作汇报]',
    '值班交班摘要',
    '工作汇报摘要',
    '员工工作摘要',
    '【值班',
    'wrap_up',
  ]
  if (bad.some((m) => raw.includes(m))) {
    raw = raw
      .split('\n')
      .map((ln) => ln.trim())
      .filter(
        (ln) =>
          ln &&
          !bad.some((m) => ln.includes(m)) &&
          !ln.startsWith('[feishu') &&
          !ln.includes('交班') &&
          !ln.includes('工作汇报摘要'),
      )
      .join('\n')
      .trim()
  }
  if (!raw) return '（本条像值班摘要，已隐藏；请重新发起讨论）'
  return raw
}

function resolveSelectedContact(st = getState()) {
  const raw = String(st.selectedContact || 'xiaomi').trim() || 'xiaomi'
  if (raw === 'xiaomi') return 'xiaomi'
  const hit = (st.agents || []).find((a) => String(a.agent_code || '') === raw)
  if (hit) return raw
  return 'xiaomi'
}

function findAgent(code) {
  const c = String(code || '').trim()
  return (getState().agents || []).find((a) => String(a.agent_code || '') === c) || null
}

function contactDraft(st = getState()) {
  return getContactDraft(resolveSelectedContact(st))
}

async function refreshEmployeeThreadForContact(code) {
  const c = String(code || '').trim()
  if (!c || c === 'xiaomi') return
  const agent = findAgent(c)
  try {
    const data = await fetchEmployeeThread(c, { roleName: agent?.role_name || '' })
    const cur = resolveSelectedContact()
    if (cur !== c) return
    patchState({
      employeeThread: {
        code: c,
        busy: data.busy,
        openTasks: data.openTasks,
        recentReports: data.recentReports,
        historyReports: data.historyReports,
        fetchedAt: Date.now(),
      },
    })
  } catch {
    /* ignore */
  }
}

function selectContact(code, { focusDraft = false } = {}) {
  const next = String(code || 'xiaomi').trim() || 'xiaomi'
  const st = getState()
  const prev = resolveSelectedContact(st)
  if (prev !== next) {
    // 切联系人前把当前输入框写回草稿 map
    const ta = _root?.querySelector('[data-draft]')
    if (ta instanceof HTMLTextAreaElement) setContactDraft(prev, ta.value)
  }
  patchState(
    {
      selectedContact: next,
      activeView: 'chat',
      employeeThread: next === 'xiaomi' ? null : st.employeeThread?.code === next ? st.employeeThread : null,
    },
    { persistUi: true },
  )
  if (next !== 'xiaomi') void refreshEmployeeThreadForContact(next)
  if (focusDraft) {
    queueMicrotask(() => {
      const ta = _root?.querySelector('[data-draft]')
      if (ta instanceof HTMLTextAreaElement) ta.focus()
    })
  }
}

function appendEmployeeLocalMsg(code, text) {
  const c = String(code || '').trim()
  if (!c) return
  const map = { ...(getState().employeeLocalMsgs || {}) }
  const list = Array.isArray(map[c]) ? [...map[c]] : []
  list.push({
    id: `loc-${Date.now()}`,
    role: 'user',
    text: String(text || '').trim(),
    ts: Date.now(),
  })
  map[c] = list.slice(-40)
  patchState({ employeeLocalMsgs: map })
}

function clampFabPos(left, top) {
  const maxL = Math.max(FAB_MARGIN, window.innerWidth - FAB_SIZE - FAB_MARGIN)
  const maxT = Math.max(FAB_MARGIN, window.innerHeight - FAB_SIZE - FAB_MARGIN)
  return {
    left: Math.min(maxL, Math.max(FAB_MARGIN, left)),
    top: Math.min(maxT, Math.max(FAB_MARGIN, top)),
  }
}

function applyFabPosition(fab, st = getState()) {
  if (!(fab instanceof HTMLElement)) return
  const hasCustom = Number.isFinite(st.fabLeft) && Number.isFinite(st.fabTop)
  if (!hasCustom) {
    fab.classList.remove('xm-fab--custom')
    fab.style.left = ''
    fab.style.top = ''
    fab.style.right = ''
    fab.style.bottom = ''
    return
  }
  const { left, top } = clampFabPos(Number(st.fabLeft), Number(st.fabTop))
  fab.classList.add('xm-fab--custom')
  fab.style.left = `${left}px`
  fab.style.top = `${top}px`
  fab.style.right = 'auto'
  fab.style.bottom = 'auto'
}

/** 强制球可见（对抗外部 CSS / 拖出屏外 / 残留 display:none） */
function ensureFabVisible(fab) {
  if (!(fab instanceof HTMLElement)) return
  fab.hidden = false
  fab.style.removeProperty('display')
  fab.style.setProperty('display', 'flex', 'important')
  fab.style.setProperty('visibility', 'visible', 'important')
  fab.style.setProperty('opacity', '1', 'important')
  fab.style.setProperty('pointer-events', 'auto', 'important')
}

function setFabPosition(left, top, { persist = true } = {}) {
  const pos = clampFabPos(left, top)
  patchState({ fabLeft: pos.left, fabTop: pos.top }, { persistUi: persist, silent: true })
  const fab = _root?.querySelector('.xm-fab')
  if (fab) applyFabPosition(fab, { ...getState(), ...pos })
}

function resetFabPosition() {
  patchState({ fabLeft: null, fabTop: null }, { persistUi: true, silent: true })
  const fab = _root?.querySelector('.xm-fab')
  if (fab) applyFabPosition(fab, getState())
}

function cancelFabOpenTimer() {
  if (_fabOpenTimer) {
    clearTimeout(_fabOpenTimer)
    _fabOpenTimer = null
  }
}

async function refreshDashboard() {
  const cold = !getState().summary
  if (cold) patchState({ loading: true, error: '' })
  else patchState({ error: '' }, { silent: true })
  try {
    const [data] = await Promise.all([
      fetchAssistantDashboard(),
      refreshAvatarIndex({ force: true }),
    ])
    const contact = resolveSelectedContact({ ...getState(), agents: data.agents })
    let employeeThread = getState().employeeThread
    if (contact && contact !== 'xiaomi') {
      const agent = (data.agents || []).find((a) => String(a.agent_code || '') === contact)
      try {
        const thread = await fetchEmployeeThread(contact, { roleName: agent?.role_name || '' })
        employeeThread = {
          code: contact,
          busy: thread.busy,
          openTasks: thread.openTasks,
          recentReports: thread.recentReports,
          historyReports: thread.historyReports,
          fetchedAt: Date.now(),
        }
      } catch {
        /* keep previous */
      }
    } else {
      employeeThread = null
    }
    patchState({
      loading: false,
      summary: data.summary,
      attentionItems: data.attentionItems,
      activeTasks: data.activeTasks,
      recentCompletions: data.recentCompletions,
      suggestedActions: data.suggestedActions,
      agents: data.agents,
      approvals: data.approvals,
      badgeCount: data.badgeCount,
      feishuBound: Boolean(data.feishuBound),
      partialUnavailable: data.partialUnavailable,
      error: data.error || '',
      lastFetchedAt: Date.now(),
      selectedContact: contact,
      employeeThread,
    })
  } catch (e) {
    patchState({
      loading: false,
      error: String(e?.message || e),
      partialUnavailable: true,
    })
  }
}

/** 已处理过的 meeting task_id，避免重复渲染 */
let _meetingProcessedTasks = new Set()
let _meetingTaskSeenCount = 0
let _meetingPollStart = 0
/** 会议室 transcript 消息指纹，避免无意义重绘 */
let _mroomMsgSig = ''
/** 当前汇报卡指纹 */
let _mroomSpeechSig = ''
/** @type {ReturnType<typeof mountAiRoundtableRoom> | null} */
let _aiRtMount = null

/**
 * 舞台构图座位（百分比坐标），避免机械正圆平均分配。
 * 上方 3 · 左右各 2~3 · 下方 2；主持人单独固定在底部中央。
 * @param {number} count
 * @returns {{ x: number, y: number }[]}
 */
function meetingSeatLayout(count) {
  const n = Math.max(0, Number(count) || 0)
  if (n <= 0) return []
  /** @type {Record<number, { x: number, y: number }[]>} */
  const presets = {
    1: [{ x: 50, y: 16 }],
    2: [
      { x: 34, y: 18 },
      { x: 66, y: 18 },
    ],
    3: [
      { x: 28, y: 16 },
      { x: 50, y: 12 },
      { x: 72, y: 16 },
    ],
    4: [
      { x: 28, y: 16 },
      { x: 50, y: 12 },
      { x: 72, y: 16 },
      { x: 50, y: 74 },
    ],
    5: [
      { x: 28, y: 16 },
      { x: 50, y: 12 },
      { x: 72, y: 16 },
      { x: 14, y: 48 },
      { x: 86, y: 48 },
    ],
    6: [
      { x: 28, y: 16 },
      { x: 50, y: 12 },
      { x: 72, y: 16 },
      { x: 12, y: 46 },
      { x: 88, y: 46 },
      { x: 50, y: 74 },
    ],
    7: [
      { x: 28, y: 15 },
      { x: 50, y: 11 },
      { x: 72, y: 15 },
      { x: 12, y: 40 },
      { x: 88, y: 40 },
      { x: 18, y: 68 },
      { x: 82, y: 68 },
    ],
    8: [
      { x: 28, y: 14 },
      { x: 50, y: 10 },
      { x: 72, y: 14 },
      { x: 11, y: 36 },
      { x: 89, y: 36 },
      { x: 12, y: 58 },
      { x: 88, y: 58 },
      { x: 50, y: 74 },
    ],
    9: [
      { x: 28, y: 14 },
      { x: 50, y: 10 },
      { x: 72, y: 14 },
      { x: 11, y: 36 },
      { x: 89, y: 36 },
      { x: 10, y: 56 },
      { x: 90, y: 56 },
      { x: 24, y: 74 },
      { x: 76, y: 74 },
    ],
    10: [
      { x: 26, y: 13 },
      { x: 50, y: 9 },
      { x: 74, y: 13 },
      { x: 10, y: 32 },
      { x: 90, y: 32 },
      { x: 9, y: 52 },
      { x: 91, y: 52 },
      { x: 22, y: 72 },
      { x: 50, y: 76 },
      { x: 78, y: 72 },
    ],
  }
  if (presets[n]) return presets[n]
  const gap = Math.PI / 2.6
  const span = 2 * Math.PI - gap
  const start = Math.PI + gap / 2
  const rx = 40
  const ry = 36
  return Array.from({ length: n }, (_, i) => {
    const a = start + (i / Math.max(1, n - 1)) * span
    return {
      x: Number((50 + rx * Math.sin(a)).toFixed(2)),
      y: Number((48 - ry * Math.cos(a)).toFixed(2)),
    }
  })
}

function meetingSpeakerState(st, agentCode) {
  const msgs = st.meetingMessages || []
  const working = msgs.find(
    (m) => m.role === 'agent' && m.agent_code === agentCode && (m.state === 'working' || m.streaming),
  )
  if (working) {
    const text = String(working.text || '')
    if (!text.trim()) return 'thinking'
    return 'speaking'
  }
  const done = msgs.find(
    (m) =>
      m.role === 'agent' &&
      m.agent_code === agentCode &&
      (m.state === 'completed' || m.state === 'failed' || m.state === 'canceled'),
  )
  if (done) {
    if (done.error) return 'error'
    const t = String(done.text || '')
    if (/不同意|反对|质疑|不太认同/.test(t) && !/同意|赞同|支持/.test(t.slice(0, 24))) return 'disagree'
    if (/同意|赞同|支持|认同|\+1/.test(t.slice(0, 48))) return 'agree'
    return 'done'
  }
  if (st.meetingPolling || st.meetingSending) return 'waiting'
  return 'idle'
}

function meetingStatusLabel(status, selected) {
  if (selected && status !== 'speaking' && status !== 'thinking') return '已点名'
  switch (status) {
    case 'speaking':
      return 'Speaking'
    case 'thinking':
      return 'Thinking…'
    case 'agree':
      return '+1'
    case 'disagree':
      return '不同意'
    case 'done':
      return '已发言'
    case 'error':
      return '异常'
    case 'waiting':
      return '等待中'
    default:
      return '已入席'
  }
}

function meetingRoundLabel(st) {
  const n = Math.max(1, (st.meetingMessages || []).filter((m) => m.role === 'user').length || 0)
  return String(n).padStart(2, '0')
}

function speechExcerpt(text, maxLen = 96) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  if (t.length <= maxLen) return t
  return `${t.slice(0, maxLen - 1)}…`
}

function mroomIcon(name) {
  const common =
    'xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
  switch (name) {
    case 'layout':
      return `<svg ${common}><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>`
    case 'panel':
      return `<svg ${common}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>`
    case 'creator':
      return `<svg ${common}><rect x="7" y="2" width="10" height="20" rx="2"/><circle cx="12" cy="18" r="1"/></svg>`
    case 'collapse':
      return `<svg ${common}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`
    case 'expand':
      return `<svg ${common}><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`
    case 'leave':
      return `<svg ${common}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>`
    case 'stop':
      return `<svg ${common}><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
    case 'spark':
      return `<svg ${common}><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/></svg>`
    default:
      return ''
  }
}

function openMeetingRoom() {
  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 1024px)').matches
  patchState(
    {
      meetingRoomOpen: true,
      isOpen: true,
      isMinimized: false,
      ...(narrow ? { meetingTranscriptCollapsed: true } : {}),
    },
    { persistUi: true },
  )
}

function closeMeetingRoom() {
  stopMeetingTts()
  resetMeetingTtsSession()
  patchState({ meetingRoomOpen: false, meetingActiveSpeaker: '' })
}

function closePanel() {
  // 关面板时一并收起会议室，避免 meetingRoomOpen 卡住导致悬浮球不出现
  patchState({ isOpen: false, meetingRoomOpen: false, meetingActiveSpeaker: '' }, { persistUi: true })
  syncDockChrome(getState())
  syncShellXiaomiActive(false)
  schedulePoll()
}

function minimizePanel() {
  patchState(
    { isOpen: false, isMinimized: true, meetingRoomOpen: false, meetingActiveSpeaker: '' },
    { persistUi: true },
  )
  syncDockChrome(getState())
  syncShellXiaomiActive(false)
  schedulePoll()
}

/** 确保已有会议；没有则用在职员工创建。 */
async function ensureMeetingCreated(titleHint = 'AI员工聊天') {
  const st = getState()
  if (st.meetingId) {
    return {
      meetingId: st.meetingId,
      participants: st.meetingParticipants || [],
    }
  }
  const agents = (st.agents || []).filter(
    (a) => String(a.status || '') === 'active' && String(a.agent_code || '') !== 'xiaomi',
  )
  const codes = agents.map((a) => a.agent_code)
  if (!codes.length) throw new Error('没有可参会的员工，请先创建智能体员工')
  const res = await createMeeting(codes, String(titleHint || 'AI员工聊天').slice(0, 40))
  const participants = (res.participants || []).map((p) => ({
    agent_code: p.agent_code,
    role_name: p.role_name,
  }))
  patchState({ meetingId: res.meeting_id, meetingParticipants: participants })
  return { meetingId: res.meeting_id, participants }
}

async function startMeetingFlow(topic) {
  let meetingId = getState().meetingId

  // 追加用户消息
  const userMsg = { id: `u-${Date.now()}`, role: 'user', text: topic }
  const baseMsgs = [...(getState().meetingMessages || []), userMsg]
  patchState({
    meetingMessages: baseMsgs,
    meetingTopic: '',
    meetingSending: true,
    meetingError: '',
    meetingCurrentTopic: topic,
    meetingActiveSpeaker: '',
    meetingRoomOpen: true,
    isOpen: true,
    isMinimized: false,
  }, { persistUi: true })

  try {
    const ensured = await ensureMeetingCreated(topic)
    meetingId = ensured.meetingId
  } catch (e) {
    patchState({ meetingSending: false, meetingError: String(e?.message || e), meetingRoomOpen: false })
    toast(String(e?.message || e), 'error')
    return
  }

  // 发起全员讨论
  try {
    _meetingProcessedTasks = new Set()
    _meetingTaskSeenCount = 0
    _meetingPollStart = Date.now()
    const res = await startMeetingDiscussion(meetingId, topic, {
      allowTools: !!getState().meetingAllowTools,
    })
    patchState({ meetingSending: false, meetingPolling: true, meetingTurnId: res.turn_id || '' })
    const topicInputs = _root?.querySelectorAll('[data-meeting-topic]')
    topicInputs?.forEach((el) => {
      if (el instanceof HTMLTextAreaElement) el.value = ''
    })
    startMeetingPoll()
  } catch (e) {
    patchState({ meetingSending: false, meetingError: String(e?.message || e) })
    toast(String(e?.message || e), 'error')
  }
}

/** @returns {string[]} */
function normalizeMentionTargets(raw) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
  const out = []
  const seen = new Set()
  for (const item of list) {
    const code = String(item || '').trim()
    if (!code) continue
    const key = code.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(code)
  }
  return out
}

function mentionRoleName(st, code) {
  const key = String(code || '').trim().toLowerCase()
  return (
    (st.meetingParticipants || []).find(
      (p) => String(p.agent_code || '').toLowerCase() === key,
    )?.role_name ||
    (st.agents || []).find((a) => String(a.agent_code || '').toLowerCase() === key)?.role_name ||
    code
  )
}

/** @returns {string[]} */
function getMentionTargets(st = getState()) {
  return normalizeMentionTargets(st?.meetingMentionTargets)
}

function isMentionSelected(st, code) {
  const key = String(code || '').trim().toLowerCase()
  if (!key) return false
  return getMentionTargets(st).some((c) => c.toLowerCase() === key)
}

function formatMentionNames(st, maxNames = 3) {
  const codes = getMentionTargets(st)
  if (!codes.length) return ''
  const names = codes.map((c) => mentionRoleName(st, c))
  if (names.length <= maxNames) return names.join('、')
  return `${names.slice(0, maxNames).join('、')} 等 ${names.length} 人`
}

function toggleMentionTarget(code) {
  const cur = getMentionTargets()
  const key = String(code || '').trim().toLowerCase()
  if (!key) return []
  const has = cur.some((c) => c.toLowerCase() === key)
  const next = has
    ? cur.filter((c) => c.toLowerCase() !== key)
    : [...cur, String(code).trim()]
  patchState({ meetingMentionTargets: next })
  return next
}

/**
 * 点名一位或多位员工口头汇报（不跑全员轮询顺序；多人时按点名顺序依次发言）。
 * @param {string | string[]} agentCodes
 * @param {string} text
 */
async function startMentionFlow(agentCodes, text) {
  const codes = normalizeMentionTargets(agentCodes)
  const topic = String(text || '').trim()
  if (!codes.length || !topic) return

  const st = getState()
  const named = codes.map((code) => ({
    code,
    roleName: mentionRoleName(st, code),
    placeholderId: `a-mention-${Date.now()}-${code}`,
  }))
  const atLine = named.map((n) => `@${n.roleName}`).join(' ')
  const userMsg = { id: `u-${Date.now()}`, role: 'user', text: `${atLine} ${topic}` }
  const placeholders = named.map((n) => ({
    id: n.placeholderId,
    role: 'agent',
    agent_code: n.code,
    role_name: n.roleName,
    text: '',
    state: 'working',
    streaming: true,
  }))

  patchState({
    meetingMessages: [...(st.meetingMessages || []), userMsg, ...placeholders],
    meetingTopic: '',
    meetingSending: true,
    meetingPolling: true,
    meetingError: '',
    meetingCurrentTopic: topic,
    meetingActiveSpeaker: named[0].code,
    meetingMentionTargets: codes,
    meetingRoomOpen: true,
    isOpen: true,
    isMinimized: false,
  }, { persistUi: true })

  let meetingId = st.meetingId
  try {
    const ensured = await ensureMeetingCreated(topic)
    meetingId = ensured.meetingId
  } catch (e) {
    patchState({
      meetingSending: false,
      meetingPolling: false,
      meetingActiveSpeaker: '',
      meetingError: String(e?.message || e),
    })
    toast(String(e?.message || e), 'error')
    return
  }

  _meetingPollStart = Date.now()
  startMeetingPoll()

  let contextSummary = ''
  try {
    for (let i = 0; i < named.length; i++) {
      const n = named[i]
      patchState({ meetingActiveSpeaker: n.code, meetingSending: true })
      try {
        const res = await mentionMeeting(meetingId, n.code, topic, contextSummary, {
          allowTools: !!getState().meetingAllowTools,
        })
        const reply = formatMeetingReply(String(res?.reply || res?.task?.result_text || '').trim())
        const tid = String(res?.task?.id || res?.task?.task_id || '')
        if (tid) _meetingProcessedTasks.add(tid)

        const cur = getState()
        const msgs = [...(cur.meetingMessages || [])]
        const idx = msgs.findIndex(
          (m) => m.id === n.placeholderId || (m.agent_code === n.code && m.state === 'working'),
        )
        const finalMsg = {
          id: tid ? `a-${tid}` : n.placeholderId,
          role: 'agent',
          agent_code: n.code,
          role_name: n.roleName,
          text: reply || '(无回复)',
          state: reply ? 'completed' : 'failed',
          error: !reply,
        }
        if (idx >= 0) msgs[idx] = finalMsg
        else msgs.push(finalMsg)
        patchState({ meetingMessages: msgs })
        if (reply) {
          contextSummary = `${contextSummary}\n【${n.roleName}】：${reply.slice(0, 120)}`.trim()
          // 只留给后面的人最近两段，避免复读
          const lines = contextSummary.split('\n').filter(Boolean)
          contextSummary = lines.slice(-2).join('\n')
        }
      } catch (e) {
        const cur = getState()
        const msgs = [...(cur.meetingMessages || [])]
        const idx = msgs.findIndex(
          (m) => m.id === n.placeholderId || (m.agent_code === n.code && m.state === 'working'),
        )
        const errText = `（未能发言）${String(e?.message || e)}`
        if (idx >= 0) {
          msgs[idx] = {
            ...msgs[idx],
            text: errText,
            state: 'failed',
            error: true,
            streaming: false,
          }
        }
        patchState({
          meetingMessages: msgs,
          meetingError: String(e?.message || e),
        })
      }
    }

    const cur = getState()
    const msgs = cur.meetingMessages || []
    patchState({
      meetingSending: false,
      meetingActiveSpeaker: '',
    })
    const topicInputs = _root?.querySelectorAll('[data-meeting-topic]')
    topicInputs?.forEach((el) => {
      if (el instanceof HTMLTextAreaElement) el.value = ''
    })
    const stillWorking = msgs.some((m) => m.state === 'working')
    if (!stillWorking) stopMeetingPoll()
  } catch (e) {
    patchState({
      meetingSending: false,
      meetingActiveSpeaker: '',
      meetingError: String(e?.message || e),
    })
    stopMeetingPoll()
    toast(String(e?.message || e), 'error')
  }
}

function startMeetingPoll() {
  if (_meetingPollTimer) clearInterval(_meetingPollTimer)
  _meetingPollTimer = setInterval(async () => {
    const st = getState()
    if (!st.meetingId) {
      stopMeetingPoll()
      return
    }
    // 超时 5 分钟自动停
    if (Date.now() - _meetingPollStart > 300_000) {
      stopMeetingPoll()
      patchState({
        meetingActiveSpeaker: '',
        meetingMessages: [
          ...(st.meetingMessages || []),
          { id: `sys-${Date.now()}`, role: 'system', text: '讨论超时，已停止轮询。' },
        ],
      })
      return
    }
    try {
      const [data, turnsData] = await Promise.all([
        pollMeetingTasks(st.meetingId),
        pollMeetingTurns(st.meetingId).catch(() => null),
      ])
      const tasks = data?.tasks || []
      if (tasks.length > _meetingTaskSeenCount) _meetingTaskSeenCount = tasks.length
      const msgs = [...(st.meetingMessages || [])]
      let changed = false
      let workingCount = 0
      let activeSpeaker = ''
      const turnId = st.meetingTurnId || ''
      const turns = turnsData?.turns || []
      const currentTurn = turnId
        ? turns.find((t) => String(t.turn_id || '') === String(turnId))
        : turns[turns.length - 1]
      const turnDone = String(currentTurn?.status || '') === 'completed'

      for (const task of tasks) {
        const tid = task.task_id
        const state = String(task.state || task.status || '')
        const agentCode = task.agent_code
        const participant = (st.meetingParticipants || []).find((p) => p.agent_code === agentCode)
        const roleName = participant?.role_name || agentCode

        if (state === 'working' || state === 'submitted') {
          workingCount++
          if (!activeSpeaker) activeSpeaker = agentCode
          const existing = msgs.find(
            (m) => m.role === 'agent' && m.agent_code === agentCode && m.state === 'working',
          )
          if (!existing) {
            msgs.push({
              id: `a-${tid}`,
              role: 'agent',
              agent_code: agentCode,
              role_name: roleName,
              text: '',
              state: 'working',
              streaming: true,
            })
            changed = true
          }
        } else if (state === 'completed' || state === 'failed' || state === 'canceled') {
          if (!_meetingProcessedTasks.has(tid)) {
            _meetingProcessedTasks.add(tid)
            // 移除占位消息
            const idx = msgs.findIndex(
              (m) => m.role === 'agent' && m.agent_code === agentCode && m.state === 'working',
            )
            if (idx >= 0) msgs.splice(idx, 1)
            const resultText = formatMeetingReply(String(task.result_text || '').trim())
            const looksBusyFail =
              resultText.includes('正在执行任务') || resultText.includes('未能发言')
            msgs.push({
              id: `a-${tid}`,
              role: 'agent',
              agent_code: agentCode,
              role_name: roleName,
              text: resultText || '(无回复)',
              state,
              error: state === 'failed' || state === 'canceled' || looksBusyFail,
            })
            changed = true
          }
        }
      }

      const patch = {}
      if (changed) patch.meetingMessages = msgs
      if (String(st.meetingActiveSpeaker || '') !== String(activeSpeaker || '')) {
        patch.meetingActiveSpeaker = activeSpeaker
      }
      if (Object.keys(patch).length) patchState(patch)

      // 全部任务终态，或本轮 turn 已完成 -> 停止
      // 方案讨论会有第二轮碰撞：任务数会超过参会人数，必须以 turn.status=completed 为准，
      // 否则第一轮 4 人说完就会提前停轮询。
      const participantCount = (st.meetingParticipants || []).length
      const terminalCount = tasks.filter((t) => {
        const s = String(t.state || t.status || '')
        return s === 'completed' || s === 'failed' || s === 'canceled'
      }).length
      const shouldStop = turnId
        ? turnDone && workingCount === 0 && terminalCount > 0
        : workingCount === 0 &&
          terminalCount > 0 &&
          participantCount > 0 &&
          terminalCount >= participantCount
      if (shouldStop) {
        stopMeetingPoll()
      }

      // 会议室开着但头像未挂上时补挂（轮询无 DOM 变更时也能恢复）
      if (st.meetingRoomOpen) {
        const room = _root?.querySelector('.xm-mroom')
        const naked = room?.querySelector('[data-xm-avatar] .xm-mroom-seat-fallback')
        if (naked && !naked.parentElement?.querySelector(':scope > *:not(.xm-mroom-seat-fallback)')) {
          // fallback 仍在且没有 React 子树时再挂（粗略：仅有 fallback 文本节点/span）
          const host = naked.parentElement
          if (host && host.childElementCount <= 1) mountMeetingRoomAvatars()
        }
      }
    } catch {
      /* 轮询错误静默 */
    }
  }, 2000)
}

function stopMeetingPoll() {
  if (_meetingPollTimer) {
    clearInterval(_meetingPollTimer)
    _meetingPollTimer = null
  }
  patchState({ meetingPolling: false, meetingSending: false, meetingActiveSpeaker: '' })
}

async function runMeetingConclude() {
  const st = getState()
  const mid = String(st.meetingId || '').trim()
  if (!mid) {
    toast('请先发起一场讨论', 'warning')
    return
  }
  if (st.meetingConcluding || st.meetingPolling || st.meetingSending) return
  const hasSpeak = (st.meetingMessages || []).some((m) => m.role === 'agent' && m.state === 'completed')
  if (!hasSpeak) {
    toast('还没有员工发言，稍后再汇总', 'warning')
    return
  }
  patchState({ meetingConcluding: true, meetingError: '' })
  try {
    const res = await concludeMeeting(mid, st.meetingCurrentTopic || st.meetingTopic || '')
    const conclusion = res?.conclusion || null
    patchState({ meetingConcluding: false, meetingConclusion: conclusion })
    const path = String(conclusion?.asset_path || res?.asset?.path || '').trim()
    toast(
      path
        ? `方案已沉淀为文档${conclusion?.summary ? `：${conclusion.summary}` : ''}`
        : conclusion?.summary
          ? `已汇总：${conclusion.summary}`
          : '已汇总最优方案',
      'success',
    )
  } catch (e) {
    patchState({ meetingConcluding: false, meetingError: String(e?.message || e) })
    toast(`汇总失败: ${e?.message || e}`, 'error')
  }
}

function meetingConclusionAssetHref(conclusion) {
  const path = String(conclusion?.asset_path || '').trim().replace(/\\/g, '/').replace(/^\//, '')
  if (!path) return ''
  const params = new URLSearchParams()
  params.set('tab', 'memory')
  params.set('memoryKind', 'episodic')
  params.set('entityType', String(conclusion?.asset_entity_type || 'user'))
  params.set('entityId', String(conclusion?.asset_entity_id || 'user'))
  params.set('path', path)
  return `#/assets?${params.toString()}`
}

function openMeetingConclusionDoc() {
  const st = getState()
  const conclusion = st.meetingConclusion
  const href = meetingConclusionAssetHref(conclusion)
  if (!href) {
    toast('还没有方案文档，请先汇总', 'warning')
    return
  }
  closeMeetingRoom()
  patchState({ isOpen: false, isMinimized: true }, { persistUi: true })
  window.location.hash = href
  toast('已打开方案文档', 'success')
}

/**
 * 页面可见性变化：后台暂停轮询定时器，回前台延迟恢复。
 *
 * 浏览器后台标签会节流 setInterval 到 ~1Hz 但不停止，导致 API 请求堆积。
 * 回到前台时堆积的定时器同时触发，瞬间发出大量请求加剧后端 SQLite 锁竞争。
 * 此函数在 hidden 时清除 _pollTimer / _meetingPollTimer，visible 时延迟 1s 恢复。
 */
let _visibilityPaused = false
let _resumeTimer = null
let _visibilityCleanup = null

function setupVisibilityPause() {
  if (typeof document === 'undefined') return () => {}

  const handleVisibility = () => {
    if (document.visibilityState === 'hidden') {
      // 进入后台：清除所有轮询定时器
      _visibilityPaused = true
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
      if (_meetingPollTimer) { clearInterval(_meetingPollTimer); _meetingPollTimer = null }
    } else if (_visibilityPaused) {
      // 回到前台：延迟 1s 恢复，避免与路由切换/reattach 竞争
      _visibilityPaused = false
      if (_resumeTimer) clearTimeout(_resumeTimer)
      _resumeTimer = setTimeout(() => {
        _resumeTimer = null
        const st = getState()
        // 仅在助手面板打开时恢复 dashboard 轮询
        if (st.isOpen && !st.isMinimized && !shouldHideAssistant()) {
          schedulePoll()
        }
        if (st.meetingId) {
          startMeetingPoll()
        }
      }, 1000)
    }
  }

  document.addEventListener('visibilitychange', handleVisibility)
  return () => {
    document.removeEventListener('visibilitychange', handleVisibility)
    if (_resumeTimer) clearTimeout(_resumeTimer)
  }
}

function schedulePoll() {
  if (_pollTimer) clearInterval(_pollTimer)
  const open = getState().isOpen && !getState().isMinimized
  _pollTimer = setInterval(() => {
    if (shouldHideAssistant()) return
    void refreshDashboard()
  }, open ? 20_000 : 60_000)
}

function openPanel() {
  cancelFabOpenTimer()
  const patch = {
    isOpen: true,
    isMinimized: false,
    contextPinned: true,
    activeView: 'chat',
    selectedContact: 'xiaomi',
  }
  if (getState().fabUserHidden) patch.fabUserHidden = false
  // 侧栏工作栏：收起联系人轨，直接对话
  if (isWorkbenchDock()) {
    patch.sidebarCollapsed = true
  }
  patchState(patch, { persistUi: true })
  syncDockChrome(getState())
  schedulePoll()
  void refreshDashboard()
  void refreshXiaomiObsEnabled()
  void ensureXiaomiSession().then(() => bindXiaomiStreamListener()).catch((e) => {
    toast(String(e?.message || e || '小V会话不可用'), 'warning')
  })
}

/** 唤醒词 / 外部入口：打开全局小V面板 */
export function openGlobalAssistant() {
  if (shouldHideAssistant()) return
  if (!_root || !document.body.contains(_root)) {
    mountGlobalAssistant()
  }
  if (getState().fabUserHidden) {
    patchState({ fabUserHidden: false }, { persistUi: true })
  }
  // 壳层 / 边缘条：优先右侧工作栏
  if (getState().panelLayoutPref === 'float') {
    patchState({ panelLayoutPref: 'auto' }, { persistUi: true, silent: true })
  }
  openPanel()
  patchState({ activeView: 'chat', selectedContact: 'xiaomi' }, { persistUi: true })
  syncShellXiaomiActive(true)
}

function syncShellXiaomiActive(forceOpen) {
  try {
    const btn = document.getElementById('shell-btn-xiaomi')
    if (!btn) return
    const open = forceOpen != null ? !!forceOpen : !!(getState().isOpen && !getState().isMinimized)
    btn.classList.toggle('is-active', open)
    btn.setAttribute('aria-pressed', open ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

/**
 * 语音转写 → 全局小V（不进主对话）
 * @param {string} text
 */
export async function handleXiaomiVoiceTranscript(text) {
  const t = String(text || '').trim()
  if (!t) return
  if (shouldHideAssistant()) throw new Error('当前页面不可用小V')
  if (getState().fabUserHidden) {
    patchState({ fabUserHidden: false }, { persistUi: true })
  }
  openPanel()
  setContactDraft('xiaomi', '', { silent: true })
  patchState({ activeView: 'chat', selectedContact: 'xiaomi', draft: '' }, { persistUi: true })
  await sendXiaomiChat(t, { ...pageContext(), voiceInitiated: true })
}

function fmtSessionRel(ts) {
  const n = Number(ts) || 0
  if (!n) return ''
  try {
    const d = n < 1e12 ? new Date(n * 1000) : new Date(n)
    return fmtRel(d.toISOString())
  } catch {
    return ''
  }
}

function renderHeader(st) {
  const sum = st.summary || {}
  const working = Number(sum.workingAgents || 0)
  const pending = Number(sum.pendingApprovals || 0)
  const statusBits = []
  if (st.partialUnavailable) statusBits.push('部分状态不可用')
  else {
    if (working > 0) statusBits.push(`${working} 人工作中`)
    if (pending > 0) statusBits.push(`${pending} 项待审批`)
  }
  const feishuBound = !!st.feishuBound
  if (feishuBound) statusBits.push('飞书已绑')
  const statusLine = statusBits.length ? statusBits.join(' · ') : '待命'
  const moreOpen = !!st.headerMoreOpen
  const histOpen = !!st.sessionHistoryOpen
  const docked = resolvePanelLayout(st) === 'dock'
  const guide = isWorkbenchDock(st)
  const ctx = pageContext()
  const title = guide ? '小V 协助' : '小V'
  const sub = guide
    ? ctx.label
      ? `当前：${ctx.label}`
      : '右侧协助 · 随时待命'
    : statusLine
  const curKey = String(st.sessionKey || '')
  const sessions = Array.isArray(st.xiaomiSessions) ? st.xiaomiSessions : []
  const histItems = st.xiaomiSessionsLoading
    ? `<div class="xm-history-empty">加载中…</div>`
    : sessions.length
      ? sessions
          .map((s) => {
            const active = s.key === curKey
            const when = fmtSessionRel(s.updatedAt)
            return `<button type="button" class="xm-history-item${active ? ' is-active' : ''}" role="menuitem" data-act="select-session" data-session="${esc(s.key)}" title="${esc(s.title)}">
              <span class="xm-history-item-title">${esc(s.title)}</span>
              <span class="xm-history-item-meta">${when ? esc(when) : '—'}${s.messageCount ? ` · ${s.messageCount} 条` : ''}</span>
            </button>`
          })
          .join('')
      : `<div class="xm-history-empty">暂无历史对话</div>`
  const iconHistory = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`
  const iconPlus = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`
  const iconDebug = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>`
  const debugOn = st.activeView === 'debug'
  const showDebug = !!st.obsEnabled
  return `
    <header class="xm-header${guide ? ' xm-header--workbench' : ''}">
      <div class="xm-header-id">
        <div class="xm-header-text">
          <div class="xm-title-row">
            <span class="xm-title">${esc(title)}</span>
            <span class="xm-status-line">${esc(sub)}</span>
          </div>
        </div>
      </div>
      <div class="xm-header-actions">
        <div class="xm-history${histOpen ? ' is-open' : ''}">
          <button type="button" class="xm-icon-btn" data-act="toggle-session-history" title="历史对话" aria-label="历史对话" aria-expanded="${histOpen ? 'true' : 'false'}">${iconHistory}</button>
        </div>
        <button type="button" class="xm-icon-btn" data-act="new-chat" title="新开对话" aria-label="新开对话">${iconPlus}</button>
        ${
          showDebug
            ? `<button type="button" class="xm-icon-btn${debugOn ? ' is-active' : ''}" data-act="open-debug" title="调试" aria-label="调试" aria-pressed="${debugOn ? 'true' : 'false'}">${iconDebug}</button>`
            : ''
        }
        <div class="xm-more${moreOpen ? ' is-open' : ''}">
          <button type="button" class="xm-icon-btn" data-act="toggle-header-more" title="更多" aria-label="更多" aria-expanded="${moreOpen ? 'true' : 'false'}">⋯</button>
          <div class="xm-more-menu" role="menu"${moreOpen ? '' : ' hidden'}>
            <button type="button" class="xm-more-item" role="menuitem" data-act="open-chat-view">对话</button>
            ${showDebug ? `<button type="button" class="xm-more-item" role="menuitem" data-act="open-debug">调试</button>` : ''}
            <button type="button" class="xm-more-item" role="menuitem" data-act="open-dashboard">工作台</button>
            <button type="button" class="xm-more-item" role="menuitem" data-act="open-meeting">会议室</button>
            <button type="button" class="xm-more-item" role="menuitem" data-act="new-round">新开轮次</button>
            <button type="button" class="xm-more-item" role="menuitem" data-act="open-main-chat">在主对话打开</button>
            <button type="button" class="xm-more-item" role="menuitem" data-act="stop-tts">停止播报</button>
            <button type="button" class="xm-more-item" role="menuitem" data-act="pause-listen">暂停监听</button>
            ${
              feishuBound
                ? `<button type="button" class="xm-more-item" role="menuitem" data-act="feishu-unbind">解绑飞书</button>`
                : `<button type="button" class="xm-more-item" role="menuitem" data-act="feishu-bind">绑定飞书</button>`
            }
            <button type="button" class="xm-more-item" role="menuitem" data-act="refresh">刷新</button>
            <button type="button" class="xm-more-item" role="menuitem" data-act="toggle-layout">${docked ? '改为悬浮窗' : '改为右侧栏'}</button>
          </div>
        </div>
        ${
          docked
            ? ''
            : `<button type="button" class="xm-icon-btn" data-act="expand" title="${st.isExpanded ? '还原' : '展开'}" aria-label="${st.isExpanded ? '还原' : '展开'}">${st.isExpanded ? '⛶' : '⤢'}</button>`
        }
        <button type="button" class="xm-icon-btn" data-act="minimize" title="收起" aria-label="收起">—</button>
        <button type="button" class="xm-icon-btn" data-act="close" title="关闭" aria-label="关闭">×</button>
      </div>
      ${
        histOpen
          ? `<div class="xm-history-menu" role="menu">
            <div class="xm-history-menu-head">历史对话</div>
            <div class="xm-history-menu-list">${histItems}</div>
          </div>`
          : ''
      }
    </header>`
}

function renderDashboard(st) {
  const sum = st.summary || {}
  const greet = greetingByHour()
  const need = Number(st.badgeCount || 0)
  const ctx = pageContext()

  const stats = [
    ['工作中', sum.workingAgents || 0],
    ['进行中', sum.executingTasks || 0],
    ['受阻/失败', sum.blockedTasks || 0],
    ['待审批', sum.pendingApprovals || 0],
    ['待你输入', sum.waitingUser || 0],
    ['今日完成', sum.completedToday || 0],
  ]

  const attention = (st.attentionItems || [])
    .map(
      (it) => `
      <article class="xm-card" data-attention-id="${esc(it.id)}">
        <div class="xm-card-top">
          <span class="xm-chip xm-chip--warn">${esc(it.typeLabel)}</span>
          <span class="xm-muted">${esc(fmtRel(it.updatedAt))}</span>
        </div>
        <div class="xm-card-title">${esc(it.title)}</div>
        <div class="xm-muted">负责人：${esc(it.owner || '—')}</div>
        <div class="xm-card-desc">${esc(it.reason)}</div>
        <div class="xm-card-actions">
          <button type="button" class="btn btn-sm btn-primary" data-act="attention-primary" data-id="${esc(it.id)}">查看</button>
          ${
            it.secondaryAction === 'request_update' && it.agentCode
              ? `<button type="button" class="btn btn-sm btn-outline" data-act="request-update" data-code="${esc(it.agentCode)}" data-task="${esc(it.taskId || '')}">请求更新</button>`
              : ''
          }
        </div>
      </article>`,
    )
    .join('')

  const active = (st.activeTasks || [])
    .map(
      (t) => `
      <button type="button" class="xm-list-row" data-act="open-task" data-task="${esc(t.id)}">
        <div class="xm-list-title">${esc(t.name)}</div>
        <div class="xm-muted">${esc(t.owner || '')} · ${esc(t.status)}${t.progressSummary ? ` · ${esc(t.progressSummary)}` : ''}</div>
        <div class="xm-muted">${esc(fmtRel(t.lastUpdatedAt))}</div>
      </button>`,
    )
    .join('')

  const done = (st.recentCompletions || [])
    .map(
      (t) => `
      <button type="button" class="xm-list-row" data-act="open-task" data-task="${esc(t.id)}">
        <div class="xm-list-title">${esc(t.name)}</div>
        <div class="xm-muted">${esc(t.owner || '')} · ${esc(t.status)} · ${esc(fmtRel(t.completedAt))}</div>
      </button>`,
    )
    .join('')

  const sug = (st.suggestedActions || [])
    .map(
      (s) => `
      <article class="xm-card xm-card--sug">
        <div class="xm-card-desc">${esc(s.text)}</div>
        <div class="xm-card-actions">
          <button type="button" class="btn btn-sm btn-primary" data-act="sug-primary" data-id="${esc(s.id)}">${esc(s.primaryLabel || '执行')}</button>
          ${s.secondaryLabel ? `<button type="button" class="btn btn-sm btn-outline" data-act="sug-secondary" data-id="${esc(s.id)}">${esc(s.secondaryLabel)}</button>` : ''}
        </div>
      </article>`,
    )
    .join('')

  return `
    <div class="xm-body xm-dashboard">
      <p class="xm-greet">${esc(greet)}。${need > 0 ? `目前有 ${need} 项需要你关注。` : '目前没有紧急事项。'}</p>
      ${ctx.label ? `<div class="xm-context">正在查看：${esc(ctx.label)} <button type="button" class="xm-context-x" data-act="clear-context" aria-label="移除上下文">×</button></div>` : ''}
      <section class="xm-section">
        <h3>今日概览</h3>
        <div class="xm-stats">${stats.map(([k, v]) => `<div class="xm-stat"><div class="xm-stat-n">${v}</div><div class="xm-stat-l">${esc(k)}</div></div>`).join('')}</div>
      </section>
      <section class="xm-section">
        <h3>需要关注</h3>
        ${attention || `<p class="xm-empty">目前没有需要你处理的事项</p>`}
      </section>
      <section class="xm-section">
        <h3>正在执行</h3>
        ${active || `<p class="xm-empty">目前没有进行中的任务 <button type="button" class="btn btn-sm btn-outline" data-act="open-delegate">委派一个任务</button></p>`}
      </section>
      <section class="xm-section">
        <h3>刚刚完成</h3>
        ${done || `<p class="xm-empty">今日暂无完成项</p>`}
      </section>
      <section class="xm-section">
        <h3>建议推进</h3>
        ${sug || `<p class="xm-empty">暂无建议</p>`}
      </section>
      <section class="xm-section">
        <h3>快捷操作</h3>
        <div class="xm-quick">
          <button type="button" class="xm-quick-btn" data-act="quick-report">今日汇报</button>
          <button type="button" class="xm-quick-btn" data-act="open-agents-rail">员工进度</button>
          <button type="button" class="xm-quick-btn" data-act="quick-blocked">待推进</button>
          <button type="button" class="xm-quick-btn" data-act="quick-approvals">待我审批</button>
          <button type="button" class="xm-quick-btn" data-act="quick-knowledge">问知识库</button>
          <button type="button" class="xm-quick-btn" data-act="open-delegate">委派任务</button>
        </div>
      </section>
    </div>`
}

function renderChat(st) {
  const tips = moduleGuideSuggestions()
  const tipHtml = tips.length
    ? `<div class="xm-guide-chips" role="list">
          ${tips
            .map(
              (tip) =>
                `<button type="button" class="xm-guide-chip" role="listitem" data-act="guide-prompt" data-prompt="${esc(tip.prompt)}">${esc(tip.label)}</button>`,
            )
            .join('')}
        </div>`
    : ''
  return `
    <div class="xm-body xm-chat${isWorkbenchDock(st) ? ' xm-chat--guide' : ''}">
      ${
        isWorkbenchDock(st)
          ? ''
          : `<div class="xm-thread-head">
        <div class="xm-thread-head-id">
          <span class="xm-thread-head-title">小V</span>
          <span class="xm-thread-head-sub">全局助手</span>
        </div>
        <div class="xm-thread-head-actions">
          <button type="button" class="xm-thread-chip" data-act="open-agents-rail">问进度</button>
          <button type="button" class="xm-thread-chip" data-act="open-delegate">派活</button>
          <button type="button" class="xm-thread-chip" data-act="nav" data-href="/knowledge">知识库</button>
        </div>
      </div>`
      }
      ${tipHtml}
      <div class="xm-chat-scroll xm-chat-scroll--react" data-chat-scroll>
        <div class="xm-react-thread-host" data-xm-react-thread></div>
      </div>
    </div>`
}

function syncXiaomiReactThreadMount() {
  const host = _root?.querySelector('[data-xm-react-thread]')
  if (!(host instanceof HTMLElement)) {
    unmountXiaomiChatThread()
    return
  }
  mountXiaomiChatThread(host, { sessionKey: String(getState().sessionKey || '') })
}

/** 调试页「当前页面上下文」表行（与 renderDebug 共用，便于原地刷新） */
function buildDebugPageContextRows(st) {
  const snap = collectXiaomiPageSnapshot()
  const fp = fingerprintXiaomiPageSnap(snap)
  let lastFp = ''
  try {
    const key = String(st.sessionKey || '').trim()
    if (key) lastFp = String(wsClient.getSessionContext(key)?.xiaomi_page_context_fp || '').trim()
  } catch {
    lastFp = ''
  }
  const ui = snap.ui && typeof snap.ui === 'object' ? snap.ui : {}
  const selected =
    Array.isArray(ui.selected) && ui.selected.length
      ? ui.selected
          .map((s) => {
            if (s && typeof s === 'object') return String(s.label || s.id || '')
            return String(s || '')
          })
          .filter(Boolean)
          .join('；')
      : ''
  return [
    ['模块', snap.module || '—'],
    ['页面', snap.label || '—'],
    ['路由', snap.route || '—'],
    ['类型', snap.contextType || '—'],
    ['实体', snap.contextId || '—'],
    ['标题', ui.pageTitle || '—'],
    ['Tab', Array.isArray(ui.activeTabs) && ui.activeTabs.length ? ui.activeTabs.join('、') : '—'],
    ['已选', selected || '—'],
    ['指纹', fp || '—'],
    ['上次已发指纹', lastFp || '（尚未发送）'],
    ['本轮是否会附带', !lastFp || fp !== lastFp ? '是（页面有变化）' : '否（与上次相同）'],
  ]
}

function renderDebugPageContextTbodyHtml(st) {
  return buildDebugPageContextRows(st)
    .map(
      ([k, v]) =>
        `<tr><th scope="row">${esc(k)}</th><td><code>${esc(v)}</code></td></tr>`,
    )
    .join('')
}

/** 保留 SessionDebugPane 根时，只刷新页面上下文表，避免详情弹窗被整段 body 重绘冲掉 */
function patchDebugPageContextTable(bodySlot, st) {
  const tbody = bodySlot?.querySelector?.('.xm-debug-table tbody')
  if (!(tbody instanceof HTMLElement)) return
  tbody.innerHTML = renderDebugPageContextTbodyHtml(st)
}

function renderDebug(st) {
  const tableRows = renderDebugPageContextTbodyHtml(st)
  return `
    <div class="xm-body xm-debug">
      <div class="xm-debug-toolbar">
        <button type="button" class="btn btn-sm btn-outline" data-act="open-chat-view">← 返回对话</button>
        <button type="button" class="btn btn-sm btn-outline" data-act="debug-refresh">刷新</button>
      </div>
      <section class="xm-debug-section">
        <h3>当前页面上下文</h3>
        <p class="xm-muted">发给小V 时附带的页面快照（指纹不变则本轮不重复注入）。</p>
        <div class="xm-debug-table-wrap">
          <table class="xm-debug-table">
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </section>
      <section class="xm-debug-section xm-debug-session">
        <h3>模型调用</h3>
        <div class="xm-debug-session-host" data-xm-session-debug></div>
      </section>
    </div>`
}

function syncXiaomiSessionDebugMount() {
  const host = _root?.querySelector('[data-xm-session-debug]')
  if (!(host instanceof HTMLElement)) {
    unmountXiaomiSessionDebug()
    return
  }
  const key = String(getState().sessionKey || '').trim()
  const threadId = key ? String(wsClient.getSessionThreadId?.(key) || '').trim() : ''
  mountXiaomiSessionDebug(host, {
    threadId,
    isRunning: !!getState().streaming,
  })
}

/** 与主对话侧栏「调试」同源：Gateway 运维观测开关 */
async function refreshXiaomiObsEnabled() {
  try {
    const { checkObsEnabled } = await import('../../react/obs/lib/obs-api.js')
    const enabled = await checkObsEnabled()
    const on = !!enabled
    const cur = getState()
    const patch = { obsEnabled: on }
    if (!on && cur.activeView === 'debug') {
      patch.activeView = 'chat'
      patch.selectedContact = 'xiaomi'
    }
    patchState(patch, { silent: cur.obsEnabled === on && cur.activeView !== 'debug' })
  } catch {
    const cur = getState()
    if (cur.obsEnabled || cur.activeView === 'debug') {
      patchState(
        {
          obsEnabled: false,
          ...(cur.activeView === 'debug' ? { activeView: 'chat', selectedContact: 'xiaomi' } : {}),
        },
        { silent: false },
      )
    } else {
      patchState({ obsEnabled: false }, { silent: true })
    }
  }
}

function renderTaskCard(t, { showProgress = false } = {}) {
  const pct = Math.max(0, Math.min(100, Number(t.progress) || 0))
  const body = t.summary || t.result || ''
  const group = toTaskStatusGroup(t.statusRaw || t.status)
  const chipMod =
    group === 'completed'
      ? ' xm-chip--ok'
      : group === 'failed'
        ? ' xm-chip--err'
        : group === 'executing' || group === 'planning'
          ? ' xm-chip--run'
          : group === 'paused'
            ? ' xm-chip--warn'
            : ''
  return `
      <article class="xm-task-card" data-act="open-task" data-task="${esc(t.id)}">
        <div class="xm-task-card-top">
          <div class="xm-task-card-title">${esc(t.name)}</div>
          <span class="xm-chip xm-chip--status${chipMod}">${esc(t.status)}</span>
        </div>
        <div class="xm-muted">${showProgress ? `${pct}%${t.progressSummary ? ` · ${esc(t.progressSummary)}` : ''} · ` : ''}${esc(fmtRel(t.updatedAt) || '—')}</div>
        ${showProgress ? `<div class="xm-task-progress" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ''}
        ${!showProgress && body ? `<div class="xm-task-report">${esc(body)}</div>` : ''}
      </article>`
}

function renderEmployeeThread(st) {
  const code = resolveSelectedContact(st)
  const agent = findAgent(code)
  const name = agent?.role_name || code
  const busy = Boolean(st.employeeThread?.code === code ? st.employeeThread?.busy : agent?.busy)
  const stLabel = WORK_STATUS_LABEL[agent?.workStatus] || (busy ? '工作中' : '空闲')
  const thread = st.employeeThread?.code === code ? st.employeeThread : null
  const openTasks = thread?.openTasks || []
  const recentReports = thread?.recentReports || thread?.reports || []
  const historyReports = thread?.historyReports || []
  const localMsgs = ((st.employeeLocalMsgs || {})[code] || []).slice(-8)

  const openHtml = openTasks.map((t) => renderTaskCard(t, { showProgress: true })).join('')
  const recentHtml = recentReports.map((t) => renderTaskCard(t)).join('')
  const historyHtml = historyReports.map((t) => renderTaskCard(t)).join('')
  const localHtml = localMsgs
    .map(
      (m) => `
      <div class="xm-msg xm-msg--user xm-msg--delegate">
        <div>${esc(m.text)}</div>
        <div class="xm-muted xm-msg-time">${esc(fmtRel(m.ts) || '')}</div>
      </div>`,
    )
    .join('')

  const historyBlock = historyReports.length
    ? `<details class="xm-history-fold">
        <summary>历史完成 · ${historyReports.length} 条</summary>
        <div class="xm-history-fold-body">${historyHtml}</div>
      </details>`
    : ''

  return `
    <div class="xm-body xm-emp-thread">
      <div class="xm-thread-head">
        <div class="xm-thread-head-id">
          <span class="xm-thread-head-title">${esc(name)}</span>
          <span class="xm-thread-head-sub">${esc(stLabel)}${agent?.department ? ` · ${esc(agent.department)}` : ''}</span>
        </div>
        <div class="xm-thread-head-actions">
          <button type="button" class="xm-thread-chip" data-act="open-employee-trail" data-code="${esc(code)}">过程</button>
          <button type="button" class="xm-thread-chip" data-act="request-update" data-code="${esc(code)}">进度</button>
          <button type="button" class="xm-thread-chip" data-act="open-employee" data-code="${esc(code)}">详情</button>
        </div>
      </div>
      <div class="xm-emp-scroll" data-emp-scroll>
        ${historyBlock}
        <section class="xm-section">
          <h3>进行中</h3>
          ${openHtml || `<p class="xm-empty">暂无进行中任务。在下方输入目标即可委派。</p>`}
        </section>
        <section class="xm-section">
          <h3>本轮委派</h3>
          ${localHtml || `<p class="xm-empty">还没有本轮委派记录</p>`}
        </section>
        <section class="xm-section">
          <h3>最新汇报</h3>
          ${recentHtml || `<p class="xm-empty">完成后汇报会出现在这里</p>`}
        </section>
      </div>
    </div>`
}

function renderContactRail(st) {
  const contact = resolveSelectedContact(st)
  const employees = (st.agents || []).filter(
    (a) => String(a.agent_code || '') !== 'xiaomi' && String(a.status || '') !== 'archived',
  )
  const xiaomiActive = contact === 'xiaomi'
  const rows = employees
    .map((a) => {
      const code = String(a.agent_code || '')
      const active = contact === code
      const label = WORK_STATUS_LABEL[a.workStatus] || (a.busy ? '工作中' : '空闲')
      const title = a.role_name || code
      return `
      <button type="button" class="xm-contact${active ? ' is-active' : ''}" data-act="select-contact" data-code="${esc(code)}" title="${esc(title)} · ${esc(label)}">
        <span class="xm-contact-avatar-wrap">
          <span class="xm-contact-avatar" data-xm-avatar="${esc(code)}" data-avatar-size="${RAIL_AVATAR_SIZE}" aria-hidden="true"></span>
          ${a.busy ? '<span class="xm-contact-busy" title="工作中"></span>' : ''}
        </span>
        <span class="xm-contact-meta">
          <span class="xm-contact-name">${esc(title)}</span>
          <span class="xm-contact-sub">${esc(label)}</span>
        </span>
      </button>`
    })
    .join('')

  return `
    <aside class="xm-rail" data-xm-rail aria-label="联系人">
      <div class="xm-rail-head">
        <span class="xm-rail-title">联系人</span>
      </div>
      <div class="xm-rail-list">
        <button type="button" class="xm-contact${xiaomiActive ? ' is-active' : ''}" data-act="select-contact" data-code="xiaomi" title="小V">
          <span class="xm-contact-avatar-wrap">
            <span class="xm-contact-avatar" data-xm-avatar="xiaomi" data-avatar-size="${RAIL_AVATAR_SIZE}" aria-hidden="true"></span>
          </span>
          <span class="xm-contact-meta">
            <span class="xm-contact-name">小V</span>
            <span class="xm-contact-sub">全局助手</span>
          </span>
        </button>
        ${rows || `<p class="xm-empty xm-rail-empty">暂无员工</p>`}
      </div>
    </aside>`
}

function renderAgents(_st) {
  // 兼容旧入口：渲染期已跳转到 chat + 选中联系人
  return renderChat(_st)
}

function renderDelegate(_st) {
  return renderEmployeeThread(_st)
}

function renderMeeting(st) {
  const participants = st.meetingParticipants || []
  const names = participants.map((p) => esc(p.role_name || p.agent_code)).join('、')
  const hasMeeting = !!st.meetingId
  const roomOpen = !!st.meetingRoomOpen
  const statusBadge = st.meetingPolling
    ? '<span class="xm-chip xm-chip--warn">讨论中…</span>'
    : st.meetingSending
      ? '<span class="xm-chip">发起中…</span>'
      : hasMeeting
        ? '<span class="xm-chip">会议已创建</span>'
        : ''
  const previewSeats = (participants.length
    ? participants
    : (st.agents || [])
        .filter((a) => String(a.status || '') === 'active' && String(a.agent_code || '') !== 'xiaomi')
        .slice(0, 8)
        .map((a) => ({ agent_code: a.agent_code, role_name: a.role_name }))
  )
    .slice(0, 8)
    .map(
      (p) => `
      <span class="xm-meeting-preview-seat" title="${esc(p.role_name || p.agent_code)}">
        <span class="xm-meeting-preview-avatar" data-xm-avatar="${esc(p.agent_code)}" data-avatar-size="28"></span>
      </span>`,
    )
    .join('')

  return `
    <div class="xm-body xm-meeting">
      <div class="xm-meeting-hero">
        <div class="xm-meeting-table-preview" aria-hidden="true">
          <div class="xm-meeting-table-disk"></div>
          <div class="xm-meeting-preview-ring">${previewSeats || '<span class="xm-muted">暂无员工</span>'}</div>
        </div>
        <div class="xm-meeting-hero-copy">
          <h3 class="xm-meeting-hero-title">AI员工会议室</h3>
          <p class="xm-meeting-hero-desc">丢入需求或方案，多名员工圆桌表态互评；讨论结束后一键汇总并沉淀为可打开的方案文档。</p>
          <div class="xm-meeting-header">
            ${
              hasMeeting
                ? `<span class="xm-muted">参会：${names || '-'}</span> ${statusBadge}`
                : '<span class="xm-muted">还没有进行中的会议</span>'
            }
          </div>
          <div class="xm-meeting-hero-actions">
            ${
              roomOpen
                ? `<button type="button" class="btn btn-sm btn-primary" data-act="meeting-room-focus">回到聊天室</button>`
                : `<button type="button" class="btn btn-sm btn-primary" data-act="meeting-room-open"${hasMeeting || participants.length || (st.agents || []).length ? '' : ' disabled'}>进入聊天室</button>`
            }
            ${
              hasMeeting && (st.meetingMessages || []).some((m) => m.role === 'agent' && m.state === 'completed')
                ? `<button type="button" class="btn btn-sm btn-outline" data-act="meeting-conclude"${st.meetingConcluding || st.meetingPolling || st.meetingSending ? ' disabled' : ''} title="综合本场发言，沉淀为方案文档">${st.meetingConcluding ? '汇总中…' : '汇总并沉淀'}</button>`
                : ''
            }
            ${
              hasMeeting
                ? `<button type="button" class="btn btn-sm btn-outline" data-act="meeting-reset" title="结束当前会议，下次重新创建">结束会议</button>`
                : ''
            }
          </div>
        </div>
      </div>
      <div class="xm-meeting-scroll" data-meeting-scroll>
        ${
          st.meetingConclusion
            ? `<div class="xm-msg xm-msg--system xm-meeting-conclusion">
                <div><strong>方案文档</strong>${st.meetingConclusion.summary ? ` · ${esc(st.meetingConclusion.summary)}` : ''}${st.meetingConclusion.asset_path ? ` · 已沉淀` : ''}</div>
                <div class="xm-meeting-conclusion-plan">${esc(st.meetingConclusion.plan || '')}</div>
                <div class="xm-meeting-conclusion-actions">
                  <button type="button" class="btn btn-sm btn-primary" data-act="meeting-open-doc"${st.meetingConclusion.asset_path ? '' : ' disabled'} title="${st.meetingConclusion.asset_path ? esc(st.meetingConclusion.asset_path) : '尚未写入文档'}">打开方案文档</button>
                </div>
              </div>`
            : ''
        }
        ${
          (st.meetingMessages || []).length
            ? (st.meetingMessages || [])
                .map((m) => {
                  if (m.role === 'user') {
                    return `<div class="xm-msg xm-msg--user">${esc(m.text)}</div>`
                  }
                  if (m.role === 'system') {
                    return `<div class="xm-msg xm-msg--system">${esc(m.text)}</div>`
                  }
                  const pending = m.state === 'working' || m.streaming
                  const cursor = pending ? '<span class="xm-cursor">▍</span>' : ''
                  const errorMark = m.error ? ' xm-msg--error' : ''
                  const speaking =
                    st.meetingActiveSpeaker && m.agent_code === st.meetingActiveSpeaker
                      ? ' xm-msg--speaking'
                      : ''
                  return `<div class="xm-msg xm-msg--meeting${errorMark}${speaking}">
                    <span class="xm-msg-speaker">${esc(m.role_name || m.agent_code || '')}${m.error ? '⚠' : pending ? ' · 汇报中' : ''}</span>
                    <span class="xm-msg-text">${esc(m.text || (pending ? '准备汇报…' : ''))}${cursor}</span>
                  </div>`
                })
                .join('')
            : `<p class="xm-empty">在下方输入话题并「发起讨论」，将打开全屏 AI员工聊天室。<br/>发言员工会高亮，其他人听汇报。</p>`
        }
      </div>
    </div>`
}

function renderMeetingComposer(st) {
  if (!st.isOpen || st.activeView !== 'meeting') return ''
  const sending = st.meetingSending || st.meetingPolling
  return `
    <footer class="xm-composer xm-meeting-composer">
      <textarea class="xm-composer-input" data-meeting-topic rows="2" placeholder="输入需求/方案或同步话题，回车发起圆桌…">${esc(st.meetingTopic || '')}</textarea>
      <div class="xm-composer-bar">
        <label class="xm-meeting-tools-toggle" title="开启后员工可短时查任务/资产再发言（只读）">
          <input type="checkbox" data-act="meeting-toggle-tools" ${st.meetingAllowTools ? 'checked' : ''} ${sending ? 'disabled' : ''} />
          允许查证
        </label>
        <span class="xm-muted xm-meeting-hint">${st.meetingAllowTools ? '查证圆桌 · 依次发言' : '口头圆桌 · 依次发言'}</span>
        ${
          sending
            ? `<button type="button" class="btn btn-sm btn-outline" data-act="meeting-stop" title="停止轮询">停止</button>`
            : `<button type="button" class="btn btn-sm btn-primary" data-act="meeting-send">发起讨论</button>`
        }
      </div>
    </footer>`
}

function renderMeetingRoomMessages(st) {
  const msgs = st.meetingMessages || []
  if (!msgs.length) {
    return `<p class="xm-mroom-empty">讨论开始后，这里会实时滚动发言。</p>`
  }
  return msgs
    .map((m) => {
      if (m.role === 'user') {
        return `<div class="xm-mroom-log xm-mroom-log--host">
          <div class="xm-mroom-log-avatar xm-mroom-log-avatar--host" aria-hidden="true">你</div>
          <div class="xm-mroom-log-main">
            <div class="xm-mroom-log-meta">
              <span class="xm-mroom-log-who">主持人</span>
            </div>
            <div class="xm-mroom-log-text">${esc(m.text)}</div>
          </div>
        </div>`
      }
      if (m.role === 'system') {
        return `<div class="xm-mroom-log xm-mroom-log--sys">${esc(m.text)}</div>`
      }
      const pending = m.state === 'working' || m.streaming
      const active = st.meetingActiveSpeaker && m.agent_code === st.meetingActiveSpeaker
      const code = m.agent_code || ''
      const name = m.role_name || code || ''
      const cls = [
        'xm-mroom-log',
        pending || active ? 'xm-mroom-log--live' : '',
        m.error ? 'xm-mroom-log--err' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `<div class="${cls}" data-mroom-log="${esc(code)}">
        <div class="xm-mroom-log-avatar" data-xm-avatar="${esc(code)}" data-avatar-size="36">
          <span class="xm-mroom-seat-fallback" aria-hidden="true">${esc(seatInitial(name))}</span>
        </div>
        <div class="xm-mroom-log-main">
          <div class="xm-mroom-log-meta">
            <span class="xm-mroom-log-who">${esc(name)}</span>
            ${pending ? '<span class="xm-mroom-log-role">发言中</span>' : ''}
          </div>
          <div class="xm-mroom-log-text">${esc(m.text || (pending ? '正在思考并发言…' : ''))}${pending ? '<span class="xm-cursor">▍</span>' : ''}</div>
        </div>
      </div>`
    })
    .join('')
}

function renderMeetingRoomSpeech(st) {
  const code = st.meetingActiveSpeaker
  if (!code) {
    if (st.meetingPolling || st.meetingSending) {
      return `<div class="xm-mroom-speech xm-mroom-speech--wait">
        <div class="xm-mroom-speech-label">圆桌进行中</div>
        <div class="xm-mroom-speech-body">正在请下一位 AI 发言…</div>
      </div>`
    }
    if ((st.meetingMessages || []).some((m) => m.role === 'agent' && m.state === 'completed')) {
      return `<div class="xm-mroom-speech xm-mroom-speech--done">
        <div class="xm-mroom-speech-label">本轮讨论结束</div>
        <div class="xm-mroom-speech-body">在下方继续追问，或切换录屏模式开始创作。</div>
      </div>`
    }
    return `<div class="xm-mroom-speech xm-mroom-speech--idle">
      <div class="xm-mroom-speech-label">等待开场</div>
      <div class="xm-mroom-speech-body">输入一个话题，让圆桌 AI 开始辩论式讨论。</div>
    </div>`
  }
  const p = (st.meetingParticipants || []).find((x) => x.agent_code === code)
  const live = (st.meetingMessages || []).find(
    (m) => m.role === 'agent' && m.agent_code === code && (m.state === 'working' || m.streaming),
  )
  const name = p?.role_name || code
  const raw = live?.text || ''
  const thinking = !raw.trim()
  const text = thinking ? '正在组织观点…' : speechExcerpt(raw, 140)
  return `<div class="xm-mroom-speech xm-mroom-speech--live">
    <div class="xm-mroom-speech-avatar" data-xm-avatar="${esc(code)}" data-avatar-size="48">
      <span class="xm-mroom-seat-fallback" aria-hidden="true">${esc(seatInitial(name))}</span>
    </div>
    <div class="xm-mroom-speech-main">
      <div class="xm-mroom-speech-label"><span class="xm-mroom-pulse"></span>${esc(name)} · ${thinking ? 'Thinking' : 'Speaking'}</div>
      <div class="xm-mroom-speech-body">${esc(text)}${!thinking ? '<span class="xm-cursor">▍</span>' : ''}</div>
    </div>
  </div>`
}

function renderSeatCaption(st, agentCode, status) {
  if (status !== 'speaking' && status !== 'thinking') return ''
  const live = (st.meetingMessages || []).find(
    (m) => m.role === 'agent' && m.agent_code === agentCode && (m.state === 'working' || m.streaming),
  )
  const excerpt = speechExcerpt(live?.text || '', 88)
  if (status === 'thinking' || !excerpt) {
    return `<div class="xm-mroom-caption xm-mroom-caption--think" aria-hidden="true"><span></span><span></span><span></span></div>`
  }
  return `<div class="xm-mroom-caption" aria-hidden="true">「${esc(excerpt)}」</div>`
}

function renderMeetingRoomSeats(st) {
  const participants = st.meetingParticipants || []
  const previewPool =
    participants.length > 0
      ? participants
      : (st.agents || [])
          .filter((a) => String(a.status || '') === 'active' && String(a.agent_code || '') !== 'xiaomi')
          .map((a) => ({ agent_code: a.agent_code, role_name: a.role_name }))
  const slots = meetingSeatLayout(previewPool.length)
  const hasActive = !!st.meetingActiveSpeaker
  const seats = previewPool
    .map((p, i) => {
      const slot = slots[i] || { x: 50, y: 20 }
      const left = Number(slot.x).toFixed(2)
      const top = Number(slot.y).toFixed(2)
      const status = meetingSpeakerState(st, p.agent_code)
      const selected = isMentionSelected(st, p.agent_code)
      const dim = hasActive && status !== 'speaking' && status !== 'thinking'
      const avatarSize = status === 'speaking' ? MROOM_AVATAR_SPEAKING : MROOM_AVATAR_SIZE
      const name = p.role_name || p.agent_code
      return `<div class="xm-mroom-seat is-${status}${selected ? ' is-selected' : ''}${dim ? ' is-dimmed' : ''}" data-mroom-seat="${esc(p.agent_code)}" data-act="meeting-select" style="--home-x:${left}%;--home-y:${top}%" title="点击多选点名：${esc(name)}">
        <div class="xm-mroom-seat-card">
          <div class="xm-mroom-seat-ring" aria-hidden="true"></div>
          <div class="xm-mroom-seat-avatar" data-xm-avatar="${esc(p.agent_code)}" data-avatar-size="${avatarSize}">
            <span class="xm-mroom-seat-fallback" aria-hidden="true">${esc(seatInitial(name))}</span>
          </div>
          <div class="xm-mroom-seat-name">${esc(name)}</div>
          <div class="xm-mroom-seat-status" data-status="${status}">
            <span class="xm-mroom-status-dot" aria-hidden="true"></span>
            ${esc(meetingStatusLabel(status, selected))}
          </div>
        </div>
        ${renderSeatCaption(st, p.agent_code, status)}
      </div>`
    })
    .join('')

  return `${seats}
    <div class="xm-mroom-seat xm-mroom-seat--host is-host" data-mroom-host style="--home-x:50%;--home-y:90%">
      <div class="xm-mroom-seat-card">
        <div class="xm-mroom-seat-ring" aria-hidden="true"></div>
        <div class="xm-mroom-seat-avatar xm-mroom-seat-avatar--host">你</div>
        <div class="xm-mroom-seat-name">主持人</div>
        <div class="xm-mroom-seat-status"><span class="xm-mroom-status-dot" aria-hidden="true"></span>主持</div>
      </div>
    </div>`
}

function renderMeetingComposerBar(st) {
  const sending = st.meetingSending || st.meetingPolling
  const hadRound = (st.meetingMessages || []).some((m) => m.role === 'user')
  const targets = getMentionTargets(st)
  const targetLabel = formatMentionNames(st)
  if (sending) {
    return `
      <span class="xm-mroom-hint">讨论进行中 · 请等待本轮结束</span>
      <button type="button" class="xm-mroom-btn xm-mroom-btn--ghost" data-act="meeting-stop">停止</button>`
  }
  if (targets.length) {
    return `
      <span class="xm-mroom-hint">已点名 ${targets.length} 人：${esc(targetLabel)}</span>
      <button type="button" class="xm-mroom-btn xm-mroom-btn--ghost" data-act="meeting-clear-mention">取消</button>
      <button type="button" class="xm-mroom-btn xm-mroom-btn--ghost" data-act="meeting-send">全员</button>
      <button type="button" class="xm-mroom-btn xm-mroom-btn--primary" data-act="meeting-mention">请他们发言 →</button>`
  }
  return `
    <span class="xm-mroom-hint">点击角色可多选点名 · 或全员讨论</span>
    ${
      (st.meetingMessages || []).some((m) => m.role === 'agent' && m.state === 'completed')
        ? `<button type="button" class="xm-mroom-btn xm-mroom-btn--ghost" data-act="meeting-conclude"${st.meetingConcluding ? ' disabled' : ''}>${st.meetingConcluding ? '汇总中…' : '沉淀方案'}</button>`
        : ''
    }
    <button type="button" class="xm-mroom-btn xm-mroom-btn--primary" data-act="meeting-send">${hadRound ? '继续追问 →' : '开始讨论 →'}</button>`
}

function renderMeetingTopActions(st) {
  const sending = st.meetingSending || st.meetingPolling
  const creator = !!st.meetingCreatorMode
  const collapsed = !!st.meetingTranscriptCollapsed || creator
  return `
    ${
      sending
        ? `<button type="button" class="xm-mroom-icon-btn" data-act="meeting-stop" title="停止讨论" aria-label="停止讨论">${mroomIcon('stop')}</button>`
        : ''
    }
    <button type="button" class="xm-mroom-icon-btn${creator ? ' is-active' : ''}" data-act="meeting-creator-toggle" title="${creator ? '退出录屏模式' : '录屏模式'}" aria-label="录屏模式" aria-pressed="${creator ? 'true' : 'false'}">${mroomIcon('creator')}</button>
    <button type="button" class="xm-mroom-icon-btn${collapsed ? '' : ' is-active'}" data-act="meeting-transcript-toggle" title="${collapsed ? '展开实时讨论' : '折叠实时讨论'}" aria-label="布局" ${creator ? 'disabled' : ''}>${mroomIcon(collapsed ? 'expand' : 'panel')}</button>
    <button type="button" class="xm-mroom-icon-btn" data-act="meeting-room-collapse" title="收起" aria-label="收起">${mroomIcon('collapse')}</button>
    <button type="button" class="xm-mroom-icon-btn xm-mroom-icon-btn--leave" data-act="meeting-room-close" title="离开" aria-label="离开">${mroomIcon('leave')}</button>`
}

function renderMeetingRoom(st) {
  const topic = st.meetingCurrentTopic || st.meetingTopic || '输入一个话题，开始 AI员工聊天'
  const count =
    (st.meetingParticipants || []).length ||
    (st.agents || []).filter((a) => String(a.status || '') === 'active' && String(a.agent_code || '') !== 'xiaomi')
      .length
  const mentionLabel = formatMentionNames(st)
  const mentionCount = getMentionTargets(st).length
  const live = !!(st.meetingPolling || st.meetingSending || st.meetingActiveSpeaker)
  const statusText = st.meetingPolling
    ? '讨论进行中'
    : st.meetingSending
      ? '正在召集…'
      : mentionCount
        ? `已点名 ${mentionCount} 人：${mentionLabel}`
        : count
          ? `${count} 位 AI 已入席`
          : '等待入席'
  const creator = !!st.meetingCreatorMode
  const collapsed = !!st.meetingTranscriptCollapsed || creator
  const round = meetingRoundLabel(st)
  const roomClass = [
    'xm-mroom',
    creator ? 'is-creator' : '',
    collapsed ? 'is-transcript-collapsed' : '',
    live ? 'is-live' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `
    <div class="${roomClass}" role="dialog" aria-modal="true" aria-label="AI员工聊天室">
      <div class="xm-mroom-bg" aria-hidden="true"></div>
      <header class="xm-mroom-top">
        <div class="xm-mroom-brand">
          <span class="xm-mroom-brand-mark" aria-hidden="true">${mroomIcon('spark')}</span>
          <div>
            <div class="xm-mroom-brand-title">AI员工聊天室</div>
            <div class="xm-mroom-brand-sub" data-mroom-brand-sub>
              <span class="xm-mroom-live-dot${live ? ' is-on' : ''}" aria-hidden="true"></span>
              ${esc(statusText)}
            </div>
          </div>
        </div>
        <div class="xm-mroom-actions" data-mroom-actions>${renderMeetingTopActions(st)}</div>
      </header>
      <div class="xm-mroom-body">
        <section class="xm-mroom-stage-wrap">
          <div class="xm-mroom-topic-bar" data-mroom-topic-bar>
            <div class="xm-mroom-topic-kicker">当前话题</div>
            <div class="xm-mroom-topic-text" title="${esc(topic)}">${esc(topic)}</div>
          </div>
          <div class="xm-mroom-stage">
            <div class="xm-mroom-table">
              <div class="xm-mroom-table-glow" aria-hidden="true"></div>
              <div class="xm-mroom-table-spot" aria-hidden="true"></div>
              <div class="xm-mroom-table-inner" data-mroom-table-inner>
                <div class="xm-mroom-table-round" data-mroom-round>第 ${Number(round) || 1} 轮</div>
                <div class="xm-mroom-table-topic">${esc(String(topic).slice(0, 64))}</div>
              </div>
            </div>
            ${renderMeetingRoomSeats(st)}
          </div>
          <div class="xm-mroom-speech-slot" data-mroom-speech>${renderMeetingRoomSpeech(st)}</div>
        </section>
        <aside class="xm-mroom-side" data-mroom-side>
          <div class="xm-mroom-side-head">
            <div>
              <div class="xm-mroom-side-title">实时讨论</div>
              <div class="xm-mroom-side-sub"><span class="xm-mroom-live-dot${live ? ' is-on' : ''}" aria-hidden="true"></span>讨论记录</div>
            </div>
            <button type="button" class="xm-mroom-icon-btn" data-act="meeting-transcript-toggle" title="折叠" aria-label="折叠侧栏">${mroomIcon('collapse')}</button>
          </div>
          <div class="xm-mroom-log-scroll" data-mroom-scroll>${renderMeetingRoomMessages(st)}</div>
        </aside>
      </div>
      <footer class="xm-mroom-console">
        <div class="xm-mroom-console-shell">
          <div class="xm-mroom-console-icon" aria-hidden="true">${mroomIcon('spark')}</div>
          <textarea class="xm-mroom-input" data-meeting-topic data-mroom-topic rows="1" placeholder="${
            getMentionTargets(st).length
              ? `向已点名的 ${getMentionTargets(st).length} 位追问…`
              : '输入需求/方案，开始圆桌讨论…'
          }">${esc(st.meetingTopic || '')}</textarea>
          <label class="xm-meeting-tools-toggle xm-meeting-tools-toggle--room" title="开启后员工可短时查任务/资产再发言（只读）">
            <input type="checkbox" data-act="meeting-toggle-tools" ${st.meetingAllowTools ? 'checked' : ''} ${live ? 'disabled' : ''} />
            查证
          </label>
          <div class="xm-mroom-composer-bar" data-mroom-composer-bar>${renderMeetingComposerBar(st)}</div>
        </div>
      </footer>
    </div>`
}

function destroyAiRoundtableMount() {
  if (_aiRtMount) {
    try {
      _aiRtMount.destroy()
    } catch {
      /* ignore */
    }
    _aiRtMount = null
  }
  _root?.querySelector('.xm-mroom')?.remove()
  _root?.querySelector('[data-ai-roundtable-host]')?.remove()
  _mroomMsgSig = ''
  _mroomSpeechSig = ''
}

function ensureAiRoundtableMount() {
  if (!_root) return null
  if (_aiRtMount) return _aiRtMount
  _root.querySelector('.xm-mroom')?.remove()
  // 与 localStorage 静音态对齐
  patchState({ meetingTtsMuted: isMeetingTtsMuted() }, { silent: true })
  _aiRtMount = mountAiRoundtableRoom(_root, {
    onTopicChange: (value) => {
      patchState({ meetingTopic: String(value ?? '') }, { silent: true })
    },
    onSend: (topic) => {
      const t = String(topic || '').trim()
      if (!t) return
      // 发送是用户手势：解锁浏览器音频并打开会议室播报
      enableMeetingTtsFromUserGesture()
      patchState({ meetingTtsMuted: false })
      void startMeetingFlow(t)
    },
    onMention: (agentCodes, topic) => {
      const codes = normalizeMentionTargets(agentCodes)
      const t = String(topic || '').trim()
      if (!codes.length || !t) return
      enableMeetingTtsFromUserGesture()
      patchState({ meetingTtsMuted: false })
      void startMentionFlow(codes, t)
    },
    onStop: () => {
      stopMeetingPoll()
    },
    onSelectParticipant: (agentCode) => {
      const cur = getState()
      if (cur.meetingSending || cur.meetingPolling) return
      const code = String(agentCode || '').trim()
      if (!code) return
      const next = toggleMentionTarget(code)
      if (next.length) {
        toast(
          `已点名 ${next.length} 人：${formatMentionNames({ ...cur, meetingMentionTargets: next })}。可继续点选多人`,
          'success',
        )
      }
    },
    onClearMention: () => {
      patchState({ meetingMentionTargets: [] })
    },
    onCollapse: () => {
      closeMeetingRoom()
      patchState({ activeView: 'meeting', isOpen: true, isMinimized: false }, { persistUi: true })
    },
    onClose: () => {
      stopMeetingPoll()
      closeMeetingRoom()
      const cur = getState()
      if (cur.isOpen) patchState({ activeView: 'meeting' }, { persistUi: true })
    },
    onToggleCreator: () => {
      const cur = getState()
      const next = !cur.meetingCreatorMode
      patchState({
        meetingCreatorMode: next,
        meetingTranscriptCollapsed: next ? true : cur.meetingTranscriptCollapsed,
      })
    },
    onToggleTranscript: () => {
      const cur = getState()
      if (cur.meetingCreatorMode) {
        patchState({ meetingCreatorMode: false, meetingTranscriptCollapsed: false })
        return
      }
      patchState({ meetingTranscriptCollapsed: !cur.meetingTranscriptCollapsed })
    },
    onToggleTts: () => {
      const muted = toggleMeetingTtsMuted()
      patchState({ meetingTtsMuted: muted })
      if (!muted) {
        toast('已开启语音播报', 'success')
        const cur = getState()
        void syncMeetingTts({ ...cur, agents: buildRoundtableAgents(cur) })
      } else {
        toast('已静音', 'info')
      }
    },
  })
  return _aiRtMount
}

/**
 * 用 listAgents 头像索引丰富会议室 agents（与侧栏/员工模块同源）。
 * store.agents 来自角色摘要，常缺 has_avatar_file / avatar_rev。
 */
function buildRoundtableAgents(st) {
  const byCode = new Map()
  for (const a of st.agents || []) {
    const code = String(a?.agent_code || '').trim()
    if (!code) continue
    byCode.set(code.toLowerCase(), a)
  }
  for (const p of st.meetingParticipants || []) {
    const code = String(p?.agent_code || '').trim()
    if (!code) continue
    const key = code.toLowerCase()
    if (!byCode.has(key)) {
      byCode.set(key, { agent_code: code, role_name: p.role_name })
    }
  }
  // 主持人常用小V头像
  if (!byCode.has('xiaomi')) {
    byCode.set('xiaomi', { agent_code: 'xiaomi', role_name: '小V' })
  }

  const out = []
  for (const [key, role] of byCode) {
    const code = String(role.agent_code || key).trim()
    const av = resolveAvatarAgent(code, role)
    out.push({
      ...role,
      agent_code: code,
      agent_name: av.agent_name,
      role_name: role.role_name || av.agent_name,
      avatar: av.avatar,
      avatar_meta: av.avatar_meta,
      tts_speaker: av.tts_speaker ?? role.tts_speaker ?? null,
      has_avatar_file: av.has_avatar_file,
      avatar_rev: av.avatar_rev,
    })
  }
  return out
}

/**
 * 全屏会议室：挂载 React AIRoundtableRoom，状态由小V store 驱动。
 */
function syncMeetingRoom(st) {
  if (!_root) return
  if (!st.meetingRoomOpen) {
    stopMeetingTts()
    destroyAiRoundtableMount()
    return
  }
  const mount = ensureAiRoundtableMount()
  const paint = (state) => {
    const agents = buildRoundtableAgents(state)
    const next = { ...state, agents, meetingTtsMuted: isMeetingTtsMuted() }
    mount?.update(next)
    void syncMeetingTts(next)
  }
  // 先用缓存索引立刻绘制；再强制刷新 listAgents 后重绘真实头像
  paint(st)
  void (async () => {
    await refreshAvatarIndex({ force: true })
    const cur = getState()
    if (!cur.meetingRoomOpen || !_aiRtMount) return
    paint(cur)
  })()
}

function renderComposer(st) {
  if (!st.isOpen) return ''
  if (st.activeView === 'meeting') return renderMeetingComposer(st)
  if (st.activeView === 'debug') return ''
  const contact = resolveSelectedContact(st)
  const draft = contactDraft(st)
  if (contact !== 'xiaomi') {
    const agent = findAgent(contact)
    const name = agent?.role_name || contact
    return `
    <footer class="xm-composer xm-composer--delegate">
      <div class="xm-composer-box">
        <textarea class="xm-composer-input" data-draft rows="2" placeholder="发给「${esc(name)}」：一句话任务目标…">${esc(draft)}</textarea>
        <button type="button" class="xm-composer-send" data-act="send" title="委派" aria-label="委派">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
      </div>
      <p class="xm-composer-hint">发送即委派 · 不等于已完成</p>
    </footer>`
  }
  const iconSend = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>`
  const iconStop = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
  return `
    <footer class="xm-composer xm-composer--inline${isWorkbenchDock(st) ? ' xm-composer--guide' : ''}">
      <div class="xm-composer-box">
        <textarea class="xm-composer-input" data-draft rows="2" placeholder="${isWorkbenchDock(st) ? '直接说：帮我创建 / 改参数 / 查进度…' : '问进度、查知识、安排任务或了解系统用法…'}">${esc(draft)}</textarea>
        ${
          st.streaming
            ? `<button type="button" class="xm-composer-send is-stop" data-act="stop" title="停止" aria-label="停止">${iconStop}</button>`
            : `<button type="button" class="xm-composer-send" data-act="send" title="发送" aria-label="发送">${iconSend}</button>`
        }
      </div>
    </footer>`
}

function renderFabHtml(st) {
  const badge = Number(st.badgeCount || 0)
  const shortcut = formatShortcutDisplay(getShortcutBinding('toggleXiaomiAssistant'))
  return `<button type="button" class="xm-fab xm-fab--quiet" data-act="open" title="小V 协助（${shortcut}）· 右键可隐藏" aria-label="打开小V 协助">
    <span class="xm-fab-face" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </span>
    ${badge > 0 ? `<span class="xm-fab-badge" aria-label="${badge} 项待处理">${badge > 99 ? '99+' : badge}</span>` : ''}
  </button>`
}

/** 右侧边缘入口（对标常见助手侧栏）；可带 coach mark 引导 */
function renderEdgeTabHtml(st) {
  const ctx = pageContext()
  const tip = ctx.label ? `协助 · ${ctx.label}` : '小V 协助'
  const coach = resolveEdgeCoach(st)
  const coachHtml = coach
    ? `<div class="xm-edge-coach" role="status" data-coach-id="${esc(coach.id)}">
        <div class="xm-edge-coach-card">
          <p class="xm-edge-coach-title">${esc(coach.title)}</p>
          <p class="xm-edge-coach-body">${esc(coach.body)}</p>
          <div class="xm-edge-coach-actions">
            <button type="button" class="xm-edge-coach-cta" data-act="open">打开小V</button>
            <button type="button" class="xm-edge-coach-dismiss" data-act="dismiss-coach" data-coach-id="${esc(coach.id)}" aria-label="知道了">知道了</button>
          </div>
        </div>
      </div>`
    : ''
  return `<div class="xm-edge-wrap${coach ? ' has-coach' : ''}">
    ${coachHtml}
    <button type="button" class="xm-edge-tab${coach ? ' is-hint' : ''}" data-act="open" title="${esc(tip)}" aria-label="打开小V 协助">
      <span class="xm-edge-tab-label">小V</span>
    </button>
  </div>`
}

function renderBody(st) {
  let view = st.activeView === 'knowledge' ? 'chat' : st.activeView
  if (view === 'agents' || view === 'delegate') view = 'chat'
  if (view === 'debug' && !st.obsEnabled) view = 'chat'
  if (view === 'meeting') return renderMeeting(st)
  if (view === 'debug') return renderDebug(st)
  if (view === 'chat') {
    const contact = resolveSelectedContact(st)
    return contact === 'xiaomi' ? renderChat(st) : renderEmployeeThread(st)
  }
  return renderDashboard(st)
}

function renderShellInner(st) {
  const guideDock = isWorkbenchDock(st)
  if (guideDock) {
    return `<div class="xm-main xm-main--guide" data-xm-main>
        <div data-xm-body-slot>${renderBody(st)}</div>
        <div data-xm-composer-slot>${renderComposer(st)}</div>
      </div>`
  }
  return `${renderContactRail(st)}
      <div class="xm-main" data-xm-main>
        <div data-xm-body-slot>${renderBody(st)}</div>
        <div data-xm-composer-slot>${renderComposer(st)}</div>
      </div>`
}

function renderBanner(st) {
  if (st.loading) return `<div class="xm-loading" data-xm-banner>加载中…</div>`
  if (st.error && st.partialUnavailable) {
    return `<div class="xm-banner" data-xm-banner>${esc(st.error)} <button type="button" class="btn btn-sm btn-outline" data-act="refresh">重试</button></div>`
  }
  return `<div data-xm-banner hidden></div>`
}

/** In-place panel updates — avoid full aside remount (re-triggers xm-in flash). */
function render() {
  if (!_root) return
  const st = getState()
  const hide = shouldHideAssistant()
  _root.hidden = hide
  if (hide) {
    syncDockChrome({ ...st, isOpen: false })
    const room = _root.querySelector('.xm-mroom')
    if (room) room.remove()
    // 隐藏路由时清掉会议室开关，回来后悬浮球才能正常出现
    if (st.meetingRoomOpen) {
      patchState({ meetingRoomOpen: false, meetingActiveSpeaker: '' }, { silent: true })
    }
    unmountXiaomiPanelReactHosts()
    return
  }

  // 默认右侧边缘条；仅用户主动切回 float 时才用悬浮球
  const preferFloat = resolvePanelLayout(st) === 'float'
  const showFab = !st.isOpen && !st.meetingRoomOpen && !st.fabUserHidden && preferFloat
  const showEdgeTab = !st.isOpen && !st.meetingRoomOpen && !st.fabUserHidden && !preferFloat
  let fab = _root.querySelector('.xm-fab')
  let edgeTab = _root.querySelector('.xm-edge-tab')
  let edgeWrap = _root.querySelector('.xm-edge-wrap')
  let panel = _root.querySelector('.xm-panel')

  if (st.fabUserHidden && !st.isOpen && !st.meetingRoomOpen) {
    if (fab) fab.remove()
    if (edgeWrap) edgeWrap.remove()
    else if (edgeTab) edgeTab.remove()
    if (panel) panel.remove()
    closeFabContextMenu()
    unmountXiaomiPanelReactHosts()
    syncDockChrome(st)
    syncMeetingRoom(st)
    return
  }

  if (showEdgeTab) {
    if (panel) panel.remove()
    if (fab) fab.remove()
    unmountXiaomiPanelReactHosts()
    syncDockChrome(st)
    const staleRoom = _root.querySelector('.xm-mroom')
    if (staleRoom) staleRoom.remove()
    const html = renderEdgeTabHtml(st)
    if (edgeWrap) {
      edgeWrap.outerHTML = html
    } else if (edgeTab && !edgeTab.closest('.xm-edge-wrap')) {
      edgeTab.outerHTML = html
    } else if (!edgeWrap) {
      _root.insertAdjacentHTML('afterbegin', html)
    }
    // 记录展示，便于「知道了」后短冷却
    const coach = resolveEdgeCoach(st)
    if (coach) {
      const last = Number(st.coachShownAt || 0)
      if (!last || Date.now() - last > COACH_ROUTE_COOLDOWN_MS) {
        patchState({ coachShownAt: Date.now() }, { silent: true })
      }
    }
    syncMeetingRoom(st)
    return
  }

  if (edgeWrap) edgeWrap.remove()
  else if (edgeTab) edgeTab.remove()

  if (showFab) {
    if (panel) panel.remove()
    unmountXiaomiPanelReactHosts()
    syncDockChrome(st)
    // 残留会议室 DOM 时清掉，避免挡住操作且状态已关
    const staleRoom = _root.querySelector('.xm-mroom')
    if (staleRoom) staleRoom.remove()
    if (!fab) {
      _root.insertAdjacentHTML('afterbegin', renderFabHtml(st))
      fab = _root.querySelector('.xm-fab')
    } else {
      const badge = Number(st.badgeCount || 0)
      const existing = fab.querySelector('.xm-fab-badge')
      if (badge > 0) {
        const label = badge > 99 ? '99+' : String(badge)
        if (existing) {
          existing.textContent = label
          existing.setAttribute('aria-label', `${badge} 项待处理`)
        } else {
          fab.insertAdjacentHTML(
            'beforeend',
            `<span class="xm-fab-badge" aria-label="${badge} 项待处理">${label}</span>`,
          )
        }
      } else if (existing) {
        existing.remove()
      }
    }
    applyFabPosition(fab, st)
    ensureFabVisible(fab)
    syncMeetingRoom(st)
    mountRailAvatars()
    return
  }

  if (fab) fab.remove()
  {
    const wrap = _root.querySelector('.xm-edge-wrap')
    if (wrap) wrap.remove()
    else _root.querySelector('.xm-edge-tab')?.remove()
  }

  // 仅会议室全屏时：可不显示侧栏，只保留圆桌
  if (st.meetingRoomOpen && !st.isOpen) {
    if (panel) panel.remove()
    unmountXiaomiPanelReactHosts()
    syncMeetingRoom(st)
    mountRailAvatars()
    return
  }

  const needsShellRemount = panel && !panel.querySelector('[data-xm-shell]')
  if (needsShellRemount) {
    panel.remove()
    panel = null
  }

  if (!panel) {
    _root.insertAdjacentHTML(
      'beforeend',
      `<aside class="xm-panel xm-panel--enter${st.isExpanded ? ' xm-panel--expanded' : ''}${resolvePanelLayout(st) === 'dock' ? ' xm-panel--dock' : ''}" role="dialog" aria-label="小V全局助手">
        <div data-xm-chrome>${renderHeader(st)}</div>
        ${renderBanner(st)}
        <div class="xm-shell" data-xm-shell>${renderShellInner(st)}</div>
      </aside>`,
    )
    panel = _root.querySelector('.xm-panel')
    panel?.addEventListener(
      'animationend',
      () => {
        panel?.classList.remove('xm-panel--enter')
      },
      { once: true },
    )
  } else {
    panel.classList.toggle('xm-panel--expanded', !!st.isExpanded && resolvePanelLayout(st) !== 'dock')
    panel.classList.toggle('xm-panel--dock', resolvePanelLayout(st) === 'dock')
    const chrome = panel.querySelector('[data-xm-chrome]')
    if (chrome) chrome.innerHTML = renderHeader(st)
    const bannerHost = panel.querySelector('[data-xm-banner]')
    const nextBanner = renderBanner(st)
    if (bannerHost) {
      const wrap = document.createElement('div')
      wrap.innerHTML = nextBanner
      const next = wrap.firstElementChild
      if (next) bannerHost.replaceWith(next)
    } else {
      panel.querySelector('[data-xm-chrome]')?.insertAdjacentHTML('afterend', nextBanner)
    }
    const shell = panel.querySelector('[data-xm-shell]')
    const rail = shell?.querySelector('[data-xm-rail]')
    const bodySlot = shell?.querySelector('[data-xm-body-slot]')
    const composerSlot = shell?.querySelector('[data-xm-composer-slot]')
    const guideDock = isWorkbenchDock(st)
    const keepXmSessionDebugShell =
      st.activeView === 'debug' && !!bodySlot?.querySelector?.('[data-xm-session-debug]')
    // dock 工作栏无联系人轨：结构变了就整段重挂（调试视图除外，避免冲掉详情弹窗）
    if (guideDock && rail && !keepXmSessionDebugShell) {
      shell.innerHTML = renderShellInner(st)
    } else if (!guideDock && shell && !rail && !keepXmSessionDebugShell) {
      shell.innerHTML = renderShellInner(st)
    } else if (shell && bodySlot && composerSlot && (rail || guideDock || keepXmSessionDebugShell)) {
      if (rail) rail.outerHTML = renderContactRail(st)
      const contactNow = resolveSelectedContact(st)
      const keepXmReactThread =
        st.activeView === 'chat' &&
        contactNow === 'xiaomi' &&
        !!bodySlot.querySelector('[data-xm-react-thread]')
      // 流式/消息更新时勿销毁 React 根，否则 MessageRow 会整树重挂
      // 调试详情弹窗挂在 SessionDebugPane 状态上：body 整段重绘会 remount 并关掉弹窗
      const keepXmSessionDebug =
        st.activeView === 'debug' && !!bodySlot.querySelector('[data-xm-session-debug]')
      if (keepXmSessionDebug) {
        patchDebugPageContextTable(bodySlot, st)
      } else if (!keepXmReactThread) {
        bodySlot.innerHTML = renderBody(st)
      }
      const ta = composerSlot.querySelector('[data-draft]')
      const prevDraft = ta instanceof HTMLTextAreaElement ? ta.value : null
      const prevSelStart = ta instanceof HTMLTextAreaElement ? ta.selectionStart : null
      const prevSelEnd = ta instanceof HTMLTextAreaElement ? ta.selectionEnd : null
      const focused = ta instanceof HTMLTextAreaElement && document.activeElement === ta
      const draftUnchanged = String(prevDraft ?? '') === String(contactDraft(st) ?? '')
      const mt = composerSlot.querySelector('[data-meeting-topic]')
      const mtPrev = mt instanceof HTMLTextAreaElement ? mt.value : null
      const mtFocused = mt instanceof HTMLTextAreaElement && document.activeElement === mt
      const mtSelStart = mt instanceof HTMLTextAreaElement ? mt.selectionStart : null
      const mtSelEnd = mt instanceof HTMLTextAreaElement ? mt.selectionEnd : null
      composerSlot.innerHTML = renderComposer(st)
      if (focused) {
        const nextTa = composerSlot.querySelector('[data-draft]')
        if (nextTa instanceof HTMLTextAreaElement) {
          nextTa.focus()
          if (draftUnchanged && prevSelStart != null && prevSelEnd != null) {
            try {
              nextTa.setSelectionRange(prevSelStart, prevSelEnd)
            } catch {
              /* ignore */
            }
          } else {
            const n = nextTa.value.length
            try {
              nextTa.setSelectionRange(n, n)
            } catch {
              /* ignore */
            }
          }
        }
      }
      if (mtFocused) {
        const nextMt = composerSlot.querySelector('[data-meeting-topic]')
        if (nextMt instanceof HTMLTextAreaElement) {
          nextMt.value = String(st.meetingTopic ?? mtPrev ?? '')
          nextMt.focus()
          if (mtSelStart != null && mtSelEnd != null) {
            try {
              nextMt.setSelectionRange(mtSelStart, mtSelEnd)
            } catch {
              /* ignore */
            }
          }
        }
      }
    } else if (shell) {
      shell.innerHTML = renderShellInner(st)
    }
  }

  const contact = resolveSelectedContact(st)
  const scroll = _root.querySelector('[data-chat-scroll]')
  if (scroll && st.activeView === 'chat' && contact === 'xiaomi') {
    scroll.scrollTop = scroll.scrollHeight
  }
  const empScroll = _root.querySelector('[data-emp-scroll]')
  if (empScroll && st.activeView === 'chat' && contact !== 'xiaomi') {
    // keep user scroll position unless near bottom
    const nearBottom = empScroll.scrollHeight - empScroll.scrollTop - empScroll.clientHeight < 48
    if (nearBottom) empScroll.scrollTop = empScroll.scrollHeight
  }
  const meetingScroll = _root.querySelector('[data-meeting-scroll]')
  if (meetingScroll && st.activeView === 'meeting') {
    meetingScroll.scrollTop = meetingScroll.scrollHeight
  }
  syncDockChrome(st)
  syncMeetingRoom(st)
  mountRailAvatars()
  if (st.isOpen && st.activeView === 'chat' && contact === 'xiaomi') {
    syncXiaomiReactThreadMount()
  } else {
    unmountXiaomiChatThread()
  }
  if (st.isOpen && st.activeView === 'debug') {
    syncXiaomiSessionDebugMount()
  } else {
    unmountXiaomiSessionDebug()
  }
}

function findAttention(id) {
  return (getState().attentionItems || []).find((x) => x.id === id)
}

function findSug(id) {
  return (getState().suggestedActions || []).find((x) => x.id === id)
}

async function handleAction(act, el, e) {
  const st = getState()
  if (act === 'open') {
    if (_suppressFabOpen) {
      _suppressFabOpen = false
      cancelFabOpenTimer()
      return
    }
    // 延迟打开，给双击「恢复默认」留窗口
    cancelFabOpenTimer()
    _fabOpenTimer = setTimeout(() => {
      _fabOpenTimer = null
      if (_suppressFabOpen) {
        _suppressFabOpen = false
        return
      }
      openPanel()
    }, FAB_OPEN_DELAY_MS)
    return
  }
  if (act === 'close') {
    patchState({ headerMoreOpen: false }, { silent: true })
    closePanel()
    return
  }
  if (act === 'minimize') {
    patchState({ headerMoreOpen: false }, { silent: true })
    minimizePanel()
    return
  }
  if (act === 'toggle-layout') {
    const cur = resolvePanelLayout(getState())
    const next = cur === 'dock' ? 'float' : 'dock'
    patchState({ panelLayoutPref: next, headerMoreOpen: false }, { persistUi: true })
    syncDockChrome(getState())
    return
  }
  if (act === 'guide-prompt') {
    const prompt = String(el?.getAttribute?.('data-prompt') || '').trim()
    if (!prompt) return
    setContactDraft('xiaomi', prompt, { silent: false })
    patchState({ activeView: 'chat', selectedContact: 'xiaomi', draft: prompt }, { persistUi: true })
    queueMicrotask(() => {
      const ta = _root?.querySelector('.xm-composer [data-draft]')
      if (ta instanceof HTMLTextAreaElement) {
        ta.focus()
        try {
          ta.setSelectionRange(ta.value.length, ta.value.length)
        } catch {
          /* ignore */
        }
      }
    })
    return
  }
  if (act === 'expand') {
    patchState({ headerMoreOpen: false, isExpanded: !st.isExpanded }, { persistUi: true })
    return
  }
  if (act === 'refresh') {
    patchState({ headerMoreOpen: false }, { silent: true })
    void refreshDashboard()
    return
  }
  if (act === 'clear-context') {
    patchState({ contextPinned: false, contextOverride: null })
    return
  }
  if (act === 'nav') {
    navigate(el.getAttribute('data-href') || '/proactive')
    return
  }
  if (act === 'open-employee') {
    navigate(`/proactive/${encodeURIComponent(el.getAttribute('data-code') || '')}`)
    return
  }
  if (act === 'open-task') {
    const tid = el.getAttribute('data-task') || ''
    if (tid) navigate(`/task/${encodeURIComponent(tid)}`)
    return
  }
  if (act === 'open-board') {
    navigate('/proactive/board')
    return
  }
  if (act === 'open-delegate' || act === 'delegate-to') {
    const code =
      act === 'delegate-to'
        ? String(el.getAttribute('data-code') || '').trim()
        : ''
    const fallback =
      (st.agents || []).find(
        (a) => String(a.status || '') === 'active' && String(a.agent_code || '') !== 'xiaomi',
      )?.agent_code || ''
    const target = code || fallback
    if (!target) {
      toast('暂无可委派的员工', 'warning')
      return
    }
    selectContact(target, { focusDraft: true })
    return
  }
  if (act === 'open-agents-rail') {
    const first =
      (st.agents || []).find(
        (a) => String(a.status || '') === 'active' && String(a.agent_code || '') !== 'xiaomi',
      )?.agent_code || ''
    if (first) selectContact(first)
    else {
      patchState({ activeView: 'chat', selectedContact: 'xiaomi' }, { persistUi: true })
      toast('暂无员工，可先打开员工管理创建', 'info')
    }
    return
  }
  if (act === 'select-contact') {
    selectContact(el.getAttribute('data-code') || 'xiaomi')
    return
  }
  if (act === 'open-employee-trail') {
    const code = String(el.getAttribute('data-code') || resolveSelectedContact(st)).trim()
    if (!code || code === 'xiaomi') return
    const agent = findAgent(code)
    const busy = Boolean(
      st.employeeThread?.code === code ? st.employeeThread?.busy : agent?.busy,
    )
    try {
      ensureLiveProcess().open({
        agentCode: code,
        roleName: agent?.role_name || code,
        busy,
        title: busy ? '工作过程 · 工作中' : '工作过程',
      })
    } catch (err) {
      toast(String(err?.message || err), 'error')
    }
    return
  }
  if (act === 'request-update') {
    const code = el.getAttribute('data-code') || ''
    const task = el.getAttribute('data-task') || ''
    try {
      await requestEmployeeUpdate(code, task)
      toast('已请求员工更新进度', 'success')
    } catch (err) {
      toast(String(err?.message || err), 'error')
    }
    return
  }
  if (act === 'attention-primary') {
    const it = findAttention(el.getAttribute('data-id'))
    if (!it) return
    markAttentionRead(it.id)
    if (it.kind === 'approval_required') navigate('/proactive?tab=approvals')
    else if (it.taskId) navigate(`/task/${encodeURIComponent(it.taskId)}`)
    else if (it.agentCode) navigate(`/proactive/${encodeURIComponent(it.agentCode)}`)
    return
  }
  if (act === 'sug-primary' || act === 'sug-secondary') {
    const s = findSug(el.getAttribute('data-id'))
    if (!s) return
    const action = act === 'sug-primary' ? s.primaryAction : s.secondaryAction
    if (action === 'open_board') navigate('/proactive/board')
    else if (action === 'open_task' && s.taskId) navigate(`/task/${encodeURIComponent(s.taskId)}`)
    else if (action === 'request_update') {
      try {
        await requestEmployeeUpdate(s.agentCode, s.taskId)
        toast('已请求更新', 'success')
      } catch (err) {
        toast(String(err?.message || err), 'error')
      }
    } else if (action === 'open_delegate') {
      const code = String(s.agentCode || '').trim()
      const fallback =
        (getState().agents || []).find(
          (a) => String(a.status || '') === 'active' && String(a.agent_code || '') !== 'xiaomi',
        )?.agent_code || ''
      const target = code || fallback
      if (target) selectContact(target, { focusDraft: true })
      else toast('暂无可委派的员工', 'warning')
    } else if (action === 'open_agents') {
      void handleAction('open-agents-rail', el, e)
    }
    return
  }
  if (act === 'quick-report') {
    selectContact('xiaomi')
    patchState({ activeView: 'chat' }, { persistUi: true })
    void sendXiaomiChat('请根据当前系统状态做今日汇报：整体情况、已完成、正在进行、阻塞、下一步、需要我决定的事项。', pageContext()).catch(
      (err) => toast(String(err?.message || err), 'error'),
    )
    return
  }
  if (act === 'quick-blocked') {
    selectContact('xiaomi')
    patchState({ activeView: 'chat' }, { persistUi: true })
    void sendXiaomiChat('列出当前受阻、停滞、待确认、等待用户输入的事项，并给出可执行推进建议。', pageContext()).catch((err) =>
      toast(String(err?.message || err), 'error'),
    )
    return
  }
  if (act === 'quick-approvals') {
    navigate('/proactive?tab=approvals')
    return
  }
  if (act === 'quick-knowledge') {
    selectContact('xiaomi')
    setContactDraft('xiaomi', '', { silent: true })
    patchState({ activeView: 'chat', draft: '' }, { persistUi: true })
    return
  }
  if (act === 'meeting-send') {
    const ta =
      _root.querySelector('.xm-mroom [data-meeting-topic]') ||
      _root.querySelector('[data-meeting-topic]')
    const topic = String(ta?.value || st.meetingTopic || '').trim()
    if (!topic) return
    void startMeetingFlow(topic)
    return
  }
  if (act === 'meeting-mention') {
    const ta =
      _root.querySelector('.xm-mroom [data-meeting-topic]') ||
      _root.querySelector('[data-meeting-topic]')
    const topic = String(ta?.value || st.meetingTopic || '').trim()
    const targets = getMentionTargets(st)
    if (!targets.length) {
      toast('请先点击座位选择要点名的同事（可多选）', 'warning')
      return
    }
    if (!topic) {
      toast('请输入想问的内容', 'warning')
      return
    }
    void startMentionFlow(targets, topic)
    return
  }
  if (act === 'meeting-select') {
    if (st.meetingSending || st.meetingPolling) return
    const code = String(el.getAttribute('data-mroom-seat') || '').trim()
    if (!code) return
    toggleMentionTarget(code)
    return
  }
  if (act === 'meeting-clear-mention') {
    patchState({ meetingMentionTargets: [] })
    return
  }
  if (act === 'meeting-stop') {
    stopMeetingPoll()
    return
  }
  if (act === 'meeting-room-open') {
    openMeetingRoom()
    return
  }
  if (act === 'meeting-room-focus') {
    openMeetingRoom()
    return
  }
  if (act === 'meeting-creator-toggle') {
    const cur = getState()
    const next = !cur.meetingCreatorMode
    patchState({
      meetingCreatorMode: next,
      meetingTranscriptCollapsed: next ? true : cur.meetingTranscriptCollapsed,
    })
    return
  }
  if (act === 'meeting-transcript-toggle') {
    const cur = getState()
    if (cur.meetingCreatorMode) {
      patchState({ meetingCreatorMode: false, meetingTranscriptCollapsed: false })
      return
    }
    patchState({ meetingTranscriptCollapsed: !cur.meetingTranscriptCollapsed })
    return
  }
  if (act === 'meeting-room-collapse') {
    // 收起全屏，讨论可继续在后台轮询
    closeMeetingRoom()
    patchState({ activeView: 'meeting', isOpen: true, isMinimized: false }, { persistUi: true })
    return
  }
  if (act === 'meeting-room-close') {
    stopMeetingPoll()
    closeMeetingRoom()
    // 离开会议室后若侧栏已关，恢复悬浮球；否则留在会议 tab
    const cur = getState()
    if (!cur.isOpen) {
      /* showFab path on next render */
    } else {
      patchState({ activeView: 'meeting' }, { persistUi: true })
    }
    return
  }
  if (act === 'meeting-reset') {
    stopMeetingPoll()
    closeMeetingRoom()
    _meetingProcessedTasks = new Set()
    _meetingTaskSeenCount = 0
    patchState(
      {
        meetingId: '',
        meetingParticipants: [],
        meetingMessages: [],
        meetingTopic: '',
        meetingTurnId: '',
        meetingError: '',
        meetingCurrentTopic: '',
        meetingActiveSpeaker: '',
        meetingMentionTargets: [],
        meetingCreatorMode: false,
        meetingTranscriptCollapsed: false,
        meetingConclusion: null,
        meetingConcluding: false,
      },
      { persistUi: true },
    )
    return
  }
  if (act === 'meeting-conclude') {
    void runMeetingConclude()
    return
  }
  if (act === 'meeting-toggle-tools') {
    const checked = !!(el && 'checked' in el ? el.checked : !getState().meetingAllowTools)
    patchState({ meetingAllowTools: checked })
    return
  }
  if (act === 'meeting-open-plan' || act === 'meeting-open-doc') {
    openMeetingConclusionDoc()
    return
  }
  if (act === 'send') {
    const ta = _root.querySelector('[data-draft]')
    const text = String(ta?.value || contactDraft(st) || '').trim()
    if (!text) return
    const contact = resolveSelectedContact(st)
    if (contact !== 'xiaomi') {
      setContactDraft(contact, '', { silent: true })
      void delegateToEmployee(contact, { title: text, goal: text })
        .then((res) => {
          appendEmployeeLocalMsg(contact, text)
          const tid = res?.task_id || res?.id || ''
          toast(tid ? `已委派（${tid}）` : '已交给员工处理（尚未完成）', 'success')
          void refreshEmployeeThreadForContact(contact)
          void refreshDashboard()
        })
        .catch((err) => toast(String(err?.message || err), 'error'))
      return
    }
    setContactDraft('xiaomi', '', { silent: true })
    patchState({ activeView: 'chat', draft: '' }, { persistUi: true })
    void sendXiaomiChat(text, pageContext()).catch((err) => toast(String(err?.message || err), 'error'))
    return
  }
  if (act === 'stop') {
    void stopXiaomiChat()
    void import('../../lib/background-voice.js').then(({ stopAssistantVoicePlayback }) =>
      stopAssistantVoicePlayback(),
    )
    return
  }
  if (act === 'stop-tts') {
    patchState({ headerMoreOpen: false }, { silent: true })
    void import('../../lib/background-voice.js').then(async ({ stopAssistantVoicePlayback }) => {
      await stopAssistantVoicePlayback()
      toast('已停止播报', 'info')
    })
    return
  }
  if (act === 'pause-listen') {
    patchState({ headerMoreOpen: false }, { silent: true })
    void import('../../lib/background-voice.js').then(({ pauseConversationListening }) =>
      pauseConversationListening({ reason: 'button' }),
    )
    return
  }
  if (act === 'new-round') {
    patchState({ headerMoreOpen: false }, { silent: true })
    const ok = await showConfirm(
      '确定新开一轮？\n\n将清空当前小V对话记录并换新线程；会话本身保留，之后提问不再带上旧上下文。',
    )
    if (!ok) return
    try {
      await startXiaomiNewRound()
      toast('已新开一轮', 'success')
    } catch (err) {
      toast(String(err?.message || err || '新开轮次失败'), 'error')
    }
    return
  }
  if (act === 'new-chat') {
    try {
      await startXiaomiNewChat()
      toast('已新开对话', 'success')
    } catch (err) {
      toast(String(err?.message || err || '新建对话失败'), 'error')
    }
    return
  }
  if (act === 'toggle-session-history') {
    const next = !st.sessionHistoryOpen
    patchState({ sessionHistoryOpen: next, headerMoreOpen: false })
    if (next) {
      void refreshXiaomiSessionList().catch((err) => {
        toast(String(err?.message || err || '加载历史失败'), 'error')
      })
    }
    return
  }
  if (act === 'select-session') {
    const key = String(el?.getAttribute?.('data-session') || '').trim()
    if (!key) return
    if (key === String(st.sessionKey || '')) {
      patchState({ sessionHistoryOpen: false })
      return
    }
    try {
      await switchXiaomiSession(key)
      toast('已切换会话', 'success')
    } catch (err) {
      toast(String(err?.message || err || '切换会话失败'), 'error')
    }
    return
  }
  if (act === 'open-main-chat') {
    patchState({ headerMoreOpen: false }, { silent: true })
    const key = st.sessionKey
    if (key) {
      try {
        sessionStorage.setItem('evopanel_pending_chat_session', key)
      } catch {
        /* ignore */
      }
    }
    navigate('/chat')
    return
  }
  if (act === 'toggle-header-more') {
    patchState({ headerMoreOpen: !st.headerMoreOpen, sessionHistoryOpen: false }, { silent: false })
    return
  }
  if (act === 'open-chat-view') {
    patchState(
      { activeView: 'chat', selectedContact: 'xiaomi', headerMoreOpen: false, sessionHistoryOpen: false },
      { persistUi: true },
    )
    return
  }
  if (act === 'open-debug') {
    if (!st.obsEnabled) {
      toast('请先开启运维观测，才能使用会话调试', 'warning')
      return
    }
    patchState(
      { activeView: 'debug', selectedContact: 'xiaomi', headerMoreOpen: false, sessionHistoryOpen: false },
      { persistUi: true },
    )
    void ensureXiaomiSession().catch(() => {})
    return
  }
  if (act === 'debug-refresh') {
    // 强制重绘页面上下文表 + 刷新 SessionDebugPane
    render()
    return
  }
  if (act === 'open-dashboard') {
    patchState({ activeView: 'dashboard', headerMoreOpen: false, sessionHistoryOpen: false }, { persistUi: true })
    return
  }
  if (act === 'open-meeting') {
    patchState(
      { activeView: 'meeting', headerMoreOpen: false, sessionHistoryOpen: false, isOpen: true, isMinimized: false },
      { persistUi: true },
    )
    return
  }
  if (act === 'dismiss-coach') {
    const id = String(el?.getAttribute?.('data-coach-id') || '').trim()
    if (!id) return
    const prev = Array.isArray(st.coachDismissed) ? st.coachDismissed : []
    const next = [...new Set([...prev, id])].slice(-40)
    patchState({ coachDismissed: next, coachShownAt: Date.now() }, { persistUi: true })
    return
  }
  if (act === 'feishu-bind') {
    patchState({ headerMoreOpen: false }, { silent: true })
    void startFeishuEmployeeScan(XIAOMI_AGENT, {
      roleName: '小V',
      onBound: () => {
        patchState({ feishuBound: true })
        void refreshDashboard()
      },
    })
    return
  }
  if (act === 'feishu-unbind') {
    patchState({ headerMoreOpen: false }, { silent: true })
    const ok = await showConfirm(
      '确定解除小V 的飞书机器人绑定？\n\n浮动助手与员工岗是同一身份，解绑后飞书侧将无法再对话到小V。',
    )
    if (!ok) return
    await unbindFeishuEmployee(XIAOMI_AGENT, {
      onUnbound: () => {
        patchState({ feishuBound: false })
        void refreshDashboard()
      },
    })
    return
  }
}

function onRootClick(e) {
  const t = e.target
  if (!(t instanceof Element)) return
  const moreWrap = t.closest('.xm-more')
  if (!moreWrap && getState().headerMoreOpen) {
    patchState({ headerMoreOpen: false })
  }
  const histMenu = t.closest('.xm-history-menu')
  const histBtn = t.closest('[data-act="toggle-session-history"]')
  if (!histMenu && !histBtn && getState().sessionHistoryOpen) {
    patchState({ sessionHistoryOpen: false })
  }
  const viewBtn = t.closest('[data-view]')
  if (viewBtn && _root.contains(viewBtn)) {
    let view = viewBtn.getAttribute('data-view') || 'dashboard'
    if (view === 'agents') {
      void handleAction('open-agents-rail', viewBtn, e)
      return
    }
    if (view === 'delegate') {
      void handleAction('open-delegate', viewBtn, e)
      return
    }
    if (view === 'chat') {
      patchState({ activeView: 'chat', selectedContact: resolveSelectedContact() }, { persistUi: true })
      return
    }
    patchState({ activeView: view }, { persistUi: true })
    return
  }
  const btn = t.closest('[data-act]')
  if (btn && _root.contains(btn)) {
    const act = btn.getAttribute('data-act') || ''
    // Checkbox: allow native toggle; state synced via change handler
    if (act === 'meeting-toggle-tools' && (btn instanceof HTMLInputElement || t instanceof HTMLInputElement)) {
      return
    }
    e.preventDefault()
    void handleAction(act, btn, e)
  }
}

function onRootChange(e) {
  const t = e.target
  if (!(t instanceof HTMLInputElement) || !_root?.contains(t)) return
  if (t.getAttribute('data-act') === 'meeting-toggle-tools') {
    patchState({ meetingAllowTools: !!t.checked })
  }
}

function onRootSubmit(e) {
  const form = e.target
  if (!(form instanceof HTMLFormElement) || !_root.contains(form)) return
  e.preventDefault()
  const act = form.getAttribute('data-act')
  if (act === 'delegate-submit') {
    // 旧表单兼容：若仍有残留 DOM，改为选中员工并聚焦输入
    const fd = new FormData(form)
    const agent = String(fd.get('agent') || '').trim()
    if (agent) selectContact(agent, { focusDraft: true })
  }
}

function onRootInput(e) {
  const t = e.target
  if (t instanceof HTMLTextAreaElement && t.matches('[data-draft]')) {
    setContactDraft(resolveSelectedContact(), t.value, { silent: true })
  }
  if (t instanceof HTMLTextAreaElement && t.matches('[data-meeting-topic]')) {
    patchState({ meetingTopic: t.value }, { silent: true })
  }
}

function onRootKeydown(e) {
  if (!(e.target instanceof HTMLTextAreaElement)) return
  if (e.target.matches('[data-draft]')) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleAction('send', e.target, e)
    }
  }
  if (e.target.matches('[data-meeting-topic]')) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const st = getState()
      if (getMentionTargets(st).length && (st.meetingRoomOpen || st.activeView === 'meeting')) {
        void handleAction('meeting-mention', e.target, e)
      } else {
        void handleAction('meeting-send', e.target, e)
      }
    }
  }
}

function onGlobalKeydown(e) {
  if (shouldHideAssistant()) return
  const binding = getShortcutBinding('toggleXiaomiAssistant')
  if (shortcutMatchesEvent(binding, e)) {
    e.preventDefault()
    const st = getState()
    if (st.isOpen && !st.fabUserHidden) minimizePanel()
    else openPanel()
    return
  }
  if (e.key === 'Escape') {
    closeFabContextMenu()
    const st = getState()
    if (st.meetingRoomOpen) {
      e.preventDefault()
      closeMeetingRoom()
      patchState({ activeView: 'meeting', isOpen: true, isMinimized: false }, { persistUi: true })
      return
    }
    if (st.isOpen) {
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'TEXTAREA' || tag === 'INPUT') return
      minimizePanel()
    }
  }
}

function closeFabContextMenu() {
  document.getElementById('xm-fab-context-menu')?.remove()
  document.removeEventListener('pointerdown', onFabMenuOutside, true)
}

function onFabMenuOutside(e) {
  const menu = document.getElementById('xm-fab-context-menu')
  if (!menu) return
  if (e.target instanceof Node && menu.contains(e.target)) return
  closeFabContextMenu()
}

function hideFabByUser() {
  closeFabContextMenu()
  cancelFabOpenTimer()
  _suppressFabOpen = true
  patchState(
    {
      fabUserHidden: true,
      isOpen: false,
      isMinimized: false,
      meetingRoomOpen: false,
      meetingActiveSpeaker: '',
    },
    { persistUi: true },
  )
  const shortcut = formatShortcutDisplay(getShortcutBinding('toggleXiaomiAssistant'))
  toast(`小V 已隐藏 · 按 ${shortcut} 可再显示`, 'info')
}

function onFabContextMenu(e) {
  if (!(e.target instanceof Element) || !_root) return
  const fab = e.target.closest('.xm-fab')
  if (!fab || !_root.contains(fab)) return
  e.preventDefault()
  e.stopPropagation()
  cancelFabOpenTimer()
  closeFabContextMenu()

  const menu = document.createElement('div')
  menu.id = 'xm-fab-context-menu'
  menu.className = 'xm-fab-menu'
  menu.setAttribute('role', 'menu')
  menu.innerHTML = `
    <button type="button" class="xm-fab-menu-item" role="menuitem" data-fab-menu="hide">隐藏悬浮球</button>
    <button type="button" class="xm-fab-menu-item" role="menuitem" data-fab-menu="reset-pos">恢复默认位置</button>
  `
  const x = Math.min(e.clientX, window.innerWidth - 180)
  const y = Math.min(e.clientY, window.innerHeight - 96)
  menu.style.left = `${Math.max(8, x)}px`
  menu.style.top = `${Math.max(8, y)}px`
  document.body.appendChild(menu)

  menu.addEventListener('click', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('[data-fab-menu]') : null
    if (!btn) return
    const act = btn.getAttribute('data-fab-menu')
    if (act === 'hide') hideFabByUser()
    else if (act === 'reset-pos') {
      closeFabContextMenu()
      resetFabPosition()
      toast('已恢复默认位置', 'success')
    }
  })

  window.setTimeout(() => {
    document.addEventListener('pointerdown', onFabMenuOutside, true)
  }, 0)
}

function onFabPointerDown(e) {
  if (!(e.target instanceof Element) || !_root) return
  const fab = e.target.closest('.xm-fab')
  if (!fab || !_root.contains(fab) || e.button > 0) return
  const rect = fab.getBoundingClientRect()
  _fabDrag = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    originLeft: rect.left,
    originTop: rect.top,
    moved: false,
  }
  try {
    fab.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
}

function onFabPointerMove(e) {
  if (!_fabDrag || e.pointerId !== _fabDrag.pointerId || !_root) return
  const fab = _root.querySelector('.xm-fab')
  if (!fab) return
  const dx = e.clientX - _fabDrag.startX
  const dy = e.clientY - _fabDrag.startY
  if (!_fabDrag.moved && Math.hypot(dx, dy) < FAB_DRAG_THRESHOLD) return
  if (!_fabDrag.moved) {
    _fabDrag.moved = true
    fab.classList.add('xm-fab--dragging')
  }
  e.preventDefault()
  setFabPosition(_fabDrag.originLeft + dx, _fabDrag.originTop + dy, { persist: false })
}

function onFabPointerUp(e) {
  if (!_fabDrag || e.pointerId !== _fabDrag.pointerId) return
  const fab = _root?.querySelector('.xm-fab')
  const moved = _fabDrag.moved
  _fabDrag = null
  if (fab) {
    fab.classList.remove('xm-fab--dragging')
    try {
      fab.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  if (moved) {
    cancelFabOpenTimer()
    _suppressFabOpen = true
    const st = getState()
    if (Number.isFinite(st.fabLeft) && Number.isFinite(st.fabTop)) {
      setFabPosition(st.fabLeft, st.fabTop, { persist: true })
    }
  }
}

function onFabDblClick(e) {
  if (!(e.target instanceof Element) || !_root) return
  const fab = e.target.closest('.xm-fab')
  if (!fab || !_root.contains(fab)) return
  e.preventDefault()
  e.stopPropagation()
  cancelFabOpenTimer()
  _suppressFabOpen = true
  resetFabPosition()
  toast('已恢复默认位置', 'success')
}

function onFabWindowResize() {
  const st = getState()
  if (!Number.isFinite(st.fabLeft) || !Number.isFinite(st.fabTop)) return
  setFabPosition(st.fabLeft, st.fabTop, { persist: true })
}

function onHashChange() {
  if (shouldHideAssistant()) {
    render()
    return
  }
  // Restore context pin when route changes
  if (!getState().contextPinned) patchState({ contextPinned: true, contextOverride: null })
  // 切入任意页且面板已开：保持对话工作栏
  if (getState().isOpen && isWorkbenchDock()) {
    const st = getState()
    if (st.activeView === 'dashboard' || st.activeView === 'agents' || st.activeView === 'delegate') {
      patchState({ activeView: 'chat', selectedContact: 'xiaomi' }, { persistUi: true, silent: true })
    }
  }
  // 预热页面快照，避免「先问我在哪」仍读到上一页的 session context
  void syncXiaomiPageContext().catch(() => {})
  render()
}

/**
 * Mount once under document.body（勿挂 #app：overflow 可能裁切 fixed 悬浮球）.
 * Safe to call repeatedly.
 */
export function mountGlobalAssistant() {
  const host = document.body
  if (!host) return null

  if (_root && host.contains(_root)) {
    // 热重载 / 再次挂载：强制回到右下角悬浮球
    patchState(
      {
        meetingRoomOpen: false,
        meetingActiveSpeaker: '',
        isOpen: false,
        isMinimized: false,
        fabLeft: null,
        fabTop: null,
      },
      { silent: true, persistUi: true },
    )
    _root.hidden = false
    render()
    return _root
  }

  // 残留节点（HMR / 旧挂载点）清掉
  document.getElementById('xiaomi-global-assistant')?.remove()

  _root = document.createElement('div')
  _root.id = 'xiaomi-global-assistant'
  _root.className = 'xm-root'
  host.appendChild(_root)

  // 启动一律显示悬浮球：清面板 UI / 会议室视图 / 自定义位置（拖出屏外）。
  // 注意：不清 meetingId/meetingTurnId/meetingParticipants —— 它们是刷新后恢复会议的凭据，
  // 若后端会议仍在进行，挂载完成后会据此重挂会议室并恢复轮询。
  patchState(
    {
      meetingRoomOpen: false,
      meetingActiveSpeaker: '',
      isOpen: false,
      isMinimized: false,
      fabLeft: null,
      fabTop: null,
    },
    { silent: true, persistUi: true },
  )

  _root.addEventListener('click', onRootClick)
  _root.addEventListener('change', onRootChange)
  _root.addEventListener('submit', onRootSubmit)
  _root.addEventListener('input', onRootInput)
  _root.addEventListener('keydown', onRootKeydown)
  _root.addEventListener('pointerdown', onFabPointerDown)
  _root.addEventListener('pointermove', onFabPointerMove)
  _root.addEventListener('pointerup', onFabPointerUp)
  _root.addEventListener('pointercancel', onFabPointerUp)
  _root.addEventListener('dblclick', onFabDblClick)
  _root.addEventListener('contextmenu', onFabContextMenu)

  registerXiaomiVoiceSendHandler(async (text) => {
    await handleXiaomiVoiceTranscript(text)
  })
  registerXiaomiVoicePartialHandler((partial) => {
    if (shouldHideAssistant()) return
    if (getState().fabUserHidden) {
      patchState({ fabUserHidden: false }, { persistUi: true })
    }
    if (!getState().isOpen) openPanel()
    setContactDraft('xiaomi', String(partial || ''), { silent: true })
    patchState({ activeView: 'chat', selectedContact: 'xiaomi', draft: String(partial || '') }, { persistUi: true, silent: true })
    const ta = _root?.querySelector('[data-draft]')
    if (ta instanceof HTMLTextAreaElement) ta.value = String(partial || '')
  })

  if (!_routeBound) {
    window.addEventListener('hashchange', onHashChange)
    window.addEventListener('keydown', onGlobalKeydown)
    window.addEventListener('resize', onFabWindowResize)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !shouldHideAssistant()) {
        void refreshDashboard()
        void refreshXiaomiObsEnabled()
      }
    })
    _routeBound = true
  }
  if (_unsub) _unsub()
  _unsub = subscribe(() => render())

  render()
  void refreshXiaomiObsEnabled()
  schedulePoll()
  // 刷新后恢复会议室：后端会议仍在进行（meetingId 非空）时，重挂会议室并恢复轮询，
  // 避免用户体感「开会中途被踢出」。
  const _st = getState()
  if (_st.meetingId && !_st.meetingRoomOpen) {
    patchState({ meetingRoomOpen: true, activeView: 'meeting', isOpen: true, isMinimized: false }, { persistUi: true })
    _meetingPollStart = Date.now()
    startMeetingPoll()
  }
  if (_visibilityCleanup) _visibilityCleanup()
  _visibilityCleanup = setupVisibilityPause()
  if (!shouldHideAssistant()) {
    void refreshDashboard()
    if (getState().isOpen) {
      void ensureXiaomiSession().then(() => bindXiaomiStreamListener()).catch(() => {})
    }
  }
  return _root
}

export function unmountGlobalAssistant() {
  destroyAiRoundtableMount()
  unmountXiaomiPanelReactHosts()
  closeFabContextMenu()
  if (_pollTimer) clearInterval(_pollTimer)
  if (_meetingPollTimer) { clearInterval(_meetingPollTimer); _meetingPollTimer = null }
  _pollTimer = null
  if (_liveProcess) {
    try {
      _liveProcess.destroy()
    } catch {
      /* ignore */
    }
    _liveProcess = null
  }
  if (_unsub) _unsub()
  _unsub = null
  if (_visibilityCleanup) { _visibilityCleanup(); _visibilityCleanup = null }
  unregisterXiaomiVoiceSendHandler()
  unregisterXiaomiVoicePartialHandler()
  if (_root) {
    _root.remove()
    _root = null
  }
}
