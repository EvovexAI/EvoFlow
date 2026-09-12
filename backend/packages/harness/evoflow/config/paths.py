import logging
import os
import re
import shutil
from pathlib import Path

# Virtual path prefix seen by agents inside the sandbox
VIRTUAL_PATH_PREFIX = "/mnt/user-data"

_SAFE_THREAD_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


class Paths:
    """
    Centralized path configuration for EvoFlow application data.

    Directory layout (host side):
        {base_dir}/
        ├── data/
        │   ├── app/evoflow.db              <-- tasks, memory, sessions, config tables
        │   ├── observability/evoflow_observability.db
        │   ├── checkpoints/checkpoints.db  <-- LangGraph state (see checkpointer config)
        │   └── logs/                       <-- Gateway daily logs (7-day retention)
        ├── skills/                    <-- legacy PUBLIC skill root (install-wide)
        ├── scopes/                    <-- per-org / personal / group homes
        │   ├── org/<org_id>/{skills,agents,files,memory}/
        │   ├── personal/<user_id>/...
        │   └── group/<group_id>/...
        ├── memory.json                     <-- legacy hint only
        ├── agents/                         <-- optional legacy; agent config in SQLite
        └── threads/
            └── {thread_id}/
                └── user-data/         <-- mounted as /mnt/user-data/ inside sandbox
                    ├── workspace/     <-- /mnt/user-data/workspace/
                    ├── uploads/       <-- /mnt/user-data/uploads/
                    └── outputs/       <-- /mnt/user-data/outputs/

    BaseDir resolution (in priority order):
        1. Constructor argument `base_dir`
        2. EVOFLOW_HOME environment variable
        3. Local dev fallback: cwd/.evoflow  (when cwd is the backend/ dir)
        4. Default: $HOME/.evoflow
    """

    def __init__(self, base_dir: str | Path | None = None) -> None:
        self._base_dir = Path(base_dir).resolve() if base_dir is not None else None

    @property
    def host_base_dir(self) -> Path:
        """Host-visible base dir for Docker volume mount sources.

        When running inside Docker with a mounted Docker socket (DooD), the Docker
        daemon runs on the host and resolves mount paths against the host filesystem.
        Set EVOFLOW_HOST_BASE_DIR to the host-side path that corresponds to this
        container's base_dir so that sandbox container volume mounts work correctly.

        Falls back to base_dir when the env var is not set (native/local execution).
        """
        if env := os.getenv("EVOFLOW_HOST_BASE_DIR"):
            return Path(env)
        return self.base_dir

    @property
    def base_dir(self) -> Path:
        """Root directory for all application data."""
        if self._base_dir is not None:
            return self._base_dir

        if env_home := os.getenv("EVOFLOW_HOME"):
            from evoflow.config.data_paths import normalize_evoflow_base_dir

            return normalize_evoflow_base_dir(Path(env_home))

        # Prefer existing data dir before loading AppConfig (opening evoflow.db must not take 30s+).
        home_dir = Path.home() / ".evoflow"
        if home_dir.exists():
            return home_dir

        # Config-driven base_dir (written to config.yaml by EvoPanel)
        try:
            from evoflow.config.app_config import get_app_config

            cfg = get_app_config()
            extra = getattr(cfg, "model_extra", None) or {}
            paths_cfg = extra.get("paths") if isinstance(extra, dict) else None
            if isinstance(paths_cfg, dict):
                raw = paths_cfg.get("base_dir") or paths_cfg.get("baseDir")
                if isinstance(raw, str) and raw.strip():
                    return Path(raw.strip()).resolve()
        except Exception:
            # Keep base_dir resolution robust; fall through to cwd/home logic.
            pass

        # Local dev fallback: only when $HOME/.evoflow does not exist yet
        cwd = Path.cwd()
        if cwd.name == "backend" or (cwd / "pyproject.toml").exists():
            return cwd / ".evoflow"

        return home_dir

    @property
    def evoflow_db(self) -> Path:
        """Application SQLite database (tasks, memory, threads, channels, observability)."""
        from evoflow.persistence.db import resolve_evolflow_db_path

        return resolve_evolflow_db_path()

    @property
    def memory_file(self) -> Path:
        """Legacy path hint; memory is stored in :attr:`evoflow_db` table ``evoflow_memory``."""
        return self.base_dir / "memory.json"

    @property
    def agents_dir(self) -> Path:
        """Root directory for all custom agents: `{base_dir}/agents/`."""
        return self.base_dir / "agents"

    @property
    def tasks_dir(self) -> Path:
        """Canonical task aggregate storage dir: `{base_dir}/tasks/`."""
        return self.base_dir / "tasks"

    @property
    def claude_session_logs_dir(self) -> Path:
        """JSONL debug logs for ``claude_session``: `{base_dir}/logs/claude`."""
        return self.base_dir / "logs" / "claude"

    def task_dir(self, main_task_id: str) -> Path:
        """Canonical dir for one main task bundle: `{base_dir}/tasks/{main_task_id}/`."""
        tid = str(main_task_id or "").strip()
        if not tid:
            raise ValueError("main_task_id is required")
        return self.tasks_dir / tid

    def task_detail_dir(self, main_task_id: str) -> Path:
        """Per-main-task detail dir: `{base_dir}/tasks/{main_task_id}/task_detail/`."""
        return self.task_dir(main_task_id) / "task_detail"

    def task_stream_log_file(self, main_task_id: str) -> Path:
        """Canonical per-main-task stream log: `{base_dir}/tasks/{main_task_id}/task_stream_logs.jsonl`."""
        return self.task_dir(main_task_id) / "task_stream_logs.jsonl"

    @property
    def projects_dir(self) -> Path:
        raise RuntimeError("Legacy projects_dir removed; use tasks_dir")

    def agent_dir(self, name: str) -> Path:
        """Directory for a specific agent: `{base_dir}/agents/{name}/`."""
        return self.agents_dir / name.lower()

    def agent_memory_file(self, name: str) -> Path:
        """Per-agent memory file: `{base_dir}/agents/{name}/memory.json`."""
        return self.agent_dir(name) / "memory.json"

    def thread_dir(self, thread_id: str) -> Path:
        """
        Host path for a thread's data: `{base_dir}/threads/{thread_id}/`

        This directory contains a `user-data/` subdirectory that is mounted
        as `/mnt/user-data/` inside the sandbox.

        Raises:
            ValueError: If `thread_id` contains unsafe characters (path separators
                        or `..`) that could cause directory traversal.
        """
        if not _SAFE_THREAD_ID_RE.match(thread_id):
            raise ValueError(f"Invalid thread_id {thread_id!r}: only alphanumeric characters, hyphens, and underscores are allowed.")
        return self.base_dir / "threads" / thread_id

    def thread_task_state_file(self, thread_id: str) -> Path:
        """Canonical thread task-state file: `{base_dir}/threads/{thread_id}/task_state.json`."""
        return self.thread_dir(thread_id) / "task_state.json"

    def sandbox_work_dir(self, thread_id: str) -> Path:
        """
        Host path for the agent's workspace directory.
        Host: `{base_dir}/threads/{thread_id}/user-data/workspace/`
        Sandbox: `/mnt/user-data/workspace/`
        """
        return self.thread_dir(thread_id) / "user-data" / "workspace"

    def sandbox_uploads_dir(self, thread_id: str) -> Path:
        """
        Host path for user-uploaded files.
        Host: `{base_dir}/threads/{thread_id}/user-data/uploads/`
        Sandbox: `/mnt/user-data/uploads/`
        """
        return self.thread_dir(thread_id) / "user-data" / "uploads"

    def sandbox_outputs_dir(self, thread_id: str) -> Path:
        """
        Host path for agent-generated artifacts.
        Host: `{base_dir}/threads/{thread_id}/user-data/outputs/`
        Sandbox: `/mnt/user-data/outputs/`
        """
        return self.thread_dir(thread_id) / "user-data" / "outputs"

    def acp_workspace_dir(self, thread_id: str) -> Path:
        """
        Host path for the ACP workspace of a specific thread.
        Host: `{base_dir}/threads/{thread_id}/acp-workspace/`
        Sandbox: `/mnt/acp-workspace/`

        Each thread gets its own isolated ACP workspace so that concurrent
        sessions cannot read each other's ACP agent outputs.
        """
        return self.thread_dir(thread_id) / "acp-workspace"

    def sandbox_user_data_dir(self, thread_id: str) -> Path:
        """
        Host path for the user-data root.
        Host: `{base_dir}/threads/{thread_id}/user-data/`
        Sandbox: `/mnt/user-data/`
        """
        return self.thread_dir(thread_id) / "user-data"

    def ensure_thread_dirs(self, thread_id: str) -> None:
        """Create all standard sandbox directories for a thread.

        Directories are created with mode 0o777 so that sandbox containers
        (which may run as a different UID than the host backend process) can
        write to the volume-mounted paths without "Permission denied" errors.
        The explicit chmod() call is necessary because Path.mkdir(mode=...) is
        subject to the process umask and may not yield the intended permissions.

        Includes the ACP workspace directory so it can be volume-mounted into
        the sandbox container at ``/mnt/acp-workspace`` even before the first
        ACP agent invocation.
        """
        for d in [
            self.sandbox_work_dir(thread_id),
            self.sandbox_uploads_dir(thread_id),
            self.sandbox_outputs_dir(thread_id),
            self.acp_workspace_dir(thread_id),
        ]:
            d.mkdir(parents=True, exist_ok=True)
            d.chmod(0o777)

    def delete_thread_dir(self, thread_id: str) -> None:
        """Delete thread sandbox files (uploads/workspace) and SQLite thread rows.

        The operation is idempotent: missing thread directories are ignored.
        """
        try:
            from evoflow.persistence import repositories as repo

            repo.delete_thread_data(thread_id)
        except Exception:
            logging.getLogger(__name__).debug("delete_thread_data sqlite cleanup failed", exc_info=True)
        thread_dir = self.thread_dir(thread_id)
        if thread_dir.exists():
            shutil.rmtree(thread_dir)

    def resolve_virtual_path(self, thread_id: str, virtual_path: str) -> Path:
        """Resolve a sandbox virtual path to the actual host filesystem path.

        Args:
            thread_id: The thread ID.
            virtual_path: Virtual path as seen inside the sandbox, e.g.
                          ``/mnt/user-data/outputs/report.pdf``.
                          Leading slashes are stripped before matching.

        Returns:
            The resolved absolute host filesystem path.

        Raises:
            ValueError: If the path does not start with the expected virtual
                        prefix or a path-traversal attempt is detected.
        """
        stripped = virtual_path.lstrip("/")
        prefix = VIRTUAL_PATH_PREFIX.lstrip("/")

        # Require an exact segment-boundary match to avoid prefix confusion
        # (e.g. reject paths like "mnt/user-dataX/...").
        if stripped != prefix and not stripped.startswith(prefix + "/"):
            raise ValueError(f"Path must start with /{prefix}")

        relative = stripped[len(prefix) :].lstrip("/")
        base = self.sandbox_user_data_dir(thread_id).resolve()
        actual = (base / relative).resolve()

        try:
            actual.relative_to(base)
        except ValueError:
            raise ValueError("Access denied: path traversal detected")

        return actual


# ── Singleton ────────────────────────────────────────────────────────────

_paths: Paths | None = None


def get_paths() -> Paths:
    """Return the global Paths singleton (lazy-initialized)."""
    global _paths
    if _paths is None:
        _paths = Paths()
    return _paths


def reset_paths_cache() -> None:
    """Clear cached :class:`Paths` after ``runtime.paths`` changes in SQLite."""
    global _paths
    _paths = None


def resolve_path(path: str) -> Path:
    """Resolve *path* to an absolute ``Path``.

    Relative paths are resolved relative to the application base directory.
    Absolute paths are returned as-is (after normalisation).
    """
    p = Path(path)
    if not p.is_absolute():
        p = get_paths().base_dir / path
    return p.resolve()
