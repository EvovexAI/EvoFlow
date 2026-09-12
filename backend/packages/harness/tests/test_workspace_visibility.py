"""Workspace path visibility + stamp rules (P1 isolation)."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


def test_host_path_stamps_org_shared(sqlite_tmp: str) -> None:
    from evoflow.authz.scope import org_scope
    from evoflow.authz.workspace_visibility import default_owner_scope_for_path, resolve_stamp_for_workspace_path
    from evoflow.persistence import workspace_repositories as ws_repo

    ensure_app_schema(get_db())
    host = str(Path(sqlite_tmp) / "shared-project")
    Path(host).mkdir(parents=True, exist_ok=True)
    assert default_owner_scope_for_path(host, principal_id="user:alice") == org_scope("local")
    stamp = resolve_stamp_for_workspace_path(
        host, {"org_id": "local", "principal_id": "user:alice", "created_by": "user:alice"}
    )
    wid = ws_repo.get_or_create_workspace(host, org_id=stamp["org_id"], owner_scope_id=stamp["owner_scope_id"])
    assert wid > 0
    assert ws_repo.get_workspace_owner_scope(host) == org_scope("local")


def test_personal_files_private_from_other_user(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException

    from evoflow.authz import http_guard, principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.authz.scope_paths import ensure_principal_home, scope_files_dir
    from evoflow.authz.workspace_visibility import (
        default_owner_scope_for_path,
        filter_visible_workspace_paths,
        workspace_path_visible_to_principal,
    )
    from evoflow.persistence import workspace_repositories as ws_repo

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    ensure_principal_home(alice)
    alice_files = str(scope_files_dir(personal_scope("user:alice")).resolve())
    assert default_owner_scope_for_path(alice_files, principal_id="user:alice") == personal_scope(
        "user:alice"
    )
    ws_repo.get_or_create_workspace(
        alice_files,
        org_id="local",
        owner_scope_id=personal_scope("user:alice"),
    )

    assert workspace_path_visible_to_principal(
        alice_files,
        alice,
        personal_scope_id=personal_scope("user:alice"),
        org_scope_id="org:local",
    )
    assert not workspace_path_visible_to_principal(
        alice_files,
        bob,
        personal_scope_id=personal_scope("user:bob"),
        org_scope_id="org:local",
    )

    shared = str(Path(sqlite_tmp) / "team-repo")
    Path(shared).mkdir(parents=True, exist_ok=True)
    ws_repo.get_or_create_workspace(shared, org_id="local", owner_scope_id="org:local")
    visible = filter_visible_workspace_paths(
        [alice_files, shared],
        bob,
        personal_scope_id=personal_scope("user:bob"),
        org_scope_id="org:local",
    )
    assert shared in visible
    assert alice_files not in visible

    monkeypatch.setattr(
        http_guard,
        "resolve_authz_from_request",
        lambda _r: {
            "principal": bob,
            "principal_id": "user:bob",
            "is_admin": False,
            "personal_scope": personal_scope("user:bob"),
            "org_scope": "org:local",
            "org_id": "local",
        },
    )
    with pytest.raises(HTTPException) as ei:
        http_guard.require_workspace_path_visible(MagicMock(), alice_files)
    assert ei.value.status_code == 404


def test_default_workspace_root_is_personal_files(sqlite_tmp: str) -> None:
    from evoflow.authz import principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.authz.scope_paths import scope_files_dir
    from evoflow.authz.workspace_visibility import default_workspace_root_for_principal

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    root = default_workspace_root_for_principal(alice)
    assert root
    expected = str(scope_files_dir(personal_scope("user:alice")).resolve())
    assert Path(root) == Path(expected)
    assert Path(root).is_dir()
