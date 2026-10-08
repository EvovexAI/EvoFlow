import { logger } from "@/logger.js";
import type { ConversationTransport } from "@/v4/transport.js";

type FrameListener = Parameters<ConversationTransport["onFrame"]>[0];
type AssemblyFaultListener = Parameters<ConversationTransport["onAssemblyFault"]>[0];
type RuntimeRestartListener = Parameters<ConversationTransport["onRuntimeRestart"]>[0];
type RuntimeLifecycleListener = Parameters<
  NonNullable<ConversationTransport["onRuntimeLifecycle"]>
>[0];

async function unsubscribeIgnoringFailure(
  transport: ConversationTransport,
  subscriptionId: string,
): Promise<void> {
  try {
    await transport.unsubscribe(subscriptionId);
  } catch (error) {
    logger.warn(
      `[v4-conversation] unsubscribe ${subscriptionId} 失败（忽略）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 远程 service proxy 换代期间保持 renderer 侧 transport 身份稳定。
 *
 * 同一 workspace 的存量 pane 会继续持有本对象；replace 后命令与订阅统一转发到
 * 最新 proxy，旧 proxy 的监听先同步解除，避免新旧 Store 竞争同一 topic ownership。
 */
export class ReplaceableConversationTransport implements ConversationTransport {
  private readonly frameListeners = new Set<FrameListener>();
  private readonly assemblyFaultListeners = new Set<AssemblyFaultListener>();
  private readonly runtimeRestartListeners = new Set<RuntimeRestartListener>();
  private readonly runtimeLifecycleListeners = new Set<RuntimeLifecycleListener>();
  private readonly transportBySubscriptionId = new Map<string, ConversationTransport>();
  private offFrame: (() => void) | null = null;
  private offAssemblyFault: (() => void) | null = null;
  private offRuntimeRestart: (() => void) | null = null;
  private offRuntimeLifecycle: (() => void) | null = null;

  /**
   * 承载方不支持 runtime lifecycle 时本方法在构造期被抹掉，消费方据此回落 onRuntimeRestart。
   * 能力按构造时的 current 判定：同一 workspace 的后续 transport 均由
   * createAgentConversationTransport 产出，支持性只取决于 agentService，换代不会翻转。
   */
  onRuntimeLifecycle?: (listener: RuntimeLifecycleListener) => () => void = (listener) => {
    this.runtimeLifecycleListeners.add(listener);
    this.bindRuntimeLifecycleListener();
    return () => {
      this.runtimeLifecycleListeners.delete(listener);
      if (this.runtimeLifecycleListeners.size === 0) {
        this.offRuntimeLifecycle?.();
        this.offRuntimeLifecycle = null;
      }
    };
  };

  constructor(private current: ConversationTransport) {
    if (!current.onRuntimeLifecycle) {
      this.onRuntimeLifecycle = undefined;
    }
  }

  replace(transport: ConversationTransport): void {
    if (transport === this.current) return;

    const previous = this.current;
    this.detachCurrentListeners();
    // 旧 proxy 上的 active subscription 必须先释放，但断线 RPC 可能永久
    // pending；cleanup 只做 best-effort，不能阻塞新 proxy 的重订阅接管。
    for (const [subscriptionId, owner] of this.transportBySubscriptionId) {
      if (owner !== previous) continue;
      this.transportBySubscriptionId.delete(subscriptionId);
      void unsubscribeIgnoringFailure(previous, subscriptionId);
    }

    this.current = transport;
    this.bindCurrentListeners();
    // proxy 换代只会让 connection ownership 失效，CLI runtime/logEpoch 仍可能连续；
    // 显式携带原因，让 Store 用当前水位 fresh subscribe，由服务端裁决 resume/snapshot。
    for (const listener of this.runtimeRestartListeners) listener("transportReplaced");
  }

  async subscribe(
    params: Parameters<ConversationTransport["subscribe"]>[0],
  ): ReturnType<ConversationTransport["subscribe"]> {
    const owner = this.current;
    const result = await owner.subscribe(params);
    if (owner !== this.current) {
      // 换代前发起的迟到 ACK 不能重新写入稳定 transport 的 ownership 映射。
      void unsubscribeIgnoringFailure(owner, result.ack.subscriptionId);
      throw new Error("fault.subscription.transportReplaced");
    }
    this.transportBySubscriptionId.set(result.ack.subscriptionId, owner);
    return result;
  }

  activate(subscriptionId: string): void {
    (this.transportBySubscriptionId.get(subscriptionId) ?? this.current).activate(subscriptionId);
  }

  resync(
    params: Parameters<ConversationTransport["resync"]>[0],
  ): ReturnType<ConversationTransport["resync"]> {
    return (this.transportBySubscriptionId.get(params.subscriptionId) ?? this.current).resync(
      params,
    );
  }

  unsubscribe(subscriptionId: string): ReturnType<ConversationTransport["unsubscribe"]> {
    const owner = this.transportBySubscriptionId.get(subscriptionId) ?? this.current;
    this.transportBySubscriptionId.delete(subscriptionId);
    return owner.unsubscribe(subscriptionId);
  }

  sendCommand(
    envelope: Parameters<ConversationTransport["sendCommand"]>[0],
  ): ReturnType<ConversationTransport["sendCommand"]> {
    return this.current.sendCommand(envelope);
  }

  queryCommands(
    params: Parameters<ConversationTransport["queryCommands"]>[0],
  ): ReturnType<ConversationTransport["queryCommands"]> {
    return this.current.queryCommands(params);
  }

  rowsRange(
    params: Parameters<ConversationTransport["rowsRange"]>[0],
  ): ReturnType<ConversationTransport["rowsRange"]> {
    return this.current.rowsRange(params);
  }

  plans(
    params: Parameters<ConversationTransport["plans"]>[0],
  ): ReturnType<ConversationTransport["plans"]> {
    return this.current.plans(params);
  }

  // workflowRunEvents 是后来（workflow run 事件日志的 RPC）加进 ConversationTransport
  // 的成员，加的时候只落到了具体传输实现上，这个稳定身份漏掉了转发。而 pane 持的正是本对象，
  // 于是走 service proxy 的 pane 上 `transport.workflowRunEvents` 是 undefined——run 详情页
  // 的事件日志被静默解除，一打开就抛。接口新增成员时这里必须同步长出一条转发。
  workflowRunEvents(
    params: Parameters<ConversationTransport["workflowRunEvents"]>[0],
  ): ReturnType<ConversationTransport["workflowRunEvents"]> {
    return this.current.workflowRunEvents(params);
  }

  // 同一类漏接的预防：接口新增成员时，这个稳定身份必须同步长出一条转发。
  workflowRuns(
    params: Parameters<ConversationTransport["workflowRuns"]>[0],
  ): ReturnType<ConversationTransport["workflowRuns"]> {
    return this.current.workflowRuns(params);
  }

  // workflow 用户面产物的三条读接口必须在此转发；遗漏时 service proxy 上的方法为
  // undefined，侧板调用就会抛错。
  workflowRunArtifacts(
    params: Parameters<ConversationTransport["workflowRunArtifacts"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifacts"]> {
    return this.current.workflowRunArtifacts(params);
  }

  workflowRunArtifactData(
    params: Parameters<ConversationTransport["workflowRunArtifactData"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifactData"]> {
    return this.current.workflowRunArtifactData(params);
  }

  workflowRunArtifactRead(
    params: Parameters<ConversationTransport["workflowRunArtifactRead"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifactRead"]> {
    return this.current.workflowRunArtifactRead(params);
  }

  // dwf 脚本 transcript 的两条读面。
  workflowRunWorkspace(
    params: Parameters<ConversationTransport["workflowRunWorkspace"]>[0],
  ): ReturnType<ConversationTransport["workflowRunWorkspace"]> {
    return this.current.workflowRunWorkspace(params);
  }

  workflowRunNodeResult(
    params: Parameters<ConversationTransport["workflowRunNodeResult"]>[0],
  ): ReturnType<ConversationTransport["workflowRunNodeResult"]> {
    return this.current.workflowRunNodeResult(params);
  }

  fileChanges(
    params: Parameters<ConversationTransport["fileChanges"]>[0],
  ): ReturnType<ConversationTransport["fileChanges"]> {
    return this.current.fileChanges(params);
  }

  fileRewindPreview(
    params: Parameters<ConversationTransport["fileRewindPreview"]>[0],
  ): ReturnType<ConversationTransport["fileRewindPreview"]> {
    return this.current.fileRewindPreview(params);
  }

  attachmentPut(
    params: Parameters<ConversationTransport["attachmentPut"]>[0],
    options?: Parameters<ConversationTransport["attachmentPut"]>[1],
  ): ReturnType<ConversationTransport["attachmentPut"]> {
    return this.current.attachmentPut(params, options);
  }

  attachmentRead(
    params: Parameters<ConversationTransport["attachmentRead"]>[0],
  ): ReturnType<ConversationTransport["attachmentRead"]> {
    return this.current.attachmentRead(params);
  }

  attachmentReadRange(
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ): ReturnType<ConversationTransport["attachmentReadRange"]> {
    return this.current.attachmentReadRange(params);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    this.bindFrameListener();
    return () => {
      this.frameListeners.delete(listener);
      if (this.frameListeners.size === 0) {
        this.offFrame?.();
        this.offFrame = null;
      }
    };
  }

  onAssemblyFault(listener: AssemblyFaultListener): () => void {
    this.assemblyFaultListeners.add(listener);
    this.bindAssemblyFaultListener();
    return () => {
      this.assemblyFaultListeners.delete(listener);
      if (this.assemblyFaultListeners.size === 0) {
        this.offAssemblyFault?.();
        this.offAssemblyFault = null;
      }
    };
  }

  onRuntimeRestart(listener: RuntimeRestartListener): () => void {
    this.runtimeRestartListeners.add(listener);
    this.bindRuntimeRestartListener();
    return () => {
      this.runtimeRestartListeners.delete(listener);
      if (this.runtimeRestartListeners.size === 0) {
        this.offRuntimeRestart?.();
        this.offRuntimeRestart = null;
      }
    };
  }

  private bindCurrentListeners(): void {
    this.bindFrameListener();
    this.bindAssemblyFaultListener();
    this.bindRuntimeRestartListener();
    this.bindRuntimeLifecycleListener();
  }

  private bindFrameListener(): void {
    if (this.offFrame || this.frameListeners.size === 0) return;
    this.offFrame = this.current.onFrame((frame, context) => {
      for (const listener of this.frameListeners) listener(frame, context);
    });
  }

  private bindAssemblyFaultListener(): void {
    if (this.offAssemblyFault || this.assemblyFaultListeners.size === 0) return;
    this.offAssemblyFault = this.current.onAssemblyFault((fault) => {
      for (const listener of this.assemblyFaultListeners) listener(fault);
    });
  }

  private bindRuntimeRestartListener(): void {
    if (this.offRuntimeRestart || this.runtimeRestartListeners.size === 0) return;
    const owner = this.current;
    this.offRuntimeRestart = owner.onRuntimeRestart(() => {
      for (const [subscriptionId, subscriptionOwner] of this.transportBySubscriptionId) {
        if (subscriptionOwner === owner) {
          this.transportBySubscriptionId.delete(subscriptionId);
        }
      }
      for (const listener of this.runtimeRestartListeners) listener();
    });
  }

  private bindRuntimeLifecycleListener(): void {
    if (this.offRuntimeLifecycle || this.runtimeLifecycleListeners.size === 0) return;
    this.offRuntimeLifecycle =
      this.current.onRuntimeLifecycle?.((state) => {
        for (const listener of this.runtimeLifecycleListeners) listener(state);
      }) ?? null;
  }

  private detachCurrentListeners(): void {
    this.offFrame?.();
    this.offFrame = null;
    this.offAssemblyFault?.();
    this.offAssemblyFault = null;
    this.offRuntimeRestart?.();
    this.offRuntimeRestart = null;
    this.offRuntimeLifecycle?.();
    this.offRuntimeLifecycle = null;
  }
}
