"""IM channel runs must stamp principal_id like desktop chatSend (Asset Center)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.channels.manager import _enrich_channel_run_context, _stamp_channel_run_identity
from app.channels.message_bus import InboundMessage, InboundMessageType


def test_stamp_channel_run_identity_falls_back_to_local_admin(monkeypatch):
    stamped: list[tuple[str, dict[str, Any]]] = []

    def _fake_enrich(ctx: dict[str, Any] | None) -> dict[str, Any]:
        # Simulate session with no created_by yet.
        return dict(ctx or {})

    def _fake_admin() -> dict[str, Any]:
        return {"principal_id": "admin", "org_id": "local"}

    def _fake_identity(pid: str, *, org_id: str | None = None) -> dict[str, str]:
        out = {"principal_id": pid, "created_by": pid, "owner_scope_id": f"personal:{pid}"}
        if org_id:
            out["org_id"] = org_id
        return out

    def _fake_stamp(sk: str, identity: dict[str, Any] | None) -> bool:
        stamped.append((sk, dict(identity or {})))
        return True

    monkeypatch.setattr(
        "evoflow.authz.runtime_identity.enrich_run_context_identity",
        _fake_enrich,
    )
    monkeypatch.setattr(
        "evoflow.authz.principals.get_or_create_local_admin",
        _fake_admin,
    )
    monkeypatch.setattr(
        "evoflow.authz.runtime_identity.identity_from_principal_id",
        _fake_identity,
    )
    monkeypatch.setattr(
        "evoflow.authz.runtime_identity.stamp_session_from_identity",
        _fake_stamp,
    )

    ctx: dict[str, Any] = {"agent_name": "main", "channel": "weixin"}
    _stamp_channel_run_identity(ctx, "agent:main:weixin:peer@im.wechat")
    assert ctx["principal_id"] == "admin"
    assert ctx["created_by"] == "admin"
    assert ctx["memory_enabled"] is True
    assert stamped and stamped[0][0] == "agent:main:weixin:peer@im.wechat"


def test_stamp_channel_run_identity_keeps_existing_principal(monkeypatch):
    def _fake_enrich(ctx: dict[str, Any] | None) -> dict[str, Any]:
        out = dict(ctx or {})
        out.setdefault("principal_id", "admin")
        out.setdefault("created_by", "admin")
        return out

    called = {"admin": 0}

    def _fake_admin() -> dict[str, Any]:
        called["admin"] += 1
        return {"principal_id": "admin"}

    monkeypatch.setattr(
        "evoflow.authz.runtime_identity.enrich_run_context_identity",
        _fake_enrich,
    )
    monkeypatch.setattr(
        "evoflow.authz.principals.get_or_create_local_admin",
        _fake_admin,
    )

    ctx: dict[str, Any] = {"principal_id": "admin", "created_by": "admin"}
    _stamp_channel_run_identity(ctx, "agent:main:weixin:peer@im.wechat")
    assert ctx["principal_id"] == "admin"
    assert ctx["memory_enabled"] is True
    assert called["admin"] == 0


def test_enrich_channel_run_context_stamps_identity_and_account(monkeypatch):
    monkeypatch.setattr(
        "app.channels.manager._stamp_channel_run_identity",
        lambda run_context, session_key: run_context.update(
            {
                "principal_id": "admin",
                "created_by": "admin",
                "memory_enabled": True,
                "session_key": session_key,
            }
        ),
    )
    msg = InboundMessage(
        channel_name="weixin",
        chat_id="peer@im.wechat",
        user_id="peer@im.wechat",
        text="hi",
        msg_type=InboundMessageType.CHAT,
        account_id="a20c5a2a3092@im.bot",
        metadata={"chat_type": "dm", "account_id": "a20c5a2a3092@im.bot"},
    )
    ctx: dict[str, Any] = {"agent_name": "main"}
    _enrich_channel_run_context(ctx, "agent:main:weixin:peer@im.wechat", msg, "run-1")
    assert ctx["channel"] == "weixin"
    assert ctx["account_id"] == "a20c5a2a3092@im.bot"
    assert ctx["principal_id"] == "admin"
    assert ctx["memory_enabled"] is True
    assert ctx["evf_channel_run_id"] == "run-1"
