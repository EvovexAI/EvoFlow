"""agents.bindings catalog + create_agent tools default (omit ≠ inherit-all)."""

from __future__ import annotations

import uuid

import pytest

from evoflow.admin.agents import create_agent, delete_agent, list_bindings_catalog
from evoflow.admin.errors import ValidationError
from evoflow.config.capability_packs import CAPABILITY_PACKS, MAX_ALLOWLIST_TOOLS


def test_list_bindings_catalog_has_described_rows() -> None:
    cat = list_bindings_catalog()
    assert isinstance(cat.get("packs"), list)
    assert len(cat["packs"]) >= 4
    pack_ids = {p["id"] for p in cat["packs"]}
    assert {"research", "writer", "duty", "coding", "none", "custom"} <= pack_ids
    assert isinstance(cat.get("tools"), list)
    assert isinstance(cat.get("skills"), list)
    assert isinstance(cat.get("mcp_servers"), list)
    assert isinstance(cat.get("knowledge_bases"), list)
    assert "hint" in cat
    assert "capability_pack" in (cat.get("hint") or "")
    if cat["tools"]:
        row = cat["tools"][0]
        assert "name" in row and "description" in row
    if cat["knowledge_bases"]:
        kb = cat["knowledge_bases"][0]
        assert "id" in kb and "name" in kb


def test_create_agent_omitted_tools_is_empty_allowlist() -> None:
    code = f"bind-omit-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent({"agent_code": code, "agent_name": "Omit Tools"})
        assert row.get("tools") == []
        assert row.get("bindings_applied", {}).get("tools_mode") == "empty"
        assert row.get("mcp_servers") == []
        assert row.get("knowledge_vault_ids") == []
        assert row.get("bindings_applied", {}).get("knowledge_vault_ids") == []
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass


def test_create_agent_omitted_skills_is_empty_allowlist() -> None:
    code = f"bind-omit-skills-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent({"agent_code": code, "agent_name": "Omit Skills"})
        assert row.get("skills") == []
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass


def test_bindings_catalog_defaults_on_create_has_no_skills() -> None:
    defaults = list_bindings_catalog().get("defaults_on_create", {})
    assert defaults.get("skills") == []
    assert defaults.get("max_allowlist_tools") == MAX_ALLOWLIST_TOOLS


def test_create_agent_explicit_null_tools_requires_confirm() -> None:
    code = f"bind-null-{uuid.uuid4().hex[:8]}"
    with pytest.raises(ValidationError, match="confirm_inherit_all"):
        create_agent({"agent_code": code, "agent_name": "Null Tools", "tools": None})


def test_create_agent_explicit_null_tools_inherits_all_with_confirm() -> None:
    code = f"bind-null-ok-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent(
            {
                "agent_code": code,
                "agent_name": "Null Tools Ok",
                "tools": None,
                "confirm_inherit_all": True,
            }
        )
        assert row.get("tools") is None
        assert row.get("bindings_applied", {}).get("tools_mode") == "inherit_all"
        assert "warning" in row
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass


def test_create_agent_capability_pack_writer() -> None:
    code = f"bind-pack-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent(
            {
                "agent_code": code,
                "agent_name": "Writer Pack",
                "capability_pack": "writer",
            }
        )
        expected = list(CAPABILITY_PACKS["writer"].tools)
        assert row.get("tools") == expected
        assert row.get("capability_pack") == "writer"
        assert row.get("bindings_applied", {}).get("capability_pack") == "writer"
        assert row.get("bindings_applied", {}).get("tools_mode") == "allowlist"
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass


def test_create_agent_pack_plus_tools_extra() -> None:
    code = f"bind-extra-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent(
            {
                "agent_code": code,
                "agent_name": "Research Extra",
                "capability_pack": "research",
                "tools_extra": ["todo_write"],
            }
        )
        tools = row.get("tools") or []
        assert "web_search" in tools
        assert "todo_write" in tools
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass


def test_create_agent_pack_rejects_tools_override() -> None:
    code = f"bind-conflict-{uuid.uuid4().hex[:8]}"
    with pytest.raises(ValidationError, match="tools_extra"):
        create_agent(
            {
                "agent_code": code,
                "agent_name": "Conflict",
                "capability_pack": "duty",
                "tools": ["tasks"],
            }
        )


def test_create_agent_wide_allowlist_requires_confirm() -> None:
    code = f"bind-wide-{uuid.uuid4().hex[:8]}"
    # Guard runs before catalog validation — synthetic names are enough.
    wide = [f"tool-{i}" for i in range(MAX_ALLOWLIST_TOOLS + 1)]
    with pytest.raises(ValidationError, match="confirm_wide_tools"):
        create_agent({"agent_code": code, "agent_name": "Wide", "tools": wide})


def test_create_agent_forbid_inherit_all_for_employees() -> None:
    code = f"bind-emp-null-{uuid.uuid4().hex[:8]}"
    with pytest.raises(ValidationError, match="employees must not"):
        create_agent(
            {
                "agent_code": code,
                "agent_name": "Emp Null",
                "tools": None,
            },
            forbid_inherit_all=True,
        )


def test_capability_pack_tools_all_assignable() -> None:
    """每个能力包引用的工具名必须都在可分配目录内。

    根因背景：``todo`` 改名 ``todo_write`` 后这里漏改；``subagent`` 只在
    ``subagent_enabled=True`` 时装载，若校验用 False 装载就会把整包打成
    ``unknown tool(s)`` —— 表现是「工程编码」包建不出员工，而不是报某个名字。
    """
    from evoflow.config.agent_resource_validation import assignable_tool_names

    assignable = assignable_tool_names()
    offenders = {
        pack.id: [t for t in pack.tools if t not in assignable]
        for pack in CAPABILITY_PACKS.values()
        if pack.tools
    }
    offenders = {k: v for k, v in offenders.items() if v}
    assert not offenders, f"capability packs reference non-assignable tools: {offenders}"


@pytest.mark.parametrize("pack_id", ["coding", "duty", "research", "writer"])
def test_create_agent_with_each_shipped_pack(pack_id: str) -> None:
    """出厂能力包必须能直接建出员工（回归：coding 包曾整体不可用）。"""
    code = f"bind-pack-{pack_id}-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent(
            {
                "agent_code": code,
                "agent_name": f"Pack {pack_id}",
                "capability_pack": pack_id,
            }
        )
        tools = row.get("tools") or []
        assert tools, f"pack {pack_id} produced empty allowlist"
        expected = CAPABILITY_PACKS[pack_id].tools
        assert set(expected) <= set(tools)
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass
