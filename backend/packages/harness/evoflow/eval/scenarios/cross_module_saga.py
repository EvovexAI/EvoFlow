"""Cross-module saga: 配置 → 雇佣 → 门禁建待办 → 派发 → 工作流 → 任务中心 → 审批.

Deterministic ledger chain (no live LLM / no MCP process / wake_now=False).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import (
    expect_agent,
    expect_agent_mcp,
    expect_agent_skill,
    expect_app,
    expect_app_run,
    expect_approval,
    expect_initiative,
    expect_mcp_server,
    expect_role,
    expect_skill_enabled,
    expect_task,
    expect_user_item,
    expect_vault_setting,
)

_AGENT = "eval-saga"
_MCP = "eval-saga-mcp"
_TOKEN = "EvoFlowSagaUniqueToken77"
_APP_ID = "eval_cross_module_saga"


def _run(home: Path) -> dict:
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import apps as apps_admin
    from evoflow.admin import employees as employees_admin
    from evoflow.admin import items as items_admin
    from evoflow.admin import knowledge as knowledge_admin
    from evoflow.admin import mcp as mcp_admin
    from evoflow.admin import skills as skills_admin
    from evoflow.admin import tasks as tasks_admin
    from evoflow.admin.platform_actions import dispatch_platform_action, reset_registry_cache
    from evoflow.collab.workflow_validator import validate_app_definition
    from evoflow.persistence import app_repositories
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import ApprovalStatus, InitiativeStatus
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.work_items import create_role_work_item, load_work_item_task

    steps: list[dict] = []

    # ── 1. 知识库：vault → remember → recall ──
    created_vault = knowledge_admin.create_managed_vault(name="跨模块Saga知识库")
    vault = created_vault.get("vault") or created_vault
    vault_id = str(
        vault.get("id") or created_vault.get("vault_id") or created_vault.get("id") or ""
    ).strip()
    knowledge_admin.remember(
        {
            "title": "Saga评测笔记",
            "knowledge": f"跨模块链路检索词 {_TOKEN}",
            "content": f"跨模块链路检索词 {_TOKEN}",
        },
        vault_id=vault_id or None,
    )
    recalled = knowledge_admin.recall(
        _TOKEN, vault_id=vault_id or None, mode="fulltext", limit=5
    )
    recall_blob = json.dumps(recalled, ensure_ascii=False, default=str)
    recall_hit = (
        int(recalled.get("total") or 0) >= 1
        or _TOKEN in recall_blob
        or bool(recalled.get("entries") or recalled.get("results") or recalled.get("hits"))
    )
    steps.append({"step": 1, "module": "knowledge", "api": "vault+remember+recall", "vault_id": vault_id})

    # ── 2. MCP：配置面（不 spawn） ──
    mcp_admin.set_mcp_config(
        {
            "mcp_servers": {
                _MCP: {
                    "enabled": True,
                    "type": "stdio",
                    "command": "echo",
                    "args": [],
                    "description": "saga mcp config only",
                }
            }
        }
    )
    mcp_servers = (mcp_admin.get_mcp_config().get("mcp_servers") or {})
    mcp_ok = _MCP in mcp_servers
    steps.append({"step": 2, "module": "mcp", "api": "set_mcp_config", "server": _MCP})

    # ── 3. 技能：挑一条并确保启用 ──
    listed_skills = skills_admin.list_skills(enabled_only=False)
    skills = list(listed_skills.get("skills") or [])
    pick = next(
        (
            s
            for s in skills
            if isinstance(s, dict) and s.get("name") and s.get("category") != "custom"
        ),
        skills[0] if skills else None,
    )
    skill_name = str((pick or {}).get("name") or "").strip()
    if skill_name:
        skills_admin.set_skill_enabled(skill_name, enabled=True)
    steps.append({"step": 3, "module": "skills", "api": "list+enable", "skill": skill_name})

    # ── 4. 智能体：绑 skills + MCP ──
    try:
        agents_admin.create_agent(
            {
                "agent_code": _AGENT,
                "agent_name": "跨模块Saga智能体",
                "description": "cross-module saga",
                "soul": "串联评测链路。",
                "skills": [skill_name] if skill_name else [],
                "mcp_servers": [_MCP],
            }
        )
    except Exception:  # noqa: BLE001
        agents_admin.update_agent(
            _AGENT,
            {
                "skills": [skill_name] if skill_name else [],
                "mcp_servers": [_MCP],
            },
        )
    agent = agents_admin.get_agent(_AGENT)
    agent_skills = list(agent.get("skills") or [])
    agent_mcp = list(agent.get("mcp_servers") or [])
    steps.append(
        {
            "step": 4,
            "module": "agents",
            "api": "create/update_agent",
            "skills": agent_skills,
            "mcp_servers": agent_mcp,
        }
    )

    # ── 5. 员工：雇佣 + 挂知识库 ──
    hired = employees_admin.hire(
        {
            "agent_code": _AGENT,
            "role_name": "Saga值班员",
            "responsibilities": ["跨模块链路"],
            "knowledge_vault_ids": [vault_id] if vault_id else [],
            "autonomy_level": "approval_for_all",
            "approval_channels": ["desktop"],
            "workspace_path": str(home),
        }
    )
    role_vaults = list((hired.get("config") or {}).get("knowledge_vault_ids") or [])
    steps.append(
        {
            "step": 5,
            "module": "agents",
            "api": "employees.hire",
            "knowledge_vault_ids": role_vaults,
        }
    )

    # ── 6. 平台门禁：confirm 预览不落库，确认后建待办 ──
    reset_registry_cache()
    preview = dispatch_platform_action(
        "items.create",
        args_json=json.dumps({"title": "Saga预览不应落库"}, ensure_ascii=False),
        confirm=False,
    )
    listed_preview = dispatch_platform_action("items.list", args_json="{}", confirm=False)
    preview_total = int(listed_preview.get("total") or 0)
    created_item = dispatch_platform_action(
        "items.create",
        args_json=json.dumps(
            {"title": "Saga待办-派发链路", "notes": "cross-module"},
            ensure_ascii=False,
        ),
        confirm=True,
    )
    item = created_item.get("item") or {}
    item_id = str(item.get("id") or "").strip()
    steps.append(
        {
            "step": 6,
            "module": "platform",
            "api": "items.create confirm false→true",
            "item_id": item_id,
            "preview_total": preview_total,
        }
    )

    # ── 7. 待办 → 任务中心（不 wake） ──
    dispatched = items_admin.dispatch_item(item_id, agent_code=_AGENT, wake_now=False)
    dispatch_task_id = str(dispatched.get("task_id") or "").strip()
    item_after = dispatched.get("item") or items_admin.get_item(item_id)["item"]
    linked = list(item_after.get("linked_task_ids") or [])
    task_row = tasks_admin.get_task(dispatch_task_id) if dispatch_task_id else {}
    source_ref = ""
    if isinstance(task_row, dict):
        source_ref = str(
            task_row.get("source_ref")
            or (task_row.get("task") or {}).get("source_ref")
            or ""
        )
    expected_ref = f"item:{item_id}"
    steps.append(
        {
            "step": 7,
            "module": "items",
            "api": "dispatch_item",
            "task_id": dispatch_task_id,
            "source_ref": source_ref,
        }
    )

    # ── 8. 工作流：save → run → task/run ──
    app_def = {
        "name": "跨模块Saga工作流",
        "description": "saga workflow",
        "icon": "🔗",
        "category": "eval",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "parameters": [{"name": "topic", "type": "string", "label": "主题", "default": "saga"}],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "处理",
                "agent_code": _AGENT,
                "goal": "处理 {topic}",
                "instruction": "处理关于 {topic}",
                "depends_on": [],
            }
        ],
    }
    validated = validate_app_definition(app_def)
    valid_ok = bool(
        validated.get("ok")
        if "ok" in validated
        else validated.get("valid")
        if "valid" in validated
        else not (validated.get("errors") or [])
    )
    app_repositories.save_app(_APP_ID, app_def)
    run_result = apps_admin.run_app(_APP_ID, parameters={"topic": "跨模块Saga"})
    run_obj = run_result.get("run") if isinstance(run_result, dict) else {}
    wf_task_id = str(
        (run_obj or {}).get("task_id")
        or (run_obj or {}).get("main_task_id")
        or run_result.get("task_id")
        or ""
    ).strip()
    wf_run_id = str((run_obj or {}).get("run_id") or (run_obj or {}).get("id") or "").strip()
    steps.append(
        {
            "step": 8,
            "module": "workflow",
            "api": "save_app+run_app",
            "task_id": wf_task_id,
            "run_id": wf_run_id,
        }
    )

    # ── 9. 任务中心：两条任务都可观测 ──
    listed_tasks = tasks_admin.list_tasks(include_subtasks=False)
    task_ids = [
        str(t.get("id") or t.get("task_id") or "")
        for t in (listed_tasks.get("tasks") or listed_tasks.get("items") or [])
        if isinstance(t, dict)
    ]
    # get_task fallback if list shape differs
    dispatch_visible = dispatch_task_id in task_ids or bool(
        dispatch_task_id and tasks_admin.get_task(dispatch_task_id)
    )
    wf_visible = wf_task_id in task_ids or bool(wf_task_id and tasks_admin.get_task(wf_task_id))
    steps.append(
        {
            "step": 9,
            "module": "tasks",
            "api": "list_tasks/get_task",
            "dispatch_visible": dispatch_visible,
            "workflow_visible": wf_visible,
        }
    )

    # ── 10. 审批台账：同岗位 work_item → approve ──
    role = ProactiveRepository.get_role(_AGENT)
    appr_ok = False
    appr_id = ""
    appr_task_id = ""
    if role is not None:
        created_wi = create_role_work_item(
            role,
            {
                "title": "Saga审批方案",
                "description": "跨模块 saga 审批",
                "action_type": "analysis",
                "risk_level": "low",
                "rationale": "saga",
            },
            round_id="round:eval-saga",
            goal="跨模块审批",
            source="role",
            raised_by=_AGENT,
        )
        appr_task_id = str(created_wi.get("task_id") or "")
        gate = DecisionGate()
        task = load_work_item_task(appr_task_id)
        appr = asyncio.run(gate.request_approval_for_task(role, task))
        appr_id = str(appr.id)
        updated = asyncio.run(
            gate.process_decision(appr.id, decision="approved", decided_by="user")
        )
        appr2 = ProactiveRepository.get_approval(appr.id)
        bridge = ProactiveRepository.get_initiative(f"task:{appr_task_id}")
        appr_ok = (
            updated is not None
            and updated.status == InitiativeStatus.APPROVED
            and appr2 is not None
            and appr2.status == ApprovalStatus.APPROVED
            and bridge is not None
            and bridge.status == InitiativeStatus.APPROVED
        )
    steps.append(
        {
            "step": 10,
            "module": "tasks",
            "api": "DecisionGate approve",
            "approval_id": appr_id,
            "ok": appr_ok,
        }
    )

    persist = [
        expect_vault_setting(vault_id) if vault_id else None,
        expect_mcp_server(_MCP, enabled=True),
        expect_agent(_AGENT, agent_name="跨模块Saga智能体"),
        expect_agent_mcp(_AGENT, _MCP),
        expect_role(_AGENT, role_name="Saga值班员"),
        expect_user_item(item_id, title="Saga待办-派发链路") if item_id else None,
        expect_app(_APP_ID, name="跨模块Saga工作流"),
    ]
    persist = [p for p in persist if p is not None]
    if skill_name:
        persist.append(expect_skill_enabled(skill_name, True))
        persist.append(expect_agent_skill(_AGENT, skill_name))
    if dispatch_task_id:
        persist.extend(
            expect_task(
                dispatch_task_id,
                assigned_to=_AGENT,
                source_ref=expected_ref,
                user_item_id=item_id,
            )
        )
    if wf_run_id:
        persist.append(expect_app_run(wf_run_id, task_id=wf_task_id or None, app_id=_APP_ID))
    elif wf_task_id:
        persist.append(expect_app_run(task_id=wf_task_id, app_id=_APP_ID))
    if wf_task_id:
        persist.extend(expect_task(wf_task_id))
    if appr_id:
        persist.append(expect_approval(appr_id, status=ApprovalStatus.APPROVED.value))
    if appr_task_id:
        persist.append(
            expect_initiative(f"task:{appr_task_id}", status=InitiativeStatus.APPROVED.value)
        )
        persist.extend(expect_task(appr_task_id))

    # cleanup mcp so isolation leftovers are small (after persist reconcile)
    try:
        mcp_admin.set_mcp_config({"mcp_servers": {}})
    except Exception:  # noqa: BLE001
        pass

    assertions = [
        check(
            "knowledge_recall",
            bool(vault_id) and recall_hit,
            inputs={"vault_id": vault_id, "token": _TOKEN},
            expected="vault + recall hit",
            actual={"vault_id": vault_id, "hit": recall_hit},
            api="knowledge_admin.*",
        ),
        check(
            "mcp_configured",
            mcp_ok,
            inputs={"server": _MCP},
            expected=_MCP,
            actual=list(mcp_servers.keys()),
            api="mcp_admin.set_mcp_config",
        ),
        check(
            "skill_ready",
            bool(skill_name),
            inputs={},
            expected="non-empty skill",
            actual=skill_name,
            api="skills_admin.list_skills",
        ),
        check(
            "agent_bound",
            (not skill_name or skill_name in agent_skills) and _MCP in agent_mcp,
            inputs={"agent_code": _AGENT, "skills": [skill_name], "mcp": [_MCP]},
            expected={"skills": [skill_name] if skill_name else [], "mcp": [_MCP]},
            actual={"skills": agent_skills, "mcp": agent_mcp},
            api="agents_admin.create_agent",
        ),
        check(
            "employee_hired_with_vault",
            hired.get("agent_code") == _AGENT
            and (not vault_id or vault_id in role_vaults),
            inputs={"agent_code": _AGENT, "knowledge_vault_ids": [vault_id]},
            expected={"agent_code": _AGENT, "vault": vault_id},
            actual={"agent_code": hired.get("agent_code"), "vaults": role_vaults},
            api="employees_admin.hire",
        ),
        check(
            "platform_confirm_gate",
            (
                bool(preview.get("pending_confirm"))
                or (preview.get("ok") is True and not preview.get("item"))
            )
            and preview_total == 0
            and bool(item_id),
            inputs={"confirm": "false→true"},
            expected="preview no mutate + confirmed item",
            actual={
                "pending_confirm": preview.get("pending_confirm"),
                "preview_total": preview_total,
                "item_id": item_id,
            },
            api="dispatch_platform_action",
        ),
        check(
            "item_dispatch_link",
            bool(dispatch_task_id)
            and dispatch_task_id in linked
            and (source_ref == expected_ref or expected_ref in source_ref),
            inputs={"item_id": item_id, "agent_code": _AGENT, "wake_now": False},
            expected={"task_id": "non-empty", "source_ref": expected_ref},
            actual={
                "task_id": dispatch_task_id,
                "linked": linked,
                "source_ref": source_ref,
            },
            api="items_admin.dispatch_item",
        ),
        check(
            "workflow_run_task",
            valid_ok and bool(wf_task_id or wf_run_id),
            inputs={"app_id": _APP_ID, "agent_code": _AGENT},
            expected="valid def + task/run",
            actual={"valid": valid_ok, "task_id": wf_task_id, "run_id": wf_run_id},
            api="apps_admin.run_app",
        ),
        check(
            "tasks_hub_sees_both",
            dispatch_visible and wf_visible,
            inputs={"dispatch_task_id": dispatch_task_id, "wf_task_id": wf_task_id},
            expected="both tasks observable",
            actual={
                "dispatch_visible": dispatch_visible,
                "workflow_visible": wf_visible,
                "listed_sample": task_ids[:12],
            },
            api="tasks_admin.list_tasks",
        ),
        check(
            "approval_ledger",
            appr_ok,
            inputs={"agent_code": _AGENT},
            expected="approval + initiative APPROVED",
            actual={"ok": appr_ok, "approval_id": appr_id},
            api="DecisionGate.process_decision",
        ),
    ]
    return finalize(
        assertions + persist,
        metrics={
            "vault_id": vault_id,
            "skill_name": skill_name,
            "agent_code": _AGENT,
            "item_id": item_id,
            "dispatch_task_id": dispatch_task_id,
            "workflow_task_id": wf_task_id,
            "workflow_run_id": wf_run_id,
            "approval_id": appr_id,
            "eval_scope": "ledger_only",
            "wake_now": False,
            "llm": False,
            "not_covered": [
                "feishu_channel_push",
                "worker_llm_execution",
                "mcp_stdio_process_lifecycle",
                "config_yaml_agent_tools",
            ],
        },
        steps=steps,
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
