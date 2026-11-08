"""Soft-creep progress: in-flight nodes should not stay frozen at 10%."""

from __future__ import annotations

import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "packages" / "harness"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from evoflow.collab.task_progress import (  # noqa: E402
    enrich_task_soft_progress,
    soft_display_progress_for_subtask,
)


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def test_soft_progress_creeps_while_running():
    now = time.time()
    row = {
        "status": "in_progress",
        "progress": 10,
        "started_at": _iso(now - 60),
    }
    soft = soft_display_progress_for_subtask(row, now_ts=now)
    assert soft > 10
    assert soft <= 92


def test_soft_progress_asymptote_under_ceiling():
    now = time.time()
    row = {
        "status": "running",
        "progress": 10,
        "started_at": _iso(now - 3600),
    }
    soft = soft_display_progress_for_subtask(row, now_ts=now)
    assert soft >= 80
    assert soft <= 92


def test_soft_progress_respects_worker_floor():
    now = time.time()
    row = {
        "status": "in_progress",
        "progress": 55,
        "started_at": _iso(now - 30),
    }
    soft = soft_display_progress_for_subtask(row, now_ts=now)
    assert soft >= 55
    assert soft <= 92


def test_soft_progress_terminal_success_is_100():
    assert (
        soft_display_progress_for_subtask({"status": "completed", "progress": 10}, now_ts=time.time())
        == 100
    )


def test_soft_progress_pending_stays_stored():
    assert soft_display_progress_for_subtask({"status": "pending", "progress": 0}, now_ts=time.time()) == 0


def test_enrich_task_soft_progress_bumps_sub_and_main():
    now = time.time()
    out = {
        "id": "Task_1",
        "status": "executing",
        "progress": 10,
        "subtasks": [
            {
                "id": "Subtask_a",
                "status": "in_progress",
                "progress": 10,
                "started_at": _iso(now - 90),
            },
            {
                "id": "Subtask_b",
                "status": "completed",
                "progress": 100,
            },
        ],
    }
    enrich_task_soft_progress(out)
    assert out["subtasks"][0]["progress"] > 10
    assert out["subtasks"][1]["progress"] == 100
    assert out["progress"] > 10
    assert out["progress"] <= 99
