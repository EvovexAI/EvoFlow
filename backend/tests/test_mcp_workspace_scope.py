"""Workspace（项目）级 MCP 配置 + 信任门测试（对齐 Zcode 项目 scope）.

覆盖对齐清单 #3 的核心语义：

1. 项目根解析（env 覆盖 / cwd 兜底）与 mcp.json 查找顺序；
2. 信任门三态：untrusted → trusted（指纹绑定）→ changed（配置变更即失效）；
3. 信任门挡在连接加载之前：未信任的 server 绝不进入 ``load_mcp_config`` 结果；
4. 用户级同名 server 优先（项目配置不能仿冒/劫持用户已信任 server）；
5. 管理接口：GET /api/mcp/project 与 POST /api/mcp/project/trust。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import mcp as mcp_router
from evoflow.mcp import workspace_scope
from evoflow.mcp.tools import _merge_trusted_project_servers, load_mcp_config


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "repo"
    (root / ".evoflow").mkdir(parents=True)
    monkeypatch.setenv("EVOFLOW_MCP_PROJECT_DIR", str(root))
    # 信任存储隔离到临时目录
    monkeypatch.setattr(
        workspace_scope, "trust_store_path", lambda: tmp_path / "trust" / "mcp_project_trust.json"
    )
    return root


def _write_project_config(root: Path, servers: dict, *, dot_mcp: bool = False) -> None:
    target = (root / ".mcp.json") if dot_mcp else (root / ".evoflow" / "mcp.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"mcpServers": servers}), encoding="utf-8")


# ── 项目根与文件解析 ────────────────────────────────────────────────────


def test_project_root_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_MCP_PROJECT_DIR", str(tmp_path))
    assert workspace_scope.resolve_project_root() == tmp_path


def test_project_root_defaults_to_cwd(monkeypatch, tmp_path):
    monkeypatch.delenv("EVOFLOW_MCP_PROJECT_DIR", raising=False)
    monkeypatch.chdir(tmp_path)
    assert workspace_scope.resolve_project_root() == tmp_path


def test_load_project_servers_evoflow_first(project):
    _write_project_config(project, {"a": {"command": "x"}})
    _write_project_config(project, {"b": {"command": "y"}}, dot_mcp=True)
    servers, source = workspace_scope.load_project_mcp_servers()
    assert set(servers) == {"a"}
    assert source == project / ".evoflow" / "mcp.json"


def test_load_project_servers_dot_mcp_fallback(project):
    _write_project_config(project, {"b": {"command": "y"}}, dot_mcp=True)
    servers, source = workspace_scope.load_project_mcp_servers()
    assert set(servers) == {"b"}
    assert source == project / ".mcp.json"


def test_load_project_servers_invalid_json_skipped(project):
    (project / ".evoflow" / "mcp.json").write_text("{oops", encoding="utf-8")
    _write_project_config(project, {"b": {"command": "y"}}, dot_mcp=True)
    servers, source = workspace_scope.load_project_mcp_servers()
    assert set(servers) == {"b"}
    assert source == project / ".mcp.json"


# ── 信任门三态 ──────────────────────────────────────────────────────────


def test_trust_gate_lifecycle(project):
    _write_project_config(project, {"gh": {"command": "npx", "args": ["-y", "gh-mcp"]}})

    # 从未信任 → untrusted，且不参与连接加载
    status = workspace_scope.project_servers_with_status()
    assert status["gh"]["status"] == "untrusted"
    assert workspace_scope.trusted_project_servers() == {}

    # 信任 → trusted（指纹绑定），进入连接加载集合
    workspace_scope.set_project_server_trust("gh", True)
    status = workspace_scope.project_servers_with_status()
    assert status["gh"]["status"] == "trusted"
    assert set(workspace_scope.trusted_project_servers()) == {"gh"}

    # 配置被改（名字没变）→ changed，信任自动失效
    _write_project_config(project, {"gh": {"command": "evil", "args": []}})
    status = workspace_scope.project_servers_with_status()
    assert status["gh"]["status"] == "changed"
    assert workspace_scope.trusted_project_servers() == {}

    # 重新信任新配置 → trusted；撤回 → untrusted
    workspace_scope.set_project_server_trust("gh", True)
    assert workspace_scope.project_servers_with_status()["gh"]["status"] == "trusted"
    workspace_scope.set_project_server_trust("gh", False)
    assert workspace_scope.project_servers_with_status()["gh"]["status"] == "untrusted"
    assert workspace_scope.trusted_project_servers() == {}


def test_trust_unknown_server_rejected(project):
    with pytest.raises(KeyError):
        workspace_scope.set_project_server_trust("ghost", True)


def test_disabled_project_server_not_loaded(project):
    _write_project_config(project, {"off": {"command": "x", "enabled": False}})
    workspace_scope.set_project_server_trust("off", True)
    assert workspace_scope.trusted_project_servers() == {}


def test_trust_store_survives_reload(project):
    _write_project_config(project, {"gh": {"command": "x"}})
    workspace_scope.set_project_server_trust("gh", True)
    # 新读一遍存储（模拟进程重启）：trust_store_path 被 monkeypatch 为固定路径，
    # project_servers_with_status 走 _load_trust_store 重新从盘上读。
    assert workspace_scope.project_servers_with_status()["gh"]["status"] == "trusted"


# ── 合并语义：用户级优先 ────────────────────────────────────────────────


def test_merge_user_level_wins_over_project(monkeypatch):
    monkeypatch.setattr(
        workspace_scope,
        "trusted_project_servers",
        lambda: {"github": {"command": "evil"}, "proj-only": {"command": "ok"}},
    )
    merged = _merge_trusted_project_servers({"github": {"command": "user"}})
    # 用户级 github 保持不变；项目独有 server 正常并入
    assert merged["github"] == {"command": "user"}
    assert merged["proj-only"] == {"command": "ok"}


def test_merge_empty_project_is_noop(monkeypatch):
    monkeypatch.setattr(workspace_scope, "trusted_project_servers", lambda: {})
    user = {"a": {"command": "x"}}
    assert _merge_trusted_project_servers(user) is user


def test_merge_failure_falls_back_to_user(monkeypatch):
    def boom():
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(workspace_scope, "trusted_project_servers", boom)
    user = {"a": {"command": "x"}}
    assert _merge_trusted_project_servers(user) == user


def test_load_mcp_config_includes_trusted_project_servers(project, monkeypatch):
    """端到端：信任门挡在 load_mcp_config 之前（未信任不出现，信任后并入）。"""
    _write_project_config(project, {"projmcp": {"command": "npx", "args": ["-y", "x"]}})
    # 隔离用户级来源：SQLite 读空、文件加载为空（防止测试触碰真实 dev DB / Cursor 配置）
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.list_mcp_servers", lambda: {}
    )
    import evoflow.mcp.config_io as config_io

    monkeypatch.setattr(config_io, "load_mcp_json_from_files", lambda: ({}, None))
    monkeypatch.setattr(config_io, "sync_mcp_servers_to_sqlite", lambda servers: None)
    monkeypatch.delenv("EVOFLOW_MCP_CONFIG", raising=False)

    # 未信任：项目 server 不应出现
    loaded = load_mcp_config()
    assert "projmcp" not in loaded

    workspace_scope.set_project_server_trust("projmcp", True)
    loaded = load_mcp_config()
    assert loaded.get("projmcp") == {"command": "npx", "args": ["-y", "x"]}


# ── 管理接口 ────────────────────────────────────────────────────────────


@pytest.fixture()
def api_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(mcp_router, "require_org_admin", lambda request: None)
    monkeypatch.setattr(
        "evoflow.mcp.cache.reset_mcp_tools_cache", lambda: None, raising=False
    )
    app = FastAPI()
    app.include_router(mcp_router.router)
    return TestClient(app)


def test_project_api_list_and_trust(project, api_client: TestClient):
    _write_project_config(project, {"gh": {"command": "npx", "args": ["x"]}})

    resp = api_client.get("/api/mcp/project")
    assert resp.status_code == 200
    body = resp.json()
    assert body["project_root"] == str(project)
    assert body["servers"][0]["name"] == "gh"
    assert body["servers"][0]["status"] == "untrusted"

    # 信任
    resp = api_client.post("/api/mcp/project/trust", json={"name": "gh", "trusted": True})
    assert resp.status_code == 200
    assert resp.json()["servers"][0]["status"] == "trusted"
    assert workspace_scope.trusted_project_servers()

    # 未知 server → 404
    resp = api_client.post("/api/mcp/project/trust", json={"name": "ghost", "trusted": True})
    assert resp.status_code == 404

    # 撤回
    resp = api_client.post("/api/mcp/project/trust", json={"name": "gh", "trusted": False})
    assert resp.status_code == 200
    assert resp.json()["servers"][0]["status"] == "untrusted"
