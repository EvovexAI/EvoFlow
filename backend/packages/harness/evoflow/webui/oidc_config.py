"""OIDC / enterprise SSO configuration (stored in evoflow_app_settings)."""

from __future__ import annotations

import os
from typing import Any

from evoflow.persistence import config_repositories as cfg_repo

_OIDC_SETTINGS_KEY = "webui.oidc"

DEFAULT_OIDC_CONFIG: dict[str, Any] = {
    "enabled": False,
    "issuer": "",
    "clientId": "",
    "clientSecret": "",
    "scopes": "openid email profile",
    "emailClaim": "email",
    "nameClaim": "name",
    "subClaim": "sub",
    "allowedEmailDomain": "",
    "autoProvision": True,
    "passwordLoginEnabled": True,
    "buttonLabel": "企业 SSO 登录",
    "redirectUri": "",
    # Optional manual overrides (empty = discover from issuer)
    "authorizationEndpoint": "",
    "tokenEndpoint": "",
    "userinfoEndpoint": "",
    "jwksUri": "",
}


def _normalize_config(raw: Any) -> dict[str, Any]:
    out = dict(DEFAULT_OIDC_CONFIG)
    if isinstance(raw, dict):
        for k in out:
            if k in raw and raw[k] is not None:
                out[k] = raw[k]
    # Env overrides for container / headless deploy
    if os.environ.get("EVOFLOW_OIDC_ENABLED", "").strip().lower() in ("1", "true", "yes"):
        out["enabled"] = True
    for env_key, cfg_key in (
        ("EVOFLOW_OIDC_ISSUER", "issuer"),
        ("EVOFLOW_OIDC_CLIENT_ID", "clientId"),
        ("EVOFLOW_OIDC_CLIENT_SECRET", "clientSecret"),
        ("EVOFLOW_OIDC_ALLOWED_EMAIL_DOMAIN", "allowedEmailDomain"),
    ):
        val = os.environ.get(env_key, "").strip()
        if val:
            out[cfg_key] = val
    out["enabled"] = bool(out.get("enabled"))
    out["autoProvision"] = bool(out.get("autoProvision", True))
    out["passwordLoginEnabled"] = bool(out.get("passwordLoginEnabled", True))
    return out


def get_oidc_config(*, include_secret: bool = False) -> dict[str, Any]:
    raw = cfg_repo.get_app_setting(_OIDC_SETTINGS_KEY)
    cfg = _normalize_config(raw)
    if not include_secret:
        secret = str(cfg.get("clientSecret") or "")
        cfg = dict(cfg)
        cfg["clientSecret"] = "********" if secret else ""
        cfg["hasClientSecret"] = bool(secret)
    return cfg


def set_oidc_config(updates: dict[str, Any]) -> dict[str, Any]:
    current = _normalize_config(cfg_repo.get_app_setting(_OIDC_SETTINGS_KEY))
    merged = dict(current)
    for k, v in updates.items():
        if k not in DEFAULT_OIDC_CONFIG:
            continue
        if k == "clientSecret" and (v is None or v == "" or v == "********"):
            continue
        merged[k] = v
    cfg_repo.set_app_setting(_OIDC_SETTINGS_KEY, merged)
    return get_oidc_config(include_secret=False)


def is_oidc_enabled() -> bool:
    cfg = get_oidc_config(include_secret=True)
    if not cfg.get("enabled"):
        return False
    return bool(str(cfg.get("issuer") or "").strip() and str(cfg.get("clientId") or "").strip())


def get_oidc_client_secret() -> str:
    cfg = _normalize_config(cfg_repo.get_app_setting(_OIDC_SETTINGS_KEY))
    return str(cfg.get("clientSecret") or "").strip()
