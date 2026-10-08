import {
  defaultLayoutForKind,
  defaultTitleForKind,
  normalizeRightStageKind,
  type RightStageKind,
  type RightStageStreamChunk,
  type RightStageStreamSession,
  type RightStageSurface,
} from './right-stage-types.js'

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
  rev: number
  streams: Map<string, RightStageStreamSession>
  /** 最近关闭的标签（倒序，最新在前）。 */
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
  private rev = 0
  private streams = new Map<string, RightStageStreamSession>()
  private recentClosed: RecentClosedRightStageTab[] = []
  private listeners = new Set<Listener>()
  private cachedSnapshot: RightStageSnapshot = emptySnapshot()

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
      rev: this.rev,
      streams,
      recentClosed: this.recentClosed,
    }
  }

  getSnapshot(): RightStageSnapshot {
    return this.cachedSnapshot
  }

  get isOpen(): boolean {
    return this.tabs.length > 0
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
  }) {
    const kind = normalizeRightStageKind(String(input.kind || '').trim())
    if (!kind) return
    // 产物改由侧栏 Info Rail 呈报，禁止占用 Right Stage
    if (kind === 'artifacts') {
      const existingArtifacts = this.tabs.find((t) => t.kind === 'artifacts')
      if (existingArtifacts) {
        this.tabs = this.tabs.filter((t) => t !== existingArtifacts)
        if (this.activeKey === this.tabKeyOf(existingArtifacts)) this.activeKey = null
        this.bump()
      }
      return
    }
    const next: RightStageSurface = {
      id: String(input.id || 'primary').trim() || 'primary',
      kind,
      title: input.title?.trim() || defaultTitleForKind(kind),
      layout: input.layout || defaultLayoutForKind(kind),
      data: { ...(input.data || {}) },
    }
    const key = this.tabKeyOf(next)
    const existingIdx = this.tabs.findIndex((t) => this.tabKeyOf(t) === key)
    if (existingIdx >= 0) {
      const prev = this.tabs[existingIdx]
      const same =
        prev.title === next.title &&
        prev.layout === next.layout &&
        JSON.stringify(prev.data) === JSON.stringify(next.data)
      if (same) {
        // 仅激活
        if (this.activeKey !== key) {
          this.activeKey = key
          this.bump()
        }
        return
      }
      this.tabs[existingIdx] = next
    } else {
      this.tabs = [...this.tabs, next]
    }
    this.activeKey = key
    this.bump()
  }

  activateTab(key: string) {
    if (this.activeKey === key) return
    if (!this.tabs.some((t) => this.tabKeyOf(t) === key)) return
    this.activeKey = key
    this.bump()
  }

  closeTab(key: string) {
    const target = this.tabs.find((t) => this.tabKeyOf(t) === key)
    const idx = this.tabs.findIndex((t) => this.tabKeyOf(t) === key)
    if (idx < 0) return
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
    this.show({ kind: entry.tab.kind, id: entry.tab.id, title: entry.tab.title, layout: entry.tab.layout, data: entry.tab.data })
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
    const matches = this.tabs.filter((t) => t.id === id)
    if (!matches.length) {
      // 兼容旧调用：id 默认 'primary' 但激活标签可能用了其他 id——关闭激活者
      if (this.activeKey) {
        const active = this.tabs.find((t) => this.tabKeyOf(t) === this.activeKey)
        if (active && active.id === id) {
          this.recordClosed(this.tabKeyOf(active), active)
          this.tabs = this.tabs.filter((t) => t !== active)
          this.activeKey = this.tabs.length ? this.tabKeyOf(this.tabs[this.tabs.length - 1]) : null
          this.bump()
        }
      }
      return
    }
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

  clearStreams() {
    if (this.streams.size === 0) return
    this.streams.clear()
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
    this.bump()
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

export function hideRightStageIfKind(...kinds: string[]) {
  const kindsNorm = kinds.map((k) => normalizeRightStageKind(k))
  const matching = rightStageStore.getSnapshot().tabs.filter((t) =>
    kindsNorm.includes(String(t.kind)),
  )
  for (const t of matching) rightStageStore.closeTab(`${t.kind}:${t.id}`)
}
