import gc
import tempfile
from pathlib import Path

from evoflow.code_index.hooks import drain_index_hook_pool_for_tests, notify_file_changed, resolve_path_under_workspace
from evoflow.code_index.store import build_index, search_index
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace
from evoflow.tools.host_direct.write_file import write_file_hd


def test_resolve_path_under_workspace():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        fp = root / "pkg" / "mod.py"
        fp.parent.mkdir()
        fp.write_text("x", encoding="utf-8")
        ws, rel = resolve_path_under_workspace(str(fp), workspace_root=str(root))
        assert ws == str(root.resolve())
        assert rel == "pkg/mod.py"


def test_write_file_hook_updates_index_via_index_db_fallback():
    """Hook resolves workspace from index meta when ToolRuntime is not injected."""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        build_index(str(root), force=True)
        rt = runtime_with_workspace(str(root))
        out = write_file_hd.invoke(
            {
                "name": "write",
                "type": "tool_call",
                "id": "t-hook-write",
                "args": {"path": "hooked.py", "content": "class Hooked: pass\n", "runtime": rt},
            }
        )
        content = getattr(out, "content", out)
        assert str(content).startswith("OK:")
        drain_index_hook_pool_for_tests()
        data = search_index(str(root), query="Hooked")
        assert any(s.get("name") == "Hooked" for s in data.get("symbols") or [])
        gc.collect()


def test_str_replace_hook_updates_index():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        fp = root / "edit.py"
        fp.write_text("def old(): pass\n", encoding="utf-8")
        build_index(str(root), force=True)
        from evoflow.tools.host_direct.str_replace import str_replace_hd

        rt = runtime_with_workspace(str(root))
        out = str_replace_hd.invoke(
            {
                "name": "replace",
                "type": "tool_call",
                "id": "t-hook-str",
                "args": {
                    "path": "edit.py",
                    "old_string": "old",
                    "new_string": "new_name",
                    "runtime": rt,
                },
            }
        )
        content = getattr(out, "content", out)
        assert str(content).startswith("OK:")
        drain_index_hook_pool_for_tests()
        data = search_index(str(root), query="new_name")
        assert any(s.get("name") == "new_name" for s in data.get("symbols") or [])
        gc.collect()


def test_notify_tool_result_without_runtime():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        build_index(str(root), force=True)
        fp = root / "manual.py"
        fp.write_text("def manual(): pass\n", encoding="utf-8")
        from evoflow.code_index.hooks import notify_tool_result

        notify_tool_result(str(fp), "OK: wrote", workspace_root=str(root))
        drain_index_hook_pool_for_tests()
        data = search_index(str(root), query="manual")
        assert any(s.get("name") == "manual" for s in data.get("symbols") or [])
        gc.collect()


def test_notify_file_changed_guesses_workspace_from_project_index():
    """Without workspace_root, walk up to ``.evoflow/code_index/index.db``."""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        build_index(str(root), force=True)
        fp = root / "pkg" / "guessed.py"
        fp.parent.mkdir()
        fp.write_text("def guessed_symbol_xyz(): pass\n", encoding="utf-8")
        notify_file_changed(str(fp.resolve()))
        drain_index_hook_pool_for_tests()
        data = search_index(str(root), query="guessed_symbol_xyz")
        assert any(s.get("name") == "guessed_symbol_xyz" for s in data.get("symbols") or [])
        gc.collect()


def test_notify_file_changed_deleted():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        fp = root / "gone.py"
        fp.write_text("def gone(): pass\n", encoding="utf-8")
        build_index(str(root), force=True)
        fp.unlink()
        notify_file_changed(str(fp), workspace_root=str(root), deleted=True)
        drain_index_hook_pool_for_tests()
        data = search_index(str(root), query="gone")
        assert not any(s.get("name") == "gone" for s in data.get("symbols") or [])
        gc.collect()
