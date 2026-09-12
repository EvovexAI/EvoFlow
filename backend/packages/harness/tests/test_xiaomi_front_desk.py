"""Xiaomi (小V) front-desk identity / prompt / tool policy."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.agents.xiaomi.identity import XIAOMI_AGENT_CODE, is_xiaomi_agent
from evoflow.agents.xiaomi.prompt import policy_block, role_block
from evoflow.agents.xiaomi.tool_policy import XIAOMI_SYSTEM_TOOL_NAMES, filter_xiaomi_tools
from evoflow.agents.xiaomi.tools import get_xiaomi_tools
from evoflow.agents.lead_agent.prompt import apply_prompt_template


def test_is_xiaomi_agent() -> None:
    assert is_xiaomi_agent("xiaomi")
    assert is_xiaomi_agent("小V")
    assert not is_xiaomi_agent("main")
    assert not is_xiaomi_agent(None)
    assert XIAOMI_AGENT_CODE == "xiaomi"


def test_xiaomi_tools_are_action_loop_only() -> None:
    names = {getattr(t, "name", "") for t in get_xiaomi_tools()}
    assert names == XIAOMI_SYSTEM_TOOL_NAMES
    assert "ask_clarification" not in names
    assert "xiaomi_wake" in names
    assert "xiaomi_knowledge_search" in names
    assert "platform" in names
    assert "xiaomi_platform" not in names
    # 行政只加一个通用工具名，不按域膨胀
    assert not any(n.endswith("_admin") for n in names)


def test_xiaomi_role_prompt_is_action_first() -> None:
    role = role_block(prompt_language="zh")
    assert "xiaomi_org_status" in role
    assert "xiaomi_board_overview" in role
    assert "xiaomi_wake" in role
    assert "xiaomi_knowledge_search" in role
    assert "platform" in role
    assert "询问" in role or "澄清" in role  # 禁止询问
    assert "语音" in role or "口语" in role
    assert "Markdown" in role or "markdown" in role.lower()
    pol = policy_block(prompt_language="zh")
    assert "ask_clarification" not in pol
    assert "xiaomi_wake" in pol
    assert "xiaomi_knowledge_search" in pol
    assert "platform" in pol
    assert "Markdown" in pol or "口语" in pol


def test_filter_xiaomi_tools_only_system_tools() -> None:
    tools = [
        SimpleNamespace(name="ask_clarification"),
        SimpleNamespace(name="read"),
        SimpleNamespace(name="web_search"),
        SimpleNamespace(name="terminal"),
        SimpleNamespace(name="knowledge_search"),
        SimpleNamespace(name="xiaomi_org_status"),
        SimpleNamespace(name="xiaomi_board_overview"),
        SimpleNamespace(name="xiaomi_employee_brief"),
        SimpleNamespace(name="xiaomi_task_brief"),
        SimpleNamespace(name="xiaomi_dispatch"),
        SimpleNamespace(name="xiaomi_wake"),
        SimpleNamespace(name="xiaomi_knowledge_search"),
        SimpleNamespace(name="platform"),
    ]
    out = filter_xiaomi_tools(tools, session_mode="agent")
    names = {t.name for t in out}
    assert names == XIAOMI_SYSTEM_TOOL_NAMES
    assert "ask_clarification" not in names
    assert "knowledge_search" not in names


def test_xiaomi_employee_and_task_brief_tools_registered() -> None:
    names = {getattr(t, "name", "") for t in get_xiaomi_tools()}
    assert "xiaomi_employee_brief" in names
    assert "xiaomi_task_brief" in names
    assert "platform" in names
    assert names == XIAOMI_SYSTEM_TOOL_NAMES


def test_xiaomi_employee_brief_unknown_and_self() -> None:
    import json

    from evoflow.agents.xiaomi.tools import xiaomi_employee_brief_tool

    self_raw = xiaomi_employee_brief_tool.invoke({"agent_code": "xiaomi"})
    self_data = json.loads(self_raw)
    assert self_data.get("ok") is False

    miss_raw = xiaomi_employee_brief_tool.invoke({"agent_code": "no-such-employee-xyz"})
    miss_data = json.loads(miss_raw)
    assert miss_data.get("ok") is False


def test_xiaomi_task_brief_rejects_round_id() -> None:
    import json

    from evoflow.agents.xiaomi.tools import xiaomi_task_brief_tool

    raw = xiaomi_task_brief_tool.invoke({"task_id": "round:abc"})
    data = json.loads(raw)
    assert data.get("ok") is False
    assert "round" in str(data.get("error") or "").lower() or "Task" in str(data.get("error") or "")


def test_condense_work_trail() -> None:
    from evoflow.agents.xiaomi.tools import _condense_work_trail

    out = _condense_work_trail(
        [
            {"role": "tool", "tool_name": "read"},
            {"role": "tool", "tool_name": "write"},
            {"role": "assistant", "content_json": {"content": "已改完登录页"}},
        ]
    )
    assert out["tool_sequence"] == ["read", "write"]
    assert "登录页" in out["last_assistant_text"]


def test_format_page_context_block_zh() -> None:
    from evoflow.agents.xiaomi.prompt import format_page_context_block

    block = format_page_context_block(
        {
            "module": "employees",
            "label": "员工 · coder",
            "route": "/proactive/coder",
            "contextType": "agent",
            "contextId": "coder",
            "ui": {
                "pageTitle": "智能体员工",
                "activeTabs": ["组织"],
                "selected": [{"id": "coder", "label": "代码助手"}],
            },
            "recentActivity": [
                {"type": "route", "label": "智能体员工", "module": "employees"},
                {"type": "select_employee", "label": "代码助手", "entityId": "coder"},
            ],
        },
        prompt_language="zh",
    )
    assert "<xiaomi_ui_context>" in block
    assert "模块=智能体员工(employees)" in block
    assert "代码助手" in block
    assert "路过页面" in block
    assert "select_employee:代码助手" in block
    # 当前屏 route 不应再写成「路过」
    assert "route:智能体员工" not in block
    assert "用户当前界面" in block


def test_format_page_context_skips_current_route_activity() -> None:
    from evoflow.agents.xiaomi.prompt import format_page_context_block

    block = format_page_context_block(
        {
            "module": "chat",
            "label": "主对话",
            "route": "/chat",
            "recentActivity": [
                {"type": "route", "label": "主对话", "module": "chat"},
            ],
        },
        prompt_language="zh",
    )
    assert "用户当前界面" in block
    assert "路过页面" not in block


def test_format_page_context_block_workflow_not_tasks() -> None:
    from evoflow.agents.xiaomi.prompt import format_page_context_block

    block = format_page_context_block(
        {
            "module": "workflow",
            "label": "工作流",
            "route": "/apps",
            "recentActivity": [
                {"type": "route", "label": "任务中心", "module": "tasks"},
            ],
        },
        prompt_language="zh",
    )
    assert "工作流" in block
    assert "不是任务中心" in block
    assert "不要沿用对话历史" in block


def test_apply_prompt_template_xiaomi_steward() -> None:
    prompt = apply_prompt_template(
        agent_name="xiaomi",
        loaded_tool_names=list(XIAOMI_SYSTEM_TOOL_NAMES),
        all_tool_names=list(XIAOMI_SYSTEM_TOOL_NAMES) + ["read", "write", "tool_search"],
        intent_hint="ask",
        session_mode="ask",
        prompt_language="zh",
        include_memory=False,
        xiaomi_page_context={
            "module": "workflow",
            "label": "工作流",
            "route": "/apps",
        },
    )
    assert "<xiaomi_policy>" in prompt
    assert "<xiaomi_runtime>" not in prompt
    assert "当前系统时间" not in prompt
    assert "xiaomi_wake" in prompt
    assert "EvovexAI 旗下的智能助手" not in prompt
    assert "<tool_catalog>" not in prompt
    assert "<tools_not_in_request>" not in prompt
    assert "<available-deferred-tools>" not in prompt
    assert "tool_search" not in prompt
    # 页面快照走 ephemeral Human，不得进 system（前缀缓存）
    assert "<xiaomi_ui_context>" not in prompt
    assert "用户当前界面" not in prompt


def test_strip_xiaomi_ui_context_from_system_prompt() -> None:
    from evoflow.agents.xiaomi.prompt import strip_xiaomi_ui_context_from_system_prompt

    raw = "base\n\n<xiaomi_ui_context>\nold\n</xiaomi_ui_context>\n\ntail"
    out = strip_xiaomi_ui_context_from_system_prompt(raw)
    assert "<xiaomi_ui_context>" not in out
    assert "base" in out
    assert "tail" in out


def test_xiaomi_ui_context_live_footer_strips_legacy_and_system() -> None:
    from unittest.mock import MagicMock

    from langchain.agents.middleware.types import ModelRequest
    from langchain_core.messages import HumanMessage, SystemMessage

    from evoflow.agents.middlewares.xiaomi_ui_context_live_footer_middleware import (
        XiaomiUiContextLiveFooterMiddleware,
    )

    mw = XiaomiUiContextLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {
        "agent_name": "xiaomi",
        "xiaomi_page_context": {
            "module": "chat",
            "label": "主对话",
            "route": "/chat",
        },
        "prompt_language": "zh",
    }
    legacy_named = HumanMessage(
        content="<xiaomi_ui_context>\nold named\n</xiaomi_ui_context>",
        name="xiaomi_ui_context",
    )
    legacy_unnamed = HumanMessage(content="<xiaomi_ui_context>\nold unnamed\n</xiaomi_ui_context>")
    blank = HumanMessage(content=[{"type": "text", "text": ""}])
    real = HumanMessage(content=[{"type": "text", "text": "这里呢 是什么"}])
    msgs = [real, legacy_named, legacy_unnamed, blank]
    req = ModelRequest(
        model=MagicMock(),
        messages=list(msgs),
        system_message=SystemMessage(
            content="sys base\n<xiaomi_ui_context>\nstale sys\n</xiaomi_ui_context>"
        ),
        tool_choice=None,
        tools=[],
        response_format=None,
        state={"messages": list(msgs)},
        runtime=rt,
        model_settings={},
    )
    out = mw._patch_request(req)
    sm = out.system_message
    assert sm is not None
    assert "<xiaomi_ui_context>" not in str(sm.content)
    assert "sys base" in str(sm.content)
    payload = list(out.messages or [])
    assert len(payload) == 2
    assert payload[0].content == real.content
    assert getattr(payload[-1], "name", None) == "xiaomi_ui_context"
    assert "主对话" in str(payload[-1].content)
    assert not any(_message_is_blankish(m) for m in payload[:-1])


def _message_is_blankish(msg) -> bool:
    c = getattr(msg, "content", None)
    if c == "" or c == []:
        return True
    if isinstance(c, list) and len(c) == 1 and isinstance(c[0], dict):
        return not str(c[0].get("text") or "").strip()
    return False


def test_xiaomi_ui_context_message_name() -> None:
    from evoflow.agents.middlewares.xiaomi_ui_context_live_footer_middleware import (
        XIAOMI_UI_CONTEXT_MESSAGE_NAME,
    )

    assert XIAOMI_UI_CONTEXT_MESSAGE_NAME == "xiaomi_ui_context"


def test_apply_prompt_template_main_is_not_xiaomi() -> None:
    prompt = apply_prompt_template(
        agent_name="main",
        loaded_tool_names=["read", "write"],
        all_tool_names=["read", "write"],
        intent_hint="ask",
        session_mode="ask",
        prompt_language="zh",
        include_memory=False,
    )
    assert "<xiaomi_policy>" not in prompt


def test_xiaomi_duty_system_prompt() -> None:
    from evoflow.agents.xiaomi.duty import build_xiaomi_duty_system_prompt
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig

    role = ProactiveRole(
        agent_code="xiaomi",
        role_name="小V",
        config=ProactiveRoleConfig(),
    )
    text = build_xiaomi_duty_system_prompt(role)
    assert "怎么工作" in text
    assert "催办" in text or "派给" in text
    assert "不要自己改业务代码" in text or "不亲自动手" in text
    assert "管理" in text and "任何人" in text
    assert "直属下级（你可派活的直接下属）" not in text


def test_should_skip_xiaomi_idle_patrol(monkeypatch) -> None:
    from evoflow.agents.xiaomi import duty as xduty

    monkeypatch.setattr(
        xduty,
        "summarize_xiaomi_duty_load",
        lambda: {
            "ok": True,
            "open_task_count": 0,
            "busy_count": 0,
            "pending_approvals": 0,
            "employee_count": 0,
        },
    )
    skip, _snap = xduty.should_skip_xiaomi_idle_patrol()
    assert skip is True

    monkeypatch.setattr(
        xduty,
        "summarize_xiaomi_duty_load",
        lambda: {
            "ok": True,
            "open_task_count": 2,
            "busy_count": 0,
            "pending_approvals": 0,
            "employee_count": 1,
        },
    )
    skip, _snap = xduty.should_skip_xiaomi_idle_patrol()
    assert skip is False

    monkeypatch.setattr(
        xduty,
        "summarize_xiaomi_duty_load",
        lambda: {
            "ok": True,
            "open_task_count": 0,
            "busy_count": 1,
            "pending_approvals": 0,
            "employee_count": 1,
        },
    )
    skip, _snap = xduty.should_skip_xiaomi_idle_patrol()
    assert skip is True

    monkeypatch.setattr(
        xduty,
        "summarize_xiaomi_duty_load",
        lambda: {
            "ok": True,
            "open_task_count": 0,
            "busy_count": 0,
            "pending_approvals": 1,
            "employee_count": 1,
        },
    )
    skip, _snap = xduty.should_skip_xiaomi_idle_patrol()
    assert skip is False

    monkeypatch.setattr(
        xduty,
        "summarize_xiaomi_duty_load",
        lambda: {
            "ok": False,
            "open_task_count": -1,
            "busy_count": -1,
            "pending_approvals": -1,
            "employee_count": -1,
        },
    )
    skip, _snap = xduty.should_skip_xiaomi_idle_patrol()
    assert skip is False


def test_summarize_xiaomi_duty_load_counts_open_and_busy(monkeypatch) -> None:
    from evoflow.agents.xiaomi import duty as xduty
    from evoflow.admin import employees as emp
    from evoflow.admin import tasks as admin_tasks

    monkeypatch.setattr(
        emp,
        "list_roles",
        lambda status="active": {
            "roles": [
                {"agent_code": "xiaomi", "role_name": "小V", "busy": False},
                {
                    "agent_code": "coder",
                    "role_name": "代码助手",
                    "busy": True,
                    "pending_approvals": 0,
                },
            ]
        },
    )
    monkeypatch.setattr(
        admin_tasks,
        "list_tasks",
        lambda role, include_subtasks=False: {
            "tasks": [
                {"task_id": "t1", "status": "pending", "progress": 10},
                {"task_id": "t2", "status": "completed", "progress": 100},
            ]
        }
        if role == "代码助手"
        else {"tasks": []},
    )
    snap = xduty.summarize_xiaomi_duty_load()
    assert snap["ok"] is True
    assert snap["employee_count"] == 1
    assert snap["busy_count"] == 1
    assert snap["open_task_count"] == 1


def test_skip_xiaomi_idle_heartbeat_only_for_xiaomi(monkeypatch) -> None:
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
    from evoflow.proactive.runner import _should_skip_xiaomi_idle_heartbeat

    monkeypatch.setattr(
        "evoflow.agents.xiaomi.duty.should_skip_xiaomi_idle_patrol",
        lambda: (True, {"open_task_count": 0, "busy_count": 0, "pending_approvals": 0}),
    )
    xiaomi = ProactiveRole(
        agent_code="xiaomi",
        role_name="小V",
        config=ProactiveRoleConfig(),
    )
    other = ProactiveRole(
        agent_code="coder",
        role_name="代码助手",
        config=ProactiveRoleConfig(),
    )
    assert _should_skip_xiaomi_idle_heartbeat(xiaomi) is True
    assert _should_skip_xiaomi_idle_heartbeat(other) is False


def test_xiaomi_knowledge_search_no_owned(monkeypatch) -> None:
    import asyncio
    import json

    from evoflow.agents.xiaomi import tools as xtools
    from evoflow.knowledge.owned import service as owned_service

    monkeypatch.setattr(owned_service, "list_bases", lambda: [])
    monkeypatch.setattr(
        "evoflow.knowledge.owned.worker.ensure_owned_kb_worker_started",
        lambda: None,
    )

    raw = asyncio.run(xtools.xiaomi_knowledge_search_tool.ainvoke({"query": "MCP"}))
    data = json.loads(raw)
    assert data.get("ok") is False
    assert data.get("error") == "no_owned_kb"


def test_xiaomi_knowledge_search_owned(monkeypatch) -> None:
    import asyncio
    import json

    from evoflow.agents.xiaomi import tools as xtools
    from evoflow.knowledge.owned import service as owned_service

    monkeypatch.setattr(
        "evoflow.knowledge.owned.worker.ensure_owned_kb_worker_started",
        lambda: None,
    )
    monkeypatch.setattr(
        owned_service,
        "list_bases",
        lambda: [{"id": "kb_demo", "name": "演示库", "embeddingDim": None}],
    )

    async def _search(kb_id, query, mode="hybrid", top_k=8, tags=None):
        assert kb_id == "kb_demo"
        assert mode == "keyword"  # no embeddingDim → keyword
        return {
            "items": [
                {
                    "title": "开发指南",
                    "fileName": "guides/dev.md",
                    "docId": "doc_1",
                    "content": "配置说明与启动步骤。",
                    "score": 1.0,
                }
            ],
            "mode": mode,
            "degraded": False,
        }

    monkeypatch.setattr(owned_service, "search", _search)

    raw = asyncio.run(
        xtools.xiaomi_knowledge_search_tool.ainvoke({"query": "开发指南 配置", "top_k": 5})
    )
    data = json.loads(raw)
    assert data.get("ok") is True
    assert data.get("provider") == "owned"
    assert data.get("count", 0) >= 1
    assert all(i.get("source") == "owned" for i in data.get("items") or [])
    assert any("开发指南" in str(i.get("title") or "") for i in data.get("items") or [])


def test_ensure_xiaomi_proactive_role_idempotent(tmp_path, monkeypatch) -> None:
    import gc
    from pathlib import Path

    from evoflow.agents.xiaomi.duty import ensure_xiaomi_proactive_role
    from evoflow.config.app_config import reset_app_config
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.proactive.repositories import ProactiveRepository

    db_path = Path(tmp_path) / "data" / "app" / "evoflow.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
    reset_app_config()
    reset_db_for_tests()
    get_db()
    try:
        r1 = ensure_xiaomi_proactive_role()
        assert r1["ok"] and r1["created"] is True
        role = ProactiveRepository.get_role("xiaomi")
        assert role is not None
        assert role.role_name == "小V"
        r2 = ensure_xiaomi_proactive_role()
        assert r2["ok"] and r2["created"] is False
    finally:
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def test_build_system_prompt_routes_xiaomi() -> None:
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
    from evoflow.proactive.prompt import build_system_prompt

    role = ProactiveRole(agent_code="xiaomi", role_name="小V", config=ProactiveRoleConfig())
    text = build_system_prompt(role)
    assert "常驻" in text


def test_xiaomi_role_protected_from_archive_and_delete(tmp_path, monkeypatch) -> None:
    import gc
    from pathlib import Path

    from evoflow.agents.xiaomi.duty import ensure_xiaomi_proactive_role
    from evoflow.admin.employees import archive_role as admin_archive
    from evoflow.admin.errors import ValidationError
    from evoflow.config.app_config import reset_app_config
    from evoflow.persistence.db import get_db, reset_db_for_tests

    db_path = Path(tmp_path) / "data" / "app" / "evoflow.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
    reset_app_config()
    reset_db_for_tests()
    get_db()
    try:
        ensure_xiaomi_proactive_role()
        try:
            admin_archive("xiaomi")
            raise AssertionError("expected ValidationError")
        except ValidationError as e:
            assert "系统默认前台" in str(e) or "小V" in str(e)
    finally:
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def test_agent_empty_list_round_trip() -> None:
    from evoflow.persistence.row_mappers import agent_doc_to_parts, agent_parts_to_doc

    row, lists, env = agent_doc_to_parts(
        "demo",
        {
            "agent_code": "demo",
            "agent_name": "Demo",
            "description": "d",
            "tools": [],
            "mcp_servers": [],
            "skills": [],
        },
    )
    assert any(kind == "tools" for kind, _, _ in lists)
    doc = agent_parts_to_doc(row, lists, env)
    assert doc["tools"] == []
    assert doc["mcp_servers"] == []
    assert doc["skills"] == []

    row2, lists2, env2 = agent_doc_to_parts(
        "demo2",
        {"agent_code": "demo2", "description": "all tools"},
    )
    doc2 = agent_parts_to_doc(row2, lists2, env2)
    assert "tools" not in doc2


def test_enforce_xiaomi_front_desk_capabilities(tmp_path, monkeypatch) -> None:
    import gc
    from pathlib import Path

    from evoflow.config.agents_config import (
        enforce_xiaomi_front_desk_capabilities,
        load_agent_config,
        save_agent_config,
        xiaomi_front_desk_capability_defaults,
    )
    from evoflow.config.app_config import reset_app_config
    from evoflow.persistence.db import get_db, reset_db_for_tests

    db_path = Path(tmp_path) / "data" / "app" / "evoflow.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
    reset_app_config()
    reset_db_for_tests()
    get_db()
    try:
        save_agent_config(
            "xiaomi",
            {
                "agent_type": "custom",
                "agent_name": "小V",
                "description": "front desk",
                "tools": None,
                "mcp_servers": None,
                "skills": ["deep-research", "evoflow-intro"],
            },
        )
        assert enforce_xiaomi_front_desk_capabilities() is True
        cfg = load_agent_config("xiaomi")
        caps = xiaomi_front_desk_capability_defaults()
        assert cfg.tools == caps["tools"]
        assert cfg.mcp_servers == caps["mcp_servers"]
        assert cfg.skills == caps["skills"]
        # Round-trip again from DB
        cfg2 = load_agent_config("xiaomi")
        assert cfg2.tools == []
        assert cfg2.skills == []
        assert cfg2.mcp_servers == []
    finally:
        reset_db_for_tests()
        reset_app_config()
        gc.collect()
