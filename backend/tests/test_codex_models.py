"""Codex subscription model catalog listing (OAuth + refresh-on-401)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from evoflow.models import codex_models as cm
from evoflow.models import codex_oauth as co


def _jwt(payload: dict) -> str:
    import base64

    header = base64.urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{body}.sig"


def test_is_codex_subscription_base_url():
    assert cm.is_codex_subscription_base_url("https://chatgpt.com/backend-api/codex")
    assert cm.is_codex_subscription_base_url("https://chatgpt.com/backend-api/codex/")
    assert not cm.is_codex_subscription_base_url("https://api.openai.com/v1")
    assert not cm.is_codex_subscription_base_url("")


def test_normalize_prefers_context_window_over_max():
    row = cm.normalize_codex_model_row(
        {
            "slug": "gpt-test",
            "display_name": "GPT Test",
            "visibility": "list",
            "context_window": 272000,
            "max_context_window": 400000,
            "supported_reasoning_levels": [{"effort": "medium"}],
            "input_modalities": ["text", "image"],
        }
    )
    assert row is not None
    assert row["id"] == "gpt-test"
    assert row["context_window"] == 272000
    assert row["max_context_window"] == 400000
    assert row["resolved_context_window"] == 272000
    assert row["supports_reasoning"] is True
    assert row["supports_vision"] is True


def test_normalize_hides_non_list_visibility():
    assert cm.normalize_codex_model_row({"slug": "hidden", "visibility": "hide"}) is None


def test_list_codex_models_uses_oauth_and_parses(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(tmp_path / "codex_auth.json"))
    token = _jwt({"chatgpt_account_id": "acct-1", "exp": 9_999_999_999})
    co.save_auth_store(
        {"access_token": token, "refresh_token": "rt-1", "account_id": "acct-1"},
        source="device-code",
    )

    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "models": [
            {
                "slug": "gpt-5.4",
                "display_name": "GPT-5.4",
                "visibility": "list",
                "context_window": 272000,
                "max_context_window": 272000,
                "supported_reasoning_levels": [{"effort": "high"}],
                "input_modalities": ["text", "image"],
            },
            {"slug": "secret", "visibility": "hide", "context_window": 1000},
        ]
    }

    with patch.object(cm, "_fetch_models_once", return_value=resp) as fetch:
        out = cm.list_codex_subscription_models(allow_builtin_fallback=False)

    fetch.assert_called_once()
    assert out["success"] is True
    assert out["source"] == "remote"
    assert len(out["models"]) == 1
    assert out["models"][0]["id"] == "gpt-5.4"
    assert out["models"][0]["resolved_context_window"] == 272000


def test_list_codex_models_refreshes_on_401(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(tmp_path / "codex_auth.json"))
    old = _jwt({"chatgpt_account_id": "acct-1", "exp": 9_999_999_999})
    fresh = _jwt({"chatgpt_account_id": "acct-1", "exp": 9_999_999_999})
    co.save_auth_store(
        {"access_token": old, "refresh_token": "rt-old", "account_id": "acct-1"},
        source="device-code",
    )

    unauthorized = MagicMock()
    unauthorized.status_code = 401
    unauthorized.text = "Unauthorized"

    ok = MagicMock()
    ok.status_code = 200
    ok.json.return_value = {
        "models": [{"slug": "gpt-5.4", "visibility": "list", "context_window": 272000}]
    }

    with (
        patch.object(cm, "_fetch_models_once", side_effect=[unauthorized, ok]) as fetch,
        patch.object(
            co,
            "refresh_codex_oauth_pure",
            return_value={
                "access_token": fresh,
                "refresh_token": "rt-new",
                "account_id": "acct-1",
                "last_refresh": "2026-01-01T00:00:00Z",
            },
        ) as refresh,
    ):
        # force_refresh path inside list uses resolve_runtime_tokens(force_refresh=True)
        out = cm.list_codex_subscription_models(allow_builtin_fallback=False)

    assert fetch.call_count == 2
    refresh.assert_called()
    assert out["success"] is True
    assert out["models"][0]["id"] == "gpt-5.4"


def test_list_codex_models_relogin_when_still_unauthorized(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(tmp_path / "codex_auth.json"))
    token = _jwt({"chatgpt_account_id": "acct-1", "exp": 9_999_999_999})
    co.save_auth_store(
        {"access_token": token, "refresh_token": "rt-1", "account_id": "acct-1"},
        source="device-code",
    )

    unauthorized = MagicMock()
    unauthorized.status_code = 401
    unauthorized.text = "Unauthorized"

    with (
        patch.object(cm, "_fetch_models_once", return_value=unauthorized),
        patch.object(
            co,
            "refresh_codex_oauth_pure",
            return_value={
                "access_token": token,
                "refresh_token": "rt-1",
                "account_id": "acct-1",
                "last_refresh": "2026-01-01T00:00:00Z",
            },
        ),
    ):
        out = cm.list_codex_subscription_models(allow_builtin_fallback=False)

    assert out["success"] is False
    assert out["relogin_required"] is True
