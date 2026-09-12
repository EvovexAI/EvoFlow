import {
  defaultLayoutForKind,
  defaultTitleForKind,
  normalizeRightStageKind,
  type RightStageKind,
  type RightStageStreamChunk,
  type RightStageStreamSession,
  type RightStageSurface,
} from './right-stage-types.js'

export type RightStageSnapshot = {
  surface: RightStageSurface | null
  rev: number
  streams: Map<string, RightStageStreamSession>
}

type Listener = () => void

const MAX_STREAM_CHUNKS = 800
const MAX_STREAM_CHARS = 120_000

function emptySnapshot(): RightStageSnapshot {
  return { surface: null, rev: 0, streams: new Map() }
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
  private surface: RightStageSurface | null = null
  private rev = 0
  private streams = new Map<string, RightStageStreamSession>()
  private listeners = new Set<Listener>()
  private cachedSnapshot: RightStageSnapshot = emptySnapshot()

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private rebuildSnapshot() {
    const streams = new Map<string, RightStageStreamSession>()
    for (const [id, session] of this.streams) {
      streams.set(id, {
        ...session,
        chunks: session.chunks.map((c) => ({ ...c })),
      })
    }
    this.cachedSnapshot = {
      surface: this.surface ? { ...this.surface, data: { ...this.surface.data } } : null,
      rev: this.rev,
      streams,
    }
  }

  getSnapshot(): RightStageSnapshot {
    return this.cachedSnapshot
  }

  get isOpen(): boolean {
    return this.surface !== null
  }

  get currentKind(): RightStageKind | null {
    return this.surface?.kind ?? null
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
      if (this.surface?.kind === 'artifacts') this.hide()
      return
    }
    const next: RightStageSurface = {
      id: String(input.id || 'primary').trim() || 'primary',
      kind,
      title: input.title?.trim() || defaultTitleForKind(kind),
      layout: input.layout || defaultLayoutForKind(kind),
      data: { ...(input.data || {}) },
    }
    const prev = this.surface
    if (
      prev &&
      prev.id === next.id &&
      prev.kind === next.kind &&
      prev.title === next.title &&
      prev.layout === next.layout &&
      JSON.stringify(prev.data) === JSON.stringify(next.data)
    ) {
      return
    }
    this.surface = next
    this.bump()
  }

  updateData(patch: Record<string, unknown>, opts?: { id?: string }) {
    if (!this.surface) return
    if (opts?.id && this.surface.id !== opts.id) return
    const merged = { ...this.surface.data, ...patch }
    if (JSON.stringify(merged) === JSON.stringify(this.surface.data)) return
    this.surface = { ...this.surface, data: merged }
    this.bump()
  }

  hide(id = 'primary') {
    if (!this.surface) return
    if (this.surface.id !== id) return
    this.surface = null
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
    let session = this.streams.get(streamId)
    if (!session) {
      session = { streamId, format: 'plain', chunks: [], closed: false }
      this.streams.set(streamId, session)
    }
    const body = String(chunk.text ?? '')
    if (body || chunk.newline === false) {
      session.chunks.push({
        text: body,
        newline: chunk.newline !== false,
        level: chunk.level || 'info',
        streamId,
      })
      trimStreamSession(session)
    }
    session.closed = false
    this.bump()
  }

  clearStream(streamId = 'default') {
    const id = String(streamId || 'default').trim() || 'default'
    const session = this.streams.get(id)
    if (!session) return
    session.chunks = []
    session.closed = false
    this.bump()
  }

  closeStream(streamId = 'default') {
    const id = String(streamId || 'default').trim() || 'default'
    const session = this.streams.get(id)
    if (!session) return
    session.closed = true
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
      if (this.surface?.kind === 'artifacts') this.hide()
      return
    }
    const surfNorm = { ...surf, kind: normalizedKind }
    if (action === 'update') {
      if (!this.surface) {
        this.show({
          kind: surfNorm.kind,
          id: surfNorm.id,
          title: surfNorm.title,
          layout: surfNorm.layout,
          data: surfNorm.data || {},
        })
      } else {
        this.surface = {
          ...this.surface,
          ...surfNorm,
          data: { ...this.surface.data, ...(surfNorm.data || {}) },
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
  const current = rightStageStore.getSnapshot().surface?.kind
  const normalized = kinds.map((k) => normalizeRightStageKind(k))
  if (current && normalized.includes(current)) {
    rightStageStore.hide()
  }
}
