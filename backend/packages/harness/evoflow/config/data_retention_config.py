"""Retention policy for SQLite databases, logs, and checkpoint orphans."""

from pydantic import BaseModel, Field


class DataRetentionConfig(BaseModel):
    """Periodic cleanup of append-only / orphaned data under ``data/``."""

    enabled: bool = Field(default=True, description="Run retention on Gateway startup and on interval")
    interval_hours: int = Field(default=24, ge=1, le=168, description="Hours between scheduled runs")
    logs_days: int = Field(default=7, ge=1, le=365, description="Gateway daily log file retention")
    observability_days: int = Field(default=90, ge=1, le=3650, description="evoflow_obs_* row retention")
    gateway_requests_days: int = Field(
        default=7,
        ge=1,
        le=3650,
        description=(
            "Shorter retention for evoflow_obs_gateway_requests (high-volume HTTP access log). "
            "Falls back to observability_days when unset in legacy configs."
        ),
    )
    observability_max_size_gb: float = Field(
        default=2.0,
        ge=0.25,
        le=100.0,
        description=(
            "When observability.db (+ WAL) exceeds this size, strip heavy JSON columns, "
            "delete oldest gateway/trace/model rows, then VACUUM until under the cap."
        ),
    )
    observability_model_json_limit_bytes: int = Field(
        default=32 * 1024,
        ge=1024,
        le=512 * 1024,
        description="Max stored bytes per model invocation request/response JSON",
    )
    task_stream_days: int = Field(
        default=90,
        ge=1,
        le=3650,
        description="Delete stream events for terminal tasks older than this",
    )
    task_status_events_days: int = Field(default=90, ge=1, le=3650, description="evoflow_task_events (status) retention")
    automation_runs_per_task: int = Field(
        default=50,
        ge=5,
        le=5000,
        description="Keep at most N newest automation_runs rows per task_id",
    )
    checkpoint_orphan_days: int = Field(
        default=90,
        ge=7,
        le=3650,
        description="Delete all checkpoints for soft-deleted sessions older than this",
    )
    checkpoint_inactive_session_days: int = Field(
        default=30,
        ge=7,
        le=3650,
        description="Delete all checkpoints for sessions with no update in this many days (unless task is active)",
    )
    checkpoint_keep_per_thread: int = Field(
        default=5,
        ge=1,
        le=500,
        description="Per thread_id keep only the N newest checkpoints (major size win for long chats)",
    )
    vacuum_sqlite: bool = Field(
        default=True,
        description="Run VACUUM on app/obs/checkpoint DBs only after this pass deleted rows",
    )
    vacuum_min_deleted_rows: int = Field(
        default=1,
        ge=0,
        description="Skip VACUUM unless at least this many rows were deleted in the pass (0 = always vacuum when enabled)",
    )
    startup_delay_seconds: int = Field(
        default=900,
        ge=0,
        le=86400,
        description=(
            "Delay the first full retention+VACUUM after Gateway start so the first "
            "chat is not blocked by exclusive SQLite locks on large DBs"
        ),
    )
