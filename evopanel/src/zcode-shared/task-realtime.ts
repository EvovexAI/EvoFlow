/* oxlint-disable eslint(max-lines) -- task realtime 共享合约集中维护，类型和 schema 需要保持就近。 */
// ── 旧协议兼容面（过渡期）──────────────────────────────
// 剩余 18 个导出：realtime 事件/lease/owner-command 接口类型。
// 消费者：desktop taskRealtimeBus/taskRealtimeBridge、services sessionRealtimePort、
// shared channels.ts（旧 host 通道表）。
// 运行时 zod schema 与 resolveWorkspaceKey 已迁 task-realtime-core.ts（幸存面）；
// 基础传输类型（TaskRealtimeReason/TaskStreamMirrorOp/TaskStreamWatermark 等）已迁
// zcode-task-types-core.ts。本文件与旧 realtime 总线组同生命周期。
import type {
  ZCodeTaskClientMode,
  ZCodeTaskRuntimeCommand,
  ZCodeTaskMeta,
  TraceId,
  TaskRealtimeReason,
  TaskStreamWatermark,
  TaskStreamMirrorUserMessageOp,
  TaskStreamMirrorStreamEventOp,
  TaskStreamMirrorOp,
} from "./zcode-task-types-core.js";
import type { ZCodePermissionResponse } from "./zcode-protocol-legacy-types.js";
import type { WorkspaceHookReviewDecision } from "./zcode-protocol-v4/workspace-hook-review.js";

export interface TaskRealtimeEnvelope {
  eventId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  traceId: TraceId;
  createdAt: number;
}

export interface TaskRealtimeInvalidationBaseEvent extends TaskRealtimeEnvelope {
  reason: TaskRealtimeReason;
  streamWatermark?: TaskStreamWatermark;
}

export interface TaskSnapshotInvalidatedEvent extends TaskRealtimeInvalidationBaseEvent {
  type: "task_snapshot_invalidated";
  taskId: string;
}

export interface WorkspaceTaskListInvalidatedEvent extends TaskRealtimeInvalidationBaseEvent {
  type: "workspace_task_list_invalidated";
  taskId?: string;
  taskMeta?: ZCodeTaskMeta;
}

export interface TaskStreamMirrorTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  runId: string;
  traceId: TraceId;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
}

export type TaskStreamMirrorPublishOp =
  | TaskStreamMirrorUserMessageOp
  | TaskStreamMirrorStreamEventOp;

export interface TaskStreamMirrorBatchEvent extends TaskRealtimeEnvelope {
  type: "task_stream_mirror_batch";
  taskId: string;
  runId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  batchSeq: number;
  fromSeq: number;
  toSeq: number;
  ops: TaskStreamMirrorOp[];
  terminal: boolean;
}

export type TaskRealtimeDeliveryPurpose = "observer" | "relay_owner";

export type TaskRealtimeHostDeliveryKind = "desktop_window" | "relay_bridge";

export interface TaskRunLeaseTarget extends TaskStreamMirrorTarget {}

export interface TaskRunLeaseAcquireRequest extends TaskRunLeaseTarget {
  leaseRequestId: string;
}

export type TaskRunLeaseResult =
  | { leaseRequestId: string; acquired: true; ownerHostId: string }
  | {
      leaseRequestId: string;
      acquired: false;
      ownerHostId: string;
      reason: "owned_by_other_host";
    };

export type TaskOwnerCommandRequest =
  | {
      commandRequestId: string;
      type: "stop_generation";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
    }
  | {
      commandRequestId: string;
      type: "respond_permission";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      permissionRequestId: string;
      optionId: string;
      response: ZCodePermissionResponse;
    }
  | {
      commandRequestId: string;
      type: "respond_elicitation";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      elicitationRequestId: string;
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    }
  | {
      commandRequestId: string;
      type: "respond_workspace_hook_review";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      remoteSessionId?: string;
      taskId: string;
      runId: string;
      sessionId: string;
      bundleDigest: string;
      reviewFlowId: string;
      generation: number;
      interactionId: string;
      decision: WorkspaceHookReviewDecision;
    }
  | {
      commandRequestId: string;
      type: "enqueue_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      taskCommand: Extract<ZCodeTaskRuntimeCommand, { type: "send_prompt" }>;
    }
  | {
      commandRequestId: string;
      type: "promote_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      commandId: string;
      clientMode: Extract<ZCodeTaskClientMode, "web-remote-replayable">;
    }
  | {
      commandRequestId: string;
      type: "cancel_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      commandId: string;
      clientMode: Extract<ZCodeTaskClientMode, "web-remote-replayable">;
    };

export type TaskOwnerCommandDelivery = TaskOwnerCommandRequest & {
  requesterHostId: string;
};

export type TaskOwnerCommandErrorCode =
  | "NO_ACTIVE_TASK_OWNER"
  | "STALE_TASK_OWNER_COMMAND"
  | "OWNER_COMMAND_FAILED";

export type TaskOwnerCommandResult =
  | { commandRequestId: string; success: true; taskCommand?: ZCodeTaskRuntimeCommand }
  | {
      commandRequestId: string;
      success: false;
      error: string;
      code?: TaskOwnerCommandErrorCode;
    };

export type TaskRealtimeEvent =
  | TaskSnapshotInvalidatedEvent
  | WorkspaceTaskListInvalidatedEvent
  | TaskStreamMirrorBatchEvent;

export type TaskRealtimeDeliveredEvent = TaskRealtimeEvent & {
  originHostId: string;
  deliveryPurpose?: TaskRealtimeDeliveryPurpose;
};
