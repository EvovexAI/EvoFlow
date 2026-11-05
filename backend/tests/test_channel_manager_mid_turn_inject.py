"""IM busy-turn mid-turn inject (panel ↑ 加塞) for ChannelManager."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.channels.manager import ChannelManager
from app.channels.message_bus import InboundMessage, InboundMessageType
from evoflow.persistence.pending_inject_repository import (
    clear_pending_inject_store_for_tests,
    list_unconsumed_pending_injects,
)


def _msg(
    *,
    text: str = "改成这样",
    chat_id: str = "oc_test",
    channel: str = "feishu",
    account_id: str = "employee-a",
    message_id: str = "om_1",
    files: list | None = None,
) -> InboundMessage:
    return InboundMessage(
        channel_name=channel,
        chat_id=chat_id,
        user_id="ou_user",
        text=text,
        msg_type=InboundMessageType.CHAT,
        account_id=account_id,
        files=files or [],
        metadata={"message_id": message_id, "account_id": account_id},
    )


@pytest.fixture(autouse=True)
def _clear_injects():
    clear_pending_inject_store_for_tests()
    yield
    clear_pending_inject_store_for_tests()


def _mgr() -> ChannelManager:
    mgr = object.__new__(ChannelManager)
    mgr._chat_locks = {}
    mgr._chat_turn_owners = {}
    mgr._active_im_runs = {}
    mgr.store = SimpleNamespace(get_thread_id=lambda *a, **k: "thread-1")
    mgr._claude_code_chat_mode = {}
    mgr._im_claude_seed_session_id = {}
    return mgr


def test_im_routing_key_includes_account_once():
    msg = _msg()
    key = ChannelManager._im_routing_key(msg)
    assert key.count("acct:employee-a") == 1
    assert ChannelManager._chat_lock_key(msg) == key


def test_try_claim_chat_turn_exclusive():
    async def _run():
        mgr = _mgr()
        key = "feishu:oc_test:acct:employee-a"
        assert mgr._try_claim_chat_turn(key) is True
        # Same task may re-claim.
        assert mgr._try_claim_chat_turn(key) is True

        claimed_other = {"ok": None}

        async def other():
            claimed_other["ok"] = mgr._try_claim_chat_turn(key)

        await asyncio.create_task(other())
        assert claimed_other["ok"] is False
        mgr._release_chat_turn(key)
        await asyncio.create_task(other())
        assert claimed_other["ok"] is True

    asyncio.run(_run())


@pytest.mark.asyncio
async def test_enqueue_im_mid_turn_inject_queues_pending():
    mgr = _mgr()
    msg = _msg(text="不对，改用 B 方案", message_id="om_steer")
    key = ChannelManager._im_routing_key(msg)
    sk = "proactive:employee-a:chat:feishu:oc_test"
    mgr._active_im_runs[key] = {
        "thread_id": "thread-1",
        "session_key": sk,
        "run_id": "run-abc",
        "cancelled": False,
        "preview": "",
    }
    mgr._channel_thread_session_key = lambda m: sk  # type: ignore[method-assign]

    ok = await mgr._enqueue_im_mid_turn_inject(msg)
    assert ok is True
    pending = list_unconsumed_pending_injects(sk)
    assert len(pending) == 1
    assert pending[0]["message_id"] == "om_steer"
    assert "B 方案" in str(pending[0].get("text") or "")


@pytest.mark.asyncio
async def test_enqueue_im_mid_turn_inject_requires_active_run():
    mgr = _mgr()
    msg = _msg()
    mgr._channel_thread_session_key = lambda m: "proactive:x:chat:feishu:oc_test"  # type: ignore[method-assign]
    assert await mgr._enqueue_im_mid_turn_inject(msg) is False


@pytest.mark.asyncio
async def test_handle_message_busy_steers_instead_of_second_turn():
    mgr = _mgr()
    bus = SimpleNamespace(publish_outbound=AsyncMock())
    mgr.bus = bus
    mgr._semaphore = asyncio.Semaphore(8)
    handled_chat = {"n": 0}

    async def fake_chat(msg, extra_context=None):
        handled_chat["n"] += 1
        await asyncio.sleep(0.05)

    mgr._handle_chat = fake_chat  # type: ignore[method-assign]
    mgr._handle_command = AsyncMock()  # type: ignore[method-assign]
    mgr._channel_thread_session_key = (  # type: ignore[method-assign]
        lambda m: "proactive:employee-a:chat:feishu:oc_test"
    )

    msg_a = _msg(text="任务 A", message_id="om_a")
    msg_b = _msg(text="加塞纠正", message_id="om_b")
    key = ChannelManager._im_routing_key(msg_a)
    sk = "proactive:employee-a:chat:feishu:oc_test"

    async def run_a():
        # Simulate active marker while A holds the turn (set by real _handle_chat).
        async def chat_with_active(msg, extra_context=None):
            handled_chat["n"] += 1
            mgr._active_im_runs[key] = {
                "thread_id": "thread-1",
                "session_key": sk,
                "run_id": "run-a",
                "cancelled": False,
                "preview": "",
            }
            try:
                await asyncio.sleep(0.08)
            finally:
                mgr._active_im_runs.pop(key, None)

        mgr._handle_chat = chat_with_active  # type: ignore[method-assign]
        await mgr._handle_message(msg_a)

    task_a = asyncio.create_task(run_a())
    await asyncio.sleep(0.01)
    await mgr._handle_message(msg_b)
    await task_a

    assert handled_chat["n"] == 1
    pending = list_unconsumed_pending_injects(sk)
    assert len(pending) == 1
    assert pending[0]["message_id"] == "om_b"
    bus.publish_outbound.assert_not_awaited()
