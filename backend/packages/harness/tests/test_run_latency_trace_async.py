"""run_latency_trace async persistence."""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from evoflow.observability import run_latency_trace as rlt


@pytest.fixture(autouse=True)
def _reset_executor():
    rlt.flush_run_latency_trace_pending(timeout=1.0)
    rlt._shutdown_executor()
    with rlt._pending_lock:
        rlt._pending_futures.clear()
    yield
    rlt.flush_run_latency_trace_pending(timeout=1.0)
    rlt._shutdown_executor()


def test_write_returns_before_persist(monkeypatch):
    monkeypatch.delenv("EVOFLOW_RUN_LATENCY_SYNC", raising=False)
    seen: list[str] = []

    def slow_persist(row: dict) -> None:
        time.sleep(0.15)
        seen.append(str(row.get("event")))

    with patch.object(rlt, "_persist_run_latency_row", side_effect=slow_persist):
        t0 = time.perf_counter()
        rlt.write_run_latency_event("t-async", "run_cycle_start", {"x": 1}, trace_id="tr")
        elapsed = time.perf_counter() - t0
        assert elapsed < 0.05
        assert seen == []
        rlt.flush_run_latency_trace_pending(timeout=2.0)
        assert seen == ["run_cycle_start"]


def test_sync_mode_persists_inline(monkeypatch):
    monkeypatch.setenv("EVOFLOW_RUN_LATENCY_SYNC", "1")
    seen: list[str] = []

    with patch.object(rlt, "_persist_run_latency_row", side_effect=lambda row: seen.append(str(row["event"]))):
        rlt.write_run_latency_event("t-sync", "pre_model_phase", {"phase": "x"})
        assert seen == ["pre_model_phase"]


def test_run_latency_ts_beijing(monkeypatch):
    monkeypatch.setenv("EVOFLOW_RUN_LATENCY_SYNC", "1")
    rows: list[dict] = []

    with patch.object(rlt, "_persist_run_latency_row", side_effect=lambda row: rows.append(dict(row))):
        rlt.write_run_latency_event("t-bj", "run_cycle_start", {})
    assert rows and "+08:00" in str(rows[0].get("ts") or "")
