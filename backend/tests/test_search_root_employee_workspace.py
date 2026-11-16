# 【self-evolution-bot · 2026-11-16 · 第23轮】P0 回归断言（判定单 2611162156 §三④）
"""Regression tests for resolve_search_workspace_root employee-workspace tier.

两类断言（判定单要求）：
1. 员工值守会话：无 session local_workspace_root 时，默认搜索根 = 岗位 workspace_path
   （search_code_index / rg / find_file / glob_grep / bash_tool 共用该函数）。
2. 非员工会话（main / 小V / 普通聊天 / CLI）：行为零变化——session 绑定优先、
   否则落 thread sandbox、再否则 NO_WORKSPACE_BOUND。
"""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from evoflow.tools.host_direct import workspace_path_guard as wpg
from evoflow.tools.host_direct.workspace_path_guard import (
    NO_WORKSPACE_BOUND,
    resolve_search_workspace_root,
)


class _Ctx:
    def __init__(self, data: dict) -> None:
        self._data = data

    def get(self, key: str, default=None):
        return self._data.get(key, default)


class _Rt:
    """Minimal runtime stand-in (context + config), like ToolRuntime usage sites."""

    def __init__(self, context: dict, configurable: dict | None = None) -> None:
        self.context = _Ctx(context)
        self.config = {"configurable": configurable or {}}


@pytest.fixture(autouse=True)
def _clear_caches():
    wpg._employee_workspace_root_cached.cache_clear()
    yield
    wpg._employee_workspace_root_cached.cache_clear()


# ---------------------------------------------------------------------------
# 断言组 1：员工会话 → 岗位 workspace_path
# ---------------------------------------------------------------------------


def test_employee_session_resolves_to_repo_workspace(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setattr(wpg, "_resolve_employee_workspace_root", lambda runtime=None: str(repo))

    rt = _Rt({"thread_id": "duty-thread"})
    out = resolve_search_workspace_root(runtime=rt)
    assert isinstance(out, tuple)
    root, tid = out
    # 必须落在岗位仓库，而不是 profile 目录
    assert Path(root) == repo.resolve()
    assert tid == "duty-thread"


def test_session_local_workspace_root_still_wins_over_employee_tier(tmp_path, monkeypatch):
    bound = tmp_path / "bound"
    bound.mkdir()
    emp = tmp_path / "emp"
    emp.mkdir()
    monkeypatch.setattr(wpg, "_resolve_employee_workspace_root", lambda runtime=None: str(emp))

    rt = _Rt({"local_workspace_root": str(bound), "thread_id": "t1"})
    root, _tid = resolve_search_workspace_root(runtime=rt)
    assert Path(root) == bound.resolve()


def test_cached_resolver_requires_existing_directory(tmp_path, monkeypatch):
    from evoflow.proactive.employee_prompting import identity as ident_mod

    monkeypatch.setattr(
        ident_mod, "resolve_employee_identity",
        lambda code: {"code": code, "workspace_path": str(tmp_path / "nope")},
    )
    assert wpg._employee_workspace_root_cached("ghost-bot") == ""

    good = tmp_path / "good"
    good.mkdir()
    monkeypatch.setattr(
        ident_mod, "resolve_employee_identity",
        lambda code: {"code": code, "workspace_path": str(good)},
    )
    assert Path(wpg._employee_workspace_root_cached("ghost-good")) == good.resolve()


def test_non_employee_codes_never_take_employee_tier(monkeypatch):
    from evoflow.authz import agent_actor

    for label in ("main", "lead_agent", "auto", ""):
        monkeypatch.setattr(agent_actor, "agent_actor_from_runtime", lambda runtime=None, code=label: code)
        assert wpg._resolve_employee_workspace_root() == ""


def test_agent_actor_exception_degrades_to_empty(monkeypatch):
    import evoflow.authz.agent_actor as aa

    def _boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(aa, "agent_actor_from_runtime", _boom)
    assert wpg._resolve_employee_workspace_root() == ""


# ---------------------------------------------------------------------------
# 断言组 2：非员工会话行为零变化
# ---------------------------------------------------------------------------


def test_non_employee_thread_sandbox_unchanged(monkeypatch):
    # 确保员工一级对 main/无 actor 会话返回空 → 走原 thread sandbox 分支
    from evoflow.authz import agent_actor
    from evoflow.code_index import store

    monkeypatch.setattr(agent_actor, "agent_actor_from_runtime", lambda runtime=None: "main")
    sentinel = Path("Z:/sentinel/sandbox")
    monkeypatch.setattr(store, "resolve_index_root", lambda *, workspace_root=None, thread_id=None: sentinel)
    rt = _Rt({"thread_id": "thread-abc"})
    out = resolve_search_workspace_root(runtime=rt)
    assert isinstance(out, tuple)
    assert Path(out[0]) == sentinel
    assert out[1] == "thread-abc"


def test_non_employee_no_thread_returns_error_string(monkeypatch):
    from evoflow.authz import agent_actor

    monkeypatch.setattr(agent_actor, "agent_actor_from_runtime", lambda runtime=None: "")
    out = resolve_search_workspace_root(runtime=_Rt({}))
    assert out == NO_WORKSPACE_BOUND


def test_all_four_consumer_tools_share_the_single_function():
    # 影响面锁定：rg / find_file / glob_grep / bash_tool / search_code_index 全部
    # 引用同一 resolve_search_workspace_root，本测试防将来有人复制分叉实现。
    import importlib

    mod_names = [
        "evoflow.tools.host_direct.rg",
        "evoflow.tools.host_direct.find_file",
        "evoflow.tools.host_direct.search_code_index",
        "evoflow.tools.zcode_port.bash_tool",
        "evoflow.tools.zcode_port.glob_grep",
    ]
    for name in mod_names:
        m = importlib.import_module(name)
        src = Path(inspect.getsourcefile(m)).read_text(encoding="utf-8")
        assert "resolve_search_workspace_root" in src, name
