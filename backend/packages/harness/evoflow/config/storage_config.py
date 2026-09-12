"""Application SQLite storage (tasks, memory, threads, channels, observability)."""

from typing import Literal

from pydantic import BaseModel, Field

from evoflow.config.data_paths import DEFAULT_APP_DB_REL


class StorageConfig(BaseModel):
    """Single application database under ``{base_dir}/data/app/`` (default ``data/app/evoflow.db``).

    LangGraph conversation checkpoints stay in ``checkpointer.connection_string``
    (typically ``data/checkpoints/checkpoints.db``) — a separate file by design.
    """

    backend: Literal["sqlite"] = Field(
        default="sqlite",
        description="Application persistence backend (only sqlite is supported).",
    )
    sqlite_path: str = Field(
        default=DEFAULT_APP_DB_REL,
        description="Application DB path; relative paths resolve under base_dir.",
    )
