/**
 * Agent OS — Core Schema
 *
 * Defines the canonical type system for the Agent OS runtime:
 *   Session → Run → TraceEvent
 *   Policy → routes/guards requests
 *   Eval → scores run quality
 *
 * All ids are nano-style short hex strings (16 chars).
 */

// ─── Primitives ───────────────────────────────────────────────────────────────

export type AgentOsStatus = "idle" | "running" | "streaming" | "completed" | "failed";
export type AgentSurface = "chat" | "agent" | "arena" | "mcp" | "workflow" | "knowledge" | "system";
export type AgentToolStatus = "pending" | "running" | "completed" | "failed";
export type EvalGrade = "excellent" | "good" | "acceptable" | "poor";

// ─── Tool Call ────────────────────────────────────────────────────────────────

export interface AgentToolCall {
  id: string;
  name: string;
  /** Compact description of what was called */
  detail: string;
  status: AgentToolStatus;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  errorMessage?: string;
  startedAt: string;   // ISO
}

// ─── Trace Event ──────────────────────────────────────────────────────────────

export type TraceEventKind =
  | "session_start"
  | "session_end"
  | "run_start"
  | "run_end"
  | "message_user"
  | "message_assistant"
  | "tool_call"
  | "tool_result"
  | "rag_query"
  | "rag_result"
  | "policy_check"
  | "eval";

export interface AgentTraceEvent {
  id: string;
  sessionId: string;
  runId: string;
  kind: TraceEventKind;
  createdAt: string;   // ISO
  /** Short human-readable label */
  label: string;
  /** Optional detail payload */
  detail?: string;
  metadata?: Record<string, unknown>;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

export interface AgentRun {
  id: string;
  sessionId: string;
  surface: AgentSurface;
  model: string;
  /** User prompt or triggering input */
  prompt: string;
  /** Final assistant response (when completed) */
  response?: string;
  status: AgentOsStatus;
  toolCalls: AgentToolCall[];
  traceEvents: AgentTraceEvent[];
  eval?: AgentEval;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenCount?: number;
  /** Number of RAG chunks retrieved */
  ragHits?: number;
  locale: "zh" | "en";
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface AgentSession {
  id: string;
  /** Browser/client fingerprint — not tied to auth */
  visitorId: string;
  surface: AgentSurface;
  locale: "zh" | "en";
  runs: AgentRun[];
  activeRunId?: string;
  status: AgentOsStatus;
  createdAt: string;
  lastActiveAt: string;
  /** Total tool calls across all runs */
  totalToolCalls: number;
  /** Total tokens across all runs */
  totalTokens: number;
}

// ─── Eval ─────────────────────────────────────────────────────────────────────

export interface AgentEval {
  runId: string;
  grade: EvalGrade;
  /** 0–100 */
  score: number;
  reasons: string[];
  /** Which tools were most helpful */
  effectiveTools: string[];
  evaluatedAt: string;
}

// ─── Policy ───────────────────────────────────────────────────────────────────

export type PolicyAction = "allow" | "deny" | "reroute" | "rate_limit";
export type PolicyTrigger = "surface" | "tool" | "prompt_pattern" | "token_budget" | "rate";

export interface AgentPolicy {
  id: string;
  name: string;
  description: string;
  trigger: PolicyTrigger;
  action: PolicyAction;
  /** Glob/regex pattern for prompt matching, or surface/tool name */
  pattern?: string;
  /** Redirect target when action = "reroute" */
  rerouteTo?: AgentSurface;
  /** Max requests per minute when action = "rate_limit" */
  rateLimit?: number;
  enabled: boolean;
  createdAt: string;
}

// ─── Agent OS System Snapshot ─────────────────────────────────────────────────

export interface AgentOsSystemSnapshot {
  /** When this snapshot was taken */
  snapshotAt: string;
  /** Currently active sessions */
  activeSessions: number;
  /** Runs completed today */
  runsToday: number;
  /** Tool calls today */
  toolCallsToday: number;
  /** Total tokens today */
  tokensToday: number;
  /** Average run latency today (ms) */
  avgLatencyMs: number;
  /** Recent sessions (latest first, max 10) */
  recentSessions: AgentSessionSummary[];
  /** Policies in effect */
  policies: AgentPolicy[];
  /** Whether pgvector RAG is active */
  ragEnabled: boolean;
  /** Whether the knowledge index is populated */
  knowledgeReady: boolean;
}

export interface AgentSessionSummary {
  id: string;
  surface: AgentSurface;
  locale: "zh" | "en";
  status: AgentOsStatus;
  runCount: number;
  totalToolCalls: number;
  lastActiveAt: string;
  lastPromptSnippet?: string;
}

// ─── Default Policies ─────────────────────────────────────────────────────────

export const DEFAULT_POLICIES: AgentPolicy[] = [
  {
    action: "rate_limit",
    createdAt: new Date().toISOString(),
    description: "Limit agent surface to 8 req/min per visitor",
    enabled: true,
    id: "policy-agent-rate",
    name: "Agent Rate Guard",
    pattern: "/api/agent/run",
    rateLimit: 8,
    trigger: "rate",
  },
  {
    action: "rate_limit",
    createdAt: new Date().toISOString(),
    description: "Limit chat surface to 20 req/min per visitor",
    enabled: true,
    id: "policy-chat-rate",
    name: "Chat Rate Guard",
    pattern: "/api/chat",
    rateLimit: 20,
    trigger: "rate",
  },
  {
    action: "rate_limit",
    createdAt: new Date().toISOString(),
    description: "Limit AI intent classification to 30 req/min",
    enabled: true,
    id: "policy-intent-rate",
    name: "Intent Rate Guard",
    pattern: "/api/intent",
    rateLimit: 30,
    trigger: "rate",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function makeId(prefix = "") {
  const hex = Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
  return prefix ? `${prefix}_${hex}` : hex;
}

export function sessionSummary(session: AgentSession): AgentSessionSummary {
  const latestRun = session.runs[session.runs.length - 1];
  return {
    id: session.id,
    lastActiveAt: session.lastActiveAt,
    lastPromptSnippet: latestRun?.prompt?.slice(0, 80),
    locale: session.locale,
    runCount: session.runs.length,
    status: session.status,
    surface: session.surface,
    totalToolCalls: session.totalToolCalls,
  };
}
