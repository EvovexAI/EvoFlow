"""Deprecated: uploaded-document RAG. Use Obsidian Knowledge Vault ``knowledge`` tool."""

from __future__ import annotations

from langchain.tools import tool

_DEPRECATION = (
    "「上传文档」知识库已下线。请改用侧栏「知识库」（Obsidian Vault），"
    "并通过 knowledge(action=search|read|…) 检索笔记。"
)


@tool("search_knowledge_base", parse_docstring=True)
async def search_knowledge_base_tool(
    query: str,
    *,
    knowledge_base: str | None = None,
    limit: int = 5,
) -> str:
    """Deprecated — uploaded document RAG was removed.

    Use the ``knowledge`` tool against an Obsidian / Markdown vault instead.

    Args:
        query: Ignored (legacy).
        knowledge_base: Ignored (legacy).
        limit: Ignored (legacy).
    """
    _ = (query, knowledge_base, limit)
    return _DEPRECATION
