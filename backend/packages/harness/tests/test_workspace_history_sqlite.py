"""Workspace catalog + session/global history tables."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence import workspace_repositories as ws_repo
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_workspace_tables_exist(sqlite_tmp: None) -> None:
    del sqlite_tmp
    cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_workspaces)").fetchall()}
    assert "workspace_path" in cols
    hist_cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_session_workspace_history)").fetchall()}
    assert "session_key" in hist_cols
    assert "workspace_id" in hist_cols


def test_session_workspace_history_roundtrip(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:new-abc123"
    sess_repo.upsert_session_row(sk, created_at_ms=1000, updated_at_ms=1000, title="t")
    paths = ws_repo.set_session_workspace_paths(
        sk,
        ["D:/work/a", "D:/work/b"],
    )
    assert paths == ["D:/work/a", "D:/work/b"]
    assert ws_repo.list_session_workspace_paths(sk) == paths

    touched = ws_repo.touch_session_workspace(sk, "D:/work/c")
    assert touched[0] == "D:/work/c"
    assert ws_repo.get_session_current_workspace(sk) == "D:/work/c"


def test_global_workspace_history(sqlite_tmp: None) -> None:
    del sqlite_tmp
    paths = ws_repo.set_global_workspace_paths(["D:/global/1", "D:/global/2"])
    assert paths == ["D:/global/1", "D:/global/2"]
    assert ws_repo.list_global_workspace_paths() == paths


def test_touch_session_workspace_respects_user_pin(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:new-pin"
    sess_repo.upsert_session_row(
        sk,
        created_at_ms=1,
        updated_at_ms=1,
        context={
            "local_workspace_root": "D:/user/project",
            "workspace_user_pinned": True,
        },
        local_workspace_root="D:/user/project",
    )
    ws_repo.touch_session_workspace(sk, "D:/agent/other", user_pinned=False)
    assert ws_repo.get_session_current_workspace(sk) == "D:/user/project"
    assert "D:/agent/other" in ws_repo.list_session_workspace_paths(sk)


def test_remove_workspace_cascades(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:new-xyz"
    sess_repo.upsert_session_row(sk, created_at_ms=1, updated_at_ms=1)
    ws_repo.set_session_workspace_paths(sk, ["D:/remove/me"])
    ws_repo.set_global_workspace_paths(["D:/remove/me"])
    ws_repo.remove_workspace_path_everywhere("D:/remove/me")
    assert ws_repo.list_session_workspace_paths(sk) == []
    assert ws_repo.list_global_workspace_paths() == []


def test_remove_workspace_matches_path_variants(sqlite_tmp: None) -> None:
    del sqlite_tmp
    # v127: stored paths are canonicalized (forward slashes) on write.
    ws_repo.set_global_workspace_paths([r"D:\remove\variant"])
    assert ws_repo.list_global_workspace_paths() == ["D:/remove/variant"]
    ws_repo.remove_workspace_path_everywhere("D:/remove/variant/")
    assert ws_repo.list_global_workspace_paths() == []
