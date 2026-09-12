from evoflow.code_index.store import build_index, index_db_path, search_index
from evoflow.config.paths import Paths


def test_build_index_thread_sandbox(tmp_path, monkeypatch):
    paths = Paths(tmp_path)
    monkeypatch.setattr("evoflow.config.paths.get_paths", lambda: paths)
    tid = "thread-index-1"
    sandbox = paths.sandbox_work_dir(tid)
    sandbox.mkdir(parents=True, exist_ok=True)
    (sandbox / "Main.java").write_text(
        "public class Main { public static void main(String[] args) {} }\n",
        encoding="utf-8",
    )

    out = build_index(thread_id=tid, force=True)
    assert out.get("ok") is True
    assert out.get("root") == str(sandbox.resolve())
    dbp = index_db_path(str(sandbox.resolve()))
    assert dbp.exists()

    data = search_index(thread_id=tid, query="Main")
    assert any(s.get("name") == "Main" for s in data.get("symbols") or [])
