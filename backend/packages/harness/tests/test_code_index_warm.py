"""Background index warm / shared workspace DB."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from evoflow.code_index.store import (
    build_index,
    index_status,
    schedule_build_index,
    search_index,
)


@pytest.fixture
def tiny_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path / "evoflow_data"))
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.py").write_text("def hello():\n    return 1\n", encoding="utf-8")
    return ws


def test_index_status_and_schedule_skip_when_ready(tiny_workspace: Path) -> None:
    ws = tiny_workspace
    built = build_index(str(ws))
    assert built.get("ok")
    st = index_status(str(ws))
    assert st.get("ready") is True
    warm = schedule_build_index(str(ws), force=False)
    assert warm.get("skipped") is True
    assert warm.get("reason") == "index_ready"


def test_schedule_build_index_runs_in_background(tiny_workspace: Path) -> None:
    ws = tiny_workspace
    out = schedule_build_index(str(ws), force=True)
    assert out.get("status") == "scheduled"
    deadline = time.time() + 15.0
    while time.time() < deadline:
        st = index_status(str(ws))
        if st.get("ready"):
            break
        time.sleep(0.05)
    assert index_status(str(ws)).get("ready") is True
    hits = search_index(str(ws), query="hello")
    assert hits.get("hits") or hits.get("symbols")


def test_schedule_dedupes_concurrent_jobs(tiny_workspace: Path) -> None:
    ws = tiny_workspace
    first = schedule_build_index(str(ws), force=True)
    second = schedule_build_index(str(ws), force=True)
    assert first.get("status") == "scheduled"
    assert second.get("status") == "building"


def test_search_during_background_build_no_database_locked(tiny_workspace: Path) -> None:
    """Readers must not fail while a full rebuild holds a write transaction."""
    ws = tiny_workspace
    assert build_index(str(ws)).get("ok")
    schedule_build_index(str(ws), force=True)
    deadline = time.time() + 10.0
    while time.time() < deadline:
        st = index_status(str(ws))
        if st.get("building"):
            break
        time.sleep(0.02)
    assert index_status(str(ws)).get("building") is True
    for _ in range(20):
        data = search_index(str(ws), query="hello")
        assert isinstance(data, dict)
        time.sleep(0.05)


def test_index_status_returns_quickly_during_build(tiny_workspace: Path) -> None:
    ws = tiny_workspace
    assert build_index(str(ws)).get("ok")
    schedule_build_index(str(ws), force=True)
    deadline = time.time() + 10.0
    while time.time() < deadline:
        if index_status(str(ws)).get("building"):
            break
        time.sleep(0.02)
    assert index_status(str(ws)).get("building") is True
    t0 = time.time()
    st = index_status(str(ws))
    elapsed_ms = (time.time() - t0) * 1000
    assert isinstance(st, dict)
    assert elapsed_ms < 200
