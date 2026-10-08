import { z } from "zod";

export const RENDERER_ACTION_TRACE_SERVICE_NAME = "zcode-desktop-renderer";
export const RENDERER_ACTION_TRACE_MAX_SAMPLE_RATIO = 0.2;
export const RENDERER_ACTION_TRACE_MAX_BATCH_SPANS = 32;
export const RENDERER_ACTION_TRACE_MAX_BATCH_BYTES = 256 * 1024;

export const rendererActionTraceGroupSchema = z.enum([
  "core",
  "settings",
  "workbench",
  "extensions",
  "automation",
  "account",
]);
export type RendererActionTraceGroup = z.infer<typeof rendererActionTraceGroupSchema>;

export const rendererActionTraceConfigSchema = z
  .object({
    enabled: z.boolean(),
    localTtftEnabled: z.boolean().optional(),
    sampleRatio: z.number().finite().min(0).max(RENDERER_ACTION_TRACE_MAX_SAMPLE_RATIO),
    enabledGroups: z.array(rendererActionTraceGroupSchema).max(6),
    configVersion: z.string().trim().min(1).max(128),
  })
  .strict();
export type RendererActionTraceConfigV1 = z.infer<typeof rendererActionTraceConfigSchema>;

export const DISABLED_RENDERER_ACTION_TRACE_CONFIG: RendererActionTraceConfigV1 = {
  enabled: false,
  sampleRatio: 0,
  enabledGroups: [],
  configVersion: "disabled",
};

const hexTraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const hexSpanIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);
const boundedIdentifierSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const boundedValueSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/u);

export const rendererActionTraceAttributesSchema = z
  .object({
    feature_id: boundedIdentifierSchema,
    action: boundedIdentifierSchema,
    catalog_group: rendererActionTraceGroupSchema,
    operation_kind: z.enum(["navigation", "preference", "command", "management", "destructive"]),
    surface: boundedIdentifierSchema,
    trigger: z.enum(["button", "keyboard", "shortcut", "menu", "switch", "select", "drag"]),
    outcome: z.enum(["completed", "failed", "rejected", "cancelled", "noop", "abandoned"]),
    result_source: z
      .enum([
        "local_commit",
        "shared_settings",
        "setting_service",
        "platform_result",
        "authority_ack",
        "optimistic_projection",
      ])
      .optional(),
    failure_stage: boundedIdentifierSchema.optional(),
    state_after: z.enum(["enabled", "disabled"]).optional(),
    configured: z.boolean().optional(),
    requires_restart: z.boolean().optional(),
    section_id: boundedIdentifierSchema.optional(),
    value_after: boundedValueSchema.optional(),
    workspace_kind: z.enum(["local", "remote"]).optional(),
    remote_kind: z.enum(["ssh", "wsl", "docker", "server"]).optional(),
    admission_result: z
      .enum(["accepted", "rejected", "stale", "duplicate", "noop", "not_applicable"])
      .optional(),
    automation_kind: z.enum(["scheduled", "off_peak"]).optional(),
    action_id: z.string().uuid(),
  })
  .strict();
export type RendererActionTraceAttributes = z.infer<typeof rendererActionTraceAttributesSchema>;

export const rendererActionTraceSpanSchema = z
  .object({
    traceId: hexTraceIdSchema,
    spanId: hexSpanIdSchema,
    name: z.literal("ui_action"),
    startTimeUnixMs: z.number().finite().nonnegative(),
    endTimeUnixMs: z.number().finite().nonnegative(),
    status: z.enum(["unset", "ok", "error"]),
    attributes: rendererActionTraceAttributesSchema,
  })
  .strict()
  .superRefine((span, context) => {
    if (span.endTimeUnixMs < span.startTimeUnixMs) {
      context.addIssue({
        code: "custom",
        message: "endTimeUnixMs must be greater than or equal to startTimeUnixMs",
        path: ["endTimeUnixMs"],
      });
    }
  });
export type RendererActionTraceSpanV1 = z.infer<typeof rendererActionTraceSpanSchema>;

export const rendererActionTraceResourceSchema = z
  .object({
    serviceName: z.literal(RENDERER_ACTION_TRACE_SERVICE_NAME),
    serviceVersion: boundedIdentifierSchema,
    deploymentEnvironment: z.enum(["development", "test", "production"]),
    rendererInstanceId: boundedIdentifierSchema,
  })
  .strict();
export type RendererActionTraceResourceV1 = z.infer<typeof rendererActionTraceResourceSchema>;

export const rendererActionTraceBatchSchema = z
  .object({
    version: z.literal(1),
    rendererInstanceId: boundedIdentifierSchema,
    sequence: z.number().int().nonnegative(),
    droppedSinceLastFlush: z.number().int().nonnegative(),
    resource: rendererActionTraceResourceSchema,
    spans: z.array(rendererActionTraceSpanSchema).max(RENDERER_ACTION_TRACE_MAX_BATCH_SPANS),
  })
  .strict()
  .superRefine((batch, context) => {
    if (batch.resource.rendererInstanceId !== batch.rendererInstanceId) {
      context.addIssue({
        code: "custom",
        message: "rendererInstanceId must match the resource",
        path: ["resource", "rendererInstanceId"],
      });
    }
  });
export type RendererActionTraceBatchV1 = z.infer<typeof rendererActionTraceBatchSchema>;
