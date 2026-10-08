/* eslint-disable max-lines -- task index 的 v4 帧摄入、snapshot upsert 和 workspace 广播必须共享同一份闭包状态。 */
import { repairSubagentTaskIndex } from "#src/zcode-agent/repairSubagentTaskIndex.js";
import {
  deriveZCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  getZCodeUserVisibleMessages,
  isZCodeGoalContinuationReminderText,
  isZCodeModelOnlySyntheticUserMessage,
  resolveWorkspaceKey,
  resolveZCodeVisibleSessionTitle,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER,
  type ZCodeTaskGoal,
  type ZCodeTaskMode,
  type ZCodeTaskMeta,
  type ZCodeMessagePart,
  type ZCodeSessionMode,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceEvent,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
  TopicWireFrameAssembler,
  type SessionPhase,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type V4SessionsIndexSubscribeResult,
  type V4WorkspaceConfigSubscribeResult,
  type WorkspaceConfigTopicFrame,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ZCodeWorkspaceEventSubscriptionParams } from "#src/session/zcodeTaskListTypes.js";
import type {
  IZCodeAgentService,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";
import { formatTaskMetaModelSelectionFromSnapshot } from "./zcodeConfigOptions.js";

const logger = createServiceLogger("zcode-task-index-syncer");

/** v4 订阅 connectionId 作用域：与 renderer 侧栏共 topic 不同代际（重订阅替换）。 */
const TASK_INDEX_SUBSCRIBER_SCOPE = "task-index";
const MAX_PENDING_TOPIC_FRAMES = 1_024;
const MAX_PENDING_TOPIC_BYTES = 32 * 1024 * 1024;
const INITIAL_BASELINE_SEED_BATCH_SIZE = 64;
const PROVIDER_NOT_READY_RETRY_MS = 5_000;
const TOPIC_SUBSCRIBE_WARN_INTERVAL_MS = 60_000;

type TopicSubscribeReason =
  | "initial"
  | "runtime-restart"
  | "snapshot-recovery-gap"
  | "recovery-frame-timeout"
  | "resync-ack-mismatch"
  | "resync-failed"
  | "force-recovery-gap"
  | "pre-ack-overflow"
  | "provider-not-ready-wait"
  | "retry";
type TopicRetryKind = "provider-not-ready" | "transient";
type TaskIndexTopicKind = "sessions-index" | "workspace-config";

type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;

interface WorkspaceBroadcastTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
}

export interface ZCodeTaskIndexTerminalEvent {
  target: ZCodeAgentSessionTarget;
  /** v4 phase 终态映射：completedSuccess/completedInterrupted → turn.completed；error → turn.failed。 */
  kind: "turn.completed" | "turn.failed";
}

export interface ZCodeTaskIndexReadyEvent {
  target: ZCodeAgentSessionTarget;
  /** v4 phase 终态映射：agent 收口后可接受下一条输入的 ready 边界。 */
  reason: "prompt_completed" | "prompt_failed";
}

export interface ZCodeTaskIndexSyncer {
  /**
   * 幂等地为指定 workspace 建立 v4 后台摄入订阅（sessions-index + workspace-config），
   * 把 CLI 权威投影的会话终态/标题/配置目录落到 task index sqlite 与 workspace 广播。
   * 同一 workspace 多次调用只会建立一次。
   */
  ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void;
  /**
   * 兼容入口（旧 shadow 订阅 API 形状）：session 维度的激活信号统一收敛为
   * workspace 级 v4 订阅。options.includeSnapshot 在 v4 摄入下无对应语义（初始
   * sessions-index snapshot 只静默补缺失行，不回放终态/广播），保留参数只为不动调用面。
   */
  ensureSessionSubscription(
    target: ZCodeAgentSessionTarget,
    options?: {
      includeSnapshot?: boolean;
    },
  ): void;
  /**
   * 把一份 session snapshot 同步到 sqlite，并广播 workspace_task_list_changed。
   * desktop-continuous 路径上，zcodeSessionService 在 createSession/resumeSession/setModel
   * 之后调用本方法（send/steer/fork/compact/rewind 旧写路径已删，写路径统一走
   * v4 命令 + sessions-index/workspace 事件），让 sqlite 拿到最新 title/updatedAt 并触发 UI 列表刷新。
   */
  syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      /**
       * 设计修正：必填。切模型（task_model_changed）/快照收敛（task_status_changed）
       * 这类变更不得落到 task_meta_changed——后者会被 UI 当成归属相关变更
       * 触发全局 membership 重拉和列表整刷。
       */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<ZCodeTaskMeta>;
  /**
   * 只更新 task index 中的模型记录，不广播历史 snapshot。
   * 发送前 resume 会关闭 snapshot 广播，避免旧终态覆盖本地 streaming UI，
   * 但仍需要把 sqlite 的 model 从已删除历史模型更新到本次实际使用的可用模型。
   */
  syncTaskModel(target: ZCodeAgentSessionTarget, model: string): Promise<ZCodeTaskMeta | null>;
  /**
   * 主动触发一次 workspace_task_list_changed 广播。
   * 给 adapter 用：archive / rename / pin / delete 等 task 元数据变更后仍要广播。
   * 设计修正：reason 必填。曾经的缺省值（task_meta_changed）让所有不表态的发射点
   * 静默落入 UI 最重的刷新语义（全局 membership 重拉），是"输入框操作/任务收口
   * 引发左侧列表整刷"的根因；发射点必须显式声明变更类别。
   */
  emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    meta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void;
  /**
   * 获取共享的 workspace emitter，给 adapter 用来 fire 非 task_list_changed 类事件
   * （如 workspace_config_options_update）。这样 adapter 和 syncer 共用同一 emitter，
   * 订阅者只需要订阅一次即可收到全部事件。
   */
  getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent>;
  /** 订阅 workspace 维度事件流。adapter.onDynamicWorkspaceEvent 直接转发到这里。 */
  onDynamicWorkspaceEvent(workspace: WorkspaceEventInput): Event<ZCodeWorkspaceEvent>;
  /**
   * 订阅 v4 sessions-index 观察到的会话 phase 终态迁移。
   * 这不是 UI stream，只给 host runtime command queue 等 services 内部状态收口使用。
   */
  onSessionTerminalEvent: Event<ZCodeTaskIndexTerminalEvent>;
  /**
   * 订阅会话收口后的 prompt ready 状态（phase 进入 completedSuccess/completedInterrupted/error）。
   * 手机 host command queue 只能以这个事件作为继续发送下一条的边界。
   */
  onSessionReadyEvent: Event<ZCodeTaskIndexReadyEvent>;
  /** 释放所有 v4 订阅和 workspace emitter；不关闭注入的 taskIndexRepo。 */
  disposeAll(): void;
}

interface CreateZCodeTaskIndexSyncerOptions {
  agentService: IZCodeAgentService;
  taskIndexRepo: TaskIndexRepo;
}

/** phase 终态集合（sessions-index 的 conflated 最新态里判定迁移用）。 */
function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

function resolveTerminalUnreadSignal(
  summary: Pick<SessionSummary, "phase" | "goalStatus">,
): ZCodeWorkspaceTaskListChanged["unreadSignal"] {
  if (summary.phase === "error") {
    return "background_terminal";
  }
  if (
    (summary.phase === "completedSuccess" || summary.phase === "completedInterrupted") &&
    (summary.goalStatus === undefined || summary.goalStatus === "verified")
  ) {
    return "background_terminal";
  }
  return undefined;
}

function taskStatusFromSummaryPhase(phase: SessionPhase): ZCodeTaskMeta["status"] {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function buildBaselineMetaFromSummary(
  target: ZCodeAgentWorkspaceTarget,
  summary: SessionSummary,
): ZCodeTaskMeta {
  const status = taskStatusFromSummaryPhase(summary.phase);
  return {
    taskId: summary.sessionId,
    traceId: generateTraceId(summary.sessionId),
    title: summary.title,
    ...(summary.titleSource === "custom" ? { titleOverridden: true } : {}),
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    createdAt: summary.createdAt,
    updatedAt: summary.lastActivityAt,
    mode: "build",
    provider: ZCODE_AGENT_PROVIDER,
    ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
    ...(status ? { status } : {}),
  };
}

interface WorkspaceIngestState {
  target: ZCodeAgentWorkspaceTarget;
  /** 当前已 attach 的 Agent runtime generation；null = dormant。 */
  runtimeGeneration: number | null;
  /** sessions-index 订阅代际（帧过滤闸门；null = 订阅建立中）。 */
  indexSubscriptionId: string | null;
  /** workspace-config 订阅代际。 */
  configSubscriptionId: string | null;
  /** 两个 topic 各自换代；单一 topic 恢复不得让 sibling 的迟到 ACK 失效。 */
  indexSubscriptionGeneration: number;
  configSubscriptionGeneration: number;
  indexPending: PendingTopicFrames<SessionsIndexTopicWireCandidate> | null;
  configPending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate> | null;
  /** 每个 topic 独立记账的已确认水位，不能共用一个 seq/epoch。 */
  indexLogEpoch: string | null;
  indexSeq: number;
  configLogEpoch: string | null;
  configSeq: number;
  /** ACK 只证明 admission；首个 logical frame 原子 apply 后才允许把 epoch/seq 当 resume base。 */
  indexHasAppliedBase: boolean;
  configHasAppliedBase: boolean;
  indexRecovery: TopicRecoveryState | null;
  configRecovery: TopicRecoveryState | null;
  indexRecoveryGeneration: number;
  configRecoveryGeneration: number;
  /** runtime 重启/恢复 RPC 暂态失败后的 topic-local 退避，sibling 继续活着。 */
  indexRetryTimer: ReturnType<typeof setTimeout> | null;
  configRetryTimer: ReturnType<typeof setTimeout> | null;
  indexRetryAttempt: number;
  configRetryAttempt: number;
  /** 持续故障的 production warn 限频；成功订阅后清空，让下一次新故障立即可见。 */
  indexLastWarnAt: number | null;
  configLastWarnAt: number | null;
  /** 会话摘要基线（terminal 迁移/标题变化的 diff 依据）。 */
  summaries: Map<string, SessionSummary>;
  /** 首帧（snapshot）静默补缺失行，但不回放历史终态事件或列表广播。 */
  seeded: boolean;
  /** workspace 级 frame emitter 跨 runtime generation 保持稳定，只允许安装一组 listener。 */
  frameListenersInstalled: boolean;
  disposables: IDisposable[];
  indexAssembler: TopicWireFrameAssembler<SessionsIndexTopicFrame>;
  configAssembler: TopicWireFrameAssembler<WorkspaceConfigTopicFrame>;
  assemblyTimer: ReturnType<typeof setTimeout> | null;
}

type TopicDeliveryKind = "initial" | "online" | "recovery";

interface TopicRecoveryState {
  generation: number;
  subscriptionId: string;
  forceSnapshot: boolean;
  ackReceived: boolean;
  frameApplied: boolean;
  upgradeToSnapshot: boolean;
  postRecoveryGapPending: boolean;
  frameDeadline: ReturnType<typeof setTimeout> | null;
}

interface PendingTopicFrames<TFrame> {
  generation: number;
  frames: TFrame[];
  stagedBytes: number;
  recoveryNeeded: boolean;
}

export function createZCodeTaskIndexSyncer(
  options: CreateZCodeTaskIndexSyncerOptions,
): ZCodeTaskIndexSyncer {
  const { agentService, taskIndexRepo } = options;
  // task index 的事件摄入从旧协议 shadow 订阅（session/subscribe +
  // session/event + state.updated）整体迁到 v4 帧——sessions-index topic 提供
  // status(phase)/title/lastActivity 的 workspace 级 conflated 最新态，
  // workspace-config topic 提供配置目录热更新；正文搜索索引在 phase 终态迁移时
  // 回源完整 snapshot 收敛（v4 命令路径不再有 op 驱动的 snapshot 同步兜底）。
  const workspaceIngests = new Map<string, WorkspaceIngestState>();
  // 之前 workspaceEmitters 私有在 adapter 里，syncer 写完 sqlite 没有广播渠道，
  // UI 永远收不到 workspace_task_list_changed。把 emitter 上提到 syncer，adapter 改为转发，
  // 让 adapter 路径和 desktop-continuous 路径共用同一份订阅，事件不再分裂。
  const workspaceEmitters = new Map<string, Emitter<ZCodeWorkspaceEvent>>();
  const terminalEventEmitter = new Emitter<ZCodeTaskIndexTerminalEvent>();
  const readyEventEmitter = new Emitter<ZCodeTaskIndexReadyEvent>();
  let disposed = false;

  const indexTopicFor = (state: WorkspaceIngestState) =>
    sessionsIndexTopic(resolveWorkspaceKey(state.target));
  const configTopicFor = (state: WorkspaceIngestState) =>
    workspaceConfigTopic(resolveWorkspaceKey(state.target));
  const isProviderNotReadyError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
  const isRuntimeUnavailableError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  const logTopicSubscribeFailure = (
    state: WorkspaceIngestState,
    topic: TaskIndexTopicKind,
    reason: TopicSubscribeReason,
    error: unknown,
    retryKind: TopicRetryKind,
  ): void => {
    const message = `task index ${topic} 订阅失败 reason=${reason} workspace=${state.target.workspacePath}`;
    if (retryKind === "provider-not-ready") {
      // 新用户尚未配置模型是正常等待态；每个 workspace 的两个 topic 若持续 warn，
      // 会在用户进行任何操作前先制造日志风暴。debug 在 production 构建中不会落盘。
      logger.debug(undefined, message, error);
      return;
    }

    const lastWarnAt = topic === "sessions-index" ? state.indexLastWarnAt : state.configLastWarnAt;
    const now = Date.now();
    if (lastWarnAt === null || now - lastWarnAt >= TOPIC_SUBSCRIBE_WARN_INTERVAL_MS) {
      if (topic === "sessions-index") state.indexLastWarnAt = now;
      else state.configLastWarnAt = now;
      logger.warn(undefined, message, error);
      return;
    }
    // 高频重试细节只用于本地排查，不能和消息流同量级写入生产日志。
    logger.debug(undefined, message, error);
  };
  const createPendingFrames = <TFrame>(generation: number): PendingTopicFrames<TFrame> => ({
    generation,
    frames: [],
    stagedBytes: 0,
    recoveryNeeded: false,
  });
  const discardPendingFrames = <TFrame>(pending: PendingTopicFrames<TFrame> | null): void => {
    if (!pending) return;
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };
  const frameBytes = (
    frame: SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  ): number => new TextEncoder().encode(JSON.stringify(frame)).byteLength;
  const stagePendingFrame = <
    TFrame extends SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  >(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    pending: PendingTopicFrames<TFrame>,
    frame: TFrame,
  ): void => {
    if (pending.recoveryNeeded) return;
    const bytes = frameBytes(frame);
    if (
      bytes > MAX_PENDING_TOPIC_BYTES ||
      pending.frames.length + 1 > MAX_PENDING_TOPIC_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_TOPIC_BYTES
    ) {
      // ACK-only 的 initial notification 会在 Promise continuation 前到达。订阅建立前的
      // 暂存缓冲区超限时，既不能无界积压，也不能丢帧了事；此时尚未取得可证明的 base，
      // 因此标记需要恢复，待 ACK 到达后仅为该 topic 发起新一代 snapshot 订阅。
      discardPendingFrames(pending);
      pending.recoveryNeeded = true;
      logger.warn(
        undefined,
        `task index ${kind} ACK staging overflow; recovery-needed workspace=${resolveWorkspaceKey(state.target)}`,
      );
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
  const clearIndexPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.indexPending);
    state.indexPending = null;
    state.indexAssembler.clear();
  };
  const clearConfigPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.configPending);
    state.configPending = null;
    state.configAssembler.clear();
  };
  const clearPendingState = (state: WorkspaceIngestState): void => {
    clearIndexPendingState(state);
    clearConfigPendingState(state);
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    state.assemblyTimer = null;
  };
  const unsubscribeIndex = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeSessionsIndexV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `清理 task index sessions-index 订阅失败 workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };
  const unsubscribeConfig = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `清理 task index workspace-config 订阅失败 workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };
  const clearActiveSubscriptions = (state: WorkspaceIngestState): void => {
    const indexSubscriptionId = state.indexSubscriptionId;
    const configSubscriptionId = state.configSubscriptionId;
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
    if (indexSubscriptionId) void unsubscribeIndex(state, indexSubscriptionId);
    if (configSubscriptionId) void unsubscribeConfig(state, configSubscriptionId);
  };

  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    const key =
      typeof workspace === "string"
        ? workspace
        : resolveWorkspaceKey({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          });
    let emitter = workspaceEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeWorkspaceEvent>();
      workspaceEmitters.set(key, emitter);
    }
    return emitter;
  }

  function emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void {
    // 排查日志（左侧列表随输入框操作刷新）：确认哪些操作在发 task list 广播、reason 是什么。
    logger.debug(
      undefined,
      `[list-refresh-trace] emitWorkspaceTaskListChanged reason=${reason} taskId=${target.taskId ?? "-"} workspace=${target.workspacePath} hasMeta=${Boolean(taskMeta)}`,
    );
    getWorkspaceEmitter({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    }).fire({
      type: "workspace_task_list_changed",
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
      reason,
      ...(taskMeta ? { taskMeta } : {}),
      ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
    });
  }

  async function resyncTaskIndexRowFromAgent(
    target: ZCodeAgentSessionTarget,
    reason: string,
    options?: {
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
    },
  ): Promise<void> {
    try {
      // task-index 是被动观察者，只能读取现有 runtime。调用 resumeSession
      // 会在用户下一轮 prompt 已被 Core 接受后重新 materialize/resume 同一 session，
      // 形成第二个生命周期 writer；readSession(existing-only) 保留完整 snapshot
      // 的索引能力，同时不会拉起或修改 runtime。
      const snapshot = await agentService.readSession({
        ...target,
        runtimePolicy: "existing-only",
      });
      // 回源收敛是状态/正文同步，不涉及 pin/archive/unread 归属（task_status_changed）。
      await syncSnapshotAndBroadcast(snapshot, {
        ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
        broadcastReason: "task_status_changed",
        moveGroupedTaskToTop: options?.moveGroupedTaskToTop,
      });
    } catch (error) {
      logger.warn(
        undefined,
        `回源同步 task index 行失败 reason=${reason} taskId=${target.sessionId}`,
        error,
      );
    }
  }

  function sessionTargetFrom(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): ZCodeAgentSessionTarget {
    return {
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId,
    };
  }

  function broadcastTargetFrom(target: ZCodeAgentSessionTarget): WorkspaceBroadcastTarget {
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.sessionId,
    };
  }

  function emitTerminalAndReady(target: ZCodeAgentSessionTarget, summary: SessionSummary): void {
    const phase = summary.phase;
    const failed = phase === "error";
    // 顺序保持旧协议语义：先 turn 终态（收口当前 input），再 prompt ready（放行下一条）。
    terminalEventEmitter.fire({
      target,
      kind: failed ? "turn.failed" : "turn.completed",
    });
    readyEventEmitter.fire({
      target,
      reason: failed ? "prompt_failed" : "prompt_completed",
    });
  }

  /** phase 终态迁移 → sqlite status 收敛 + 广播 + 回源正文索引。 */
  function applyTerminalTransition(
    target: ZCodeAgentSessionTarget,
    summary: SessionSummary,
    options?: { moveGroupedTaskToTop?: boolean },
  ): void {
    emitTerminalAndReady(target, summary);
    const failed = summary.phase === "error";
    const unreadSignal = resolveTerminalUnreadSignal(summary);
    logger.debug(undefined, "task 终态未读裁决", {
      goalStatus: summary.goalStatus ?? null,
      phase: summary.phase,
      taskId: target.sessionId,
      unreadSignal: unreadSignal ?? null,
    });
    const updatedAt = Date.now();
    void taskIndexRepo
      .applyAgentPatch({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        // error 的 lastError 详情不在 sessions-index 摘要里，留给随后的回源 snapshot
        // 写权威值（patch 不带 lastError 键 = 保留现值）；completed 沿旧语义清空。
        patch: failed
          ? { status: "error", updatedAt }
          : { status: "completed", lastError: undefined, updatedAt },
      })
      .then((meta) => {
        if (meta) {
          // 之前只更新 sqlite 不广播，UI 监听 workspace_task_list_changed 收不到通知，
          // 导致 spinner 不消失、updatedAt 排序不刷新。补一次广播让列表收敛。
          // 终态收敛是 status 变更，必须用 task_status_changed；
          // 之前落缺省 task_meta_changed，每次 turn 完成都会全局 bump membership
          // 版本号，所有列表实例重拉归属，表现为"任务结束左侧列表闪一下"。
          emitWorkspaceTaskListChanged(
            broadcastTargetFrom(target),
            meta,
            "task_status_changed",
            unreadSignal ? { unreadSignal } : undefined,
          );
        }
        // 终态读取完整 snapshot：v4 命令路径（createSession/sendText 走 v4/command）
        // 不经过 zcodeSessionService 的 op 驱动 snapshot 同步，行缺失/正文搜索/lastError
        // 全靠这里收敛；readSession(existing-only) 只读现有 runtime，不重新恢复 session。
        void resyncTaskIndexRowFromAgent(target, failed ? "phase.error" : "phase.completed", {
          moveGroupedTaskToTop: options?.moveGroupedTaskToTop,
          // patch 已广播时不能让随后的 snapshot 回源再次制造完成提醒；
          // 行缺失时则把同一 signal 交给回源结果，保证提醒既不丢也不重复。
          ...(meta || !unreadSignal ? {} : { unreadSignal }),
        });
      })
      .catch((error) => {
        logger.warn(
          undefined,
          `同步 v4 phase 终态到 task index 失败 taskId=${target.sessionId}`,
          error,
        );
      });
  }

  /** 标题变化 → sqlite title patch；行缺失回源完整 snapshot（对齐旧 first_input 语义）。 */
  function applyTitleChange(target: ZCodeAgentSessionTarget, title: string): void {
    const updatedAt = Date.now();
    void taskIndexRepo
      .applyAgentPatch({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        patch: { title, updatedAt },
      })
      .then((meta) => {
        if (meta) {
          // 标题变更（首条消息/自动标题生成）与归属无关且每个任务必发，
          // 用专属 reason，避免每次首发/收口标题落盘都触发全局 membership 重拉。
          emitWorkspaceTaskListChanged(broadcastTargetFrom(target), meta, "task_title_changed");
        } else {
          // draft session 不预写占位行；首个标题（旧 first_input）先于任何
          // snapshot upsert 到达时按完整 snapshot 回源，避免依赖空 session 占位行。
          // v4 createSession 不经过 zcodeSessionService.createSession；首个标题到达且
          // task index 尚无行，说明这是新会话首次落库。回源时必须同时写 grouped 顶层最小
          // sort_order，否则缺序节点会被客户端补到列表末尾。
          void resyncTaskIndexRowFromAgent(target, "meta.titleUpdated", {
            moveGroupedTaskToTop: true,
          });
        }
      })
      .catch((error) => {
        logger.warn(
          undefined,
          `同步 v4 标题变更到 task index 失败 taskId=${target.sessionId}`,
          error,
        );
      });
  }

  /** 单条 summary 对基线 diff：draft 跳过；terminal 迁移/标题变化各自收敛。 */
  function processSummary(
    state: WorkspaceIngestState,
    previous: SessionSummary | undefined,
    next: SessionSummary,
    _deliveryKind: TopicDeliveryKind,
  ): void {
    state.summaries.set(next.sessionId, next);
    // draft 裁决：纯内存态、不落盘，也绝不进 task index sqlite。
    if (next.phase === "draft") {
      return;
    }
    const target = sessionTargetFrom(state.target, next.sessionId);
    const becameVisibleTask = previous === undefined || previous.phase === "draft";
    // 终态迁移 = 基线里真实观察到非终态 → 终态。无基线的会话（冷恢复 hydration、
    // 断档降级后新出现的历史会话）不回放终态；活跃会话必先以 running/prewarming
    // 进入基线（gateway 每个事件都 fan-out），不会漏掉真实收口。
    const becameTerminal =
      previous !== undefined && !isTerminalPhase(previous.phase) && isTerminalPhase(next.phase);
    if (becameTerminal) {
      applyTerminalTransition(target, next, {
        moveGroupedTaskToTop: becameVisibleTask,
      });
      return;
    }
    if (becameVisibleTask) {
      // v4 预热 session 从 draft 提升，或 online delta 首次出现新 session 时，
      // 不经过 zcodeSessionService.createSession。此处是最早且不依赖标题时序的新任务边界；
      // 立即回源写入 task 行与 grouped root 最小 sort_order，避免缺序节点落到末尾。
      void resyncTaskIndexRowFromAgent(target, "session.became-visible", {
        moveGroupedTaskToTop: true,
      });
      return;
    }
    const title = next.title.trim();
    if (title && (previous === undefined || previous.title !== next.title)) {
      applyTitleChange(target, title);
    }
  }

  async function seedMissingRowsFromInitialSnapshot(
    state: WorkspaceIngestState,
    summaries: Iterable<SessionSummary>,
  ): Promise<void> {
    const candidates = [...summaries].filter((summary) => summary.phase !== "draft");
    if (candidates.length === 0) return;
    // 纯 V4 UI 不经过 zcodeSessionService.initializeWorkspace；若把首帧
    // 当成“已有 sqlite 存量”的静默基线，远端新库就会永远是 0 行。这里只做原子
    // insert-if-missing，不广播、不回放历史终态，也不覆盖已有产品壳状态；后续打开/
    // 收口时再由完整 snapshot 补 model、正文搜索等权威字段。
    // 防灾保护：历史会话可能很多，不能一次创建等量 Promise 挤占 host 事件循环。
    // 固定小批次写入；失败只汇总一条生产日志，避免逐会话错误再次制造日志风暴。
    let failedCount = 0;
    let firstError: unknown;
    for (let offset = 0; offset < candidates.length; offset += INITIAL_BASELINE_SEED_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + INITIAL_BASELINE_SEED_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((summary) =>
          taskIndexRepo.seedTaskMetaIfMissing(buildBaselineMetaFromSummary(state.target, summary)),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failedCount += 1;
          firstError ??= result.reason;
        }
      }
    }
    if (failedCount > 0) {
      logger.warn(
        undefined,
        `首次 sessions-index 基线补齐 task index 失败 workspace=${resolveWorkspaceKey(state.target)} failed=${failedCount} total=${candidates.length}`,
        firstError,
      );
    }
  }

  function deliveryKindOf(event: unknown): TopicDeliveryKind {
    const deliveryKind = (event as { deliveryKind?: unknown }).deliveryKind;
    return deliveryKind === "initial" || deliveryKind === "recovery" ? deliveryKind : "online";
  }

  function faultDeliveryKindOf(event: unknown): TopicDeliveryKind | undefined {
    const deliveryKind = (event as { fault?: { deliveryKind?: unknown } }).fault?.deliveryKind;
    return deliveryKind === "initial" || deliveryKind === "online" || deliveryKind === "recovery"
      ? deliveryKind
      : undefined;
  }

  function isLiveState(state: WorkspaceIngestState): boolean {
    return !disposed && workspaceIngests.get(resolveWorkspaceKey(state.target)) === state;
  }

  function clearRecoveryDeadline(recovery: TopicRecoveryState | null): void {
    if (!recovery?.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  function discardIndexRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.indexRecovery);
    state.indexRecovery = null;
  }

  function discardConfigRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.configRecovery);
    state.configRecovery = null;
  }

  function settleIndexRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.indexRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardIndexRecovery(state);
      if (recovery.forceSnapshot) void subscribeIndexTopic(state, "snapshot-recovery-gap", true);
      else requestIndexRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardIndexRecovery(state);
      if (followup) requestIndexRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.indexRecovery !== recovery || recovery.frameApplied) return;
      discardIndexRecovery(state);
      if (!recovery.forceSnapshot) requestIndexRecovery(state, true);
      else void subscribeIndexTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function settleConfigRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.configRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardConfigRecovery(state);
      if (recovery.forceSnapshot) void subscribeConfigTopic(state, "snapshot-recovery-gap", true);
      else requestConfigRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardConfigRecovery(state);
      if (followup) requestConfigRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.configRecovery !== recovery || recovery.frameApplied) return;
      discardConfigRecovery(state);
      if (!recovery.forceSnapshot) requestConfigRecovery(state, true);
      else void subscribeConfigTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function completeIndexRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.indexRecovery) return;
    state.indexRecovery.frameApplied = true;
    settleIndexRecovery(state, state.indexRecovery);
  }

  function completeConfigRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.configRecovery) return;
    state.configRecovery.frameApplied = true;
    settleConfigRecovery(state, state.configRecovery);
  }

  function requestIndexRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.indexSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.indexRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleIndexRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.indexHasAppliedBase || state.indexLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.indexRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.indexRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.indexLogEpoch!, seq: state.indexSeq };
    void agentService
      .resyncSessionsIndexV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        if (
          state.indexSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardIndexRecovery(state);
          void subscribeIndexTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleIndexRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        discardIndexRecovery(state);
        logger.warn(
          undefined,
          `task index sessions-index resync 失败，改用新鲜订阅 workspace=${state.target.workspacePath}`,
          error,
        );
        void subscribeIndexTopic(state, "resync-failed", true);
      });
  }

  function requestConfigRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.configSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.configRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleConfigRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.configHasAppliedBase || state.configLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.configRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.configRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.configLogEpoch!, seq: state.configSeq };
    void agentService
      .resyncWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        if (
          state.configSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardConfigRecovery(state);
          void subscribeConfigTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleConfigRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        discardConfigRecovery(state);
        logger.warn(
          undefined,
          `task index workspace-config resync 失败，改用新鲜订阅 workspace=${state.target.workspacePath}`,
          error,
        );
        void subscribeConfigTopic(state, "resync-failed", true);
      });
  }

  function handleIndexGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.indexRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        // 强制 snapshot 仍断档说明当前 same-sub 流已不可证，
        // 不能继续猜测拼接，改为该 topic 的新代 snapshot 订阅。
        discardIndexRecovery(state);
        void subscribeIndexTopic(state, "force-recovery-gap", true);
      } else {
        requestIndexRecovery(state, true);
      }
      return;
    }
    requestIndexRecovery(state);
  }

  function handleConfigGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.configRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        discardConfigRecovery(state);
        void subscribeConfigTopic(state, "force-recovery-gap", true);
      } else {
        requestConfigRecovery(state, true);
      }
      return;
    }
    requestConfigRecovery(state);
  }

  function applySessionsIndexFrame(
    state: WorkspaceIngestState,
    frame: SessionsIndexTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (disposed) return;
    if (deliveryKind === "online" && state.indexRecovery && frame.payload.kind === "deltas") {
      if (state.indexRecovery.frameApplied && frame.toSeq > state.indexSeq) {
        state.indexRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (deliveryKind === "online" && state.indexHasAppliedBase && frame.toSeq <= state.indexSeq) {
        return;
      }
      state.indexLogEpoch = frame.payload.snapshot.logEpoch;
      state.indexSeq = frame.toSeq;
      state.indexHasAppliedBase = true;
      const nextSummaries = new Map<string, SessionSummary>();
      for (const summary of frame.payload.snapshot.sessions) {
        nextSummaries.set(summary.sessionId, summary);
      }
      if (!state.seeded) {
        // 首帧 = 静默基线：不回放历史终态、不发列表广播；仅原子补齐缺失行，
        // 防止远端/新安装的空 sqlite 因纯 V4 路径永远没有存量。
        state.summaries = nextSummaries;
        state.seeded = true;
        void seedMissingRowsFromInitialSnapshot(state, nextSummaries.values());
        const generation = state.indexSubscriptionGeneration;
        void repairSubagentTaskIndex({
          target: state.target,
          visibleSessionIds: new Set(nextSummaries.keys()),
          agentService,
          taskIndexRepo,
          isCurrent: () => isLiveState(state) && state.indexSubscriptionGeneration === generation,
          onRemoved: () =>
            emitWorkspaceTaskListChanged(state.target, undefined, "task_meta_changed"),
        }).catch((error) => {
          logger.warn(
            undefined,
            `子代理历史列表索引修复失败 workspace=${resolveWorkspaceKey(state.target)}`,
            error,
          );
        });
        completeIndexRecoveryFrame(state, deliveryKind);
        return;
      }
      // 断档降级 snapshot：对基线 diff 后处理，等价于补投丢失的 deltas（conflated 语义）。
      const previousSummaries = state.summaries;
      state.summaries = new Map();
      for (const summary of nextSummaries.values()) {
        processSummary(state, previousSummaries.get(summary.sessionId), summary, deliveryKind);
      }
      completeIndexRecoveryFrame(state, deliveryKind);
      return;
    }
    if (!state.indexHasAppliedBase) {
      // fresh task-index subscribe 从不携带 base；initial 整批丢失后任何 delta 都不能
      // 建立 cold baseline。只有 owned snapshot 可证明完整状态。
      handleIndexGap(state, deliveryKind === "recovery" ? "recovery" : "online");
      return;
    }
    if (frame.toSeq <= state.indexSeq) {
      // 任一完整校验的 recovery 若已被更晚权威 snapshot/online 覆盖，都可确认
      // delivery 成功；普通重复帧仍静默丢弃。
      if (deliveryKind === "recovery" && state.indexHasAppliedBase) {
        completeIndexRecoveryFrame(state, deliveryKind);
      }
      return;
    }
    if (frame.fromSeq !== state.indexSeq) {
      handleIndexGap(state, deliveryKind);
      return;
    }
    for (const delta of frame.payload.deltas) {
      if (delta.op === "session.upserted") {
        processSummary(
          state,
          state.summaries.get(delta.session.sessionId),
          delta.session,
          deliveryKind,
        );
        continue;
      }
      // session.removed：会话删除的 sqlite 收口走 task 删除操作（adapter deleteTask /
      // v4 deleteSession 命令的 host 侧收尾），这里只维护基线。
      state.summaries.delete(delta.sessionId);
    }
    state.indexSeq = frame.toSeq;
    state.indexHasAppliedBase = true;
    completeIndexRecoveryFrame(state, deliveryKind);
  }

  function applyWorkspaceConfigFrame(
    state: WorkspaceIngestState,
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (disposed) return;
    if (deliveryKind === "online" && state.configRecovery && frame.payload.kind === "deltas") {
      if (state.configRecovery.frameApplied && frame.toSeq > state.configSeq) {
        state.configRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (
        deliveryKind === "online" &&
        state.configHasAppliedBase &&
        frame.toSeq <= state.configSeq
      ) {
        return;
      }
      state.configLogEpoch = frame.payload.snapshot.logEpoch;
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    } else {
      if (!state.configHasAppliedBase) {
        handleConfigGap(state, deliveryKind === "recovery" ? "recovery" : "online");
        return;
      }
      if (frame.toSeq <= state.configSeq) {
        if (deliveryKind === "recovery" && state.configHasAppliedBase) {
          completeConfigRecoveryFrame(state, deliveryKind);
        }
        return;
      }
      if (frame.fromSeq !== state.configSeq) {
        handleConfigGap(state, deliveryKind);
        return;
      }
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    }
    const config =
      frame.payload.kind === "snapshot"
        ? frame.payload.snapshot.config
        : frame.payload.deltas.at(-1)?.config;
    if (!config || config.configOptions.length === 0) {
      // 空目录（无 live session 的订阅种子）不下发：下游 useZCodeConfig 收到空
      // configOptions 会把聊天工具栏的模型目录清掉。
      completeConfigRecoveryFrame(state, deliveryKind);
      return;
    }
    // v4 载荷与 ZCodeConfigOption 结构对齐（shared 黄金测试背书），零映射直通，
    // 下游 workspace_config_options_update 消费面（useZCodeConfig 等）不改。
    getWorkspaceEmitter({
      workspacePath: state.target.workspacePath,
      workspaceIdentity: state.target.workspaceIdentity,
    }).fire({
      type: "workspace_config_options_update",
      workspacePath: state.target.workspacePath,
      workspaceIdentity: state.target.workspaceIdentity,
      configOptions: config.configOptions,
    });
    completeConfigRecoveryFrame(state, deliveryKind);
  }

  function markAssemblyFault(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    reasonCode: string,
    deliveryKind: TopicDeliveryKind | undefined,
  ): void {
    logger.warn(
      undefined,
      `task index ${kind} physical assembly failed reason=${reasonCode} workspace=${resolveWorkspaceKey(state.target)}`,
    );
    if (kind === "sessions-index") {
      if (deliveryKind === "online" && state.indexRecovery) {
        state.indexRecovery.postRecoveryGapPending ||= state.indexRecovery.frameApplied;
        return;
      }
      // malformed deliveryKind 的 owned fault 不能被降成 online 后卡住已有 flight；
      // 已在恢复时按 recovery fault 推进升级，否则发起普通 same-sub resync。
      handleIndexGap(state, deliveryKind ?? (state.indexRecovery ? "recovery" : "online"));
    } else {
      if (deliveryKind === "online" && state.configRecovery) {
        state.configRecovery.postRecoveryGapPending ||= state.configRecovery.frameApplied;
        return;
      }
      handleConfigGap(state, deliveryKind ?? (state.configRecovery ? "recovery" : "online"));
    }
  }

  function scheduleAssemblyExpiry(state: WorkspaceIngestState): void {
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    const expiries = [state.indexAssembler.nextExpiryAt, state.configAssembler.nextExpiryAt].filter(
      (value): value is number => value !== null,
    );
    if (expiries.length === 0) {
      state.assemblyTimer = null;
      return;
    }
    const nextExpiryAt = Math.min(...expiries);
    const timer = setTimeout(
      () => {
        state.assemblyTimer = null;
        const now = Date.now();
        for (const event of state.indexAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "sessions-index",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        for (const event of state.configAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "workspace-config",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        scheduleAssemblyExpiry(state);
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
    timer.unref?.();
    state.assemblyTimer = timer;
  }

  function handleSessionsIndexWire(
    state: WorkspaceIngestState,
    wire: SessionsIndexTopicWireCandidate,
  ): void {
    if (disposed || wire.topic !== indexTopicFor(state)) return;
    // ownership 必须先于 assembly；foreign sub 不得占用 decoded staging。
    if (state.indexSubscriptionId === null) {
      if (state.indexPending) {
        stagePendingFrame(state, "sessions-index", state.indexPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.indexSubscriptionId) return;
    const events = state.indexAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.indexAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "sessions-index",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          applySessionsIndexFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  function handleWorkspaceConfigWire(
    state: WorkspaceIngestState,
    wire: WorkspaceConfigTopicWireCandidate,
  ): void {
    if (disposed || wire.topic !== configTopicFor(state)) return;
    if (state.configSubscriptionId === null) {
      if (state.configPending) {
        stagePendingFrame(state, "workspace-config", state.configPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.configSubscriptionId) return;
    const events = state.configAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.configAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "workspace-config",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          applyWorkspaceConfigFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  async function activateIndexSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<SessionsIndexTopicWireCandidate>,
    result: V4SessionsIndexSubscribeResult,
  ): Promise<void> {
    const stale =
      disposed ||
      generation !== state.indexSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      discardPendingFrames(pending);
      // runtime 换代可能复用 subscriptionId；迟到旧 ACK 不能
      // 反向退订已由新代接管的同 id route。
      if (state.indexSubscriptionId !== result.ack.subscriptionId) {
        await unsubscribeIndex(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.indexPending === pending) state.indexPending = null;
    if (pending.recoveryNeeded) {
      discardPendingFrames(pending);
      await unsubscribeIndex(state, result.ack.subscriptionId);
      if (generation === state.indexSubscriptionGeneration && isLiveState(state)) {
        void subscribeIndexTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.indexSubscriptionId = result.ack.subscriptionId;
    state.indexLogEpoch = result.ack.logEpoch;
    state.indexSeq = 0;
    // subscribe ACK 的 epoch/seq0 只是 admission metadata；initial physical
    // frame 可能尚未齐片或校验失败。只有 logical snapshot/delta 原子 apply 后才有 base。
    state.indexHasAppliedBase = false;
    discardIndexRecovery(state);
    state.indexRetryAttempt = 0;
    state.indexLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        handleSessionsIndexWire(state, frame);
      }
    }
  }

  async function activateConfigSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate>,
    result: V4WorkspaceConfigSubscribeResult,
  ): Promise<void> {
    const stale =
      disposed ||
      generation !== state.configSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      discardPendingFrames(pending);
      if (state.configSubscriptionId !== result.ack.subscriptionId) {
        await unsubscribeConfig(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.configPending === pending) state.configPending = null;
    if (pending.recoveryNeeded) {
      discardPendingFrames(pending);
      await unsubscribeConfig(state, result.ack.subscriptionId);
      if (generation === state.configSubscriptionGeneration && isLiveState(state)) {
        void subscribeConfigTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.configSubscriptionId = result.ack.subscriptionId;
    state.configLogEpoch = result.ack.logEpoch;
    state.configSeq = 0;
    state.configHasAppliedBase = false;
    discardConfigRecovery(state);
    state.configRetryAttempt = 0;
    state.configLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        handleWorkspaceConfigWire(state, frame);
      }
    }
  }

  function scheduleIndexRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.indexRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.indexRetryAttempt, 5));
    state.indexRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.indexRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeIndexTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.indexRetryTimer = timer;
  }

  function scheduleConfigRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.configRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.configRetryAttempt, 5));
    state.configRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.configRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeConfigTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.configRetryTimer = timer;
  }

  async function subscribeIndexTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    state.indexRetryTimer = null;
    const generation = ++state.indexSubscriptionGeneration;
    const previousSubscriptionId = state.indexSubscriptionId;
    state.indexSubscriptionId = null;
    discardIndexRecovery(state);
    clearIndexPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await unsubscribeIndex(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.indexSubscriptionGeneration) return;
    }
    const indexPending = createPendingFrames<SessionsIndexTopicWireCandidate>(generation);
    state.indexPending = indexPending;
    try {
      const result = await agentService.subscribeSessionsIndexV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateIndexSubscribe(state, generation, indexPending, result);
    } catch (error) {
      if (isLiveState(state) && state.indexSubscriptionGeneration === generation) {
        clearIndexPendingState(state);
        if (isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        logTopicSubscribeFailure(state, "sessions-index", reason, error, retryKind);
        scheduleIndexRetry(state, retryKind);
      }
    }
  }

  async function subscribeConfigTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.configRetryTimer = null;
    const generation = ++state.configSubscriptionGeneration;
    const previousSubscriptionId = state.configSubscriptionId;
    state.configSubscriptionId = null;
    discardConfigRecovery(state);
    clearConfigPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await unsubscribeConfig(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.configSubscriptionGeneration) return;
    }
    const configPending = createPendingFrames<WorkspaceConfigTopicWireCandidate>(generation);
    state.configPending = configPending;
    try {
      const result = await agentService.subscribeWorkspaceConfigV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateConfigSubscribe(state, generation, configPending, result);
    } catch (error) {
      if (isLiveState(state) && state.configSubscriptionGeneration === generation) {
        clearConfigPendingState(state);
        if (isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        logTopicSubscribeFailure(state, "workspace-config", reason, error, retryKind);
        scheduleConfigRetry(state, retryKind);
      }
    }
  }

  function ensureWorkspaceFrameListeners(state: WorkspaceIngestState): void {
    if (!isLiveState(state) || state.frameListenersInstalled) return;
    const workspace = state.target;
    // dormant state 跳过首次 establish，runtime available 后却直接走
    // resubscribe；默认 listener 已存在的话，同一 read 内紧随 response 的 initial
    // frame 无人消费。listener 必须在任一 subscribe 前同步安装，且跨 runtime 换代复用。
    state.disposables.push(
      agentService.onDynamicSessionsIndexFrame(workspace)((frame) =>
        handleSessionsIndexWire(state, frame),
      ),
      agentService.onDynamicWorkspaceConfigFrame(workspace)((frame) =>
        handleWorkspaceConfigWire(state, frame),
      ),
    );
    state.frameListenersInstalled = true;
  }

  async function establishWorkspaceSubscriptions(state: WorkspaceIngestState): Promise<void> {
    // 先挂帧监听再发起订阅：stdio 同一 read 会先 resolve response promise、再同步 fire
    // initial notification，而 await continuation 尚未运行；因此 handler 必须 staging，
    // 不能把“字节 response 在前”误当成“subscriptionId 已在 JS 状态里生效”。
    ensureWorkspaceFrameListeners(state);
    await Promise.all([
      subscribeIndexTopic(state, "initial", false),
      subscribeConfigTopic(state, "initial", false),
    ]);
  }

  /**
   * （CLI 重连重订）：agent 进程换代后，CLI 内存里的订阅全部丢失且不会有
   * gap 帧到达（订阅静默失活），ensureWorkspaceSubscription 的占位早退也不会重订。
   * 这里按 workspaceKey 重发 subscribe：帧监听挂在 workspace 级持久 emitter 上
   * （agentService wireClient 换代自动重接），只需刷新 subscriptionId 闸门；
   * 新 snapshot 帧对已 seeded 基线走既有“断档降级 snapshot” diff 路径收敛。
   */
  function resubscribeWorkspaceAfterRuntimeRestart(workspaceKey: string): void {
    if (disposed) return;
    const state = workspaceIngests.get(workspaceKey);
    if (!state) return;
    ensureWorkspaceFrameListeners(state);
    // 以前两个 topic 共用 Promise.all 代际，一侧暂态失败会
    // 撤销另一侧已成功的新订阅。现在各自 fresh subscribe + 退避重试。
    void subscribeIndexTopic(state, "runtime-restart", false);
    void subscribeConfigTopic(state, "runtime-restart", false);
  }

  const availableRuntimeGenerationByWorkspaceKey = new Map<string, number>();
  const hasRuntimeLifecycle = Boolean(agentService.onAgentRuntimeLifecycle);

  function suspendWorkspaceAfterRuntimeUnavailable(workspaceKey: string, generation: number): void {
    const state = workspaceIngests.get(workspaceKey);
    if (!state || state.runtimeGeneration !== generation) return;
    state.runtimeGeneration = null;
    state.indexSubscriptionGeneration += 1;
    state.configSubscriptionGeneration += 1;
    state.indexRecoveryGeneration += 1;
    state.configRecoveryGeneration += 1;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.indexRetryTimer = null;
    state.configRetryTimer = null;
    discardIndexRecovery(state);
    discardConfigRecovery(state);
    clearPendingState(state);
    // runtime 已退出后调用 unsubscribe/retry 会重新进入 getClient。
    // unavailable 只清本地 ownership；CLI 内订阅已随进程销毁，不再发送清理 RPC。
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
  }

  const runtimeLifecycleDisposable = agentService.onAgentRuntimeLifecycle?.((event) => {
    if (disposed) return;
    if (event.state === "unavailable") {
      if (
        availableRuntimeGenerationByWorkspaceKey.get(event.workspaceKey) ===
        event.runtimeIdentity.generation
      ) {
        availableRuntimeGenerationByWorkspaceKey.delete(event.workspaceKey);
      }
      suspendWorkspaceAfterRuntimeUnavailable(event.workspaceKey, event.runtimeIdentity.generation);
      return;
    }

    availableRuntimeGenerationByWorkspaceKey.set(
      event.workspaceKey,
      event.runtimeIdentity.generation,
    );
    const existing = workspaceIngests.get(event.workspaceKey);
    if (!existing) {
      ensureWorkspaceSubscription({
        workspacePath: event.workspacePath,
        workspaceIdentity: event.workspaceIdentity,
      });
      return;
    }
    if (existing.runtimeGeneration === event.runtimeIdentity.generation) return;
    existing.runtimeGeneration = event.runtimeIdentity.generation;
    resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey);
  });

  // 旧测试夹具/host 没有 lifecycle 时保留 restart 兼容；生产只走 available/unavailable。
  const runtimeRestartedDisposable = hasRuntimeLifecycle
    ? undefined
    : agentService.onAgentRuntimeRestarted?.((event) =>
        resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey),
      );

  function ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void {
    if (disposed) {
      return;
    }
    if (!target.workspacePath) {
      return;
    }
    const key = resolveWorkspaceKey(target);
    if (workspaceIngests.has(key)) {
      return;
    }
    const state: WorkspaceIngestState = {
      target: {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      },
      runtimeGeneration: availableRuntimeGenerationByWorkspaceKey.get(key) ?? null,
      indexSubscriptionId: null,
      configSubscriptionId: null,
      indexSubscriptionGeneration: 0,
      configSubscriptionGeneration: 0,
      indexPending: null,
      configPending: null,
      indexLogEpoch: null,
      indexSeq: 0,
      configLogEpoch: null,
      configSeq: 0,
      indexHasAppliedBase: false,
      configHasAppliedBase: false,
      indexRecovery: null,
      configRecovery: null,
      indexRecoveryGeneration: 0,
      configRecoveryGeneration: 0,
      indexRetryTimer: null,
      configRetryTimer: null,
      indexRetryAttempt: 0,
      configRetryAttempt: 0,
      indexLastWarnAt: null,
      configLastWarnAt: null,
      summaries: new Map(),
      seeded: false,
      frameListenersInstalled: false,
      disposables: [],
      indexAssembler: new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
      configAssembler: new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema),
      assemblyTimer: null,
    };
    // 占位先写入 Map，避免订阅建立期间的并发调用重复订阅。
    workspaceIngests.set(key, state);
    // lifecycle 可用时，缺 runtime 的 workspace 只保留 dormant 占位；被动 observer
    // 不得启动 CLI。旧 host 没有 lifecycle 时沿用显式 ensure 的兼容行为。
    if (!hasRuntimeLifecycle || state.runtimeGeneration !== null) {
      void establishWorkspaceSubscriptions(state);
    }
  }

  async function syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<ZCodeTaskMeta> {
    const meta = buildMetaFromSnapshot(snapshot, options);
    // 旧 child 标签页的显式 resume 仍会同步快照；只读详情不能重新写成主任务。
    if (snapshot.session.sessionKind === "subagent_child") return meta;
    // 同时把 snapshot.messages 里可见的聊天正文索引下去，
    // 让 TaskSearchDialog 正文搜索能命中；旧 sqlite 行下次到这里时自然回填。
    const searchableText = buildSearchableTextFromSnapshot(snapshot);
    // desktop-continuous 首发若先提交 task row、再补 grouped sort_order，
    // sessions-index 会在两次写之间把缺序 task 暴露给 Renderer，产生先到底部再回顶部的跳动。
    const { meta: persisted, initializedGroupedOrder } = options?.moveGroupedTaskToTop
      ? await taskIndexRepo.syncTaskMetaAtGroupedTop({ meta, searchableText })
      : {
          meta: await taskIndexRepo.syncTaskMeta({ meta, searchableText }),
          initializedGroupedOrder: false,
        };
    // createSession 刚回来时 snapshot 既没有 title 也没有 user message，
    // 默认 title 会落成 "New session" 占位符。这种"还没有任何用户内容"的快照不应该广播给 UI，
    // 否则侧边栏会先闪一下 "New session"，等 sendPrompt 完成后才换成真正的 prompt 文本。
    // sqlite 行仍然要写，让后续标题更新走 applyAgentPatch 时能找到对应行；那次
    // 标题触发的广播才是用户首次在列表里看到这个会话的时刻，标题直接就是 prompt 文本，不会闪。
    if (!hasUserVisibleContent(snapshot)) {
      if (initializedGroupedOrder) {
        // 预热 session 从 draft 提升时，grouped 顺序会先于首标题落库。
        // 即使暂时没有可广播的 task meta，也必须通知 renderer 重拉 structure；
        // 否则 sessions-index 已显示 task、structure 仍缺序，当前进程会把它补到末尾。
        emitWorkspaceTaskListChanged(
          {
            workspacePath: persisted.workspacePath,
            workspaceIdentity: persisted.workspaceIdentity,
            taskId: persisted.taskId,
          },
          undefined,
          "task_created",
        );
      }
      return persisted;
    }
    emitWorkspaceTaskListChanged(
      {
        workspacePath: persisted.workspacePath,
        workspaceIdentity: persisted.workspaceIdentity,
        taskId: persisted.taskId,
      },
      persisted,
      // sessions-index 可见帧可能早于首次 grouped sort_order 落库。
      // 首次初始化必须用 task_created 通知运行中的 grouped structure 缓存失效；
      // 重复 snapshot 没有新增顺序，仍保留调用方原本的 status/title 语义。
      initializedGroupedOrder ? "task_created" : options.broadcastReason,
      options.unreadSignal ? { unreadSignal: options.unreadSignal } : undefined,
    );
    return persisted;
  }

  async function syncTaskModel(
    target: ZCodeAgentSessionTarget,
    model: string,
  ): Promise<ZCodeTaskMeta | null> {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return null;
    }
    try {
      return await taskIndexRepo.updateTaskState({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        patch: { model: normalizedModel },
      });
    } catch (error) {
      logger.warn(undefined, `同步 task 模型到 task index 失败 taskId=${target.sessionId}`, error);
      return null;
    }
  }

  return {
    ensureWorkspaceSubscription,

    ensureSessionSubscription(
      target: ZCodeAgentSessionTarget,
      _options?: {
        includeSnapshot?: boolean;
      },
    ): void {
      if (!target.sessionId || !target.workspacePath) {
        return;
      }
      ensureWorkspaceSubscription({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
    },

    syncSnapshotAndBroadcast,

    syncTaskModel,

    emitWorkspaceTaskListChanged,

    getWorkspaceEmitter,

    onDynamicWorkspaceEvent(workspace: WorkspaceEventInput) {
      // 任务列表挂载会为所有 restored workspace 调用本入口。监听事件不代表
      // 用户使用该 workspace，禁止在这里激活 sessions-index 或启动 Agent。
      return getWorkspaceEmitter(workspace).event;
    },

    onSessionTerminalEvent: terminalEventEmitter.event,

    onSessionReadyEvent: readyEventEmitter.event,

    disposeAll(): void {
      disposed = true;
      for (const state of workspaceIngests.values()) {
        state.indexSubscriptionGeneration += 1;
        state.configSubscriptionGeneration += 1;
        state.indexRecoveryGeneration += 1;
        state.configRecoveryGeneration += 1;
        if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
        if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
        state.indexRetryTimer = null;
        state.configRetryTimer = null;
        discardIndexRecovery(state);
        discardConfigRecovery(state);
        clearPendingState(state);
        clearActiveSubscriptions(state);
        for (const disposable of state.disposables) {
          try {
            disposable.dispose();
          } catch {
            // 忽略 dispose 异常，确保所有订阅都尝试释放
          }
        }
      }
      workspaceIngests.clear();
      for (const emitter of workspaceEmitters.values()) {
        emitter.dispose();
      }
      workspaceEmitters.clear();
      terminalEventEmitter.dispose();
      readyEventEmitter.dispose();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartedDisposable?.dispose();
      availableRuntimeGenerationByWorkspaceKey.clear();
    },
  };
}

function buildMetaFromSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
  options?: {
    modelOverride?: string;
    thoughtLevelOverride?: string;
  },
): ZCodeTaskMeta {
  const modelOverride = options?.modelOverride?.trim();
  const thoughtLevelOverride = options?.thoughtLevelOverride?.trim();
  const meta: ZCodeTaskMeta = {
    taskId: snapshot.session.sessionId,
    traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
    title: deriveTitleFromSnapshot(snapshot),
    workspacePath: snapshot.session.workspace.workspacePath,
    workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    mode: fromZCodeMode(snapshot.session.mode),
    // 用户显式切模型或历史模型不可用时，session 操作已经带了新的可用模型。
    // 这类场景要同步覆盖 sqlite 的 task model，否则下次恢复仍会从已删除的历史模型起跳；
    // 普通历史快照仍走最近消息模型优先，避免被误污染的 settings.current 反向污染索引。
    model: modelOverride || formatTaskMetaModelSelectionFromSnapshot(snapshot),
    // 历史 task 恢复时 snapshot.settings.thoughtLevel 可能仍是同 workspace 草稿态的最新值。
    // 当恢复入口已经带上 task-local thoughtLevel 时，sqlite 必须写入入口值，避免下次打开继续被污染。
    thoughtLevel: thoughtLevelOverride || snapshot.settings.thoughtLevel.current,
    provider: ZCODE_AGENT_PROVIDER,
    status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
    lastError: snapshot.projection.lastError
      ? {
          code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          // sessions-index terminal resync 与 task service snapshot 必须共享同一份
          // lastError 归因，否则冷热两条读取路径的错误归因会漂移。
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
  };
  if (Object.prototype.hasOwnProperty.call(snapshot.projection, "target")) {
    // target 字段缺席表示本次 snapshot 未提供 goal 信息，不能覆盖旧索引；
    // null 才表示 DB 明确没有 goal，需要清空 task-index 中的目标。
    meta.target = snapshot.projection.target
      ? fromZCodeGoal(snapshot.projection.target)
      : snapshot.projection.target;
  }
  return meta;
}

function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

// createSession 刚返回时 snapshot 既没有真实 title 也没有 user message，
// 把这种"空白会话"广播出去会让侧边栏先闪一个 "New session" 占位符。
// 这里判断"是否已有用户可见内容"，没有就只写 sqlite 不广播，等真实 title 到了再广播。
function hasUserVisibleContent(snapshot: ZCodeSessionStateSnapshot): boolean {
  const title = snapshot.session.title?.trim() ?? "";
  if (title && !isZCodeGoalContinuationReminderText(title)) {
    return true;
  }
  if (snapshot.projection.target?.objective.trim()) {
    return true;
  }
  return snapshot.messages.some((message) => {
    if (message.info.role !== "user") return false;
    if (isZCodeModelOnlySyntheticUserMessage(message)) return false;
    return message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  });
}

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

// 全局会话搜索只索引默认可见的聊天正文，不包含思考过程、tool 调用和 compaction 折叠区。
// assistant 的 parts 可能既有历史正文又有 latest 正文，这里只取最后一段 text part，
// 与 UI 默认折叠后展示的范围一致。
function buildSearchableTextFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  const parts: string[] = [];
  let total = 0;
  // /goal 自动续跑会把内部 system-reminder 作为 runtime user turn 持久化；
  // 这条内容是 model-only 输入，不是用户可见 query，不能写进侧边栏搜索正文。
  for (const message of getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  })) {
    const textParts = message.parts.filter(
      (part): part is Extract<ZCodeMessagePart, { type: "text" }> => part.type === "text",
    );
    if (textParts.length === 0) {
      continue;
    }
    const chosen = message.info.role === "assistant" ? textParts.slice(-1) : textParts;
    for (const part of chosen) {
      const content = part.text.trim();
      if (!content) {
        continue;
      }
      parts.push(content);
      total += content.length;
      if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
        break;
      }
    }
    if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
      break;
    }
  }
  // 关键业务逻辑：上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
  return parts.join("\n").slice(0, TASK_SEARCH_TEXT_MAX_CHARS);
}

function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function fromZCodeGoal(
  goal: NonNullable<ZCodeSessionStateSnapshot["projection"]["target"]>,
): ZCodeTaskGoal {
  return {
    sessionID: goal.sessionId,
    targetID: goal.targetId,
    objective: goal.objective,
    summaryTitle: goal.summaryTitle,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    time: {
      created: goal.createdAt,
      updated: goal.updatedAt,
    },
  };
}
