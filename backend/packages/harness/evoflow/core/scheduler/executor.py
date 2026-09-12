"""Task executor for automation tasks.

Handles execution of scheduled task prompts and records run history.

Roadmap: EVOFLOW_TOOLS_REFACTORING_ROADMAP.md #19 (远期规划)
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import traceback
from dataclasses import asdict, dataclass, field
from datetime import datetime

try:
    from enum import StrEnum
except ImportError:
    from enum import Enum

    class StrEnum(str, Enum):
        pass


from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from evoflow.subagents import SubagentResult

logger = logging.getLogger(__name__)

# ─── Paths ────────────────────────────────────────────────────────

_AUTOMATIONS_DIR = Path.home() / ".evoflow" / "tasks" / "automations"


def _history_file(automation_id: str) -> Path:
    _AUTOMATIONS_DIR.mkdir(parents=True, exist_ok=True)
    return _AUTOMATIONS_DIR / f"{automation_id}_history.jsonl"


def _ensure_dir() -> Path:
    _AUTOMATIONS_DIR.mkdir(parents=True, exist_ok=True)
    return _AUTOMATIONS_DIR


# ─── Run result ──────────────────────────────────────────────────


class ExecutionStatus(StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"
    TIMEOUT = "timeout"
    SKIPPED = "skipped"  # Validity window or paused


@dataclass
class RunRecord:
    """A single execution record for an automation."""

    run_id: str = field(default_factory=lambda: f"{datetime.now().strftime('%Y%m%d%H%M%S')}")
    started_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    finished_at: str | None = None
    status: str = ExecutionStatus.SUCCESS.value
    duration_seconds: float = 0.0
    output: str = ""
    error: str = ""
    trigger_type: str = "scheduled"  # "scheduled" | "manual"
    workspace: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


# Global process registry for cancellation support
_process_registry: dict[str, subprocess.Popen] = {}
_registry_lock = threading.Lock()


def _register_process(task_id: str, process: subprocess.Popen) -> None:
    """Register a subprocess for potential cancellation."""
    with _registry_lock:
        _process_registry[task_id] = process


def _unregister_process(task_id: str) -> None:
    """Unregister a subprocess."""
    with _registry_lock:
        _process_registry.pop(task_id, None)


def cancel_subprocess(task_id: str) -> bool:
    """Cancel a running subprocess by task_id.

    Returns True if process was found and terminated, False otherwise.
    """
    with _registry_lock:
        process = _process_registry.get(task_id)

    if process is None:
        return False

    try:
        # Terminate the process tree
        process.terminate()
        # Wait a bit for graceful termination
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # Force kill if not terminated
            process.kill()
            process.wait()
        return True
    except Exception:
        return False


def _run_subagent_via_subprocess(prompt: str, task_id: str, trace_id: str, timeout: int) -> dict:
    """Run subagent execution in isolated subprocess with cancellation support.

    This creates a completely fresh Python interpreter to avoid LangGraph
    context issues from the parent process.
    """
    import subprocess

    runner_path = Path(__file__).parent / "subagent_runner.py"

    # Setup environment with harness and backend in PYTHONPATH
    env = os.environ.copy()
    harness_path = str(Path(__file__).parents[4])  # scheduler -> core -> evoflow -> packages -> harness
    backend_path = str(Path(__file__).parents[5])  # ... -> backend
    project_root = str(Path(__file__).parents[6])  # ... -> EvoFlow root (for config.yaml)
    current_pypath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = backend_path + os.pathsep + harness_path + os.pathsep + current_pypath

    process = None
    try:
        # Start process with Popen (non-blocking) to enable cancellation
        from evoflow.utils.subprocess_platform import subprocess_text_io_kwargs

        process = subprocess.Popen(
            [sys.executable, str(runner_path), prompt, task_id, trace_id],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=project_root,
            **subprocess_text_io_kwargs(),
        )

        # Register for cancellation tracking
        _register_process(task_id, process)

        try:
            # Wait with timeout
            stdout, stderr = process.communicate(timeout=timeout)

            if process.returncode == 0:
                return json.loads(stdout)
            else:
                return {
                    "task_id": task_id,
                    "trace_id": trace_id,
                    "status": "failed",
                    "result": None,
                    "error": f"Subprocess failed with code {process.returncode}: {stderr}",
                    "started_at": None,
                    "completed_at": None,
                    "ai_messages": [],
                    "stream_messages": [],
                }
        except subprocess.TimeoutExpired:
            # Timeout - kill the process
            process.kill()
            process.wait()
            return {
                "task_id": task_id,
                "trace_id": trace_id,
                "status": "timed_out",
                "result": None,
                "error": f"Execution timed out after {timeout}s",
                "started_at": None,
                "completed_at": None,
                "ai_messages": [],
                "stream_messages": [],
            }

    except Exception as e:
        if process:
            try:
                process.kill()
                process.wait()
            except Exception:
                pass
        return {
            "task_id": task_id,
            "trace_id": trace_id,
            "status": "failed",
            "result": None,
            "error": f"Subprocess execution error: {e}",
            "started_at": None,
            "completed_at": None,
            "ai_messages": [],
            "stream_messages": [],
        }
    finally:
        # Always unregister
        _unregister_process(task_id)


# ─── Executor ────────────────────────────────────────────────────


@dataclass
class AutomationExecutorConfig:
    """Configuration for the executor."""

    timeout_seconds: int = 300  # Max 5 min per execution
    max_output_chars: int = 10000  # Truncate long output
    python_exe: str | None = None  # Auto-detect if None


class AutomationExecutor:
    """Executes automation prompts via SubagentExecutor (same as task_tool).

    The executor uses the same LLM agent execution path as interactive tasks:
    - Loads SubagentConfig
    - Creates SubagentExecutor with full toolset
    - Runs agent with the automation prompt in isolated process
    - Records execution history
    """

    def __init__(self, config: AutomationExecutorConfig | None = None):
        self.config = config or AutomationExecutorConfig()

    def execute(
        self,
        task_id: str,
        task_name: str,
        prompt: str,
        workspace: str | None = None,
        *,
        manual: bool = False,
    ) -> RunRecord:
        """Execute a single automation task via SubagentExecutor.

        Args:
            task_id: Automation task ID.
            task_name: Human-readable name.
            prompt: Task description/prompt to execute.
            workspace: Optional working directory.
            manual: If True, this is a manual (non-scheduled) trigger.

        Returns:
            RunRecord with execution details.
        """
        import time

        record = RunRecord(
            trigger_type="manual" if manual else "scheduled",
            workspace=workspace,
        )

        start_time = time.time()

        try:
            # Run automation prompt via SubagentExecutor in isolated process
            result = self._run_agent(prompt, task_name, workspace)
            # Map SubagentStatus to ExecutionStatus
            status_map = {
                "completed": ExecutionStatus.SUCCESS.value,
                "failed": ExecutionStatus.FAILURE.value,
                "timed_out": ExecutionStatus.TIMEOUT.value,
                "cancelled": ExecutionStatus.SKIPPED.value,
            }
            record.status = status_map.get(str(result.status).lower(), ExecutionStatus.FAILURE.value)
            record.output = result.result or ""
            if result.error:
                record.error = result.error

        except TimeoutError:
            record.status = ExecutionStatus.TIMEOUT.value
            record.error = f"Execution timed out after {self.config.timeout_seconds}s"

        except Exception as e:
            record.status = ExecutionStatus.FAILURE.value
            record.error = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"

        finally:
            record.duration_seconds = round(time.time() - start_time, 2)
            record.finished_at = datetime.now().isoformat(timespec="seconds")

        # Append to history file
        self._append_history(task_id, record)

        logger.info(
            "Automation exec: id=%s name=%r status=%s duration=%.1fs",
            task_id,
            task_name,
            record.status,
            record.duration_seconds,
        )

        return record

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task by its task_id.

        This will terminate the subprocess if it's still running.
        Returns True if process was found and terminated.
        """
        return cancel_subprocess(task_id)

    def _run_agent(self, prompt: str, task_name: str, workspace: str | None = None) -> SubagentResult:
        """Run automation prompt via SubagentExecutor in isolated subprocess.

        Uses general-purpose subagent with full toolset, same execution path
        as interactive task delegation. Runs in separate subprocess with fresh
        Python interpreter to avoid LangGraph context issues.
        """
        from evoflow.collab.id_format import make_trace_id
        from evoflow.subagents import SubagentResult

        # Generate unique task ID and trace ID
        task_id = f"Automation_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        trace_id = make_trace_id()

        # Run in separate subprocess to get clean LangGraph context
        result_dict = _run_subagent_via_subprocess(prompt, task_id, trace_id, self.config.timeout_seconds)

        # Convert dict back to SubagentResult
        # Parse datetime strings back to datetime objects
        from datetime import datetime as dt

        if result_dict.get("started_at"):
            result_dict["started_at"] = dt.fromisoformat(result_dict["started_at"])
        if result_dict.get("completed_at"):
            result_dict["completed_at"] = dt.fromisoformat(result_dict["completed_at"])
        return SubagentResult(**result_dict)

    @staticmethod
    def _append_history(automation_id: str, record: RunRecord) -> None:
        """Append a run record to the history JSONL file."""
        history_path = _history_file(automation_id)
        try:
            with open(history_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record.to_dict(), ensure_ascii=False) + "\n")
        except OSError as e:
            logger.warning("Failed to write history for %s: %s", automation_id, e)

    @staticmethod
    def get_history(automation_id: str, limit: int = 50) -> list[RunRecord]:
        """Read execution history for a task."""
        history_path = _history_file(automation_id)
        if not history_path.exists():
            return []

        records: list[RunRecord] = []
        try:
            lines = history_path.read_text(encoding="utf-8").strip().splitlines()
            for line in lines[-limit:]:
                try:
                    data = json.loads(line)
                    records.append(RunRecord(**data))
                except (json.JSONDecodeError, TypeError):
                    continue
        except OSError as e:
            logger.warning("Failed to read history for %s: %s", automation_id, e)

        return list(reversed(records))  # Most recent first
