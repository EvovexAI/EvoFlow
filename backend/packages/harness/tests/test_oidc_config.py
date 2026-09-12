"""OIDC / enterprise SSO configuration helpers."""

from __future__ import annotations

import os
from unittest.mock import patch

from evoflow.webui.oidc_config import (
    get_oidc_client_secret,
    get_oidc_config,
    is_oidc_enabled,
    set_oidc_config,
)


def test_oidc_config_mask_secret(monkeypatch) -> None:
    store: dict = {}

    monkeypatch.setattr(
        "evoflow.webui.oidc_config.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )
    monkeypatch.setattr(
        "evoflow.webui.oidc_config.cfg_repo.set_app_setting",
        lambda key, value: store.update({key: value}),
    )

    set_oidc_config(
        {
            "enabled": True,
            "issuer": "https://idp.example.com",
            "clientId": "evoflow-client",
            "clientSecret": "super-secret",
        }
    )
    masked = get_oidc_config(include_secret=False)
    assert masked["clientSecret"] == "********"
    assert masked["hasClientSecret"] is True
    assert get_oidc_client_secret() == "super-secret"

    # Blank secret preserves previous
    set_oidc_config({"clientSecret": ""})
    assert get_oidc_client_secret() == "super-secret"

    set_oidc_config({"clientSecret": "********"})
    assert get_oidc_client_secret() == "super-secret"


def test_is_oidc_enabled_requires_issuer_and_client() -> None:
    store: dict = {}

    with patch("evoflow.webui.oidc_config.cfg_repo.get_app_setting", lambda key: store.get(key)):
        with patch(
            "evoflow.webui.oidc_config.cfg_repo.set_app_setting",
            lambda key, value: store.update({key: value}),
        ):
            assert is_oidc_enabled() is False
            set_oidc_config({"enabled": True, "issuer": "https://idp.example.com"})
            assert is_oidc_enabled() is False
            set_oidc_config({"clientId": "app"})
            assert is_oidc_enabled() is True


def test_env_overrides(monkeypatch) -> None:
    store: dict = {}
    monkeypatch.setenv("EVOFLOW_OIDC_ENABLED", "true")
    monkeypatch.setenv("EVOFLOW_OIDC_ISSUER", "https://env-idp.example.com")
    monkeypatch.setenv("EVOFLOW_OIDC_CLIENT_ID", "env-client")
    monkeypatch.setenv("EVOFLOW_OIDC_CLIENT_SECRET", "env-secret")
    monkeypatch.setenv("EVOFLOW_OIDC_ALLOWED_EMAIL_DOMAIN", "example.com")

    monkeypatch.setattr(
        "evoflow.webui.oidc_config.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )

    cfg = get_oidc_config(include_secret=True)
    assert cfg["enabled"] is True
    assert cfg["issuer"] == "https://env-idp.example.com"
    assert cfg["clientId"] == "env-client"
    assert cfg["clientSecret"] == "env-secret"
    assert cfg["allowedEmailDomain"] == "example.com"

    monkeypatch.delenv("EVOFLOW_OIDC_ENABLED", raising=False)
