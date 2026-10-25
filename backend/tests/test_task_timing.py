"""Task timing metrics — duration derivation and trust states."""

from __future__ import annotations

import pytest

from evoflow.collab import timing


def _row(**kw):
    base = {
        "status": "completed",
        "created_at": "2026-10-25T13:46:08.900+08:00",
        "started_at": "2026-10-25T13:46:24.675+08:00",
        "completed_at": "2026-10-25T13:46:44.467+08:00",
    }
    base.update(kw)
    return base


# ── Three segments must stay separate ──────────────────────────────────────


def test_subtask_segments_are_not_conflated():
    """wait and exec answer different questions — collapsing them misleads."""
    fields = timing.subtask_timing_fields(_row())
    # created → started = dependency wait (15.775s), not scheduler lag
    assert fields["wait_duration_ms"] == 15775
    # started → completed = real worker occupancy (19.792s)
    assert fields["exec_duration_ms"] == 19792
    assert fields["timing_state"] == timing.TIMING_OK


def test_run_timing_splits_queue_from_total():
    fields = timing.run_timing_fields(
        {
            "created_at": "2026-10-25T13:46:08.902+08:00",
            "started_at": "2026-10-25T13:46:08.950+08:00",
            "completed_at": "2026-10-25T13:46:50.465+08:00",
            "status": "completed",
        }
    )
    assert fields["queue_ms"] == 48
    assert fields["duration_ms"] == 41563
    assert fields["timing_state"] == timing.TIMING_OK


# ── Trust states ───────────────────────────────────────────────────────────


def test_cancelled_row_is_unreliable():
    """Residual stamps after cancel are not work time (seen as 15h in practice)."""
    fields = timing.subtask_timing_fields(
        _row(status="cancelled", completed_at="2026-10-25T13:46:44.467+08:00")
    )
    assert fields["timing_state"] == timing.TIMING_UNRELIABLE


def test_failed_row_keeps_its_duration():
    """Knowing how long it ran before failing is useful, so keep it."""
    fields = timing.subtask_timing_fields(_row(status="failed"))
    assert fields["timing_state"] == timing.TIMING_OK
    assert fields["exec_duration_ms"] == 19792


def test_unfinished_row_is_open_with_no_duration():
    fields = timing.subtask_timing_fields(_row(status="executing", completed_at=None))
    assert fields["timing_state"] == timing.TIMING_OPEN
    assert fields["exec_duration_ms"] is None


def test_absurdly_long_completion_is_unreliable():
    """Finished but spanning a pause/crash — elapsed is not real work."""
    ms = timing._long_run_guard_ms()
    long_completed = "2026-10-27T13:46:44.467+08:00"  # +2 days
    fields = timing.subtask_timing_fields(_row(completed_at=long_completed))
    assert fields["exec_duration_ms"] > ms
    assert fields["timing_state"] == timing.TIMING_UNRELIABLE


# ── Data hygiene ───────────────────────────────────────────────────────────


def test_missing_stamps_yield_none_not_zero():
    """Zero would silently pollute averages; None is excluded instead."""
    fields = timing.subtask_timing_fields({"status": "pending", "created_at": None})
    assert fields["exec_duration_ms"] is None
    assert fields["timing_state"] == timing.TIMING_OPEN


def test_negative_delta_is_rejected():
    """Clock skew must not produce negative durations."""
    fields = timing.subtask_timing_fields(
        _row(started_at="2026-10-25T13:46:44.000+08:00", completed_at="2026-10-25T13:46:24.000+08:00")
    )
    assert fields["exec_duration_ms"] is None


def test_z_suffix_timestamps_parse():
    assert timing.parse_iso_ts("2026-10-25T05:46:24Z") is not None


# ── Stamping is idempotent ─────────────────────────────────────────────────


def test_stamp_subtask_row_is_idempotent():
    row = _row()
    assert timing.stamp_subtask_row(row) is True
    assert timing.stamp_subtask_row(row) is False
    assert row["exec_duration_ms"] == 19792


def test_stamp_subtask_rows_counts_changes():
    rows = [_row(), _row(status="executing", completed_at=None)]
    assert timing.stamp_subtask_rows(rows) == 2
    assert timing.stamp_subtask_rows(rows) == 0


# ── Formatting ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("ms", "expected"),
    [
        (0, "0ms"),
        (480, "480ms"),
        (15400, "15.4s"),
        (83000, "1m23s"),
        (3_900_000, "1h05m"),
        (None, ""),
        ("bad", ""),
        (-5, ""),
    ],
)
def test_format_duration_ms(ms, expected):
    assert timing.format_duration_ms(ms) == expected
