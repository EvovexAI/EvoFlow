from evoflow.code_index.hooks import _guess_workspace_for_path


def test_guess_workspace_for_path_from_index_meta(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    fp = root / "a.py"
    fp.write_text("x=1\n", encoding="utf-8")
    from evoflow.code_index.store import build_index

    build_index(str(root), force=True)
    ws, rel = _guess_workspace_for_path(str(fp))
    assert ws == str(root.resolve())
    assert rel == "a.py"
