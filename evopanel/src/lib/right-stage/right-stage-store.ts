import {
  defaultLayoutForKind,
  defaultTitleForKind,
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

/** RUN_FINISHED / 平台 toast 收栏时不得拆掉的 kind（用户还要盯进度 / 浏览器）。 */
function isProtectedIdleHideKind(kind: string | null | undefined): boolean {
  const k = normalizeRightStageKind(kind)
  return k === 'browser' || isProgressStageKind(k)
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
  /** 默认折叠；用户点侧栏按钮或 show() 时展开。 */
  private collapsed = true
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
    this.bump()
  }

  expand() {
    this.setCollapsed(false)
  }

  collapse() {
    logRightStage('store.collapse', { from: this.collapsed }, { stack: true, store: this })
    this.setCollapsed(true)
  }

  toggleCollapsed() {
    this.setCollapsed(!this.collapsed)
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
  }) {
    const kind = normalizeRightStageKind(String(input.kind || '').trim())
    if (!kind) {
      logPanelSet('④ store.show：kind 为空，忽略')
      return
    }
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
    const next: RightStageSurface = {
      id: String(input.id || 'primary').trim() || 'primary',
      kind,
      title: input.title?.trim() || defaultTitleForKind(kind),
      layout: input.layout || defaultLayoutForKind(kind),
      data: { ...(input.data || {}) },
      ...(sessionKey ? { sessionKey } : {}),
    }
    const key = this.tabKeyOf(next)
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
      const same =
        prev.title === next.title &&
        prev.layout === next.layout &&
        prev.sessionKey === next.sessionKey &&
        JSON.stringify(prev.data) === JSON.stringify(next.data)
      if (same) {
        // 仅激活并展开（侧栏可能处于折叠）
        const needActivate = this.activeKey !== key
        const needExpand = this.collapsed
        if (needActivate) this.activeKey = key
        if (needExpand) this.collapsed = false
        if (needActivate || needExpand) this.bump()
        return
      }
      this.tabs[existingIdx] = next
    } else {
      this.tabs = [...this.tabs, next]
    }
    this.activeKey = key
    // 打开/激活任一标签时必须展开侧栏，否则用户看不到新页
    this.collapsed = false
    logPanelSet('④ store.show 已展开', {
      key,
      kind,
      title: next.title,
      sessionKey: next.sessionKey || '(空)',
      tabCount: this.tabs.length,
      collapsed: this.collapsed,
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
    this.bump()
  }

  /** 关闭全部标签（写入 recentClosed），不强制折叠（折叠由外壳按钮负责）。 */
  closeAllTabs() {
    if (!this.tabs.length) return
    for (const tab of this.tabs) this.recordClosed(this.tabKeyOf(tab), tab)
    this.tabs = []
    this.activeKey = null
    this.bump()
  }

  activateTab(key: string) {
    if (!this.tabs.some((t) => this.tabKeyOf(t) === key)) return
    const needActivate = this.activeKey !== key
    const needExpand = this.collapsed
    if (!needActivate && !needExpand) return
    if (needActivate) this.activeKey = key
    if (needExpand) this.collapsed = false
    this.bump()
  }

  closeTab(key: string) {
    const target = this.tabs.find((t) => this.tabKeyOf(t) === key)
    const idx = this.tabs.findIndex((t) => this.tabKeyOf(t) === key)
    if (idx < 0) return
    logRightStage(
      'store.closeTab',
      { key, kind: target?.kind, id: target?.id },
      { stack: true, store: this },
    )
    if (target) this.recordClosed(key, target)
    const wasActive = this.activeKey === key
    this.tabs = this.tabs.filter((t) => this.tabKeyOf(t) !== key)
    if (wasActive) {
      this.activeKey = this.tabs.length ? this.tabKeyOf(this.tabs[this.tabs.length - 1]) : null
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
    this.show({
      kind: entry.tab.kind,
      id: entry.tab.id,
      title: entry.tab.title,
      layout: entry.tab.layout,
      data: entry.tab.data,
      sessionKey: entry.tab.sessionKey,
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
    this.collapsed = true
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
    stream?: RightStageStreamChunk & { action?: string; format?: string; path?: string; title?: string }
  }) {
    const action = String(payload.action || '').trim().toLowerCase()
    if (action === 'hide' || payload.surface === null) {
      logRightStage('store.applyRemote:hide', { action, surfaceNull: payload.surface === null }, {
        stack: true,
        store: this,
      })
      this.hide()
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
        })
      } else {
        this.tabs = this.tabs.map((t) =>
          this.tabKeyOf(t) === key
            ? { ...t, ...surfNorm, data: { ...t.data, ...(surfNorm.data || {}) } }
            : t,
        )
        if (this.activeKey !== key) {
          this.activeKey = key
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
    })
  }
}

/** Process-wide default store (per-tab). Session scoping stays in ChatApp wiring. */
export const rightStageStore = new RightStageStore()

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
