"""agents.create auto-publishes BOT/employee by default (智能体=员工)."""

from __future__ import annotations

import uuid

from evoflow.admin.agents import create_agent, delete_agent, get_agent
from evoflow.admin.employees import hire
from evoflow.admin.errors import ConflictError
from evoflow.proactive.repositories import ProactiveRepository


def test_create_agent_publishes_employee_by_default() -> None:
    code = f"auto-hire-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent(
            {
                "agent_code": code,
                "agent_name": "自动雇佣助手",
                "description": "create → chat ready",
                "soul": "helpful",
                "tools": ["read"],
            }
        )
        assert row.get("as_employee") is True
        assert row.get("role_created") is True
        assert isinstance(row.get("employee"), dict)
        role = ProactiveRepository.get_role(code)
        assert role is not None
        assert role.role_name == "自动雇佣助手"
    finally:
        try:
            delete_agent(code, confirm_cascade=True)
        except Exception:
            pass


def test_create_agent_as_employee_false_skips_role() -> None:
    code = f"cap-only-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent(
            {
                "agent_code": code,
                "agent_name": "仅能力体",
                "as_employee": False,
            }
        )
        assert row.get("as_employee") is False
        assert row.get("role_created") is False
        assert ProactiveRepository.get_role(code) is None
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass


def test_hire_inherits_agent_knowledge_vault_ids_when_omitted(monkeypatch) -> None:
    code = f"hire-kb-{uuid.uuid4().hex[:8]}"
    fake_kb = f"kb_{uuid.uuid4().hex[:12]}"

    def _accept(ids):
        return [str(x).strip() for x in (ids or []) if str(x).strip()]

    monkeypatch.setattr(
        "evoflow.proactive.prompt.validate_agent_knowledge_ids",
        _accept,
    )
    try:
        create_agent(
            {
                "agent_code": code,
                "agent_name": "知识继承",
                "as_employee": False,
                "knowledge_vault_ids": [fake_kb],
            }
        )
        agent = get_agent(code)
        assert fake_kb in list(agent.get("knowledge_vault_ids") or [])

        # Omit knowledge_vault_ids → inherit from agent (not wipe to []).
        detail = hire({"agent_code": code, "role_name": "知识岗"})
        role = ProactiveRepository.get_role(code)
        assert role is not None
        assert fake_kb in list(role.config.knowledge_vault_ids or [])
        applied = (detail.get("bindings_applied") or {}).get("knowledge_vault_ids")
        if applied is not None:
            assert fake_kb in list(applied)
    finally:
        try:
            delete_agent(code, confirm_cascade=True)
        except Exception:
            pass


def test_hire_merges_responsibilities_into_system_prompt() -> None:
    code = f"hire-duty-{uuid.uuid4().hex[:8]}"
    try:
        create_agent(
            {
                "agent_code": code,
                "agent_name": "职责合并",
                "as_employee": False,
                "system_prompt": "你是值班助手。",
            }
        )
        hire(
            {
                "agent_code": code,
                "role_name": "职责合并",
                "responsibilities": ["巡检日志", "汇报异常"],
            }
        )
        agent = get_agent(code)
        sp = str(agent.get("system_prompt") or "")
        assert "岗位职责" in sp
        assert "巡检日志" in sp
        assert "汇报异常" in sp
        role = ProactiveRepository.get_role(code)
        assert role is not None
        assert list(role.config.responsibilities or []) == []
    finally:
        try:
            delete_agent(code, confirm_cascade=True)
        except Exception:
            pass


def test_duplicate_create_then_hire_still_conflicts_when_auto_hired() -> None:
    code = f"dup-auto-{uuid.uuid4().hex[:8]}"
    try:
        create_agent({"agent_code": code, "agent_name": "已在岗", "tools": []})
        raised = False
        try:
            hire({"agent_code": code, "role_name": "二任"})
        except ConflictError:
            raised = True
        assert raised
    finally:
        try:
            delete_agent(code, confirm_cascade=True)
        except Exception:
            pass
