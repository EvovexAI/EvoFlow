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
