import type {
  TaskOwnerCommandDelivery,
  TaskOwnerCommandRequest,
  TaskOwnerCommandResult,
  TaskRealtimeDeliveredEvent,
  TaskRealtimeEvent,
  TaskRealtimeHostDeliveryKind,
  TaskRunLeaseAcquireRequest,
  TaskRunLeaseResult,
  TaskRunLeaseTarget,
  TaskStreamMirrorPublishOp,
  TaskStreamMirrorTarget,
} from "@zcode/shared";

export interface SessionRealtimePort {
  readonly hostId: string;
  readonly deliveryKind?: TaskRealtimeHostDeliveryKind;
  publish(event: TaskRealtimeEvent): void;
  acquireTaskRunLease(
    request: Omit<TaskRunLeaseAcquireRequest, "leaseRequestId">,
  ): Promise<TaskRunLeaseResult>;
  releaseTaskRunLease(target: TaskRunLeaseTarget): void;
  publishStreamOp(target: TaskStreamMirrorTarget, op: TaskStreamMirrorPublishOp): void;
  requestOwnerCommand(
    command:
      | Omit<Extract<TaskOwnerCommandRequest, { type: "stop_generation" }>, "commandRequestId">
      | Omit<Extract<TaskOwnerCommandRequest, { type: "respond_permission" }>, "commandRequestId">
      | Omit<Extract<TaskOwnerCommandRequest, { type: "respond_elicitation" }>, "commandRequestId">
      | Omit<
          Extract<TaskOwnerCommandRequest, { type: "respond_workspace_hook_review" }>,
          "commandRequestId"
        >
      | Omit<Extract<TaskOwnerCommandRequest, { type: "enqueue_task_command" }>, "commandRequestId">
      | Omit<Extract<TaskOwnerCommandRequest, { type: "promote_task_command" }>, "commandRequestId">
      | Omit<Extract<TaskOwnerCommandRequest, { type: "cancel_task_command" }>, "commandRequestId">,
  ): Promise<TaskOwnerCommandResult>;
  onDidReceiveEvent(listener: (event: TaskRealtimeDeliveredEvent) => void): {
    dispose(): void;
  };
  onDidReceiveOwnerCommand(listener: (command: TaskOwnerCommandDelivery) => void): {
    dispose(): void;
  };
  publishOwnerCommandResult(result: TaskOwnerCommandResult): void;
  dispose(): void;
}
