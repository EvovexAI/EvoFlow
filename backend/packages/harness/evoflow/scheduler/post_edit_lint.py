"""After write/replace on code files: parallel read_lints UI rows + context block (like post_search_reads)."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from evoflow.config.agent_orchestration_config import get_agent_orchestration_config, is_hybrid_mode
from evoflow.scheduler.engine import format_prefetch_context_xml
from evoflow.scheduler.prefetch_stream import (
    capture_stream_writer,
    emit_prefetch_tool_calls_batch,
    emit_prefetch_tool_result,
    scheduler_read_tool_call_id,
)
from evoflow.scheduler.tool_executor import log_scheduler_invocation
from evoflow.tools.code_lint import is_lintable_code_path, lint_path_post_edit

logger = logging.getLogger(__name__)

_STREAM_PREFIX = "edit-lint"
_INVOCATION_SOURCE = "post_edit"
_TOOL_NAME = "read_lints"
_AUTO_AFTER_EDIT = os.getenv("LINT_AUTO_AFTER_EDIT", "false").strip().lower() in ("1", "true", "yes", "on")


def hybrid_post_edit_lint_enabled() -> bool:
    if not _AUTO_AFTER_EDIT:
        return False
    if not is_hybrid_mode():
        return False
    hybrid = get_agent_orchestration_config().hybrid
    return bool(getattr(hybrid, "post_edit_parallel_lint_enabled", True))


def _auto_lint_enabled() -> bool:
    return bool(getattr(get_agent_orchestration_config().hybrid, "post_edit_auto_lint_enabled", True))


async def parallel_lint_paths_for_ui_async(
    paths: list[str],
    *,
    thread_id: str | None,
    stream_prefix: str = _STREAM_PREFIX,
    invocation_source: str = _INVOCATION_SOURCE,
    stream_writer: object | None = None,
) -> list[tuple[str, str]]:
    """Emit one ``read_lints`` tool row per path, lint in parallel, return (path, text) pairs."""
    if not paths:
        return []

    cfg = get_agent_orchestration_config().local_scheduler
    sem = asyncio.Semaphore(cfg.max_io_concurrency)
    total = len(paths)

    emit_prefetch_tool_calls_batch(
        [
            {
                "tool_call_id": scheduler_read_tool_call_id(stream_prefix, p, i),
                "path": p,
                "tool_name": _TOOL_NAME,
                "index": i + 1,
                "total": total,
                "invocation_source": invocation_source,
            }
            for i, p in enumerate(paths)
        ],
        stream_writer=stream_writer,  # type: ignore[arg-type]
    )

    async def _lint_one(p: str, idx: int) -> tuple[str, str]:
        tc_id = scheduler_read_tool_call_id(stream_prefix, p, idx)
        async with sem:
            text = await asyncio.to_thread(lint_path_post_edit, p)
        ok = not str(text).startswith("Error:")
        preview = text if len(text) <= 2000 else text[:2000] + "…"
        emit_prefetch_tool_result(
            tool_call_id=tc_id,
            path=p,
            ok=ok,
            output_preview=preview,
            index=idx + 1,
            total=total,
            tool_name=_TOOL_NAME,
            stream_writer=stream_writer,  # type: ignore[arg-type]
        )
        log_scheduler_invocation(
            thread_id,
            "post_edit_lint",
            status="success" if ok else "error",
            output_preview=preview,
        )
        return p, text

    return list(await asyncio.gather(*[_lint_one(p, i) for i, p in enumerate(paths)]))


def _run_parallel_lints(
    paths: list[str],
    *,
    thread_id: str | None,
) -> list[tuple[str, str]]:
    writer = capture_stream_writer()
    try:
        return asyncio.run(
            parallel_lint_paths_for_ui_async(
                paths,
                thread_id=thread_id,
                stream_writer=writer,
            ),
        )
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(
                parallel_lint_paths_for_ui_async(
                    paths,
                    thread_id=thread_id,
                    stream_writer=writer,
                ),
            )
        finally:
            loop.close()


def follow_lint_after_edit(
    path: str,
    *,
    thread_id: str | None = None,
    workspace_root: str | None = None,
) -> str:
    """Scheduler follow-up lint block appended to write/replace tool results."""
    del workspace_root  # reserved for future workspace-scoped linters
    abs_path = str(Path(path).expanduser().resolve())
    if not is_lintable_code_path(abs_path):
        return ""

    if not hybrid_post_edit_lint_enabled():
        return ""

    hybrid = get_agent_orchestration_config().hybrid
    if not getattr(hybrid, "post_edit_parallel_lint_enabled", True):
        return "<post_edit_lints>\nScheduler batch lint is off. Call read_lints(paths) on edited code files.\n</post_edit_lints>"

    if not _auto_lint_enabled():
        return ""

    paths = [abs_path]
    snippets = _run_parallel_lints(paths, thread_id=thread_id)
    logger.info("post_edit_lint: linted %d file(s) %s", len(snippets), abs_path)
    body = format_prefetch_context_xml(paths, list(snippets))
    return f"<post_edit_lints count={len(paths)}>\n{body}\n</post_edit_lints>"
