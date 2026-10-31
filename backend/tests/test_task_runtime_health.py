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


def test_task_id_from_proactive_session_key() -> None:
    from evoflow.collab.task_runtime_health import _task_id_from_proactive_session_key

    assert (
        _task_id_from_proactive_session_key("proactive:evoflow-fa29011c:task:2610310957_f0dc")
        == "2610310957_f0dc"
    )
    assert _task_id_from_proactive_session_key("proactive:code:duty:round-1") is None
    assert _task_id_from_proactive_session_key("agent:main:foo") is None


def test_load_active_run_index_heals_proactive_task_session_key(monkeypatch) -> None:
    from evoflow.collab import task_runtime_health as trh

    monkeypatch.setattr(
        "evoflow.persistence.session_run_state.list_all_active_sessions",
        lambda limit=2000: [
            {
                "session_key": "proactive:evoflow-fa29011c:task:2610310957_f0dc",
                "thread_id": "bdcaa13f-2eac-44c9-b1c6-50da36984f54",
                "collab_task_id": None,
            }
        ],
    )
    idx = trh.load_active_run_index()
    assert "2610310957_f0dc" in idx["by_task_id"]
    assert "bdcaa13f-2eac-44c9-b1c6-50da36984f54" in idx["by_thread_id"]
    assert (
        trh.resolve_task_runtime_health(
            {"id": "2610310957_f0dc", "status": "executing"},
            active_index=idx,
        )
        == "live"
    )


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


def test_resolve_live_by_subtask_lease_between_waves() -> None:
    """A worker inside a slow tool holds a lease but the session row may still read done.

    Regression: the first workflow smoke run showed ``interrupted`` ~25s in while
    Step 1 was still executing (it finished at 63s); the operator then stopped a
    perfectly healthy run.
    """
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    idx = {"by_task_id": set(), "by_thread_id": set()}
    now = 1_000.0
    task = {
        "id": "t-live",
        "status": "executing",
        "subtasks": [
            {
                "id": "s1",
                "status": "executing",
                "lease_until_ts": now + 240.0,
            }
        ],
    }
    assert resolve_task_runtime_health(task, active_index=idx, now_ts=now) == "live"


def test_resolve_interrupted_when_lease_expired() -> None:
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    idx = {"by_task_id": set(), "by_thread_id": set()}
    now = 1_000.0
    task = {
        "id": "t-dead",
        "status": "executing",
        "subtasks": [{"id": "s1", "status": "executing", "lease_until_ts": now - 60.0}],
    }
    assert resolve_task_runtime_health(task, active_index=idx, now_ts=now) == "interrupted"


def test_resolve_ignores_lease_on_terminal_subtask() -> None:
    from evoflow.collab.task_runtime_health import subtask_has_live_lease

    now = 1_000.0
    assert subtask_has_live_lease({"status": "completed", "lease_until_ts": now + 999}, now_ts=now) is False
    assert subtask_has_live_lease({"status": "executing"}, now_ts=now) is False


def test_resolve_live_by_active_background_executor(monkeypatch) -> None:
    from evoflow.collab import task_runtime_health as trh

    monkeypatch.setattr(trh, "has_active_background_executor", lambda row: bool(row.get("background_task_id")))
    idx = {"by_task_id": set(), "by_thread_id": set()}
    task = {
        "id": "t-bg",
        "status": "executing",
        "subtasks": [{"id": "s1", "status": "executing", "background_task_id": "SupervisorExec_x"}],
    }
    assert trh.resolve_task_runtime_health(task, active_index=idx, now_ts=1_000.0) == "live"
