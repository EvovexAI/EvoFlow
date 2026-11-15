"""Tests for ``ChannelService`` per-employee bot start logic.

Step 2 of the wecom-accounts refactor. ``ChannelService._start_channel`` must
expand ``config.accounts`` into one ``ChannelManager`` instance per account —
and **must skip** an account whose bot_id collides with the primary bot or with
another already-running account on the same channel. Duplicating the same
bot_id over WeCom's WS gateway fans messages out twice or drops one socket,
which surfaces as "the same DM goes to either employee OR default agent,
randomly".
"""

from __future__ import annotations

import pytest

from app.channels.service import (
    ChannelService,
    _channel_has_primary_credentials,
    _merge_account_config,
)


@pytest.fixture()
def _isolated_binding_table(monkeypatch):
    """These tests exercise the legacy ``config.accounts`` JSON path; the
    ``evoflow_bot_bindings`` table (which ``_start_channel`` loads first and
    persists migrations into) must contribute nothing and stay read-only."""
    import evoflow.persistence.config_repositories as repo

    monkeypatch.setattr(repo, "list_bot_bindings", lambda platform, enabled_only=False: [])
    written: list[tuple] = []
    monkeypatch.setattr(
        repo,
        "upsert_bot_binding",
        lambda platform, bot_id, **kw: written.append((platform, bot_id)),
    )
    # The 2026-11 zombie-scrub also drops legacy JSON accounts whose roles no
    # longer exist; these tests exercise bot_id collision / credential logic,
    # so let every role "exist".
    monkeypatch.setattr(ChannelService, "_employee_role_exists", staticmethod(lambda code: True))
    return written


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


def _primary_config() -> dict:
    return {
        "enabled": True,
        "bot_id": "primary-bot-id",
        "secret": "primary-secret",
        "websocket_url": "wss://openws.work.weixin.qq.com",
    }


def _account_cfg(name: str, bot_id: str = "", secret: str = "default") -> dict:
    cfg: dict = {"name": name}
    if bot_id:
        cfg["bot_id"] = bot_id
        cfg["secret"] = secret
    return cfg


class _StubChannel:
    """Stand-in for the real WecomChannel — record instances without networking."""

    instances: list = []

    def __init__(self, *, bus=None, config=None, account_id=""):
        self.config = config or {}
        self.bus = bus
        self.account_id = account_id
        self.is_running = False
        type(self).instances.append(self)

    async def start(self):
        self.is_running = True
        return True

    async def stop(self):
        self.is_running = False


# ---------------------------------------------------------------------------
# Credential merging
# ---------------------------------------------------------------------------


def test_merge_account_config_overrides_top_level_creds():
    base = {"bot_id": "p", "secret": "ps", "groups": {"*": {"a": 1}}}
    acc = {"bot_id": "employee-bot", "secret": "employee-secret", "groups": {"*": {"b": 2}}}
    merged = _merge_account_config("wecom", base, acc)
    assert merged["bot_id"] == "employee-bot"
    assert merged["secret"] == "employee-secret"
    # groups keys land in extra (not at top), since groups is not a credential.
    assert merged["groups"] == {"*": {"a": 1}}
    assert merged["extra"]["groups"] == {"*": {"b": 2}}


def test_merge_account_config_only_extra_when_no_creds():
    base = {"bot_id": "p", "secret": "ps"}
    acc = {"groups": {"*": {"foo": 1}}}
    merged = _merge_account_config("wecom", base, acc)
    assert merged["bot_id"] == "p"
    assert merged["secret"] == "ps"
    assert merged["extra"]["groups"] == {"*": {"foo": 1}}


# ---------------------------------------------------------------------------
# Credential presence
# ---------------------------------------------------------------------------


def test_primary_credentials_present():
    assert _channel_has_primary_credentials("wecom", _primary_config())


def test_primary_credentials_missing():
    cfg = _primary_config()
    cfg["bot_id"] = ""
    assert not _channel_has_primary_credentials("wecom", cfg)


# ---------------------------------------------------------------------------
# Per-account start: dedup collisions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_account_sharing_primary_bot_id_is_skipped(_isolated_binding_table):
    """An account whose bot_id equals the primary bot_id must NOT start a second WS."""
    cfg = _primary_config()
    cfg["accounts"] = {
        "customer-service": _account_cfg("客服", bot_id="primary-bot-id"),
        "rd-bot": _account_cfg("研发", bot_id="rd-dedicated"),
    }
    svc = ChannelService({"wecom": cfg})
    svc._channels = {}
    svc._skipped_accounts = {}
    _StubChannel.instances = []

    async def _fake_start(name, channel_cls, config, *, account_id, instance_key):
        _StubChannel(bus=None, config=config, account_id=account_id)
        svc._channels[instance_key] = _StubChannel.instances[-1]
        return True
    svc._start_channel_instance = _fake_start  # type: ignore[assignment]

    await svc._start_channel("wecom", cfg)

    started = sorted(t.account_id for t in _StubChannel.instances)
    assert started == ["", "rd-bot"], (
        f"customer-service must be skipped (shared bot_id), got: {started}"
    )
    # (2026-11) The primary-id collision skip is log-only now; the
    # ``_skipped_accounts`` bookkeeping mechanism no longer exists.


@pytest.mark.asyncio
async def test_two_accounts_with_same_bot_id_second_is_skipped(_isolated_binding_table):
    cfg = _primary_config()
    cfg["accounts"] = {
        "emp-a": _account_cfg("员工A", bot_id="emp-shared"),
        "emp-b": _account_cfg("员工B", bot_id="emp-shared"),
    }
    svc = ChannelService({"wecom": cfg})
    svc._channels = {}
    svc._skipped_accounts = {}
    _StubChannel.instances = []

    async def _fake_start(name, channel_cls, config, *, account_id, instance_key):
        _StubChannel(bus=None, config=config, account_id=account_id)
        svc._channels[instance_key] = _StubChannel.instances[-1]
        return True
    svc._start_channel_instance = _fake_start  # type: ignore[assignment]

    await svc._start_channel("wecom", cfg)

    started = sorted(t.account_id for t in _StubChannel.instances)
    # Primary + only one of the duplicated accounts; the second is skipped.
    assert "" in started
    assert started.count("") == 1
    account_starts = [a for a in started if a]
    assert len(account_starts) == 1
    # (2026-11) Duplicate drops now happen in ``_dedupe_accounts_by_bot_id``
    # before the start loop — only the instance outcome is guaranteed; the
    # ``_skipped_accounts`` bookkeeping mechanism no longer exists.


@pytest.mark.asyncio
async def test_account_with_missing_credentials_is_skipped(_isolated_binding_table):
    cfg = _primary_config()
    cfg["accounts"] = {
        "ready": _account_cfg("ready", bot_id="ready-bot"),
        "ghost": {"name": "ghost"},
    }
    svc = ChannelService({"wecom": cfg})
    svc._channels = {}
    svc._skipped_accounts = {}
    _StubChannel.instances = []

    async def _fake_start(name, channel_cls, config, *, account_id, instance_key):
        _StubChannel(bus=None, config=config, account_id=account_id)
        svc._channels[instance_key] = _StubChannel.instances[-1]
        return True
    svc._start_channel_instance = _fake_start  # type: ignore[assignment]

    await svc._start_channel("wecom", cfg)

    started = sorted(t.account_id for t in _StubChannel.instances)
    assert set(started) == {"", "ready"}
    # (2026-11) The skip is log-only now; the ``_skipped_accounts`` bookkeeping
    # mechanism no longer exists in service.py.


@pytest.mark.asyncio
async def test_no_accounts_starts_single_instance(_isolated_binding_table):
    cfg = _primary_config()
    svc = ChannelService({"wecom": cfg})
    svc._channels = {}
    svc._skipped_accounts = {}
    _StubChannel.instances = []

    async def _fake_start(name, channel_cls, config, *, account_id, instance_key):
        _StubChannel(bus=None, config=config, account_id=account_id)
        svc._channels[instance_key] = _StubChannel.instances[-1]
        return True
    svc._start_channel_instance = _fake_start  # type: ignore[assignment]

    await svc._start_channel("wecom", cfg)

    started = [t.account_id for t in _StubChannel.instances]
    assert started == [""], "no accounts path → only the primary instance"
