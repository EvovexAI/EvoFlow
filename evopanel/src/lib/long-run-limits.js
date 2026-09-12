/**
 * Long Plan / supervisor run budgets (keep in sync with evoflow.runtime.long_run_limits).
 */
export const LONG_RUN_WALL_SECONDS = 14_400 // 4h; override via server env EVOFLOW_LONG_RUN_WALL_SECONDS

export const LONG_RUN_WALL_MS = LONG_RUN_WALL_SECONDS * 1000

/** Max idle time between SSE events before graceful detach + reattach (1h). */
export const FRONTEND_STREAM_IDLE_TIMEOUT_MS = 3_600_000

/** LangGraph main graph recursion_limit (super-steps, not chat turns). */
export const LONG_RUN_RECURSION_LIMIT = 7500
