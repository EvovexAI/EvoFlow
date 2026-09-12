"""Dedicated model summaries for tool outputs (medium tier + history aging)."""

from __future__ import annotations

import logging
import re

from evoflow.config.tool_results_config import get_tool_results_config, tool_result_compression_active, tool_uses_llm_summary
from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model, invoke_internal_chat_model
from evoflow.context.tool_summary_prompts import (
    build_single_tool_summary_prompt,
    build_tool_history_batch_prompt,
    fields_to_summary_body,
    parse_structured_summary_fields,
)
from evoflow.context.tool_tokens import count_tool_tokens

logger = logging.getLogger(__name__)

_SUMMARY_PREFIX = "[tool:summary]"
TOOL_HISTORY_PREFIX = "[tool:history]"
_PERSISTED_MARKERS = (
    "[ToolResult persisted",
    "[ToolResult summary",
    _SUMMARY_PREFIX,
    "Full output:",
    "Persisted output:",
)

_READ_TOOLS = frozenset(
    {
        "read_file",
        "grep",
        "search_code_index",
        "search_content",
    }
)
_SHELL_TOOLS = frozenset({"bash", "terminal", "run_terminal_cmd"})


def is_frozen_tool_history(content: str) -> bool:
    text = (content or "").strip()
    return text.startswith(TOOL_HISTORY_PREFIX)


def is_already_shaped(content: str) -> bool:
    text = (content or "").strip()
    if not text:
        return True
    if text == "[Old tool output cleared to save context space]":
        return True
    if is_frozen_tool_history(text):
        return True
    return any(m in text for m in _PERSISTED_MARKERS) or text.startswith(_SUMMARY_PREFIX)


def format_structured_summary(
    *,
    tool_name: str,
    body: str,
    path: str | None = None,
    ref_path: str | None = None,
    line_hint: str | None = None,
) -> str:
    if not tool_result_compression_active():
        lines: list[str] = []
        if path:
            lines.append(f"File: {path}")
        if line_hint:
            lines.append(f"lines: {line_hint}")
        if body:
            lines.append(str(body).strip())
        if ref_path:
            lines.append(f"Full output: {ref_path}")
        return "\n".join(lines).strip()

    lines = [f"{_SUMMARY_PREFIX} tool={tool_name}"]
    if path:
        lines.append(f"path: {path}")
    if line_hint:
        lines.append(f"lines: {line_hint}")
    lines.append(f"core: {(body or '').strip()}")
    if ref_path:
        lines.append(f"ref: {ref_path} (read_file with offset/limit)")
    return "\n".join(lines)


def _rule_summary_shell(content: str, tool_name: str) -> str:
    lines = content.splitlines()
    err_lines = [ln for ln in lines if re.search(r"(?i)error|exception|traceback|failed", ln)]
    tail = lines[-30:] if len(lines) > 30 else lines
    parts: list[str] = []
    if err_lines:
        parts.append("errors: " + "; ".join(ln.strip()[:200] for ln in err_lines[:5]))
    parts.append("tail:\n" + "\n".join(tail))
    body = "\n".join(parts)
    cap = get_tool_results_config().summary_max_chars
    if len(body) > cap:
        body = body[: cap - 1] + "…"
    return format_structured_summary(tool_name=tool_name, body=body)


def _rule_summary_read(content: str, tool_name: str) -> str:
    lines = content.splitlines()
    head = "\n".join(lines[:12])
    if len(head) > 600:
        head = head[:600] + "…"
    n = len(lines)
    body = f"{head}\n… ({n} lines, {len(content):,} chars)"
    return format_structured_summary(tool_name=tool_name, body=body)


def _llm_summary_to_structured(text: str, tool_name: str) -> str:
    fields = parse_structured_summary_fields(text)
    path = fields.get("path")
    path = None if path and path.lower() in ("无", "none", "n/a") else path
    line_hint = fields.get("lines")
    line_hint = None if line_hint and line_hint.lower() in ("无", "none", "n/a") else line_hint
    ref = fields.get("refs")
    ref = None if ref and ref.lower() in ("无", "none", "n/a") else ref
    body = fields_to_summary_body(fields)
    return format_structured_summary(
        tool_name=tool_name,
        body=body,
        path=path,
        ref_path=ref,
        line_hint=line_hint,
    )


def _build_llm_prompt(content: str, tool_name: str) -> str:
    cfg = get_tool_results_config()
    return build_single_tool_summary_prompt(
        content,
        tool_name,
        target_chars=cfg.llm_summary_target_chars,
        input_cap=min(len(content), cfg.llm_summary_max_input_chars),
    )


def summarize_tool_result_sync(content: str, tool_name: str) -> str | None:
    """Blocking LLM summary; returns None if disabled or failed."""
    if not tool_uses_llm_summary(tool_name):
        return None
    cfg = get_tool_results_config()
    try:
        from evoflow.models import create_chat_model

        model_name = cfg.tool_summary_model_name or cfg.llm_summary_model_name
        model = create_chat_model(
            name=model_name,
            thinking_enabled=False,
            invocation_kind="tool_summary",
        )
        resp = invoke_internal_chat_model(model, _build_llm_prompt(content, tool_name))
        text = str(getattr(resp, "content", "") or resp).strip()
        if not text:
            return None
        out = _llm_summary_to_structured(text, tool_name)
        cap = cfg.summary_max_chars
        if len(out) > cap:
            out = out[: cap - 1] + "…"
        return out
    except Exception as e:
        logger.debug("tool summary LLM failed: %s", e)
        return None


async def summarize_tool_result_async(content: str, tool_name: str) -> str | None:
    if not tool_uses_llm_summary(tool_name):
        return None
    cfg = get_tool_results_config()
    try:
        from evoflow.models import create_chat_model

        model_name = cfg.tool_summary_model_name or cfg.llm_summary_model_name
        model = create_chat_model(
            name=model_name,
            thinking_enabled=False,
            invocation_kind="tool_summary",
        )
        resp = await ainvoke_internal_chat_model(
            model,
            [{"role": "user", "content": _build_llm_prompt(content, tool_name)}],
        )
        text = str(getattr(resp, "content", "") or resp).strip()
        if not text:
            return None
        out = _llm_summary_to_structured(text, tool_name)
        cap = cfg.summary_max_chars
        if len(out) > cap:
            out = out[: cap - 1] + "…"
        return out
    except Exception as e:
        logger.debug("tool summary LLM async failed: %s", e)
        return None


def summarize_tool_result_for_history(
    content: str,
    tool_name: str,
    *,
    prefer_llm: bool = True,
) -> str:
    """Sync summary for history aging (rule first; LLM only for whitelist tools)."""
    if not tool_result_compression_active():
        return content
    name = str(tool_name or "tool").strip().lower()
    if name in _SHELL_TOOLS:
        return _rule_summary_shell(content, name)
    if name in _READ_TOOLS:
        rule = _rule_summary_read(content, name)
        if prefer_llm and tool_uses_llm_summary(name) and count_tool_tokens(content) > get_tool_results_config().tier_small_tokens:
            llm = summarize_tool_result_sync(content, name)
            if llm:
                return llm
        return rule
    if prefer_llm and tool_uses_llm_summary(name):
        llm = summarize_tool_result_sync(content, name)
        if llm:
            return llm
    body = content[: get_tool_results_config().summary_max_chars]
    if len(content) > len(body):
        body += f"… ({len(content):,} chars)"
    return format_structured_summary(tool_name=name, body=body)


async def summarize_tool_history_batch_async(combined_content: str) -> str | None:
    """LLM summary for a batch of cold-zone tools (background only; whitelist tools only)."""
    cfg = get_tool_results_config()
    if not cfg.llm_summary_enabled:
        return None
    prompt = build_tool_history_batch_prompt(
        combined_content,
        target_chars=max(cfg.llm_summary_target_chars * 2, 400),
        input_cap=min(len(combined_content), cfg.llm_summary_max_input_chars),
    )
    try:
        from evoflow.models import create_chat_model

        model = create_chat_model(
            cfg.tool_summary_model_name or cfg.llm_summary_model_name,
            thinking_enabled=False,
            invocation_kind="tool_summary",
        )
        resp = await ainvoke_internal_chat_model(model, [{"role": "user", "content": prompt}])
        text = str(getattr(resp, "content", "") or resp).strip()
        if not text.startswith(TOOL_HISTORY_PREFIX):
            text = f"{TOOL_HISTORY_PREFIX} merged_tools=?\n{text}"
        return text[: min(cfg.summary_max_chars, 2000)]
    except Exception as e:
        logger.debug("tool history batch LLM failed: %s", e)
        return None


async def summarize_tool_result_for_history_async(
    content: str,
    tool_name: str,
    *,
    prefer_llm: bool = True,
) -> str:
    if not tool_result_compression_active():
        return content
    name = str(tool_name or "tool").strip().lower()
    if name in _SHELL_TOOLS:
        return _rule_summary_shell(content, name)
    if name in _READ_TOOLS:
        if prefer_llm and tool_uses_llm_summary(name) and count_tool_tokens(content) > get_tool_results_config().tier_small_tokens:
            llm = await summarize_tool_result_async(content, name)
            if llm:
                return llm
        return _rule_summary_read(content, name)
    if prefer_llm and tool_uses_llm_summary(name):
        llm = await summarize_tool_result_async(content, name)
        if llm:
            return llm
    body = content[: get_tool_results_config().summary_max_chars]
    if len(content) > len(body):
        body += f"… ({len(content):,} chars)"
    return format_structured_summary(tool_name=name, body=body)
