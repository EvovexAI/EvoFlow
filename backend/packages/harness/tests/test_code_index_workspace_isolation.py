"""Workspace-scoped index DB isolation and storage limits."""

import tempfile
from pathlib import Path

from evoflow.code_index.store import build_index, index_db_path, search_index


def test_two_workspaces_have_separate_index_dbs():
    with tempfile.TemporaryDirectory() as base:
        root_a = Path(base) / "project_a"
        root_b = Path(base) / "project_b"
        root_a.mkdir()
        root_b.mkdir()
        (root_a / "only_a.py").write_text("def unique_symbol_alpha(): pass\n", encoding="utf-8")
        (root_b / "only_b.py").write_text("def unique_symbol_beta(): pass\n", encoding="utf-8")

        build_index(str(root_a), force=True)
        build_index(str(root_b), force=True)

        db_a = index_db_path(str(root_a.resolve()))
        db_b = index_db_path(str(root_b.resolve()))
        assert db_a != db_b
        assert db_a.exists() and db_b.exists()

        hits_a = search_index(str(root_a), "unique_symbol_alpha")
        hits_b = search_index(str(root_b), "unique_symbol_beta")
        sym_a = {s["name"] for s in hits_a.get("symbols") or []}
        sym_b = {s["name"] for s in hits_b.get("symbols") or []}
        assert "unique_symbol_alpha" in sym_a
        assert "unique_symbol_beta" in sym_b
        assert "unique_symbol_beta" not in sym_a


def test_huge_file_skipped_by_size_cap():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "small.py").write_text("marker_small_file_xyz = 1\n", encoding="utf-8")
        (root / "huge.py").write_text("marker_huge_file_xyz\n" + ("z" * 600_000), encoding="utf-8")

        out = build_index(str(root), force=True)
        assert out.get("ok") is True
        data = search_index(str(root), "marker_small_file_xyz")
        paths = {h["path"] for h in data.get("hits") or []} | {s["path"] for s in data.get("symbols") or []}
        assert "small.py" in paths
        assert "huge.py" not in paths
