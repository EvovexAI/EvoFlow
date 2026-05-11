import { z } from "zod";
import {
  aiArtifactSchema,
  buildChatArtifacts,
  createArtifact,
  type AiArtifact,
} from "../ai-ui/artifacts";
import {
  chatModelSchema,
  chatSourceSchema,
  chatToolCallSchema,
  type ChatSource,
  type ChatToolCall,
} from "../chat/demo-chat";

export const workflowRunRequestSchema = z.object({
  locale: z.enum(["zh", "en"]).default("zh"),
  model: chatModelSchema.default("gpt-5"),
  prompt: z.string().trim().min(1).max(4000),
  temperature: z.number().min(0).max(1).default(0.72),
  workflowId: z.string().trim().min(1).max(100).default("neural-summarizer"),
});

export type WorkflowRunRequest = z.infer<typeof workflowRunRequestSchema>;

export const workflowRunResponseSchema = z.object({
  artifacts: z.array(aiArtifactSchema),
  log: z.object({
    latencyMs: z.number().positive(),
    lines: z.array(z.string()).min(1),
    status: z.string(),
  }),
  output: z.object({
    insight: z.string(),
    summary: z.string(),
    title: z.string(),
  }),
  sources: z.array(chatSourceSchema),
  toolCalls: z.array(chatToolCallSchema),
});

export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;

function compactPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();

  if (normalized.length <= 64) {
    return normalized;
  }

  return `${normalized.slice(0, 61)}...`;
}

function buildWorkflowSources(locale: "zh" | "en"): ChatSource[] {
  return [
    {
      path: "DESIGN.md",
      title: locale === "zh" ? "Workflow 运行时边界" : "Workflow runtime boundary",
    },
    {
      path: "packages/ai/src/ai-ui/artifacts.ts",
      title: locale === "zh" ? "Artifact protocol 定义" : "Artifact protocol definition",
    },
    {
      path: "MEMORY.md",
      title: locale === "zh" ? "Phase 1 收口进度" : "Phase 1 closing status",
    },
  ];
}

function buildWorkflowToolCalls(
  locale: "zh" | "en",
  promptFocus: string,
): ChatToolCall[] {
  return [
    {
      detail:
        locale === "zh"
          ? `规范化执行输入：${promptFocus}`
          : `Normalized workflow input: ${promptFocus}`,
      name: "normalizePrompt",
      status: "completed",
    },
    {
      detail:
        locale === "zh"
          ? "附加 3 条与 AI runtime / artifacts 最相关的知识上下文"
          : "Attached 3 ranked knowledge hits for AI runtime and artifacts",
      name: "searchKnowledge",
      status: "completed",
    },
    {
      detail:
        locale === "zh"
          ? "构建共享 artifact protocol，准备发往 workflow surface"
          : "Built the shared artifact protocol for the workflow surface",
      name: "emitArtifacts",
      status: "completed",
    },
    {
      detail:
        locale === "zh"
          ? "生成结构化 workflow digest 并准备下游 handoff"
          : "Generated the structured workflow digest for downstream handoff",
      name: "writeWorkflowDigest",
      status: "completed",
    },
  ];
}

function buildWorkflowArtifacts({
  locale,
  model,
  sources,
  toolCalls,
}: {
  locale: "zh" | "en";
  model: WorkflowRunRequest["model"];
  sources: ChatSource[];
  toolCalls: ChatToolCall[];
}): AiArtifact[] {
  return [
    ...buildChatArtifacts({
      model,
      sources,
      toolCalls,
    }),
    createArtifact("techRadar", {
      metrics: [
        {
          label: locale === "zh" ? "逻辑链路" : "Logic chain",
          value: model === "gpt-5" ? 92 : 86,
        },
        {
          label: locale === "zh" ? "上下文贴合" : "Context fit",
          value: 89,
        },
        {
          label: locale === "zh" ? "输出稳定性" : "Output stability",
          value: 94,
        },
        {
          label: locale === "zh" ? "可观测性" : "Observability",
          value: 88,
        },
      ],
      title: locale === "zh" ? "Workflow Fitness Radar" : "Workflow Fitness Radar",
    }),
  ];
}

export function generateDemoWorkflowRun(
  request: WorkflowRunRequest,
): WorkflowRunResponse {
  const promptFocus = compactPrompt(request.prompt);
  const sources = buildWorkflowSources(request.locale);
  const toolCalls = buildWorkflowToolCalls(request.locale, promptFocus);
  const latencyMs = request.model === "gpt-5" ? 31 : 21;

  return workflowRunResponseSchema.parse({
    artifacts: buildWorkflowArtifacts({
      locale: request.locale,
      model: request.model,
      sources,
      toolCalls,
    }),
    log: {
      latencyMs,
      lines:
        request.locale === "zh"
          ? [
              "Initializing node sequence...",
              `[14:22:01] Trigger::Prompt normalized "${promptFocus}"`,
              "[14:22:02] Knowledge::Attached 3 ranked sources",
              "[14:22:03] Runtime::Shared artifact protocol emitted",
              "[14:22:04] Output::Workflow digest ready for handoff",
            ]
          : [
              "Initializing node sequence...",
              `[14:22:01] Trigger::Prompt normalized "${promptFocus}"`,
              "[14:22:02] Knowledge::Attached 3 ranked sources",
              "[14:22:03] Runtime::Shared artifact protocol emitted",
              "[14:22:04] Output::Workflow digest ready for handoff",
            ],
      status:
        request.locale === "zh"
          ? "4 个节点已完成，artifact protocol 已发出"
          : "4 nodes completed, artifact protocol emitted",
    },
    output: {
      insight:
        request.locale === "zh"
          ? "下一步可以把这条链路替换成真实 tool execution、持久化 traces 和可回放 run history。"
          : "The next step is replacing this mock orchestration with real tool execution, persisted traces, and replayable run history.",
      summary:
        request.locale === "zh"
          ? `这条 workflow 已先归一化输入，再附加知识上下文，并把结果整理成结构化 digest 与 artifact cards。本次执行主要围绕「${promptFocus}」展开。`
          : `The workflow normalized the input, hydrated ranked knowledge context, and turned the result into a structured digest plus artifact cards. This run focused on "${promptFocus}".`,
      title:
        request.locale === "zh" ? "Workflow Digest" : "Workflow Digest",
    },
    sources,
    toolCalls,
  });
}
