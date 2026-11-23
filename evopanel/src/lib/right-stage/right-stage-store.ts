import {
  defaultLayoutForKind,
  defaultTitleForKind,
  normalizeOpenedBy,
  normalizeRightStageKind,
  type RightStageKind,
  type RightStageStreamChunk,
  type RightStageStreamSession,
  type RightStageSurface,
} from './right-stage-types.js'
import { getCurrentRightStageSessionKey, resolveTabSessionKey, scopeOfKind } from './right-stage-scope.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'
import { isProgressStageKind } from './open-progress-from-panel-set.js'
import { logPanelSet, logRightStage } from './panel-set-debug-log.js'
import { reportRightStageState } from './right-stage-state-report.js'

/** RUN_FINISHED / 平台 toast 收栏时不得拆掉的 kind（用户还要盯进度 / 浏览器）。 */
function isProtectedIdleHideKind(kind: string | null | undefined): boolean {
  const k = normalizeRightStageKind(kind)
  return k === 'browser' || k === 'xiaomi' || isProgressStageKind(k)
}

export type RecentClosedRightStageTab = {
  /** 关闭前的 tab key（`${kind}:${id}`），用于 reopen。 */
  key: string
  tab: RightStageSurface
  closedAt: number
}

export type RightStageSnapshot = {
  /** 激活标签的投影——所有旧消费者按"单 surface"读取，保持零改动兼容。 */
  surface: RightStageSurface | null
  /** 打开的标签（有序）；标签条 UI 直接消费。 */
  tabs: RightStageSurface[]
  activeKey: string | null
  /**
   * ZCode 同构：折叠只藏面板，不丢 tabs。
   * 展开且 tabs 为空时显示「打开标签」首页。
   */
  collapsed: boolean
  rev: number
  streams: Map<string, RightStageStreamSession>
  /** 最近关闭的标签（倒序，最新在前）。 */
  recentClosed: RecentClosedRightStageTab[]
}

/** 按会话冻结的侧栏快照（切会话时换出 / 换回）。 */
export type RightStageSessionMemory = {
  tabs: RightStageSurface[]
  activeKey: string | null
  collapsed: boolean
  recentClosed: RecentClosedRightStageTab[]
  /**
   * 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
   * 用户是否**主动**收起（收起锁）。必须与 ``collapsed`` 分开存：
   * ``collapsed`` 是"现在收没收"，可能只是因为当时没标签；
   * ``userCollapsed`` 是"用户亲手收的，别再自动撑开"。
   * 旧版本没存这个字段，读回按 false 处理（宁可多展开一次，也不永久锁死）。
   */
  userCollapsed?: boolean
}

type Listener = () => void

const MAX_STREAM_CHUNKS = 800
const MAX_STREAM_CHARS = 120_000
/** 最近关闭标签保留条数；与标签总览弹层的展示需求一致。 */
const MAX_RECENT_CLOSED = 10

function emptySnapshot(): RightStageSnapshot {
  return {
    surface: null,
    tabs: [],
    activeKey: null,
    collapsed: true,
    rev: 0,
    streams: new Map(),
    recentClosed: [],
  }
}

function trimStreamSession(session: RightStageStreamSession) {
  while (session.chunks.length > MAX_STREAM_CHUNKS) session.chunks.shift()
  let total = session.chunks.reduce((n, c) => n + String(c.text || '').length + 1, 0)
  while (total > MAX_STREAM_CHARS && session.chunks.length > 1) {
    const removed = session.chunks.shift()
    total -= String(removed?.text || '').length + 1
  }
}

export class RightStageStore {
  /** 打开的标签（有序）。ZCode 式：多面板共存，激活者投影为 surface。 */
  private tabs: RightStageSurface[] = []
  private activeKey: string | null = null
  /**
   * 用户点过某个标签（或显式 forceExpand 打开）后钉住该 key。
   * 后续截图/生图等 auto show 只更新签、不得把 active 抢回去——否则像「点了 tab / 小V 没反应」。
   */
  private userPinnedActiveKey: string | null = null
  /** 默认折叠；用户点侧栏按钮或 show() 时展开。 */
  private collapsed = true
  /**
   * 用户点过「收起」：在用户再次 expand 前，show/activate/同签更新不得偷偷撑开。
   * 否则流式写签 / 平台 autoOpen 会把刚收起的栏立刻弹回，表现为收起钮「没反应」。
   */
  private userCollapsed = false
  private rev = 0
  private streams = new Map<string, RightStageStreamSession>()
  private recentClosed: RecentClosedRightStageTab[] = []
  private listeners = new Set<Listener>()
  private cachedSnapshot: RightStageSnapshot = emptySnapshot()
  /** appendStream 合并到下一帧再通知订阅者，避免每 token 重绘整栏（文件预览跟着抖）。 */
  private streamNotifyRaf = 0

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private tabKeyOf(surface: RightStageSurface): string {
    return `${surface.kind}:${surface.id}`
  }

  /**
   * 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
   * 改了什么：把 tab key 计算暴露成公开方法 `keyOf(surface)`。
   * 为什么：`tabKeyOf` 是 private，而 SSE 分发侧（right-stage-agui）需要算出
   *   「关签前后 tabCount 变没变、其它签 key 有没有被动」来做**真判据**。
   *   为了拿这个判据去复制一份 `${kind}:${id}` 到别处，等于把规则写两遍，
   *   下次改了这里、漏了那里就是新的「同一目标塌成两个 key」缺陷。
   */
  keyOf(surface: RightStageSurface): string {
    return this.tabKeyOf(surface)
  }

  /** 记录最近关闭：同 key 再次关闭时去重并置顶，避免总览里出现重复行。 */
  private recordClosed(key: string, tab: RightStageSurface) {
    this.recentClosed = [
      { key, tab, closedAt: Date.now() },
      ...this.recentClosed.filter((entry) => entry.key !== key),
    ].slice(0, MAX_RECENT_CLOSED)
  }

  private rebuildSnapshot() {
    const active =
      this.tabs.find((t) => this.tabKeyOf(t) === this.activeKey) ?? this.tabs[this.tabs.length - 1] ?? null
    this.activeKey = active ? this.tabKeyOf(active) : null
    const streams = new Map<string, RightStageStreamSession>()
    for (const [id, session] of this.streams) {
      streams.set(id, {
        ...session,
        chunks: session.chunks.map((c) => ({ ...c })),
      })
    }
    this.cachedSnapshot = {
      surface: active ? { ...active, data: { ...active.data } } : null,
      tabs: this.tabs.map((t) => ({ ...t, data: { ...t.data } })),
      activeKey: this.activeKey,
      collapsed: this.collapsed,
      rev: this.rev,
      streams,
      recentClosed: this.recentClosed.map((e) => ({
        ...e,
        tab: { ...e.tab, data: { ...e.tab.data } },
      })),
    }
  }

  getSnapshot(): RightStageSnapshot {
    return this.cachedSnapshot
  }

  /** 面板是否占布局宽度（与 tabs 是否为空无关）。 */
  get isOpen(): boolean {
    return !this.collapsed
  }

  setCollapsed(collapsed: boolean) {
    if (this.collapsed === collapsed) return
    this.collapsed = collapsed
    // 显式折叠 = 用户意图；显式展开清掉，允许后续 auto show 再撑开。
    this.userCollapsed = collapsed
    this.bump()
  }

  expand() {
    this.userCollapsed = false
    this.setCollapsed(false)
  }

  collapse() {
    logRightStage(
      'store.collapse',
      { from: this.collapsed, userCollapsed: true },
      { stack: true, store: this },
    )
    this.userCollapsed = true
    if (this.collapsed) {
      // 已折叠时也要钉住意图，否则同签 show() 仍会再撑开。
      return
    }
    this.collapsed = true
    this.bump()
  }

  toggleCollapsed() {
    if (this.collapsed) this.expand()
    else this.collapse()
  }

  /** 用户是否仍锁定收起（自动开栏应尊重）。 */
  get isUserCollapsed(): boolean {
    return this.userCollapsed
  }

  /** 尝试展开：用户收起锁定时返回 false，不改状态。 */
  expandUnlessUserCollapsed(): boolean {
    if (this.userCollapsed) {
      logRightStage(
        'store.expandUnlessUserCollapsed blocked',
        { userCollapsed: true },
        { store: this },
      )
      return false
    }
    this.expand()
    return true
  }

  /** 导出当前会话可冻结的侧栏状态（不含 streams）。 */
  exportSessionMemory(): RightStageSessionMemory {
    return {
      // workspace 级标签不参与会话冻结：它们由切会话时的 carry-over 传递，
      // 否则每个会话都存一份相同副本，40 条 LRU 很快被吃满。
      // task-center:* 归属任务详情宿主，也不写入对话会话记忆，避免串台。
      tabs: this.tabs
        .filter((t) => scopeOfKind(t.kind) !== 'workspace')
        .filter((t) => !isTaskCenterStageSessionKey(t.sessionKey))
        .map((t) => ({ ...t, data: { ...t.data } })),
      activeKey: this.activeKey,
      collapsed: this.collapsed,
      // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：把用户主动收起锁一并冻结到会话记忆里。
      // 为什么：下面 importSessionMemory 原本用 ``userCollapsed = this.collapsed``
      //   从"现在收没收"倒推"用户是否锁了"，于是任何一次被动收起（比如当时没标签）
      //   都会被记成用户意图，切回来以后所有 autoOpen 被永久挡住 ——
      //   这就是右栏"再也不自动展开"的语义根因。只有真的存下来才谈得上尊重用户。
      userCollapsed: this.userCollapsed,
      recentClosed: this.recentClosed
        .filter((e) => !isTaskCenterStageSessionKey(e.tab?.sessionKey))
        .map((e) => ({
          ...e,
          tab: { ...e.tab, data: { ...e.tab.data } },
        })),
    }
  }

  /**
   * 切会话时整表换入；streams 按会话清空以免串台。
   *
   * `options.carryTabs` 用于把 workspace 级标签（文件树 / 写入 / 思维导图 / 工作流）
   * 带到新会话：它们不属于任何一条会话，切过去仍该看得见。
   * 这些标签不会出现在被换出的会话记忆里（见 exportSessionMemory），
   * 所以不会随会话数量线性膨胀。
   *
   * `options.collapsedWhenNoMemory` 决定"目标会话从未打开过右栏"时的折叠态，
   * 对齐 ZCode：有可见的 workspace 级标签就展开，否则保持收起。
   */
  importSessionMemory(
    memory: RightStageSessionMemory | null | undefined,
    options?: { carryTabs?: readonly RightStageSurface[]; collapsedWhenNoMemory?: boolean },
  ) {
    const carried = (options?.carryTabs ?? []).map((t) => ({
      ...t,
      data: { ...(t.data || {}) },
    }))
    if (!memory) {
      this.tabs = carried
      this.activeKey = carried.length ? this.tabKeyOf(carried[carried.length - 1]!) : null
      this.collapsed =
        typeof options?.collapsedWhenNoMemory === 'boolean'
          ? options.collapsedWhenNoMemory
          : carried.length === 0
      // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：无记忆分支不再把"现在收没收"当成"用户锁了"。
      // 为什么：``collapsed`` 只是当前视觉状态（新会话没标签时它天然是 true），
      //   拿它当收起锁会让下一次 ui.show 也被挡住。切过来的新会话从"未锁定"开始，
      //   由 ``collapse()`` / ``setCollapsed(true)`` 这种**用户手势**去设锁。
      this.userCollapsed = false
      this.recentClosed = []
      this.streams.clear()
      this.bump()
      return
    }
    // 边界 normalize：旧版本/异常写入的脏数据在这里统一收敛，
    // 否则切回该会话会渲染出空壳或重复标签（ZCode 同样在状态边界做这一步）。
    const restored: RightStageSurface[] = []
    const seenKeys = new Set<string>()
    for (const raw of memory.tabs) {
      const kind = normalizeRightStageKind(raw?.kind)
      // 未注册/空 kind 直接丢弃：渲染只会得到 UnknownStageKind。
      if (!kind || kind === 'artifacts') continue
      const tab: RightStageSurface = {
        id: String(raw.id || 'primary').trim() || 'primary',
        kind,
        ...(raw.title ? { title: raw.title } : {}),
        layout: raw.layout || defaultLayoutForKind(kind),
        data: { ...(raw.data || {}) },
        ...(raw.sessionKey ? { sessionKey: raw.sessionKey } : {}),
      }
      const key = this.tabKeyOf(tab)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      restored.push(tab)
    }
    // 会话记忆里理论上不含 workspace 级标签；万一旧数据带了也不重复插入。
    const merged = [...restored, ...carried.filter((t) => !seenKeys.has(this.tabKeyOf(t)))]
    this.tabs = merged
    // activeKey 可能指向已被 normalize 掉的标签，回退到末尾。
    const restoredActive =
      memory.activeKey && merged.some((t) => this.tabKeyOf(t) === memory.activeKey)
        ? memory.activeKey
        : null
    this.activeKey = restoredActive ?? (merged.length ? this.tabKeyOf(merged[merged.length - 1]!) : null)
    this.collapsed =
      typeof memory.collapsed === 'boolean' ? memory.collapsed : this.tabs.length === 0
    // 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：有记忆分支改为读回**冻结时的用户意图**，读不到才回落 false。
    // 为什么：这里原本也是 ``userCollapsed = this.collapsed`` —— 同一个错误：
    //   把"这份记忆当时是收着的"当成"用户亲手锁了"。旧版本记忆没有该字段，
    //   按 false 处理：宁可多自动展开一次，也不要让右栏永久打不开。
    //   用户在会话里主动收起的意图，由 exportSessionMemory 显式存下来。
    this.userCollapsed = memory.userCollapsed === true
    this.recentClosed = Array.isArray(memory.recentClosed) ? memory.recentClosed : []
    this.streams.clear()
    this.bump()
  }

  get currentKind(): RightStageKind | null {
    return (this.tabs.find((t) => this.tabKeyOf(t) === this.activeKey)?.kind ?? null) as RightStageKind | null
  }

  private bump() {
    this.rev += 1
    this.rebuildSnapshot()
    // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：每次右栏状态变化，把「用户当前在看的签」上报给后端（节流 400ms）。
    // 为什么（用户 2026-11-20 指出）：模型要开面板时**根本不知道用户此刻右栏停在哪一页**。
    //   `grep activeKey backend --include=*.py` 命中 0 次 —— 这份状态此前只活在前端内存里。
    //   后果：用户正盯着一份文档/一个员工进程，模型再 ui.show 一个东西就直接把视线抢走；
    //   或者反过来，该复用的那一页被新开成第二个签。
    // 判据：上报必须是「状态真的变了」才发（bump 是唯一收敛点），且失败静默——
    //   上报通道绝不能反过来影响 UI。
    reportRightStageState(this.cachedSnapshot)
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        /* ignore */
      }
    }
  }

  show(input: {
    kind: RightStageKind
    id?: string
    title?: string
    layout?: RightStageSurface['layout']
    data?: Record<string, unknown>
    sessionKey?: string
    /**
     * 用户显式打开（点文件 pill / 编辑卡 / 文件树 / 小V）时为 true：
     * 清掉收起锁并展开，同时钉住该签。自动开栏（截图、生图）不要传，
     * 以免顶掉用户「收起」或把已切走的 active 抢回去。
     */
    forceExpand?: boolean
    /**
     * 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
     * 改了什么：新增「谁打开的」。创建签时定死，后续同签 show/update **不覆盖**。
     * 为什么：用户要求标签上能看出是用户 / 某个智能体 / 某条会话打开的，避免串台。
     * 判据：缺省兜底成 `session:<当前会话>`（拿不到 sessionKey 时干脆不写，
     *   不猜），绝不默认成 `user` —— 那会把模型自动开的签谎报成用户亲手开的。
     */
    openedBy?: string
  }) {
    const kind = normalizeRightStageKind(String(input.kind || '').trim())
    if (!kind) {
      logPanelSet('④ store.show：kind 为空，忽略')
      return
    }
    const forceExpand = Boolean(input.forceExpand)
    if (forceExpand) this.userCollapsed = false
    // 产物改由侧栏 Info Rail 呈报，禁止占用 Right Stage
    if (kind === 'artifacts') {
      logPanelSet('④ store.show：拒绝挂 artifacts 标签（设计如此，应走文件预览/状态卡）')
      const existingArtifacts = this.tabs.find((t) => t.kind === 'artifacts')
      if (existingArtifacts) {
        this.tabs = this.tabs.filter((t) => t !== existingArtifacts)
        if (this.activeKey === this.tabKeyOf(existingArtifacts)) this.activeKey = null
        this.bump()
      }
      return
    }
    // 归属在创建时定死（对齐 ZCode stampSidePaneTabsOwnership）：
    // 显式传入优先；否则 workspace 级 kind 不写归属（各会话共享），
    // 会话级 kind 冻结当前 UI 会话，避免"忘了传 → 对所有会话可见 → 串台"。
    const sessionKey = resolveTabSessionKey(
      kind,
      input.sessionKey,
      getCurrentRightStageSessionKey(),
    )
    // 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
    // 「谁打开的」在创建时定死（对齐 sessionKey 的盖戳时机）：
    //   显式传入优先 → 没有则按归属会话兜底成 `session:<key>` → 连会话都没有就不写。
    // 不兜成 'user'：模型自动开的签被标成用户亲手开，正是用户要防的那种串台。
    const openedBy =
      normalizeOpenedBy(input.openedBy) ||
      (sessionKey ? (`session:${sessionKey}` as const) : '')
    const next: RightStageSurface = {
      id: String(input.id || 'primary').trim() || 'primary',
      kind,
      title: input.title?.trim() || defaultTitleForKind(kind),
      layout: input.layout || defaultLayoutForKind(kind),
      data: { ...(input.data || {}) },
      ...(sessionKey ? { sessionKey } : {}),
      ...(openedBy ? { openedBy } : {}),
    }
    const key = this.tabKeyOf(next)
    const pinned = this.userPinnedActiveKey
    const pinAlive =
      Boolean(pinned) &&
      pinned !== key &&
      this.tabs.some((t) => this.tabKeyOf(t) === pinned)
    // 用户已钉在别的签上：auto show 只写签不抢 active；显式 forceExpand 仍可抢走并改钉。
    const shouldActivate = forceExpand || !pinAlive
    const existingIdx = this.tabs.findIndex((t) => this.tabKeyOf(t) === key)
    if (existingIdx >= 0) {
      const prev = this.tabs[existingIdx]
      // 更新时：只有调用方显式传入非空 sessionKey 才改归属。
      // 否则保留原签归属——resolveTabSessionKey(当前 UI 会话) 会在 current 抖动时
      // 把 browser:primary 改成别的 key，过滤后表现为「第一签突然消失」。
      const explicitSk = String(input.sessionKey || '').trim()
      if (explicitSk) next.sessionKey = explicitSk
      else if (prev.sessionKey) next.sessionKey = prev.sessionKey
      else delete next.sessionKey
      // 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
      // 「谁打开的」创建时定死：已有值一律**不覆盖**（否则同签被别的 agent update 一次，
      // 归属就被改写成后者，溯源当场失真）。只在空缺时补一次，
      // 补的是老会话记忆里没有该字段的存量签（回填后仍以首次真值为准）。
      if (prev.openedBy) next.openedBy = prev.openedBy
      else if (!next.openedBy) delete next.openedBy
      const same =
        prev.title === next.title &&
        prev.layout === next.layout &&
        prev.sessionKey === next.sessionKey &&
        prev.openedBy === next.openedBy &&
        JSON.stringify(prev.data) === JSON.stringify(next.data)
      if (same) {
        // 仅激活；用户收起锁定时不偷偷展开（forceExpand 除外）
        const needActivate = shouldActivate && this.activeKey !== key
        const needExpand = this.collapsed && (forceExpand || !this.userCollapsed)
        if (needActivate) {
          this.activeKey = key
          if (forceExpand) this.userPinnedActiveKey = key
        }
        if (needExpand) this.collapsed = false
        if (needActivate || needExpand) this.bump()
        return
      }
      this.tabs[existingIdx] = next
    } else {
      this.tabs = [...this.tabs, next]
    }
    if (shouldActivate) {
      this.activeKey = key
      if (forceExpand) this.userPinnedActiveKey = key
    }
    // 打开/激活标签：用户未锁收起时才展开；显式打开（forceExpand）始终撑开。
    if (forceExpand || !this.userCollapsed) this.collapsed = false
    logPanelSet('④ store.show 已写入', {
      key,
      kind,
      title: next.title,
      sessionKey: next.sessionKey || '(空)',
      openedBy: next.openedBy || '(未标)',
      tabCount: this.tabs.length,
      collapsed: this.collapsed,
      userCollapsed: this.userCollapsed,
      forceExpand,
      activated: shouldActivate,
      pinned: this.userPinnedActiveKey || '(无)',
    })
    this.bump()
  }

  findTab(key: string): RightStageSurface | null {
    const k = String(key || '').trim()
    const tab = this.tabs.find((t) => this.tabKeyOf(t) === k)
    return tab ? { ...tab, data: { ...tab.data } } : null
  }

  /** 只改标题/data，不激活、不展开。用于浏览器页标题和图标回写外层标签。 */
  patchTab(key: string, patch: { title?: string; data?: Record<string, unknown> }): boolean {
    const k = String(key || '').trim()
    const idx = this.tabs.findIndex((t) => this.tabKeyOf(t) === k)
    if (idx < 0) return false
    const prev = this.tabs[idx]
    const title = patch.title !== undefined ? patch.title.trim() || prev.title : prev.title
    const data = patch.data ? { ...prev.data, ...patch.data } : prev.data
    if (prev.title === title && JSON.stringify(prev.data) === JSON.stringify(data)) return false
    const nextTabs = this.tabs.slice()
    nextTabs[idx] = { ...prev, title, data }
    this.tabs = nextTabs
    this.bump()
    return true
  }

  /** 关闭除 keepKey 外的全部标签（写入 recentClosed）。 */
  closeOtherTabs(keepKey: string) {
    const keep = String(keepKey || '').trim()
    if (!keep) return
    const victims = this.tabs.filter((t) => this.tabKeyOf(t) !== keep)
    if (!victims.length) return
    for (const tab of victims) this.recordClosed(this.tabKeyOf(tab), tab)
    this.tabs = this.tabs.filter((t) => this.tabKeyOf(t) === keep)
    this.activeKey = this.tabs.length ? keep : null
    this.userPinnedActiveKey = this.activeKey
    this.bump()
  }

  /** 关闭全部标签（写入 recentClosed），不强制折叠（折叠由外壳按钮负责）。 */
  closeAllTabs() {
    if (!this.tabs.length) return
    for (const tab of this.tabs) this.recordClosed(this.tabKeyOf(tab), tab)
    this.tabs = []
    this.activeKey = null
    this.userPinnedActiveKey = null
    this.bump()
  }

  activateTab(key: string) {
    if (!this.tabs.some((t) => this.tabKeyOf(t) === key)) return
    // 用户点标签 / 总览：钉住，挡住随后截图 auto show 抢回。
    this.userPinnedActiveKey = key
    const needActivate = this.activeKey !== key
    const needExpand = this.collapsed && !this.userCollapsed
    if (!needActivate && !needExpand) {
      // 已在该签也要 bump，确保 pin 变更被订阅者看到（否则同签再点像没钉住）。
      this.bump()
      return
    }
    if (needActivate) this.activeKey = key
    if (needExpand) this.collapsed = false
    this.bump()
  }

  closeTab(key: string) {
    this._removeTab(key, { remember: true })
  }

  /**
   * 实体已删除：关掉标签且不进「最近关闭」，避免用户从总览再打开已失效页。
   */
  discardTab(key: string) {
    this._removeTab(key, { remember: false })
  }

  private _removeTab(key: string, opts: { remember: boolean }) {
    const target = this.tabs.find((t) => this.tabKeyOf(t) === key)
    const idx = this.tabs.findIndex((t) => this.tabKeyOf(t) === key)
    if (idx < 0) {
      // 仍可能留在 recentClosed（例如上次手动关过）
      if (!opts.remember) {
        const before = this.recentClosed.length
        this.recentClosed = this.recentClosed.filter((e) => e.key !== key)
        if (this.recentClosed.length !== before) this.bump()
      }
      return
    }
    logRightStage(
      opts.remember ? 'store.closeTab' : 'store.discardTab',
      { key, kind: target?.kind, id: target?.id },
      { stack: true, store: this },
    )
    if (opts.remember && target) this.recordClosed(key, target)
    else this.recentClosed = this.recentClosed.filter((e) => e.key !== key)
    const wasActive = this.activeKey === key
    const wasPinned = this.userPinnedActiveKey === key
    this.tabs = this.tabs.filter((t) => this.tabKeyOf(t) !== key)
    if (wasActive) {
      this.activeKey = this.tabs.length ? this.tabKeyOf(this.tabs[this.tabs.length - 1]) : null
    }
    if (wasPinned) {
      this.userPinnedActiveKey = this.activeKey
    }
    // 关到最后一个标签：整栏收起，不要落回「打开标签」启动页
    if (!this.tabs.length && !this.collapsed) {
      this.collapsed = true
      this.userCollapsed = true
      this.userPinnedActiveKey = null
    }
    this.bump()
  }

  /**
   * 拖拽排序：把 activeId 移到 overId 的位置。
   * 命中自身或任一端缺失时静默返回——拖拽结束事件在越界落点也会触发。
   */
  reorderTab(activeId: string, overId: string) {
    if (activeId === overId) return
    const from = this.tabs.findIndex((t) => this.tabKeyOf(t) === activeId)
    const to = this.tabs.findIndex((t) => this.tabKeyOf(t) === overId)
    if (from < 0 || to < 0) return
    const next = [...this.tabs]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    if (
      next.length === this.tabs.length &&
      next.every((t, i) => this.tabKeyOf(t) === this.tabKeyOf(this.tabs[i]))
    ) {
      return
    }
    this.tabs = next
    this.bump()
  }

  /** 重新打开最近关闭的标签（总览弹层调用）；已存在则直接激活。 */
  reopenClosedTab(key: string) {
    const entry = this.recentClosed.find((e) => e.key === key)
    if (!entry) return
    this.recentClosed = this.recentClosed.filter((e) => e.key !== key)
    // 总览里点「重新打开」= 用户显式意图：撑开并钉住该签。
    this.show({
      kind: entry.tab.kind,
      id: entry.tab.id,
      title: entry.tab.title,
      layout: entry.tab.layout,
      data: entry.tab.data,
      sessionKey: entry.tab.sessionKey,
      forceExpand: true,
    })
  }

  updateData(patch: Record<string, unknown>, opts?: { id?: string }) {
    const target =
      (opts?.id
        ? this.tabs.find((t) => t.id === opts.id)
        : this.tabs.find((t) => this.tabKeyOf(t) === this.activeKey)) ?? null
    if (!target) return
    const merged = { ...target.data, ...patch }
    if (JSON.stringify(merged) === JSON.stringify(target.data)) return
    this.tabs = this.tabs.map((t) =>
      this.tabKeyOf(t) === this.tabKeyOf(target) ? { ...t, data: merged } : t,
    )
    this.bump()
  }

  /** 关闭激活标签（或指定 surface.id 的标签）；剩余标签自动补位激活。 */
  hide(id = 'primary') {
    logRightStage(
      'store.hide:enter',
      { requestedId: id },
      { stack: true, store: this },
    )
    const matches = this.tabs.filter((t) => t.id === id)
    if (!matches.length) {
      // 兼容旧调用：id 默认 'primary' 但激活标签可能用了其他 id——
      // 关闭激活者（而不是要求 active.id === id，避免 id 不一致导致静默不关）。
      // 工作流 id 是 workflow:{taskId} 不是 primary：RUN_FINISHED 的 hide() 会走到这里，
      // 若误关 collab-workflow，表现为「对话一结束侧栏自己没了」。
      if (this.activeKey) {
        const active = this.tabs.find((t) => this.tabKeyOf(t) === this.activeKey)
        if (active) {
          if (isProtectedIdleHideKind(active.kind)) {
            logRightStage('store.hide:KEEP protected active (no id match)', {
              kind: active.kind,
              id: active.id,
              requestedId: id,
            }, { store: this })
            return
          }
          logRightStage('store.hide:REMOVE active (fallback, no id match)', {
            kind: active.kind,
            id: active.id,
            requestedId: id,
          }, { stack: true, store: this })
          this.recordClosed(this.tabKeyOf(active), active)
          this.tabs = this.tabs.filter((t) => t !== active)
          this.activeKey = this.tabs.length ? this.tabKeyOf(this.tabs[this.tabs.length - 1]) : null
          this.bump()
        }
      }
      return
    }
    // 显式 id 命中进度签时也拒绝（idle hide 不该拆工作流；用户关签走 closeTab）
    if (matches.some((t) => isProtectedIdleHideKind(t.kind))) {
      logRightStage('store.hide:KEEP protected matched ids', {
        ids: matches.map((t) => t.id),
        kinds: matches.map((t) => t.kind),
        requestedId: id,
      }, { store: this })
      return
    }
    logRightStage('store.hide:REMOVE matched', {
      ids: matches.map((t) => t.id),
      kinds: matches.map((t) => t.kind),
      requestedId: id,
    }, { stack: true, store: this })
    const wasActive = matches.some((t) => this.tabKeyOf(t) === this.activeKey)
    const removedKeys = new Set(matches.map((t) => this.tabKeyOf(t)))
    for (const t of matches) {
      this.recordClosed(this.tabKeyOf(t), t)
    }
    this.tabs = this.tabs.filter((t) => !removedKeys.has(this.tabKeyOf(t)))
    if (wasActive) {
      this.activeKey = this.tabs.length ? this.tabKeyOf(this.tabs[this.tabs.length - 1]) : null
    }
    this.bump()
  }

  /**
   * 回合结束收栏：有进度/浏览器签则整栏保留；否则才 hide。
   * 供 RUN_FINISHED / 平台条目发布使用，避免误拆工作流。
   */
  hideUnlessProgressOpen(): boolean {
    const protectedOpen = this.tabs.some((t) => isProtectedIdleHideKind(t.kind))
    if (protectedOpen) {
      logRightStage('store.hideUnlessProgressOpen:KEEP', {}, { store: this })
      return false
    }
    logRightStage('store.hideUnlessProgressOpen:HIDE', {}, { stack: true, store: this })
    this.hide()
    return true
  }

  clearStreams() {
    if (this.streams.size === 0) return
    this.streams.clear()
    this.bump()
  }

  /**
   * 清空全部标签（写入 recentClosed）并折叠。
   * 日常「收起侧栏」应走 collapse()，保留 tabs 缓存。
   */
  hideAll() {
    if (this.tabs.length === 0 && this.activeKey === null && this.collapsed) return
    logRightStage('store.hideAll', {}, { stack: true, store: this })
    for (const tab of this.tabs) {
      this.recordClosed(this.tabKeyOf(tab), tab)
    }
    this.tabs = []
    this.activeKey = null
    this.userPinnedActiveKey = null
    this.collapsed = true
    this.userCollapsed = true
    this.bump()
  }

  openStream(input: {
    streamId: string
    format?: RightStageStreamSession['format']
    path?: string
    title?: string
  }) {
    const streamId = String(input.streamId || 'default').trim() || 'default'
    const existing = this.streams.get(streamId)
    const session: RightStageStreamSession = existing || {
      streamId,
      format: input.format || 'plain',
      path: input.path,
      title: input.title,
      chunks: [],
      closed: false,
    }
    if (input.format) session.format = input.format
    if (input.path !== undefined) session.path = input.path
    if (input.title !== undefined) session.title = input.title
    session.closed = false
    this.streams.set(streamId, session)
    this.bump()
  }

  appendStream(chunk: RightStageStreamChunk) {
    const streamId = String(chunk.streamId || 'default').trim() || 'default'
    const existing = this.streams.get(streamId)
    if (!existing) return
    existing.chunks = [...existing.chunks, { ...chunk }]
    trimStreamSession(existing)
    // 内容已写入 session；快照延到 rAF 合并，减少对话流式时侧栏抖动
    if (this.streamNotifyRaf) return
    this.streamNotifyRaf = requestAnimationFrame(() => {
      this.streamNotifyRaf = 0
      this.bump()
    })
  }

  closeStream(streamId: string) {
    const id = String(streamId || 'default').trim() || 'default'
    const existing = this.streams.get(id)
    if (!existing) return
    existing.closed = true
    this.bump()
  }

  clearStream(streamId: string) {
    const id = String(streamId || 'default').trim() || 'default'
    const existing = this.streams.get(id)
    if (!existing) return
    existing.chunks = []
    existing.closed = false
    this.bump()
  }

  getStream(streamId = 'default'): RightStageStreamSession | null {
    const id = String(streamId || 'default').trim() || 'default'
    return this.cachedSnapshot.streams.get(id) ?? null
  }

  /** Apply AG-UI / SSE payload from backend panel_set. */
  applyRemote(payload: {
    action?: string
    surface?: Partial<RightStageSurface> | null
    key?: string
    stream?: RightStageStreamChunk & { action?: string; format?: string; path?: string; title?: string }
  }) {
    const action = String(payload.action || '').trim().toLowerCase()
    // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：把 activate 接在 hide 判断**之前**（下面那条判据是
    //   `action === 'hide' || payload.surface === null`，而 activate 天然没有 surface）。
    // 为什么：同型缺陷本轮已在 right-stage-agui.ts 撞过一次 —— activate 带 surface:null
    //   会被当成「收起右栏」，用户点切签反而整个面板关掉。这里当前虽未走到，
    //   但入口语义必须一致，不能让下一个人重踩。
    if (action === 'activate') {
      const k = String(payload.key || '').trim()
      if (k) this.activateTab(k)
      return
    }
    if (action === 'hide' || payload.surface === null) {
      // 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：``ui.hide`` 落到 store 时改调 ``collapse()``（整栏收起、签全部保留），
      //   不再调 ``hide()``（那是"关掉一个标签"）。
      // 为什么（本轮真机实测抓到的真缺陷，10:29:30 起 24 秒无任何前端上报）：
      //   工具文档写「ui.hide 整栏收起、签还在」，但 applyRemote 把 hide 派给 store.hide()，
      //   而 store.hide() 的语义是"关激活那一个签"。更糟的是它先 filter(t => t.id === 'primary')，
      //   shell-page 的 id 是 ``shell:/tasks`` 根本不含 'primary'，于是走 fallback 分支，
      //   命中 ``isProtectedIdleHideKind``（shell-page 属 isProgressStageKind）→ 直接 return。
      //   结果：右栏纹丝不动、标签一个不少、collapsed 仍为 false，而工具回 ``ok:true``。
      //   证据：10:29:30.041 ``[py] emit sent action=hide`` 之后再无 ``[web-state] report``，
      //   状态盘停在 collapsed=false / tabs=2；对比 ui.show 每次都能 400ms 内成对上报。
      // 判据：收起是"面板占位消失"这件事，只有 collapse() 能表达；关单个签请走 ui.close。
      logRightStage('store.applyRemote:hide → collapse', { action, surfaceNull: payload.surface === null }, {
        stack: true,
        store: this,
      })
      this.collapse()
      return
    }
    if (payload.stream) {
      const s = payload.stream
      const streamAction = String(s.action || action || 'write').toLowerCase()
      if (streamAction === 'open' || streamAction === 'clear') {
        this.openStream({
          streamId: s.streamId,
          format: (payload.stream as { format?: RightStageStreamSession['format'] }).format,
          path: (payload.stream as { path?: string }).path,
          title: (payload.stream as { title?: string }).title,
        })
        if (streamAction === 'clear') this.clearStream(s.streamId)
      } else if (streamAction === 'close') {
        this.closeStream(s.streamId)
      } else {
        this.appendStream(s)
      }
      // 远端流事件只灌内容，不自动拉开侧栏（写入/修改工具不再自动打开右侧面板）
      return
    }
    const surf = payload.surface
    if (!surf?.kind) return
    const normalizedKind = normalizeRightStageKind(surf.kind)
    if (!normalizedKind) return
    // 产物改由侧栏 Info Rail 呈报
    if (normalizedKind === 'artifacts') {
      this.show({ kind: 'artifacts' })
      return
    }
    const surfNorm = { ...surf, kind: normalizedKind }
    if (action === 'update') {
      const key = `${normalizedKind}:${String(surfNorm.id || 'primary').trim() || 'primary'}`
      const existing = this.tabs.find((t) => this.tabKeyOf(t) === key)
      if (!existing) {
        this.show({
          kind: surfNorm.kind,
          id: surfNorm.id,
          title: surfNorm.title,
          layout: surfNorm.layout,
          data: surfNorm.data || {},
          openedBy: surfNorm.openedBy,
          forceExpand: surfNorm.expand === true,
        })
      } else {
        // 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
        // update 分支同样不许改「谁打开的」：同签被别的 agent update 一次就改归属，
        // 溯源等于作废。先把 payload 里的 openedBy 剔掉，只在存量签空缺时补一次。
        const { openedBy: incomingOpenedBy, ...surfNoOpened } = surfNorm as
          RightStageSurface & Record<string, unknown>
        const backfill = existing.openedBy
          ? ''
          : normalizeOpenedBy(incomingOpenedBy) ||
            (existing.sessionKey ? (`session:${existing.sessionKey}` as const) : '')
        this.tabs = this.tabs.map((t) =>
          this.tabKeyOf(t) === key
            ? {
                ...t,
                ...surfNoOpened,
                data: { ...t.data, ...(surfNorm.data || {}) },
                ...(t.openedBy
                  ? { openedBy: t.openedBy }
                  : backfill
                    ? { openedBy: backfill }
                    : {}),
              }
            : t,
        )
        // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：update 分支不再无条件抢焦点，改成与 show() 同一套 pinAlive 判据
        //   （用户已钉在别的签上且该签还活着 → 只更新内容，不切 active；
        //    显式 expand=true 仍然可以抢）。
        // 为什么：用户场景是「我让另一个 AI 干活，右栏实时显示，我还要能接着跟它聊」。
        //   实测 `employees.chat_send` 打开「发版工程师」后 active 正确，但约 10 秒后
        //   自己跳到「任务」标签——因为同会话里 shell-page 之类的面板持续发 update，
        //   而这里 `if (this.activeKey !== key) this.activeKey = key` 是无条件的，
        //   任何一个面板刷新都把人正在看的对话抢走，续聊当场断掉。
        //   与 show() 的 shouldActivate = forceExpand || !pinAlive 对齐后，
        //   后台刷新只灌内容，不再夺走视线。
        const updatePinned = this.userPinnedActiveKey
        const updatePinAlive =
          Boolean(updatePinned) &&
          updatePinned !== key &&
          this.tabs.some((t) => this.tabKeyOf(t) === updatePinned)
        const updateCanSteal = surfNorm.expand === true || !updatePinAlive
        if (updateCanSteal && this.activeKey !== key) {
          this.activeKey = key
        }
        // 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：update 分支也要认 expand，撑开被用户收起的右栏。
        // 为什么：`ui.update` 走这条分支，原先即使带了 expand 也不会展开，
        // 与 show 分支行为不一致。
        if (surfNorm.expand === true) {
          this.userCollapsed = false
          this.collapsed = false
          this.userPinnedActiveKey = key
        }
        this.bump()
      }
      return
    }
    this.show({
      kind: surfNorm.kind,
      id: surfNorm.id,
      title: surfNorm.title,
      layout: surfNorm.layout,
      data: surfNorm.data || {},
      // 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】
      // 改了什么：SSE 下来的 surface 也带上 openedBy（后端 platform 工具按 ambient
      // actor 盖章），前端不再把它当"无来源"。
      // 为什么：这条是智能体打开面板的主通路；不带就等于所有模型开的签都退回会话兜底，
      // 用户看到的全是「会话：xxx」而分不出是哪个智能体在动他的右栏。
      openedBy: surfNorm.openedBy,
      // 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：applyRemote 把 surface.expand 映射为 show() 的 forceExpand。
      // 为什么：此前 applyRemote 调 show() 从不传 forceExpand，导致
      // `ui.show` 在用户收起右栏时只写标签不展开 —— 工具回 ok、用户看不见。
      forceExpand: surfNorm.expand === true,
    })
  }
}

/** Process-wide default store (per-tab). Session scoping stays in ChatApp wiring. */
export const rightStageStore = new RightStageStore()

// Main-panel CDP getState() reads this without dynamic import (ExecuteScript is sync).
try {
  ;(window as Window & { __evoflowRightStageStore?: RightStageStore }).__evoflowRightStageStore =
    rightStageStore
} catch {
  /* ignore */
}

/** 只关掉匹配 kind 的标签；不能再 hideAll，否则会把其它 kind 一并清掉。 */
export function hideRightStageIfKind(...kinds: string[]) {
  const kindsNorm = kinds.map((k) => normalizeRightStageKind(k)).filter(Boolean)
  if (!kindsNorm.length) return
  const matching = rightStageStore
    .getSnapshot()
    .tabs.filter((t) => kindsNorm.includes(normalizeRightStageKind(String(t.kind))))
  logRightStage(
    'hideRightStageIfKind',
    {
      kinds: kindsNorm,
      matching: matching.map((t) => ({ id: t.id, kind: t.kind })),
    },
    { stack: true, store: rightStageStore },
  )
  for (const t of matching) {
    rightStageStore.closeTab(`${normalizeRightStageKind(t.kind)}:${t.id}`)
  }
}
