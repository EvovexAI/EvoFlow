"""Prompt stability: consecutive model patches keep system+tools bytes stable (tail may change)."""

from __future__ import annotations

import hashlib
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from evoflow.agents.memory.standing_freeze import invalidate_standing_memory
from evoflow.agents.middlewares.memory_live_footer_middleware import MemoryLiveFooterMiddleware
from evoflow.agents.middlewares.mission_state_live_footer_middleware import MissionStateLiveFooterMiddleware
from evoflow.agents.middlewares.tool_surface_lock_middleware import (
    ToolSurfaceLockMiddleware,
    clear_tool_surface_lock,
)
from evoflow.agents.middlewares.workspace_runtime_live_footer_middleware import (
    WorkspaceRuntimeLiveFooterMiddleware,
)
from evoflow.agents.mission_state.models import MissionState


def _hash_system_tools(req: ModelRequest) -> str:
    sys_text = str(getattr(req.system_message, "content", "") or "")
    tool_names = "|".join(
        sorted(str(getattr(t, "name", "") or "") for t in (req.tools or []))
    )
    blob = f"{sys_text}\n@@TOOLS@@\n{tool_names}".encode("utf-8", errors="ignore")
    return hashlib.sha256(blob).hexdigest()


def test_system_and_tools_stable_across_two_patches() -> None:
    tid = "t-prompt-stable"
    clear_tool_surface_lock(tid)
    invalidate_standing_memory(tid)

    rt = MagicMock()
    rt.context = {
        "thread_id": tid,
        "evf_dynamic_prompt_meta": {"agent_name": "main", "prompt_language": "zh"},
    }
    base_sys = SystemMessage(
        content="BASE\n<workspace>\n用户工作目录: /ws\n当前系统时间: 1999-01-01\n</workspace>\n"
        "<mission_state>old</mission_state>"
    )
    tools = [SimpleNamespace(name="b_tool"), SimpleNamespace(name="a_tool")]
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="hi")],
        system_message=base_sys,
        tools=tools,
        state={"messages": [HumanMessage(content="hi")]},
        runtime=rt,
    )

    tool_lock = ToolSurfaceLockMiddleware()
    mission = MissionStateLiveFooterMiddleware()
    clock = WorkspaceRuntimeLiveFooterMiddleware()
    memory = MemoryLiveFooterMiddleware()
    state = MissionState(thread_id=tid, primary_objective="Ship cache-first", version=1)

    def run_once(r: ModelRequest) -> ModelRequest:
        r = tool_lock._patch_request(r)
        with patch("evoflow.agents.mission_state.config.MISSION_STATE_PROMPT_INJECTION_ENABLED", True):
            with patch(
                "evoflow.agents.lead_agent.prompt._build_mission_state_section",
                return_value="<mission_state>\nShip cache-first\n</mission_state>",
            ):
                with patch("evoflow.agents.mission_state.storage.load_mission_state", return_value=state):
                    r = mission._patch_request(r)
        with patch(
            "evoflow.agents.middlewares.dynamic_system_prompt_middleware._merged_runtime_context",
            return_value=rt.context,
        ):
            with patch(
                "evoflow.agents.middlewares.dynamic_system_prompt_middleware._resolve_prompt_meta",
                return_value=rt.context["evf_dynamic_prompt_meta"],
            ):
                r = clock._patch_request(r)
        with patch(
            "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
            return_value=frozenset({"chat"}),
        ):
            with patch(
                "evoflow.agents.lead_agent.prompt.build_memory_injection_sections",
                return_value="<!-- MEM -->\n<memory>frozen</memory>",
            ):
                with patch(
                    "evoflow.agents.lead_agent.prompt.build_memory_query_recall_sections",
                    return_value="",
                ):
                    r = memory._patch_request(r)
        return r

    out1 = run_once(req)
    out2 = run_once(
        req.override(
            tools=[SimpleNamespace(name="a_tool"), SimpleNamespace(name="b_tool"), SimpleNamespace(name="extra")],
            system_message=SystemMessage(content=str(base_sys.content)),
        )
    )

    assert _hash_system_tools(out1) == _hash_system_tools(out2)
    assert "<mission_state>" not in str(out1.system_message.content)
    assert "时间:" in str(out1.system_message.content)
    assert any(getattr(m, "name", None) == "session_mission_state" for m in out1.messages)
    assert not any(getattr(m, "name", None) == "session_runtime_clock" for m in out1.messages)
    assert [t.name for t in out1.tools] == ["a_tool", "b_tool"]
