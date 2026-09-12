"""LLM-assisted knowledge base chunking and indexing (Phase 2).

Uses the configured primary chat model to:
* semantically split unstructured documents when structure chunking is insufficient
* generate document summaries and per-chunk index lines

Falls back to rule-based :mod:`index_builder` / :mod:`wiki_chunker` on any failure.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from evoflow.config.app_config import get_app_config
from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
from evoflow.knowledge.chunker import _count_tokens
from evoflow.knowledge.index_builder import build_document_summary, enrich_chunk_indexes
from evoflow.knowledge.wiki_chunker import auto_chunk_document
from evoflow.models import create_chat_model

logger = logging.getLogger(__name__)

_MAX_LLM_INPUT_CHARS = int(os.getenv("EVOFLOW_KB_LLM_MAX_CHARS", "14000") or 14000)
_LLM_SPLIT_MIN_CHARS = int(os.getenv("EVOFLOW_KB_LLM_SPLIT_MIN_CHARS", "2500") or 2500)


def kb_llm_enabled() -> bool:
    raw = (os.environ.get("EVOFLOW_KB_LLM_ENABLED") or "1").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    try:
        cfg = get_app_config()
        return bool(getattr(cfg, "models", None))
    except Exception:
        return False


def _resolve_model_name() -> str | None:
    try:
        cfg = get_app_config()
    except Exception:
        return None
    primary = str(getattr(cfg, "primary_model", "") or "").strip()
    if primary and cfg.get_model_config(primary) is not None:
        return primary
    models = getattr(cfg, "models", None) or []
    return models[0].name if models else None


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, re.DOTALL)
    if fence:
        raw = fence.group(1)
    else:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            raw = raw[start : end + 1]
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _extract_response_text(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts).strip()
    return str(content or "").strip()


async def _invoke_llm(system: str, user: str) -> str | None:
    model_name = _resolve_model_name()
    if not model_name:
        return None
    try:
        model = create_chat_model(name=model_name, thinking_enabled=False, invocation_kind="internal")
        resp = await ainvoke_internal_chat_model(
            model,
            [SystemMessage(content=system), HumanMessage(content=user)],
        )
        text = _extract_response_text(resp)
        return text or None
    except Exception as e:
        logger.warning("KB LLM invoke failed: %s", e)
        return None


def _normalize_llm_chunks(raw_chunks: Any, *, file_name: str, source_text: str) -> list[dict]:
    if not isinstance(raw_chunks, list):
        return []
    out: list[dict] = []
    pos = 0
    for i, item in enumerate(raw_chunks):
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        start = source_text.find(content, pos)
        if start < 0:
            start = pos
        end = start + len(content)
        pos = end
        title = str(item.get("title") or "").strip()
        heading = str(item.get("heading_path") or title or file_name or f"段落 {i + 1}").strip()
        index_text = str(item.get("index_text") or heading).strip()
        out.append(
            {
                "content": content,
                "token_count": _count_tokens(content),
                "char_start": start,
                "char_end": end,
                "title": title,
                "heading_path": heading,
                "index_text": index_text,
            }
        )
    return out


def _attach_metadata(chunks: list[dict]) -> list[dict]:
    return enrich_chunk_indexes(chunks)


async def llm_semantic_chunk(text: str, *, file_name: str = "") -> tuple[str, str, list[dict]] | None:
    """Ask the primary model to split *text* into semantic sections."""
    body = text.strip()
    if not body:
        return None
    clipped = body[:_MAX_LLM_INPUT_CHARS]
    if len(body) > len(clipped):
        clipped += "\n\n[注：文档后续部分将由结构分块补充处理]"

    system = (
        "你是知识库文档分析助手。将文档按语义分成若干可读段落，并生成摘要与索引。"
        "只输出一个 JSON 对象，不要 Markdown 说明。"
    )
    user = f"""文档名：{file_name or "未命名"}

请输出 JSON：
{{
  "summary_text": "200字以内的文档摘要",
  "summary_index": "关键词1 · 关键词2 · 关键词3",
  "chunks": [
    {{
      "title": "小节标题",
      "heading_path": "章节路径 / 小节标题",
      "index_text": "便于检索的索引短语",
      "content": "该段完整正文（勿省略）"
    }}
  ]
}}

要求：
- chunks 数量 5~20，每段约 200~1200 字，边界按语义而非固定字数
- content 必须来自原文，不要编造
- 使用中文索引（除非原文是英文）

文档正文：
{clipped}
"""
    raw = await _invoke_llm(system, user)
    data = _extract_json_object(raw or "")
    if not data:
        return None
    chunks = _normalize_llm_chunks(data.get("chunks"), file_name=file_name, source_text=body)
    if not chunks:
        return None
    summary_text = str(data.get("summary_text") or "").strip()
    summary_index = str(data.get("summary_index") or "").strip()
    if not summary_text or not summary_index:
        summary_text, summary_index = build_document_summary(body, file_name=file_name)
    return summary_text, summary_index, _attach_metadata(chunks)


async def llm_enrich_chunks(
    text: str,
    chunks: list[dict],
    *,
    file_name: str = "",
) -> tuple[str, str, list[dict]] | None:
    """Generate summary + per-chunk index lines for pre-split chunks."""
    if not chunks:
        return None

    preview_parts: list[str] = []
    for i, c in enumerate(chunks[:40]):
        content = str(c.get("content") or "").strip()
        if len(content) > 900:
            content = content[:900] + "…"
        preview_parts.append(f"[{i}] {content}")
    preview = "\n\n".join(preview_parts)
    doc_head = text.strip()[:2000]

    system = "你是知识库索引助手。根据文档与已分段落，生成摘要和每段索引。只输出 JSON。"
    user = f"""文档名：{file_name or "未命名"}

文档开头：
{doc_head}

已分 {len(chunks)} 个段落（按顺序）：
{preview}

输出 JSON：
{{
  "summary_text": "200字以内摘要",
  "summary_index": "关键词1 · 关键词2",
  "chunks": [
    {{ "index_text": "该段检索索引短语", "title": "可选标题", "heading_path": "可选章节路径" }}
  ]
}}

chunks 数组长度必须等于 {len(chunks)}，顺序与输入段落一致。不要输出 content 字段。
"""
    raw = await _invoke_llm(system, user)
    data = _extract_json_object(raw or "")
    if not data:
        return None

    summary_text = str(data.get("summary_text") or "").strip()
    summary_index = str(data.get("summary_index") or "").strip()
    meta_chunks = data.get("chunks")
    if not isinstance(meta_chunks, list) or len(meta_chunks) != len(chunks):
        return None

    merged: list[dict] = []
    for i, base in enumerate(chunks):
        meta = meta_chunks[i] if isinstance(meta_chunks[i], dict) else {}
        row = dict(base)
        if meta.get("title"):
            row["title"] = str(meta["title"]).strip()
        if meta.get("heading_path"):
            row["heading_path"] = str(meta["heading_path"]).strip()
        elif row.get("title"):
            row["heading_path"] = str(row["title"])
        row["index_text"] = str(meta.get("index_text") or row.get("heading_path") or "").strip()
        merged.append(row)

    if not summary_text or not summary_index:
        fb_text, fb_index = build_document_summary(text, file_name=file_name)
        summary_text = summary_text or fb_text
        summary_index = summary_index or fb_index

    return summary_text, summary_index, _attach_metadata(merged)


async def process_document_with_llm(
    text: str,
    *,
    file_name: str = "",
    use_llm: bool | None = None,
) -> tuple[str, str, list[dict]]:
    """Full pipeline: structure chunk → optional LLM split → LLM index enrichment."""
    body = text.strip()
    if not body:
        return "", file_name or "空文档", []

    llm_on = kb_llm_enabled() if use_llm is None else bool(use_llm)

    if not llm_on:
        chunks = auto_chunk_document(body, file_name=file_name)
        summary_text, summary_index = build_document_summary(body, file_name=file_name)
        return summary_text, summary_index, enrich_chunk_indexes(chunks, file_name=file_name)

    chunks = auto_chunk_document(body, file_name=file_name)
    need_semantic_split = len(chunks) <= 1 and len(body) >= _LLM_SPLIT_MIN_CHARS

    if need_semantic_split:
        split = await llm_semantic_chunk(body, file_name=file_name)
        if split:
            return split

    enriched = await llm_enrich_chunks(body, chunks, file_name=file_name)
    if enriched:
        return enriched

    summary_text, summary_index = build_document_summary(body, file_name=file_name)
    return summary_text, summary_index, enrich_chunk_indexes(chunks, file_name=file_name)
