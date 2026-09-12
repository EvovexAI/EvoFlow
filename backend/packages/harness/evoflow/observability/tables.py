"""Canonical SQLite table names — prefix ``evoflow_obs_`` only."""


class ObservabilityTable:
    THREADS = "evoflow_obs_threads"
    RUNS = "evoflow_obs_runs"
    MODEL_INVOCATIONS = "evoflow_obs_model_invocations"
    TOOL_INVOCATIONS = "evoflow_obs_tool_invocations"
    TRACE_EVENTS = "evoflow_obs_trace_events"
    TASK_LIFECYCLE_EVENTS = "evoflow_obs_task_lifecycle_events"
    IM_CHANNEL_ERRORS = "evoflow_obs_im_channel_errors"
    GATEWAY_REQUESTS = "evoflow_obs_gateway_requests"
