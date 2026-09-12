"""Policy migrated from system prompt onto tool descriptions."""

from __future__ import annotations

from evoflow.agents.lead_agent.prompt import (
    _build_subagent_section,
    _build_trae_section,
    _build_worker_guidance_section,
    apply_prompt_template,
)
from evoflow.tools.builtins.subagent_tool_description import SUBAGENT_TOOL_DESCRIPTION
from evoflow.tools.builtins.task_tool import task_tool
from evoflow.tools.host_direct.delete_file import delete_file_hd
from evoflow.tools.host_direct.read_file import read_file_hd
from evoflow.tools.host_direct.str_replace import str_replace_hd
from evoflow.tools.host_direct.write_file import write_file_hd
from evoflow.tools.minimal_schema import (
    DELETE_TOOL_DESCRIPTION,
    READ_TOOL_DESCRIPTION,
    REPLACE_TOOL_DESCRIPTION,
    WRITE_TOOL_DESCRIPTION,
)


def test_basic_edit_tools_have_short_descriptions() -> None:
    assert str(read_file_hd.description) == READ_TOOL_DESCRIPTION
    assert str(write_file_hd.description) == WRITE_TOOL_DESCRIPTION
    assert str(str_replace_hd.description) == REPLACE_TOOL_DESCRIPTION
    assert str(delete_file_hd.description) == DELETE_TOOL_DESCRIPTION
    for desc in (
        READ_TOOL_DESCRIPTION,
        WRITE_TOOL_DESCRIPTION,
        REPLACE_TOOL_DESCRIPTION,
        DELETE_TOOL_DESCRIPTION,
    ):
        assert desc.strip()
        assert len(desc) < 220


def test_worker_guidance_section_empty() -> None:
    assert _build_worker_guidance_section(["replace", "write", "read"], prompt_language="zh") == ""
    assert _build_worker_guidance_section(["replace", "write", "read"], prompt_language="en") == ""


def test_system_prompt_omits_host_direct_edit_policy() -> None:
    prompt = apply_prompt_template(
        loaded_tool_names=["read", "replace", "write", "delete"],
        all_tool_names=["read", "replace", "write", "delete"],
        intent_hint="agent",
        prompt_language="zh",
    )
    assert "<host_direct_edit_policy>" not in prompt


def test_subagent_tool_carries_routing_policy() -> None:
    assert "Use when" in SUBAGENT_TOOL_DESCRIPTION or "multi-file" in SUBAGENT_TOOL_DESCRIPTION.lower()
    assert len(SUBAGENT_TOOL_DESCRIPTION) < 1200
    desc = str(getattr(task_tool, "description", "") or "")
    assert "subagent" in desc.lower() or "Delegate" in desc


def test_subagent_section_is_catalog_only() -> None:
    section = _build_subagent_section(3, "TestAgent", prompt_language="zh")
    assert "<subagent_system>" in section
    assert "什么时候用" not in section
    assert "general-purpose" in section


def test_trae_section_empty() -> None:
    assert _build_trae_section(["trae_delegate", "trae_status"], "Lead", prompt_language="zh") == ""
    prompt = apply_prompt_template(
        loaded_tool_names=["trae_delegate"],
        all_tool_names=["trae_delegate"],
        intent_hint="agent",
        prompt_language="zh",
    )
    assert "<trae_execution_policy>" not in prompt
