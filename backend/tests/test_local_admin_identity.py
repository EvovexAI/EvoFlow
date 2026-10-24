"""Localhost/no-JWT identity must resolve to the operator's real account.

Regression for the account chip showing "Local Admin": the bootstrap principal
(``local-admin``, display "Local Admin") used to be preferred over the primary
WebUI admin, so one person ended up with two identities and the UI showed the
bootstrap label nobody chose.

Run: cd backend && python -m pytest tests/test_local_admin_identity.py -v
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from evoflow.authz import admin_grants as admin_grants_mod
from evoflow.authz import principals as principals_mod
from evoflow.persistence import db as db_mod
from evoflow.persistence.bootstrap_admin_merge import merge_bootstrap_admin_into_primary


@pytest.fixture()
def app_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the app DB at a throwaway file with a fully-migrated schema."""
    db_path = tmp_path / "evoflow.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    monkeypatch.setattr(db_mod, "_cached_default_path", db_path, raising=False)
    monkeypatch.setattr(db_mod, "_DB_SINGLETON", None, raising=False)
    monkeypatch.setattr(db_mod, "_db_singleton", None, raising=False)
    conn = db_mod.get_db()
    yield conn
    try:
        db_mod.close_db()
    except Exception:
        pass


def _seed_admin(conn: sqlite3.Connection, *, with_bootstrap: bool) -> None:
    if with_bootstrap:
        principals_mod.create_principal(
            display_name="Local Admin",
            principal_id="local-admin",
            attrs={"bootstrap": True},
        )
        admin_grants_mod.promote_org_admin("local-admin", granted_by=None)
    principals_mod.ensure_webui_principal(webui_user_id=1, username="admin", is_primary=True)


def test_resolves_primary_admin_over_bootstrap(app_db: sqlite3.Connection) -> None:
    _seed_admin(app_db, with_bootstrap=True)

    resolved = principals_mod.get_or_create_local_admin()

    assert resolved["principal_id"] == "admin"
    assert resolved["display_name"] == "admin"


def test_bootstrap_is_last_resort_and_named_admin(app_db: sqlite3.Connection) -> None:
    resolved = principals_mod.get_or_create_local_admin()

    assert resolved["principal_id"] == "local-admin"
    assert resolved["display_name"] == "admin"
    assert "local admin" not in str(resolved["display_name"]).lower()


@pytest.mark.skipif(sqlite3.sqlite_version_info < (3, 33), reason="requires upsert support")
def test_merge_lets_local_admin_resolve_to_admin(app_db: sqlite3.Connection) -> None:
    """After the one-time merge, localhost calls land on the real account."""
    _seed_admin(app_db, with_bootstrap=True)
    # Pre-merge the bootstrap principal wins (it is the earliest org admin).
    assert principals_mod.get_or_create_local_admin()["principal_id"] == "admin"

    merge_bootstrap_admin_into_primary(app_db)
    resolved = principals_mod.get_or_create_local_admin()
    assert resolved["principal_id"] == "admin"
