"""Tests for remaining proactive product polish: timeouts + rejection memory."""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import sqlite3
from unittest.mock import patch

import pytest

from evoflow.proactive.decision_gate import DecisionGate
from evoflow.proactive.models import (
    Approval,
    ApprovalStatus,
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveRole,
    ProactiveRoleConfig,
)
from evoflow.proactive.repositories import ProactiveMemoryRepository, ProactiveRepository
from evoflow.timeutil import utc_now_iso_z


def _heal_get_db_mocks() -> None:
    import sys
    from unittest.mock import MagicMock

    from evoflow.persistence import db as dbmod

    real = dbmod.get_db
    for _name, mod in list(sys.modules.items()):
        if mod is None or not _name.startswith("evoflow."):
            continue
        bound = getattr(mod, "get_db", None)
        if isinstance(bound, MagicMock):
            setattr(mod, "get_db", real)


@pytest.fixture
def db_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_app_schema(conn)
    yield conn
    conn.close()


@pytest.fixture(autouse=True)
def patch_get_db(db_conn):
    import evoflow.persistence.app_repositories  # noqa: F401

    with patch("evoflow.persistence.db.get_db", return_value=db_conn):
        with patch("evoflow.proactive.repositories.get_db", return_value=db_conn):
            yield
    _heal_get_db_mocks()


def test_approval_timeout_prefers_builtin_over_flat_30() -> None:
    gate = DecisionGate()
    role = ProactiveRole(
        agent_code="to",
        role_name="TO",
        config=ProactiveRoleConfig(approval_timeout_minutes=30),
    )
    code = Initiative(
        id="i1",
        role_agent_code="to",
        title="change",
        description="",
        action_type=InitiativeActionType.CODE_CHANGE,
        risk_level=InitiativeRiskLevel.HIGH,
    )
    analysis = Initiative(
        id="i2",
        role_agent_code="to",
        title="scan",
        description="",
        action_type=InitiativeActionType.ANALYSIS,
        risk_level=InitiativeRiskLevel.MEDIUM,
    )
    assert gate._resolve_timeout_minutes(role, code) == 1440
    assert gate._resolve_timeout_minutes(role, analysis) == 120


def test_decision_gate_parse_iso_handles_beijing_and_z() -> None:
    """Regression: check_timeouts called missing ``_parse_iso`` and crashed every tick."""
    from datetime import UTC

    gate = DecisionGate()
    bj = gate._parse_iso("2026-07-18T15:38:32.000000+08:00")
    zulu = gate._parse_iso("2026-07-18T07:38:32.000000Z")
    assert bj is not None and zulu is not None
    assert bj.tzinfo is not None and bj.astimezone(UTC).hour == 7
    assert abs((bj - zulu).total_seconds()) < 1
    assert gate._parse_iso("") is None
    assert gate._parse_iso("not-a-date") is None


def test_rejection_writes_strategy_to_memory() -> None:
    import asyncio

    code = "reject_mem_role"
    role = ProactiveRole(
        agent_code=code,
        role_name="Reject Mem",
        config=ProactiveRoleConfig(autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_ALL),
    )
    ProactiveRepository.save_role(role)
    init = Initiative(
        id=ProactiveRepository.new_initiative_id(),
        role_agent_code=code,
        title="全量 ESLint 扫描",
        description="scan",
        action_type=InitiativeActionType.ANALYSIS,
        risk_level=InitiativeRiskLevel.MEDIUM,
        status=InitiativeStatus.PENDING_APPROVAL,
        created_at=utc_now_iso_z(),
        updated_at=utc_now_iso_z(),
    )
    ProactiveRepository.save_initiative(init)
    appr = Approval(
        id=ProactiveRepository.new_approval_id(),
        initiative_id=init.id,
        role_agent_code=code,
        channel="desktop",
        status=ApprovalStatus.PENDING,
        created_at=utc_now_iso_z(),
        updated_at=utc_now_iso_z(),
    )
    ProactiveRepository.save_approval(appr)
    init.approval_id = appr.id
    ProactiveRepository.save_initiative(init)

    gate = DecisionGate()
    asyncio.run(
        gate.process_decision(
            appr.id,
            decision="rejected",
            decided_by="user",
            rejection_reason="范围过大，应先更新旧事项",
        )
    )
    mem = ProactiveMemoryRepository.get(code)
    assert any("驳回" in s and "ESLint" in s for s in mem.strategies)
    assert any("范围过大" in s for s in mem.strategies)


def test_work_log_marks_timeout_rejected_for_reeval(db_conn) -> None:
    from evoflow.proactive.engine import ProactiveEngine
    from evoflow.proactive.models import InitiativeStatus

    init = Initiative(
        id="init_to_reeval",
        role_agent_code="r1",
        title="落地 ESLint",
        description="全量扫",
        action_type=InitiativeActionType.CODE_CHANGE,
        risk_level=InitiativeRiskLevel.HIGH,
        status=InitiativeStatus.TIMEOUT_REJECTED,
        created_at=utc_now_iso_z(),
        updated_at=utc_now_iso_z(),
    )
    ProactiveRepository.save_initiative(init)
    engine = ProactiveEngine()
    log = engine._build_work_log([init])
    assert "待重新评估" in log
    assert "timeout_rejected" in log or "落地 ESLint" in log
    assert "勿再提同题" not in log  # user-reject wording must not apply to timeout
    assert "round_log" not in log


def test_prompt_mentions_timeout_reeval() -> None:
    """Task-only duty brief: no check_in/wrap_up; timeout reeval is optional."""
    from evoflow.proactive.prompt import build_system_prompt, build_user_prompt
    from evoflow.proactive.models import ProactiveMemory, ProactiveRole

    role = ProactiveRole(agent_code="r", role_name="R")
    sys_p = build_system_prompt(role)
    assert "Task" in sys_p
    assert "proactive_submit_work" not in sys_p
    assert "check_in" not in sys_p
    assert "wrap_up" not in sys_p
    user_p = build_user_prompt(role, ProactiveMemory(role_agent_code="r"), work_log="x")
    assert "本轮行动" in user_p
    assert "check_in" not in user_p
    assert "wrap_up" not in user_p


def test_budget_notify_dedupes_same_day() -> None:
    import asyncio
    from unittest.mock import AsyncMock, patch

    from evoflow.proactive.runner import ProactiveRunner

    role = ProactiveRole(agent_code="budget_r", role_name="Budget")
    runner = ProactiveRunner()

    async def _run() -> None:
        with patch("evoflow.collab.ws_notify.broadcast_to_channels", new_callable=AsyncMock) as desk:
            # Feishu push may no-op outside gateway; dedupe is what we assert.
            await runner._notify_budget_exceeded(role, spent_today=1.0, budget_usd=0.5)
            await runner._notify_budget_exceeded(role, spent_today=1.2, budget_usd=0.5)
            assert desk.await_count == 1

    asyncio.run(_run())
