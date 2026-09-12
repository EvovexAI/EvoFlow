"""Search indexed workspace via FTS5 + symbols."""

from __future__ import annotations

import atexit
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError

from langchain.tools import ToolRuntime, tool

from evoflow.tools.minimal_schema import SEARCH_CODE_INDEX_DESCRIPTION

_MAX_WALL_SECONDS = 45.0
_MAX_READ_WALL_SECONDS = 15.0
_MAX_READ_LIMIT = 4

_SEARCH_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="search-code-index")
atexit.register(lambda: _SEARCH_POOL.shutdown(wait=False, cancel_futures=True))


def _cap_read_limit(read_limit: int, read_offset: int) -> tuple[int, str]:
    """Return (capped read_limit, optional hint suffix)."""
    if read_limit <= _MAX_READ_LIMIT:
        return read_limit, ""
    return (
        _MAX_READ_LIMIT,
        (
            f"\n\n[hint] read_limit capped at {_MAX_READ_LIMIT}; "
            f"use read_offset={read_offset + _MAX_READ_LIMIT} on a follow-up call to continue."
        ),
    )


def _run_search_index_lookup(
    *,
    root: str,
    thread_id: str | None,
    query: str,
    queries: list[str] | str | None,
    limit: int,
) -> tuple[str | None, dict | None]:
    """Run FTS/symbol search only. Returns (user_message, data) — one side is always None."""
    from evoflow.code_index.store import merge_search_queries, search_index
    from evoflow.tools.arg_coerce import normalize_search_query_inputs

    primary, extra = normalize_search_query_inputs(query, queries)
    label, _explicit = merge_search_queries(primary, queries=extra)
    if not label:
        return "Error: provide `query` (e.g. `飞书|feishu|lark`) and/or `queries`.", None

    data = search_index(root or None, primary, queries=extra, thread_id=thread_id, limit=limit)
    hits = data.get("hits") or []
    symbols = data.get("symbols") or []
    related = data.get("related_files") or []
    imported_by = data.get("imported_by") or []
    imports = data.get("imports") or []
    ref_users = data.get("internal_ref_users") or []
    type_supers = data.get("type_supertypes") or []
    type_subs = data.get("type_subtypes") or []
    if not hits and not symbols and not related and not imported_by and not imports and not ref_users and not type_supers and not type_subs:
        from evoflow.code_index.store import index_status

        st = index_status(workspace_root=root or None, thread_id=thread_id)
        if st.get("building"):
            return (
                f"No index hits for '{label}' yet — workspace index is still building. "
                "Retry search_code_index in a few seconds.",
                None,
            )
        if not st.get("ready"):
            return (
                f"No index hits for '{label}'. Workspace index is not ready — "
                "open the project in EvoPanel (index build) or wait for background indexing.",
                None,
            )
        return (
            f"No index hits for '{label}'. Try pipe synonyms (dall-e|dalle), shorter symbols, "
            "or read_file on likely paths after index miss.",
            None,
        )
    data["label"] = label
    return None, data


def _format_search_data(data: dict, *, limit: int, verbose: bool = False) -> str:
    from evoflow.code_index.format_results import format_search_index_body

    label = str(data.get("label") or data.get("query") or "")
    return format_search_index_body(
        {
            "hits": data.get("hits") or [],
            "symbols": data.get("symbols") or [],
            "related_files": data.get("related_files") or [],
            "imported_by": data.get("imported_by") or [],
            "imports": data.get("imports") or [],
            "internal_ref_users": data.get("internal_ref_users") or [],
            "type_supertypes": data.get("type_supertypes") or [],
            "type_subtypes": data.get("type_subtypes") or [],
            "path_prefix": data.get("path_prefix"),
            "path_scope_relaxed": data.get("path_scope_relaxed"),
        },
        label=label,
        limit=limit,
        rebuild_in_progress=bool(data.get("rebuild_in_progress")),
        verbose=verbose,
    )


def _follow_read_with_timeout(
    *,
    data: dict,
    read_root: str,
    thread_id: str | None,
    read_offset: int,
    read_limit: int,
) -> str:
    from evoflow.scheduler.search_follow_read import follow_read_after_search

    def _reads() -> str:
        return follow_read_after_search(
            data,
            workspace_root=read_root,
            thread_id=thread_id,
            read_offset=read_offset,
            read_limit=read_limit,
        )

    try:
        fut = _SEARCH_POOL.submit(_reads)
        extra_reads = fut.result(timeout=_MAX_READ_WALL_SECONDS)
    except FuturesTimeoutError:
        return (
            f"\n\n[hint] post-search reads timed out after {int(_MAX_READ_WALL_SECONDS)}s; "
            "use read_file on catalog paths or lower read_limit."
        )
    except Exception as e:
        return f"\n\n[hint] post-search reads failed: {e}"
    return f"\n\n{extra_reads}" if extra_reads else ""


def _search_code_index_wallclock(
    *,
    root: str,
    thread_id: str | None,
    query: str,
    queries: list[str] | str | None,
    read_offset: int,
    read_limit: int,
    limit: int,
    verbose: bool = False,
) -> str:
    """Run indexed search with a wall-clock timeout; batch reads use a separate budget."""
    try:
        fut = _SEARCH_POOL.submit(
            _run_search_index_lookup,
            root=root,
            thread_id=thread_id,
            query=query,
            queries=queries,
            limit=limit,
        )
        msg, data = fut.result(timeout=_MAX_WALL_SECONDS)
    except FuturesTimeoutError:
        return (
            f"Error: search_code_index timed out after {int(_MAX_WALL_SECONDS)}s. "
            "Lower read_limit (max 4), narrow query, or paginate with read_offset."
        )
    except Exception as e:
        return f"Error: search_code_index failed: {e}"

    if msg is not None:
        return msg
    assert data is not None

    out = _format_search_data(data, limit=limit, verbose=verbose)

    read_root = root
    if not read_root and thread_id:
        try:
            from evoflow.code_index.store import resolve_index_root

            read_root = str(resolve_index_root(workspace_root=None, thread_id=thread_id))
        except ValueError:
            read_root = ""
    if read_root:
        out += _follow_read_with_timeout(
            data=data,
            read_root=read_root,
            thread_id=thread_id,
            read_offset=read_offset,
            read_limit=read_limit,
        )
    elif read_limit > 0:
        out += "\n\n[hint] post-search reads skipped: workspace root unavailable."
    return out


@tool("search_code_index", description=SEARCH_CODE_INDEX_DESCRIPTION, parse_docstring=False)
def search_code_index_hd(
    query: str = "",
    queries: list[str] | str | None = None,
    *,
    read_offset: int = 0,
    read_limit: int = 0,
    limit: int = 15,
    verbose: bool = False,
    runtime: ToolRuntime,
) -> str:
    """Search the workspace code index."""
    try:
        read_offset = int(read_offset)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        read_offset = 0
    try:
        read_limit = int(read_limit)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        read_limit = 0
    read_offset = max(0, read_offset)
    read_limit = max(0, read_limit)
    read_limit, read_cap_note = _cap_read_limit(read_limit, read_offset)

    from evoflow.tools.host_direct.workspace_path_guard import resolve_search_workspace_root

    resolved = resolve_search_workspace_root(runtime=runtime)
    if isinstance(resolved, str):
        return resolved
    root, thread_id = resolved

    tid = str(thread_id or "").strip()
    if runtime is not None and getattr(runtime, "context", None):
        tid = str(runtime.context.get("thread_id") or tid or "").strip()
    if tid:
        from evoflow.exploration.exploration_budget import check_tool_budget

        budget_err = check_tool_budget(tid, "search_code_index", {"query": query})
        if budget_err:
            return budget_err

    return _search_code_index_wallclock(
        root=root,
        thread_id=thread_id,
        query=query,
        queries=queries,
        read_offset=read_offset,
        read_limit=read_limit,
        limit=limit,
        verbose=verbose,
    ) + read_cap_note
