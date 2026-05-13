import { z } from "zod";
import {
  aiArtifactSchema,
  buildChatArtifacts,
  createArtifact,
} from "./ai-ui/artifacts";
import {
  chatSourceSchema,
  chatToolCallSchema,
  type ChatSource,
  type ChatToolCall,
} from "./chat/demo-chat";

const accentSchema = z.enum(["primary", "secondary", "tertiary"]);

export const observabilitySnapshotRequestSchema = z.object({
  locale: z.enum(["zh", "en"]).default("zh"),
});
export type ObservabilitySnapshotRequest = z.infer<
  typeof observabilitySnapshotRequestSchema
>;

export const observabilityMetricSchema = z.object({
  accent: accentSchema,
  label: z.string(),
  value: z.string(),
});

export const observabilityTraceSchema = z.object({
  accent: accentSchema,
  detail: z.string(),
  status: z.string(),
  title: z.string(),
});

export const observabilitySessionSchema = z.object({
  accent: accentSchema,
  location: z.string(),
  state: z.string(),
  summary: z.string(),
  title: z.string(),
});

export const observabilitySnapshotResponseSchema = z.object({
  artifacts: z.array(aiArtifactSchema),
  metrics: z.array(observabilityMetricSchema).min(1),
  sessions: z.array(observabilitySessionSchema).min(1),
  sources: z.array(chatSourceSchema),
  status: z.literal("completed"),
  summary: z.string(),
  toolCalls: z.array(chatToolCallSchema),
  traces: z.array(observabilityTraceSchema).min(1),
});
export type ObservabilitySnapshotResponse = z.infer<
  typeof observabilitySnapshotResponseSchema
>;

function buildObservabilitySources(
  locale: "zh" | "en",
): ChatSource[] {
  return [
    {
      path: "packages/observability/src/llm-runs.ts",
      title: locale === "zh" ? "LLM Run 事件模型" : "LLM run event model",
    },
    {
      path: "packages/observability/src/tool-calls.ts",
      title: locale === "zh" ? "Tool Call 事件模型" : "Tool call event model",
    },
    {
      path: "packages/observability/src/visitor-sessions.ts",
      title: locale === "zh" ? "Visitor Session 事件模型" : "Visitor session event model",
    },
  ];
}

export function getObservabilitySources(locale: "zh" | "en") {
  return buildObservabilitySources(locale);
}

function buildObservabilityToolCalls(
  locale: "zh" | "en",
): ChatToolCall[] {
  return [
    {
      detail:
        locale === "zh"
          ? "聚合最近一次 `/api/chat`、`/api/workflow/run` 与 `/api/jobs/run` 的执行信号"
          : "Aggregated the latest execution signals from `/api/chat`, `/api/workflow/run`, and `/api/jobs/run`",
      name: "queryRuntimeTraces",
      status: "completed",
    },
    {
      detail:
        locale === "zh"
          ? "整理 visitor session 与 route-level activity 统计"
          : "Collected visitor sessions and route-level activity statistics",
      name: "queryVisitorSessions",
      status: "completed",
    },
    {
      detail:
        locale === "zh"
          ? "把 observability snapshot 映射成共享 artifact protocol"
          : "Mapped the observability snapshot into the shared artifact protocol",
      name: "emitObservabilityArtifacts",
      status: "completed",
    },
  ];
}

function buildObservabilityArtifacts({
  locale,
  sources,
  toolCalls,
}: {
  locale: "zh" | "en";
  sources: ChatSource[];
  toolCalls: ChatToolCall[];
}) {
  return [
    ...buildChatArtifacts({
      model: "gpt-5-mini",
      sources,
      toolCalls,
    }),
    createArtifact("techRadar", {
      metrics: [
        {
          label: locale === "zh" ? "轨迹密度" : "Trace density",
          value: 91,
        },
        {
          label: locale === "zh" ? "会话清晰度" : "Session clarity",
          value: 87,
        },
        {
          label: locale === "zh" ? "事件覆盖" : "Event coverage",
          value: 89,
        },
        {
          label: locale === "zh" ? "可回放性" : "Replayability",
          value: 84,
        },
      ],
      title: locale === "zh" ? "Observability Snapshot Radar" : "Observability Snapshot Radar",
    }),
  ];
}

interface CreateObservabilitySnapshotOptions {
  artifacts?: ObservabilitySnapshotResponse["artifacts"];
  locale: "zh" | "en";
  metrics: ObservabilitySnapshotResponse["metrics"];
  sessions: ObservabilitySnapshotResponse["sessions"];
  sources: ChatSource[];
  summary: string;
  toolCalls: ChatToolCall[];
  traces: ObservabilitySnapshotResponse["traces"];
}

export function createObservabilitySnapshot({
  artifacts,
  locale,
  metrics,
  sessions,
  sources,
  summary,
  toolCalls,
  traces,
}: CreateObservabilitySnapshotOptions): ObservabilitySnapshotResponse {
  return observabilitySnapshotResponseSchema.parse({
    artifacts:
      artifacts ??
      buildObservabilityArtifacts({
        locale,
        sources,
        toolCalls,
      }),
    metrics,
    sessions,
    sources,
    status: "completed",
    summary,
    toolCalls,
    traces,
  });
}

export function generateDemoObservabilitySnapshot(
  request: ObservabilitySnapshotRequest,
): ObservabilitySnapshotResponse {
  const sources = buildObservabilitySources(request.locale);
  const toolCalls = buildObservabilityToolCalls(request.locale);

  return createObservabilitySnapshot({
    locale: request.locale,
    metrics: [
      { accent: "primary", label: "LLM Runs", value: "264" },
      { accent: "secondary", label: "Tool Calls", value: "104" },
      { accent: "tertiary", label: "UI Actions", value: "41" },
    ],
    sessions: [
      {
        accent: "primary",
        location: request.locale === "zh" ? "上海" : "Shanghai",
        state: "inspecting /admin/jobs",
        summary:
          request.locale === "zh"
            ? "查看 Worker log、手动运行 GitHub Sync，并回看 artifact 结果区。"
            : "Inspected the worker log, manually ran GitHub Sync, and reviewed the artifact results.",
        title: request.locale === "zh" ? "访客会话 31DX" : "Visitor Session 31DX",
      },
      {
        accent: "secondary",
        location: request.locale === "zh" ? "新加坡" : "Singapore",
        state: "refreshing /admin/observability",
        summary:
          request.locale === "zh"
            ? "刷新 trace stream，对 chat / workflow / jobs / evolution 的运行边界做交叉检查。"
            : "Refreshed the trace stream and cross-checked the runtime boundaries across chat, workflow, jobs, and evolution.",
        title: request.locale === "zh" ? "访客会话 88QF" : "Visitor Session 88QF",
      },
    ],
    sources,
    summary:
      request.locale === "zh"
        ? "Observability snapshot 已刷新：当前可以同时观察 chat、workflow、jobs 与 evolution 几条主链路的运行信号，并把结果映射成同一套 artifact protocol。"
        : "The observability snapshot was refreshed. You can now inspect the runtime signals for chat, workflow, jobs, and evolution together and map them into the same artifact protocol.",
    toolCalls,
    traces: [
      {
        accent: "primary",
        detail:
          request.locale === "zh"
            ? "Loaded `/api/chat` response traces and verified that artifact-aware payloads include sources, toolCalls, and artifacts."
            : "Loaded `/api/chat` response traces and verified that artifact-aware payloads include sources, toolCalls, and artifacts.",
        status: request.locale === "zh" ? "已刷新" : "refreshed",
        title: "chat.runtime",
      },
      {
        accent: "secondary",
        detail:
          request.locale === "zh"
            ? "Inspected `/api/workflow/run` and `/api/jobs/run` to confirm shared response shapes across workflow and worker surfaces."
            : "Inspected `/api/workflow/run` and `/api/jobs/run` to confirm shared response shapes across workflow and worker surfaces.",
        status: request.locale === "zh" ? "已刷新" : "refreshed",
        title: "workflow.jobs.bridge",
      },
      {
        accent: "tertiary",
        detail:
          request.locale === "zh"
            ? "Replayed `/api/evolution` control traces and validated the latest digest / artifact payload boundary."
            : "Replayed `/api/evolution` control traces and validated the latest digest / artifact payload boundary.",
        status: request.locale === "zh" ? "已刷新" : "refreshed",
        title: "evolution.control",
      },
    ],
  });
}
