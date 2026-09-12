"""Workspace memory policy gates."""

from __future__ import annotations

from evoflow.assets.workspace_memory_policy import (
    is_workspace_ephemeral_content,
    should_persist_workspace_asset,
    workspace_write_discipline_block,
)


def test_ephemeral_content_rejected() -> None:
    assert is_workspace_ephemeral_content("hello world test")
    assert is_workspace_ephemeral_content("本次已重写组件")
    assert not is_workspace_ephemeral_content("EvoFlow backend 使用 FastAPI Gateway 路由注册")


def test_should_persist_module_fact() -> None:
    assert should_persist_workspace_asset(
        title="Gateway 路由",
        content="backend/app/gateway 负责 HTTP 路由与中间件装配，入口 main.py。",
        category="module",
    )
    assert should_persist_workspace_asset(
        title="记忆整理队列",
        content="Phase1 扫描 inbox 后由 Phase2 LLM 合并写入 facts 与 standing。",
        category="logic",
    )


def test_discipline_block_zh() -> None:
    block = workspace_write_discipline_block(lang="zh")
    assert "module" in block
    assert "scope=workspace" in block
