"""Feishu QR re-bind steals app_id from the previously mistaken employee."""

from __future__ import annotations

from types import SimpleNamespace

import pytest


def _role(code: str, *, app_id: str = "", secret: str = "sec"):
    cfg = SimpleNamespace(
        feishu_app_id=app_id,
        feishu_app_secret=secret if app_id else "",
        feishu_open_id="ou_x" if app_id else "",
        feishu_bound_at="2026-01-01T00:00:00Z" if app_id else "",
        feishu_intro_sent_at="",
        feishu_intro_sent={},
        approval_channels=["feishu"] if app_id else [],
    )
    return SimpleNamespace(agent_code=code, role_name=code, config=cfg, status="active")


def test_steal_clears_other_role_holding_same_app_id(monkeypatch):
    from evoflow.proactive import feishu_binding as fb

    wrong = _role("douyin", app_id="cli_ecom")
    winner = _role("ecommerce", app_id="")
    saved: list[str] = []
    removed: list[str] = []

    monkeypatch.setattr(
        fb.ProactiveRepository,
        "list_roles",
        staticmethod(lambda: [wrong, winner]),
    )
    monkeypatch.setattr(
        fb.ProactiveRepository,
        "save_role",
        staticmethod(lambda role: saved.append(role.agent_code)),
    )
    monkeypatch.setattr(fb, "remove_role_account_from_channel", lambda code: removed.append(code) or True)
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_bot_binding",
        lambda *_a, **_k: {"agent_code": "douyin", "bot_id": "cli_ecom"},
    )
    deleted: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.delete_bot_binding",
        lambda plat, bid: deleted.append((plat, bid)) or True,
    )

    cleared = fb.steal_feishu_app_id_from_other_roles("cli_ecom", keep_agent_code="ecommerce")
    assert cleared == ["douyin"]
    assert wrong.config.feishu_app_id == ""
    assert wrong.config.feishu_app_secret == ""
    assert saved == ["douyin"]
    assert removed == ["douyin"]
    assert deleted == [("feishu", "cli_ecom")]


def test_steal_noop_when_only_keeper_holds_app(monkeypatch):
    from evoflow.proactive import feishu_binding as fb

    keeper = _role("ecommerce", app_id="cli_ecom")
    monkeypatch.setattr(
        fb.ProactiveRepository,
        "list_roles",
        staticmethod(lambda: [keeper]),
    )
    monkeypatch.setattr(
        fb.ProactiveRepository,
        "save_role",
        staticmethod(lambda _role: (_ for _ in ()).throw(AssertionError("should not save"))),
    )
    monkeypatch.setattr(
        fb,
        "remove_role_account_from_channel",
        lambda _code: (_ for _ in ()).throw(AssertionError("should not remove")),
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_bot_binding",
        lambda *_a, **_k: {"agent_code": "ecommerce", "bot_id": "cli_ecom"},
    )

    assert fb.steal_feishu_app_id_from_other_roles("cli_ecom", keep_agent_code="ecommerce") == []
    assert keeper.config.feishu_app_id == "cli_ecom"


def test_sync_drops_duplicate_app_id_account_slots(monkeypatch):
    from evoflow.proactive import feishu_binding as fb

    persisted: dict = {}

    monkeypatch.setattr(
        fb,
        "_channels_section",
        lambda: {
            "feishu": {
                "enabled": True,
                "accounts": {
                    "douyin": {"app_id": "cli_ecom", "app_secret": "old"},
                    "other": {"app_id": "cli_other", "app_secret": "x"},
                },
            }
        },
    )

    def _persist(accounts, *, ensure_enabled=True):
        persisted["accounts"] = dict(accounts)
        persisted["ensure_enabled"] = ensure_enabled

    monkeypatch.setattr(fb, "_persist_feishu_accounts", _persist)

    out = fb.sync_role_account_to_channel(
        "ecommerce",
        app_id="cli_ecom",
        app_secret="newsec",
        open_id="ou_new",
        role_name="电商",
    )
    assert out["app_id"] == "cli_ecom"
    assert "douyin" not in persisted["accounts"]
    assert "other" in persisted["accounts"]
    assert persisted["accounts"]["ecommerce"]["app_secret"] == "newsec"


@pytest.mark.asyncio
async def test_apply_registration_returns_stolen_from(monkeypatch):
    from evoflow.proactive import feishu_binding as fb

    winner = _role("ecommerce", app_id="")
    monkeypatch.setattr(
        fb.ProactiveRepository,
        "get_role",
        staticmethod(lambda code: winner if code == "ecommerce" else None),
    )
    monkeypatch.setattr(fb.ProactiveRepository, "save_role", staticmethod(lambda _r: None))
    monkeypatch.setattr(fb, "steal_feishu_app_id_from_other_roles", lambda *_a, **_k: ["douyin"])
    monkeypatch.setattr(fb, "sync_role_account_to_channel", lambda *_a, **_k: {})
    monkeypatch.setattr(fb, "restart_feishu_channel_if_possible", lambda: _async_false())

    async def _no_intro(*_a, **_k):
        return None

    monkeypatch.setattr(
        "evoflow.proactive.self_intro.push_employee_self_intro",
        _no_intro,
    )

    result = await fb.apply_registration_to_role(
        "ecommerce",
        app_id="cli_ecom",
        app_secret="sec",
        open_id="ou_1",
    )
    assert result["ok"] is True
    assert result["stolen_from"] == ["douyin"]
    assert winner.config.feishu_app_id == "cli_ecom"


@pytest.mark.asyncio
async def test_rebind_same_open_id_keeps_intro_markers(monkeypatch):
    """Same binder scanning QR again must not wipe durable intro state."""
    from evoflow.proactive import feishu_binding as fb

    winner = _role("ecommerce", app_id="cli_ecom")
    winner.config.feishu_open_id = "ou_same"
    winner.config.feishu_intro_sent_at = "2026-10-30T10:00:00Z"
    winner.config.feishu_intro_sent = {
        "open_id:ou_same": "2026-10-30T10:00:00Z",
        "chat_id:oc_private": "2026-10-30T10:01:00Z",
    }
    monkeypatch.setattr(
        fb.ProactiveRepository,
        "get_role",
        staticmethod(lambda code: winner if code == "ecommerce" else None),
    )
    monkeypatch.setattr(fb.ProactiveRepository, "save_role", staticmethod(lambda _r: None))
    monkeypatch.setattr(fb, "steal_feishu_app_id_from_other_roles", lambda *_a, **_k: [])
    monkeypatch.setattr(fb, "sync_role_account_to_channel", lambda *_a, **_k: {})
    monkeypatch.setattr(fb, "restart_feishu_channel_if_possible", lambda: _async_false())

    pushed: list[str] = []

    async def _intro(code, *, receive_id, receive_id_type="chat_id", **_k):
        pushed.append(f"{receive_id_type}:{receive_id}")
        return True

    monkeypatch.setattr(
        "evoflow.proactive.self_intro.push_employee_self_intro",
        _intro,
    )

    await fb.apply_registration_to_role(
        "ecommerce",
        app_id="cli_ecom",
        app_secret="sec",
        open_id="ou_same",
    )
    assert winner.config.feishu_intro_sent_at == "2026-10-30T10:00:00Z"
    assert winner.config.feishu_intro_sent["open_id:ou_same"] == "2026-10-30T10:00:00Z"
    assert winner.config.feishu_intro_sent["chat_id:oc_private"] == "2026-10-30T10:01:00Z"
    assert pushed == ["open_id:ou_same"]


async def _async_false():
    return False


def test_find_agent_code_for_feishu_app_id(monkeypatch):
    from evoflow.proactive import feishu_binding as fb

    owner = _role("ecommerce", app_id="cli_ecom")
    other = _role("douyin", app_id="cli_other")
    monkeypatch.setattr(
        fb.ProactiveRepository,
        "list_roles",
        staticmethod(lambda: [other, owner]),
    )
    assert fb.find_agent_code_for_feishu_app_id("cli_ecom") == "ecommerce"
    assert fb.find_agent_code_for_feishu_app_id("cli_missing") == ""


def test_channel_service_dedupe_prefers_owner(monkeypatch):
    from app.channels.service import ChannelService

    accounts = [
        ("douyin", {"app_id": "cli_ecom", "app_secret": "s1"}),
        ("ecommerce", {"app_id": "cli_ecom", "app_secret": "s1"}),
        ("other", {"app_id": "cli_other", "app_secret": "s2"}),
    ]
    monkeypatch.setattr(
        "evoflow.proactive.feishu_binding.find_agent_code_for_feishu_app_id",
        lambda app_id: "ecommerce" if app_id == "cli_ecom" else "",
    )
    svc = ChannelService.__new__(ChannelService)
    out = svc._dedupe_accounts_by_bot_id("feishu", accounts)
    codes = [c for c, _ in out]
    assert codes.count("ecommerce") == 1
    assert "douyin" not in codes
    assert "other" in codes
