"""Unit tests for WeixinChannel multi-account binding (``account_id``).

Mirrors :mod:`tests.test_wecom_channel_account_id` for the weixin (iLink) channel.
Key contract difference: weixin slots are keyed by the **iLink account_id**
(= ``bot_id``), and many bindings may intentionally carry an empty
``agent_code`` (= route to the channel-wide main agent 主智能体). The employee
code therefore lives on the ``evoflow_bot_bindings`` row and is resolved via
``ChannelManager._weixin_binding_agent_code``.

Invariants locked down here:

Backwards compatibility:
    * Old call sites that pass only ``(bus, config)`` still work; the channel
      resolves its own account from config/env (legacy single-binding behaviour).

Multi-account isolation:
    * Each instance stamps inbound with its own account_id; two instances must
      not share the dedup pool.
    * Outbound subscription slots are per account_id (bus contract, already
      covered in test_channel_outbound_account_routing.py).

Routing:
    * ``_inbound_proactive_agent_code`` resolves the employee from the binding
      row; 主智能体 bindings (empty agent_code) fall through to the channel
      default — the session key must stay ``agent:{main}:weixin:{chat_id}``.
    * Thread-store topic ``acct:<account_id>`` isolates threads per bot (same
      WeChat peer chatting two bots must not share one thread).

No real network access: we exercise ``_process_message`` directly with
synthetic iLink ``getupdates`` message dicts; credentials come from config so
no credential files are read.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.channels.message_bus import InboundMessage, MessageBus
from app.channels.manager import PER_EMPLOYEE_ACCOUNT_CHANNELS, ChannelManager
from app.channels.store import ChannelStore
from app.channels.weixin import WeixinChannel


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_channel(bus: MessageBus, account_id: str = "", **config_extra: Any) -> WeixinChannel:
    """Construct a WeixinChannel that never starts polling and never touches disk.

    Credentials are supplied via config so ``__init__`` does not fall back to
    credential-file loading (which would read the host ``~/.evoflow``).
    """
    config: dict[str, Any] = {
        "token": "test-token",
        "account_id": account_id or "legacy-account",
        **config_extra,
    }
    if account_id:
        config["account_id"] = account_id
    return WeixinChannel(bus=bus, config=config, account_id=account_id)


def _ilink_dm(msgid: str, sender_id: str = "user-A", text: str = "hello") -> dict[str, Any]:
    """Synthetic iLink ``getupdates`` message for a DM (no room_id)."""
    return {
        "message_id": msgid,
        "from_user_id": sender_id,
        "item_list": [{"type": 1, "text_item": {"text": text}}],
    }


@pytest.fixture()
def _isolated_home(monkeypatch, tmp_path):
    """Keep context-token / sync file writes inside a tmp EVOFLOW_HOME."""
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------------------
# Constructor contract
# ---------------------------------------------------------------------------


def test_legacy_two_arg_constructor_still_resolves_account_from_config() -> None:
    """Old call sites that pass only ``(bus, config)`` keep resolving the
    account from config (legacy single-binding behaviour)."""
    channel = WeixinChannel(bus=MessageBus(), config={"token": "t", "account_id": "acct-1"})
    assert channel._account_id == "acct-1"
    assert channel._token == "t"


def test_ctor_account_id_wins_over_config_and_env(monkeypatch) -> None:
    monkeypatch.setenv("WEIXIN_ACCOUNT_ID", "env-account")
    channel = WeixinChannel(
        bus=MessageBus(),
        config={"token": "t", "account_id": "config-account"},
        account_id="bot-A",
    )
    assert channel._account_id == "bot-A"


def test_account_id_is_stripped(_isolated_home) -> None:
    channel = _make_channel(MessageBus(), "   ", token="t")
    # "" after strip → legacy first-wins file resolution ran against the empty
    # isolated home; the strip itself must not produce a padded id.
    assert channel._account_id in ("", )
    channel2 = WeixinChannel(bus=MessageBus(), config={"token": "t", "account_id": "  acct-2  "})
    assert channel2._account_id == "acct-2"


def test_weixin_is_a_per_employee_account_channel() -> None:
    """The single switch that enables weixin account expansion + routing."""
    assert "weixin" in PER_EMPLOYEE_ACCOUNT_CHANNELS


def test_dedicated_account_does_not_load_other_accounts_credential_file(monkeypatch, tmp_path) -> None:
    """With several accounts on disk, a dedicated instance must not pick up
    another account's token via the legacy first-wins fallback."""
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    home = tmp_path / "weixin" / "accounts"
    home.mkdir(parents=True)
    (home / "bot-aaa.json").write_text('{"token": "token-aaa", "base_url": ""}', encoding="utf-8")
    (home / "bot-bbb.json").write_text('{"token": "token-bbb", "base_url": ""}', encoding="utf-8")

    # Positive: a dedicated account loads ITS OWN file (exact filename match).
    channel_own = WeixinChannel(bus=MessageBus(), config={}, account_id="bot-bbb")
    assert channel_own._account_id == "bot-bbb"
    assert channel_own._token == "token-bbb"

    # Missing file → no token, and definitely NOT another account's token via
    # the legacy first-wins fallback.
    channel = WeixinChannel(bus=MessageBus(), config={}, account_id="bot-missing")
    assert channel._account_id == "bot-missing"
    assert channel._token == ""


# ---------------------------------------------------------------------------
# Inbound stamping / dedup isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_inbound_carries_instance_account_id(_isolated_home) -> None:
    bus = MessageBus()
    channel = _make_channel(bus, "a20c5a2a3092@im.bot")

    await channel._process_message(_ilink_dm("m-1", text="ping"))

    msg = await asyncio.wait_for(bus.get_inbound(timeout=2.0), timeout=2.5)
    assert msg.account_id == "a20c5a2a3092@im.bot"
    assert ChannelManager._inbound_account_id(msg) == "a20c5a2a3092@im.bot"
    assert msg.metadata["chat_type"] == "dm"
    assert msg.text == "ping"


@pytest.mark.asyncio
async def test_two_accounts_do_not_share_dedup_pool(_isolated_home) -> None:
    """The same iLink message_id seen by two bot instances must publish twice."""
    bus = MessageBus()
    bot_a = _make_channel(bus, "a20c5a2a3092@im.bot")
    bot_b = _make_channel(bus, "f7d65b3c12a7@im.bot")

    payload = _ilink_dm("shared-msgid")
    await bot_a._process_message(payload)
    await bot_b._process_message(payload)

    a = await asyncio.wait_for(bus.get_inbound(timeout=2.0), timeout=2.5)
    b = await asyncio.wait_for(bus.get_inbound(timeout=2.0), timeout=2.5)
    seen = {a.account_id, b.account_id}
    assert seen == {"a20c5a2a3092@im.bot", "f7d65b3c12a7@im.bot"}


@pytest.mark.asyncio
async def test_account_dedups_its_own_redelivery(_isolated_home) -> None:
    bus = MessageBus()
    channel = _make_channel(bus, "a20c5a2a3092@im.bot")

    payload = _ilink_dm("dup-msgid")
    await channel._process_message(payload)
    await channel._process_message(payload)  # redelivery → dropped

    msg = await asyncio.wait_for(bus.get_inbound(timeout=2.0), timeout=2.5)
    assert msg.account_id == "a20c5a2a3092@im.bot"
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(bus.get_inbound(timeout=0.1), timeout=0.5)


# ---------------------------------------------------------------------------
# Manager routing (weixin slot = iLink account_id, employee via binding row)
# ---------------------------------------------------------------------------


def _weixin_msg(account_id: str, chat_id: str = "user-A@im.wechat") -> InboundMessage:
    return InboundMessage(
        channel_name="weixin",
        chat_id=chat_id,
        user_id=chat_id,
        text="hi",
        account_id=account_id,
        metadata={"account_id": account_id, "chat_type": "dm"},
    )


def _patch_weixin_binding(monkeypatch, binding: dict[str, Any] | None) -> list[tuple[str, str]]:
    calls: list[tuple[str, str]] = []

    def _fake_get_bot_binding(platform: str, bot_id: str):
        calls.append((platform, bot_id))
        if platform == "weixin" and binding and str(binding.get("bot_id")) == str(bot_id):
            return binding
        return None

    def _fake_get_bot_binding_by_agent(platform: str, agent_code: str):
        if platform == "weixin" and binding and str(binding.get("agent_code") or "") == str(agent_code):
            return binding
        return None

    import evoflow.persistence.config_repositories as repo

    monkeypatch.setattr(repo, "get_bot_binding", _fake_get_bot_binding)
    monkeypatch.setattr(repo, "get_bot_binding_by_agent", _fake_get_bot_binding_by_agent)
    # Legacy config fallback: no live service.
    import app.channels.service as svc

    monkeypatch.setattr(svc, "get_channel_service", lambda: None)
    return calls


def test_thread_store_topic_is_account_scoped_for_weixin() -> None:
    """Same WeChat peer + two bots → two distinct thread-store keys."""
    msg_a = _weixin_msg("a20c5a2a3092@im.bot", chat_id="peer-1")
    msg_b = _weixin_msg("f7d65b3c12a7@im.bot", chat_id="peer-1")
    assert ChannelManager._channel_store_topic(msg_a) == "acct:a20c5a2a3092@im.bot"
    assert ChannelManager._channel_store_topic(msg_b) == "acct:f7d65b3c12a7@im.bot"
    assert ChannelManager._channel_store_topic(_weixin_msg("")) is None


def test_proactive_agent_code_resolves_from_binding_row(monkeypatch) -> None:
    binding = {"bot_id": "a20c5a2a3092@im.bot", "agent_code": "sales-emp", "enabled": True}
    _patch_weixin_binding(monkeypatch, binding)

    msg = _weixin_msg("a20c5a2a3092@im.bot")
    assert ChannelManager._inbound_proactive_agent_code(msg) == "sales-emp"
    # feishu/wecom slot ids remain the code itself (unchanged behaviour).
    feishu_msg = InboundMessage(
        channel_name="feishu", chat_id="oc_x", user_id="ou_x", text="hi", account_id="emp-tutor"
    )
    assert ChannelManager._inbound_proactive_agent_code(feishu_msg) == "emp-tutor"


def test_main_agent_binding_falls_through_to_channel_default(monkeypatch) -> None:
    """Empty agent_code = 主智能体 binding: no proactive routing, no proactive
    session key — the message routes to the channel-wide default (lead_agent)."""
    binding = {"bot_id": "a20c5a2a3092@im.bot", "agent_code": "", "enabled": True}
    _patch_weixin_binding(monkeypatch, binding)

    msg = _weixin_msg("a20c5a2a3092@im.bot")
    assert ChannelManager._inbound_proactive_agent_code(msg) == ""
    assert ChannelManager._account_session("weixin", "a20c5a2a3092@im.bot") == {}


def test_account_session_for_employee_binding(monkeypatch) -> None:
    binding = {
        "bot_id": "a20c5a2a3092@im.bot",
        "agent_code": "sales-emp",
        "enabled": True,
        "session_config": {"assistant_id": "sales-emp", "display_name": "销售小助手"},
    }
    _patch_weixin_binding(monkeypatch, binding)

    session = ChannelManager._account_session("weixin", "a20c5a2a3092@im.bot")
    assert session["assistant_id"] == "sales-emp"
    assert session["display_name"] == "销售小助手"


def test_session_key_stays_agent_key_for_main_agent_binding(monkeypatch) -> None:
    """Regression: the weixin slot id (ilink bot id) must never leak into the
    ``proactive:<ilink_id>:chat:…`` session key — 主智能体 bindings keep the
    legacy task-tab key."""
    binding = {"bot_id": "a20c5a2a3092@im.bot", "agent_code": "", "enabled": True}
    _patch_weixin_binding(monkeypatch, binding)

    import app.channels.store as store_mod

    monkeypatch.setattr(store_mod.repo, "load_all_channel_bindings", lambda: {})
    bus = MessageBus()
    manager = ChannelManager(bus, store_mod.ChannelStore())
    key = manager._channel_thread_session_key(_weixin_msg("a20c5a2a3092@im.bot"))
    assert key == "agent:main:weixin:user-A@im.wechat"


def test_session_key_uses_employee_code_for_employee_binding(monkeypatch) -> None:
    binding = {"bot_id": "a20c5a2a3092@im.bot", "agent_code": "sales-emp", "enabled": True}
    _patch_weixin_binding(monkeypatch, binding)

    import app.channels.store as store_mod

    monkeypatch.setattr(store_mod.repo, "load_all_channel_bindings", lambda: {})
    bus = MessageBus()
    manager = ChannelManager(bus, store_mod.ChannelStore())
    key = manager._channel_thread_session_key(_weixin_msg("a20c5a2a3092@im.bot"))
    assert key == "proactive:sales-emp:chat:weixin:user-A@im.wechat"


# ---------------------------------------------------------------------------
# ChannelService helpers (weixin branches)
# ---------------------------------------------------------------------------


def test_service_account_bot_id_secret_weixin_branches() -> None:
    from app.channels.service import ChannelService

    acc = {"bot_id": "a20c5a2a3092@im.bot", "account_id": "a20c5a2a3092@im.bot", "token": "tk"}
    assert ChannelService._account_bot_id("weixin", acc) == "a20c5a2a3092@im.bot"
    assert ChannelService._account_bot_secret("weixin", acc) == "tk"
    # Legacy flat account entry spelling.
    legacy = {"account_id": "f7d65b3c12a7@im.bot", "token": "tk2"}
    assert ChannelService._account_bot_id("weixin", legacy) == "f7d65b3c12a7@im.bot"
    assert ChannelService._account_bot_secret("weixin", legacy) == "tk2"


def test_absorb_weixin_flat_account_upserts_binding_row(monkeypatch) -> None:
    """Flat ``{account_id, token, base_url}`` config → first binding row (主智能体)."""
    from app.channels.service import ChannelService

    upserted: list[dict[str, Any]] = []

    import evoflow.persistence.config_repositories as repo

    monkeypatch.setattr(repo, "get_bot_binding", lambda platform, bot_id: None)

    def _fake_upsert(platform: str, bot_id: str, **kwargs: Any) -> None:
        upserted.append({"platform": platform, "bot_id": bot_id, **kwargs})

    monkeypatch.setattr(repo, "upsert_bot_binding", _fake_upsert)

    svc = ChannelService.__new__(ChannelService)  # skip __init__ (bus/manager wiring)
    svc._absorb_weixin_flat_account(
        {"account_id": "a20c5a2a3092@im.bot", "token": "tk-1", "base_url": "https://redirect.example"}
    )
    assert len(upserted) == 1
    row = upserted[0]
    assert row["platform"] == "weixin"
    assert row["bot_id"] == "a20c5a2a3092@im.bot"
    assert row["agent_code"] == ""
    assert row["bot_secret"] == "tk-1"
    assert row["session_config"] == {"base_url": "https://redirect.example"}
    assert row["enabled"] is True


def test_absorb_weixin_flat_account_is_idempotent(monkeypatch) -> None:
    from app.channels.service import ChannelService

    import evoflow.persistence.config_repositories as repo

    monkeypatch.setattr(
        repo,
        "get_bot_binding",
        lambda platform, bot_id: {"bot_id": bot_id, "agent_code": ""} if platform == "weixin" else None,
    )
    upserted: list[Any] = []
    monkeypatch.setattr(repo, "upsert_bot_binding", lambda *a, **k: upserted.append(1))

    svc = ChannelService.__new__(ChannelService)
    svc._absorb_weixin_flat_account({"account_id": "a20c5a2a3092@im.bot", "token": "tk-1"})
    assert upserted == []


def test_migrate_legacy_accounts_reads_weixin_agent_code_from_entry(monkeypatch) -> None:
    """weixin accounts are keyed by iLink account_id — the employee code rides
    inside the entry (dict keys are NOT agent codes, unlike feishu/wecom)."""
    from app.channels.service import ChannelService

    upserted: list[dict[str, Any]] = []

    import evoflow.persistence.config_repositories as repo

    monkeypatch.setattr(repo, "list_bot_bindings", lambda platform, enabled_only=False: [])
    monkeypatch.setattr(repo, "upsert_bot_binding", lambda platform, bot_id, **kw: upserted.append({"bot_id": bot_id, **kw}))
    # The employee exists → role lookup must succeed (a raise would skip the row).
    from types import SimpleNamespace

    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        staticmethod(lambda code: SimpleNamespace(agent_code=code, role_name=code, config=None, status="active")),
    )

    svc = ChannelService.__new__(ChannelService)
    svc._migrate_legacy_accounts_to_table(
        "weixin",
        {
            "a20c5a2a3092@im.bot": {
                "account_id": "a20c5a2a3092@im.bot",
                "token": "tk",
                "agent_code": "sales-emp",
                "session": {"assistant_id": "sales-emp"},
            },
        },
    )
    assert len(upserted) == 1
    assert upserted[0]["bot_id"] == "a20c5a2a3092@im.bot"
    assert upserted[0]["agent_code"] == "sales-emp"


# ---------------------------------------------------------------------------
# weixin_binding domain helpers
# ---------------------------------------------------------------------------


def _patch_weixin_binding_repo(monkeypatch, rows: list[dict[str, Any]] | None = None):
    """Patch config_repositories with an in-memory weixin bindings table."""
    table: dict[str, dict[str, Any]] = {r["bot_id"]: dict(r) for r in (rows or [])}

    import evoflow.persistence.config_repositories as repo

    monkeypatch.setattr(repo, "get_bot_binding", lambda platform, bot_id: table.get(bot_id))

    def _upsert(platform: str, bot_id: str, **kwargs: Any) -> None:
        assert platform == "weixin"
        table[bot_id] = {"bot_id": bot_id, **kwargs}

    monkeypatch.setattr(repo, "upsert_bot_binding", _upsert)

    def _delete(platform: str, bot_id: str) -> bool:
        return table.pop(bot_id, None) is not None

    monkeypatch.setattr(repo, "delete_bot_binding", _delete)

    def _list(platform: str, enabled_only: bool = True):
        rows_ = [dict(v) for v in table.values()]
        if enabled_only:
            rows_ = [r for r in rows_ if r.get("enabled", True)]
        return rows_

    monkeypatch.setattr(repo, "list_bot_bindings", _list)

    import app.channels.service as svc

    monkeypatch.setattr(svc, "get_channel_service", lambda: None)
    import evoflow.runtime.ports as ports

    monkeypatch.setattr(ports, "get_channel_service", lambda: None)
    return table


def test_sync_binding_main_agent_and_employee(monkeypatch) -> None:
    from evoflow.proactive.weixin_binding import sync_weixin_account_binding, weixin_binding_public

    table = _patch_weixin_binding_repo(monkeypatch)

    pub = sync_weixin_account_binding(
        "a20c5a2a3092@im.bot", token="tk-1", display_name="小号", base_url="https://r.example"
    )
    assert pub["is_main_agent"] is True
    assert pub["display_name"] == "小号"
    assert "tk-1" not in str(pub)  # token never leaks into the public snapshot
    row = table["a20c5a2a3092@im.bot"]
    assert row["agent_code"] == ""
    assert row["session_config"]["display_name"] == "小号"
    assert "assistant_id" not in row["session_config"]

    pub2 = sync_weixin_account_binding("f7d65b3c12a7@im.bot", token="tk-2", agent_code="sales-emp")
    assert pub2["is_main_agent"] is False
    assert table["f7d65b3c12a7@im.bot"]["session_config"]["assistant_id"] == "sales-emp"
    assert weixin_binding_public(table["f7d65b3c12a7@im.bot"])["agent_code"] == "sales-emp"


def test_sync_binding_rejects_second_bot_for_same_employee(monkeypatch) -> None:
    """1 employee ⇄ 1 weixin bot: a second bot cannot claim the same agent_code."""
    from evoflow.proactive.weixin_binding import sync_weixin_account_binding

    _patch_weixin_binding_repo(
        monkeypatch,
        rows=[{"bot_id": "a20c5a2a3092@im.bot", "agent_code": "sales-emp", "bot_secret": "tk", "enabled": True, "session_config": {}}],
    )
    with pytest.raises(ValueError, match="sales-emp"):
        sync_weixin_account_binding("f7d65b3c12a7@im.bot", token="tk-2", agent_code="sales-emp")


def test_update_binding_rebinds_employee(monkeypatch) -> None:
    """PATCH 改绑: empty agent_code re-routes the bot to the main agent."""
    from evoflow.proactive.weixin_binding import update_weixin_account_binding

    table = _patch_weixin_binding_repo(
        monkeypatch,
        rows=[
            {
                "bot_id": "a20c5a2a3092@im.bot",
                "agent_code": "sales-emp",
                "bot_secret": "tk",
                "enabled": True,
                "session_config": {"assistant_id": "sales-emp"},
                "bound_at": "2026-01-01T00:00:00Z",
            }
        ],
    )
    pub = update_weixin_account_binding("a20c5a2a3092@im.bot", agent_code="", display_name="主号")
    assert pub["is_main_agent"] is True
    row = table["a20c5a2a3092@im.bot"]
    assert row["agent_code"] == ""
    assert "assistant_id" not in row["session_config"]
    assert row["session_config"]["display_name"] == "主号"
    assert row["bound_at"] == "2026-01-01T00:00:00Z"  # bound_at preserved on patch


def test_remove_binding(monkeypatch) -> None:
    from evoflow.proactive.weixin_binding import remove_weixin_account_binding

    table = _patch_weixin_binding_repo(
        monkeypatch,
        rows=[{"bot_id": "a20c5a2a3092@im.bot", "agent_code": "", "bot_secret": "tk", "enabled": True, "session_config": {}}],
    )
    assert remove_weixin_account_binding("a20c5a2a3092@im.bot") is True
    assert table == {}
    assert remove_weixin_account_binding("a20c5a2a3092@im.bot") is False
