"""Background bash wait must not look like a zombie chat run.

Covers:
- ``_thread_has_running_background_bash`` exact thread match
- ``wait_task`` pulses live-run heartbeat while blocking
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from evoflow.tools.zcode_port.background import (
    BackgroundBashTask,
    _TASKS,
    _LOCK,
    register_task,
    wait_task,
)


def _clear_tasks() -> None:
    with _LOCK:
        _TASKS.clear()


def test_thread_has_running_background_bash_matches_exact_thread(tmp_path: Path):
    from app.gateway.run_status_reconcile import _thread_has_running_background_bash

    _clear_tasks()
    try:
        out = tmp_path / "t.output"
        out.write_text("", encoding="utf-8")
        register_task(
            BackgroundBashTask(
                task_id="abc123def456",
                command="sleep 1",
                description="wait",
                output_path=out,
                status="running",
                thread_id="thread-alive",
                session_key="sess-alive",
            )
        )
        assert _thread_has_running_background_bash("thread-alive") is True
        assert _thread_has_running_background_bash("thread-other") is False
        assert _thread_has_running_background_bash("") is False
    finally:
        _clear_tasks()


def test_wait_task_pulses_heartbeat_while_running(tmp_path: Path):
    _clear_tasks()
    try:
        out = tmp_path / "t.output"
        out.write_text("", encoding="utf-8")
        task = BackgroundBashTask(
            task_id="pulse0000001",
            command="sleep 1",
            description="wait",
            output_path=out,
            status="running",
            thread_id="thread-pulse",
            session_key="sess-pulse",
        )
        register_task(task)

        heartbeats: list[str] = []
        activities: list[str] = []

        def _hb(sk: str) -> int:
            heartbeats.append(sk)
            return 1

        def _act(tid: str, **kwargs):
            activities.append(str(kwargs.get("detail") or ""))

        # Finish quickly after first pulse: mark completed mid-wait.
        real_sleep = __import__("time").sleep

        def _sleep(_s: float) -> None:
            task.status = "completed"
            task.exit_code = 0
            real_sleep(0.01)

        with (
            patch(
                "evoflow.persistence.live_run_repositories.update_live_run_heartbeat",
                side_effect=_hb,
            ),
            patch(
                "evoflow.observability.agent_activity_stream.emit_agent_activity",
                side_effect=_act,
            ),
            patch("evoflow.tools.zcode_port.background.time.sleep", side_effect=_sleep),
        ):
            got = wait_task("pulse0000001", 5_000)

        assert got is not None
        assert got.status == "completed"
        assert heartbeats == ["sess-pulse"]
        assert activities and "pulse0000001" in activities[0]
    finally:
        _clear_tasks()
