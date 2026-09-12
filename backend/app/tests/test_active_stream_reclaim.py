"""Active SSE proxy bookkeeping + hang reclaim helpers."""

from __future__ import annotations

import time

import pytest

pytest.importorskip("app.gateway.routers.langgraph_proxy")
from app.gateway.routers import langgraph_proxy as lg


@pytest.fixture(autouse=True)
def _clear_active_streams():
    with lg._active_stream_lock:
        lg._active_stream_proxies.clear()
        lg._active_stream_run_ids.clear()
    yield
    with lg._active_stream_lock:
        lg._active_stream_proxies.clear()
        lg._active_stream_run_ids.clear()


def test_reclaim_stale_missing_run_id_only():
    now = time.time()
    with lg._active_stream_lock:
        lg._active_stream_proxies["zombie"] = now - 120.0
        lg._active_stream_proxies["alive"] = now - 120.0
        lg._active_stream_run_ids["alive"] = "run-1"
        lg._active_stream_proxies["fresh"] = now - 10.0

    victims = lg.reclaim_stale_active_stream_proxies(max_age_s=90.0, require_missing_run_id=True)
    assert victims == ["zombie"]
    snap = {row["thread_id"]: row.get("run_id") for row in lg.list_active_stream_proxies()}
    assert "zombie" not in snap
    assert snap["alive"] == "run-1"
    assert "fresh" in snap


def test_list_active_stream_proxies_sorted_by_age():
    now = time.time()
    with lg._active_stream_lock:
        lg._active_stream_proxies["old"] = now - 50.0
        lg._active_stream_proxies["new"] = now - 5.0
    rows = lg.list_active_stream_proxies()
    assert [r["thread_id"] for r in rows] == ["old", "new"]
