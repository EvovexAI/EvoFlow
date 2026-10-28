"""Server-side task runtime_health from evoflow_chat_sessions (not FE probe)."""

from __future__ import annotations


def test_resolve_idle_for_terminal() -> None:
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    assert resolve_task_runtime_health({"status": "completed"}, active_index={"by_task_id": set(), "by_thread_id": set()}) == "idle"
    assert resolve_task_runtime_health({"status": "awaiting_close"}, active_index={"by_task_id": set(), "by_thread_id": set()}) == "idle"


def test_resolve_live_by_task_id() -> None:
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    idx = {"by_task_id": {"t1"}, "by_thread_id": set()}
    assert resolve_task_runtime_health({"id": "t1", "status": "executing"}, active_index=idx) == "live"


def test_resolve_live_by_thread() -> None:
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    idx = {"by_task_id": set(), "by_thread_id": {"th-1"}}
    assert (
        resolve_task_runtime_health(
            {"id": "x", "status": "executing", "thread_id": "th-1"},
            active_index=idx,
        )
        == "live"
    )


def test_resolve_interrupted_when_no_session() -> None:
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    idx = {"by_task_id": set(), "by_thread_id": set()}
    assert resolve_task_runtime_health({"id": "orphan", "status": "executing"}, active_index=idx) == "interrupted"


def test_enrich_stamps_fields(monkeypatch) -> None:
    from evoflow.collab import task_runtime_health as trh

    monkeypatch.setattr(
        trh,
        "load_active_run_index",
        lambda: {"by_task_id": {"alive"}, "by_thread_id": set()},
    )
    rows = [
        {"id": "alive", "status": "executing", "progress": 20},
        {"id": "dead", "status": "executing", "progress": 40},
        {"id": "done", "status": "completed", "progress": 100},
    ]
    trh.enrich_tasks_runtime_health(rows)
    assert rows[0]["runtime_health"] == "live" and rows[0]["run_alive"] is True
    assert rows[1]["runtime_health"] == "interrupted" and rows[1]["run_alive"] is False
    assert rows[2]["runtime_health"] == "idle"
