import tempfile
from pathlib import Path

from evoflow.utils.workspace_browse import list_workspace_entries, resolve_under_workspace


def test_resolve_allows_parent_traversal():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "proj"
        root.mkdir()
        outside = Path(tmp) / "outside.txt"
        outside.write_text("x", encoding="utf-8")
        got = resolve_under_workspace(root, "../outside.txt")
        assert got.resolve() == outside.resolve()


def test_list_workspace_entries():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "src").mkdir()
        (root / "src" / "main.py").write_text("print(1)\n", encoding="utf-8")
        (root / "node_modules").mkdir()
        resolved, entries = list_workspace_entries(root, ".")
        assert Path(resolved).is_dir()
        names = {e["name"] for e in entries}
        assert "src" in names
        assert "node_modules" not in names
