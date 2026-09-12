import tempfile
import time
from pathlib import Path

from evoflow.code_index.store import build_index, search_index
from evoflow.code_index.watcher import index_watch_status, start_index_watch, stop_index_watch


def test_watch_registry_start_stop():
    with tempfile.TemporaryDirectory() as tmp:
        root = str(Path(tmp))
        build_index(root, force=True)
        s1 = start_index_watch(workspace_root=root)
        assert s1.get("watching") is True
        st = index_watch_status(workspace_root=root)
        assert st.get("watching") is True
        assert (st.get("ref_count") or 0) >= 1
        s2 = start_index_watch(workspace_root=root)
        assert s2.get("started") is False
        stop_index_watch(workspace_root=root)
        st2 = index_watch_status(workspace_root=root)
        assert (st2.get("ref_count") or 0) >= 1
        stop_index_watch(workspace_root=root)
        st3 = index_watch_status(workspace_root=root)
        assert st3.get("watching") is False


def test_watcher_incremental_on_file_change():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build_index(str(root), force=True)
        start_index_watch(workspace_root=str(root))
        try:
            time.sleep(0.5)
            (root / "live.py").write_text("class Live: pass\n", encoding="utf-8")
            time.sleep(1.5)
            found = False
            for _ in range(20):
                data = search_index(str(root), query="Live")
                if any(s.get("name") == "Live" for s in data.get("symbols") or []):
                    found = True
                    break
                time.sleep(0.25)
            assert found, "watcher did not index new file in time"
        finally:
            stop_index_watch(workspace_root=str(root))
