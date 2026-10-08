import { z } from "zod";
import { timestampSchema } from "./core.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const workspaceHookReviewTrustStateSchema = z.enum([
  "not_applicable",
  "pending_trust",
  "trusted_persistent",
  "blocked_untrusted",
  "blocked_policy",
  "revoked",
  "stale_digest",
]);
export type WorkspaceHookReviewTrustState = z.infer<typeof workspaceHookReviewTrustStateSchema>;

export const workspaceHookReviewDecisionSchema = z
  .object({
    action: z.literal("trust_selected"),
    reviewItemIds: z.array(nonEmptyStringSchema).min(1),
  })
  .strict()
  .superRefine((decision, context) => {
    if ("reviewItemIds" in decision && decision.reviewItemIds) {
      addDuplicateItemIssue(decision.reviewItemIds, context, ["reviewItemIds"]);
    }
  });
export type WorkspaceHookReviewDecision = z.infer<typeof workspaceHookReviewDecisionSchema>;

export const workspaceHookReviewCommandTargetSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
    reviewFlowId: nonEmptyStringSchema,
    generation: positiveIntegerSchema,
    interactionId: nonEmptyStringSchema,
  })
  .strict();
export type WorkspaceHookReviewCommandTarget = z.infer<
  typeof workspaceHookReviewCommandTargetSchema
>;

export const workspaceHookTrustRevokeTargetSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
    hookDeclarationDigests: z.array(sha256DigestSchema).min(1),
  })
  .strict()
  .superRefine((target, context) => {
    addDuplicateItemIssue(target.hookDeclarationDigests, context, ["hookDeclarationDigests"]);
  });
export type WorkspaceHookTrustRevokeTarget = z.infer<typeof workspaceHookTrustRevokeTargetSchema>;

// 软门禁：按需开审核 flow 的命令 target。
// 克隆 revoke 的 non-flow target 变体,但不需要 hookDeclarationDigests
// (审核 flow 从当前 snapshot 拉取全部 pending items,而非指定 declarations)。
export const requestWorkspaceHookReviewTargetSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
  })
  .strict();
export type RequestWorkspaceHookReviewTarget = z.infer<
  typeof requestWorkspaceHookReviewTargetSchema
>;

export const workspaceHookReviewRequestPayloadSchema = z
  .object({
    kind: z.literal("workspaceHookReview"),
    reviewFlowId: nonEmptyStringSchema,
    generation: positiveIntegerSchema,
    interactionId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    workspaceLabel: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema.optional(),
    bundleDigest: sha256DigestSchema,
    createdAt: timestampSchema,
    deadlineAt: timestampSchema,
    sourceFiles: z.array(
      z
        .object({
          path: nonEmptyStringSchema,
          displayPath: nonEmptyStringSchema,
          editable: z.boolean(),
        })
        .strict(),
    ),
    summary: z
      .object({
        eventCount: nonnegativeIntegerSchema,
        hookCount: nonnegativeIntegerSchema,
        pendingCount: nonnegativeIntegerSchema,
      })
      .strict(),
    items: z.array(
      z
        .object({
          reviewItemId: nonEmptyStringSchema,
          event: z.enum([
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PermissionRequest",
            "PostToolUse",
            "PostToolUseFailure",
            "Stop",
          ]),
          matcher: z.string().optional(),
          type: z.enum(["command", "process"]),
          displayName: nonEmptyStringSchema,
          displayCommand: nonEmptyStringSchema,
          sourcePath: nonEmptyStringSchema,
          resolvedTimeoutMs: positiveIntegerSchema,
          resolvedMaxOutputBytes: positiveIntegerSchema,
          executionMode: z.enum(["foreground", "background"]),
          configuredEnabled: z.boolean(),
          editable: z.boolean(),
          trustState: workspaceHookReviewTrustStateSchema,
        })
        .strict(),
    ),
    warningCode: z.literal("workspace_hooks_execute_code"),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.deadlineAt < request.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "deadlineAt must not precede createdAt",
      });
    }
    if (request.summary.hookCount !== request.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "hookCount"],
        message: "hookCount must match the immutable request items",
      });
    }
    const eventCount = new Set(request.items.map((item) => item.event)).size;
    if (request.summary.eventCount !== eventCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "eventCount"],
        message: "eventCount must match the immutable request items",
      });
    }
    const pendingCount = request.items.filter((item) =>
      ["pending_trust", "revoked", "stale_digest"].includes(item.trustState),
    ).length;
    if (request.summary.pendingCount !== pendingCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "pendingCount"],
        message: "pendingCount must match pending admission items",
      });
    }
    addDuplicateItemIssue(
      request.items.map((item) => item.reviewItemId),
      context,
      ["items"],
    );
  });
export type WorkspaceHookReviewRequestPayload = z.infer<
  typeof workspaceHookReviewRequestPayloadSchema
>;

export const presentWorkspaceHookReviewRequestSchema = z
  .object({
    reviewFlowId: nonEmptyStringSchema,
    generation: positiveIntegerSchema,
    interactionId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
    settingsSection: z.literal("hooks"),
    settingsScope: z.literal("workspace"),
  })
  .strict();
export type PresentWorkspaceHookReviewRequest = z.infer<
  typeof presentWorkspaceHookReviewRequestSchema
>;

function addDuplicateItemIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(values).size === values.length) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: "review item ids must be unique",
  });
}
