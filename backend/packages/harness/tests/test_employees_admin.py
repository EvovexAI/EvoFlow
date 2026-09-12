"""Tests for evoflow employees admin + CLI (智能体员工观察台)."""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import gc
import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from evoflow.admin import agents as agents_admin
from evoflow.admin import employees as employees_admin
from evoflow.admin.errors import ConflictError, NotFoundError, ValidationError
from evoflow.cli.main import main
from evoflow.persistence.db import get_db, reset_db_for_tests
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
    from evoflow.config.app_config import reset_app_config

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db_path = root / "data" / "app" / "evoflow.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("EVOFLOW_HOME", str(root))
        # Desktop shells often export this to the live DB; it beats EVOFLOW_HOME.
        monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
        monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield root
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def _ensure_agent(code: str = "code-reviewer") -> None:
    agents_admin.create_agent(
        {
            "agent_code": code,
            "agent_name": f"Agent {code}",
            "description": "test",
            "soul": "Review code.",
            "skills": [],
        }
    )


def _save_role(code: str = "code-agent") -> ProactiveRole:
    role = ProactiveRole(
        agent_code=code,
        role_name="Code Agent",
        department="Engineering",
        config=ProactiveRoleConfig(responsibilities=["patrol"], kpis=["0 errors"]),
        status="active",
    )
    ProactiveRepository.save_role(role)
    return role


def test_employees_hire_update_pause_resume(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _ensure_agent("code-reviewer")
    hired = employees_admin.hire(
        {
            "agent_code": "code-reviewer",
            "role_name": "巡检员",
            "responsibilities": ["巡检 lint"],
            "workspace_path": "D:/example/EvoFlow",
            "kpis": ["0 errors"],
        }
    )
    assert hired["agent_code"] == "code-reviewer"
    assert hired["role_name"] == "巡检员"
    assert hired["config"]["responsibilities"] == ["巡检 lint"]

    with pytest.raises(ConflictError):
        employees_admin.hire({"agent_code": "code-reviewer", "role_name": "dup"})

    updated = employees_admin.update_role(
        "code-reviewer",
        {"role_name": "前端巡检", "max_turns": 15, "kpis": ["ESLint clean"]},
    )
    assert updated["role_name"] == "前端巡检"
    assert updated["config"]["max_turns"] == 15
    assert updated["config"]["kpis"] == ["ESLint clean"]

    got = employees_admin.get_role("code-reviewer")
    assert got["status"] == "active"

    with patch.object(employees_admin, "_try_gateway_put", return_value=None):
        paused = employees_admin.pause_role("code-reviewer")
    assert paused["status"] == "paused"
    assert ProactiveRepository.get_role("code-reviewer").status == "paused"

    resumed = employees_admin.resume_role("code-reviewer")
    assert resumed["status"] == "active"
    assert resumed["from_status"] == "paused"


def test_employees_hire_requires_agent(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="not found"):
        employees_admin.hire({"agent_code": "missing-agent", "role_name": "X"})


def test_cli_employees_hire(capsys, sqlite_tmp: Path, tmp_path: Path) -> None:
    del sqlite_tmp
    _ensure_agent("cli-hire")
    payload = tmp_path / "hire.json"
    payload.write_text(
        json.dumps(
            {
                "agent_code": "cli-hire",
                "role_name": "CLI Hire",
                "responsibilities": ["demo"],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    code = main(["employees", "hire", "--file", str(payload), "--compact"])
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["agent_code"] == "cli-hire"
    assert out["role_name"] == "CLI Hire"


def test_employees_list_and_worklog(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role("code-agent")
    day = "2026-07-18"
    now = f"{day}T10:00:00Z"
    ProactiveRepository.save_initiative(
        Initiative(
            id="init_j1",
            role_agent_code="code-agent",
            title="巡检 ESLint",
            description="【交班汇报】ok",
            action_type=InitiativeActionType.REPORT,
            risk_level=InitiativeRiskLevel.LOW,
            action_plan={"kind": "round_log", "phase": "wrap_up"},
            status=InitiativeStatus.COMPLETED,
            round_id="round_abc",
            goal="核对 ESLint",
            outcome="仍为 0 error",
            created_at=now,
            updated_at=now,
        )
    )
    ProactiveRepository.save_initiative(
        Initiative(
            id="init_a1",
            role_agent_code="code-agent",
            title="补一条注释",
            description="actionable",
            action_type=InitiativeActionType.CODE_CHANGE,
            risk_level=InitiativeRiskLevel.LOW,
            status=InitiativeStatus.PENDING_APPROVAL,
            round_id="round_abc",
            created_at=now,
            updated_at=now,
        )
    )

    with patch.object(employees_admin, "_fetch_gateway_status", return_value=None):
        listed = employees_admin.list_roles()
    assert listed["count"] == 1
    assert listed["roles"][0]["agent_code"] == "code-agent"
    assert listed["gateway_reachable"] is False

    log = employees_admin.worklog("code-agent", day=day)
    assert log["round_count"] == 1
    assert log["rounds"][0]["goal"] == "核对 ESLint"
    assert log["rounds"][0]["verdict"] == "done"
    assert log["rounds"][0]["pending_approval"] == 1
    assert log["task_count"] == 0
    assert log["activity_count"] == 1
    assert log["has_duty_rounds"] is True
    assert log["has_board_tasks"] is False
    assert "hint" in log
    assert "semantics" in log


def test_employees_worklog_tasks_without_rounds_not_empty(sqlite_tmp: Path) -> None:
    """Dispatch-only day: round_count=0 but tasks[] present — not an empty worklog."""
    del sqlite_tmp
    _save_role("code-agent")
    day = "2026-08-15"
    fake_tasks = [
        {
            "task_id": "2608150439_a657",
            "name": "测试 dispatch 幂等性修复v2",
            "status": "completed",
            "progress": 100,
            "source": "role",
            "source_ref": "item:item_x",
            "created_at": f"{day}T12:00:00+08:00",
            "updated_at": f"{day}T13:00:00+08:00",
            "completed_at": f"{day}T13:00:00+08:00",
            "summary": "ok",
        }
    ]
    with patch.object(
        employees_admin,
        "_list_role_tasks_for_beijing_day",
        return_value=fake_tasks,
    ):
        log = employees_admin.worklog("code-agent", day=day)
    assert log["round_count"] == 0
    assert log["rounds"] == []
    assert log["task_count"] == 1
    assert log["tasks"][0]["task_id"] == "2608150439_a657"
    assert log["activity_count"] == 1
    assert log["has_board_tasks"] is True
    assert log["has_duty_rounds"] is False
    assert "task_count" in log["hint"] or "台账任务" in log["hint"]
    assert "不是 bug" in log["semantics"]["note"] or "不是 bug" in str(log["semantics"])


def test_employees_worklog_unknown_role(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(NotFoundError):
        employees_admin.worklog("no-such-role")


def test_employees_worklog_bad_day(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role()
    with pytest.raises(ValidationError):
        employees_admin.worklog("code-agent", day="18/07/2026")
    with pytest.raises(ValidationError, match="valid calendar date"):
        employees_admin.worklog("code-agent", day="2026-13-45")


def test_employees_list_rejects_invalid_status(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role()
    with pytest.raises(ValidationError, match="Invalid role status"):
        employees_admin.list_roles(status="nonexistent_status")


def test_employees_hire_rejects_sensitive_workspace(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _ensure_agent("ws-guard")
    with pytest.raises(ValidationError, match="sensitive"):
        employees_admin.hire(
            {
                "agent_code": "ws-guard",
                "workspace_path": r"C:\Windows\System32\config\SAM",
            }
        )


def test_employees_update_accepts_nested_config(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _ensure_agent("cfg-nest")
    employees_admin.hire({"agent_code": "cfg-nest", "role_name": "Nest"})
    updated = employees_admin.update_role(
        "cfg-nest",
        {"config": {"daily_budget_usd": 12.5, "max_turns": 9}},
    )
    assert updated["config"]["daily_budget_usd"] == 12.5
    assert updated["config"]["max_turns"] == 9


def test_employees_trail_rejects_non_positive_max_steps(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role()
    with pytest.raises(ValidationError, match="max_steps"):
        employees_admin.round_trail("code-agent", max_steps=0)
    with pytest.raises(ValidationError, match="max_steps"):
        employees_admin.round_trail("code-agent", max_steps=-1)


def test_employees_trail_empty(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role()
    trail = employees_admin.round_trail("code-agent", round_id="round_x")
    assert trail["agent_code"] == "code-agent"
    assert trail["tool_step_count"] == 0
    assert trail["message_count"] == 0


def test_employees_dispatch_requires_goal(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role()
    with pytest.raises(ValidationError):
        employees_admin.dispatch("code-agent", "")


def test_employees_dispatch_http(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role()

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.content = b'{"ok":true,"dispatched":true}'
    mock_resp.json.return_value = {
        "ok": True,
        "dispatched": True,
        "agent_code": "code-agent",
        "goal": "查一下 CI",
    }

    with patch("evoflow.admin.employees.httpx.Client") as client_cls:
        client = MagicMock()
        client.__enter__.return_value = client
        client.__exit__.return_value = False
        client.post.return_value = mock_resp
        client_cls.return_value = client
        result = employees_admin.dispatch("code-agent", "查一下 CI")

    assert result["ok"] is True
    assert result["dispatched"] is True
    assert "watch_path" in result


def test_resolve_role_ref_by_name(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role("quality-inspector")
    role = ProactiveRepository.get_role("quality-inspector")
    assert role is not None
    role.role_name = "技术总监"
    ProactiveRepository.save_role(role)
    resolved = employees_admin.resolve_role_ref("技术总监")
    assert resolved.agent_code == "quality-inspector"


def test_employees_wake_passes_round_id(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role("quality-inspector")
    role = ProactiveRepository.get_role("quality-inspector")
    assert role is not None
    role.role_name = "技术总监"
    ProactiveRepository.save_role(role)
    _save_role("product-manager")

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.content = b'{"ok":true,"dispatched":true}'
    mock_resp.json.return_value = {
        "ok": True,
        "dispatched": True,
        "agent_code": "quality-inspector",
        "round_id": "dispatch:keep-me",
        "resumed_round": True,
    }

    with patch("evoflow.admin.employees.httpx.Client") as client_cls:
        client = MagicMock()
        client.__enter__.return_value = client
        client.__exit__.return_value = False
        client.post.return_value = mock_resp
        client_cls.return_value = client
        result = employees_admin.wake(
            "技术总监",
            from_agent="product-manager",
            task_id="Task_abc",
            round_id="dispatch:keep-me",
        )

    assert result["ok"] is True
    assert result.get("round_id") == "dispatch:keep-me"
    posted = client.post.call_args
    body = posted.kwargs.get("json") or posted[1].get("json")
    assert body.get("round_id") == "dispatch:keep-me"
    assert body.get("related_task_id") == "Task_abc"
    assert body.get("resume_round") is True


def test_employees_wake_by_role_name(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role("quality-inspector")
    role = ProactiveRepository.get_role("quality-inspector")
    assert role is not None
    role.role_name = "技术总监"
    ProactiveRepository.save_role(role)
    _save_role("product-manager")

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.content = b'{"ok":true,"dispatched":true}'
    mock_resp.json.return_value = {"ok": True, "dispatched": True, "agent_code": "quality-inspector"}

    with patch("evoflow.admin.employees.httpx.Client") as client_cls:
        client = MagicMock()
        client.__enter__.return_value = client
        client.__exit__.return_value = False
        client.post.return_value = mock_resp
        client_cls.return_value = client
        result = employees_admin.wake(
            "技术总监",
            from_agent="product-manager",
            task_id="Task_abc",
        )

    assert result["ok"] is True
    assert result.get("woken") is True
    assert result.get("from_agent_code") == "product-manager"
    assert result.get("task_id") == "Task_abc"
    # POST body should include auto goal + attribution for DB SSOT
    posted = client.post.call_args
    assert posted is not None
    body = posted.kwargs.get("json") or posted[1].get("json")
    assert "Task_abc" in body["goal"]
    assert body.get("from_agent") == "product-manager"
    assert body.get("related_task_id") == "Task_abc"


def test_org_filter_same_workspace() -> None:
    from evoflow.proactive.org import filter_roster_same_org

    a = ProactiveRole(
        agent_code="a",
        role_name="A",
        config=ProactiveRoleConfig(workspace_path="D:/repo"),
    )
    b = ProactiveRole(
        agent_code="b",
        role_name="B",
        config=ProactiveRoleConfig(workspace_path="D:/repo"),
    )
    c = ProactiveRole(
        agent_code="c",
        role_name="C",
        config=ProactiveRoleConfig(workspace_path="D:/other"),
    )
    peers = filter_roster_same_org(a, [a, b, c])
    codes = {r.agent_code for r in peers}
    assert codes == {"a", "b"}



def test_employees_update_reports_to(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _ensure_agent("product-manager")
    _ensure_agent("fe-dev")
    employees_admin.hire(
        {
            "agent_code": "product-manager",
            "role_name": "产品经理",
            "workspace_path": "D:/example/EvoFlow",
            "responsibilities": ["统筹"],
        }
    )
    employees_admin.hire(
        {
            "agent_code": "fe-dev",
            "role_name": "前端",
            "workspace_path": "D:/example/EvoFlow",
            "responsibilities": ["前端开发"],
        }
    )
    updated = employees_admin.update_role("fe-dev", {"reports_to": "product-manager"})
    assert updated["reports_to"] == "product-manager"
    role = ProactiveRepository.get_role("fe-dev")
    assert role is not None
    assert role.config.reports_to == "product-manager"
    row = get_db().execute(
        "SELECT reports_to FROM evoflow_proactive_roles WHERE agent_code = ?",
        ("fe-dev",),
    ).fetchone()
    assert row[0] == "product-manager"


def test_cli_employees_list(capsys, sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role("cli-emp")
    with patch.object(employees_admin, "_fetch_gateway_status", return_value=None):
        code = main(["employees", "list", "--compact"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert any(r["agent_code"] == "cli-emp" for r in payload["roles"])
    row = next(r for r in payload["roles"] if r["agent_code"] == "cli-emp")
    assert "org_key" in row


def test_cli_employees_worklog(capsys, sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _save_role("cli-emp")
    day = utc_now_iso_z()[:10]
    code = main(["employees", "worklog", "cli-emp", "--day", day, "--compact"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["agent_code"] == "cli-emp"
    assert payload["day"] == day
