"""Owned KB ``knowledge`` tool — unified search/read/list for the in-house RAG knowledge base.

Replaces the old Obsidian vault MCP ``knowledge`` tool. Provides a consistent interface
(search / read / list) against ``owned_service``.
"""

from __future__ import annotations

import json
from typing import Any

from langchain.tools import tool

from evoflow.knowledge.owned import service as owned_service


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _format_hit(h: dict[str, Any], index: int) -> str:
    title = h.get("title") or h.get("fileName") or h.get("docId") or f"文档{index + 1}"
    score = h.get("rrfScore") or h.get("score") or 0
    score_str = f"{float(score):.3f}" if score else "—"
    snippet = (str(h.get("content") or "")[:400]).strip()
    chunk_kind = h.get("chunkKind") or h.get("chunk_kind") or "text"
    parts = [
        f"[{index + 1}] {title}",
        f"   分数: {score_str} | 类型: {chunk_kind}",
    ]
    tags = h.get("tags") or []
    if tags:
        parts.append(f"   标签: {' '.join(str(t) for t in tags[:6])}")
    if snippet:
        parts.append(f"   {snippet}")
    return "\n".join(parts)


def _format_doc(doc: dict[str, Any]) -> str:
    title = doc.get("title") or doc.get("fileName") or doc.get("id", "未知文档")
    status = doc.get("parseStatus") or doc.get("parse_status") or "unknown"
    tags = doc.get("tags") or []
    lines = [
        f"标题: {title}",
        f"ID: {doc.get('id')}",
        f"状态: {status}",
        f"标签: {', '.join(str(t) for t in tags[:10]) or '无'}",
        f"路径: {doc.get('folderPath') or '/'} / {doc.get('fileName') or ''}",
    ]
    summary = doc.get("summaryText") or doc.get("summary_text") or ""
    if summary:
        lines.append(f"摘要: {summary[:300]}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------

_TOOL_DESCRIPTION = """**自研知识库**：在您的个人/团队知识库中搜索、阅读与列出文档。

**action=search** — 检索知识库（推荐默认操作）
- 搜索已索引的文档（关键词 + 向量混合检索）
- 知识库：留空自动搜索所有可见知识库；也可指定具体 KB ID
- 模式：hybrid（默认，兼顾关键词与语义）/ keyword / semantic
- topK：返回条数，默认 8

**action=read** — 读取文档正文
- docId 必填
- 返回正文、标签、摘要等信息

**action=list** — 列出可用的知识库
- 返回所有可见知识库名称与描述，便于后续指定 KB 检索

**注意**：写入/导入需在面板「知识库」页面操作，不在此工具范围内。
"""


@tool("knowledge", args_schema=None, parse_docstring=False)
async def knowledge_tool(
    action: str = "search",
    *,
    query: str = "",
    doc_id: str = "",
    knowledge_base: str = "",
    mode: str = "hybrid",
    top_k: int = 8,
) -> str:
    """自研知识库 — 搜索 / 阅读 / 列出知识库。

Args:
    action: 操作类型。search（默认）| read | list
    query: 搜索关键词（search 模式必填）
    doc_id: 文档 ID（read 模式必填）
    knowledge_base: 知识库 ID，留空自动搜索所有（search 模式）
    mode: 检索模式。hybrid（默认）| keyword | semantic | title
    top_k: 返回条数，默认 8，上限 20
"""
    action = (action or "search").strip().lower()

    # ── list ──────────────────────────────────────────────────────────────
    if action == "list":
        try:
            bases = owned_service.list_bases()
        except Exception as exc:
            return f"列出知识库失败: {exc}"

        if not bases:
            return "当前没有可用的知识库。请在「知识库」页面创建一个知识库并导入文档。"

        lines = [f"共 {len(bases)} 个知识库：\n"]
        for b in bases:
            lines.append(
                f"  • [{b['id']}] {b.get('name') or '未命名'}"
                f"  | 文档 {b.get('documentCount', 0)} 篇"
                f"  | 向量 {'✅' if b.get('embeddingDim') else '❌'}"
            )
            desc = b.get("description") or ""
            if desc:
                lines.append(f"    说明: {desc[:120]}")
        lines.append("\n可用 action=search&knowledge_base=<id> 指定具体知识库。")
        return "\n".join(lines)

    # ── search ─────────────────────────────────────────────────────────
    if action == "search":
        q = (query or "").strip()
        if not q:
            return "action=search 需要提供 query 参数（搜索关键词）。"

        top_k = max(1, min(int(top_k or 8), 20))
        mode = (mode or "hybrid").lower()
        if mode not in {"hybrid", "keyword", "semantic", "title"}:
            mode = "hybrid"

        kb_id = (knowledge_base or "").strip()

        try:
            if kb_id:
                result = await owned_service.search(
                    kb_id,
                    q,
                    mode=mode,
                    top_k=top_k,
                )
                base = owned_service.get_base(kb_id)
                scope_label = f"知识库「{base.get('name') or kb_id}」"
            else:
                result = await owned_service.search_all(
                    q,
                    mode=mode,
                    top_k=top_k,
                )
                scope_label = "所有知识库"
        except ValueError as exc:
            return f"搜索失败: {exc}"
        except Exception as exc:
            return f"搜索出错: {exc}"

        items = result.get("items") or []
        degraded = result.get("degraded") or False

        if not items:
            hints = [
                "没有找到相关结果。",
                f"提示: 知识库可能尚未完成索引（向量模型未就绪时自动降级为关键词检索）。",
                "可在知识库详情页检查文档状态；PDF/Office 文档需先解析完成才能被检索。",
            ]
            if degraded:
                hints.insert(1, "⚠️ 语义检索降级为关键词模式（向量索引未就绪）。")
            return "\n".join(hints)

        lines = [f"在 {scope_label} 中找到 {len(items)} 条结果（{mode} 模式）：\n"]
        for i, h in enumerate(items):
            lines.append(_format_hit(h, i))
        if degraded:
            lines.append("\n⚠️ 语义检索降级为关键词模式（向量索引未就绪）。")
        return "\n".join(lines)

    # ── read ────────────────────────────────────────────────────────────
    if action == "read":
        did = (doc_id or "").strip()
        if not did:
            return "action=read 需要提供 doc_id 参数（文档 ID）。"

        try:
            content = owned_service.get_document_content(did)
        except Exception as exc:
            return f"读取文档失败: {exc}"

        if not content:
            return f"未找到文档 doc_id={did}，或文档已被删除。"

        title = content.get("title") or content.get("fileName") or did
        lines = [
            f"=== {title} ===",
            f"ID: {did}",
            f"来源: {content.get('source', 'unknown')}",
            f"标签: {', '.join(str(t) for t in (content.get('tags') or [])[:12]) or '无'}",
        ]
        summary = content.get("summaryText") or ""
        if summary:
            lines.append(f"摘要: {summary[:300]}")
        body = content.get("content") or ""
        if body:
            lines.append(f"\n--- 正文（前 6000 字）---\n{body[:6000]}")
            if len(body) > 6000:
                lines.append(f"\n...（正文共 {len(body)} 字，已截断）")
        else:
            lines.append("\n（正文为空：文档可能还在解析中，或来源类型不支持预览）")
        return "\n".join(lines)

    # ── unknown action ────────────────────────────────────────────────
    return (
        f"未知 action={action}。支持的 action：search / read / list。"
        "\n示例: knowledge(action='search', query='项目架构', top_k=5)"
        "\n示例: knowledge(action='list')"
        "\n示例: knowledge(action='read', doc_id='doc_xxx')"
    )
