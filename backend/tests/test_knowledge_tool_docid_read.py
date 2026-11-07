"""``knowledge`` tool must expose a usable docId and accept titles on ``read``.

Regression for the 2026-11-07 workflow verification run: search printed only
titles, ``action=read`` accepted only the internal ``doc_…`` id, so every
retrieval-type workflow node burned its budget guessing id formats and could
never open a document body.
"""

from __future__ import annotations

import importlib
from types import SimpleNamespace
from unittest.mock import patch

import pytest

kt = importlib.import_module("evoflow.tools.builtins.knowledge_tool")

DOC_ID = "doc_765acad041d941feaade580dc6c79c84"


def _runtime(agent: str) -> SimpleNamespace:
    return SimpleNamespace(context={"agent_name": agent}, config={})


async def _call(**kwargs):
    return await kt.knowledge_tool.coroutine(**kwargs)


_DOCS = [
    {"id": DOC_ID, "title": "create-agent", "fileName": "create-agent.md", "parseStatus": "done"},
    {"id": "doc_deadbeef0000000000000000000000ff", "title": "product-overview", "fileName": "product-overview.md", "parseStatus": "done"},
]

_CONTENT = {
    "title": "create-agent",
    "fileName": "create-agent.md",
    "source": "raw",
    "tags": [],
    "content": "# 案例二：雇佣代码审查员\n正文内容",
    "kbId": "kb_bound",
}


def test_format_hit_prints_docid():
    line = kt._format_hit({"title": "create-agent", "docId": DOC_ID, "score": 0.9, "content": "片段"}, 0)
    assert f"docId: {DOC_ID}" in line


def test_format_hit_prefers_snake_case_doc_id():
    line = kt._format_hit({"title": "x", "doc_id": DOC_ID}, 0)
    assert DOC_ID in line


def test_hit_doc_id_normalized():
    assert kt._hit_doc_id({"doc_id": DOC_ID}) == DOC_ID
    assert kt._hit_doc_id({"docId": DOC_ID}) == DOC_ID
    assert kt._hit_doc_id({"title": "no id"}) == ""


@pytest.mark.asyncio
async def test_search_output_carries_read_id():
    items = [{"title": "create-agent", "docId": DOC_ID, "content": "片段", "rrfScore": 0.9}]
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt, "_resolve_bound_kb_id", return_value="kb_bound"),
        patch.object(kt.owned_service, "get_base", return_value={"id": "kb_bound", "name": "产品资料库"}),
        patch.object(kt.owned_service, "search", new=lambda *a, **k: _async(items)),
    ):
        out = await _call(action="search", query="工作流", knowledge_base="kb_bound", runtime=_runtime("product_pm"))
    assert f"docId: {DOC_ID}" in out


async def _async(items):
    return {"items": items, "degraded": False}


@pytest.mark.asyncio
async def test_read_accepts_title_from_search():
    """The title shown by search must be readable without knowing the internal id."""
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt.owned_service, "list_documents", return_value=_DOCS) as ld,
        patch.object(kt.owned_service, "_kb_id_for_doc", return_value="kb_bound"),
        patch.object(kt.owned_service, "get_document_content", return_value=_CONTENT) as gdc,
    ):
        out = await _call(action="read", doc_id="product-overview", runtime=_runtime("product_pm"))
    assert "未找到文档" not in out
    assert "正文内容" in out
    # resolved to the real id before hitting the content store
    assert gdc.call_args[0][0] == "doc_deadbeef0000000000000000000000ff"
    # scope respected: only the bound KB was scanned
    assert ld.call_args_list[0][0][0] == "kb_bound"


@pytest.mark.asyncio
async def test_read_title_strips_md_suffix_and_case():
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt.owned_service, "list_documents", return_value=_DOCS),
        patch.object(kt.owned_service, "_kb_id_for_doc", return_value="kb_bound"),
        patch.object(kt.owned_service, "get_document_content", return_value=_CONTENT) as gdc,
    ):
        await _call(action="read", doc_id="Product Overview.MD", runtime=_runtime("product_pm"))
    assert gdc.call_args[0][0] == "doc_deadbeef0000000000000000000000ff"


@pytest.mark.asyncio
async def test_read_unknown_title_still_fails_with_hint():
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt.owned_service, "list_documents", return_value=_DOCS),
        patch.object(kt.owned_service, "_kb_id_for_doc", return_value=None),
        patch.object(kt.owned_service, "get_document_content", return_value=None),
    ):
        out = await _call(action="read", doc_id="不存在的篇目", runtime=_runtime("product_pm"))
    assert "未找到文档" in out
    assert "action=docs" in out  # tells the model how to get a real id


@pytest.mark.asyncio
async def test_read_exact_id_skips_title_scan():
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt.owned_service, "list_documents", return_value=_DOCS) as ld,
        patch.object(kt.owned_service, "_kb_id_for_doc", return_value="kb_bound"),
        patch.object(kt.owned_service, "get_document_content", return_value=_CONTENT),
    ):
        out = await _call(action="read", doc_id=DOC_ID, runtime=_runtime("product_pm"))
    assert "正文内容" in out
    ld.assert_not_called()


@pytest.mark.asyncio
async def test_docs_action_lists_ids():
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])),
        patch.object(kt, "_resolve_bound_kb_id", return_value="kb_bound"),
        patch.object(kt.owned_service, "list_documents", return_value=_DOCS),
    ):
        out = await _call(action="docs", knowledge_base="kb_bound", runtime=_runtime("product_pm"))
    assert DOC_ID in out
    assert "product-overview" in out


@pytest.mark.asyncio
async def test_docs_action_requires_kb():
    with patch.object(kt, "resolve_knowledge_tool_scope", return_value=(True, [])):
        out = await _call(action="docs", runtime=_runtime("main"))
    assert "knowledge_base" in out


@pytest.mark.asyncio
async def test_docs_action_denies_unbound_kb():
    with patch.object(kt, "resolve_knowledge_tool_scope", return_value=(False, ["kb_bound"])):
        out = await _call(action="docs", knowledge_base="kb_other", runtime=_runtime("product_pm"))
    assert "无权访问知识库" in out
