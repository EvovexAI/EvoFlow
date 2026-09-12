"""Large tool result persistence — saves oversized outputs to files."""

from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path

from evoflow.config.tool_results_config import get_tool_results_config, tool_uses_llm_summary

logger = logging.getLogger(__name__)

_PERSISTED_DIR_NAME = "large_tool_results"


def _get_store_dir() -> Path:
    base = Path(os.environ.get("EVOFLOW_DATA_DIR", Path.home() / ".evoflow"))
    store_dir = base / _PERSISTED_DIR_NAME
    store_dir.mkdir(parents=True, exist_ok=True)
    return store_dir


def _prune_old_files(store_dir: Path) -> None:
    cfg = get_tool_results_config()
    if not cfg.enabled:
        return
    now = time.time()
    cutoff = now - (cfg.max_age_hours * 3600)
    for f in store_dir.iterdir():
        if f.is_file() and f.stat().st_mtime < cutoff:
            try:
                f.unlink()
            except OSError:
                pass


def build_head_summary(content: str) -> str:
    cfg = get_tool_results_config()
    lines = content.splitlines()
    head = "\n".join(lines[: cfg.summary_head_lines])
    if len(head) > cfg.summary_max_chars:
        head = head[: cfg.summary_max_chars] + "…"
    total_lines = len(lines)
    return f"{head}\n… ({len(content):,} chars, {total_lines:,} lines total)"


def _llm_summary(content: str, tool_name: str) -> str | None:
    cfg = get_tool_results_config()
    if not tool_uses_llm_summary(tool_name):
        return None
    cap = min(len(content), cfg.llm_summary_max_input_chars)
    snippet = content[:cap]
    try:
        from evoflow.models import create_chat_model

        model = create_chat_model(
            cfg.tool_summary_model_name or cfg.llm_summary_model_name,
            thinking_enabled=False,
            invocation_kind="tool_summary",
        )
        prompt = f"Summarize this {tool_name} tool output in 2-4 sentences for an AI agent. Focus on facts needed to continue work. Output plain text only.\n\n{snippet}"
        resp = model.invoke(prompt)
        text = getattr(resp, "content", "") or str(resp)
        text = str(text).strip()
        return text[: cfg.summary_max_chars] if text else None
    except Exception as e:
        logger.debug("LLM tool summary failed: %s", e)
        return None


_PRESERVE_FULL_INLINE_TOOLS = frozenset({"read_file", "read_files", "list_agents", "list_assignable_tools"})

# TEMP: set True to re-enable disk offload for oversized tool results.
_LARGE_RESULT_OFFLOAD_ENABLED = False


def maybe_persist(
    content: str,
    tool_name: str,
    tool_call_id: str,
    *,
    thread_id: str | None = None,
) -> str:
    """Persist *content* when over threshold; return summary + path reference."""
    cfg = get_tool_results_config()
    n = len(content)
    if not cfg.enabled:
        return content

    if n <= cfg.threshold_chars:
        return content

    if not _LARGE_RESULT_OFFLOAD_ENABLED:
        return content

    content_hash = hashlib.md5(content.encode("utf-8")).hexdigest()[:12]
    safe_name = tool_name.replace("/", "_").replace(" ", "_")
    filename = f"{safe_name}_{tool_call_id}_{content_hash}.txt"
    store_dir = _get_store_dir()
    filepath = store_dir / filename

    try:
        _prune_old_files(store_dir)
        filepath.write_text(content, encoding="utf-8")
        if thread_id:
            from evoflow.context.context_ref_lru import register_ref

            register_ref(thread_id, str(filepath), n)
        logger.info("Persisted large tool result (%d chars) to %s", n, filepath)
        summary = _llm_summary(content, tool_name) or build_head_summary(content)
        return (
            f"[ToolResult persisted — {tool_name}]\n{summary}\n\n"
            f"Full output: {filepath}\n"
            f"Use read_file(path='{filepath}', offset=…, limit=…) for on-demand loading."
        )
    except OSError as e:
        logger.warning("Failed to persist large tool result to %s: %s", filepath, e)
        cap = min(cfg.summary_max_chars, n)
        return content[:cap] + f"\n\n… [persist failed, total {n:,} chars]"
