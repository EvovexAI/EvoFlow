"""End-to-end tests for the weixin accounts CRUD API (multi-account binding).

Exercises ``/api/channels/weixin/accounts`` (GET / PATCH / DELETE) through a
FastAPI TestClient against a **real** (isolated) SQLite DB, replicating the
exact request shapes the panel sends:

- PATCH body carries ``null`` for untouched fields (``display_name ?? null``);
- account ids contain ``@`` (iLink bot id) and are URL-encoded in the path.

``require_org_admin`` treats unauthenticated local requests as admin, so no
auth mocking is needed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers.channels import router


@pytest.fixture()
def client(monkeypatch, tmp_path: Path) -> TestClient:
    """Isolated DB + weixin home + no live ChannelService (YAML mirror stubbed)."""
    from evoflow.persistence.db import reset_db_for_tests

    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "evoflow.db"))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_db_for_tests()

    import app.channels.service as svc

    monkeypatch.setattr(svc, "get_channel_service", lambda: None)

    import evoflow.config.app_config as app_config

    monkeypatch.setattr(
        app_config, "update_channels_section_and_save", lambda channels: None, raising=False
    )

    import app.gateway.routers.channels as ch_router

    monkeypatch.setattr(
        ch_router, "_channels_section_from_app_config", lambda cfg: {}, raising=False
    )

    app = FastAPI()
    app.include_router(router)
    yield TestClient(app)
    reset_db_for_tests()


def _seed(account_id: str, agent_code: str = "", token: str = "tk") -> None:
    from evoflow.persistence.config_repositories import upsert_bot_binding

    upsert_bot_binding(
        platform="weixin",
        bot_id=account_id,
        agent_code=agent_code,
        bot_secret=token,
        workspace_root="",
        session_config={"assistant_id": agent_code} if agent_code else {},
        enabled=True,
        bound_at="2026-11-15T08:30:00Z",
    )


def test_get_empty_accounts(client: TestClient) -> None:
    resp = client.get("/api/channels/weixin/accounts")
    assert resp.status_code == 200
    assert resp.json() == {"success": True, "accounts": []}


def test_get_lists_full_account_id_and_bound_at(client: TestClient) -> None:
    """The panel shows the FULL iLink account id (not a suffix) so several
    bindings are distinguishable; bound_at surfaces for display."""
    _seed("664040bb4695@im.bot")
    resp = client.get("/api/channels/weixin/accounts")
    assert resp.status_code == 200
    accounts = resp.json()["accounts"]
    assert len(accounts) == 1
    row = accounts[0]
    assert row["account_id"] == "664040bb4695@im.bot"
    assert row["is_main_agent"] is True
    assert row["bound_at"] == "2026-11-15T08:30:00Z"


def test_get_bound_at_falls_back_to_credential_saved_at(client: TestClient) -> None:
    """Absorbed legacy bindings have no bound_at → the credential file's
    saved_at is surfaced instead of an em-dash."""
    from app.channels.weixin_setup import save_weixin_credentials

    _seed("f7d65b3c12a7@im.bot")
    save_weixin_credentials(
        account_id="f7d65b3c12a7@im.bot",
        token="tk",
        base_url="https://ilinkai.weixin.qq.com",
        user_id="",
    )
    resp = client.get("/api/channels/weixin/accounts")
    assert resp.status_code == 200
    row = resp.json()["accounts"][0]
    assert row["bound_at"], "expected saved_at fallback for empty bound_at"


def test_patch_rebinds_employee_with_null_fields(client: TestClient) -> None:
    """PATCH with the exact panel body (untouched fields = null) re-binds the
    account to an employee; GET reflects the new target."""
    _seed("664040bb4695@im.bot")
    resp = client.patch(
        "/api/channels/weixin/accounts/664040bb4695%40im.bot",
        json={"display_name": None, "enabled": None, "agent_code": "sales-emp"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["success"] is True
    assert resp.json()["account"]["agent_code"] == "sales-emp"
    assert resp.json()["account"]["is_main_agent"] is False

    from evoflow.persistence.config_repositories import get_bot_binding

    row = get_bot_binding("weixin", "664040bb4695@im.bot")
    assert row["agent_code"] == "sales-emp"
    assert row["session_config"]["assistant_id"] == "sales-emp"

    listing = client.get("/api/channels/weixin/accounts").json()["accounts"]
    assert listing[0]["agent_code"] == "sales-emp"


def test_patch_rebind_back_to_main_agent(client: TestClient) -> None:
    """``agent_code: ""`` re-routes the bot to the main agent (改绑回主智能体)."""
    _seed("664040bb4695@im.bot", agent_code="sales-emp")
    resp = client.patch(
        "/api/channels/weixin/accounts/664040bb4695%40im.bot",
        json={"display_name": None, "enabled": None, "agent_code": ""},
    )
    assert resp.status_code == 200
    assert resp.json()["account"]["is_main_agent"] is True

    from evoflow.persistence.config_repositories import get_bot_binding

    row = get_bot_binding("weixin", "664040bb4695@im.bot")
    assert row["agent_code"] == ""
    assert "assistant_id" not in row["session_config"]


def test_patch_unknown_account_404(client: TestClient) -> None:
    resp = client.patch(
        "/api/channels/weixin/accounts/ghost%40im.bot",
        json={"display_name": None, "enabled": None, "agent_code": "x"},
    )
    assert resp.status_code == 404


def test_patch_conflicting_employee_409(client: TestClient) -> None:
    """1 employee ⇄ 1 weixin bot: a second bot cannot claim the same agent."""
    _seed("664040bb4695@im.bot", agent_code="sales-emp")
    _seed("f7d65b3c12a7@im.bot")
    resp = client.patch(
        "/api/channels/weixin/accounts/f7d65b3c12a7%40im.bot",
        json={"display_name": None, "enabled": None, "agent_code": "sales-emp"},
    )
    assert resp.status_code == 409


def test_patch_toggle_enabled(client: TestClient) -> None:
    _seed("664040bb4695@im.bot")
    resp = client.patch(
        "/api/channels/weixin/accounts/664040bb4695%40im.bot",
        json={"display_name": None, "enabled": False, "agent_code": None},
    )
    assert resp.status_code == 200
    assert resp.json()["account"]["enabled"] is False

    from evoflow.persistence.config_repositories import get_bot_binding

    assert get_bot_binding("weixin", "664040bb4695@im.bot")["enabled"] is False


def test_delete_unbinds_account(client: TestClient) -> None:
    """DELETE removes the binding row and reports success (增删改查之「删」)."""
    _seed("664040bb4695@im.bot", agent_code="sales-emp")
    resp = client.delete("/api/channels/weixin/accounts/664040bb4695%40im.bot")
    assert resp.status_code == 200, resp.text
    assert resp.json()["success"] is True

    from evoflow.persistence.config_repositories import get_bot_binding

    assert get_bot_binding("weixin", "664040bb4695@im.bot") is None
    assert client.get("/api/channels/weixin/accounts").json()["accounts"] == []


def test_delete_unknown_account_404(client: TestClient) -> None:
    resp = client.delete("/api/channels/weixin/accounts/ghost%40im.bot")
    assert resp.status_code == 404
