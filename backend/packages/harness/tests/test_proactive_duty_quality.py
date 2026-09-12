"""Tests for proactive title near-dup + incomplete auto wrap."""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import sqlite3
from unittest.mock import patch

import pytest

from evoflow.proactive.models import (
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveRole,
    ProactiveRoleConfig,
)
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.proactive.submit_work import apply_proactive_submit_work
from evoflow.proactive.title_similarity import (
    find_near_duplicate_title,
    normalize_proactive_title,
    title_similarity,
)


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


def test_title_similarity_catches_eslint_paraphrases() -> None:
    a = "全量 ESLint 质量扫描：对 evopanel/src/ 下所有 .js 文件运行 ESLint"
    b = "真正落地全量 ESLint 质量扫描：对 evopanel/src/ 下所有 .js 文件运行 ESLint，收集完整 lint 报告"
    c = "前端例行快检：确认 evopanel 前端状态无变化"
    assert title_similarity(a, b) >= 0.72
    assert find_near_duplicate_title(b, [a]) == a
    assert find_near_duplicate_title(c, [a]) is None
    assert "eslint" in normalize_proactive_title(b)


def test_submit_work_ignores_initiatives_for_task_create(monkeypatch) -> None:
    """initiatives[] must not create Tasks; duty raises via evoflow tasks create."""
    code = "near_dup_role"
    role = ProactiveRole(
        agent_code=code,
        role_name="Near Dup",
        config=ProactiveRoleConfig(
            autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_RISKY,
            max_initiatives_per_cycle=3,
        ),
    )
    ProactiveRepository.save_role(role)

    created: list[str] = []

    def _fake_create(role_arg, data, **kwargs):
        tid = f"task_near_{len(created) + 1}"
        created.append(str(data.get("title") or ""))
        return {"task_id": tid, "title": data.get("title"), "needs_approval": False}

    monkeypatch.setattr(
        "evoflow.proactive.work_items.create_role_work_item",
        _fake_create,
    )

    r2 = apply_proactive_submit_work(
        role_agent_code=code,
        round_id="round:near-2",
        goal="真正落地全量 ESLint 质量扫描：对 evopanel/src 运行并收集报告",
        outcome="again",
        reflection="again",
        phase="wrap_up",
        initiatives=[
            {
                "title": "真正落地全量 ESLint 质量扫描：对 evopanel/src 运行并收集报告",
                "description": "scan again",
                "action_type": "analysis",
                "risk_level": "low",
            }
        ],
    )
    assert r2["ok"]
    assert r2.get("created_task_ids") == []
    assert created == []
    assert r2.get("ignored_initiatives_use_cli")
    assert "CLI" in (r2.get("hint") or "") or "evoflow tasks create" in (r2.get("hint") or "")


def test_incomplete_auto_wrap_marks_failed_not_completed() -> None:
    code = "incomplete_wrap_role"
    role = ProactiveRole(
        agent_code=code,
        role_name="Incomplete Wrap",
        config=ProactiveRoleConfig(autonomy_level=ProactiveAutonomyLevel.FULL_AUTO),
    )
    ProactiveRepository.save_role(role)
    rid = "round:incomplete-1"
    apply_proactive_submit_work(
        role_agent_code=code,
        round_id=rid,
        goal="探测 gateway",
        phase="check_in",
        observations=["start"],
    )
    res = apply_proactive_submit_work(
        role_agent_code=code,
        round_id=rid,
        phase="wrap_up",
        goal="值班巡检（自动交班·未完成）",
        outcome="系统补齐",
        reflection="自动交班",
        incomplete=True,
    )
    assert res["ok"]
    assert res["incomplete"] is True
    journals = [
        i
        for i in ProactiveRepository.list_initiatives(role_agent_code=code, limit=10)
        if i.round_id == rid
        and isinstance(i.action_plan, dict)
        and i.action_plan.get("kind") == "round_log"
    ]
    assert len(journals) == 1
    assert journals[0].status == InitiativeStatus.FAILED
    plan = journals[0].action_plan if isinstance(journals[0].action_plan, dict) else {}
    assert plan.get("kind") == "round_log"
    assert plan.get("incomplete") is True
    assert plan.get("phase") == "wrap_up"
