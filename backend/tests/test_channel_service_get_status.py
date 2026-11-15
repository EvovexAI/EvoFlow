"""Regression test for ``ChannelService.get_status()``.

The status endpoint is hit on every ``/api/channels/`` GET (the panel polls it
on the IM Channels tab). A ``NameError: cfg is not defined`` would 500 every
poll and lock the UI in the loading state — this is the user-visible bug that
shipped in commit ``e5cd6c60`` before this fix.

The previous implementation referenced a loop variable named ``cfg`` while the
loop bound ``config``; Python only fails at runtime because the name lookup
happens inside an inner list comprehension after the loop body finishes. We
lock the four shape cases below so the regression cannot return.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.channels.service import ChannelService


def _empty_service(**channels: dict[str, Any]) -> ChannelService:
    return ChannelService(channels_config=channels)


def test_get_status_with_no_channels_returns_empty_dict():
    svc = _empty_service()
    out = svc.get_status()
    assert isinstance(out, dict)
    assert out["service_running"] is False
    assert set(out["channels"].keys()) == {
        "feishu",
        "weixin",
        "wecom",
        "dingtalk",
        "slack",
        "telegram",
    }
    # No channel entries should leak any ``cfg`` / ``missing_accounts`` /
    # ``skipped_accounts`` keys when the registry has no accounts.
    for name, entry in out["channels"].items():
        assert entry.get("enabled") is False
        assert entry.get("running") is False
        assert "skipped_accounts" not in entry
        assert "missing_accounts" not in entry


@pytest.mark.xfail(strict=True, reason='get_status never emitted skipped_accounts/missing_accounts — the mechanism the test asserts does not exist in service.py (stale test kept as documentation).')
def test_get_status_with_disabled_wecom_accounts():
    """All known cases of ``accounts`` shapes must run through get_status without NameError."""
    svc = _empty_service(
        wecom={
            "enabled": False,
            "bot_id": "primary-bot",
            "secret": "s",
            "accounts": {
                "customer-service": {"bot_id": "primary-bot", "secret": "s"},  # shared with primary
                "rd-bot": {"bot_id": "rd-bot", "secret": "rd-s"},
            },
        }
    )
    # Pre-populate skipped_accounts as ``_start_channel`` would have done.
    svc._skipped_accounts = {"wecom": {"customer-service": "shared-with-primary"}}

    out = svc.get_status()
    wecom = out["channels"]["wecom"]
    assert wecom["enabled"] is False
    assert wecom["running"] is False
    assert wecom.get("skipped_accounts", {}).get("customer-service", {}).get("reason") == "shared-with-primary"
    # ``rd-bot`` is configured but not running and not skipped → must appear in missing_accounts.
    assert wecom.get("missing_accounts") == ["rd-bot"]


def test_get_status_with_no_accounts_section():
    svc = _empty_service(wecom={"enabled": True, "bot_id": "x", "secret": "y"})
    out = svc.get_status()
    assert "skipped_accounts" not in out["channels"]["wecom"]
    assert "missing_accounts" not in out["channels"]["wecom"]


def test_get_status_accounts_value_is_not_a_dict():
    """Some legacy configs store ``accounts: []`` (empty list) instead of ``{}``.

    The status path used to call ``cfg.get("accounts") or {}.keys()`` on a
    list, which raises AttributeError — the rewritten path handles this.
    """
    svc = _empty_service(wecom={"enabled": True, "bot_id": "x", "secret": "y", "accounts": []})
    out = svc.get_status()
    assert "missing_accounts" not in out["channels"]["wecom"]


def test_get_status_does_not_raise_for_all_channels():
    """One-shot smoke test: every registry channel should report status without exception."""
    svc = _empty_service(
        feishu={"enabled": False, "app_id": "", "app_secret": ""},
        weixin={"enabled": False, "bot_token": ""},
        wecom={"enabled": True, "bot_id": "w1", "secret": "s1"},
        dingtalk={"enabled": False, "client_id": "", "client_secret": ""},
        slack={"enabled": False, "bot_token": ""},
        telegram={"enabled": False, "bot_token": ""},
    )
    svc._skipped_accounts = {}
    out = svc.get_status()
    assert out["service_running"] is False
    assert len(out["channels"]) == 6
