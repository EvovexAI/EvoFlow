"""Storage for project and task data."""

import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Literal

from evoflow.collab.id_format import make_fact_id, make_task_id
from evoflow.collab.models import (
    ProjectStatus,
    TaskStatus,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)
_SAFE_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

_MAIN_TASK_MUTATION_LOCKS: dict[str, threading.RLock] = {}
_MAIN_TASK_LOCK_GUARD = threading.Lock()
# Was 2s — task-queue ticks (15–60s) re-scanned every project almost every tick.
_DEFAULT_PROJECT_CACHE_TTL_SECONDS = float(os.getenv("EVOFLOW_PROJECT_CACHE_TTL", "30") or 30)
_DEFAULT_PROJECT_CACHE_MAX_ENTRIES = max(8, int(os.getenv("EVOFLOW_PROJECT_CACHE_MAX", "64") or 64))
_DEFAULT_TASK_DETAIL_CACHE_MAX_ENTRIES = max(32, int(os.getenv("EVOFLOW_TASK_DETAIL_CACHE_MAX", "256") or 256))


def main_task_mutation_lock(main_task_id: str) -> threading.RLock:
    """Per-main-task reentrant lock for load-modify-save sequences."""
    mid = str(main_task_id or "").strip()
    with _MAIN_TASK_LOCK_GUARD:
        lock = _MAIN_TASK_MUTATION_LOCKS.get(mid)
        if lock is None:
            lock = threading.RLock()
            _MAIN_TASK_MUTATION_LOCKS[mid] = lock
        return lock


def task_memory_persistence_enabled() -> bool:
    """Agent task_memory (task_detail) writes. Off by default — subtask rows are UI source of truth."""
    return os.getenv("EVOFLOW_TASK_MEMORY_ENABLED", "0").strip().lower() in ("1", "true", "yes")


def _resolve_storage_dir(paths: Any, leaf: str) -> Path:
    """Resolve canonical storage dir.

    Canonical: {base_dir}/{leaf}
    """
    canonical = Path(paths.base_dir) / leaf
    return canonical


def create_empty_project(name: str = "", description: str = "", *, main_task_id: str | None = None) -> dict[str, Any]:
    """Create an empty task-bundle structure.

    NOTE: The bundle id is the main task id (storage key).
    """
    now = utc_now_iso_z()
    return {
        "id": (str(main_task_id).strip() if main_task_id else ""),
        "name": name,
        "description": description,
        "tasks": [],
        "status": ProjectStatus.PENDING.value,
        "supervisor_session_id": None,
        "created_at": now,
        "updated_at": now,
    }


def create_empty_task(
    name: str = "",
    description: str = "",
    project_id: str = "",
    dependencies: list[str] | None = None,
) -> dict[str, Any]:
    """Create an empty task structure."""
    now = utc_now_iso_z()
    return {
        "id": make_task_id(),
        "name": name,
        "description": description,
        "status": TaskStatus.PENDING.value,
        "parent_id": None,
        "dependencies": dependencies or [],
        "assigned_to": None,
        "result": None,
        "error": None,
        "created_at": now,
        "started_at": None,
        "completed_at": None,
        "progress": 0,
        "execution_authorized": False,
        "thread_id": None,
        "authorized_at": None,
        "authorized_by": None,
        "subtasks": [],
        "execution_history": [],
    }


def create_task_detail(
    task_id: str = "",
    agent_id: str = "",
    main_task_id: str = "",
) -> dict[str, Any]:
    """Create an empty per-task/subtask detail structure."""
    now = utc_now_iso_z()
    return {
        "task_id": task_id,
        "agent_id": agent_id,
        "main_task_id": main_task_id,
        "status": TaskStatus.PENDING.value,
        "facts": [],
        "output_summary": "",
        "current_step": "",
        "progress": 0,
        "created_at": now,
        "updated_at": now,
        "completed_at": None,
    }


class ProjectStorage:
    """Storage for task bundles (SQLite ``evoflow_collab_tasks`` root rows + children)."""

    def __init__(self, storage_dir: Path | None = None) -> None:
        del storage_dir  # legacy arg; DB path from ``storage.sqlite_path``
        self._project_cache: dict[str, dict[str, Any]] = {}
        self._project_cache_ts: dict[str, float] = {}
        self._cache_ttl_seconds = max(0.0, _DEFAULT_PROJECT_CACHE_TTL_SECONDS)
        self._cache_max_entries = _DEFAULT_PROJECT_CACHE_MAX_ENTRIES
        self._lock = threading.RLock()

    def _trim_project_cache_locked(self, *, now: float | None = None) -> None:
        """Drop expired entries, then LRU-evict until under the entry cap."""
        import time

        ts_now = time.time() if now is None else now
        if self._cache_ttl_seconds > 0:
            expired = [
                pid
                for pid, ts in self._project_cache_ts.items()
                if (ts_now - float(ts or 0.0)) >= self._cache_ttl_seconds
            ]
            for pid in expired:
                self._project_cache.pop(pid, None)
                self._project_cache_ts.pop(pid, None)
        while len(self._project_cache) > self._cache_max_entries:
            oldest = min(self._project_cache_ts.items(), key=lambda kv: float(kv[1] or 0.0), default=None)
            if oldest is None:
                break
            pid = oldest[0]
            self._project_cache.pop(pid, None)
            self._project_cache_ts.pop(pid, None)

    def load_project(self, project_id: str, *, bypass_cache: bool = False) -> dict[str, Any] | None:
        """Load a project by ID."""
        import time

        from evoflow.persistence import repositories as repo

        with self._lock:
            pid = str(project_id)
            if not bypass_cache:
                cached = self._project_cache.get(pid)
                ts = float(self._project_cache_ts.get(pid) or 0.0)
                if cached is not None and self._cache_ttl_seconds > 0 and (time.time() - ts) < self._cache_ttl_seconds:
                    return cached
                if cached is not None and self._cache_ttl_seconds <= 0:
                    return cached
            project_data = repo.load_task_bundle(pid)
            if project_data is not None:
                now = time.time()
                self._project_cache[pid] = project_data
                self._project_cache_ts[pid] = now
                self._trim_project_cache_locked(now=now)
            elif bypass_cache:
                self._project_cache.pop(pid, None)
                self._project_cache_ts.pop(pid, None)
            return project_data

    def invalidate_project(self, project_id: str) -> None:
        """Drop in-process cache so the next load reads SQLite."""
        with self._lock:
            pid = str(project_id)
            self._project_cache.pop(pid, None)
            self._project_cache_ts.pop(pid, None)

    def save_project(self, project_data: dict[str, Any]) -> bool:
        """Save a project."""
        from evoflow.persistence import repositories as repo

        project_id = project_data.get("id")
        if not project_id:
            return False

        with self._lock:
            try:
                project_data["updated_at"] = utc_now_iso_z()
                repo.save_task_bundle(str(project_id), project_data)
                self._project_cache[str(project_id)] = project_data
                import time

                now = time.time()
                self._project_cache_ts[str(project_id)] = now
                self._trim_project_cache_locked(now=now)
                logger.info("Project %s saved", project_id)
                return True
            except Exception as e:
                logger.error("Failed to save project %s: %s", project_id, e)
                return False

    def delete_project(self, project_id: str) -> bool:
        """Delete a project."""
        from evoflow.persistence import repositories as repo

        with self._lock:
            try:
                repo.delete_task_bundle(project_id)
                self._project_cache.pop(project_id, None)
                logger.info("Project %s deleted", project_id)
                return True
            except Exception as e:
                logger.error("Failed to delete project %s: %s", project_id, e)
                return False

    def list_projects(self) -> list[dict[str, Any]]:
        """List all projects (summary info only)."""
        from evoflow.persistence import repositories as repo

        with self._lock:
            projects: list[dict[str, Any]] = []
            for project_id in repo.list_task_bundle_ids():
                project_data = self.load_project(project_id)
                if project_data:
                    projects.append(
                        {
                            "id": project_data.get("id"),
                            "name": project_data.get("name"),
                            "description": project_data.get("description"),
                            "status": project_data.get("status"),
                            "created_at": project_data.get("created_at"),
                            "updated_at": project_data.get("updated_at"),
                            "task_count": len(project_data.get("tasks", [])),
                        }
                    )
            return projects


class TaskDetailStorage:
    """Storage for task detail snapshots (SQLite ``evoflow_task_details`` / ``evoflow_task_global_facts``)."""

    _UNASSIGNED_AGENT_ID = "__unassigned__"

    def __init__(self, storage_dir: Path | None = None) -> None:
        del storage_dir
        self._cache: dict[str, dict[str, Any]] = {}
        self._cache_order: list[str] = []
        self._cache_max_entries = _DEFAULT_TASK_DETAIL_CACHE_MAX_ENTRIES
        self._lock = threading.Lock()

    def _normalize_agent_id(self, agent_id: str | None) -> str:
        if not agent_id:
            return self._UNASSIGNED_AGENT_ID
        return agent_id

    def _touch_cache_locked(self, cache_key: str, memory_data: dict[str, Any]) -> None:
        self._cache[cache_key] = memory_data
        try:
            self._cache_order.remove(cache_key)
        except ValueError:
            pass
        self._cache_order.append(cache_key)
        while len(self._cache_order) > self._cache_max_entries:
            old = self._cache_order.pop(0)
            self._cache.pop(old, None)

    def load_task_memory(self, project_id: str, agent_id: str, task_id: str) -> dict[str, Any]:
        """Load task memory (``project_id`` = main_task_id)."""
        from evoflow.persistence import repositories as repo

        agent_id = self._normalize_agent_id(agent_id)
        cache_key = f"{project_id}/{agent_id}/{task_id}"
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                try:
                    self._cache_order.remove(cache_key)
                except ValueError:
                    pass
                self._cache_order.append(cache_key)
                return cached
            memory_data = repo.load_task_detail(project_id, agent_id, task_id)
            if memory_data is None:
                memory_data = create_task_detail(task_id, agent_id, project_id)
            self._touch_cache_locked(cache_key, memory_data)
            return memory_data

    def save_task_memory(self, memory_data: dict[str, Any]) -> bool:
        """Save task memory."""
        if not task_memory_persistence_enabled():
            return True
        from evoflow.persistence import repositories as repo

        project_id = memory_data.get("main_task_id")
        agent_id = self._normalize_agent_id(memory_data.get("agent_id"))
        task_id = memory_data.get("task_id")
        if not all([project_id, task_id]):
            return False
        memory_data["agent_id"] = agent_id
        try:
            memory_data["updated_at"] = utc_now_iso_z()
            repo.save_task_detail(str(project_id), agent_id, str(task_id), memory_data)
            cache_key = f"{project_id}/{agent_id}/{task_id}"
            with self._lock:
                self._touch_cache_locked(cache_key, memory_data)
            logger.info("Task memory saved: %s", cache_key)
            return True
        except Exception as e:
            logger.error("Failed to save task memory: %s", e)
            return False

    def load_project_facts(self, project_id: str) -> dict[str, Any]:
        """Load all facts for a main task."""
        from evoflow.persistence import repositories as repo

        data = repo.load_task_global_facts(project_id)
        if data is not None:
            return data
        return {"version": "1.0", "main_task_id": project_id, "facts": [], "last_updated": ""}

    def save_project_facts(self, facts_data: dict[str, Any]) -> bool:
        """Save main task facts."""
        if not task_memory_persistence_enabled():
            return True
        from evoflow.persistence import repositories as repo

        project_id = facts_data.get("main_task_id")
        if not project_id:
            return False
        try:
            facts_data["last_updated"] = utc_now_iso_z()
            repo.save_task_global_facts(str(project_id), facts_data)
            logger.info("Project facts saved: %s", project_id)
            return True
        except Exception as e:
            logger.error("Failed to save project facts: %s", e)
            return False

    def add_fact_to_project(self, project_id: str, fact: dict[str, Any]) -> bool:
        facts_data = self.load_project_facts(project_id)
        facts_data.setdefault("facts", []).append(fact)
        return self.save_project_facts(facts_data)

    def get_agent_memories(self, project_id: str, agent_id: str) -> list[dict[str, Any]]:
        from evoflow.persistence import repositories as repo

        agent_id = self._normalize_agent_id(agent_id)
        return repo.list_task_details_for_agent(project_id, agent_id)


class AgentRuntimeStorage:
    """Storage for agent runtime status (SQLite ``evoflow_agent_runtime``)."""

    def __init__(self, storage_dir: Path | None = None) -> None:
        del storage_dir
        self._lock = threading.Lock()

    def update_agent(self, agent_data: dict[str, Any]) -> bool:
        from evoflow.persistence import repositories as repo

        agent_id = agent_data.get("agent_id")
        if not agent_id:
            return False
        with self._lock:
            repo.save_agent_runtime(str(agent_id), agent_data)
            return True

    def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        from evoflow.persistence import repositories as repo

        return repo.load_all_agent_runtime().get(agent_id)

    def get_all_agents(self) -> list[dict[str, Any]]:
        from evoflow.persistence import repositories as repo

        return list(repo.load_all_agent_runtime().values())

    def remove_agent(self, agent_id: str) -> bool:
        from evoflow.persistence import repositories as repo

        with self._lock:
            return repo.delete_agent_runtime(agent_id)


class TaskStreamLogStorage:
    """Append-only task stream events (SQLite ``evoflow_task_events``, type ``stream``)."""

    def __init__(self, storage_dir: Path | None = None) -> None:
        del storage_dir
        self._lock = threading.RLock()

    def _validate_task_id(self, task_id: str) -> str:
        tid = str(task_id or "").strip()
        if not tid or not _SAFE_TASK_ID_RE.match(tid):
            raise ValueError(f"Invalid task_id {task_id!r}: only alphanumeric characters, hyphens, and underscores are allowed.")
        return tid

    def append_event(self, task_id: str, event: dict[str, Any]) -> bool:
        from evoflow.persistence import repositories as repo

        try:
            tid = self._validate_task_id(task_id)
            with self._lock:
                repo.append_task_stream_event(tid, event)
            return True
        except Exception:
            logger.exception("Failed to append task stream event task_id=%s", task_id)
            return False

    def tail_events(self, task_id: str, limit: int = 200) -> list[dict[str, Any]]:
        from evoflow.persistence import repositories as repo

        limit_n = max(1, min(int(limit or 200), 1000))
        try:
            tid = self._validate_task_id(task_id)
            with self._lock:
                return repo.tail_task_stream_events(tid, limit_n)
        except Exception:
            logger.exception("Failed to tail task stream events task_id=%s", task_id)
            return []


def find_main_task(
    storage: ProjectStorage,
    main_task_id: str,
    *,
    bypass_cache: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Locate a top-level main task by id across all project buckets."""
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"], bypass_cache=bypass_cache)
        if not project:
            continue
        for task in project.get("tasks", []):
            if task.get("id") == main_task_id:
                return project, task
    return None


def find_subtask_by_ids(
    storage: ProjectStorage,
    main_task_id: str,
    subtask_id: str,
) -> dict[str, Any] | None:
    """Return a subtask row from ``main_task_id``'s ``subtasks[]``, or None."""
    found = find_main_task(storage, main_task_id)
    if not found:
        return None
    _project, task = found
    for st in task.get("subtasks") or []:
        if st.get("id") == subtask_id:
            return st
    return None


def patch_collab_subtask_in_project_storage(
    storage: ProjectStorage,
    main_task_id: str,
    subtask_id: str,
    updates: dict[str, Any],
) -> bool:
    """Merge ``updates`` into a ``subtasks[]`` row and persist the project bundle."""
    mid = str(main_task_id or "").strip()
    with main_task_mutation_lock(mid):
        found = find_main_task(storage, mid, bypass_cache=True)
        if not found:
            return False
        project, task = found
        now = utc_now_iso_z()
        subs = list(task.get("subtasks") or [])
        idx = -1
        for i, st in enumerate(subs):
            if isinstance(st, dict) and st.get("id") == subtask_id:
                idx = i
                break
        if idx < 0:
            return False
        prev_row = subs[idx]
        old_status = str(prev_row.get("status") or "").strip().lower() if isinstance(prev_row, dict) else ""
        row = dict(prev_row)
        row.update(updates)
        row["updated_at"] = now
        subs[idx] = row
        task["subtasks"] = subs
        task["updated_at"] = now
        project["updated_at"] = now
        ok = storage.save_project(project)
        if ok and old_status != str(row.get("status") or "").strip().lower():
            try:
                from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

                tid = str(task.get("thread_id") or "").strip() or None
                write_task_lifecycle_trace(
                    thread_id=tid,
                    event="subtask_status_changed",
                    main_task_id=str(main_task_id).strip(),
                    subtask_id=str(subtask_id).strip(),
                    status=str(row.get("status") or "").strip().lower() or None,
                    detail={
                        "from": old_status or None,
                        "to": str(row.get("status") or "").strip().lower() or None,
                        "source": "patch_collab_subtask",
                    },
                )
            except Exception:
                pass
        return ok


def patch_collab_main_task_in_project_storage(
    storage: ProjectStorage,
    main_task_id: str,
    updates: dict[str, Any],
) -> bool:
    """Merge ``updates`` into the main task row and persist the project bundle."""
    mid = str(main_task_id or "").strip()
    if not mid or not updates:
        return False
    with main_task_mutation_lock(mid):
        found = find_main_task(storage, mid, bypass_cache=True)
        if not found:
            return False
        project, task = found
        now = utc_now_iso_z()
        row = dict(task)
        row.update(updates)
        row["updated_at"] = now
        tasks = list(project.get("tasks") or [])
        for i, t in enumerate(tasks):
            if isinstance(t, dict) and t.get("id") == mid:
                tasks[i] = row
                break
        project["tasks"] = tasks
        project["updated_at"] = now
        return bool(storage.save_project(project))


def rollup_root_task_progress_from_subtasks(storage: ProjectStorage, main_task_id: str) -> bool:
    """Sync main-task ``progress`` (cap 99%) and non-terminal ``status`` from subtask rows.

    Main-task ``completed`` + 100% remain lead-only. Returns ``True`` if the main task exists.
    """
    from evoflow.collab.task_progress import sync_main_task_from_subtasks

    try:
        result = sync_main_task_from_subtasks(storage, main_task_id)
        return bool(result.get("ok"))
    except Exception:
        logger.warning("rollup_root_task_progress_from_subtasks failed task_id=%s", main_task_id, exc_info=True)
        return False


def find_subtask_row_by_id(
    storage: ProjectStorage,
    subtask_id: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    """Locate ``(project, main_task, subtask_row)`` when ``subtask_id`` appears in any ``subtasks[]``."""
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"])
        if not project:
            continue
        for task in project.get("tasks", []):
            for st in task.get("subtasks") or []:
                if st.get("id") == subtask_id:
                    return project, task, st
    return None


def load_task_detail_for_task_id(
    project_storage: ProjectStorage,
    memory_storage: TaskDetailStorage,
    task_id: str,
) -> tuple[dict[str, Any], str, str, str | None] | None:
    """Resolve task detail for a **main task id** or a **subtask id** (``GET /api/task-detail/tasks/{id}``).

    On-disk path: ``tasks/{main_task_id}/task_detail/agents/{agent_id}/{task_id}.json`` — ``task_id`` is always
    the memory file basename; for subtasks, ``agent_id`` prefers ``subtask.assigned_to`` then main task's.

    Returns ``(memory_dict, main_task_id, agent_id_used, parent_main_task_id_or_none)``.
    ``parent_main_task_id_or_none`` is ``None`` for a main task, else the parent main task id.
    """
    main = find_main_task(project_storage, task_id)
    if main is not None:
        project, task = main
        agent_id = task.get("assigned_to") or ""
        mem = memory_storage.load_task_memory(task_id, agent_id, task_id)
        return mem, task_id, agent_id, None

    sub = find_subtask_row_by_id(project_storage, task_id)
    if sub is None:
        return None
    project, main_task, subtask = sub
    agent_id = (subtask.get("assigned_to") or main_task.get("assigned_to") or "") or ""
    mtid = str(main_task.get("id") or "").strip()
    mem = memory_storage.load_task_memory(mtid, agent_id, task_id)
    return mem, mtid, agent_id, mtid


def load_task_detail_for_main_task(
    project_storage: ProjectStorage,
    memory_storage: TaskDetailStorage,
    main_task_id: str,
) -> tuple[dict[str, Any], str, str] | None:
    """Resolve task detail for a **main** task id only (not subtask ids).

    Prefer :func:`load_task_detail_for_task_id` when the id may be a subtask.

    Returns ``(memory_dict, main_task_id, agent_id_used)`` or ``None`` if no such main task exists.
    """
    found = find_main_task(project_storage, main_task_id)
    if not found:
        return None
    project, task = found
    agent_id = task.get("assigned_to") or ""
    mem = memory_storage.load_task_memory(main_task_id, agent_id, main_task_id)
    return mem, main_task_id, agent_id


def persist_task_detail_after_subagent_run(
    memory_storage: TaskDetailStorage,
    main_task_id: str,
    agent_id: str,
    memory_task_id: str,
    *,
    outcome: Literal["completed", "failed", "timed_out", "cancelled"],
    output_summary: str,
    current_step: str,
    progress: int,
    source_ref: str | None = None,
) -> tuple[bool, int]:
    """Persist ``output_summary`` / ``facts`` / status after a ``task`` tool subagent run (F-02).

    Storage key: ``tasks/{main_task_id}/task_detail/agents/{agent_id}/{memory_task_id}.json``.
    Best-effort: logs and returns ``(False, 0)`` on error; never raises.
    Returns ``(ok, facts_count)``.
    """
    if not task_memory_persistence_enabled():
        return True, 0
    try:
        mem = memory_storage.load_task_memory(main_task_id, agent_id, memory_task_id)
        now = utc_now_iso_z()
        mem["task_id"] = memory_task_id
        mem["agent_id"] = agent_id
        mem["main_task_id"] = main_task_id
        mem["output_summary"] = (output_summary or "")[:8000]
        mem["current_step"] = (current_step or "")[:2000]
        mem["progress"] = min(100, max(0, int(progress)))
        mem["updated_at"] = now
        if outcome == "completed":
            mem["status"] = TaskStatus.COMPLETED.value
            mem["completed_at"] = now
        elif outcome == "cancelled":
            mem["status"] = TaskStatus.CANCELLED.value
            mem["completed_at"] = now
        else:
            mem["status"] = TaskStatus.FAILED.value
            mem["completed_at"] = now
        fact_id = make_fact_id()
        snippet = (output_summary or "").strip()
        if len(snippet) > 500:
            snippet = snippet[:500] + "…"
        fact_body = f"[subagent {outcome}] {snippet}" if snippet else f"[subagent {outcome}]"
        fact: dict[str, Any] = {
            "id": fact_id,
            "content": fact_body,
            "category": "conclusion" if outcome == "completed" else "finding",
            "confidence": 0.85 if outcome == "completed" else 0.55,
            "source_message": source_ref,
        }
        mem.setdefault("facts", []).append(fact)
        if not memory_storage.save_task_memory(mem):
            return False, 0
        memory_storage.add_fact_to_project(main_task_id, {**fact, "task_id": memory_task_id})
        return True, len(mem.get("facts", []))
    except Exception:
        logger.exception(
            "persist_task_memory_after_subagent_run failed main_task=%s task=%s",
            main_task_id,
            memory_task_id,
        )
        return False, 0


def persist_subtask_runtime_snapshot(
    storage: ProjectStorage,
    memory_storage: TaskDetailStorage,
    main_task_id: str,
    subtask_id: str,
    *,
    status: str | None = None,
    progress: int | None = None,
    task_report: str | None = None,
    execution_preview: str | None = None,
    output_summary: str | None = None,
    current_step: str | None = None,
    result: str | None = None,
    error: str | None = None,
    observed_tools: list[str] | None = None,
    observed_tool_calls: list[dict[str, Any]] | None = None,
    sync_agent_memory: bool = False,
) -> bool:
    """Persist subtask runtime state to the project row (UI source of truth).

    Agent ``task_memory`` is updated only when ``sync_agent_memory=True`` or when
    ``output_summary`` / ``current_step`` are explicitly passed (tool-facing notes).

    Source of truth policy:
    - **Collab completion report**: ``task_report`` (+ ``result`` mirror) — only from
      ``subtask_outcome_report`` / system outcome; shown in sidebar as 完成汇报.
    - **Running text**: ``execution_conversation`` on the main task (tagged by
      ``collab_subtask_id``); do not duplicate long stream drafts on the subtask row.
    - **Agent memory**: ``task_memory.output_summary`` / ``current_step`` — worker run
      notes; must not be treated as the official subtask completion summary.
    """
    found = find_main_task(storage, main_task_id)
    if not found:
        return False
    project, task = found
    subs = list(task.get("subtasks") or [])
    idx = -1
    for i, st in enumerate(subs):
        if isinstance(st, dict) and str(st.get("id") or "").strip() == str(subtask_id or "").strip():
            idx = i
            break
    if idx < 0:
        return False

    now = utc_now_iso_z()
    row = dict(subs[idx])
    prev_status_for_trace = str(row.get("status") or "").strip().lower()
    agent_id = str(row.get("assigned_to") or task.get("assigned_to") or "").strip()

    if status is not None:
        s = str(status).strip().lower()
        if s:
            row["status"] = s
            if s == "completed":
                row["completed_at"] = row.get("completed_at") or now
                row.pop("failed_at", None)
                # Success clears stale errors (e.g. watchdog timed_out then real completion overwrites status only).
                row.pop("error", None)
            elif s in {"failed", "timed_out", "cancelled"}:
                row["failed_at"] = row.get("failed_at") or now
    if progress is not None:
        try:
            row["progress"] = max(0, min(100, int(progress)))
        except (TypeError, ValueError):
            pass
    if task_report is not None:
        tr = str(task_report)[:8000]
        row["task_report"] = tr
        row["result"] = tr
        row.pop("execution_preview", None)
    if result is not None and task_report is None:
        row["result"] = str(result)
    if error is not None:
        row["error"] = str(error)
    if execution_preview is not None:
        # Short status hints only; running body text lives in execution_conversation.
        hint = str(execution_preview).strip()
        if hint and len(hint) <= 160:
            row["execution_preview"] = hint
        elif hint:
            row.pop("execution_preview", None)
    # Tool observations live in execution_conversation; do not duplicate on the row.
    _ = observed_tools
    _ = observed_tool_calls
    row["updated_at"] = now
    subs[idx] = row
    task["subtasks"] = subs
    task["updated_at"] = now
    project["updated_at"] = now
    if not storage.save_project(project):
        return False

    if status is not None:
        st_trace = str(status).strip().lower()
        if st_trace in {"completed", "failed", "timed_out", "cancelled"} and st_trace != prev_status_for_trace:
            try:
                from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

                tid = str(task.get("thread_id") or "").strip() or None
                write_task_lifecycle_trace(
                    thread_id=tid,
                    event="subtask_status_changed",
                    main_task_id=str(main_task_id).strip(),
                    subtask_id=str(subtask_id).strip(),
                    status=st_trace,
                    detail={
                        "from": prev_status_for_trace or None,
                        "to": st_trace,
                        "source": "persist_subtask_runtime_snapshot",
                    },
                )
            except Exception:
                pass

    should_sync_mem = task_memory_persistence_enabled() and (
        sync_agent_memory or output_summary is not None or current_step is not None
    )
    if not should_sync_mem:
        rollup_root_task_progress_from_subtasks(storage, main_task_id)
        return True

    mem = memory_storage.load_task_memory(main_task_id, agent_id, str(subtask_id))
    mem["task_id"] = str(subtask_id)
    mem["main_task_id"] = main_task_id
    mem["agent_id"] = agent_id
    if status is not None:
        mem["status"] = str(status).strip().lower()
    if progress is not None:
        try:
            mem["progress"] = max(0, min(100, int(progress)))
        except (TypeError, ValueError):
            pass
    if output_summary is not None:
        mem["output_summary"] = str(output_summary)[:8000]
    if current_step is not None:
        mem["current_step"] = str(current_step)[:2000]
    if mem.get("status") == "completed":
        mem["completed_at"] = mem.get("completed_at") or now
    memory_storage.save_task_memory(mem)
    # Parent main-task progress is lead-owned; rollup is a no-op but keeps call chains stable.
    rollup_root_task_progress_from_subtasks(storage, main_task_id)
    return True


def reconcile_subtask_memory_consistency(
    storage: ProjectStorage,
    memory_storage: TaskDetailStorage,
    main_task_id: str,
) -> int:
    """Repair divergence between subtask rows and task_memory snapshots.

    Returns number of repaired subtasks.
    """
    if not task_memory_persistence_enabled():
        return 0
    found = find_main_task(storage, main_task_id)
    if not found:
        return 0
    _project, task = found
    repaired = 0
    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        sid = str(st.get("id") or "").strip()
        if not sid:
            continue
        st_status = str(st.get("status") or "").strip()
        st_progress = st.get("progress")
        st_task_report = str(st.get("task_report") or "").strip()
        # read current memory to decide if patch is needed
        try:
            row = load_task_detail_for_task_id(storage, memory_storage, sid)
            mem = row[0] if row else {}
        except Exception:
            mem = {}
        mem_status = str(mem.get("status") or "").strip()
        mem_progress = int(mem.get("progress") or 0) if str(mem.get("progress") or "").strip() else 0
        need_fix = (st_status and st_status != mem_status) or (
            st_progress is not None and int(st_progress or 0) != mem_progress
        )
        if not need_fix:
            continue
        ok = persist_subtask_runtime_snapshot(
            storage,
            memory_storage,
            main_task_id,
            sid,
            status=st_status or None,
            progress=int(st_progress) if st_progress is not None else None,
            task_report=st_task_report or None,
            current_step=f"Subtask {st_status}" if st_status else None,
            result=str(st.get("result") or "") or None,
            error=str(st.get("error") or "") or None,
        )
        if ok:
            repaired += 1
    return repaired


def collab_execution_gate_error(main_task_id: str, runtime_thread_id: str | None) -> str | None:
    """Return user-facing error if collaborative main task cannot run workers; None if OK.

    ``execution_authorized`` and ``thread_id`` binding are no longer enforced here: if the
    main task id exists in project storage, collaborative ``task`` runs are allowed. UI may
    still call ``start_execution`` to advance collab phase / UX; it does not gate the tool.
    """
    _ = runtime_thread_id  # kept for backward-compatible call sites
    storage = get_project_storage()
    found = find_main_task(storage, main_task_id)
    if found is None:
        return f"Error: collaborative task id {main_task_id!r} was not found."
    return None


def find_open_main_task_id_by_name(storage: ProjectStorage, task_name: str) -> str | None:
    """If a root task with this name exists in pending/planning, return its id (supervisor dedupe)."""
    for project_summary in storage.list_projects():
        project = storage.load_project(project_summary["id"])
        if not project:
            continue
        for task in project.get("tasks", []):
            if task.get("name") == task_name and task.get("status") in ("pending", "planning"):
                tid = task.get("id")
                return str(tid) if tid else None
    return None


def new_project_bundle_root_task(
    task_name: str,
    task_description: str = "",
    thread_id: str | None = None,
    session_model_name: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build ``(project_dict, root_task_dict)`` — single source for HTTP ``POST /api/tasks`` and ``supervisor(create_task)``."""
    now = utc_now_iso_z()
    task = create_empty_task(name=task_name, description=task_description)
    task["created_at"] = now
    task["thread_id"] = thread_id
    task["subtasks"] = list(task.get("subtasks") or [])
    if session_model_name:
        task["session_model_name"] = str(session_model_name).strip()
    # Bundle id must be the main task id (storage key). Keep display name unprefixed.
    project = create_empty_project(
        name=str(task_name or "").strip(),
        description=task_description,
        main_task_id=str(task.get("id") or "").strip(),
    )
    project["tasks"] = [task]
    project["created_at"] = now
    project["updated_at"] = now
    return project, task


_storage_instance: ProjectStorage | None = None
_task_memory_instance: TaskDetailStorage | None = None
_agent_runtime_instance: AgentRuntimeStorage | None = None
_task_stream_log_instance: TaskStreamLogStorage | None = None
_storage_lock = threading.Lock()


def get_project_storage() -> ProjectStorage:
    """Get the project storage instance."""
    global _storage_instance
    if _storage_instance is not None:
        return _storage_instance

    with _storage_lock:
        if _storage_instance is not None:
            return _storage_instance
        _storage_instance = ProjectStorage()
        return _storage_instance


def get_task_detail_storage() -> TaskDetailStorage:
    """Get the task detail storage instance."""
    global _task_memory_instance
    if _task_memory_instance is not None:
        return _task_memory_instance

    with _storage_lock:
        if _task_memory_instance is not None:
            return _task_memory_instance
        _task_memory_instance = TaskDetailStorage()
        return _task_memory_instance


# Backward aliases; callers should migrate to `task_detail` names.
TaskMemoryStorage = TaskDetailStorage
get_task_memory_storage = get_task_detail_storage
load_task_memory_for_task_id = load_task_detail_for_task_id
load_task_memory_for_main_task = load_task_detail_for_main_task
persist_task_memory_after_subagent_run = persist_task_detail_after_subagent_run


def get_agent_runtime_storage() -> AgentRuntimeStorage:
    """Get the agent runtime storage instance."""
    global _agent_runtime_instance
    if _agent_runtime_instance is not None:
        return _agent_runtime_instance

    with _storage_lock:
        if _agent_runtime_instance is not None:
            return _agent_runtime_instance
        _agent_runtime_instance = AgentRuntimeStorage()
        return _agent_runtime_instance


def get_task_stream_log_storage() -> TaskStreamLogStorage:
    """Get the task stream log storage instance."""
    global _task_stream_log_instance
    if _task_stream_log_instance is not None:
        return _task_stream_log_instance

    with _storage_lock:
        if _task_stream_log_instance is not None:
            return _task_stream_log_instance
        _task_stream_log_instance = TaskStreamLogStorage()
        return _task_stream_log_instance
