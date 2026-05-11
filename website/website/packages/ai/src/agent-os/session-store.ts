/**
 * Agent OS — In-Memory Session Store
 *
 * Lightweight server-side registry of active/recent sessions.
 * Designed to survive Next.js hot-reload by living in module scope.
 * Sessions expire after SESSION_TTL_MS of inactivity.
 */

import {
  DEFAULT_POLICIES,
  makeId,
  sessionSummary,
  type AgentOsSystemSnapshot,
  type AgentPolicy,
  type AgentRun,
  type AgentSession,
  type AgentSurface,
  type AgentToolCall,
  type AgentTraceEvent,
  type TraceEventKind,
} from "./schema";

const SESSION_TTL_MS = 30 * 60 * 1000;   // 30 min inactivity
const MAX_SESSIONS = 200;
const MAX_RUNS_PER_SESSION = 50;

// ─── Singleton store ──────────────────────────────────────────────────────────

interface SessionStoreState {
  sessions: Map<string, AgentSession>;
  // Daily counters (reset at UTC midnight)
  dailyCounterDate: string;   // YYYY-MM-DD
  runsToday: number;
  toolCallsToday: number;
  tokensToday: number;
  totalLatencyMs: number;
  latencySamples: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentOsStore: SessionStoreState | undefined;
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getStore(): SessionStoreState {
  if (!globalThis.__agentOsStore) {
    globalThis.__agentOsStore = {
      dailyCounterDate: getTodayDate(),
      latencySamples: 0,
      runsToday: 0,
      sessions: new Map(),
      toolCallsToday: 0,
      totalLatencyMs: 0,
      tokensToday: 0,
    };
  }

  // Reset daily counters if it's a new UTC day
  const today = getTodayDate();
  if (globalThis.__agentOsStore.dailyCounterDate !== today) {
    globalThis.__agentOsStore.dailyCounterDate = today;
    globalThis.__agentOsStore.runsToday = 0;
    globalThis.__agentOsStore.toolCallsToday = 0;
    globalThis.__agentOsStore.tokensToday = 0;
    globalThis.__agentOsStore.totalLatencyMs = 0;
    globalThis.__agentOsStore.latencySamples = 0;
  }

  return globalThis.__agentOsStore;
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export function createSession({
  locale,
  surface,
  visitorId,
}: {
  locale: "zh" | "en";
  surface: AgentSurface;
  visitorId: string;
}): AgentSession {
  const store = getStore();
  const now = new Date().toISOString();

  const session: AgentSession = {
    createdAt: now,
    id: makeId("s"),
    lastActiveAt: now,
    locale,
    runs: [],
    status: "idle",
    surface,
    totalTokens: 0,
    totalToolCalls: 0,
    visitorId,
  };

  store.sessions.set(session.id, session);
  evictExpiredSessions();
  return session;
}

export function getSession(sessionId: string): AgentSession | undefined {
  return getStore().sessions.get(sessionId);
}

export function touchSession(sessionId: string) {
  const session = getStore().sessions.get(sessionId);
  if (session) {
    session.lastActiveAt = new Date().toISOString();
  }
}

// ─── Run lifecycle ────────────────────────────────────────────────────────────

export function startRun({
  locale,
  model,
  prompt,
  sessionId,
  surface,
}: {
  locale: "zh" | "en";
  model: string;
  prompt: string;
  sessionId: string;
  surface: AgentSurface;
}): AgentRun | undefined {
  const store = getStore();
  const session = store.sessions.get(sessionId);
  if (!session) return undefined;

  const now = new Date().toISOString();
  const run: AgentRun = {
    id: makeId("r"),
    locale,
    model,
    prompt,
    sessionId,
    startedAt: now,
    status: "running",
    surface,
    toolCalls: [],
    traceEvents: [],
  };

  // Append trace event
  run.traceEvents.push(makeTraceEvent(sessionId, run.id, "run_start", "Run started", prompt.slice(0, 80)));

  session.runs = [...session.runs.slice(-MAX_RUNS_PER_SESSION + 1), run];
  session.activeRunId = run.id;
  session.status = "running";
  session.lastActiveAt = now;

  store.runsToday += 1;

  return run;
}

export function completeRun({
  durationMs,
  response,
  runId,
  sessionId,
  tokenCount,
}: {
  durationMs: number;
  response: string;
  runId: string;
  sessionId: string;
  tokenCount?: number;
}) {
  const store = getStore();
  const session = store.sessions.get(sessionId);
  const run = session?.runs.find((r) => r.id === runId);
  if (!run) return;

  const now = new Date().toISOString();
  run.completedAt = now;
  run.durationMs = durationMs;
  run.response = response;
  run.status = "completed";
  run.tokenCount = tokenCount;

  run.traceEvents.push(makeTraceEvent(sessionId, runId, "run_end", "Run completed", `${(durationMs / 1000).toFixed(2)}s`));

  if (session) {
    session.activeRunId = undefined;
    session.status = "idle";
    session.lastActiveAt = now;
    if (tokenCount) session.totalTokens += tokenCount;
  }

  store.totalLatencyMs += durationMs;
  store.latencySamples += 1;
  if (tokenCount) store.tokensToday += tokenCount;
}

export function recordToolCall(sessionId: string, runId: string, toolCall: AgentToolCall) {
  const store = getStore();
  const session = store.sessions.get(sessionId);
  const run = session?.runs.find((r) => r.id === runId);
  if (!run) return;

  run.toolCalls.push(toolCall);
  run.traceEvents.push(
    makeTraceEvent(sessionId, runId, "tool_call", `Tool: ${toolCall.name}`, toolCall.detail),
  );

  if (session) {
    session.totalToolCalls += 1;
    session.lastActiveAt = new Date().toISOString();
  }

  store.toolCallsToday += 1;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function listRecentSessions(limit = 10) {
  const store = getStore();
  return [...store.sessions.values()]
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, limit)
    .map(sessionSummary);
}

export function getSystemSnapshot(extraData?: {
  knowledgeChunks?: number;
  pgvectorEnabled?: boolean;
}): AgentOsSystemSnapshot {
  const store = getStore();
  const now = new Date().toISOString();

  const activeSessions = [...store.sessions.values()].filter(
    (s) => s.status === "running" || (Date.now() - new Date(s.lastActiveAt).getTime() < 5 * 60_000),
  ).length;

  const avgLatencyMs = store.latencySamples > 0
    ? Math.round(store.totalLatencyMs / store.latencySamples)
    : 0;

  return {
    activeSessions,
    avgLatencyMs,
    knowledgeReady: (extraData?.knowledgeChunks ?? 0) > 0,
    policies: DEFAULT_POLICIES,
    ragEnabled: extraData?.pgvectorEnabled ?? false,
    recentSessions: listRecentSessions(10),
    runsToday: store.runsToday,
    snapshotAt: now,
    toolCallsToday: store.toolCallsToday,
    tokensToday: store.tokensToday,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTraceEvent(
  sessionId: string,
  runId: string,
  kind: TraceEventKind,
  label: string,
  detail?: string,
): AgentTraceEvent {
  return {
    createdAt: new Date().toISOString(),
    detail,
    id: makeId("t"),
    kind,
    label,
    runId,
    sessionId,
  };
}

function evictExpiredSessions() {
  const store = getStore();
  const cutoff = Date.now() - SESSION_TTL_MS;

  let evicted = 0;
  for (const [id, session] of store.sessions) {
    if (new Date(session.lastActiveAt).getTime() < cutoff) {
      store.sessions.delete(id);
      evicted++;
    }
  }

  // Hard cap — evict oldest if still over limit
  if (store.sessions.size > MAX_SESSIONS) {
    const sorted = [...store.sessions.entries()].sort(
      ([, a], [, b]) => a.lastActiveAt.localeCompare(b.lastActiveAt),
    );
    const toRemove = sorted.slice(0, store.sessions.size - MAX_SESSIONS);
    for (const [id] of toRemove) store.sessions.delete(id);
  }

  return evicted;
}
