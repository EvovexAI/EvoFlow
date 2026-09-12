"""Unified write-time shaping for tool results (runtime-aligned inline truncation)."""

from __future__ import annotations

import logging
import re

from evoflow.config.tool_results_config import (
    get_tool_results_config,
    preserve_verbatim_tool_names,
    tool_result_compression_active,
    tool_result_shaping_active,
)
from evoflow.context.shaped_tool_cache import remember_shaped
from evoflow.context.tool_code_compact import compact_code_light
from evoflow.context.tool_result_summarizer import (
    format_structured_summary,
    is_already_shaped,
)
from evoflow.context.tool_tokens import count_tool_tokens
from evoflow.tools.large_result_store import maybe_persist
from evoflow.tools.tool_output_truncation import formatted_truncate_tool_output

logger = logging.getLogger(__name__)

_PREFETCH_PREVIEW_LINES = 40
_POST_SEARCH_READS_RE = re.compile(
    r"<post_search_reads\b[\s\S]*?</post_search_reads>",
    re.IGNORECASE,
)
_WORKER_CODE_READS_RE = re.compile(
    r"<worker_code_reads>[\s\S]*?</worker_code_reads>",
    re.IGNORECASE,
)
_PRESERVED_READ_BLOCK_RES = (_WORKER_CODE_READS_RE, _POST_SEARCH_READS_RE)
# Skip tiktoken when body is clearly under tier_small (≈800 tokens).
_FAST_SMALL_CHAR_BUDGET = 800 * 4


def _split_preserved_read_blocks(content: str) -> tuple[str, str]:
    """Detach code-read blocks so worker/search payloads can be shaped without dropping excerpts."""
    preserved: list[str] = []
    rest = str(content or "")
    for pattern in _PRESERVED_READ_BLOCK_RES:
        for m in pattern.finditer(rest):
            preserved.append(m.group(0).strip())
        rest = pattern.sub("", rest)
    rest = re.sub(r"\n{3,}", "\n\n", rest).strip()
    return rest, "\n\n".join(preserved)


def _split_post_search_reads(content: str) -> tuple[str, str]:
    return _split_preserved_read_blocks(content)


def _attach_preserved_read_blocks(shaped: str, preserved: str) -> str:
    if not preserved:
        return shaped
    base = str(shaped or "").rstrip()
    return f"{preserved}\n\n{base}" if base else preserved


def _attach_post_search_reads(shaped: str, post_reads: str) -> str:
    return _attach_preserved_read_blocks(shaped, post_reads)


def _measure(content: str) -> int:
    cfg = get_tool_results_config()
    if cfg.use_token_tiers:
        return count_tool_tokens(content)
    return len(content)


def _apply_inline_token_cap(body: str, max_tokens: int) -> str:
    if not body:
        return body
    if count_tool_tokens(body) <= max_tokens:
        return body
    return formatted_truncate_tool_output(body, max_tokens)


def _shape_working_body(body: str, *, tool_name: str) -> str:
    cfg = get_tool_results_config()
    if not body:
        return body

    if len(body) <= _FAST_SMALL_CHAR_BUDGET:
        return body

    if cfg.use_token_tiers:
        tokens = count_tool_tokens(body)
        if tokens <= cfg.tier_small_tokens:
            return body
        return _apply_inline_token_cap(body, cfg.tier_medium_tokens)

    medium_chars = cfg.medium_threshold_chars
    if len(body) <= medium_chars:
        return body
    cap_tokens = max(200, cfg.tier_medium_tokens)
    return formatted_truncate_tool_output(body, cap_tokens)


def format_prefetch_snippet(path: str, body: str, *, max_tokens: int | None = None) -> str:
    """Head+tail preview for prefetch (avoid head-only truncation)."""
    cfg = get_tool_results_config()
    budget = max_tokens or cfg.tier_medium_tokens
    if tool_result_shaping_active():
        shaped = _apply_inline_token_cap(body, budget)
    elif _measure(body) <= budget:
        shaped = body
    elif len(body.splitlines()) <= _PREFETCH_PREVIEW_LINES * 2:
        cap = budget * 4 if cfg.use_token_tiers else budget
        shaped = body[:cap] + ("…" if len(body) > cap else "")
    else:
        lines = body.splitlines()
        head_n = _PREFETCH_PREVIEW_LINES
        tail_n = _PREFETCH_PREVIEW_LINES
        head = "\n".join(lines[:head_n])
        tail = "\n".join(lines[-tail_n:])
        shaped = f"{head}\n… ({len(lines)} lines, {len(body):,} chars) …\n{tail}"
    if cfg.code_compact_enabled and tool_result_compression_active():
        shaped = compact_code_light(shaped)
    if tool_result_shaping_active():
        header = f"--- {path} ---\n" if path else ""
        return f"{header}{shaped}".strip() if header else shaped
    if not tool_result_compression_active():
        header = f"--- {path} ---\n" if path else ""
        return f"{header}{shaped}".strip()
    return format_structured_summary(tool_name="read_file", body=shaped, path=path)


def _maybe_read_action_hint(
    content: str,
    tool_name: str,
    *,
    thread_id: str | None,
    partial_read: bool,
) -> str:
    name = str(tool_name or "tool").strip().lower()
    if name not in ("read", "read_file", "read_files") or partial_read or not thread_id:
        return content
    try:
        from evoflow.exploration.action_bias import format_read_followup_action_hint

        hint = format_read_followup_action_hint(thread_id)
        if hint:
            return content + hint
    except Exception:
        pass
    return content


def shape_tool_result(
    content: str,
    tool_name: str,
    tool_call_id: str,
    *,
    thread_id: str | None = None,
    partial_read: bool = False,
) -> str:
    """Shape tool output before it is stored in ToolMessage.

    runtime-aligned path (``tool_result_shaping_active``): small bodies pass through;
    larger bodies get inline middle truncation with a warning header. Disk persist
    remains optional via ``cfg.enabled`` + ``maybe_persist`` for extreme payloads.
    """
    if not tool_result_shaping_active():
        return _maybe_read_action_hint(content, tool_name, thread_id=thread_id, partial_read=partial_read)
    if is_already_shaped(content):
        return content

    cfg = get_tool_results_config()
    name = str(tool_name or "tool").strip().lower()
    working_content = content
    post_reads = ""
    if name in ("search_code_index", "worker"):
        working_content, post_reads = _split_preserved_read_blocks(content)

    # Explicit read_file slice: keep inline for model/UI (do not re-persist or [tool:summary]).
    if partial_read and name in ("read", "read_file"):
        cap = max(cfg.threshold_chars // 2, 32_000)
        if len(content) > cap:
            out = content[:cap] + f"\n\n… [{len(content):,} chars in this slice; narrow limit or use next offset page]"
        else:
            out = content
        remember_shaped(thread_id or "", tool_call_id, out)
        return out

    # Agent list tools: full JSON inline (no summary / persist ref).
    if name in preserve_verbatim_tool_names():
        remember_shaped(thread_id or "", tool_call_id, content)
        return content

    # read_file / read_files: always return full body inline, no persist / no summary / no code compact.
    if name in ("read", "read_file", "read_files"):
        out = _attach_preserved_read_blocks(working_content, post_reads)
        out = _maybe_read_action_hint(out, name, thread_id=thread_id, partial_read=partial_read)
        remember_shaped(thread_id or "", tool_call_id, out)
        return out

    shaped_body = _shape_working_body(working_content, tool_name=name)

    # Optional disk offload for extreme payloads (off by default; separate from inline shaping).
    if cfg.enabled and len(shaped_body) > cfg.threshold_chars and len(working_content) > cfg.threshold_chars:
        shaped_body = maybe_persist(working_content, tool_name, tool_call_id, thread_id=thread_id)
        if count_tool_tokens(shaped_body) > cfg.tier_medium_tokens:
            shaped_body = _apply_inline_token_cap(shaped_body, cfg.tier_medium_tokens)

    out = _attach_preserved_read_blocks(shaped_body, post_reads)
    remember_shaped(thread_id or "", tool_call_id, out)
    return out
