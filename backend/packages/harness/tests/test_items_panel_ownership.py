"""Items + panel settings ownership isolation."""

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
        try:
            from evoflow.items.store import reset_store_for_tests

            reset_store_for_tests()
        except Exception:
            pass
        yield tmp
        try:
            from evoflow.items.store import reset_store_for_tests

            reset_store_for_tests()
        except Exception:
            pass
        reset_db_for_tests()
        gc.collect()


def test_items_list_filters_by_owner_scope(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.authz import principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.items import service as items_svc

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    assert alice and bob

    items_svc.create_item(
        title="Alice todo",
        owner_scope_id=personal_scope("user:alice"),
        created_by="user:alice",
        org_id="local",
    )
    items_svc.create_item(
        title="Bob todo",
        owner_scope_id=personal_scope("user:bob"),
        created_by="user:bob",
        org_id="local",
    )
    items_svc.create_item(title="Legacy unstamped")

    alice_list = items_svc.list_items(
        is_admin=False,
        personal_scope=personal_scope("user:alice"),
        org_scope="org:local",
        principal=alice,
        filter_visibility=True,
    )
    titles = {r["title"] for r in alice_list["items"]}
    assert titles == {"Alice todo"}

    admin_list = items_svc.list_items(
        is_admin=True,
        personal_scope=personal_scope("user:alice"),
        org_scope="org:local",
        principal=alice,
        filter_visibility=True,
    )
    assert admin_list["total"] == 3


def test_require_item_visible_blocks_other_user(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from fastapi import HTTPException

    from evoflow.authz import http_guard, principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.items import service as items_svc

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")

    created = items_svc.create_item(
        title="secret",
        owner_scope_id=personal_scope("user:alice"),
        created_by="user:alice",
    )
    iid = created["item"]["id"]

    def _authz_bob(_req):
        return {
            "principal": bob,
            "principal_id": "user:bob",
            "is_admin": False,
            "personal_scope": personal_scope("user:bob"),
            "org_scope": "org:local",
            "org_id": "local",
        }

    def _authz_alice(_req):
        return {
            "principal": alice,
            "principal_id": "user:alice",
            "is_admin": False,
            "personal_scope": personal_scope("user:alice"),
            "org_scope": "org:local",
            "org_id": "local",
        }

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", _authz_alice)
    http_guard.require_item_visible(MagicMock(), iid)

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", _authz_bob)
    with pytest.raises(HTTPException) as ei:
        http_guard.require_item_visible(MagicMock(), iid)
    assert ei.value.status_code == 404


def test_panel_settings_per_principal(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.persistence.panel_settings import (
        get_panel_settings,
        patch_panel_settings,
    )

    ensure_app_schema(get_db())
    patch_panel_settings({"theme": "dark"}, principal_id="user:alice")
    patch_panel_settings({"theme": "light"}, principal_id="user:bob")
    assert get_panel_settings("user:alice")["theme"] == "dark"
    assert get_panel_settings("user:bob")["theme"] == "light"
    # global key remains independent
    assert get_panel_settings(None)["theme"] == "system"
