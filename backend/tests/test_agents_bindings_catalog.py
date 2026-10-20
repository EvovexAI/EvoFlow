"""agents.bindings catalog + create_agent tools default (omit ≠ inherit-all)."""

from __future__ import annotations

import uuid

import pytest

from evoflow.admin.agents import create_agent, delete_agent, list_bindings_catalog


def test_list_bindings_catalog_has_described_rows() -> None:
    cat = list_bindings_catalog()
    assert isinstance(cat.get("tools"), list)
    assert isinstance(cat.get("skills"), list)
    assert isinstance(cat.get("mcp_servers"), list)
    assert isinstance(cat.get("knowledge_bases"), list)
    assert "hint" in cat
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


def test_create_agent_explicit_null_tools_inherits_all() -> None:
    code = f"bind-null-{uuid.uuid4().hex[:8]}"
    try:
        row = create_agent({"agent_code": code, "agent_name": "Null Tools", "tools": None})
        assert row.get("tools") is None
        assert row.get("bindings_applied", {}).get("tools_mode") == "inherit_all"
        assert "warning" in row
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass
