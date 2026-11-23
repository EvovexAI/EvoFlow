"""Workflow (apps) nestable folders: create / rename / cycle / delete-move / list filter."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.persistence import app_folders, app_repositories
from evoflow.persistence import db as db_mod
from evoflow.persistence.schema import ensure_app_schema


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "evoflow.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    monkeypatch.setattr(db_mod, "_cached_default_path", None, raising=False)
    monkeypatch.setattr(db_mod, "_read_pool", None, raising=False)
    monkeypatch.setattr(db_mod, "_shared_conn", None, raising=False)
    monkeypatch.setattr(db_mod, "_shared_conn_path", None, raising=False)
    monkeypatch.setattr(db_mod, "_shared_wrapper", None, raising=False)
    app_repositories.reset_apps_columns_cache_for_tests()
    ensure_app_schema(db_mod.get_db())
    app_repositories.reset_apps_columns_cache_for_tests()
    yield
    app_repositories.reset_apps_columns_cache_for_tests()


def _seed_app(app_id: str, *, name: str = "又又", folder_id: str = "") -> None:
    app_repositories.save_app(
        app_id,
        {
            "name": name,
            "description": "d",
            "status": "draft",
            "folder_id": folder_id,
            "steps": [{"ref": "s1", "name": "step", "goal": "g"}],
            "parameters": [],
            "canvas": {"nodes": [], "edges": []},
        },
    )


def test_create_rename_nested_folders() -> None:
    root = app_folders.create_folder("又又相关")
    assert root["folder_id"].startswith("afolder_")
    assert root["parent_id"] == ""
    assert root["name"] == "又又相关"

    child = app_folders.create_folder("草稿", parent_id=root["folder_id"])
    assert child["parent_id"] == root["folder_id"]

    renamed = app_folders.update_folder(root["folder_id"], name="又又项目")
    assert renamed["name"] == "又又项目"

    items = app_folders.list_folders()
    names = {f["folder_id"]: f["name"] for f in items}
    assert names[root["folder_id"]] == "又又项目"
    assert names[child["folder_id"]] == "草稿"


def test_move_cycle_rejected() -> None:
    a = app_folders.create_folder("A")
    b = app_folders.create_folder("B", parent_id=a["folder_id"])
    with pytest.raises(ValueError, match="descendant"):
        app_folders.update_folder(a["folder_id"], parent_id=b["folder_id"])
    with pytest.raises(ValueError, match="itself"):
        app_folders.update_folder(a["folder_id"], parent_id=a["folder_id"])


def test_max_depth_rejected() -> None:
    parent_id = ""
    last = None
    for i in range(app_folders.MAX_FOLDER_DEPTH):
        last = app_folders.create_folder(f"L{i}", parent_id=parent_id)
        parent_id = last["folder_id"]
    assert last is not None
    with pytest.raises(ValueError, match="max depth"):
        app_folders.create_folder("too-deep", parent_id=last["folder_id"])


def test_delete_moves_apps_to_parent() -> None:
    parent = app_folders.create_folder("父夹")
    child = app_folders.create_folder("子夹", parent_id=parent["folder_id"])
    _seed_app("App_folder_move", folder_id=child["folder_id"])

    loaded = app_repositories.load_app("App_folder_move")
    assert loaded is not None
    assert loaded.get("folder_id") == child["folder_id"]

    assert app_folders.delete_folder(child["folder_id"]) is True
    assert app_folders.get_folder(child["folder_id"]) is None

    loaded2 = app_repositories.load_app("App_folder_move")
    assert loaded2 is not None
    assert loaded2.get("folder_id") == parent["folder_id"]


def test_delete_refuses_nonempty_subfolders() -> None:
    parent = app_folders.create_folder("有子")
    app_folders.create_folder("子", parent_id=parent["folder_id"])
    with pytest.raises(ValueError, match="subfolders"):
        app_folders.delete_folder(parent["folder_id"])


def test_list_apps_folder_filter() -> None:
    folder = app_folders.create_folder("分类")
    _seed_app("App_in_folder", name="夹内", folder_id=folder["folder_id"])
    _seed_app("App_at_root", name="根上", folder_id="")

    in_folder = app_repositories.list_apps(folder_id=folder["folder_id"])
    assert {a["id"] for a in in_folder} == {"App_in_folder"}

    at_root = app_repositories.list_apps(folder_id="__root__")
    assert {a["id"] for a in at_root} == {"App_at_root"}

    all_apps = app_repositories.list_apps()
    assert {a["id"] for a in all_apps} >= {"App_in_folder", "App_at_root"}


def test_save_preserves_folder_when_omitted() -> None:
    folder = app_folders.create_folder("保留")
    _seed_app("App_keep_folder", folder_id=folder["folder_id"])
    app_repositories.save_app(
        "App_keep_folder",
        {
            "name": "又又",
            "description": "updated",
            "status": "draft",
            "steps": [{"ref": "s1", "name": "step", "goal": "g"}],
            "parameters": [],
            "canvas": {"nodes": [], "edges": []},
        },
    )
    loaded = app_repositories.load_app("App_keep_folder")
    assert loaded is not None
    assert loaded.get("folder_id") == folder["folder_id"]
