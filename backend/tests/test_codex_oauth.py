"""Codex subscription OAuth: store, refresh, device session, status."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from evoflow.models import codex_oauth as co


def _jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{body}.sig"


def test_account_id_from_token_reads_chatgpt_claim():
    token = _jwt({"chatgpt_account_id": "acct-1", "exp": 9_999_999_999})
    assert co.account_id_from_token(token) == "acct-1"


def test_save_and_load_auth_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    path = tmp_path / "codex_auth.json"
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(path))
    token = _jwt({"chatgpt_account_id": "a1", "exp": 9_999_999_999})
    co.save_auth_store(
        {"access_token": token, "refresh_token": "rt-1", "account_id": "a1"},
        source="device-code",
    )
    assert path.is_file()
    status = co.get_auth_status()
    assert status["logged_in"] is True
    assert status["account_id"] == "a1"
    assert status["source"] in {"device-code", "evoflow", "refresh"}


def test_resolve_refreshes_expiring_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    path = tmp_path / "codex_auth.json"
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(path))
    old = _jwt({"chatgpt_account_id": "a1", "exp": 1})  # already expired
    fresh = _jwt({"chatgpt_account_id": "a1", "exp": 9_999_999_999})
    co.save_auth_store({"access_token": old, "refresh_token": "rt-old", "account_id": "a1"})

    with patch.object(
        co,
        "refresh_codex_oauth_pure",
        return_value={
            "access_token": fresh,
            "refresh_token": "rt-new",
            "account_id": "a1",
            "last_refresh": "2026-01-01T00:00:00Z",
        },
    ) as refresh:
        out = co.resolve_runtime_tokens(refresh_if_expiring=True, allow_cli_fallback=False)

    refresh.assert_called_once()
    assert out["access_token"] == fresh
    assert out["refresh_token"] == "rt-new"
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored["tokens"]["refresh_token"] == "rt-new"


def test_import_cli_tokens(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    cli = tmp_path / "cli-auth.json"
    evo = tmp_path / "evo-auth.json"
    monkeypatch.setenv("CODEX_AUTH_PATH", str(cli))
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(evo))
    token = _jwt({"chatgpt_account_id": "cli-acct", "exp": 9_999_999_999})
    cli.write_text(
        json.dumps({"tokens": {"access_token": token, "refresh_token": "rt-cli", "account_id": "cli-acct"}}),
        encoding="utf-8",
    )

    with patch.object(
        co,
        "refresh_codex_oauth_pure",
        return_value={
            "access_token": token,
            "refresh_token": "rt-rotated",
            "account_id": "cli-acct",
            "last_refresh": "2026-01-01T00:00:00Z",
        },
    ):
        status = co.import_cli_and_save()

    assert status["logged_in"] is True
    assert evo.is_file()
    stored = json.loads(evo.read_text(encoding="utf-8"))
    assert stored["tokens"]["refresh_token"] == "rt-rotated"
    assert stored["source"] == "cli-import"


def test_device_login_start_and_poll_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(tmp_path / "codex_auth.json"))

    usercode_resp = MagicMock()
    usercode_resp.status_code = 200
    usercode_resp.json.return_value = {
        "user_code": "ABCD-EFGH",
        "device_auth_id": "dev-1",
        "interval": 3,
    }

    poll_resp = MagicMock()
    poll_resp.status_code = 200
    poll_resp.json.return_value = {
        "authorization_code": "auth-code",
        "code_verifier": "verifier",
    }

    token = _jwt({"chatgpt_account_id": "a9", "exp": 9_999_999_999})
    exchange = {"access_token": token, "refresh_token": "rt", "account_id": "a9"}

    with (
        patch("httpx.Client") as client_cls,
        patch.object(co, "_exchange_device_authorization", return_value=exchange),
    ):
        client = MagicMock()
        client.__enter__.return_value = client
        client.__exit__.return_value = False
        client.post.side_effect = [usercode_resp, poll_resp]
        client_cls.return_value = client

        started = co.start_device_login(open_browser=False)
        assert started["user_code"] == "ABCD-EFGH"
        assert started["session_id"]

        polled = co.poll_device_login(started["session_id"])
        assert polled["status"] == "success"
        assert polled["auth"]["logged_in"] is True


def test_clear_auth_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    path = tmp_path / "codex_auth.json"
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(path))
    token = _jwt({"chatgpt_account_id": "a1", "exp": 9_999_999_999})
    co.save_auth_store({"access_token": token, "refresh_token": "rt", "account_id": "a1"})
    assert co.clear_auth_store() is True
    assert not path.exists()
    status = co.get_auth_status()
    assert status["logged_in"] is False


def test_load_codex_cli_credential_prefers_evoflow_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.models.credential_loader import load_codex_cli_credential

    evo = tmp_path / "evo.json"
    monkeypatch.setenv("EVOFLOW_CODEX_AUTH_PATH", str(evo))
    token = _jwt({"chatgpt_account_id": "z1", "exp": 9_999_999_999})
    co.save_auth_store({"access_token": token, "refresh_token": "rt", "account_id": "z1"}, source="device-code")
    cred = load_codex_cli_credential()
    assert cred is not None
    assert cred.access_token == token
    assert cred.account_id == "z1"
