"""Employee task: frozen agent prompt/tools + hire → duty brief contract."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role, expect_vault_setting
from evoflow.eval.scenarios._runtime_contract import (
    ensure_agent,
    expect_duty_brief,
    expect_prompt_contains,
    expect_tools_include,
    runtime_contract_metrics,
    snapshot_agent_runtime,
)

_CODE = "eval-emp-runtime"
_PROMPT_TOKEN = "EVAL_EMP_RUNTIME_SYSTEM_PROMPT_v1"
_SOUL_TOKEN = "EVAL_EMP_RUNTIME_SOUL_v1"
_TOOLS = ["read", "web_search"]


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import employees as employees_admin
    from evoflow.admin import knowledge as knowledge_admin

    vault = knowledge_admin.create_managed_vault(name="员工运行时评测库")
    vault_obj = vault.get("vault") or vault
    vault_id = str(vault_obj.get("id") or vault.get("vault_id") or vault.get("id") or "").strip()

    created = ensure_agent(
        agent_code=_CODE,
        agent_name="员工运行时合同智能体",
        description="employee task runtime contract",
        soul=f"Soul marker {_SOUL_TOKEN}",
        system_prompt=f"Workflow guide {_PROMPT_TOKEN}. Always cite vault notes.",
        tools=list(_TOOLS),
        skills=[],
    )
    hired = employees_admin.hire(
        {
            "agent_code": _CODE,
            "role_name": "运行时值班员",
            "responsibilities": ["处理评测工单", "引用知识库"],
            "kpis": ["准时响应"],
            "knowledge_vault_ids": [vault_id] if vault_id else [],
        }
    )
    snap = snapshot_agent_runtime(_CODE)

    assertions = [
        check(
            "agent_created",
            created.get("agent_code") == _CODE,
            inputs={"agent_code": _CODE, "tools": _TOOLS},
            expected=_CODE,
            actual=created.get("agent_code"),
            api="ensure_agent",
        ),
        check(
            "hired",
            hired.get("agent_code") == _CODE,
            inputs={"role_name": "运行时值班员", "vault_id": vault_id},
            expected=_CODE,
            actual=hired.get("agent_code"),
            api="employees_admin.hire",
        ),
        expect_prompt_contains(_CODE, system_prompt_substr=_PROMPT_TOKEN, soul_substr=_SOUL_TOKEN),
        expect_tools_include(_CODE, _TOOLS, forbidden=["bash"]),
        expect_duty_brief(
            _CODE,
            must_contain=["运行时值班员", "处理评测工单", _PROMPT_TOKEN],
        ),
    ]
    persist = [
        expect_agent(_CODE, agent_name="员工运行时合同智能体"),
        expect_role(_CODE, status="active", role_name="运行时值班员"),
    ]
    if vault_id:
        persist.append(expect_vault_setting(vault_id))
        assertions.append(
            expect_duty_brief(_CODE, must_contain=[vault_id], require_marker=True)
        )

    metrics = runtime_contract_metrics(agent_codes=[_CODE], extra={"vault_id": vault_id})
    metrics["tools_expected"] = list(_TOOLS)
    metrics["prompt_tokens"] = {"system": _PROMPT_TOKEN, "soul": _SOUL_TOKEN}
    metrics["snapshot"] = snap

    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "create_managed_vault", "result": {"vault_id": vault_id}},
            {"step": 2, "api": "ensure_agent", "inputs": {"tools": _TOOLS}},
            {"step": 3, "api": "employees_admin.hire"},
            {"step": 4, "api": "build_system_prompt + resolve tools"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
