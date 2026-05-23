import fs from "node:fs";
import { withDatabase } from "../client";
import { coerceTimestamp } from "./run-state";
import { resolveRuntimeFilePath } from "./runtime-files";

export type SurfaceName =
  | "chat"
  | "palette"
  | "agent"
  | "arena"
  | "workflow"
  | "admin-evolution"
  | "admin-jobs"
  | "admin-observability";

export interface StoredLlmRun {
  createdAt: string;
  latencyMs?: number;
  model: string;
  promptType?: string;
  route: string;
  sessionId?: string;
  status: "success" | "error" | "cancelled";
  summary: string;
  surface: SurfaceName;
}

export interface StoredToolCall {
  createdAt: string;
  detail: string;
  route: string;
  status: "success" | "error";
  surface: SurfaceName;
  toolName: string;
}

export interface StoredRuntimeJobRun {
  createdAt: string;
  durationMs: number;
  jobName: string;
  route: string;
  status: "success" | "error" | "skipped";
  summary: string;
}

export interface StoredUiAction {
  actionName: string;
  createdAt: string;
  label: string;
  route: string;
  source: "user" | "ai" | "system";
}

export interface StoredVisitorSession {
  createdAt: string;
  landingRoute?: string;
  location: string;
  route: string;
  state: string;
  summary: string;
  surface: SurfaceName;
  visitorId: string;
}

export interface RuntimeObservabilityState {
  jobRuns: StoredRuntimeJobRun[];
  llmRuns: StoredLlmRun[];
  sessions: StoredVisitorSession[];
  toolCalls: StoredToolCall[];
  uiActions: StoredUiAction[];
}

const MAX_EVENTS = 30;
const RUNTIME_STORE_FILE = resolveRuntimeFilePath(
  process.env.OBSERVABILITY_STORE_FILENAME || "observability-store.json",
);

function trimCollection<T>(collection: T[]) {
  if (collection.length > MAX_EVENTS) {
    collection.length = MAX_EVENTS;
  }

  return collection;
}

function createEmptyRuntimeStore(): RuntimeObservabilityState {
  return {
    jobRuns: [],
    llmRuns: [],
    sessions: [],
    toolCalls: [],
    uiActions: [],
  };
}

function parseRuntimeStore(raw: string): RuntimeObservabilityState {
  const parsed = JSON.parse(raw) as Partial<RuntimeObservabilityState>;

  return {
    jobRuns: trimCollection(
      Array.isArray(parsed.jobRuns) ? [...parsed.jobRuns] : [],
    ) as StoredRuntimeJobRun[],
    llmRuns: trimCollection(
      Array.isArray(parsed.llmRuns) ? [...parsed.llmRuns] : [],
    ) as StoredLlmRun[],
    sessions: trimCollection(
      Array.isArray(parsed.sessions) ? [...parsed.sessions] : [],
    ) as StoredVisitorSession[],
    toolCalls: trimCollection(
      Array.isArray(parsed.toolCalls) ? [...parsed.toolCalls] : [],
    ) as StoredToolCall[],
    uiActions: trimCollection(
      Array.isArray(parsed.uiActions) ? [...parsed.uiActions] : [],
    ) as StoredUiAction[],
  };
}

function readRuntimeStoreFile() {
  try {
    return parseRuntimeStore(fs.readFileSync(RUNTIME_STORE_FILE, "utf8"));
  } catch {
    return createEmptyRuntimeStore();
  }
}

function writeRuntimeStoreFile(state: RuntimeObservabilityState) {
  fs.writeFileSync(
    RUNTIME_STORE_FILE,
    JSON.stringify(
      {
        jobRuns: trimCollection([...state.jobRuns]),
        llmRuns: trimCollection([...state.llmRuns]),
        sessions: trimCollection([...state.sessions]),
        toolCalls: trimCollection([...state.toolCalls]),
        uiActions: trimCollection([...state.uiActions]),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function updateRuntimeStoreFile<T>(
  mutator: (state: RuntimeObservabilityState) => T,
) {
  const state = readRuntimeStoreFile();
  const result = mutator(state);
  writeRuntimeStoreFile(state);
  return result;
}

function coerceNumber(value: unknown) {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);

  return Number.isFinite(parsed) ? parsed : 0;
}

export async function recordLlmRun(run: StoredLlmRun) {
  const result = await withDatabase(async (client) => {
    await client`
      INSERT INTO observability_llm_runs (
        created_at,
        route,
        summary,
        surface,
        session_id,
        model,
        prompt_type,
        status,
        latency_ms
      ) VALUES (
        ${run.createdAt},
        ${run.route},
        ${run.summary},
        ${run.surface},
        ${run.sessionId ?? null},
        ${run.model},
        ${run.promptType ?? null},
        ${run.status},
        ${run.latencyMs ?? null}
      )
    `;

    return run;
  });

  if (result !== undefined) {
    return result;
  }

  return updateRuntimeStoreFile((state) => {
    state.llmRuns.unshift(run);
    trimCollection(state.llmRuns);
    return run;
  });
}

export async function recordToolCalls(toolCalls: StoredToolCall[]) {
  if (toolCalls.length === 0) {
    return toolCalls;
  }

  const result = await withDatabase(async (client) => {
    for (const toolCall of toolCalls) {
      await client`
        INSERT INTO observability_tool_calls (
          created_at,
          detail,
          route,
          surface,
          tool_name,
          status
        ) VALUES (
          ${toolCall.createdAt},
          ${toolCall.detail},
          ${toolCall.route},
          ${toolCall.surface},
          ${toolCall.toolName},
          ${toolCall.status}
        )
      `;
    }

    return toolCalls;
  });

  if (result !== undefined) {
    return result;
  }

  return updateRuntimeStoreFile((state) => {
    state.toolCalls.unshift(...toolCalls);
    trimCollection(state.toolCalls);
    return toolCalls;
  });
}

export async function recordObservedJobRun(jobRun: StoredRuntimeJobRun) {
  const result = await withDatabase(async (client) => {
    await client`
      INSERT INTO observability_job_runs (
        created_at,
        duration_ms,
        route,
        summary,
        job_name,
        status
      ) VALUES (
        ${jobRun.createdAt},
        ${jobRun.durationMs},
        ${jobRun.route},
        ${jobRun.summary},
        ${jobRun.jobName},
        ${jobRun.status}
      )
    `;

    return jobRun;
  });

  if (result !== undefined) {
    return result;
  }

  return updateRuntimeStoreFile((state) => {
    state.jobRuns.unshift(jobRun);
    trimCollection(state.jobRuns);
    return jobRun;
  });
}

export async function recordUiAction(action: StoredUiAction) {
  const result = await withDatabase(async (client) => {
    await client`
      INSERT INTO observability_ui_actions (
        created_at,
        label,
        route,
        action_name,
        source
      ) VALUES (
        ${action.createdAt},
        ${action.label},
        ${action.route},
        ${action.actionName},
        ${action.source}
      )
    `;

    return action;
  });

  if (result !== undefined) {
    return result;
  }

  return updateRuntimeStoreFile((state) => {
    state.uiActions.unshift(action);
    trimCollection(state.uiActions);
    return action;
  });
}

export async function recordVisitorSession(session: StoredVisitorSession) {
  const result = await withDatabase(async (client) => {
    await client`
      INSERT INTO observability_visitor_sessions (
        created_at,
        location,
        route,
        state,
        summary,
        surface,
        visitor_id,
        landing_route
      ) VALUES (
        ${session.createdAt},
        ${session.location},
        ${session.route},
        ${session.state},
        ${session.summary},
        ${session.surface},
        ${session.visitorId},
        ${session.landingRoute ?? null}
      )
    `;

    return session;
  });

  if (result !== undefined) {
    return result;
  }

  return updateRuntimeStoreFile((state) => {
    state.sessions.unshift(session);
    trimCollection(state.sessions);
    return session;
  });
}

export async function listRuntimeObservabilityRecords() {
  const result = await withDatabase(async (client) => {
    const [llmRuns, toolCalls, jobRuns, uiActions, sessions] = await Promise.all([
      client<{
        created_at: string;
        latency_ms: number | null;
        model: string;
        prompt_type: string | null;
        route: string;
        session_id: string | null;
        status: StoredLlmRun["status"];
        summary: string;
        surface: SurfaceName;
      }[]>`
        SELECT *
        FROM observability_llm_runs
        ORDER BY created_at DESC
        LIMIT ${MAX_EVENTS}
      `,
      client<{
        created_at: string;
        detail: string;
        route: string;
        status: StoredToolCall["status"];
        surface: SurfaceName;
        tool_name: string;
      }[]>`
        SELECT *
        FROM observability_tool_calls
        ORDER BY created_at DESC
        LIMIT ${MAX_EVENTS}
      `,
      client<{
        created_at: string;
        duration_ms: number;
        job_name: string;
        route: string;
        status: StoredRuntimeJobRun["status"];
        summary: string;
      }[]>`
        SELECT *
        FROM observability_job_runs
        ORDER BY created_at DESC
        LIMIT ${MAX_EVENTS}
      `,
      client<{
        action_name: string;
        created_at: string;
        label: string;
        route: string;
        source: StoredUiAction["source"];
      }[]>`
        SELECT *
        FROM observability_ui_actions
        ORDER BY created_at DESC
        LIMIT ${MAX_EVENTS}
      `,
      client<{
        created_at: string;
        landing_route: string | null;
        location: string;
        route: string;
        state: string;
        summary: string;
        surface: SurfaceName;
        visitor_id: string;
      }[]>`
        SELECT *
        FROM observability_visitor_sessions
        ORDER BY created_at DESC
        LIMIT ${MAX_EVENTS}
      `,
    ]);

    return {
      jobRuns: jobRuns.map((jobRun) => ({
        createdAt: coerceTimestamp(jobRun.created_at),
        durationMs: coerceNumber(jobRun.duration_ms),
        jobName: jobRun.job_name,
        route: jobRun.route,
        status: jobRun.status,
        summary: jobRun.summary,
      })),
      llmRuns: llmRuns.map((run) => ({
        createdAt: coerceTimestamp(run.created_at),
        latencyMs: run.latency_ms ?? undefined,
        model: run.model,
        promptType: run.prompt_type ?? undefined,
        route: run.route,
        sessionId: run.session_id ?? undefined,
        status: run.status,
        summary: run.summary,
        surface: run.surface,
      })),
      sessions: sessions.map((session) => ({
        createdAt: coerceTimestamp(session.created_at),
        landingRoute: session.landing_route ?? undefined,
        location: session.location,
        route: session.route,
        state: session.state,
        summary: session.summary,
        surface: session.surface,
        visitorId: session.visitor_id,
      })),
      toolCalls: toolCalls.map((toolCall) => ({
        createdAt: coerceTimestamp(toolCall.created_at),
        detail: toolCall.detail,
        route: toolCall.route,
        status: toolCall.status,
        surface: toolCall.surface,
        toolName: toolCall.tool_name,
      })),
      uiActions: uiActions.map((action) => ({
        actionName: action.action_name,
        createdAt: coerceTimestamp(action.created_at),
        label: action.label,
        route: action.route,
        source: action.source,
      })),
    } satisfies RuntimeObservabilityState;
  });

  return result ?? readRuntimeStoreFile();
}
