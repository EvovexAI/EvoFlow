"""Tests for Knowledge Vault launch plans and capability discovery."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

from evoflow.knowledge.vault.capability import (
    build_related_graph_arguments,
    build_search_arguments,
    discover_from_tool_objects,
)
from evoflow.knowledge.vault.runtime_resolve import (
    build_search_launch_plan,
    build_write_launch_plan,
    private_packages_ready,
    runtime_status_dict,
)


def test_discover_ohs_tool_names():
    class _T:
        def __init__(self, name: str) -> None:
            self.name = name
            self.args_schema = None

    tools = [
        _T("kb-search_evo_kb_search"),
        _T("kb-search_evo_kb_read"),
        _T("kb-search_evo_kb_reindex"),
        _T("kb-search_evo_kb_status"),
    ]
    caps = discover_from_tool_objects(tools)
    assert caps.search_tool
    assert "search" in (caps.search_tool or "")
    assert caps.read_tool
    assert caps.reindex_tool
    assert caps.status_tool
    assert not caps.missing_required


def test_build_search_arguments_maps_tag_scope():
    schema = {"properties": {"query": {}, "mode": {}, "limit": {}, "tag": {}, "scope": {}, "rerank": {}}}
    args = build_search_arguments(
        query="q",
        mode="hybrid",
        top_k=5,
        tags=["a", "b"],
        scopes=["Knowledge"],
        schema=schema,
    )
    assert args["query"] == "q"
    assert args["tag"] == ["a", "b"]
    assert args["scope"] == "Knowledge"
    assert "tags" not in args
    assert "scopes" not in args


def test_related_graph_arguments():
    schema = {
        "properties": {
            "path": {},
            "related": {},
            "depth": {},
            "direction": {},
            "link_type": {},
        }
    }
    args = build_related_graph_arguments(path="Knowledge/A.md", depth=2, direction="outgoing", schema=schema)
    assert args["related"] is True
    assert args["path"] == "Knowledge/A.md"
    assert args["depth"] == 2
    assert "query" not in args


def test_launch_plan_npx_dev(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("EVOFLOW_KB_MCP_LAUNCH", "npx")
    monkeypatch.setenv("EVOFLOW_KB_RUNTIME_ROOT", str(tmp_path / "kb-mcp"))
    with (
        patch("evoflow.knowledge.vault.runtime_resolve.resolve_node_binary", return_value="/usr/bin/node"),
        patch("evoflow.knowledge.vault.runtime_resolve.resolve_npx_binary", return_value="/usr/bin/npx"),
        patch("evoflow.knowledge.vault.runtime_resolve.private_packages_ready", return_value=(False, "missing")),
    ):
        plan = build_search_launch_plan()
    assert plan.kind == "npx"
    assert "-y" in plan.args
    assert plan.production is False


def test_launch_plan_private_requires_packages(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("EVOFLOW_KB_MCP_LAUNCH", "private")
    monkeypatch.setenv("EVOFLOW_KB_RUNTIME_ROOT", str(tmp_path / "kb-mcp"))
    monkeypatch.setenv("EVOFLOW_KB_PACKAGED_ROOT", str(tmp_path / "packaged-missing"))
    with patch("evoflow.knowledge.vault.runtime_resolve.resolve_node_binary", return_value=str(tmp_path / "node")):
        plan = build_search_launch_plan()
    assert plan.kind == "unavailable"
    assert plan.online_install_required is True


def test_launch_plan_private_ready(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("EVOFLOW_KB_MCP_LAUNCH", "private")
    root = tmp_path / "kb-mcp"
    monkeypatch.setenv("EVOFLOW_KB_RUNTIME_ROOT", str(root))
    monkeypatch.setenv("EVOFLOW_KB_PACKAGED_ROOT", str(tmp_path / "packaged-missing"))
    node = tmp_path / "node.exe" if os.name == "nt" else tmp_path / "node"
    node.write_text("x", encoding="utf-8")
    ohs = root / "node_modules" / "obsidian-hybrid-search" / "dist" / "src"
    ohs.mkdir(parents=True)
    (ohs / "server.js").write_text("console.log(1)", encoding="utf-8")
    write = root / "node_modules" / "obsidian-mcp-server" / "dist"
    write.mkdir(parents=True)
    (write / "index.js").write_text("console.log(1)", encoding="utf-8")
    ready, msg = private_packages_ready(root)
    assert ready, msg
    with patch("evoflow.knowledge.vault.runtime_resolve.resolve_node_binary", return_value=str(node)):
        plan = build_search_launch_plan()
        wplan = build_write_launch_plan()
    assert plan.kind == "private"
    assert plan.command == str(node)
    assert any("server.js" in a for a in plan.args)
    assert wplan.kind == "private"


def test_launch_prefers_packaged_root(monkeypatch, tmp_path: Path):
    """In-repo packaging/kb-mcp wins over empty user runtime when ready."""
    monkeypatch.setenv("EVOFLOW_KB_MCP_LAUNCH", "auto")
    monkeypatch.delenv("EVOFLOW_KB_RUNTIME_ROOT", raising=False)
    packaged = tmp_path / "packaging-kb-mcp"
    packaged.mkdir(parents=True)
    (packaged / "package.json").write_text('{"name":"evoflow-kb-mcp","private":true}', encoding="utf-8")
    ohs = packaged / "node_modules" / "obsidian-hybrid-search" / "dist" / "src"
    ohs.mkdir(parents=True)
    (ohs / "server.js").write_text("ok", encoding="utf-8")
    write = packaged / "node_modules" / "obsidian-mcp-server" / "dist"
    write.mkdir(parents=True)
    (write / "index.js").write_text("ok", encoding="utf-8")
    monkeypatch.setenv("EVOFLOW_KB_PACKAGED_ROOT", str(packaged))
    node = tmp_path / "node.exe" if os.name == "nt" else tmp_path / "node"
    node.write_text("x", encoding="utf-8")
    with patch("evoflow.knowledge.vault.runtime_resolve.resolve_node_binary", return_value=str(node)):
        plan = build_search_launch_plan()
    assert plan.kind == "private"
    assert str(packaged) in (plan.cwd or "")
    assert any("server.js" in a for a in plan.args)


def test_resolve_node_prefers_program_files_over_editor_helper(monkeypatch, tmp_path: Path):
    from evoflow.knowledge.vault import runtime_resolve as rr

    helper = tmp_path / "cursor" / "resources" / "app" / "resources" / "helpers" / "node.exe"
    helper.parent.mkdir(parents=True)
    helper.write_text("x", encoding="utf-8")
    pf_root = tmp_path / "ProgramFiles"
    system = pf_root / "nodejs" / "node.exe"
    system.parent.mkdir(parents=True)
    system.write_text("x", encoding="utf-8")

    monkeypatch.delenv("EVOFLOW_KB_NODE", raising=False)
    monkeypatch.setenv("ProgramFiles", str(pf_root))
    monkeypatch.setenv("ProgramW6432", str(pf_root))
    monkeypatch.setenv("EVOFLOW_KB_RUNTIME_ROOT", str(tmp_path / "runtime-empty"))
    monkeypatch.setenv("EVOFLOW_KB_PACKAGED_ROOT", str(tmp_path / "packaged-missing"))
    monkeypatch.setattr(rr.shutil, "which", lambda *_a, **_k: str(helper))
    monkeypatch.setattr(rr.sys, "platform", "win32")

    chosen = rr.resolve_node_binary()
    assert Path(chosen).resolve() == system.resolve()
    assert rr._is_editor_helper_node(str(helper)) is True
    assert rr._is_editor_helper_node(str(system)) is False
    monkeypatch.setenv("EVOFLOW_KB_RUNTIME_ROOT", str(tmp_path / "kb-mcp"))
    monkeypatch.setenv("EVOFLOW_KB_PACKAGED_ROOT", str(tmp_path / "packaged-missing"))
    monkeypatch.setenv("EVOFLOW_KB_MCP_LAUNCH", "npx")
    status = runtime_status_dict()
    assert "mode" in status
    assert "searchPlan" in status
    assert "writePlan" in status
    assert "privatePackagesReady" in status
    assert "packagedRoot" in status
    assert "preferredInstallRoot" in status
