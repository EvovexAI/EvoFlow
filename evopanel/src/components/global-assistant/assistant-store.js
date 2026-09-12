/**
 * 小V面板本地状态（UI 持久化；聊天摘要会话由内存 + 可选后端）
 */
const LS_KEY = 'evopanel_xiaomi_assistant_v1'

function loadPersisted() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

function savePersisted(partial) {
  try {
    const cur = loadPersisted()
    localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...partial }))
  } catch {
    /* ignore */
  }
}

/** @type {Set<(s: ReturnType<typeof getState>) => void>} */
const listeners = new Set()

const state = {
  isOpen: false,
  isExpanded: false,
  isMinimized: false,
  activeView: 'dashboard', // dashboard | chat | meeting（agents/delegate 兼容跳转）
  /** 微信式联系人：'xiaomi' | agent_code */
  selectedContact: 'xiaomi',
  /** 左轨折叠为仅头像 */
  sidebarCollapsed: false,
  /** @type {Record<string, string>} */
  draftByContact: {},
  sessionKey: '',
  unreadReadIds: /** @type {string[]} */ ([]),
  draft: '',
  contextPinned: true,
  contextOverride: /** @type {null | Record<string, string>} */ (null),
  summary: null,
  attentionItems: [],
  activeTasks: [],
  recentCompletions: [],
  suggestedActions: [],
  agents: [],
  approvals: [],
  messages: [],
  streaming: false,
  loading: false,
  error: '',
  partialUnavailable: false,
  lastFetchedAt: 0,
  badgeCount: 0,
  /** 与员工岗 xiaomi 同源：飞书 PersonalAgent 是否已绑 */
  feishuBound: false,
  /** 顶栏「⋯」菜单是否展开（内存态） */
  headerMoreOpen: false,
  /** 顶栏历史会话下拉是否展开 */
  sessionHistoryOpen: false,
  /** @type {Array<{ key: string, title: string, updatedAt: number, messageCount: number }>} */
  xiaomiSessions: [],
  xiaomiSessionsLoading: false,
  /** @type {null | { code: string, busy: boolean, openTasks: array, reports: array, fetchedAt: number }} */
  employeeThread: null,
  /** @type {Record<string, array>} 员工会话本地「已委派」气泡（不写值班 transcript） */
  employeeLocalMsgs: {},
  // 群聊会议状态（内存态，不持久化）
  meetingId: '',
  meetingParticipants: [],
  meetingMessages: [],
  meetingTopic: '',
  meetingSending: false,
  meetingPolling: false,
  meetingTurnId: '',
  meetingError: '',
  meetingConcluding: false,
  /** @type {null | { summary?: string, plan?: string, asset_path?: string, asset_entity_type?: string, asset_entity_id?: string, steps?: string[], risks?: string[] }} */
  meetingConclusion: null,
  /** 全屏 AI员工聊天室是否打开 */
  meetingRoomOpen: false,
  /** 当前正在汇报的 agent_code */
  meetingActiveSpeaker: '',
  /** 本轮讨论话题（展示用） */
  meetingCurrentTopic: '',
  /** 点名汇报目标 agent_code 列表（可多选）；空=全员讨论 */
  meetingMentionTargets: [],
  /** 录屏 / 专注模式：放大舞台、隐藏侧栏 */
  meetingCreatorMode: false,
  /** 右侧实时讨论面板是否折叠 */
  meetingTranscriptCollapsed: false,
  /** 会议室 TTS 是否静音（顶栏音量键；默认静音，需用户点开） */
  meetingTtsMuted: true,
  /** 本轮讨论是否允许员工短工具查证（只读任务/资产） */
  meetingAllowTools: false,
  /** @type {number | null} 悬浮球自定义 left（px）；null 表示默认右下角 */
  fabLeft: null,
  /** @type {number | null} 悬浮球自定义 top（px） */
  fabTop: null,
  /** 用户主动隐藏悬浮球（右键菜单）；Ctrl+Shift+M 可恢复 */
  fabUserHidden: false,
  /**
   * 面板布局偏好：
   * - auto：默认右侧 dock（边缘条入口）
   * - dock：始终右侧独立区域
   * - float：旧版悬浮窗（⋯ 菜单可切回）
   */
  panelLayoutPref: 'auto',
  /** 已关闭的边缘引导 tip id 列表 */
  coachDismissed: /** @type {string[]} */ ([]),
  /** 上次展示边缘引导的时间戳 */
  coachShownAt: 0,
  /** 运维观测开启时才显示「调试」（与主对话侧栏同源） */
  obsEnabled: false,
  ...(() => {
    const p = loadPersisted()
    const fl = Number(p.fabLeft)
    const ft = Number(p.fabTop)
    const fabLeft = Number.isFinite(fl) ? fl : null
    const fabTop = Number.isFinite(ft) ? ft : null
    const contact = typeof p.selectedContact === 'string' && p.selectedContact.trim() ? p.selectedContact.trim() : 'xiaomi'
    const drafts =
      p.draftByContact && typeof p.draftByContact === 'object' && !Array.isArray(p.draftByContact)
        ? p.draftByContact
        : {}
    // 会议最小上下文（用于刷新后恢复讨论）：meetingId 非空表示后端会议仍在进行。
    const meetingId = typeof p.meetingId === 'string' ? p.meetingId : ''
    const meetingTurnId = typeof p.meetingTurnId === 'string' ? p.meetingTurnId : ''
    const meetingParticipants = Array.isArray(p.meetingParticipants) ? p.meetingParticipants : []
    const layoutPref =
      p.panelLayoutPref === 'dock' || p.panelLayoutPref === 'float' || p.panelLayoutPref === 'auto'
        ? p.panelLayoutPref
        : 'auto'
    const coachDismissed = Array.isArray(p.coachDismissed)
      ? p.coachDismissed.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 40)
      : []
    return {
      // 不恢复「面板已打开」：刷新后回到右侧边缘条入口
      isOpen: false,
      isExpanded: Boolean(p.isExpanded),
      // meeting 视图：仅当后端会议仍在进行（meetingId 非空）才恢复；
      // 否则（含刷新后只剩残留 meeting 视图、无会议上下文）降级回 dashboard，避免卡在空会议室。
      activeView:
        typeof p.activeView === 'string' && p.activeView !== 'knowledge'
          ? meetingId && p.activeView === 'meeting'
            ? 'meeting'
            : p.activeView === 'meeting'
              ? 'dashboard'
              : p.activeView
          : 'dashboard',
      selectedContact: contact,
      sidebarCollapsed: Boolean(p.sidebarCollapsed),
      draftByContact: drafts,
      unreadReadIds: Array.isArray(p.unreadReadIds) ? p.unreadReadIds : [],
      draft: typeof p.draft === 'string' ? p.draft : typeof drafts.xiaomi === 'string' ? drafts.xiaomi : '',
      sessionKey: typeof p.sessionKey === 'string' ? p.sessionKey : '',
      meetingId,
      meetingTurnId,
      meetingParticipants,
      fabLeft,
      fabTop,
      fabUserHidden: Boolean(p.fabUserHidden),
      panelLayoutPref: layoutPref,
      coachDismissed,
    }
  })(),
}

export function getState() {
  return state
}

/** 小V 悬浮球是否被用户隐藏（设置页开关用；false = 显示） */
export function isFabUserHidden() {
  return !!state.fabUserHidden
}

/**
 * 设置小V 悬浮球显示/隐藏。
 * @param {boolean} hidden true=隐藏，false=显示
 */
export function setFabUserHidden(hidden) {
  const next = !!hidden
  if (next) {
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
    return
  }
  patchState({ fabUserHidden: false }, { persistUi: true })
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(state)
    } catch (e) {
      console.warn('[xiaomi-assistant] subscriber', e)
    }
  }
}

export function patchState(partial, { persistUi = false, silent = false } = {}) {
  Object.assign(state, partial)
  if (persistUi) {
    savePersisted({
      // isOpen 不再持久化：刷新后始终回到悬浮球，避免「主界面看不到球」
      isExpanded: state.isExpanded,
      activeView: state.activeView,
      selectedContact: state.selectedContact,
      sidebarCollapsed: state.sidebarCollapsed,
      draftByContact: state.draftByContact,
      unreadReadIds: state.unreadReadIds,
      draft: state.draft,
      sessionKey: state.sessionKey,
      // 会议最小上下文：刷新后凭 meetingId 重挂轮询恢复讨论。
      meetingId: state.meetingId,
      meetingTurnId: state.meetingTurnId,
      meetingParticipants: state.meetingParticipants,
      fabLeft: state.fabLeft,
      fabTop: state.fabTop,
      fabUserHidden: !!state.fabUserHidden,
      panelLayoutPref: state.panelLayoutPref || 'auto',
      coachDismissed: Array.isArray(state.coachDismissed) ? state.coachDismissed.slice(0, 40) : [],
    })
  }
  if (!silent) emit()
}

export function markAttentionRead(id) {
  const sid = String(id || '').trim()
  if (!sid) return
  if (state.unreadReadIds.includes(sid)) return
  patchState({ unreadReadIds: [...state.unreadReadIds, sid].slice(-200) }, { persistUi: true })
}

export function isAttentionRead(id) {
  return state.unreadReadIds.includes(String(id || '').trim())
}

/** 当前联系人草稿（小V 同步到 draft 字段以兼容语音） */
export function getContactDraft(contact = state.selectedContact) {
  const key = String(contact || 'xiaomi').trim() || 'xiaomi'
  const map = state.draftByContact || {}
  if (key === 'xiaomi') {
    if (typeof map.xiaomi === 'string') return map.xiaomi
    return typeof state.draft === 'string' ? state.draft : ''
  }
  return typeof map[key] === 'string' ? map[key] : ''
}

export function setContactDraft(contact, text, { silent = true } = {}) {
  const key = String(contact || 'xiaomi').trim() || 'xiaomi'
  const value = String(text ?? '')
  const map = { ...(state.draftByContact || {}), [key]: value }
  const partial =
    key === 'xiaomi'
      ? { draftByContact: map, draft: value }
      : { draftByContact: map }
  patchState(partial, { persistUi: true, silent })
}
