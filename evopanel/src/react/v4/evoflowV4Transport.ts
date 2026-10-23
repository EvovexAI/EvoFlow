// EvoFlow 自有后端的 V4 SSE transport。
// 实现 zcode-ui `ConversationTransport` 的流式子集（subscribe/activate/resync/
// unsubscribe/onFrame/rowsRange/sendCommand），对接 backend `app/gateway/v4/routes.py`：
//   POST /api/v4/conversation/subscribe   → { ack }
//   POST /api/v4/conversation/resync      → { ack }
//   POST /api/v4/conversation/unsubscribe → { ok }
//   POST /api/v4/conversation/command     → CommandAck
//   POST /api/v4/conversation/rows_range  → rowsRange result
//   GET  /api/v4/conversation/frames?connectionId=… → SSE `event: v4.wire`
// 帧负载是 `ConversationTopicWireCandidate`（wireVersion=3, kind=complete），解包
// `candidate.frame` 交给 projection store，并携带 deliveryKind 上下文。
//
// 语义对齐（与 verbatim store 的三条铁律配套）：
// - ACK 前到达的本订阅帧暂存，activate(subscriptionId) 后按原序释放；
//   含「SSE 首帧早于 HTTP ACK」竞态：按 subId 提前建 staging，ACK 时不得 set([]) 覆盖。
// - SSE 断线自动重连；重连后的缺帧由 store 的断档恢复（携水位 resync）自愈，
//   transport 不做任何补偿猜测。
// - 对齐日志：`[v4-rx]`（帧级 fromSeq→toSeq）/ `[v4-tx]`（订阅生命周期），
//   localStorage.evoflow_v4_debug='1' 打开逐帧输出。
// - stream-compare：每帧落盘同轮目录的 `v4-recv.log`（与 sse-recv / ui-display 对账）。
//
// 桌面安装包：相对路径 EventSource('/api/...') 只会打到 WebView 静态资源，进不了
// Gateway sidecar（与 panel-stream 同病）。POST/GET 一律走 evoflowFetch /
// evoflowFetchStream（Tauri → gatewayProxy / gateway_proxy_stream）。
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationResyncParams,
  ConversationTopicFrame,
  SubscribeParams,
  TopicFrameDeliveryKind,
  V4ConversationResyncResult,
  V4ConversationRowsRangeParams,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationRowsRangeResult,
  V4ConversationSubscribeResult,
  V4ConversationUnsubscribeParams,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@zcode/ui/v4/transport.js";
import { evoflowFetch, evoflowFetchStream } from "../../lib/ws-client.js";
import { logStreamCompareV4Recv } from "../lib/stream-compare-file-log.js";
import { parseV4WireSseBlocks } from "./v4-wire-sse-parse.js";

export { parseV4WireSseBlocks } from "./v4-wire-sse-parse.js";

type FrameListener = (
  frame: ConversationTopicFrame,
  context?: { deliveryKind: TopicFrameDeliveryKind },
) => void;

interface WireCandidate {
  wireVersion?: number;
  kind?: string;
  deliveryKind?: TopicFrameDeliveryKind;
  logicalFrameId?: string;
  logicalFrameOrdinal?: number;
  topic: string;
  subscriptionId: string;
  frame: ConversationTopicFrame;
}

function v4DebugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem("evoflow_v4_debug") === "1";
  } catch {
    return false;
  }
}

function v4Log(channel: string, message: string, detail?: Record<string, unknown>): void {
  const line = `[${channel}] ${message}`;
  if (detail) console.info(line, detail);
  else console.info(line);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await evoflowFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`v4 ${url} failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

function unsupported(method: string): never {
  throw new Error(`EvoFlowV4Transport: ${method} 不支持（自有后端未实现该面）`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function silenceReaderCancel(reader: ReadableStreamDefaultReader<Uint8Array> | null): void {
  if (!reader?.cancel) return;
  void Promise.resolve(reader.cancel()).catch(() => {});
}

function isBenignV4StreamError(err: unknown): boolean {
  if (!err) return true;
  const e = err as { name?: string; message?: string };
  if (e?.name === "AbortError") return true;
  const msg = String(e?.message || err || "")
    .trim()
    .toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network error") ||
    msg.includes("load failed") ||
    msg.includes("aborted") ||
    msg.includes("abort") ||
    msg.includes("bodystreambuffer was aborted")
  );
}

export class EvoFlowV4Transport implements ConversationTransport {
  readonly connectionId: string;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly assemblyFaultListeners = new Set<(fault: {
    topic: string;
    subscriptionId: string;
    reasonCode?: string;
    deliveryKind?: TopicFrameDeliveryKind;
  }) => void>();
  private readonly runtimeRestartListeners = new Set<
    (reason?: "runtimeRestart" | "transportReplaced") => void
  >();
  /** subscriptionId → topic（unsubscribe 需要 topic，store 只回传 id）。 */
  private readonly topicBySubscription = new Map<string, string>();
  /** ACK 前暂存的本订阅帧；activate 后按原序释放。 */
  private readonly stagedBySubscription = new Map<
    string,
    Array<{ frame: ConversationTopicFrame; deliveryKind: TopicFrameDeliveryKind }>
  >();
  private readonly activeSubscriptions = new Set<string>();
  /** 已退订的 subId：迟到帧不得再进 staging（否则会泄漏 / 污染下一次误 activate）。 */
  private readonly closedSubscriptions = new Set<string>();
  private disposed = false;
  /** frames SSE 是否已拉起（单连接共享；dispose 后可再 ensure）。 */
  private sseLoopStarted = false;
  private sseAbort: AbortController | null = null;
  private sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor() {
    this.connectionId = `evoflow-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }

  async subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
    if (this.disposed) throw new Error("transport disposed");
    this.ensureSse();
    v4Log("v4-tx", `subscribe ${params.topic}`, { base: params.base ?? null });
    const result = await postJson<{ ack: V4ConversationSubscribeResult["ack"] }>(
      "/api/v4/conversation/subscribe",
      {
        connectionId: this.connectionId,
        topic: params.topic,
        ...(params.base ? { base: params.base } : {}),
        // 桌面面板走 continuous 档（30ms flush 窗）；web/手机消费方可传别的 clientMode。
        clientMode: "desktop-continuous",
      },
    );
    const subscriptionId = result.ack.subscriptionId;
    this.closedSubscriptions.delete(subscriptionId);
    this.topicBySubscription.set(subscriptionId, params.topic);
    // 切勿覆盖已有 staging：SSE 首帧 snapshot 常比 HTTP ACK 先到（见 handleCandidate），
    // 若这里 set([]) 会把已暂存的 initial/recovery 快照抹掉 → 面板永停「V4 连接中…」。
    if (!this.stagedBySubscription.has(subscriptionId)) {
      this.stagedBySubscription.set(subscriptionId, []);
    } else {
      const n = this.stagedBySubscription.get(subscriptionId)?.length ?? 0;
      if (n > 0) {
        v4Log("v4-rx", `subscribe ACK keeps ${n} early-staged frames`, { subscriptionId });
      }
    }
    return result;
  }

  activate(subscriptionId: string): void {
    this.activeSubscriptions.add(subscriptionId);
    const staged = this.stagedBySubscription.get(subscriptionId);
    if (!staged || staged.length === 0) return;
    this.stagedBySubscription.delete(subscriptionId);
    v4Log("v4-rx", `activate releases ${staged.length} staged frames`, { subscriptionId });
    for (const item of staged) {
      this.dispatchFrame(item.frame, item.deliveryKind);
    }
  }

  async resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult> {
    v4Log("v4-tx", `resync sub=${params.subscriptionId}`, { base: params.base ?? null });
    return await postJson<V4ConversationResyncResult>("/api/v4/conversation/resync", {
      subscriptionId: params.subscriptionId,
      ...(params.base ? { base: params.base } : {}),
    });
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.activeSubscriptions.delete(subscriptionId);
    this.stagedBySubscription.delete(subscriptionId);
    this.closedSubscriptions.add(subscriptionId);
    const topic = this.topicBySubscription.get(subscriptionId);
    this.topicBySubscription.delete(subscriptionId);
    try {
      const body: V4ConversationUnsubscribeParams = {
        subscriptionId,
        topic: topic ?? `conversation/${subscriptionId}`,
        connectionId: this.connectionId,
      };
      await postJson("/api/v4/conversation/unsubscribe", body);
    } catch (error) {
      v4Log("v4-tx", `unsubscribe failed sub=${subscriptionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onAssemblyFault(
    listener: (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void,
  ): () => void {
    this.assemblyFaultListeners.add(listener);
    return () => this.assemblyFaultListeners.delete(listener);
  }

  onRuntimeRestart(
    listener: (reason?: "runtimeRestart" | "transportReplaced") => void,
  ): () => void {
    this.runtimeRestartListeners.add(listener);
    return () => this.runtimeRestartListeners.delete(listener);
  }

  async rowsRange(
    params: V4ConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult> {
    return await postJson<V4ConversationRowsRangeResult>("/api/v4/conversation/rows_range", {
      sessionId: params.sessionId,
      beforeRowId: params.beforeRowId ?? null,
      limit: params.limit,
    });
  }

  async fileChanges(
    params: V4ConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult> {
    return await postJson<V4ConversationFileChangesResult>("/api/v4/conversation/file_changes", {
      sessionId: params.sessionId,
      target: params.target,
      baseRevision: params.baseRevision,
      baseLogEpoch: params.baseLogEpoch,
    });
  }

  async sendCommand(envelope: CommandEnvelope): Promise<CommandAck> {
    return await postJson<CommandAck>("/api/v4/conversation/command", { envelope });
  }

  async queryCommands(_params: CommandsQueryParams): Promise<CommandsQueryResult> {
    // 自有后端暂无 pending command registry；schema 要求 results.min(1)，
    // 无命令可对账时只能 fail-fast，由调用方按对账不可用处理。
    unsupported("queryCommands");
  }

  // ── 以下为 zcode 完整 transport 面的其余方法：自有后端未实现，显式 fail-fast ──

  plans(): never {
    unsupported("plans");
  }
  workflowRunEvents(): never {
    unsupported("workflowRunEvents");
  }
  workflowRuns(): never {
    unsupported("workflowRuns");
  }
  workflowRunArtifacts(): never {
    unsupported("workflowRunArtifacts");
  }
  workflowRunArtifactData(): never {
    unsupported("workflowRunArtifactData");
  }
  workflowRunArtifactRead(): never {
    unsupported("workflowRunArtifactRead");
  }
  workflowRunWorkspace(): never {
    unsupported("workflowRunWorkspace");
  }
  workflowRunNodeResult(): never {
    unsupported("workflowRunNodeResult");
  }
  fileRewindPreview(): never {
    unsupported("fileRewindPreview");
  }
  attachmentPut(): never {
    unsupported("attachmentPut");
  }
  attachmentRead(): never {
    unsupported("attachmentRead");
  }
  attachmentReadRange(): never {
    unsupported("attachmentReadRange");
  }

  dispose(): void {
    this.disposed = true;
    this.sseLoopStarted = false;
    try {
      this.sseAbort?.abort();
    } catch {
      /* ignore */
    }
    this.sseAbort = null;
    silenceReaderCancel(this.sseReader);
    this.sseReader = null;
    this.frameListeners.clear();
    this.assemblyFaultListeners.clear();
    this.runtimeRestartListeners.clear();
  }

  // ── 内部：SSE 连接与帧分发（Tauri 走 gateway_proxy_stream，禁 EventSource） ──

  private ensureSse(): void {
    if (this.sseLoopStarted || this.disposed) return;
    this.sseLoopStarted = true;
    const path = `/api/v4/conversation/frames?connectionId=${encodeURIComponent(this.connectionId)}`;
    v4Log("v4-tx", `sse loop start connectionId=${this.connectionId}`);
    void this.runFramesLoop(path);
  }

  private async runFramesLoop(path: string): Promise<void> {
    let backoffMs = 1000;
    let loggedWarn = false;
    while (!this.disposed) {
      const ac = new AbortController();
      this.sseAbort = ac;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const res = await evoflowFetchStream(path, { method: "GET", signal: ac.signal });
        if (!res?.ok || !res.body) {
          if (!this.disposed && !loggedWarn) {
            console.warn("[v4-tx] frames bad response", res?.status);
            loggedWarn = true;
          }
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30000);
          continue;
        }
        backoffMs = 1000;
        loggedWarn = false;
        if (v4DebugEnabled()) {
          v4Log("v4-tx", `sse connected connectionId=${this.connectionId}`);
        }
        reader = res.body.getReader();
        this.sseReader = reader;
        const dec = new TextDecoder();
        let buf = "";
        while (!this.disposed && !ac.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) buf += dec.decode(value, { stream: true });
          buf = parseV4WireSseBlocks(buf, (data) => this.onWireData(data));
        }
      } catch (e) {
        if (this.disposed || ac.signal.aborted) break;
        if (isBenignV4StreamError(e)) {
          if (!loggedWarn) {
            console.warn(
              "[v4-tx] frames disconnected (will retry)",
              e instanceof Error ? e.message : e,
            );
            loggedWarn = true;
          }
        } else if (!this.disposed) {
          console.warn("[v4-tx] frames stream error", e);
        }
      } finally {
        this.sseReader = null;
        if (this.sseAbort === ac) this.sseAbort = null;
        silenceReaderCancel(reader);
      }
      if (this.disposed) break;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }

  private onWireData(data: string): void {
    let candidate: WireCandidate;
    try {
      candidate = JSON.parse(data) as WireCandidate;
    } catch (error) {
      v4Log("v4-rx", "wire parse failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    // 不在读循环里同步跑 projection→React：侧栏开合/表格测宽的
    // useLayoutEffect setState 会叠进同一嵌套更新计数，触发 React #185
    //（Maximum update depth），且被旧 catch 误标成 wire parse failed。
    queueMicrotask(() => {
      if (this.disposed) return;
      try {
        this.handleCandidate(candidate);
      } catch (error) {
        v4Log("v4-rx", "frame dispatch failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private handleCandidate(candidate: WireCandidate): void {
    if (!candidate?.frame || !candidate.subscriptionId) return;
    const deliveryKind: TopicFrameDeliveryKind =
      candidate.deliveryKind ?? "online";
    const payload = candidate.frame.payload;
    if (v4DebugEnabled()) {
      const seq =
        payload.kind === "deltas"
          ? `${candidate.frame.fromSeq}->${candidate.frame.toSeq} ops=${payload.deltas.length}`
          : `snapshot seq=${candidate.frame.toSeq}`;
      v4Log("v4-rx", `${candidate.topic} ${deliveryKind} ${seq}`);
    }
    if (!this.activeSubscriptions.has(candidate.subscriptionId)) {
      if (this.closedSubscriptions.has(candidate.subscriptionId)) {
        // 已退订的迟到帧：丢弃。
        return;
      }
      // ACK 尚未返回 / activate 前：暂存。
      // 关键：initial snapshot 经 SSE 可能早于 subscribe() 的 HTTP ACK 到达；
      // 此时 staged map 还没有该 subId。旧逻辑直接丢弃 → store 永远等不到首帧。
      let staged = this.stagedBySubscription.get(candidate.subscriptionId);
      if (!staged) {
        staged = [];
        this.stagedBySubscription.set(candidate.subscriptionId, staged);
        v4Log("v4-rx", `early-stage frame before subscribe ACK`, {
          subscriptionId: candidate.subscriptionId,
          deliveryKind,
          topic: candidate.topic,
        });
      }
      this.logCompareFrame(candidate.topic, candidate.frame, deliveryKind);
      staged.push({ frame: candidate.frame, deliveryKind });
      return;
    }
    this.logCompareFrame(candidate.topic, candidate.frame, deliveryKind);
    this.dispatchFrame(candidate.frame, deliveryKind);
  }

  private dispatchFrame(frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind): void {
    for (const listener of this.frameListeners) {
      try {
        listener(frame, { deliveryKind });
      } catch (error) {
        // 单 listener（如某 session store）抛错不得拖死整条 SSE 扇出。
        v4Log("v4-rx", "frame listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private logCompareFrame(
    topic: string,
    frame: ConversationTopicFrame,
    deliveryKind: TopicFrameDeliveryKind,
  ): void {
    try {
      logStreamCompareV4Recv({ topic, deliveryKind, frame });
    } catch {
      /* best-effort：对比日志失败不得影响投影 */
    }
  }
}

let sharedTransport: EvoFlowV4Transport | null = null;

/** 连接级单例：同页所有 v4 pane 共享一条 SSE（对齐 SessionDataLayer 的连接模型）。 */
export function getEvoflowV4Transport(): EvoFlowV4Transport {
  if (!sharedTransport) {
    sharedTransport = new EvoFlowV4Transport();
    // 注册为 ZCode 侧栏框架的 transport 覆盖：SubagentSessionSidePane /
    // 文件查看器等 vendor 面板经 workspaceConnectionRegistry 拿到本 transport，
    // 无需 ZCode agentService RPC。
    void (async () => {
      try {
        const { registerV4TransportOverride } = await import("@zcode/ui/v4/workspaceConnectionRegistry.js");
        registerV4TransportOverride({ workspacePath: "" }, sharedTransport!);
      } catch {
        // 覆盖注册失败不影响直连使用
      }
    })();
  }
  return sharedTransport;
}

/** 测试 / HMR：丢掉单例，下次 get 重建（含新的 connectionId + SSE）。 */
export function resetEvoflowV4TransportForTests(): void {
  try {
    sharedTransport?.dispose();
  } catch {
    /* ignore */
  }
  sharedTransport = null;
}
