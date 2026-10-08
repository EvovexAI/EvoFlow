/**
 * ZCode v4 风格 SessionDataLayer。
 *
 * 不复制 ZCode 190 行的 keep-warm/e2e/transport；H2.5 才做 verbatim。
 *
 * - 首个 ``acquire(sid)`` 触发 subscribe → 拿到 subscriptionId。
 * - 每帧 frame 通过 ``onFrame`` 注入对应 store（store 自己 handleFrame）。
 * - 引用计数：最后一个 release 等 30s 后才真正 close（防拖拽/切 pane 抖动）。
 * - 单 host connection 共享给所有 session（与 ZCode 同语义）。
 */

import {
  ConversationProjectionStore,
  type ProjectionStatus,
} from './conversationProjectionStore'
import type { ConversationTopicFrame } from './protocol/types'

export interface SessionLease {
  readonly sessionId: string
  readonly store: ConversationProjectionStore
  /** Open kind：cold (首次 subscribe) / warm / keep_warm。H1 demo 未启用。 */
  readonly openKind: 'cold' | 'warm' | 'keep_warm'
  readonly startedAt: number
  release(): void
}

export interface SessionDataLayerOptions {
  /** Function that 触发新 topic 的 subscribe,返回 subscriptionId + logEpoch。 */
  subscribe: (sessionId: string) => Promise<{ subscriptionId: string; logEpoch: string }>
  /** Function that 主动 unsubscribe (called when keep-warm expires). */
  unsubscribe?: (subscriptionId: string) => Promise<void>
  /** Number of ms to wait after last release before closing the store. */
  keepWarmMs?: number
  /**
   * Frame dispatcher: 给定 topic 推一帧 frame. 由 transport 层注册（见 onFrame）.
   * EvoFlow 的 H1 demo SSE 走 own dispatcher.
   */
  onFrame?: (sessionId: string, frame: ConversationTopicFrame) => void
}

const DEFAULT_KEEP_WARM_MS = 30_000

interface SessionEntry {
  store: ConversationProjectionStore
  refCount: number
  keepWarmTimer: ReturnType<typeof setTimeout> | null
  subscriptionId: string | null
}

export class SessionDataLayer {
  private readonly entries = new Map<string, SessionEntry>()
  private readonly subscribe: SessionDataLayerOptions['subscribe']
  private readonly unsubscribe: SessionDataLayerOptions['unsubscribe']
  private readonly keepWarmMs: number
  private readonly onFrame: ((sessionId: string, frame: ConversationTopicFrame) => void) | null
  private disposed = false

  constructor(opts: SessionDataLayerOptions) {
    this.subscribe = opts.subscribe
    this.unsubscribe = opts.unsubscribe
    this.keepWarmMs = opts.keepWarmMs ?? DEFAULT_KEEP_WARM_MS
    this.onFrame = opts.onFrame ?? null
  }

  /** Active (含 keep-warm 中) session 数。 */
  get size(): number {
    return this.entries.size
  }

  /**
   * 取得 session 的 projection store。首个引用触发 subscribe;
   * 后续 acquire 共享同一 store (pane 多视图).
   */
  async acquire(sessionId: string): Promise<SessionLease> {
    if (this.disposed) {
      throw new Error('SessionDataLayer 已释放，不能再 acquire')
    }
    const startedAt = monotonicNow()
    let entry = this.entries.get(sessionId)
    let openKind: SessionLease['openKind']

    if (entry) {
      openKind = entry.keepWarmTimer !== null ? 'keep_warm' : 'warm'
      entry.refCount++
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer)
        entry.keepWarmTimer = null
      }
    } else {
      const store = new ConversationProjectionStore({
        topic: sessionId,
        initial: {
          status: 'connecting' as ProjectionStatus,
          snapshot: null,
          lastError: null,
          subscriptionId: null,
          optimisticCommands: [],
          recoveryDeadline: null,
        },
      })
      entry = { store, refCount: 1, keepWarmTimer: null, subscriptionId: null }
      this.entries.set(sessionId, entry)
      openKind = 'cold'

      // 异步 subscribe; 失败落在 store 状态里（status=error）,不在这里抛.
      try {
        const { subscriptionId, logEpoch } = await this.subscribe(sessionId)
        entry.subscriptionId = subscriptionId
        // 把 subscriptionId 写入 store state（即便 frame 还没来）
        store.ackSubscribe(subscriptionId, logEpoch, 'snapshot')
      } catch (err) {
        store.setError(`subscribe failed: ${String(err)}`)
      }
    }

    let released = false
    return {
      sessionId,
      store: entry.store,
      openKind,
      startedAt,
      release: () => {
        if (released) return
        released = true
        this._releaseEntry(sessionId)
      },
    }
  }

  /**
   * 手动注入 frame。EvoFlow H1 demo SSE 消费层在每次 fetch 时调一次。
   * 真实场景下，transport 层注册一个 ``(frame) => entries[frame.subscriptionId]`` 路由，
   * store 自己处理。
   */
  injectFrame(frame: ConversationTopicFrame): void {
    if (this.onFrame) {
      this.onFrame(frame.subscriptionId, frame)
      return
    }
    // 默认行为: 按 subscriptionId 找到 store.
    for (const entry of this.entries.values()) {
      if (entry.subscriptionId === frame.subscriptionId) {
        entry.store.handleFrame(frame)
        return
      }
    }
  }

  /** 主动 close 一个 session. */
  closeSession(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId)
    if (entry.keepWarmTimer) clearTimeout(entry.keepWarmTimer)
    void this.unsubscribe?.(entry.subscriptionId ?? '').catch(() => {})
    entry.store.close()
  }

  /** 全部释放（window/workspace 卸载时调用） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      if (entry.keepWarmTimer) clearTimeout(entry.keepWarmTimer)
      void this.unsubscribe?.(entry.subscriptionId ?? '').catch(() => {})
      entry.store.close()
    }
    this.entries.clear()
  }

  private _releaseEntry(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.refCount--
    if (entry.refCount > 0 || this.disposed) return

    // 关 pane ≠ 停 session; 只退订视图
    entry.keepWarmTimer = setTimeout(() => {
      // 引用仍为 0 且 还没 dispose 才真 close
      if (entry.refCount === 0) {
        this.closeSession(sessionId)
      }
    }, this.keepWarmMs)
  }
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}