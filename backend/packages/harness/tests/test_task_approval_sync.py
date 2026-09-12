"""Task-native approval must sync the bridge initiative (task:<id>)."""

from __future__ import annotations

import asyncio
import gc
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from evoflow.config.app_config import reset_app_config
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.proactive.decision_gate import DecisionGate
from evoflow.proactive.models import (
    ApprovalStatus,
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveRole,
    ProactiveRoleConfig,
)
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.proactive.work_items import create_role_work_item, load_work_item_task


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    """Isolated app DB — never touch ~/.evoflow live roles.

    ``EVOFLOW_DB_PATH`` (often set by desktop) overrides ``EVOFLOW_HOME``.
    """
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


def test_task_approve_syncs_bridge_initiative(sqlite_tmp):
    code = "test-pm-approve-sync"
    role = ProactiveRole(
        agent_code=code,
        role_name="测试产品经理",
        department="产品",
        status="active",
        config=ProactiveRoleConfig(
            autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_ALL,
            approval_channels=["desktop"],
            workspace_path=str(sqlite_tmp),
        ),
    )
    ProactiveRepository.save_role(role)

    created = create_role_work_item(
        role,
        {
            "title": "文案优化方案",
            "description": "优化任务中心文案",
            "action_type": "analysis",
            "risk_level": "low",
            "rationale": "方案已写到 md，请批准后再派前端",
        },
        round_id="round:test",
        goal="优化文案",
        source="role",
        raised_by=code,
    )
    tid = str(created.get("task_id") or "")
    assert tid

    async def _noop_push(*_a, **_k):
        return None

    with patch(
        "evoflow.proactive.decision_gate.DecisionGate._push_to_channels",
        _noop_push,
    ):
        gate = DecisionGate()
        task = load_work_item_task(tid)
        assert task
        appr = asyncio.run(gate.request_approval_for_task(role, task))
        assert appr.status == ApprovalStatus.PENDING

        bridge = ProactiveRepository.get_initiative(f"task:{tid}")
        assert bridge is not None
        assert bridge.status == InitiativeStatus.PENDING_APPROVAL

        updated = asyncio.run(
            gate.process_decision(appr.id, decision="approved", decided_by="user")
        )
        assert updated is not None
        assert updated.status == InitiativeStatus.APPROVED
        assert updated.approved_by == "user"

        bridge2 = ProactiveRepository.get_initiative(f"task:{tid}")
        assert bridge2 is not None
        assert bridge2.status == InitiativeStatus.APPROVED
        assert bridge2.approved_by == "user"

        appr2 = ProactiveRepository.get_approval(appr.id)
        assert appr2 is not None
        assert appr2.status == ApprovalStatus.APPROVED
