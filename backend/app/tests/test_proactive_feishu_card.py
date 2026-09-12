"""Feishu proactive approval card payload + callback field normalization."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

_backend = Path(__file__).resolve().parents[2]
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))
_harness = _backend / "packages" / "harness"
if str(_harness) not in sys.path:
    sys.path.insert(0, str(_harness))


def test_build_wrap_digest_card_shows_items_and_readable_next_duty():
    """Wrap cards must surface work-item titles, not counters alone."""
    from app.channels.feishu import build_wrap_digest_card

    card = build_wrap_digest_card(
        role_name="前端工程师",
        department="技术部",
        agent_code="code-agent",
        think_summary="",
        counts={"pending_approval": 0, "completed": 0, "failed": 0, "executing": 1},
        items=[
            {
                "title": "改登录按钮文案",
                "status": "executing",
                "preview": "把「登录」改成「进入工作台」",
                "is_journal": False,
            },
            {
                "title": "工作日志",
                "status": "completed",
                "is_journal": True,
                "preview": "不应出现在事项列表",
            },
        ],
        next_heartbeat_at="2026-08-15T13:38:34.377047+08:00",
        panel_url="http://127.0.0.1:8001/#/proactive/code-agent",
    )
    body = card["elements"][0]["content"]
    assert "本轮事项" in body
    assert "改登录按钮文案" in body
    assert "执行中" in body
    assert "不应出现在事项列表" not in body
    assert "2026-08-15 13:38" in body
    assert ".377047" not in body
    assert "没有写出文字小结" not in body
    actions = card["elements"][1]["actions"]
    assert any(a.get("url", "").endswith("/#/proactive/code-agent") for a in actions)


def test_build_wrap_digest_card_empty_summary_hint_when_no_items():
    from app.channels.feishu import build_wrap_digest_card

    card = build_wrap_digest_card(
        role_name="前端工程师",
        agent_code="code-agent",
        counts={"pending_approval": 0, "completed": 0, "failed": 0, "executing": 1},
        items=[],
        next_heartbeat_at="",
    )
    body = card["elements"][0]["content"]
    assert "没有写出文字小结" in body
    assert "打开员工页" in body


def test_build_proactive_approval_card_has_action_and_decision():
    from app.channels.feishu import build_proactive_approval_card

    card = build_proactive_approval_card(
        approval_id="appr_1",
        initiative_id="init_1",
        role_name="增长运营",
        department="市场",
        title="优化落地页",
        description="缩短首屏",
        risk_level="high",
        action_type="optimization",
        agent_code="growth-op",
        timeout_minutes=120,
        panel_url="http://127.0.0.1:8001/#/proactive?tab=approvals&highlight=appr_1",
    )
    actions = card["elements"][1]["actions"]
    assert len(actions) == 3
    approve, reject, panel = actions
    assert approve["value"]["action"] == "approved"
    assert approve["value"]["decision"] == "approved"
    assert approve["value"]["initiative_id"] == "init_1"
    assert reject["value"]["action"] == "rejected"
    assert reject["value"]["decision"] == "rejected"
    assert panel["url"].endswith("highlight=appr_1")
    assert "高风险" in card["elements"][0]["content"]
    assert "120 分钟" in card["elements"][0]["content"]
    assert "growth-op" in card["elements"][0]["content"]


def test_build_proactive_approval_card_omits_panel_without_url():
    from app.channels.feishu import build_proactive_approval_card

    card = build_proactive_approval_card(
        approval_id="a",
        initiative_id="i",
        role_name="R",
        department="",
        title="T",
        description="D",
        risk_level="low",
        action_type="analysis",
        panel_url=None,
    )
    actions = card["elements"][1]["actions"]
    assert len(actions) == 2
    assert all("url" not in a for a in actions)


def test_build_proactive_approval_card_handoff_is_lean():
    """Handoff cards: review gist + next who/what; scrub Task ids; no dump."""
    from app.channels.feishu import build_proactive_approval_card

    card = build_proactive_approval_card(
        approval_id="appr_h",
        initiative_id="init_h",
        role_name="技术总监",
        department="研发",
        title="方案交接",
        description="冗长倡议描述不应出现在交接卡",
        risk_level="medium",
        action_type="handoff",
        card_kind="handoff",
        summary="审核通过后改按钮文案。关联 Task_20260725035052_749696 勿展示。",
        rationale="很长的分析依据",
        expected_outcome="很长的预期效果",
        next_handlers=[
            {
                "role": "前端工程师",
                "agent_code": "code-agent",
                "content": "把「新建内容」改成「新建文章」",
            }
        ],
        panel_url="http://127.0.0.1:8001/#/proactive?tab=approvals&highlight=appr_h",
    )
    body = card["elements"][0]["content"]
    assert "转交任务汇报" in card["header"]["title"]["content"]
    assert "同意派发" in card["elements"][1]["actions"][0]["text"]["content"]
    assert "审核内容" in body
    assert "改按钮文案" in body
    assert "下一步" in body
    assert "前端工程师" in body
    assert "新建文章" in body
    assert "Task_20260725035052_749696" not in body
    assert "冗长倡议" not in body
    assert "很长的分析依据" not in body


def test_resolve_proactive_panel_url_prefers_panel_env(monkeypatch: pytest.MonkeyPatch):
    from app.channels.feishu import resolve_proactive_panel_url

    monkeypatch.delenv("EVOFLOW_PANEL_URL", raising=False)
    monkeypatch.delenv("EVOFLOW_WEBUI_PUBLIC_URL", raising=False)
    monkeypatch.delenv("EVOFLOW_GATEWAY_URL", raising=False)
    assert resolve_proactive_panel_url(approval_id="x") is None

    monkeypatch.setenv("EVOFLOW_GATEWAY_URL", "http://gw:8001/")
    monkeypatch.setenv("EVOFLOW_PANEL_URL", "https://panel.example")
    url = resolve_proactive_panel_url(approval_id="appr_9")
    assert url == "https://panel.example/#/proactive?tab=approvals&highlight=appr_9"


def test_build_proactive_decided_card_removes_buttons():
    from app.channels.feishu import build_proactive_decided_card

    card = build_proactive_decided_card(approved=True, title="优化落地页")
    assert card["header"]["template"] == "green"
    assert "已同意" in card["header"]["title"]["content"]
    assert all(el.get("tag") != "action" for el in card["elements"])


def test_feishu_callback_accepts_action_alias():
    """HTTP callback must accept button value.action (not only decision)."""
    from fastapi import HTTPException

    from evoflow.proactive.router import feishu_approval_callback

    async def _run() -> None:
        with patch("evoflow.proactive.router.process_approval", new_callable=AsyncMock) as mock_proc:
            mock_proc.return_value = {"ok": True, "decision": "approved"}
            out = await feishu_approval_callback(
                {
                    "action": {
                        "value": {
                            "initiative_id": "init_42",
                            "action": "approved",
                            "approval_id": "appr_42",
                        }
                    }
                }
            )
            assert out["ok"] is True
            assert mock_proc.await_args.args[0] == "init_42"
            assert mock_proc.await_args.args[1].decision == "approved"
            assert mock_proc.await_args.args[1].decided_by == "feishu"

        with patch("evoflow.proactive.router.process_approval", new_callable=AsyncMock) as mock_proc:
            mock_proc.return_value = {"ok": True, "decision": "rejected"}
            await feishu_approval_callback(
                {"value": {"initiative_id": "init_7", "decision": "rejected"}}
            )
            assert mock_proc.await_args.args[1].decision == "rejected"

        with pytest.raises(HTTPException) as ei:
            await feishu_approval_callback({"value": {"initiative_id": "x"}})
        assert ei.value.status_code == 400

    asyncio.run(_run())


def test_feishu_channel_has_card_action_handler():
    from app.channels.feishu import FeishuChannel
    from app.channels.message_bus import MessageBus

    ch = FeishuChannel(MessageBus(), {})
    assert callable(getattr(ch, "_on_card_action", None))


def test_card_action_response_accepts_plain_dict_toast():
    """Regression: nested CallBackToast objects crash lark-oapi UnmarshalException."""
    from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTriggerResponse

    from app.channels.feishu import build_proactive_decided_card

    card = build_proactive_decided_card(approved=True, title="t")
    resp = P2CardActionTriggerResponse(
        {
            "toast": {"type": "success", "content": "已同意，开始执行"},
            "card": {"type": "raw", "data": card},
        }
    )
    assert resp.toast is not None
    assert resp.toast.content == "已同意，开始执行"
    assert resp.card is not None
    assert resp.card.type == "raw"
