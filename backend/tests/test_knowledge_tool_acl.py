"""Employee ``knowledge`` tool must not list/search/read unbound knowledge bases."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import importlib

# ``builtins.knowledge_tool`` is shadowed by the StructuredTool re-export in
# ``__init__.py``; load the module object via importlib.
kt = importlib.import_module("evoflow.tools.builtins.knowledge_tool")


def _runtime(agent: str) -> SimpleNamespace:
    return SimpleNamespace(context={"agent_name": agent}, config={})


async def _call(**kwargs):
    """Invoke the underlying coroutine (bypass ToolRuntime graph injection)."""
    return await kt.knowledge_tool.coroutine(**kwargs)


@pytest.mark.asyncio
async def test_list_employee_only_bound_kbs():
    bases = [
        {"id": "kb_bound", "name": "产品资料库", "documentCount": 7, "embeddingDim": 1024, "description": ""},
        {"id": "kb_other", "name": "电商内容库", "documentCount": 14, "embeddingDim": 1024, "description": ""},
    ]
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt.owned_service, "list_bases", return_value=bases),
    ):
        out = await _call(action="list", runtime=_runtime("product_pm"))
    assert "kb_bound" in out
    assert "产品资料库" in out
    assert "kb_other" not in out
    assert "电商内容库" not in out
    assert "本岗已绑定" in out


@pytest.mark.asyncio
async def test_list_admin_sees_all():
    bases = [
        {"id": "kb_a", "name": "A", "documentCount": 1, "embeddingDim": 0, "description": ""},
        {"id": "kb_b", "name": "B", "documentCount": 2, "embeddingDim": 0, "description": ""},
    ]
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(True, [])),
        patch.object(kt.owned_service, "list_bases", return_value=bases),
    ):
        out = await _call(action="list", runtime=_runtime("xiaomi"))
    assert "kb_a" in out and "kb_b" in out
    assert "平台全量" in out


@pytest.mark.asyncio
async def test_search_employee_denied_unbound_kb():
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt, "_kb_allowed", return_value=False),
    ):
        out = await _call(
            action="search",
            query="定价",
            knowledge_base="kb_secret",
            runtime=_runtime("product_pm"),
        )
    assert "无权访问" in out


@pytest.mark.asyncio
async def test_search_employee_scopes_search_all():
    search_all = AsyncMock(return_value={"items": [], "degraded": False})
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt.owned_service, "search_all", search_all),
    ):
        out = await _call(action="search", query="定价", runtime=_runtime("product_pm"))
    search_all.assert_awaited_once()
    assert search_all.await_args.kwargs.get("kb_ids") == ["kb_bound"]
    assert "没有找到相关结果" in out


@pytest.mark.asyncio
async def test_search_unbound_employee_blocked():
    with patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, [])):
        out = await _call(action="search", query="定价", runtime=_runtime("intern"))
    assert "未绑定知识库" in out


@pytest.mark.asyncio
async def test_read_employee_denied_other_kb_doc():
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt.owned_service, "_kb_id_for_doc", return_value="kb_other"),
    ):
        out = await _call(action="read", doc_id="doc_x", runtime=_runtime("product_pm"))
    assert "无权读取" in out


def test_platform_admin_detection():
    assert kt._is_platform_kb_admin("main")
    assert kt._is_platform_kb_admin("xiaomi")
    assert not kt._is_platform_kb_admin("product_pm")
    assert not kt._is_platform_kb_admin("")


def test_resolve_scope_uses_vault_binding():
    with (
        patch("evoflow.config.agents_config.get_agent_kb_vault_ids", return_value=["vault-alias"]),
        patch.object(kt, "_resolve_bound_kb_id", return_value="kb_real"),
    ):
        is_admin, allowed = kt.resolve_knowledge_tool_scope("product_pm")
    assert is_admin is False
    assert allowed == ["kb_real"]
