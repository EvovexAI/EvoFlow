"""Regression: an auto-skipped node must let the main task converge.

Real case (run 2611080207_1016, 2026-11-08): step 1 completed, step 2 failed
(unresolved input binding), step 3 was auto-skipped by
``skip_subtasks_blocked_by_exhausted_upstream_failure``. Every node was terminal,
yet the main task sat at ``executing`` / 33% forever — the run could not be
closed, retried as a unit, or reported honestly to the user.

``skipped`` was missing from ``task_progress._SUB_FAIL`` while every other
module (``monitor`` / ``task_observability`` / ``app_rollup`` / the cancel path)
already treats it as terminal-and-unsuccessful. Note it is *not* recoverable:
``requeue_failed_subtasks_ready_for_retry`` only resets ``failed`` rows.
"""

from __future__ import annotations

from evoflow.collab.task_progress import (
    _SUB_FAIL,
    _SUB_TERMINAL,
    infer_main_status_from_subtasks,
    rollup_verdict_for_terminal_statuses,
)


def _subs(*statuses: str) -> list[dict]:
    return [{"id": str(i), "status": s, "progress": 100 if s == "completed" else 0}
            for i, s in enumerate(statuses)]


def test_skipped_counts_as_terminal_but_not_as_a_raw_failure():
    """Terminal (nothing will revive it) yet kept out of _SUB_FAIL.

    ``_SUB_FAIL`` feeds other decisions; conflating "parked by an upstream
    failure" with "this step failed" would relabel a user-cancelled run as
    failed, so the two are separated and ordered in the verdict function.
    """
    assert "skipped" in _SUB_TERMINAL
    assert "skipped" not in _SUB_FAIL


def test_failed_plus_skipped_rolls_main_to_failed():
    """The exact production shape: completed + failed + skipped ⇒ failed."""
    assert infer_main_status_from_subtasks(
        _subs("completed", "failed", "skipped")
    ) == "failed"


def test_skipped_alone_does_not_leave_the_run_open():
    """No ``executing`` inference when nothing is actually in flight."""
    got = infer_main_status_from_subtasks(_subs("completed", "skipped"))
    assert got != "executing", got
    assert got == "failed"


def test_blocked_plus_skipped_still_converges():
    assert infer_main_status_from_subtasks(
        _subs("blocked", "skipped")
    ) == "failed"


def test_pure_success_is_still_left_to_the_lead_or_rollup():
    """Must not flip a clean run: all-success keeps returning None."""
    assert infer_main_status_from_subtasks(_subs("completed", "completed")) is None


def test_in_flight_node_keeps_the_run_executing():
    """A skipped sibling must not finalize a run that still has work running."""
    assert infer_main_status_from_subtasks(
        _subs("failed", "skipped", "executing")
    ) == "executing"


def test_user_cancel_beats_skipped_relabel():
    """A cancelled run with a parked dependent stays ``cancelled``.

    Keeping ``skipped`` out of ``_SUB_FAIL`` is what allows this precedence:
    turning the user's own stop into a red "failed" would be a lie about intent.
    """
    assert infer_main_status_from_subtasks(_subs("cancelled", "skipped")) == "cancelled"
    assert infer_main_status_from_subtasks(
        _subs("completed", "cancelled", "skipped")
    ) == "cancelled"
    # But a real failure still outranks both.
    assert infer_main_status_from_subtasks(
        _subs("cancelled", "failed", "skipped")
    ) == "failed"


def test_all_cancel_still_cancels():
    assert rollup_verdict_for_terminal_statuses(["cancelled", "canceled"]) == "cancelled"


def test_empty_status_list_has_no_verdict():
    """``all(x in CANCEL for x in [])`` is True — an empty run is not "cancelled"."""
    assert rollup_verdict_for_terminal_statuses([]) is None


def test_mixed_success_and_cancel_is_left_open_as_before():
    """Pre-existing behaviour preserved: no failure, no skip ⇒ no verdict."""
    assert rollup_verdict_for_terminal_statuses(["completed", "cancelled"]) is None
    assert infer_main_status_from_subtasks(_subs("completed", "cancelled")) is None


def test_read_projection_and_verdict_agree():
    """The read projection and the app-sourced write path cannot drift.

    They already drifted once (``blocked``, then ``skipped``): one branch
    re-implemented "all terminal AND any failed" inline, so a run whose steps
    were completed + failed + skipped stayed ``executing`` forever.
    """
    for combo in (
        ("completed", "failed", "skipped"),
        ("cancelled", "skipped"),
        ("completed", "skipped"),
        ("blocked", "skipped"),
        ("completed", "completed"),
    ):
        got = infer_main_status_from_subtasks(_subs(*combo))
        want = rollup_verdict_for_terminal_statuses(list(combo))
        assert got == want, (combo, got, want)


def test_skip_propagates_through_a_skipped_upstream():
    """3-level chain: A failed(exhausted) → B skipped → C must skip too.

    ``skip_subtasks_blocked_by_exhausted_upstream_failure`` only recognised
    ``failed`` upstreams, and a skipped row carries no ``auto_retry_count`` of
    its own, so propagation stopped one node deep. C then sat in ``planned``
    waiting on a node that would never run — which also kept the run out of the
    all-terminal state the rollup needs to close it.
    """
    from evoflow.tools.builtins.supervisor.dependency import (
        _upstream_failure_exhausted,
        skip_subtasks_blocked_by_exhausted_upstream_failure,
    )

    assert _upstream_failure_exhausted({"status": "skipped"}, max_auto_retries=3) is True

    def _sub(sid: str, status: str, *, deps=()) -> dict:
        return {
            "id": sid,
            "name": sid,
            "status": status,
            "assigned_to": "agent",
            "worker_profile": {"depends_on": list(deps)},
        }

    task = {
        "id": "T_MAIN",
        "status": "executing",
        "progress": 40,
        "subtasks": [
            _sub("A", "failed", deps=()) | {"auto_retry_count": 3},
            _sub("B", "skipped", deps=("A",)),
            _sub("C", "planned", deps=("B",)),
            _sub("D", "planned", deps=("C",)),  # 4th level, same wave
        ],
    }

    class _Storage:
        def __init__(self) -> None:
            self._project = {"id": "p1", "tasks": [task]}

        def list_projects(self):
            return [{"id": "p1"}]

        def load_project(self, project_id, *, bypass_cache: bool = False):
            return self._project

        def save_project(self, project):
            self._project = project
            return True

    res = skip_subtasks_blocked_by_exhausted_upstream_failure(_Storage(), "T_MAIN")
    parked = {s["id"]: s["status"] for s in task["subtasks"]}
    assert res.get("changed") is True, res
    assert parked["C"] == "skipped", parked
    assert parked["D"] == "skipped", parked
    assert parked["A"] == "failed" and parked["B"] == "skipped"


def test_app_sourced_run_closes_as_failed_on_the_write_path():
    """``_sync_main_task_from_subtasks_locked`` must force the run closed.

    This is the branch that runs on every worker ``done``; before the fix it
    only fired for ``all terminal AND any failed`` and left a
    completed + failed + skipped run at ``executing``/33% forever.
    """
    from evoflow.collab.task_progress import sync_main_task_from_subtasks

    task = {
        "id": "T_MAIN",
        "status": "executing",
        "progress": 33,
        "source_app_id": "App_test",
        "subtasks": _subs("completed", "failed", "skipped"),
    }

    class _Storage:
        def __init__(self) -> None:
            self._project = {"id": "p1", "tasks": [task]}
            self.saves = 0

        def list_projects(self):
            return [{"id": "p1"}]

        def load_project(self, project_id, *, bypass_cache: bool = False):
            return self._project

        def save_project(self, project):
            self.saves += 1
            self._project = project
            return True

    res = sync_main_task_from_subtasks(_Storage(), "T_MAIN", persist=False)
    assert res.get("status") == "failed", res
