"""persistence_pressure snapshot shapes (no live LG required)."""

from __future__ import annotations

from pathlib import Path

from evoflow.admin.persistence_pressure import (
    _list_pckl_files,
    build_persistence_pressure_snapshot,
)


def test_list_pckl_files_empty_dir(tmp_path: Path) -> None:
    assert _list_pckl_files(tmp_path) == []


def test_list_pckl_files_sizes(tmp_path: Path) -> None:
    big = tmp_path / ".langgraph_checkpoint.1.pckl"
    big.write_bytes(b"x" * 1500)
    small = tmp_path / ".langgraph_ops.pckl"
    small.write_bytes(b"y" * 40)
    (tmp_path / "ignore.txt").write_text("nope", encoding="utf-8")
    files = _list_pckl_files(tmp_path)
    assert [f["name"] for f in files] == [
        ".langgraph_checkpoint.1.pckl",
        ".langgraph_ops.pckl",
    ]
    assert files[0]["bytes"] == 1500


def test_build_snapshot_has_legend(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    (tmp_path / ".langgraph_api").mkdir(parents=True)
    snap = build_persistence_pressure_snapshot()
    assert "pckl" in snap
    assert "legend" in snap
    assert snap["legend"]["evoflow_db"]
    assert "checkpointer" in snap
    assert "fat_sessions" in snap
    assert "langgraph_process" in snap
