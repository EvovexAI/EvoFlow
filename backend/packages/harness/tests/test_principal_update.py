"""Principal update + password reset tests."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.authz import principals as principals_mod
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def identity_db(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        monkeypatch.setenv("EVOFLOW_ACL_MODE", "shadow")
        reset_db_for_tests()
        ensure_app_schema(get_db())
        yield
        reset_db_for_tests()
        gc.collect()


def test_update_principal_display_and_email(identity_db) -> None:
    created = principals_mod.create_principal(
        display_name="Alice",
        username="alice",
        password="password123",
        primary_email="alice@example.com",
    )
    pid = str(created["principal_id"])
    updated = principals_mod.update_principal(
        pid,
        display_name="Alice Wang",
        primary_email="alice.wang@example.com",
        update_primary_email=True,
    )
    assert updated["display_name"] == "Alice Wang"
    assert updated["primary_email"] == "alice.wang@example.com"


def test_reset_principal_password(identity_db) -> None:
    created = principals_mod.create_principal(
        display_name="Bob",
        username="bob",
        password="oldpassword1",
    )
    pid = str(created["principal_id"])
    new_pw = principals_mod.reset_principal_password(pid, new_password="newpassword9")
    assert new_pw == "newpassword9"
    from evoflow.webui.auth import verify_user_credentials

    assert verify_user_credentials("bob", "newpassword9") is not None
    assert verify_user_credentials("bob", "oldpassword1") is None
