"""Tests for collaboration id formats (short task ids)."""

from __future__ import annotations

import re

from evoflow.collab.id_format import is_task_id, make_task_id


def test_make_task_id_is_short_without_task_prefix() -> None:
    tid = make_task_id()
    assert not tid.startswith("Task_")
    assert re.fullmatch(r"\d{10}_[0-9a-f]{4}", tid, re.IGNORECASE)
    assert len(tid) == 15


def test_is_task_id_accepts_legacy_and_short() -> None:
    assert is_task_id("Task_20260725082222_399713")
    assert is_task_id("2607250827_a3f9")
    assert not is_task_id("Subtask_20260725082222_399713")
    assert not is_task_id("random")
    assert not is_task_id("")
