// CLI admission 后的自包含输入事实。
// queue / guide / runtime / transcript 只能携带同一个 intent，不允许各层重建字段。
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { modelSelectionSchema } from "../model-selection.js";
import { submissionModeSchema } from "./submission.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";

export const conversationInputDeliverySchema = z
  .object({
    requested: z.enum(["auto", "startNow", "queue", "guide"]),
    admitted: z.enum(["startNow", "queue", "guide"]),
    fallbackReasonCode: z.string().optional(),
  })
  .strict();

export const conversationInputOrderSchema = z
  .object({
    admissionSeq: z.number().int().nonnegative(),
    queuePosition: z.number().int().nonnegative().optional(),
  })
  .strict();

export const conversationInputSteerSchema = z
  .object({
    state: z.enum(["notRequested", "submitting", "steering", "guided", "fellBack"]),
    reasonCode: z.string().optional(),
  })
  .strict();

export const conversationInputDispatchSchema = z
  .object({
    state: z.enum(["admitted", "queued", "reserved", "promoting", "drained"]),
    reservationId: z.string().optional(),
  })
  .strict();

export const conversationInputIntentSchema = z
  .object({
    sourceCommandId: z.string().min(1),
    queueItemId: z.string().min(1),
    clientId: z.string().min(1),
    // compact 是可排队的维护意图；消费时走 compact lifecycle，不投影为 user row。
    kind: z.enum(["sendText", "sendGoalCommand", "compact"]),
    text: z.string(),
    attachments: z.array(attachmentRefSchema).default([]),
    // optional 只服务旧 snapshot hydration；新 admission 必须填入完整 Submission。
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    sharedContextRefs: z.array(sharedContextRefSchema).max(1).optional(),
    delivery: conversationInputDeliverySchema,
    order: conversationInputOrderSchema,
    steer: conversationInputSteerSchema,
    dispatch: conversationInputDispatchSchema,
    admittedAt: timestampSchema,
    provenance: z
      .object({
        sourceCommandId: z.string().min(1),
        queueItemId: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConversationInputIntent = z.infer<typeof conversationInputIntentSchema>;
