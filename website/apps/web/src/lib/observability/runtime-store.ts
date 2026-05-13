import type { ChatToolCall, ObservabilitySnapshotResponse } from "@ai-site/ai";
import {
  listRuntimeObservabilityRecords,
  recordLlmRun,
  recordObservedJobRun,
  recordToolCalls as recordToolCallsInRepository,
  recordUiAction as recordUiActionInRepository,
  recordVisitorSession as recordVisitorSessionInRepository,
  type RuntimeObservabilityState,
  type StoredLlmRun,
  type StoredRuntimeJobRun,
  type StoredToolCall,
  type StoredUiAction,
  type StoredVisitorSession,
  type SurfaceName,
} from "@ai-site/db";

type TraceRecord = ObservabilitySnapshotResponse["traces"][number];
type SessionRecord = ObservabilitySnapshotResponse["sessions"][number];
const LOCATIONS = ["Shanghai", "Singapore", "Remote"] as const;

function createSessionId(surface: SurfaceName) {
  return `${surface}-${Date.now().toString(36)}`;
}

function nextLocation() {
  return LOCATIONS[Math.floor(Date.now() / 1000) % LOCATIONS.length];
}

function translateLocation(location: string, locale: "zh" | "en") {
  if (locale === "en") {
    return location;
  }

  const translationMap: Record<string, string> = {
    Remote: "远程",
    Shanghai: "上海",
    Singapore: "新加坡",
  };

  return translationMap[location] ?? location;
}

function buildTraceStatus(status: string, locale: "zh" | "en") {
  if (locale === "en") {
    return status;
  }

  const translationMap: Record<string, string> = {
    cancelled: "已取消",
    completed: "已完成",
    error: "失败",
    success: "成功",
  };

  return translationMap[status] ?? status;
}

function buildRuntimeSessionTitle(surface: SurfaceName, locale: "zh" | "en") {
  const titleMap: Record<SurfaceName, { en: string; zh: string }> = {
    "admin-evolution": {
      en: "Evolution Runtime Session",
      zh: "Evolution 运行会话",
    },
    "admin-jobs": {
      en: "Jobs Runtime Session",
      zh: "Jobs 运行会话",
    },
    "admin-observability": {
      en: "Observability Runtime Session",
      zh: "Observability 运行会话",
    },
    agent: {
      en: "Agent Runtime Session",
      zh: "Agent 运行会话",
    },
    arena: {
      en: "Arena Runtime Session",
      zh: "Arena 运行会话",
    },
    chat: {
      en: "Chat Runtime Session",
      zh: "Chat 运行会话",
    },
    palette: {
      en: "Palette Runtime Session",
      zh: "Palette 运行会话",
    },
    workflow: {
      en: "Workflow Runtime Session",
      zh: "Workflow 运行会话",
    },
  };

  return titleMap[surface][locale];
}

function compactText(value: string, max = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, max - 3)}...`;
}

async function recordVisitorSession(args: {
  route: string;
  state: string;
  summary: string;
  surface: SurfaceName;
}) {
  const session: StoredVisitorSession = {
    createdAt: new Date().toISOString(),
    landingRoute: args.route,
    location: nextLocation(),
    route: args.route,
    state: args.state,
    summary: compactText(args.summary),
    surface: args.surface,
    visitorId: createSessionId(args.surface),
  };

  await recordVisitorSessionInRepository(session);
}

async function recordUiAction(args: {
  actionName: string;
  label: string;
  route: string;
}) {
  const action: StoredUiAction = {
    actionName: args.actionName,
    createdAt: new Date().toISOString(),
    label: args.label,
    route: args.route,
    source: "user",
  };

  await recordUiActionInRepository(action);
}

async function recordToolCalls(args: {
  route: string;
  surface: SurfaceName;
  toolCalls: ChatToolCall[];
}) {
  const storedToolCalls: StoredToolCall[] = args.toolCalls.map((toolCall) => ({
    createdAt: new Date().toISOString(),
    detail: toolCall.detail,
    route: args.route,
    status: toolCall.status === "completed" ? "success" : "error",
    surface: args.surface,
    toolName: toolCall.name,
  }));

  await recordToolCallsInRepository(storedToolCalls);
}

export async function recordChatRuntime(args: {
  latencyMs: number;
  model: string;
  route: string;
  summary: string;
  surface: "chat" | "palette";
  toolCalls: ChatToolCall[];
}) {
  const llmRun: StoredLlmRun = {
    createdAt: new Date().toISOString(),
    latencyMs: args.latencyMs,
    model: args.model,
    promptType: args.surface,
    route: args.route,
    status: "success",
    summary: compactText(args.summary),
    surface: args.surface,
  };

  await recordLlmRun(llmRun);
  await recordToolCalls({
    route: args.route,
    surface: args.surface,
    toolCalls: args.toolCalls,
  });
  await recordUiAction({
    actionName: `submit-${args.surface}`,
    label: args.surface === "chat" ? "Chat submit" : "Palette analysis",
    route: args.route,
  });
  await recordVisitorSession({
    route: args.route,
    state: args.surface === "chat" ? "chatting in /ai/chat" : "querying terminal mode",
    summary: compactText(args.summary),
    surface: args.surface,
  });
}

export async function recordAgentRuntime(args: {
  latencyMs: number;
  model: string;
  route: string;
  summary: string;
  toolCalls: ChatToolCall[];
}) {
  const llmRun: StoredLlmRun = {
    createdAt: new Date().toISOString(),
    latencyMs: args.latencyMs,
    model: args.model,
    promptType: "agent",
    route: args.route,
    status: "success",
    summary: compactText(args.summary),
    surface: "agent",
  };

  await recordLlmRun(llmRun);
  await recordToolCalls({
    route: args.route,
    surface: "agent",
    toolCalls: args.toolCalls,
  });
  await recordUiAction({
    actionName: "run-agent-mission",
    label: "Agent mission run",
    route: args.route,
  });
  await recordVisitorSession({
    route: args.route,
    state: "running /ai/agent",
    summary: compactText(args.summary),
    surface: "agent",
  });
}

export async function recordArenaRuntime(args: {
  latencyMs: number;
  model: string;
  route: string;
  summary: string;
  toolCalls: ChatToolCall[];
}) {
  const llmRun: StoredLlmRun = {
    createdAt: new Date().toISOString(),
    latencyMs: args.latencyMs,
    model: args.model,
    promptType: "arena",
    route: args.route,
    status: "success",
    summary: compactText(args.summary),
    surface: "arena",
  };

  await recordLlmRun(llmRun);
  await recordToolCalls({
    route: args.route,
    surface: "arena",
    toolCalls: args.toolCalls,
  });
  await recordUiAction({
    actionName: "run-model-arena",
    label: "Model arena run",
    route: args.route,
  });
  await recordVisitorSession({
    route: args.route,
    state: "running /ai/arena",
    summary: compactText(args.summary),
    surface: "arena",
  });
}

export async function recordWorkflowRuntime(args: {
  latencyMs?: number;
  model: string;
  route: string;
  summary: string;
  toolCalls: ChatToolCall[];
}) {
  const llmRun: StoredLlmRun = {
    createdAt: new Date().toISOString(),
    latencyMs: args.latencyMs ?? 31,
    model: args.model,
    promptType: "workflow",
    route: args.route,
    status: "success",
    summary: compactText(args.summary),
    surface: "workflow",
  };

  await recordLlmRun(llmRun);
  await recordToolCalls({
    route: args.route,
    surface: "workflow",
    toolCalls: args.toolCalls,
  });
  await recordUiAction({
    actionName: "run-workflow",
    label: "Workflow run",
    route: args.route,
  });
  await recordVisitorSession({
    route: args.route,
    state: "running /ai/workflow",
    summary: compactText(args.summary),
    surface: "workflow",
  });
}

export async function recordJobRuntime(args: {
  durationMs: number;
  jobName: string;
  route: string;
  summary: string;
  toolCalls: ChatToolCall[];
}) {
  const observedJobRun: StoredRuntimeJobRun = {
    createdAt: new Date().toISOString(),
    durationMs: args.durationMs,
    jobName: args.jobName,
    route: args.route,
    status: "success",
    summary: compactText(args.summary),
  };

  await recordObservedJobRun(observedJobRun);
  await recordToolCalls({
    route: args.route,
    surface: "admin-jobs",
    toolCalls: args.toolCalls,
  });
  await recordUiAction({
    actionName: "run-job",
    label: args.jobName,
    route: args.route,
  });
  await recordVisitorSession({
    route: args.route,
    state: "running /admin/jobs",
    summary: compactText(args.summary),
    surface: "admin-jobs",
  });
}

export async function recordEvolutionRuntime(args: {
  action: string;
  route: string;
  summary: string;
  toolCalls: ChatToolCall[];
}) {
  await recordToolCalls({
    route: args.route,
    surface: "admin-evolution",
    toolCalls: args.toolCalls,
  });
  await recordUiAction({
    actionName: `evolution-${args.action}`,
    label: args.action,
    route: args.route,
  });
  await recordVisitorSession({
    route: args.route,
    state: "running /admin/evolution",
    summary: compactText(args.summary),
    surface: "admin-evolution",
  });
}

export async function recordObservabilityRefresh(args: {
  route: string;
  summary: string;
}) {
  await recordUiAction({
    actionName: "refresh-observability",
    label: "Observability snapshot refresh",
    route: args.route,
  });
  await recordVisitorSession({
    route: args.route,
    state: "refreshing /admin/observability",
    summary: compactText(args.summary),
    surface: "admin-observability",
  });
}

function buildTraceRecords(
  runtimeStore: RuntimeObservabilityState,
  locale: "zh" | "en",
): TraceRecord[] {
  const traceEntries = [
    ...runtimeStore.llmRuns.map((run) => ({
      accent: "primary" as const,
      createdAt: run.createdAt,
      detail:
        locale === "zh"
          ? `${run.model} 在 ${run.route} 完成一次 ${run.surface} 运行。${run.summary}`
          : `${run.model} completed a ${run.surface} run on ${run.route}. ${run.summary}`,
      status: buildTraceStatus(run.status, locale),
      title: `${run.surface}.runtime`,
    })),
    ...runtimeStore.toolCalls.map((toolCall) => ({
      accent: "secondary" as const,
      createdAt: toolCall.createdAt,
      detail: toolCall.detail,
      status: buildTraceStatus(toolCall.status, locale),
      title: `${toolCall.surface}.${toolCall.toolName}`,
    })),
    ...runtimeStore.jobRuns.map((jobRun) => ({
      accent: "tertiary" as const,
      createdAt: jobRun.createdAt,
      detail:
        locale === "zh"
          ? `${jobRun.jobName} 已在 ${jobRun.durationMs}ms 内完成。${jobRun.summary}`
          : `${jobRun.jobName} completed in ${jobRun.durationMs}ms. ${jobRun.summary}`,
      status: buildTraceStatus(jobRun.status, locale),
      title: `job.${jobRun.jobName}`,
    })),
    ...runtimeStore.uiActions.map((action) => ({
      accent: "primary" as const,
      createdAt: action.createdAt,
      detail:
        locale === "zh"
          ? `记录到 UI action "${action.label}"，目标路由为 ${action.route}。`
          : `Recorded the UI action "${action.label}" targeting ${action.route}.`,
      status: locale === "zh" ? "已记录" : "recorded",
      title: `ui.${action.actionName}`,
    })),
  ];

  return traceEntries
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 6)
    .map(({ accent, detail, status, title }) => ({
      accent,
      detail,
      status,
      title,
    }));
}

function buildSessionRecords(
  runtimeStore: RuntimeObservabilityState,
  locale: "zh" | "en",
): SessionRecord[] {
  return runtimeStore.sessions.slice(0, 3).map((session, index) => ({
    accent: (["primary", "secondary", "tertiary"] as const)[index % 3],
    location: translateLocation(session.location, locale),
    state: session.state,
    summary: session.summary,
    title: `${buildRuntimeSessionTitle(session.surface, locale)} ${session.visitorId.slice(-4).toUpperCase()}`,
  }));
}

function buildRecentToolCalls(
  runtimeStore: RuntimeObservabilityState,
  locale: "zh" | "en",
): ChatToolCall[] {
  const seen = new Set<string>();

  return runtimeStore.toolCalls
    .filter((toolCall) => {
      if (seen.has(toolCall.toolName)) {
        return false;
      }

      seen.add(toolCall.toolName);
      return true;
    })
    .slice(0, 4)
    .map((toolCall) => ({
      detail:
        locale === "zh"
          ? `${toolCall.surface} -> ${toolCall.detail}`
          : `${toolCall.surface} -> ${toolCall.detail}`,
      name: toolCall.toolName,
      status: toolCall.status === "success" ? "completed" : "pending",
    }));
}

export async function getRuntimeObservabilityState(locale: "zh" | "en") {
  const runtimeStore = await listRuntimeObservabilityRecords();
  const counts = {
    llmRuns: runtimeStore.llmRuns.length,
    toolCalls: runtimeStore.toolCalls.length,
    uiActions: runtimeStore.uiActions.length,
  };

  return {
    counts,
    sessions: buildSessionRecords(runtimeStore, locale),
    summary:
      locale === "zh"
        ? `Live runtime store 已捕获 ${counts.llmRuns} 次模型运行、${counts.toolCalls} 次工具调用与 ${counts.uiActions} 次 UI 操作。现在 admin observability 已能反映最近真实交互，而不只是静态占位。`
        : `The live runtime store has captured ${counts.llmRuns} model runs, ${counts.toolCalls} tool calls, and ${counts.uiActions} UI actions. Admin observability can now reflect recent real interactions instead of only static placeholders.`,
    toolCalls: buildRecentToolCalls(runtimeStore, locale),
    traces: buildTraceRecords(runtimeStore, locale),
  };
}
