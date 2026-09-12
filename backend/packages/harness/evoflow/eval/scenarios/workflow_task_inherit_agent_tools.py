"""Workflow task: step omits tools → worker inherits agent tool whitelist."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_app, expect_task
from evoflow.eval.scenarios._runtime_contract import (
    ensure_agent,
    expect_tools_include,
    find_main_and_subtasks,
    resolve_inherited_worker_tools,
    runtime_contract_metrics,
)

_APP = "eval_wf_inherit_tools"
_CODE = "eval-wf-inherit"
_TOOLS = ["read", "web_search"]


def _app_def() -> dict:
    return {
        "name": "工作流工具继承评测",
        "description": "inherit agent tools",
        "category": "eval",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "parameters": [{"name": "topic", "type": "string", "label": "主题", "default": "inherit"}],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "name": "无 tools 覆盖",
                "assigned_agent": _CODE,
                "agent_code": _CODE,
                "goal": "处理 {{topic}}",
                "instruction": "步骤不声明 tools，应继承智能体工具",
                "depends_on": [],
                # intentionally no "tools" key
            }
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories

    ensure_agent(
        agent_code=_CODE,
        agent_name="工作流工具继承智能体",
        description="inherit tools",
        soul="Inherit tools worker.",
        system_prompt="Use only configured tools.",
        tools=list(_TOOLS),
    )
    app_repositories.save_app(_APP, _app_def())
    result = app_runner.run_app_workflow(_APP, {"topic": "继承"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    _storage, _task, subs = find_main_and_subtasks(task_id)
    st = next((s for s in subs if str(s.get("ref") or "") == "1"), subs[0] if subs else {})
    wp = st.get("worker_profile") if isinstance(st.get("worker_profile"), dict) else {}
    profile_tools = wp.get("tools")
    # When step omits tools, profile should not pin an empty override list that blocks inherit.
    inherited = resolve_inherited_worker_tools(
        agent_code=_CODE,
        profile_tools=list(profile_tools) if isinstance(profile_tools, list) else None,
    )

    assertions = [
        check(
            "step_omits_tools_in_profile_or_empty",
            profile_tools is None or profile_tools == [] or not profile_tools,
            inputs={"worker_profile.tools": profile_tools},
            expected="no step tools override (None/[])",
            actual=profile_tools,
            api="worker_profile",
        ),
        expect_tools_include(_CODE, _TOOLS),
        check(
            "inherited_allowlist_has_agent_tools",
            all(t in inherited for t in _TOOLS) or all(t in set(inherited) for t in _TOOLS),
            inputs={"agent_code": _CODE, "expected": _TOOLS},
            expected=_TOOLS,
            actual=inherited,
            api="resolve_worker_tool_allowlist",
        ),
    ]
    persist = [
        expect_agent(_CODE, agent_name="工作流工具继承智能体"),
        expect_app(_APP, name="工作流工具继承评测"),
    ]
    if task_id:
        persist.extend(expect_task(task_id))

    metrics = runtime_contract_metrics(
        agent_codes=[_CODE],
        task_id=task_id or None,
        extra={"inherited_tools": inherited, "profile_tools": profile_tools},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "create_agent with tools"},
            {"step": 2, "api": "run_app_workflow step without tools"},
            {"step": 3, "api": "resolve_worker_tool_allowlist inherit"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
