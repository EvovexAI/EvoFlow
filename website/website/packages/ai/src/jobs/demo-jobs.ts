import { z } from "zod";
import {
  aiArtifactSchema,
  buildChatArtifacts,
  createArtifact,
} from "../ai-ui/artifacts";
import {
  chatSourceSchema,
  chatToolCallSchema,
  type ChatSource,
  type ChatToolCall,
} from "../chat/demo-chat";

export const jobIdSchema = z.enum([
  "github-sync",
  "blog-sync",
  "weekly-digest",
  "rebuild-coding-dna",
  "aggregate-metrics",
  "ingest-knowledge",
]);
export type JobId = z.infer<typeof jobIdSchema>;

export const jobRunRequestSchema = z.object({
  jobId: jobIdSchema,
  locale: z.enum(["zh", "en"]).default("zh"),
});
export type JobRunRequest = z.infer<typeof jobRunRequestSchema>;

export const jobRunResponseSchema = z.object({
  artifacts: z.array(aiArtifactSchema),
  logLines: z.array(z.string()).min(1),
  recentRun: z.object({
    duration: z.string(),
    status: z.string(),
  }),
  sources: z.array(chatSourceSchema),
  status: z.literal("completed"),
  summary: z.string(),
  toolCalls: z.array(chatToolCallSchema),
});
export type JobRunResponse = z.infer<typeof jobRunResponseSchema>;

export const jobRunSnapshotStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);
export type JobRunSnapshotStatus = z.infer<typeof jobRunSnapshotStatusSchema>;

export const jobRunSnapshotSchema = z.object({
  artifacts: z.array(aiArtifactSchema),
  error: z.string().nullable(),
  jobId: jobIdSchema,
  logLines: z.array(z.string()).min(1),
  recentRun: jobRunResponseSchema.shape.recentRun.nullable(),
  runId: z.string().trim().min(1),
  sources: z.array(chatSourceSchema),
  status: jobRunSnapshotStatusSchema,
  summary: z.string().nullable(),
  toolCalls: z.array(chatToolCallSchema),
});
export type JobRunSnapshot = z.infer<typeof jobRunSnapshotSchema>;

export function createJobRunSnapshot(snapshot: JobRunSnapshot) {
  return jobRunSnapshotSchema.parse(snapshot);
}

export interface JobRadarMetric {
  label: string;
  value: number;
}

interface CreateJobRunResponseArgs {
  artifacts?: JobRunResponse["artifacts"];
  durationMs: number;
  jobId: JobId;
  locale: "zh" | "en";
  logLines: string[];
  radarMetrics?: JobRadarMetric[];
  sources: ChatSource[];
  summary: string;
  toolCalls: ChatToolCall[];
}

export const jobRegistry = {
  aggregateMetrics: "aggregate-metrics",
  blogSync: "blog-sync",
  githubSync: "github-sync",
  rebuildCodingDna: "rebuild-coding-dna",
  weeklyDigest: "weekly-digest",
} as const;

function getJobDisplayName(jobId: JobId, locale: "zh" | "en") {
  const labels: Record<JobId, { en: string; zh: string }> = {
    "aggregate-metrics": {
      en: "Metrics Aggregate",
      zh: "Metrics Aggregate",
    },
    "blog-sync": {
      en: "Blog Sync",
      zh: "Blog Sync",
    },
    "github-sync": {
      en: "GitHub Sync",
      zh: "GitHub Sync",
    },
    "ingest-knowledge": {
      en: "Knowledge Ingest",
      zh: "Knowledge Ingest",
    },
    "rebuild-coding-dna": {
      en: "Coding DNA Rebuild",
      zh: "Coding DNA Rebuild",
    },
    "weekly-digest": {
      en: "Weekly Digest",
      zh: "Weekly Digest",
    },
  };

  return labels[jobId][locale];
}

function buildJobSources(jobId: JobId, locale: "zh" | "en"): ChatSource[] {
  const shared: ChatSource[] = [
    {
      path: "MEMORY.md",
      title: locale === "zh" ? "开发记忆与阶段进度" : "Development memory",
    },
    {
      path: "packages/content/src/platform-pages.ts",
      title: locale === "zh" ? "Admin / Jobs 内容源" : "Admin / jobs content",
    },
  ];

  const specific: Record<JobId, ChatSource[]> = {
    "aggregate-metrics": [
      {
        path: ".runtime/observability-store.json",
        title:
          locale === "zh"
            ? "可观测性信号聚合输入"
            : "Observability aggregation input",
      },
      {
        path: "packages/content/src/site-stats.ts",
        title:
          locale === "zh" ? "站点指标种子" : "Site metric seeds",
      },
    ],
    "blog-sync": [
      {
        path: "packages/content/src/home.ts",
        title: locale === "zh" ? "首页内容同步信号" : "Homepage content sync signals",
      },
    ],
    "github-sync": [
      {
        path: "DESIGN.md",
        title: locale === "zh" ? "站点设计与运行约束" : "Site design and runtime constraints",
      },
    ],
    "ingest-knowledge": [
      {
        path: "packages/db/src/repos/knowledge-chunks.ts",
        title: locale === "zh" ? "知识块向量存储" : "Knowledge chunk vector store",
      },
      {
        path: ".runtime/source-records.json",
        title: locale === "zh" ? "GitHub / Blog 来源记录" : "GitHub / Blog source records",
      },
    ],
    "rebuild-coding-dna": [
      {
        path: "packages/content/src/home.ts",
        title: locale === "zh" ? "Coding DNA 首页内容层" : "Homepage Coding DNA content",
      },
      {
        path: "DESIGN.md",
        title:
          locale === "zh"
            ? "工程架构与设计约束"
            : "Engineering architecture and design constraints",
      },
    ],
    "weekly-digest": [
      {
        path: "packages/ai/src/demo-evolution.ts",
        title: locale === "zh" ? "Digest 生成协议" : "Digest generation protocol",
      },
    ],
  };

  return [...shared, ...specific[jobId]];
}

function buildJobToolCalls(
  jobId: JobId,
  locale: "zh" | "en",
): ChatToolCall[] {
  const shared: ChatToolCall[] = [
    {
      detail:
        locale === "zh"
          ? "加载 worker registry 与当前调度状态"
          : "Loaded the worker registry and current schedule state",
      name: "loadJobRegistry",
      status: "completed",
    },
  ];

  const specific: Record<JobId, ChatToolCall[]> = {
    "aggregate-metrics": [
      {
        detail:
          locale === "zh"
            ? "聚合 observability、job runs 与站点统计信号"
            : "Aggregated observability, job run, and site-stat signals",
        name: "collectRuntimeMetrics",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "生成 admin 可消费的指标快照"
            : "Generated an admin-ready metric snapshot",
        name: "publishMetricSnapshot",
        status: "completed",
      },
    ],
    "blog-sync": [
      {
        detail:
          locale === "zh"
            ? "模拟拉取 blog delta 并合并新的内容变更"
            : "Simulated the blog delta pull and merged new content changes",
        name: "syncBlogContent",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "准备将新增事件发往 homepage / evolution surface"
            : "Prepared new events for the homepage and evolution surfaces",
        name: "emitContentSignals",
        status: "completed",
      },
    ],
    "github-sync": [
      {
        detail:
          locale === "zh"
            ? "模拟抓取 GitHub 活动并提炼成工程信号"
            : "Simulated the GitHub activity sync and distilled engineering signals",
        name: "syncGithubActivity",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "刷新 coding DNA / timeline 的候选事件"
            : "Refreshed candidate events for coding DNA and the timeline",
        name: "refreshCodingDna",
        status: "completed",
      },
    ],
    "ingest-knowledge": [
      {
        detail:
          locale === "zh"
            ? "扫描来源记录并提取文本块"
            : "Scanned source records and extracted text chunks",
        name: "chunkSourceRecords",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "通过 text-embedding-3-small 生成 1536 维向量"
            : "Generated 1536-dim vectors via text-embedding-3-small",
        name: "embedChunks",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "写入 pgvector knowledge_chunks 表"
            : "Upserted into pgvector knowledge_chunks table",
        name: "upsertVectorStore",
        status: "completed",
      },
    ],
    "rebuild-coding-dna": [
      {
        detail:
          locale === "zh"
            ? "重新抽取工程信号并对齐首页架构切片"
            : "Re-extracted engineering signals and aligned homepage architecture layers",
        name: "rebuildCodingDna",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "为首页和 evolution 准备新的 DNA 指纹快照"
            : "Prepared a refreshed DNA fingerprint snapshot for the homepage and evolution",
        name: "stageDnaFingerprint",
        status: "completed",
      },
    ],
    "weekly-digest": [
      {
        detail:
          locale === "zh"
            ? "聚合本周的 UI、AI runtime 与 evolution 变更"
            : "Aggregated this week's UI, AI runtime, and evolution changes",
        name: "collectWeeklySignals",
        status: "completed",
      },
      {
        detail:
          locale === "zh"
            ? "生成 digest 草稿并封装为 artifact protocol"
            : "Generated the digest draft and packaged it as the artifact protocol",
        name: "generateDigestDraft",
        status: "completed",
      },
    ],
  };

  return [...shared, ...specific[jobId]];
}

function buildJobArtifacts({
  jobId,
  locale,
  radarMetrics,
  sources,
  toolCalls,
}: {
  jobId: JobId;
  locale: "zh" | "en";
  radarMetrics?: JobRadarMetric[];
  sources: ChatSource[];
  toolCalls: ChatToolCall[];
}) {
  const defaultRadarMetrics: Record<JobId, JobRadarMetric[]> = {
    "aggregate-metrics": [
      { label: locale === "zh" ? "信号覆盖" : "Signal coverage", value: 89 },
      { label: locale === "zh" ? "面板对齐" : "Dashboard alignment", value: 86 },
      { label: locale === "zh" ? "会话可见性" : "Session visibility", value: 82 },
      { label: locale === "zh" ? "快照新鲜度" : "Snapshot freshness", value: 88 },
    ],
    "blog-sync": [
      { label: locale === "zh" ? "内容新鲜度" : "Content freshness", value: 87 },
      { label: locale === "zh" ? "变更密度" : "Change density", value: 82 },
      { label: locale === "zh" ? "投递准备" : "Delivery readiness", value: 85 },
      { label: locale === "zh" ? "同步健康" : "Sync health", value: 91 },
    ],
    "github-sync": [
      { label: locale === "zh" ? "活动覆盖" : "Activity coverage", value: 90 },
      { label: locale === "zh" ? "信号抽取" : "Signal extraction", value: 88 },
      { label: locale === "zh" ? "时间线写入" : "Timeline write", value: 84 },
      { label: locale === "zh" ? "可观测性" : "Observability", value: 89 },
    ],
    "ingest-knowledge": [
      { label: locale === "zh" ? "摄入覆盖" : "Ingest coverage", value: 88 },
      { label: locale === "zh" ? "向量新鲜度" : "Vector freshness", value: 85 },
      { label: locale === "zh" ? "嵌入质量" : "Embedding quality", value: 90 },
      { label: locale === "zh" ? "检索就绪" : "Retrieval readiness", value: 86 },
    ],
    "rebuild-coding-dna": [
      { label: locale === "zh" ? "指纹密度" : "Fingerprint density", value: 91 },
      { label: locale === "zh" ? "架构对齐" : "Architecture alignment", value: 88 },
      { label: locale === "zh" ? "首页映射" : "Homepage mapping", value: 85 },
      { label: locale === "zh" ? "进化准备" : "Evolution readiness", value: 86 },
    ],
    "weekly-digest": [
      { label: locale === "zh" ? "摘要覆盖" : "Digest coverage", value: 93 },
      { label: locale === "zh" ? "主题聚合" : "Theme aggregation", value: 86 },
      { label: locale === "zh" ? "分发准备" : "Distribution readiness", value: 83 },
      { label: locale === "zh" ? "内容贴合" : "Content fit", value: 91 },
    ],
  };

  return [
    ...buildChatArtifacts({
      model: "gpt-5-mini",
      sources,
      toolCalls,
    }),
    createArtifact("techRadar", {
      metrics: radarMetrics ?? defaultRadarMetrics[jobId],
      title: locale === "zh" ? "Worker Job Radar" : "Worker Job Radar",
    }),
  ];
}

function buildJobSummary(jobId: JobId, locale: "zh" | "en") {
  if (jobId === "aggregate-metrics") {
    return locale === "zh"
      ? "Metrics Aggregate 已汇总当前 runtime signals，并准备刷新 admin / observability 的指标快照。"
      : "Metrics Aggregate rolled up the current runtime signals and prepared a refreshed metric snapshot for admin and observability.";
  }

  if (jobId === "github-sync") {
    return locale === "zh"
      ? "GitHub Sync 已提炼出最新工程信号，并准备刷新 coding DNA 与 evolution timeline。"
      : "GitHub Sync extracted the latest engineering signals and prepared updates for coding DNA and the evolution timeline.";
  }

  if (jobId === "blog-sync") {
    return locale === "zh"
      ? "Blog Sync 已模拟合并内容增量，并为首页与实验室入口准备新的内容片段。"
      : "Blog Sync simulated the content delta merge and prepared new content fragments for the homepage and lab entry.";
  }

  if (jobId === "rebuild-coding-dna") {
    return locale === "zh"
      ? "Coding DNA Rebuild 已重建首页指纹信号，并为 evolution feed 准备新的工程画像。"
      : "Coding DNA Rebuild regenerated the homepage fingerprint signals and prepared a refreshed engineering profile for the evolution feed.";
  }

  if (jobId === "ingest-knowledge") {
    return locale === "zh"
      ? "Knowledge Ingest 将全部来源记录分块并通过 text-embedding-3-small 生成向量，写入 pgvector knowledge_chunks，使 AI 对话升级为语义检索。"
      : "Knowledge Ingest chunked all source records, embedded them via text-embedding-3-small, and upserted into pgvector knowledge_chunks, upgrading AI chat to semantic retrieval.";
  }

  return locale === "zh"
    ? "Weekly Digest 已聚合本周平台变化，并生成可投递到首页与 admin 的摘要草稿。"
    : "Weekly Digest aggregated this week's platform changes and generated a draft summary that can be delivered to the homepage and admin.";
}

function buildJobLogLines(jobId: JobId, locale: "zh" | "en") {
  const jobLabel = getJobDisplayName(jobId, locale);

  if (jobId === "aggregate-metrics") {
    return [
      `[manual] ${jobLabel} queued`,
      "[worker] runtime metric collection started",
      "[worker] observability and job signals rolled up",
      "[worker] admin metric snapshot published",
      `[done] ${jobLabel} completed in 0.8s`,
    ];
  }

  if (jobId === "github-sync") {
    return [
      `[manual] ${jobLabel} queued`,
      "[worker] github sync started",
      "[worker] activity shards normalized",
      "[worker] coding DNA candidate events refreshed",
      `[done] ${jobLabel} completed in 1.1s`,
    ];
  }

  if (jobId === "blog-sync") {
    return [
      `[manual] ${jobLabel} queued`,
      "[worker] blog delta pull started",
      "[worker] markdown fragments normalized",
      "[worker] homepage and lab snippets prepared",
      `[done] ${jobLabel} completed in 1.3s`,
    ];
  }

  if (jobId === "rebuild-coding-dna") {
    return [
      `[manual] ${jobLabel} queued`,
      "[worker] engineering fingerprint extraction started",
      "[worker] Architecture layers refreshed from current signals",
      "[worker] homepage DNA snapshot staged",
      `[done] ${jobLabel} completed in 1.0s`,
    ];
  }

  if (jobId === "ingest-knowledge") {
    return [
      `[manual] ${jobLabel} queued`,
      "[worker] scanning source records for chunking",
      "[worker] text chunks created with 800-char windows",
      "[worker] embedMany via text-embedding-3-small (1536 dims)",
      "[worker] upserting to knowledge_chunks in pgvector",
      `[done] ${jobLabel} completed in 3.5s`,
    ];
  }

  return [
    `[manual] ${jobLabel} queued`,
    "[worker] weekly signal aggregation started",
    "[worker] digest outline generated",
    "[worker] delivery payload staged for admin",
    `[done] ${jobLabel} completed in 1.2s`,
  ];
}

function buildJobRecentRun(jobId: JobId) {
  const durations: Record<JobId, string> = {
    "aggregate-metrics": "0.8s",
    "blog-sync": "1.3s",
    "github-sync": "1.1s",
    "ingest-knowledge": "3.5s",
    "rebuild-coding-dna": "1.0s",
    "weekly-digest": "1.2s",
  };

  return {
    duration: durations[jobId],
    status: "completed",
  };
}

export function formatDurationMs(durationMs: number) {
  const seconds = Math.max(0.1, durationMs / 1000);
  return `${seconds.toFixed(1)}s`;
}

export function createJobRunResponse({
  artifacts,
  durationMs,
  jobId,
  locale,
  logLines,
  radarMetrics,
  sources,
  summary,
  toolCalls,
}: CreateJobRunResponseArgs): JobRunResponse {
  return jobRunResponseSchema.parse({
    artifacts:
      artifacts ??
      buildJobArtifacts({
        jobId,
        locale,
        radarMetrics,
        sources,
        toolCalls,
      }),
    logLines,
    recentRun: {
      duration: formatDurationMs(durationMs),
      status: "completed",
    },
    sources,
    status: "completed",
    summary,
    toolCalls,
  });
}

export function generateDemoJobRun(
  request: JobRunRequest,
): JobRunResponse {
  const sources = buildJobSources(request.jobId, request.locale);
  const toolCalls = buildJobToolCalls(request.jobId, request.locale);

  return createJobRunResponse({
    durationMs:
      Number.parseFloat(buildJobRecentRun(request.jobId).duration.replace("s", "")) * 1000,
    jobId: request.jobId,
    locale: request.locale,
    logLines: buildJobLogLines(request.jobId, request.locale),
    sources,
    summary: buildJobSummary(request.jobId, request.locale),
    toolCalls,
  });
}
