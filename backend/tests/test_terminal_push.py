"""P0-2: workflow terminal states must reach the automation's IM channel.

Covers: push retry on transient failures, the automation-binding gate
(no binding / push disabled → no IM spam), and the per-(run,status) dedup of
the fan-out hook at the write-path SSOT.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

import app.gateway.channel_result_push as crp
from evoflow.collab import app_run_events


# ── push_markdown_result retry ──────────────────────────────────────────────


async def test_push_markdown_result_retries_then_succeeds():
    calls = []

    class _Svc:
        async def feishu_push_markdown(self, tid, text, receive_id_type="chat_id"):
            calls.append(tid)
            if len(calls) < 3:
                raise RuntimeError("transient network")
            return None

    with patch.object(crp, "_PUSH_RETRY_DELAYS_S", (0.0, 0.0)), patch(
        "app.channels.service.get_channel_service", return_value=_Svc()
    ):
        ok, msg = await crp.push_markdown_result(
            channel="feishu", target_id="oc_test", title="t", markdown_body="b"
        )
    assert ok is True and msg == "ok"
    assert len(calls) == 3, "must retry twice before succeeding"


async def test_push_markdown_result_gives_up_after_retries():
    calls = []

    class _Svc:
        async def feishu_push_markdown(self, tid, text, receive_id_type="chat_id"):
            calls.append(tid)
            raise RuntimeError("down")

    with patch.object(crp, "_PUSH_RETRY_DELAYS_S", (0.0, 0.0)), patch(
        "app.channels.service.get_channel_service", return_value=_Svc()
    ):
        ok, msg = await crp.push_markdown_result(
            channel="feishu", target_id="oc_test", title="t", markdown_body="b"
        )
    assert ok is False
    assert "down" in msg
    assert len(calls) == 3


# ── automation-binding gate ─────────────────────────────────────────────────


async def test_terminal_push_skips_without_automation_binding():
    pushed = AsyncMock()
    with patch.object(crp, "push_markdown_result", pushed):
        ok, msg = await crp.push_automation_run_terminal({"status": "completed"})
    assert ok is False and msg == "no_automation_binding"
    pushed.assert_not_awaited()


async def test_terminal_push_skips_when_push_disabled():
    pushed = AsyncMock()
    with patch.object(crp, "push_markdown_result", pushed), patch(
        "evoflow.persistence.automation_repositories.load_automation",
        return_value={"id": "auto1", "feishu_push_enabled": False},
    ):
        ok, msg = await crp.push_automation_run_terminal({"status": "completed", "automation_id": "auto1"})
    assert ok is False and msg == "push_disabled"
    pushed.assert_not_awaited()


async def test_terminal_push_sends_summary_when_enabled():
    pushed = AsyncMock(return_value=(True, "ok"))
    with patch.object(crp, "push_markdown_result", pushed), patch(
        "evoflow.persistence.automation_repositories.load_automation",
        return_value={"id": "auto1", "name": "日报", "feishu_push_enabled": True},
    ):
        ok, msg = await crp.push_automation_run_terminal(
            {
                "status": "completed",
                "automation_id": "auto1",
                "automation_name": "日报",
                "source_run_id": "run-9",
                "result_summary": "3 个步骤全部成功",
            }
        )
    assert ok is True
    kwargs = pushed.await_args.kwargs
    assert "成功" in kwargs["title"]
    assert "run-9" in kwargs["markdown_body"]
    assert "3 个步骤全部成功" in kwargs["markdown_body"]


# ── SSOT fan-out hook ───────────────────────────────────────────────────────


async def test_terminal_fan_out_is_deduped_per_run_status(monkeypatch):
    pushed = AsyncMock(return_value=(True, "ok"))
    monkeypatch.setattr("app.gateway.channel_result_push.push_automation_run_terminal", pushed)
    app_run_events._im_push_dedup.clear()

    task = {"id": "mt-x", "source_run_id": "run-dedup", "status": "completed", "automation_id": "auto1"}
    app_run_events._fan_out_terminal_im_push(task, "completed")
    app_run_events._fan_out_terminal_im_push(task, "completed")  # reconciler re-emit

    # let the spawned task run
    import asyncio

    await asyncio.sleep(0.05)
    assert pushed.await_count == 1, "terminal state must reach IM exactly once"
    app_run_events._im_push_dedup.clear()
