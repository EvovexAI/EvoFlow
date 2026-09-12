"""Invoke host_direct tools from the local scheduler."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from evoflow.scheduler.retry import retry_read, search_with_fts_fallback
from evoflow.scheduler.task_plan import TaskOp

logger = logging.getLogger(__name__)

_MAX_PREVIEW = 2000


def _preview(text: str) -> str:
    t = str(text or "")
    if len(t) <= _MAX_PREVIEW:
        return t
    return t[:_MAX_PREVIEW] + f"\n... ({len(t)} chars)"


def execute_op(
    op: TaskOp,
    *,
    workspace_root: str | None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Run a single TaskOp; returns result dict with ok/output_preview/error."""
    root = str(op.workspace_root or workspace_root or "").strip() or str(Path.cwd().resolve())
    try:
        if op.op == "read":
            from evoflow.tools.host_direct.read_logic import read_file_content
            from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path, runtime_with_workspace

            path = op.path or ""
            rt = runtime_with_workspace(root, thread_id)
            resolved = resolve_tool_path(path, runtime=rt, must_exist=True, must_be_file=True)
            if isinstance(resolved, str):
                out = resolved
            else:
                out = retry_read(lambda: read_file_content(str(resolved), use_cache=True))
            ok = not out.startswith("Error:")
            return {"op": "read", "path": path, "ok": ok, "output_preview": _preview(out), "error": out if not ok else None}

        if op.op == "search":
            from evoflow.code_index.store import search_index

            q = str(op.query or "").strip()
            if not q:
                return {"op": "search", "ok": False, "error": "query required"}

            def _search(query: str) -> str:
                data = search_index(root, query, thread_id=thread_id, limit=op.limit or 15)
                hits = data.get("hits") or []
                symbols = data.get("symbols") or []
                if not hits and not symbols:
                    return f"No index hits for '{query}'."
                lines = [f"hits={len(hits)} symbols={len(symbols)}"]
                for s in symbols[:10]:
                    lines.append(f"sym {s.get('path')}:{s.get('line')} {s.get('name')}")
                for h in hits[:10]:
                    lines.append(f"file {h.get('path')}")
                return "\n".join(lines)

            out = search_with_fts_fallback(_search, q)
            ok = "No index hits" not in out
            return {"op": "search", "query": q, "ok": ok, "output_preview": _preview(out)}

        if op.op == "list_dir":
            from evoflow.tools.host_direct.list_dir import list_dir_hd
            from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace

            path = op.path or root or "."
            rt = runtime_with_workspace(root, thread_id)
            out = list_dir_hd(path, runtime=rt)
            ok = not str(out).startswith("Error:")
            return {"op": "list_dir", "path": path, "ok": ok, "output_preview": _preview(out)}

        if op.op == "write":
            from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace
            from evoflow.tools.host_direct.write_file import write_file_hd

            path = op.path or ""
            content = op.content or ""
            rt = runtime_with_workspace(root, thread_id)
            out = write_file_hd.invoke({"path": path, "content": content, "runtime": rt})
            ok = str(out).startswith("OK:")
            return {"op": "write", "path": path, "ok": ok, "output_preview": _preview(out), "error": out if not ok else None}

        if op.op == "run":
            from evoflow.tools.host_direct.terminal_tool import terminal_tool
            from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace

            cmd = op.command or ""
            rt = runtime_with_workspace(root, thread_id)
            out = terminal_tool.invoke({"command": cmd, "runtime": rt})
            ok = not str(out).startswith("Error:")
            return {"op": "run", "command": cmd, "ok": ok, "output_preview": _preview(out)}

        return {"op": op.op, "ok": False, "error": f"unsupported op: {op.op}"}
    except Exception as e:
        logger.warning("scheduler execute_op failed: %s", e)
        return {"op": op.op, "ok": False, "error": str(e)}


def log_scheduler_invocation(
    thread_id: str | None,
    op_name: str,
    *,
    status: str,
    output_preview: str = "",
) -> None:
    if not thread_id:
        return
    try:
        import time

        from evoflow.observability.recorder import get_observability_recorder
        from evoflow.timeutil import instant_to_beijing_iso

        ended_ms = int(time.time() * 1000)
        ended_at = instant_to_beijing_iso(ended_ms)
        get_observability_recorder().record_tool_invocation(
            thread_id=str(thread_id),
            run_id=None,
            tool_call_id=f"scheduler-{op_name}-{ended_ms}",
            tool_name=f"scheduler:{op_name}",
            started_at=ended_at,
            ended_at=ended_at,
            duration_ms=0.0,
            status=status,
            input_obj={"invocation_source": "scheduler"},
            output_text=output_preview[:4000],
            collab_phase=None,
            invocation_source="scheduler",
        )
    except Exception as e:
        logger.debug("scheduler timeline log skipped: %s", e)
