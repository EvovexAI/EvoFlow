"""「已排队 ≠ 失败」：忙时叫醒入队后，端点必须当成功返回，不能报 409 让人以为丢了。

【self-evolution-bot · 2026-11-17 · 第28轮】
根因实测：我自己发一次 wake 撞上「本会话正在跑」，runner 明明返回
``ok=True / busy=True / queued_behind_busy=True``（目标与 session_key 都记进队列），
HTTP 层却统一 409「请稍候或查看进度」。调用方只能翻代码才知道这次叫醒没丢。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from evoflow.proactive import router as pr

SK = "proactive:self-evolution-bot:chat:2026-11-16T11-40-50.047Z"


def _req() -> SimpleNamespace:
    """绕开 FastAPI 鉴权：_require_role_agent 在测试里直接放行。"""
    return SimpleNamespace()


async def _call_dispatch(result: dict) -> dict:
    req = pr.DispatchTaskRequest(goal="验证装完机回到同一屏", session_key=SK)

    class _Runner:
        async def dispatch_task_fire_and_forget(self, *a, **k):
            return result

    with (
        patch.object(pr, "_require_role_agent", lambda *a, **k: None),
        patch.object(pr, "_get_proactive_runner", lambda: _Runner()),
        patch("evoflow.config.agents_config.load_agent_config", lambda code: object()),
        patch(
            "evoflow.config.agents_config.materialize_builtin_agent_if_missing",
            lambda code: True,
        ),
    ):
        return await pr.dispatch_task(_req(), "self-evolution-bot", req)


@pytest.mark.asyncio
async def test_queued_behind_busy_returns_success_not_409():
    """关键回归：入队回执必须原样返回，不能抛 409。"""
    result = {
        "ok": True,
        "dispatched": False,
        "busy": True,
        "queued_behind_busy": True,
        "queue_depth": 1,
        "agent_code": "self-evolution-bot",
        "goal": "验证装完机回到同一屏",
    }
    out = await _call_dispatch(result)
    assert out.get("queued_behind_busy") is True
    assert out.get("queue_depth") == 1


@pytest.mark.asyncio
async def test_plain_busy_without_queue_still_409():
    """没入队的忙（例如 interrupt 竞态失败）仍然要 409，不能把真失败说成成功。"""
    result = {
        "ok": True,
        "dispatched": False,
        "busy": True,
        "queued_behind_busy": False,
        "agent_code": "self-evolution-bot",
    }
    with pytest.raises(HTTPException) as ei:
        await _call_dispatch(result)
    assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_not_ok_still_400():
    """真失败不能因为改了 busy 分支就漏掉。"""
    with pytest.raises(HTTPException) as ei:
        await _call_dispatch({"ok": False, "error": "boom"})
    assert ei.value.status_code == 400
