// SessionDataLayer（纯数据层）。
// Map<topic, SessionStore>，不知道「显示」这回事；生命周期 = 引用计数：
// 有 pane 引用 → 订阅；归零 → 延迟退订（keep-warm，防拖拽/切 pane 抖动）。
// 一个实例对应一条 host 连接；跨 workspace 分屏在 shell 层做
// Map<workspaceKey, SessionDataLayer>，本层不感知 workspace。
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { SessionOpenKind } from "@/lib/sessionOpenArmsTelemetry.js";
import { conversationTopic, type ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";
import type { CommandsQueryParams, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";

/** pane 持有的租约；release 幂等。 */
export interface SessionLease {
  readonly sessionId: string;
  readonly store: ConversationProjectionStore;
  /** 由数据层按 projection 生命周期判定，避免 pane 首次 render 时 snapshot 仍为空。 */
  readonly openKind: SessionOpenKind;
  /** pane acquire 的 Renderer 单调时钟起点。 */
  readonly startedAt: number;
  release(): void;
}

interface SessionDataLayerOptions {
  transport: ConversationTransport;
  /** 引用归零后延迟退订窗口（ms），默认 30s。 */
  keepWarmMs?: number;
}

const SESSION_DATA_LAYER_KEEP_WARM_MS = 30_000;
const E2E_SESSION_DATA_LAYER_KEEP_WARM_MS = 1_000;

function resolveSessionDataLayerKeepWarmMs(
  e2eStoreBridgeEnabled = shouldExposeE2EStoreBridge(),
): number {
  return e2eStoreBridgeEnabled
    ? E2E_SESSION_DATA_LAYER_KEEP_WARM_MS
    : SESSION_DATA_LAYER_KEEP_WARM_MS;
}

interface SessionEntry {
  store: ConversationProjectionStore;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class SessionDataLayer {
  private readonly transport: ConversationTransport;
  private readonly keepWarmMs: number;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly offFrame: () => void;
  private disposed = false;

  constructor(options: SessionDataLayerOptions) {
    this.transport = options.transport;
    this.keepWarmMs = options.keepWarmMs ?? resolveSessionDataLayerKeepWarmMs();
    // 连接级单监听：按 topic 扇入到各 store（pane 间共享的正是这一条连接）。
    this.offFrame = this.transport.onFrame((frame, context) => {
      this.entries.get(frame.topic)?.store.handleFrame(frame, context);
    });
  }

  /**
   * 取得 session 的投影 store。首个引用触发 subscribe（新开 pane 就是一次
   * subscribe，与刷新、新设备同一路径）；重复 acquire 共享同一 store（readonly，
   * 同 session 多 pane = 多视图）。
   *
   * ``intent: "prefetch"`` = 悬停预热：服务端 hydrate 走低优先级，可被用户打开插队。
   */
  acquire(
    sessionId: string,
    opts?: { intent?: "open" | "prefetch" },
  ): SessionLease {
    if (this.disposed) {
      throw new Error("SessionDataLayer 已释放，不能再 acquire");
    }
    const intent = opts?.intent === "prefetch" ? "prefetch" : "open";
    const topic = conversationTopic(sessionId);
    const startedAt = monotonicNow();
    let entry = this.entries.get(topic);
    let openKind: SessionOpenKind;
    if (entry) {
      openKind = entry.keepWarmTimer !== null ? "keep_warm" : "warm";
      entry.refCount++;
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
        entry.keepWarmTimer = null;
      }
      // 切回已流式会话：warm store 可能卡在 connecting/无订阅；冷开才会 connect()，
      // 这里补一刀，避免干等 Timeline 遮罩 + 5s watchdog（正式包空白开现场）。
      entry.store.ensureConnected();
    } else {
      const store = new ConversationProjectionStore(topic, this.transport);
      entry = { store, refCount: 1, keepWarmTimer: null };
      this.entries.set(topic, entry);
      openKind = "cold";
      // 订阅失败落在 store.state（status=error + retry()），不在这里抛。
      void store.connect({
        rendererPrepareStartedAt: startedAt,
        ...(intent === "prefetch" ? { intent: "prefetch" as const } : {}),
      });
    }
    logger.lifecycle.info("v4 session data lease acquired", {
      event: "v4.session_data.acquire",
      keepWarm: entry.keepWarmTimer !== null,
      module: "ui.v4.session_data_layer",
      openKind,
      refCount: entry.refCount,
      sessionId,
      status: "completed",
      topic,
    });

    let released = false;
    return {
      sessionId,
      store: entry.store,
      openKind,
      startedAt,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(topic);
      },
    };
  }

  /** 当前活跃（含 keep-warm 中）的 session 数，测试与调试观测点。 */
  get size(): number {
    return this.entries.size;
  }

  /** 该 session 是否已有活跃（含 keep-warm 中）的 store。 */
  has(sessionId: string): boolean {
    return this.entries.has(conversationTopic(sessionId));
  }

  /**
   * stream-404 remint：把旧 thread 的投影条目改挂到新 threadId。
   * 保留同一 store + snapshot；旧 topic 仍指向同一 entry（别名），
   * 这样旧 lease.release() 与新 acquire() 不会冷开空白。
   */
  rebindSessionId(oldSessionId: string, newSessionId: string): boolean {
    if (this.disposed) return false;
    const oldId = String(oldSessionId || "").trim();
    const newId = String(newSessionId || "").trim();
    if (!oldId || !newId || oldId === newId) return false;
    const oldTopic = conversationTopic(oldId);
    const newTopic = conversationTopic(newId);
    const entry = this.entries.get(oldTopic);
    if (!entry) return false;
    const existing = this.entries.get(newTopic);
    if (existing && existing !== entry) {
      logger.lifecycle.warn("v4 session data remint rebind skipped — new topic occupied", {
        event: "v4.session_data.remint_rebind_conflict",
        module: "ui.v4.session_data_layer",
        oldTopic,
        newTopic,
        status: "skipped",
      });
      return false;
    }
    this.entries.set(newTopic, entry);
    try {
      entry.store.rebindSessionId(newId);
    } catch (err) {
      logger.lifecycle.warn("v4 session data remint store rebind failed", {
        event: "v4.session_data.remint_rebind_failed",
        module: "ui.v4.session_data_layer",
        oldTopic,
        newTopic,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    logger.lifecycle.info("v4 session data remint rebound", {
      event: "v4.session_data.remint_rebind",
      module: "ui.v4.session_data_layer",
      oldTopic,
      newTopic,
      refCount: entry.refCount,
      status: "completed",
    });
    return true;
  }

  /**
   * 用户点开某会话时：立刻关掉其它仅 keep-warm（refCount=0）的投影，
   * 打断它们占着的 subscribe/hydrate，避免排队把点击拖成十几秒 connecting。
   * ``keepSessionIds`` 通常 = 当前点开 + 仍需钉住的执行中会话。
   */
  releaseKeepWarmExcept(keepSessionIds: readonly string[]): number {
    if (this.disposed) return 0;
    const keep = new Set(
      keepSessionIds
        .map((id) => conversationTopic(String(id || "").trim()))
        .filter(Boolean),
    );
    let closed = 0;
    for (const [topic, entry] of [...this.entries.entries()]) {
      if (keep.has(topic)) continue;
      if (entry.refCount > 0) continue;
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
        entry.keepWarmTimer = null;
      }
      for (const [k, e] of [...this.entries.entries()]) {
        if (e === entry) this.entries.delete(k);
      }
      closed += 1;
      logger.lifecycle.info("v4 session data keep-warm cancelled for focus", {
        event: "v4.session_data.keep_warm_cancelled",
        module: "ui.v4.session_data_layer",
        topic,
        status: "cancelled",
      });
      void entry.store.close();
    }
    return closed;
  }

  /**
   * 只读窥探已有 store（不增减引用）。切会话时 React 换租约前一帧可用来
   * 读 keep-warm/pin 快照，避免 lease mismatch → 空白 connecting。
   */
  peekStore(sessionId: string): ConversationProjectionStore | null {
    const entry = this.entries.get(conversationTopic(sessionId));
    return entry?.store ?? null;
  }

  /** renderer pending-command registry 的只读对账入口；仍复用本 layer 的同一 host connection。 */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
    return this.transport.queryCommands(params);
  }

  private releaseEntry(topic: string): void {
    const entry = this.entries.get(topic);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0 || this.disposed) {
      logger.lifecycle.info("v4 session data lease released", {
        event: "v4.session_data.release",
        module: "ui.v4.session_data_layer",
        refCount: entry.refCount,
        status: "completed",
        topic,
      });
      return;
    }
    // 关 pane ≠ 停 session：这里只是退订视图，session 在 CLI 里照跑。
    entry.keepWarmTimer = setTimeout(() => {
      // remint 别名：同一 entry 可能挂在新旧两个 topic 上，过期时一并摘掉。
      for (const [k, e] of [...this.entries.entries()]) {
        if (e === entry) this.entries.delete(k);
      }
      logger.lifecycle.info("v4 session data keep-warm expired", {
        event: "v4.session_data.keep_warm_expired",
        module: "ui.v4.session_data_layer",
        refCount: 0,
        status: "completed",
        topic,
      });
      void entry.store.close();
    }, this.keepWarmMs);
    logger.lifecycle.info("v4 session data lease released", {
      event: "v4.session_data.release",
      keepWarmMs: this.keepWarmMs,
      module: "ui.v4.session_data_layer",
      refCount: 0,
      status: "keep_warm",
      topic,
    });
  }

  /** 连接销毁时清场（window/workspace 卸载）。 */
  dispose(): void {
    if (this.disposed) return;
    logger.lifecycle.info("v4 session data layer dispose started", {
      entryCount: this.entries.size,
      event: "v4.session_data.dispose.started",
      module: "ui.v4.session_data_layer",
      status: "started",
    });
    this.disposed = true;
    this.offFrame();
    for (const entry of this.entries.values()) {
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
      }
      void entry.store.close();
    }
    this.entries.clear();
    logger.lifecycle.info("v4 session data layer dispose completed", {
      event: "v4.session_data.dispose.completed",
      module: "ui.v4.session_data_layer",
      status: "completed",
    });
  }
}
