"""OIDC principal provisioning (JIT + email link)."""

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


def test_oidc_jit_provision(identity_db) -> None:
    p = principals_mod.resolve_or_provision_oidc_principal(
        oidc_sub="oidc-sub-1",
        email="sso@example.com",
        display_name="SSO User",
    )
    pid = str(p["principal_id"])
    assert p["display_name"] == "SSO User"
    linked = principals_mod.resolve_principal_by_identity("oidc", "oidc-sub-1")
    assert linked and str(linked["principal_id"]) == pid


def test_oidc_link_existing_email(identity_db) -> None:
    existing = principals_mod.create_principal(
        display_name="Existing",
        primary_email="same@example.com",
    )
    linked = principals_mod.resolve_or_provision_oidc_principal(
        oidc_sub="oidc-sub-2",
        email="same@example.com",
        display_name="From IdP",
    )
    assert str(linked["principal_id"]) == str(existing["principal_id"])
    by_oidc = principals_mod.resolve_principal_by_identity("oidc", "oidc-sub-2")
    assert by_oidc is not None


def test_oidc_no_auto_provision_raises(identity_db) -> None:
    with pytest.raises(ValueError, match="not provisioned"):
        principals_mod.resolve_or_provision_oidc_principal(
            oidc_sub="unknown-sub",
            email="new@example.com",
            auto_provision=False,
        )
