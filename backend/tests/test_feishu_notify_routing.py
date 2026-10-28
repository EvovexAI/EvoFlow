"""Feishu notify: bind-first 1:1 routing (no learned-chat spam)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from evoflow.proactive.feishu_notify import (
    _outbound_feishu_target,
    _send_account_for_target,
    push_collab_tree_receipt,
    resolve_tree_receipt_notify_role,
)


def _role(
    code: str,
    *,
    channels: list[str] | None = None,
    open_id: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(
        agent_code=code,
        role_name=code,
        department="",
        config=SimpleNamespace(
            approval_channels=list(channels) if channels is not None else ["desktop", "feishu"],
            feishu_open_id=open_id,
        ),
    )


@pytest.fixture(autouse=True)
def _no_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.proactive.push_binding_repo.RolePushBindingRepository.get_policy",
        lambda _code: None,
    )


def test_send_account_is_always_the_bound_role() -> None:
    role = _role("dev-backend", open_id="ou_dev")
    assert _send_account_for_target(role, "oc_learned_by_other", "chat_id") == "dev-backend"
    assert _send_account_for_target(role, "ou_dev", "open_id") == "dev-backend"


def test_tree_receipt_prefers_raised_by_binding(monkeypatch: pytest.MonkeyPatch) -> None:
    raised = _role("product-owner", open_id="ou_po")
    assignee = _role("dev-tech-director", open_id="ou_dir")
    main = _role("xiaomi", open_id="ou_xm")

    def _load(code: str):
        return {"product-owner": raised, "dev-tech-director": assignee, "xiaomi": main}.get(code)

    monkeypatch.setattr("evoflow.proactive.feishu_notify._load_role", _load)
    role = resolve_tree_receipt_notify_role(
        raised_by="product-owner",
        assigned_to="dev-tech-director",
    )
    assert role is raised
    assert _outbound_feishu_target(role) == ("ou_po", "open_id")


def test_tree_receipt_skips_user_raiser_then_uses_assignee(monkeypatch: pytest.MonkeyPatch) -> None:
    assignee = _role("dev-tech-director", open_id="ou_dir")
    main = _role("xiaomi", open_id="ou_xm")

    def _load(code: str):
        return {"dev-tech-director": assignee, "xiaomi": main}.get(code)

    monkeypatch.setattr("evoflow.proactive.feishu_notify._load_role", _load)
    role = resolve_tree_receipt_notify_role(raised_by="user", assigned_to="dev-tech-director")
    assert role is assignee


def test_tree_receipt_falls_back_to_xiaomi_when_others_unbound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unbound = _role("dev-tech-director", open_id="")
    main = _role("xiaomi", open_id="ou_xm")

    def _load(code: str):
        return {"dev-tech-director": unbound, "xiaomi": main}.get(code)

    monkeypatch.setattr("evoflow.proactive.feishu_notify._load_role", _load)
    role = resolve_tree_receipt_notify_role(raised_by="user", assigned_to="dev-tech-director")
    assert role is main


def test_tree_receipt_none_when_nobody_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    def _load(code: str):
        return _role(code, open_id="")

    monkeypatch.setattr("evoflow.proactive.feishu_notify._load_role", _load)
    assert resolve_tree_receipt_notify_role(raised_by="user", assigned_to="lead") is None


def test_push_tree_receipt_unbound_skips_without_sending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unbound → no Feishu send; claim finalized as no_target; stamp kept via ext id."""
    records: list[dict] = []

    monkeypatch.setattr(
        "evoflow.proactive.feishu_notify.resolve_tree_receipt_notify_role",
        lambda **_k: None,
    )

    def _finalize(claim_id, **kwargs):
        records.append({"claim_id": claim_id, **kwargs})

    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.finalize_tree_receipt_claim",
        _finalize,
    )
    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.tree_receipt_external_id",
        lambda rid: f"tree_receipt:{rid}",
    )
    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.tree_receipt_outbound_exists",
        lambda *_a, **_k: False,
    )
    channel = MagicMock()
    channel.send_proactive_markdown = AsyncMock()
    monkeypatch.setattr("evoflow.proactive.feishu_notify._feishu_channel", lambda: channel)

    mid = asyncio.run(
        push_collab_tree_receipt(
            root_task_id="root1",
            raised_by="user",
            assigned_to="lead",
            claim_push_id="push_claim",
        )
    )

    assert mid == "tree_receipt:root1"
    assert records and records[0]["error"] == "no_target"
    channel.send_proactive_markdown.assert_not_called()


def test_push_tree_receipt_sends_as_bound_role_bot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = _role("product-owner", open_id="ou_po")
    monkeypatch.setattr(
        "evoflow.proactive.feishu_notify.resolve_tree_receipt_notify_role",
        lambda **_k: role,
    )
    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.tree_receipt_external_id",
        lambda rid: f"tree_receipt:{rid}",
    )
    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.tree_receipt_outbound_exists",
        lambda *_a, **_k: False,
    )
    finalized: list[dict] = []

    def _finalize(claim_id, **kwargs):
        finalized.append({"claim_id": claim_id, **kwargs})

    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.finalize_tree_receipt_claim",
        _finalize,
    )

    channel = MagicMock()
    channel.send_proactive_markdown = AsyncMock(return_value=None)
    monkeypatch.setattr("evoflow.proactive.feishu_notify._feishu_channel", lambda: channel)

    mid = asyncio.run(
        push_collab_tree_receipt(
            root_task_id="root2",
            root_name="demo",
            raised_by="product-owner",
            assigned_to="lead",
            claim_push_id="push_claim2",
        )
    )

    assert mid == "tree_receipt:root2"
    channel.send_proactive_markdown.assert_awaited_once()
    args, kwargs = channel.send_proactive_markdown.await_args
    assert args[0] == "ou_po"
    assert kwargs.get("receive_id_type") == "open_id"
    assert kwargs.get("account_id") == "product-owner"
    assert finalized and finalized[0]["ok"] is True
    assert finalized[0]["sender_account_id"] == "product-owner"
    assert finalized[0]["role_agent_code"] == "product-owner"
    assert finalized[0]["payload"]["reason"] == "collab_tree_all_descendants_terminal"
