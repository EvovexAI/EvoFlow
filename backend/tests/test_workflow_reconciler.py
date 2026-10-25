"""Workflow crash/node recover reconciler."""

from __future__ import annotations

import time

from evoflow.collab.runner_epoch import current_runner_epoch, reset_runner_epoch_for_tests
from evoflow.collab.workflow_reconciler import is_zombie_executing_subtask


def test_zombie_when_epoch_mismatches():
    reset_runner_epoch_for_tests("ep-live")
    st = {
        "status": "executing",
        "runner_epoch": "ep-old",
        "lease_until_ts": time.time() + 9999,
    }
    assert is_zombie_executing_subtask(st, reason="tick") is True


def test_not_zombie_when_same_epoch_and_lease_valid():
    ep = reset_runner_epoch_for_tests()
    st = {
        "status": "executing",
        "runner_epoch": ep,
        "lease_until_ts": time.time() + 9999,
    }
    assert is_zombie_executing_subtask(st, reason="tick") is False
    assert current_runner_epoch() == ep


def test_zombie_when_lease_expired():
    ep = reset_runner_epoch_for_tests()
    st = {
        "status": "executing",
        "runner_epoch": ep,
        "lease_until_ts": time.time() - 10,
    }
    assert is_zombie_executing_subtask(st, reason="tick") is True


def test_boot_treats_pre_epoch_executing_as_zombie():
    reset_runner_epoch_for_tests("ep-boot")
    st = {"status": "executing", "lease_until_ts": time.time() + 9999}
    assert is_zombie_executing_subtask(st, reason="boot") is True
    assert is_zombie_executing_subtask(st, reason="tick") is False


# ── Desktop split process model (Gateway ticks vs LangGraph claims) ─────────
#
# Regression: the reconciler ticks in the Gateway process while task_tool
# claims run in the LangGraph process.  When the epoch was a per-process uuid,
# the Gateway never matched the row epoch and "healed" a *live* Step 2 back to
# pending on the very next tick (observed as error_text="reconcile:tick:zombie_executing"
# on a subtask that then completed normally 16s later).


def test_epoch_uses_boot_cycle_id_so_processes_share_it(monkeypatch):
    reset_runner_epoch_for_tests()
    monkeypatch.delenv("EVOFLOW_RUNNER_EPOCH", raising=False)
    monkeypatch.setenv("EVOFLOW_BOOT_CYCLE_ID", "bc-1792907086215-45008")
    from evoflow.collab import runner_epoch

    runner_epoch._EPOCH = None
    runner_epoch._OVERRIDE = None
    assert current_runner_epoch() == "bc-1792907086215-45008"
    assert runner_epoch.runner_epoch_is_shared() is True


def test_epoch_falls_back_to_process_id_without_boot_env(monkeypatch):
    reset_runner_epoch_for_tests()
    monkeypatch.delenv("EVOFLOW_RUNNER_EPOCH", raising=False)
    monkeypatch.delenv("EVOFLOW_BOOT_CYCLE_ID", raising=False)
    from evoflow.collab import runner_epoch

    runner_epoch._EPOCH = None
    runner_epoch._OVERRIDE = None
    assert current_runner_epoch().startswith("ep-")
    # Not comparable across processes → epoch mismatch must NOT be conclusive.
    assert runner_epoch.runner_epoch_is_shared() is False


def test_cross_process_epoch_mismatch_is_not_zombie_when_epoch_unscoped(monkeypatch):
    """Per-process epoch must not be used to condemn a live worker."""
    monkeypatch.delenv("EVOFLOW_RUNNER_EPOCH", raising=False)
    monkeypatch.delenv("EVOFLOW_BOOT_CYCLE_ID", raising=False)
    reset_runner_epoch_for_tests()
    from evoflow.collab import runner_epoch

    runner_epoch._EPOCH = None
    runner_epoch._OVERRIDE = None

    st = {
        "status": "executing",
        "runner_epoch": "ep-some-other-process",
        "lease_until_ts": time.time() + 9999,
        "updated_at": "2026-10-25T13:46:24.675852+08:00",
    }
    # Lease valid + epoch not comparable → must stay alive (regression guard).
    assert is_zombie_executing_subtask(st, reason="tick") is False


def test_cross_process_epoch_mismatch_is_zombie_when_epoch_boot_scoped(monkeypatch):
    """With a boot-scoped epoch, a row from a *previous* boot must still heal."""
    monkeypatch.delenv("EVOFLOW_RUNNER_EPOCH", raising=False)
    monkeypatch.setenv("EVOFLOW_BOOT_CYCLE_ID", "bc-current-boot")
    reset_runner_epoch_for_tests()
    from evoflow.collab import runner_epoch

    runner_epoch._EPOCH = None
    runner_epoch._OVERRIDE = None

    st = {
        "status": "executing",
        "runner_epoch": "bc-previous-boot",
        "lease_until_ts": time.time() + 9999,
    }
    assert is_zombie_executing_subtask(st, reason="tick") is True

    st_same = {
        "status": "executing",
        "runner_epoch": "bc-current-boot",
        "lease_until_ts": time.time() + 9999,
    }
    assert is_zombie_executing_subtask(st_same, reason="tick") is False
