"""Tests for task-center noise hide/cleanup + meeting speak board guard."""

from __future__ import annotations

import inspect
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

from evoflow.collab.task_noise import (
    classify_noise_cleanup_reason,
    cleanup_noise_tasks,
    is_duty_patrol_task,
    is_task_center_noise,
)


def test_is_task_center_noise_receipt_and_meeting():
    assert is_task_center_noise(
        {"name": "【下游回执】系统自动通知：你派发/编排的下游已结案。", "source": "role"}
    )
    assert is_task_center_noise(
        {
            "name": "【圆桌会议 · 口头汇报】",
            "raised_by": "meeting_orchestrator",
            "source": "role",
        }
    )
    assert is_task_center_noise(
        {"name": "汇报每个人工作进度", "woken_by": "meeting_orchestrator"}
    )
    assert is_task_center_noise(
        {"name": "进度汇报 · 前端 · 2026-08-14", "source_channel": "status_check"}
    )
    assert not is_task_center_noise(
        {"name": "开发财务报销后端", "source": "role", "raised_by": "pm-lead"}
    )


def test_is_task_center_noise_hides_duty_patrol():
    assert is_task_center_noise(
        {"name": "【巡检】project-architect 2026-08-28 值班", "source": "chat"}
    )
    assert is_task_center_noise(
        {
            "name": "【值班】项目·测试 2026-08-28 巡检",
            "source": "role",
            "source_channel": "proactive_patrol",
        }
    )
    assert not is_task_center_noise(
        {"name": "修复 EvoFlow 标题不生效", "source": "role", "raised_by": "xiaomi"}
    )
    assert not is_task_center_noise(
        {
            "name": "【技术巡检】sqlite-vec 向量检索模块健康度复核",
            "source": "role",
            "raised_by": "project-architect",
        }
    )


def test_classify_duty_patrol_cleanup():
    assert (
        classify_noise_cleanup_reason(
            {"name": "【巡检】代码助手 2026-08-28 值班", "status": "pending"}
        )
        == "duty_patrol"
    )
    assert (
        classify_noise_cleanup_reason(
            {"name": "开发财务报销后端", "status": "pending", "source": "role"}
        )
        is None
    )


def test_classify_eval_and_stuck_moved_to_reclaim():
    assert (
        classify_noise_cleanup_reason(
            {
                "name": "用一句话完成任务并在回答中包含 EVAL_LIVE_WAKE_OK",
                "description": "live_wake eval",
                "status": "executing",
            }
        )
        == "eval_live"
    )
    # Business stuck executing@100 is no longer noise-cancel; reclaim owns it.
    old = (datetime.now(UTC) - timedelta(days=5)).isoformat()
    assert (
        classify_noise_cleanup_reason(
            {
                "name": "业务任务",
                "status": "executing",
                "progress": 100,
                "updated_at": old,
            },
            stuck_days=3,
        )
        is None
    )
    assert (
        classify_noise_cleanup_reason(
            {
                "name": "开发一个轻量级财务报销管理系统后端API",
                "status": "completed",
                "progress": 100,
                "raised_by": "pm-lead",
                "source": "role",
            }
        )
        is None
    )


def test_cleanup_noise_dry_run_lists_only():
    candidates = [
        {
            "id": "t1",
            "name": "【下游回执】系统自动通知：你派发/编排的下游已结案。",
            "status": "completed",
            "source": "role",
            "updated_at": "2026-08-01T00:00:00+00:00",
        }
    ]
    storage = MagicMock()
    storage.list_projects.return_value = [{"id": "p1"}]
    storage.load_project.return_value = {"id": "p1", "tasks": candidates}

    with patch("evoflow.collab.storage.get_project_storage", return_value=storage):
        out = cleanup_noise_tasks(dry_run=True)

    assert out["dry_run"] is True
    assert out["count"] == 1
    assert out["candidates"][0]["task_id"] == "t1"
    assert out["cancelled"] == []


def test_speak_in_meeting_does_not_create_collab_work_item():
    import asyncio

    from evoflow.a2a import adapter as a2a

    src = inspect.getsource(a2a.speak_in_meeting)
    # Strip docstring — it documents the forbidden APIs by name.
    body = src.split('"""', 2)[-1] if '"""' in src else src
    assert "create_role_work_item" not in body
    assert "dispatch_task(" not in body
    assert "get_project_storage" not in body

    role = MagicMock()
    role.role_name = "前端工程师"
    role.agent_code = "fe"
    create_calls: list = []

    with (
        patch("evoflow.a2a.adapter.ProactiveRepository.get_role", return_value=role),
        patch("evoflow.a2a.adapter._create_a2a_task_record"),
        patch("evoflow.a2a.adapter._update_a2a_task_state"),
        patch(
            "evoflow.a2a.adapter._llm_meeting_speak",
            new_callable=AsyncMock,
            return_value="口头内容",
        ),
        patch(
            "evoflow.proactive.work_items.create_role_work_item",
            side_effect=lambda *a, **k: create_calls.append((a, k)) or None,
        ),
    ):
        out = asyncio.run(
            a2a.speak_in_meeting(
                agent_code="fe",
                session_id="meet1",
                message_text="汇报进度",
                meeting_id="m1",
            )
        )

    assert create_calls == []
    assert out.get("reply") == "口头内容"
    assert str((out.get("task") or {}).get("id") or "").startswith("a2a_")
