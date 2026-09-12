"""Channel push audit log (schema v97 + repository + decision inbound)."""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import asyncio
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_BACKEND = Path(__file__).resolve().parents[3]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from evoflow.persistence.channel_push_repositories import (
    list_by_approval,
    list_recent,
    record_push,
    safe_record_push,
)
from evoflow.persistence.db import get_db, reset_db_for_tests



def test_record_and_list_by_approval(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "push-log.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    reset_db_for_tests()
    get_db()  # ensure schema (incl. v97)

    pid = record_push(
        direction="outbound",
        channel="feishu",
        kind="approval_card",
        event="sent",
        transport="interactive_card",
        approval_id="appr_test1",
        task_id="Task_1",
        role_agent_code="project-architect",
        sender_account_id="xiaomi",
        external_message_id="om_abc",
        title="转交任务汇报",
        content_summary="改按钮文案",
        payload={"card_kind": "handoff"},
        triggered_by="system",
    )
    assert pid.startswith("push_")
    record_push(
        direction="outbound",
        channel="feishu",
        kind="approval_file",
        event="sent",
        transport="file",
        approval_id="appr_test1",
        title="review.md",
        content_summary="docs/roles/x/review.md",
        external_message_id="om_file",
        triggered_by="system",
    )
    items = list_by_approval("appr_test1")
    assert len(items) == 2
    kinds = {i["kind"] for i in items}
    assert kinds == {"approval_card", "approval_file"}
    assert items[0]["approval_id"] == "appr_test1"
    recent = list_recent(limit=10, channel="feishu")
    assert any(r["id"] == pid for r in recent)


def test_safe_record_push_mirrors_to_chat_transcript(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Channel interactions land in chat_messages like normal user/assistant turns."""
    db_path = tmp_path / "push-chat.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    reset_db_for_tests()
    get_db()

    safe_record_push(
        direction="outbound",
        channel="feishu",
        kind="approval_card",
        event="sent",
        transport="interactive_card",
        approval_id="appr_chat1",
        task_id="Task_chat",
        role_agent_code="project-architect",
        receive_id="oc_demo_chat",
        receive_id_type="chat_id",
        sender_account_id="xiaomi",
        external_message_id="om_card_chat",
        title="转交任务汇报",
        content_summary="审核通过后派前端",
        status="ok",
        triggered_by="system",
    )
    safe_record_push(
        direction="inbound",
        channel="feishu",
        kind="approval_decision",
        event="callback",
        transport="interactive_card",
        approval_id="appr_chat1",
        role_agent_code="project-architect",
        external_message_id="om_card_chat",
        title="approved",
        content_summary="feishu card approved",
        payload={"decision": "approved"},
        status="ok",
        triggered_by="user_callback",
    )

    rows = get_db().execute(
        """
        SELECT session_key, role, content_json, tool_name, message_id
        FROM evoflow_chat_messages
        ORDER BY seq ASC
        """
    ).fetchall()
    assert len(rows) >= 2
    sessions = {str(r["session_key"]) for r in rows}
    assert "proactive:project-architect" in sessions
    assert "agent:xiaomi:feishu:oc_demo_chat" in sessions

    def _text(row) -> str:
        import json

        raw = row["content_json"]
        if isinstance(raw, str) and raw.startswith("{"):
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict) and "content" in obj:
                    return str(obj.get("content") or "")
                if isinstance(obj, list):
                    return " ".join(
                        str(b.get("text") or "") for b in obj if isinstance(b, dict)
                    )
            except Exception:
                pass
        return str(raw or "")

    proactive_rows = [r for r in rows if r["session_key"] == "proactive:project-architect"]
    roles = [str(r["role"]) for r in proactive_rows]
    assert "assistant" in roles
    assert "user" in roles
    assistant = next(r for r in proactive_rows if r["role"] == "assistant")
    assert "审批卡" in _text(assistant)
    assert str(assistant["tool_name"] or "").startswith("channel:")
    user = next(r for r in proactive_rows if r["role"] == "user")
    ut = _text(user)
    assert "回执" in ut or "approved" in ut


def test_safe_record_push_swallows_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.record_push",
        MagicMock(side_effect=RuntimeError("boom")),
    )
    assert safe_record_push(direction="outbound", kind="x") is None


def test_process_decision_records_desktop_inbound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import Approval, ApprovalStatus

    db_path = tmp_path / "push-inbound.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    reset_db_for_tests()
    get_db()

    approval = Approval(
        id="appr_desk",
        initiative_id="task:Task_p",
        task_id="Task_p",
        role_agent_code="product-manager",
        channel="desktop",
        status=ApprovalStatus.PENDING,
        created_at="t",
        updated_at="t",
    )
    task = {
        "id": "Task_p",
        "status": "completed",
        "assigned_to": "product-manager",
        "handlers_pending_approval": True,
        "handlers": [{"agent_code": "code-agent", "content": "x"}],
    }
    synthetic = SimpleNamespace(
        id="task:Task_p",
        role_agent_code="product-manager",
        status=None,
        approval_id=None,
        approved_by="",
        approved_at="",
    )

    with (
        patch(
            "evoflow.proactive.decision_gate.ProactiveRepository.get_approval",
            return_value=approval,
        ),
        patch("evoflow.proactive.decision_gate.ProactiveRepository.save_approval"),
        patch(
            "evoflow.proactive.decision_gate.ProactiveRepository.get_initiative",
            return_value=synthetic,
        ),
        patch("evoflow.proactive.decision_gate.ProactiveRepository.save_initiative"),
        patch(
            "evoflow.proactive.work_items.load_work_item_task",
            return_value=task,
        ),
        patch(
            "evoflow.admin.tasks.dispatch_handlers_after_approval",
            return_value=[{"ok": True}],
        ),
        patch(
            "evoflow.admin.tasks.task_has_pending_handoff_approval",
            return_value=True,
        ),
    ):
        asyncio.run(
            DecisionGate().process_decision(
                "appr_desk", decision="approved", decided_by="user"
            )
        )

    items = list_by_approval("appr_desk")
    assert len(items) == 1
    assert items[0]["direction"] == "inbound"
    assert items[0]["channel"] == "desktop"
    assert items[0]["event"] == "callback"
    assert items[0]["payload"]["decision"] == "approved"


def test_push_feishu_records_outbound_card(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import (
        Approval,
        ApprovalStatus,
        Initiative,
        InitiativeActionType,
        InitiativeRiskLevel,
        InitiativeStatus,
        ProactiveRole,
        ProactiveRoleConfig,
    )

    db_path = tmp_path / "push-out.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    reset_db_for_tests()
    get_db()

    role = ProactiveRole(
        agent_code="project-architect",
        role_name="技术总监",
        config=ProactiveRoleConfig(workspace_path=str(tmp_path)),
    )
    initiative = Initiative(
        id="task:Task_h",
        role_agent_code="project-architect",
        title="审核交接",
        description="desc",
        status=InitiativeStatus.PENDING_APPROVAL,
        risk_level=InitiativeRiskLevel.MEDIUM,
        action_type=InitiativeActionType.ANALYSIS,
    )
    approval = Approval(
        id="appr_out",
        initiative_id="task:Task_h",
        task_id="Task_h",
        role_agent_code="project-architect",
        channel="feishu",
        status=ApprovalStatus.PENDING,
        created_at="t",
        updated_at="t",
    )

    channel = MagicMock()
    channel.is_running = True
    channel._chat_account = {}
    channel.send_proactive_approval_card = AsyncMock(return_value="om_card_1")
    channel.send_proactive_approval_output_files = AsyncMock(
        return_value=[
            {
                "ok": True,
                "filename": "review.md",
                "path": "docs/review.md",
                "message_id": "om_file_1",
                "error": "",
            }
        ]
    )
    service = MagicMock()
    service._channels = {"feishu": channel}

    task_row = {
        "id": "Task_h",
        "status": "completed",
        "handlers_pending_approval": True,
        "summary": "审核通过，派前端改文案",
        "handlers": [
            {"role": "前端工程师", "agent_code": "code-agent", "content": "改按钮"}
        ],
        "outputs": [
            {"type": "file", "label": "审核报告", "value": "docs/review.md"},
        ],
    }

    import types

    svc_mod = types.ModuleType("app.channels.service")
    svc_mod.get_channel_service = lambda: service
    chan_mod = types.ModuleType("app.channels")
    chan_mod.service = svc_mod
    # Avoid importing real app.channels (pytest path may shadow backend/app).
    with (
        patch.dict(
            sys.modules,
            {"app.channels": chan_mod, "app.channels.service": svc_mod},
        ),
        patch(
            "evoflow.proactive.feishu_notify.resolve_role_feishu_target",
            return_value=("oc_chat", "chat_id"),
        ),
        patch(
            "evoflow.proactive.work_items.load_work_item_task",
            return_value=task_row,
        ),
        patch(
            "evoflow.admin.tasks.task_summary_of",
            return_value="审核通过，派前端改文案",
        ),
        patch(
            "evoflow.collab.task_handlers.task_handlers_of",
            return_value=task_row["handlers"],
        ),
        patch(
            "evoflow.collab.task_outputs.task_outputs_of",
            return_value=task_row["outputs"],
        ),
        patch(
            "evoflow.collab.task_outputs.shareable_approval_outputs",
            return_value=task_row["outputs"],
        ),
        patch("evoflow.proactive.decision_gate.ProactiveRepository.save_approval"),
    ):
        asyncio.run(
            DecisionGate()._push_feishu(
                role, initiative, approval, triggered_by="manual_repush"
            )
        )

    items = list_by_approval("appr_out")
    kinds = {i["kind"] for i in items}
    assert "approval_card" in kinds
    assert "approval_file" in kinds
    card = next(i for i in items if i["kind"] == "approval_card")
    assert card["event"] == "sent"
    assert card["external_message_id"] == "om_card_1"
    assert card["triggered_by"] == "manual_repush"
    assert card["sender_account_id"] in ("", "xiaomi", "project-architect")
    file_row = next(i for i in items if i["kind"] == "approval_file")
    assert file_row["title"] == "review.md"
    assert file_row["external_message_id"] == "om_file_1"
