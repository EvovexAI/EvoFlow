"""Session list isolation filters by created_by / scope membership."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests

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


def test_isolation_filters_session_list(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.authz import principals as principals_mod
    from evoflow.authz.session_ownership import (
        acl_session_list_filter_sql,
        stamp_session_ownership,
    )
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.schema import ensure_app_schema

    ensure_app_schema(get_db())
    sess_repo.invalidate_session_select_cache()

    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")

    sess_repo.upsert_session_row("agent:main:alice-s", title="alice chat", message_count=0)
    sess_repo.upsert_session_row("agent:main:bob-s", title="bob chat", message_count=0)
    sess_repo.upsert_session_row("agent:main:legacy-s", title="legacy chat", message_count=0)
    stamp_session_ownership("agent:main:alice-s", alice, force=True)
    stamp_session_ownership("agent:main:bob-s", bob, force=True)

    sql, params = acl_session_list_filter_sql(alice, is_admin=False)
    rows = sess_repo.list_sessions_for_ui(limit=50, acl_sql=sql, acl_params=params)
    keys = {r["sessionKey"] for r in rows}
    assert "agent:main:alice-s" in keys
    assert "agent:main:legacy-s" not in keys  # orphan → admin only (v136)
    assert "agent:main:bob-s" not in keys

    # Admin sees everyone (incl. orphan / other users)
    admin = principals_mod.get_or_create_local_admin()
    sql_a, params_a = acl_session_list_filter_sql(admin, is_admin=True)
    assert sql_a == ""
    rows_admin = sess_repo.list_sessions_for_ui(limit=50, acl_sql=sql_a, acl_params=params_a)
    keys_admin = {r["sessionKey"] for r in rows_admin}
    assert "agent:main:bob-s" in keys_admin
    assert "agent:main:legacy-s" in keys_admin
