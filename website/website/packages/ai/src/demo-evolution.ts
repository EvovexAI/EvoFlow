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

export const evolutionActionSchema = z.enum([
  "rebuild_index",
  "run_sync",
  "generate_digest",
]);
export type EvolutionAction = z.infer<typeof evolutionActionSchema>;

export const evolutionRequestSchema = z.object({
  action: evolutionActionSchema.default("generate_digest"),
  locale: z.enum(["zh", "en"]).default("zh"),
});
export type EvolutionRequest = z.infer<typeof evolutionRequestSchema>;

export const evolutionRunResponseSchema = z.object({
  action: evolutionActionSchema,
  artifacts: z.array(aiArtifactSchema),
  bullets: z.array(z.string()).min(1),
  sources: z.array(chatSourceSchema),
  status: z.literal("completed"),
  summary: z.string(),
  toolCalls: z.array(chatToolCallSchema),
});
export type EvolutionRunResponse = z.infer<typeof evolutionRunResponseSchema>;

export const evolutionRunSnapshotStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);
export type EvolutionRunSnapshotStatus = z.infer<
  typeof evolutionRunSnapshotStatusSchema
>;

export const evolutionRunSnapshotSchema = z.object({
  action: evolutionActionSchema,
  artifacts: z.array(aiArtifactSchema),
  bullets: z.array(z.string()).min(1),
  error: z.string().nullable(),
  logLines: z.array(z.string()).min(1),
  runId: z.string().trim().min(1),
  sources: z.array(chatSourceSchema),
  status: evolutionRunSnapshotStatusSchema,
  summary: z.string().nullable(),
  toolCalls: z.array(chatToolCallSchema),
});
export type EvolutionRunSnapshot = z.infer<typeof evolutionRunSnapshotSchema>;

export function createEvolutionRunSnapshot(snapshot: EvolutionRunSnapshot) {
  return evolutionRunSnapshotSchema.parse(snapshot);
}

export interface EvolutionRadarMetric {
  label: string;
  value: number;
}

interface CreateEvolutionRunResponseArgs {
  action: EvolutionAction;
  artifacts?: EvolutionRunResponse["artifacts"];
  bullets: string[];
  locale: "zh" | "en";
  radarMetrics?: EvolutionRadarMetric[];
  sources: ChatSource[];
  summary: string;
  toolCalls: ChatToolCall[];
}

function buildEvolutionSources(
  action: EvolutionAction,
  locale: "zh" | "en",
): ChatSource[] {
  const shared: ChatSource[] = [
    {
      path: "DESIGN.md",
      title: locale === "zh" ? "总体技术设计" : "Technical design",
    },
    {
      path: "MEMORY.md",
      title: locale === "zh" ? "开发记忆与阶段进度" : "Development memory",
    },
  ];

  const actionSpecific: Record<EvolutionAction, ChatSource[]> = {
    generate_digest: [
      {
        path: "packages/content/src/platform-pages.ts",
        title: locale === "zh" ? "Admin / Evolution 内容源" : "Admin / evolution content",
      },
    ],
    rebuild_index: [
      {
        path: "apps/web/src/lib/chat/knowledge.ts",
        title: locale === "zh" ? "知识检索运行时" : "Knowledge retrieval runtime",
      },
    ],
    run_sync: [
      {
        path: "packages/content/src/home.ts",
        title: locale === "zh" ? "首页成长信号源" : "Homepage growth signal source",
      },
    ],
  };

  return [...shared, ...actionSpecific[action]];
}

function buildEvolutionToolCalls(
  action: EvolutionAction,
  locale: "zh" | "en",
): ChatToolCall[] {
  const shared: ChatToolCall[] = [
    {
      detail:
        locale === "zh"
          ? "读取当前平台状态与最近一次 Phase 1 收口进度"
          : "Loaded the current platform state and latest Phase 1 closing progress",
      name: "getDevelopmentMemory",
      status: "completed",
    },
  ];

  const actionSpecific: Record<EvolutionAction, ChatToolCall[]> = {
    generate_digest: [
      {
        detail:
          locale === "zh"
            ? "聚合 Stitch UI、GPT chat、workflow runtime 与 MCP bridge 的最近变更"
            : "Aggregated recent changes across Stitch UI, GPT chat, workflow runtime, and the MCP bridge",
        name: "collectGrowthSignals",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "生成本周 digest 草稿并映射为 artifact protocol"
            : "Generated the weekly digest draft and mapped it into the artifact protocol",
        name: "generateWeeklyDigest",
        status: "completed",
      },
    ],
    rebuild_index: [
      {
        detail:
          locale === "zh"
            ? "重新扫描知识源并刷新 sources 排名"
            : "Rescanned knowledge sources and refreshed source ranking",
        name: "rebuildKnowledgeIndex",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "重新校准 admin / chat / workflow 的 retrieval context"
            : "Recalibrated retrieval context for admin, chat, and workflow",
        name: "refreshRetrievalContext",
        status: "completed",
      },
    ],
    run_sync: [
      {
        detail:
          locale === "zh"
            ? "模拟执行 GitHub / Blog sync pipeline"
            : "Simulated the GitHub and Blog sync pipeline",
        name: "runRemoteSync",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "准备把新增事件写入 evolution timeline"
            : "Prepared new events for the evolution timeline",
        name: "prepareTimelineEvents",
        status: "completed",
      },
    ],
  };

  return [...shared, ...actionSpecific[action]];
}

function buildEvolutionBullets(
  action: EvolutionAction,
  locale: "zh" | "en",
) {
  if (action === "rebuild_index") {
    return locale === "zh"
      ? [
          "已重新扫描 `DESIGN.md`、`MEMORY.md` 与 typed content。",
          "知识索引版本已提升，sources 相关性排序已刷新。",
          "后续可把这条链路切换到真正的 worker job。",
        ]
      : [
          "Rescanned `DESIGN.md`, `MEMORY.md`, and typed content.",
          "The knowledge index version was bumped and source relevance was refreshed.",
          "This path can later be moved into a real worker job.",
        ];
  }

  if (action === "run_sync") {
    return locale === "zh"
      ? [
          "模拟执行 GitHub / Blog sync pipeline。",
          "新的进化事件已准备写入 timeline。",
          "下一阶段可接入真实远程源和持久化记录。",
        ]
      : [
          "Simulated the GitHub and Blog sync pipeline.",
          "New evolution events are ready to be written into the timeline.",
          "The next step is wiring real remote sources and persisted job history.",
        ];
  }

  return locale === "zh"
    ? [
        "已根据当前站点状态生成新的 digest 草稿。",
        "摘要聚焦 Stitch UI 落地、GPT chat、Workflow runtime 与 MCP bridge。",
        "下一步可投递到首页、管理台或邮件渠道。",
      ]
    : [
        "Generated a new digest draft based on the current platform state.",
        "The summary focuses on Stitch UI rollout, GPT chat, the workflow runtime, and the MCP bridge.",
        "It can later be delivered to the homepage, admin, or email channels.",
      ];
}

function buildEvolutionSummary(
  action: EvolutionAction,
  locale: "zh" | "en",
) {
  if (action === "rebuild_index") {
    return locale === "zh"
      ? "Knowledge index rebuild completed for the current Phase 1 scaffold."
      : "Knowledge index rebuild completed for the current Phase 1 scaffold.";
  }

  if (action === "run_sync") {
    return locale === "zh"
      ? "Sync pipeline finished in simulated mode and refreshed the evolution context."
      : "Sync pipeline finished in simulated mode and refreshed the evolution context.";
  }

  return locale === "zh"
    ? "Weekly digest draft generated for the current Phase 1 state."
    : "Weekly digest draft generated for the current Phase 1 state.";
}

function buildEvolutionArtifacts({
  action,
  radarMetrics,
  locale,
  sources,
  toolCalls,
}: {
  action: EvolutionAction;
  radarMetrics?: EvolutionRadarMetric[];
  locale: "zh" | "en";
  sources: ChatSource[];
  toolCalls: ChatToolCall[];
}) {
  const defaultRadarMetrics: Record<EvolutionAction, EvolutionRadarMetric[]> = {
    generate_digest: [
      { label: locale === "zh" ? "摘要覆盖" : "Digest coverage", value: 92 },
      { label: locale === "zh" ? "信号密度" : "Signal density", value: 88 },
      { label: locale === "zh" ? "投递准备" : "Delivery readiness", value: 84 },
      { label: locale === "zh" ? "内容贴合" : "Content fit", value: 90 },
    ],
    rebuild_index: [
      { label: locale === "zh" ? "索引新鲜度" : "Index freshness", value: 94 },
      { label: locale === "zh" ? "来源排序" : "Source ranking", value: 89 },
      { label: locale === "zh" ? "召回质量" : "Recall quality", value: 91 },
      { label: locale === "zh" ? "上下文对齐" : "Context alignment", value: 87 },
    ],
    run_sync: [
      { label: locale === "zh" ? "同步健康" : "Sync health", value: 90 },
      { label: locale === "zh" ? "事件摄入" : "Event ingestion", value: 86 },
      { label: locale === "zh" ? "时间线写入" : "Timeline write", value: 83 },
      { label: locale === "zh" ? "远程准备" : "Remote readiness", value: 79 },
    ],
  };

  return [
    ...buildChatArtifacts({
      model: "gpt-5-mini",
      sources,
      toolCalls,
    }),
    createArtifact("techRadar", {
      metrics: radarMetrics ?? defaultRadarMetrics[action],
      title: locale === "zh" ? "Evolution Control Radar" : "Evolution Control Radar",
    }),
  ];
}

export function createEvolutionRunResponse({
  action,
  artifacts,
  bullets,
  locale,
  radarMetrics,
  sources,
  summary,
  toolCalls,
}: CreateEvolutionRunResponseArgs): EvolutionRunResponse {
  return evolutionRunResponseSchema.parse({
    action,
    artifacts:
      artifacts ??
      buildEvolutionArtifacts({
        action,
        locale,
        radarMetrics,
        sources,
        toolCalls,
      }),
    bullets,
    sources,
    status: "completed",
    summary,
    toolCalls,
  });
}

export function generateDemoEvolutionResult(
  request: EvolutionRequest,
): EvolutionRunResponse {
  const sources = buildEvolutionSources(request.action, request.locale);
  const toolCalls = buildEvolutionToolCalls(request.action, request.locale);

  return createEvolutionRunResponse({
    action: request.action,
    bullets: buildEvolutionBullets(request.action, request.locale),
    locale: request.locale,
    sources,
    summary: buildEvolutionSummary(request.action, request.locale),
    toolCalls,
  });
}
