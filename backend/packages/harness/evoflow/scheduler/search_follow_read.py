"""After code-index search: ranked path catalog + model-controlled paginated read_file rows."""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from evoflow.config.agent_orchestration_config import get_agent_orchestration_config, is_hybrid_mode
from evoflow.scheduler.engine import format_prefetch_context_xml
from evoflow.scheduler.prefetch_stream import (
    capture_stream_writer,
    emit_prefetch_tool_calls_batch,
    emit_prefetch_tool_result,
    scheduler_read_tool_call_id,
)
from evoflow.scheduler.tool_executor import log_scheduler_invocation

logger = logging.getLogger(__name__)

_STREAM_PREFIX = "search-read"
_INVOCATION_SOURCE = "post_search"
_FTS_SNIPPET_TAG_RE = re.compile(r"</?b>", re.IGNORECASE)


@dataclass(frozen=True)
class PostSearchReadTarget:
    abs_path: str
    rel_path: str
    anchor_line: int | None = None
    hit_snippet: str | None = None


def _normalize_rel(rel: str) -> str:
    return str(rel or "").strip().replace("\\", "/")


def read_targets_from_search_data(
    data: dict[str, Any],
    workspace_root: str,
    *,
    max_files: int,
) -> list[PostSearchReadTarget]:
    """Ranked read targets from ``search_index`` (symbols first, then hits, then graph neighbors)."""
    root = str(workspace_root or "").strip()
    if not root:
        return []
    cap = max(1, int(max_files))
    root_path = Path(root)
    targets: list[PostSearchReadTarget] = []
    seen: set[str] = set()

    def add_rel(rel: str, *, anchor_line: int | None = None, hit_snippet: str | None = None) -> bool:
        rel = _normalize_rel(rel)
        if not rel or rel in seen:
            return False
        seen.add(rel)
        line = int(anchor_line) if anchor_line and int(anchor_line) > 0 else None
        snippet = str(hit_snippet or "").strip() or None
        targets.append(
            PostSearchReadTarget(
                abs_path=str(root_path / rel),
                rel_path=rel,
                anchor_line=line,
                hit_snippet=snippet,
            )
        )
        return len(targets) >= cap

    for row in data.get("symbols") or []:
        if add_rel(str(row.get("path") or ""), anchor_line=int(row.get("line") or 0) or None):
            return targets

    for row in data.get("hits") or []:
        if add_rel(str(row.get("path") or ""), hit_snippet=str(row.get("snippet") or "")):
            return targets

    for row in data.get("related_files") or []:
        if add_rel(str(row.get("path") or "")):
            return targets

    for row in list(data.get("imported_by") or []) + list(data.get("internal_ref_users") or []) + list(data.get("imports") or []) + list(data.get("type_supertypes") or []) + list(data.get("type_subtypes") or []):
        rel = str(row.get("from_path") or row.get("to_path") or "").strip()
        line = int(row.get("line") or 0) or None
        if add_rel(rel, anchor_line=line):
            return targets

    return targets


def paths_from_search_data(
    data: dict[str, Any],
    workspace_root: str,
    *,
    max_files: int,
) -> list[str]:
    """Pick absolute paths to read from a ``search_index`` result (symbols first, then hits)."""
    return [t.abs_path for t in read_targets_from_search_data(data, workspace_root, max_files=max_files)]


def hybrid_search_scheduler_enabled() -> bool:
    if not is_hybrid_mode():
        return False
    return bool(get_agent_orchestration_config().hybrid.read_search_via_scheduler)


def format_read_catalog(targets: list[PostSearchReadTarget] | list[str], *, workspace_root: str) -> str:
    """Numbered path list for model pagination (read_offset / read_limit)."""
    if not targets:
        return ""
    root = Path(workspace_root)
    lines = [
        "Read catalog (0-based index; prefer read_file on the top 1-2 most relevant paths):",
        "Optional batch prefetch: read_offset + read_limit on search_code_index (max 4; returns anchored snippets, not whole files).",
        "",
    ]
    for i, item in enumerate(targets):
        if isinstance(item, PostSearchReadTarget):
            rel = item.rel_path
            if item.anchor_line:
                rel = f"{rel}:{item.anchor_line}"
        else:
            abs_p = str(item)
            try:
                rel = Path(abs_p).resolve().relative_to(root.resolve()).as_posix()
            except ValueError:
                rel = abs_p.replace("\\", "/")
        lines.append(f"  [{i}] {rel}")
    n = len(targets)
    lines.append("")
    lines.append(f"Total ranked paths: {n}. Examples: read_file on [0] or [1]; optional batch read_offset=0 read_limit=2 (indices 0-1).")
    lines.append(
        "If the user asked to fix/implement code: read_file on top catalog paths, then use these paths in a follow-up worker edit task — search alone is not completion."
    )
    lines.append("Next: read_file on the top 1-2 catalog paths before editing.")
    return "\n".join(lines)


def _line_for_hit_snippet(text: str, snippet: str) -> int | None:
    clean = _FTS_SNIPPET_TAG_RE.sub("", str(snippet or "")).replace("…", "").strip()
    if len(clean) < 6:
        return None
    needles = [clean[:80], clean[:40], clean[:24]]
    for needle in needles:
        if len(needle) < 6:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if needle in line:
                return i
    return None


def _read_window_for_target(target: PostSearchReadTarget) -> tuple[int, int]:
    hybrid = get_agent_orchestration_config().hybrid
    ctx_before = int(hybrid.post_search_read_context_before)
    ctx_after = int(hybrid.post_search_read_context_after)
    fallback_lines = int(hybrid.post_search_read_fallback_lines)

    anchor = target.anchor_line
    if not anchor and target.hit_snippet:
        try:
            text = Path(target.abs_path).read_text(encoding="utf-8", errors="replace")
            anchor = _line_for_hit_snippet(text, target.hit_snippet)
        except OSError:
            anchor = None

    if anchor and anchor > 0:
        offset = max(1, anchor - ctx_before)
        limit = ctx_before + ctx_after + 1
        return offset, limit
    return 1, fallback_lines


def read_target_snippet(target: PostSearchReadTarget) -> str:
    from evoflow.tools.host_direct.read_logic import read_file_content

    offset, limit = _read_window_for_target(target)
    return read_file_content(target.abs_path, offset=offset, limit=limit, use_cache=False)


async def parallel_read_paths_for_ui_async(
    paths: list[str],
    *,
    workspace_root: str,
    thread_id: str | None,
    stream_prefix: str = _STREAM_PREFIX,
    invocation_source: str = _INVOCATION_SOURCE,
    batch_offset: int = 0,
    stream_writer: object | None = None,
    emit_stream_events: bool = True,
    log_to_observability: bool = True,
    read_targets: list[PostSearchReadTarget] | None = None,
) -> list[tuple[str, str]]:
    """Emit one ``read_file`` tool row per path, read in parallel, return (path, text) pairs."""
    from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path, runtime_with_workspace

    if not paths:
        return []

    target_by_abs = {t.abs_path: t for t in (read_targets or [])}
    cfg = get_agent_orchestration_config().local_scheduler
    sem = asyncio.Semaphore(cfg.max_io_concurrency)
    total = len(paths)

    if emit_stream_events:
        call_rows: list[dict[str, str | int]] = []
        for i, p in enumerate(paths):
            target = target_by_abs.get(p)
            row: dict[str, str | int] = {
                "tool_call_id": scheduler_read_tool_call_id(stream_prefix, p, batch_offset + i),
                "path": p,
                "index": i + 1,
                "total": total,
                "invocation_source": invocation_source,
                "catalog_index": batch_offset + i,
            }
            if target is not None:
                offset, limit = _read_window_for_target(target)
                row["offset"] = offset
                row["limit"] = limit
            call_rows.append(row)
        emit_prefetch_tool_calls_batch(
            call_rows,
            stream_writer=stream_writer,  # type: ignore[arg-type]
        )

    rt = runtime_with_workspace(workspace_root, thread_id) if workspace_root else None

    async def _read_one(p: str, idx: int) -> tuple[str, str]:
        tc_id = scheduler_read_tool_call_id(stream_prefix, p, batch_offset + idx)
        async with sem:
            if rt is not None:
                resolved = resolve_tool_path(p, runtime=rt, must_exist=True, must_be_file=True)
                if isinstance(resolved, str):
                    return p, resolved
                p = str(resolved)
            target = target_by_abs.get(p)
            if target is None:
                target = PostSearchReadTarget(abs_path=p, rel_path=Path(p).name)
            text = await asyncio.to_thread(read_target_snippet, target)
        ok = not str(text).startswith("Error:")
        preview = text if len(text) <= 2000 else text[:2000] + "…"
        if emit_stream_events:
            emit_prefetch_tool_result(
                tool_call_id=tc_id,
                path=p,
                ok=ok,
                output_preview=preview,
                index=idx + 1,
                total=total,
                stream_writer=stream_writer,  # type: ignore[arg-type]
            )
        if log_to_observability:
            log_op = "prefetch_read" if invocation_source == "prefetch" else "post_search_read"
            log_scheduler_invocation(
                thread_id,
                log_op,
                status="success" if ok else "error",
                output_preview=preview,
            )
        return p, text

    return list(await asyncio.gather(*[_read_one(p, i) for i, p in enumerate(paths)]))


def _run_parallel_reads(
    paths: list[str],
    *,
    workspace_root: str,
    thread_id: str | None,
    batch_offset: int,
    read_targets: list[PostSearchReadTarget] | None = None,
) -> list[tuple[str, str]]:
    # ``search_code_index`` is sync; ``asyncio.run`` drops LangGraph contextvars — capture writer first.
    writer = capture_stream_writer()
    try:
        return asyncio.run(
            parallel_read_paths_for_ui_async(
                paths,
                workspace_root=workspace_root,
                thread_id=thread_id,
                batch_offset=batch_offset,
                stream_writer=writer,
                read_targets=read_targets,
            ),
        )
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(
                parallel_read_paths_for_ui_async(
                    paths,
                    workspace_root=workspace_root,
                    thread_id=thread_id,
                    batch_offset=batch_offset,
                    stream_writer=writer,
                    read_targets=read_targets,
                ),
            )
        finally:
            loop.close()


def follow_read_after_search(
    data: dict[str, Any],
    *,
    workspace_root: str,
    thread_id: str | None = None,
    read_offset: int = 0,
    read_limit: int = 0,
) -> str:
    """Catalog + optional paginated parallel reads (empty read block when read_limit=0)."""
    hybrid = get_agent_orchestration_config().hybrid
    catalog_cap = hybrid.post_search_path_catalog_max
    all_targets = read_targets_from_search_data(data, workspace_root, max_files=catalog_cap)
    if not all_targets:
        return ""

    blocks: list[str] = [format_read_catalog(all_targets, workspace_root=workspace_root)]

    limit = int(read_limit)
    if limit <= 0:
        return "\n\n".join(blocks)

    if not getattr(hybrid, "post_search_parallel_read_enabled", False):
        blocks.append(
            "<post_search_reads>\n"
            "Scheduler batch read is off. Use read_file(path) for paths listed in the catalog above "
            "(by index or full path). read_offset/read_limit on search_code_index are ignored until re-enabled.\n"
            "</post_search_reads>"
        )
        return "\n\n".join(blocks)

    if not hybrid_search_scheduler_enabled():
        blocks.append(
            "<post_search_reads>\n"
            "Use read_file(path) for catalog paths listed above.\n"
            "</post_search_reads>"
        )
        return "\n\n".join(blocks)

    offset = max(0, int(read_offset))
    limit = min(limit, max(0, len(all_targets) - offset))
    slice_targets = all_targets[offset : offset + limit]
    slice_paths = [t.abs_path for t in slice_targets]
    if not slice_paths:
        blocks.append(f"<post_search_reads>\nNo paths in range read_offset={offset} read_limit={limit} (catalog has {len(all_targets)} paths, valid indices 0–{len(all_targets) - 1}).\n</post_search_reads>")
        return "\n\n".join(blocks)

    snippets = _run_parallel_reads(
        slice_paths,
        workspace_root=workspace_root,
        thread_id=thread_id,
        batch_offset=offset,
        read_targets=slice_targets,
    )
    logger.info(
        "post_search_read: offset=%d limit=%d read %d/%d files under %s",
        offset,
        limit,
        len(snippets),
        len(all_targets),
        workspace_root,
    )
    body = format_prefetch_context_xml(slice_paths, list(snippets))
    blocks.append(f"<post_search_reads offset={offset} limit={limit} total_catalog={len(all_targets)}>\n{body}\n</post_search_reads>")
    if offset + limit < len(all_targets):
        remaining = len(all_targets) - offset - limit
        blocks.append(f"More catalog paths available: use read_offset={offset + limit} read_limit=<N> ({remaining} paths left in catalog) on the next search_code_index call (same query) or read_file on specific indices.")
    return "\n\n".join(blocks)
