"""CLI registration + items admin facade (platform ↔ CLI sync)."""

from __future__ import annotations

import gc
import io
import json
import tempfile
from pathlib import Path

import pytest

from evoflow.admin import items as items_admin
from evoflow.cli.main import build_parser, main
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    from evoflow.config.app_config import reset_app_config

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def test_cli_registers_workflow_and_items() -> None:
    parser = build_parser()
    # top-level choices
    actions = parser._subparsers._group_actions  # noqa: SLF001
    choices = set()
    for a in actions:
        if getattr(a, "choices", None):
            choices.update(a.choices.keys())
    assert "workflow" in choices
    assert "items" in choices
    assert "knowledge" in choices


def test_items_admin_crud_roundtrip(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    created = items_admin.create_item({"title": "周五交报告", "notes": "附曲线", "priority": "high"})
    item = created["item"]
    iid = item["id"]
    assert item["title"] == "周五交报告"
    listed = items_admin.list_items(q="报告")
    assert listed["total"] >= 1
    got = items_admin.get_item(iid)
    assert got["item"]["id"] == iid
    updated = items_admin.update_item(iid, {"status": "in_progress"})
    assert updated["item"]["status"] == "in_progress"
    deleted = items_admin.delete_item(iid)
    assert deleted["deleted"] == iid


def test_cli_items_create_list(sqlite_tmp: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    del sqlite_tmp
    payload = json.dumps({"title": "CLI 事项", "status": "todo"}, ensure_ascii=False)
    monkeypatch.setattr("sys.stdin", io.StringIO(payload))
    assert main(["items", "create", "--stdin"]) == 0
    out = capsys.readouterr().out
    assert "CLI 事项" in out
    assert main(["items", "list", "--query", "CLI"]) == 0
    listed = capsys.readouterr().out
    assert "CLI 事项" in listed


def test_cli_workflow_list_empty(sqlite_tmp: Path, capsys) -> None:
    del sqlite_tmp
    # list should succeed even with no apps
    code = main(["workflow", "list"])
    assert code == 0
    data = json.loads(capsys.readouterr().out)
    assert "items" in data
    assert "count" in data


def test_cli_knowledge_help_includes_create() -> None:
    parser = build_parser()
    kn = None
    for a in parser._subparsers._group_actions:  # noqa: SLF001
        if getattr(a, "choices", None) and "knowledge" in a.choices:
            kn = a.choices["knowledge"]
            break
    assert kn is not None
    subs = kn._subparsers._group_actions  # noqa: SLF001
    names = set()
    for a in subs:
        if getattr(a, "choices", None):
            names.update(a.choices.keys())
    assert "create" in names
    assert "enable" in names
    assert "disable" in names
