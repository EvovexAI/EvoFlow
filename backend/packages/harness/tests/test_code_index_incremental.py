import tempfile
from pathlib import Path

from evoflow.code_index.store import build_index, index_file, search_index


def test_incremental_index_file_update_and_remove():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        fp = root / "widget.py"
        fp.write_text("def v1(): pass\n", encoding="utf-8")
        build_index(str(root), force=True)

        fp.write_text("def v2(): pass\nclass Widget: pass\n", encoding="utf-8")
        out = index_file(str(root), relative_path="widget.py")
        assert out.get("ok") is True
        assert out.get("action") == "updated"
        data = search_index(str(root), query="Widget")
        assert any(s.get("name") == "Widget" for s in data.get("symbols") or [])

        index_file(str(root), relative_path="widget.py", deleted=True)
        data2 = search_index(str(root), query="Widget")
        assert not any(s.get("name") == "Widget" for s in data2.get("symbols") or [])
