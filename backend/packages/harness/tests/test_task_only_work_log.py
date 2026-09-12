"""Task-only work log: work-board + dispatch guard + brief journal demotion."""

from __future__ import annotations

import asyncio
import gc
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from evoflow.config.app_config import reset_app_config
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.proactive.engine import ProactiveEngine
from evoflow.proactive.models import (
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveRole,
    ProactiveRoleConfig,
)
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db_path = root / "data" / "app" / "evoflow.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("EVOFLOW_HOME", str(root))
        monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
        monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield root
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def _save_role(code: str = "code-agent", name: str = "前端工程师") -> ProactiveRole:
    role = ProactiveRole(
        agent_code=code,
        role_name=name,
        status="active",
        config=ProactiveRoleConfig(),
        created_at=utc_now_iso_z(),
        updated_at=utc_now_iso_z(),
    )
    ProactiveRepository.save_role(role)
    return role


def test_work_board_returns_tasks_empty_initiatives(sqlite_tmp):
    from evoflow.proactive.router import get_role_work_board

    role = _save_role()
    # Legacy journal in DB must not appear on Panel work-board.
    now = utc_now_iso_z()
    ProactiveRepository.save_initiative(
        Initiative(
            id="init_journal_legacy",
            role_agent_code=role.agent_code,
            title="旧交班卡",
            description="should not surface",
            action_type=InitiativeActionType.REPORT,
            risk_level=InitiativeRiskLevel.LOW,
            action_plan={"kind": "round_log", "phase": "wrap_up"},
            status=InitiativeStatus.COMPLETED,
            round_id="round:old",
            created_at=now,
            updated_at=now,
        )
    )

    board_tasks = [
        {
            "task_id": "Task_fe_1",
            "id": "Task_fe_1",
            "name": "优化任务中心文案",
            "status": "completed",
            "assigned_role": role.role_name,
            "round_id": "dispatch:2026-07-20T01:00:00Z",
            "created_at": now,
            "updated_at": now,
        }
    ]

    with (
        patch(
            "evoflow.admin.tasks.list_tasks",
            return_value={"tasks": board_tasks},
        ),
        patch(
            "evoflow.proactive.router._synthesize_round_journals_from_chat",
            return_value=[
                {
                    "id": "chat-round:dispatch:x",
                    "round_id": "dispatch:2026-07-20T01:00:00Z",
                    "action_plan": {"kind": "round_log", "synthetic": True},
                    "created_at": now,
                    "updated_at": now,
                }
            ],
        ),
        patch(
            "evoflow.proactive.router.ProactiveRepository.list_pending_approvals",
            return_value=[],
        ),
    ):
        board = asyncio.run(get_role_work_board(role.agent_code, limit=50))

    assert board["tasks"]
    assert board["tasks"][0]["task_id"] == "Task_fe_1"
    assert board["initiatives"] == []
    assert board["legacy_initiatives"] == []
    assert board["counts"]["legacy"] == 0
    assert board["counts"]["tasks"] >= 1
    # Chat round meta only — not DB journals.
    assert all(
        (r.get("action_plan") or {}).get("synthetic") is True for r in board["rounds"]
    )
    assert not any(r.get("id") == "init_journal_legacy" for r in board["rounds"])


def test_build_work_log_skips_round_log_and_dispatch_guard(sqlite_tmp):
    engine = ProactiveEngine()
    now = utc_now_iso_z()
    journal = Initiative(
        id="j1",
        role_agent_code="r",
        title="交班",
        description="",
        action_type=InitiativeActionType.REPORT,
        risk_level=InitiativeRiskLevel.LOW,
        action_plan={"kind": "round_log"},
        status=InitiativeStatus.COMPLETED,
        created_at=now,
        updated_at=now,
    )
    guard = Initiative(
        id="g1",
        role_agent_code="r",
        title="派发未产出",
        description="",
        action_type=InitiativeActionType.ALERT,
        risk_level=InitiativeRiskLevel.MEDIUM,
        action_plan={"kind": "dispatch_guard"},
        status=InitiativeStatus.FAILED,
        created_at=now,
        updated_at=now,
    )
    approval = Initiative(
        id="a1",
        role_agent_code="r",
        title="待批方案",
        description="",
        action_type=InitiativeActionType.ANALYSIS,
        risk_level=InitiativeRiskLevel.HIGH,
        status=InitiativeStatus.PENDING_APPROVAL,
        created_at=now,
        updated_at=now,
    )
    log = engine._build_work_log([journal, guard, approval])
    assert "交班" not in log
    assert "派发未产出" not in log
    assert "待批方案" in log
    assert "id=`a1`" in log


def test_dispatch_guard_writes_failed_task_not_initiative(sqlite_tmp):
    from evoflow.proactive.runner import ProactiveRunner

    role = _save_role("dispatch-guard-role", "测试岗")
    runner = ProactiveRunner()
    round_id = "dispatch:2026-07-20T12:00:00Z"

    created_calls: list[dict] = []

    def fake_create(role_arg, data, **kwargs):
        created_calls.append({"data": data, "kwargs": kwargs})
        # First call (pre-register) fails; guard call succeeds.
        if len(created_calls) == 1:
            return None
        return {"task_id": "Task_guard_fail"}

    with (
        patch(
            "evoflow.proactive.work_items.create_role_work_item",
            side_effect=fake_create,
        ),
        patch(
            "evoflow.proactive.work_items.list_pending_work_items_for_round",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.work_items.set_work_item_status",
        ) as set_status,
        patch.object(
            runner,
            "_process_role",
            new=AsyncMock(
                return_value={
                    "ok": True,
                    "busy": False,
                    "round_id": round_id,
                    "agent_code": role.agent_code,
                }
            ),
        ),
    ):
        report = asyncio.run(runner.dispatch_task(role.agent_code, "写一份前端方案"))

    assert report.get("dispatch_guard_triggered") is True
    assert report.get("dispatch_guard_task_id") == "Task_guard_fail"
    assert len(created_calls) == 2
    assert created_calls[1]["data"]["action_plan"]["kind"] == "dispatch_guard"
    set_status.assert_called()
    assert set_status.call_args[0][0] == "Task_guard_fail"
    assert set_status.call_args[0][1] == "failed"

    # No initiative journal for the guard.
    inits = ProactiveRepository.list_initiatives(
        role_agent_code=role.agent_code, limit=20
    )
    assert not any(
        str((i.action_plan or {}).get("kind") or "") == "dispatch_guard" for i in inits
    )
