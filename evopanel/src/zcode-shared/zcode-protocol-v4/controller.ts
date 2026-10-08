import { z } from "zod";
import { zcodeTaskMetaSchema } from "../validation.js";
import { pendingInteractionSummarySchema } from "./sessions-index.js";
import { sessionWorkflowActivitySchema } from "./sessions-index-workflow-activity.js";
import { sessionPhaseSchema } from "./snapshot.js";
import { subscribeAckSchema } from "./transport.js";

export const CONTROLLER_WORKSPACES_TOPIC = "controller/workspaces" as const;
export const CONTROLLER_TASKS_INDEX_TOPIC = "controller/tasks-index" as const;

export const windowHostControllerTopicSchema = z.enum([
  CONTROLLER_WORKSPACES_TOPIC,
  CONTROLLER_TASKS_INDEX_TOPIC,
]);
export type WindowHostControllerTopic = z.infer<typeof windowHostControllerTopicSchema>;

export const windowHostTaskAddressSchema = z
  .object({
    remoteSessionId: z.string().trim().min(1).optional(),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    taskId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((address, context) => {
    if (address.remoteSessionId && !address.workspaceIdentity) {
      context.addIssue({
        code: "custom",
        message: "remote task address requires workspaceIdentity",
        path: ["workspaceIdentity"],
      });
    }
  });
export type WindowHostTaskAddress = z.infer<typeof windowHostTaskAddressSchema>;

export const windowHostControllerWorkspaceFactSchema = z
  .object({
    remoteSessionId: z.string().trim().min(1).optional(),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    sourceAvailability: z.enum(["online", "offline"]),
    connectionState: z.enum([
      "connecting",
      "online",
      "closing",
      "failed",
      "disconnected",
      "reconnecting",
    ]),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (workspace.remoteSessionId && !workspace.workspaceIdentity) {
      context.addIssue({
        code: "custom",
        message: "remote workspace fact requires workspaceIdentity",
        path: ["workspaceIdentity"],
      });
    }
    if (
      workspace.sourceAvailability === "offline" &&
      workspace.connectionState !== "disconnected" &&
      workspace.connectionState !== "failed"
    ) {
      context.addIssue({
        code: "custom",
        message: "offline source must be disconnected or failed",
        path: ["connectionState"],
      });
    }
  });
export type WindowHostControllerWorkspaceFact = z.infer<
  typeof windowHostControllerWorkspaceFactSchema
>;

export const windowHostControllerTaskActivitySchema = z
  .object({
    phase: sessionPhaseSchema,
    lastActivityAt: z.number().finite().nonnegative(),
    hasBackgroundWork: z.boolean(),
    pendingInteractions: pendingInteractionSummarySchema.optional(),
    // 侧栏工作流运行行；无 run 时缺席。
    workflowActivity: sessionWorkflowActivitySchema.optional(),
  })
  .strict();
export type WindowHostControllerTaskActivity = z.infer<
  typeof windowHostControllerTaskActivitySchema
>;

export const windowHostControllerTaskRowSchema = z
  .object({
    address: windowHostTaskAddressSchema,
    meta: zcodeTaskMetaSchema,
    membership: z
      .object({
        pinned: z.boolean(),
        archived: z.boolean(),
        active: z.boolean(),
      })
      .strict(),
    sourceAvailability: z.enum(["online", "offline"]),
    liveStatus: z.enum(["idle", "running", "waiting", "completed", "error"]),
    activity: windowHostControllerTaskActivitySchema.optional(),
    searchSnippets: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      row.address.taskId !== row.meta.taskId ||
      row.address.workspacePath !== row.meta.workspacePath ||
      row.address.workspaceIdentity !== row.meta.workspaceIdentity
    ) {
      context.addIssue({
        code: "custom",
        message: "task address and meta identity must match",
        path: ["meta"],
      });
    }
  });
export type WindowHostControllerTaskRow = z.infer<typeof windowHostControllerTaskRowSchema>;

export type TaskListMembershipKind = "pinned" | "archived" | "timeline" | "active";

/** Host 查询和各 Renderer 投影共用的 task list membership 判定。 */
export function matchesTaskListMembershipKind(
  membership: Pick<WindowHostControllerTaskRow["membership"], "pinned" | "archived">,
  kind: TaskListMembershipKind,
): boolean {
  switch (kind) {
    case "pinned":
      return membership.pinned && !membership.archived;
    case "archived":
      return membership.archived;
    case "timeline":
      return !membership.pinned && !membership.archived;
    case "active":
      return !membership.archived;
  }
}

export const windowHostControllerWorkspacesSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    logEpoch: z.string().trim().min(1),
    workspaces: z.array(windowHostControllerWorkspaceFactSchema),
  })
  .strict();
export type WindowHostControllerWorkspacesSnapshot = z.infer<
  typeof windowHostControllerWorkspacesSnapshotSchema
>;

export const windowHostControllerTasksSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    logEpoch: z.string().trim().min(1),
    tasks: z.array(windowHostControllerTaskRowSchema),
  })
  .strict();
export type WindowHostControllerTasksSnapshot = z.infer<
  typeof windowHostControllerTasksSnapshotSchema
>;

export const windowHostControllerWorkspaceDeltaSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("workspace.upserted"),
      workspace: windowHostControllerWorkspaceFactSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("workspace.removed"),
      remoteSessionId: z.string().trim().min(1).optional(),
      workspacePath: z.string().trim().min(1),
      workspaceIdentity: z.string().trim().min(1).optional(),
    })
    .strict(),
]);
export type WindowHostControllerWorkspaceDelta = z.infer<
  typeof windowHostControllerWorkspaceDeltaSchema
>;

export const windowHostControllerTaskDeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("task.upserted"), task: windowHostControllerTaskRowSchema }).strict(),
  z.object({ op: z.literal("task.removed"), address: windowHostTaskAddressSchema }).strict(),
]);
export type WindowHostControllerTaskDelta = z.infer<typeof windowHostControllerTaskDeltaSchema>;

function createControllerFrameSchema<Snapshot extends z.ZodTypeAny, Delta extends z.ZodTypeAny>(
  topic: WindowHostControllerTopic,
  snapshotSchema: Snapshot,
  deltaSchema: Delta,
) {
  return z
    .object({
      topic: z.literal(topic),
      subscriptionId: z.string().trim().min(1),
      logEpoch: z.string().trim().min(1),
      fromSeq: z.number().int().nonnegative(),
      toSeq: z.number().int().nonnegative(),
      sentAt: z.number(),
      payload: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("snapshot"), snapshot: snapshotSchema }).strict(),
        z.object({ kind: z.literal("deltas"), deltas: z.array(deltaSchema) }).strict(),
      ]),
    })
    .strict()
    .superRefine((frame, context) => {
      if (frame.toSeq < frame.fromSeq) {
        context.addIssue({
          code: "custom",
          message: "toSeq must not be lower than fromSeq",
          path: ["toSeq"],
        });
      }
      const payload = frame.payload as
        | { kind: "snapshot"; snapshot: { logEpoch?: string } }
        | { kind: "deltas" };
      if (payload.kind === "snapshot") {
        if (frame.fromSeq !== 0) {
          context.addIssue({
            code: "custom",
            message: "snapshot frame must start at seq zero",
            path: ["fromSeq"],
          });
        }
        if (payload.snapshot.logEpoch !== frame.logEpoch) {
          context.addIssue({
            code: "custom",
            message: "frame and snapshot logEpoch must match",
            path: ["logEpoch"],
          });
        }
      }
    });
}

export const windowHostControllerWorkspaceFrameSchema = createControllerFrameSchema(
  CONTROLLER_WORKSPACES_TOPIC,
  windowHostControllerWorkspacesSnapshotSchema,
  windowHostControllerWorkspaceDeltaSchema,
);
export type WindowHostControllerWorkspaceFrame = z.infer<
  typeof windowHostControllerWorkspaceFrameSchema
>;

export const windowHostControllerTaskFrameSchema = createControllerFrameSchema(
  CONTROLLER_TASKS_INDEX_TOPIC,
  windowHostControllerTasksSnapshotSchema,
  windowHostControllerTaskDeltaSchema,
);
export type WindowHostControllerTaskFrame = z.infer<typeof windowHostControllerTaskFrameSchema>;

export const controllerSubscribeParamsSchema = z
  .object({
    topic: windowHostControllerTopicSchema,
    base: z
      .object({
        logEpoch: z.string().trim().min(1),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    visibility: z.enum(["foreground", "background"]).optional(),
  })
  .strict();
export type ControllerSubscribeParams = z.infer<typeof controllerSubscribeParamsSchema>;

export const controllerSubscribeResultSchema = z.object({ ack: subscribeAckSchema }).strict();
export type ControllerSubscribeResult = z.infer<typeof controllerSubscribeResultSchema>;

export const controllerResyncParamsSchema = z
  .object({
    subscriptionId: z.string().trim().min(1),
    base: z
      .object({
        logEpoch: z.string().trim().min(1),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    forceSnapshot: z.boolean().optional(),
  })
  .strict();
export type ControllerResyncParams = z.infer<typeof controllerResyncParamsSchema>;

export const controllerResyncResultSchema = z.object({ ack: subscribeAckSchema }).strict();
export type ControllerResyncResult = z.infer<typeof controllerResyncResultSchema>;

export const controllerUnsubscribeParamsSchema = z
  .object({ subscriptionId: z.string().trim().min(1) })
  .strict();
export type ControllerUnsubscribeParams = z.infer<typeof controllerUnsubscribeParamsSchema>;

export interface WindowHostControllerCursor {
  subscriptionId: string;
  logEpoch: string;
  seq: number;
}

export interface WindowHostControllerFrameStart {
  subscriptionId: string;
  logEpoch: string;
  fromSeq: number;
}

export function isWindowHostControllerFrameGap(
  cursor: WindowHostControllerCursor,
  frame: WindowHostControllerFrameStart,
): boolean {
  return (
    cursor.subscriptionId !== frame.subscriptionId ||
    cursor.logEpoch !== frame.logEpoch ||
    cursor.seq !== frame.fromSeq
  );
}
