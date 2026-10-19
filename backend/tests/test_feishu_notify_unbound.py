"""Unbound employees must not attempt Feishu work-report or approval pushes."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from evoflow.proactive.feishu_notify import (
    _outbound_feishu_target,
    push_wrap_digest_card,
)


def _role(*, channels: list[str], open_id: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        agent_code="code-agent",
        role_name="研发",
        department="",
        config=SimpleNamespace(approval_channels=channels, feishu_open_id=open_id),
    )


def _report() -> dict:
    return {"think_summary": "修了登录页失败重试", "counts": {"failed": 1}}


@pytest.fixture(autouse=True)
def _no_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.proactive.push_binding_repo.RolePushBindingRepository.get_policy",
        lambda _code: None,
    )


def test_historical_default_channels_without_binding_are_not_a_target() -> None:
    role = _role(channels=["desktop", "feishu"])
    assert _outbound_feishu_target(role) is None


def test_explicit_desktop_only_ignores_stale_open_id() -> None:
    role = _role(channels=["desktop"], open_id="ou_stale")
    assert _outbound_feishu_target(role) is None


def test_bound_open_id_resolves_when_feishu_channel_listed() -> None:
    role = _role(channels=["desktop", "feishu"], open_id="ou_bound")
    assert _outbound_feishu_target(role) == ("ou_bound", "open_id")


def test_unbound_wrap_digest_does_not_record_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    logged: list[dict] = []
    monkeypatch.setattr(
        "evoflow.proactive.feishu_notify._log_notify",
        lambda **kwargs: logged.append(kwargs),
    )
    channel = MagicMock()
    monkeypatch.setattr("evoflow.proactive.feishu_notify._feishu_channel", lambda: channel)

    mid = asyncio.run(push_wrap_digest_card(_role(channels=["desktop", "feishu"]), _report()))

    assert mid is None
    assert logged == []
    channel.send_proactive_wrap_card.assert_not_called()


def test_bound_wrap_digest_records_when_channel_down(monkeypatch: pytest.MonkeyPatch) -> None:
    logged: list[dict] = []
    monkeypatch.setattr(
        "evoflow.proactive.feishu_notify._log_notify",
        lambda **kwargs: logged.append(kwargs),
    )
    monkeypatch.setattr("evoflow.proactive.feishu_notify._feishu_channel", lambda: None)

    mid = asyncio.run(
        push_wrap_digest_card(_role(channels=["desktop", "feishu"], open_id="ou_bound"), _report())
    )

    assert mid is None
    assert logged and logged[0]["error"] == "feishu_not_running"
    assert logged[0]["kind"] == "wrap_digest"
