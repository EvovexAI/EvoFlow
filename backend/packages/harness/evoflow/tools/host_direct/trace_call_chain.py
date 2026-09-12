"""Trace call/dependency chains across the workspace code index.

Uses the SQLite FTS5 index (file_deps, symbols, internal_refs tables) to perform
BFS traversal from a seed symbol or file path, returning a layered dependency DAG.
Designed for impact analysis before refactoring.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain.tools import ToolRuntime, tool

from evoflow.tools.minimal_schema import TRACE_CALL_CHAIN_DESCRIPTION

logger = logging.getLogger(__name__)

_MAX_DEPTH = 5
_MAX_NODES = 80
_MAX_SEEDS = 10
_MAX_SYMS_PER_FILE = 5
_MAX_NEIGHBORS_PER_NODE = 15  # per-node budget shared across all 4 queries

_SKIP_SEGMENTS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    "target",
    "binaries",
    "_internal",
}


def _path_has_skipped_segment(rel: str) -> bool:
    """True if any path segment is a known skip dir or hidden (dot-prefixed)."""
    parts = str(rel or "").replace("\\", "/").split("/")
    return any(p in _SKIP_SEGMENTS or p.startswith(".") for p in parts if p)


def _index_stats(conn: Any) -> dict:
    """Quick row counts so the caller can judge index coverage."""
    try:
        files = conn.execute("SELECT COUNT(*) FROM fts_content").fetchone()[0]
        syms = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
        deps = conn.execute("SELECT COUNT(*) FROM file_deps").fetchone()[0]
        refs = conn.execute("SELECT COUNT(*) FROM internal_refs").fetchone()[0]
        return {"files": int(files), "symbols": int(syms), "deps": int(deps), "refs": int(refs)}
    except Exception:
        return {"files": 0, "symbols": 0, "deps": 0, "refs": 0}


def _find_seed_paths(conn: Any, symbol: str, path: str) -> list[dict]:
    """Resolve seed file paths from a symbol name or explicit path."""
    seeds: list[dict] = []
    seen: set[str] = set()

    sym = str(symbol or "").strip()
    if sym:
        # exact match first
        for row in conn.execute(
            "SELECT DISTINCT path, name, kind, line FROM symbols "
            "WHERE name = ? COLLATE NOCASE LIMIT ?",
            (sym, _MAX_SEEDS),
        ).fetchall():
            p = str(row[0])
            if p and p not in seen and not _path_has_skipped_segment(p):
                seen.add(p)
                seeds.append({"path": p, "name": str(row[1]), "kind": str(row[2]), "line": int(row[3] or 0)})

        # prefix match fallback
        if len(seeds) < _MAX_SEEDS:
            esc = sym.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            for row in conn.execute(
                "SELECT DISTINCT path, name, kind, line FROM symbols "
                "WHERE name LIKE ? ESCAPE '\\' LIMIT ?",
                (esc + "%", _MAX_SEEDS - len(seeds)),
            ).fetchall():
                p = str(row[0])
                if p and p not in seen and not _path_has_skipped_segment(p):
                    seen.add(p)
                    seeds.append({"path": p, "name": str(row[1]), "kind": str(row[2]), "line": int(row[3] or 0)})

    pth = str(path or "").strip().replace("\\", "/").strip("/")
    if pth and pth not in seen:
        row = conn.execute(
            "SELECT name, kind, line FROM symbols WHERE path = ? ORDER BY line LIMIT 1",
            (pth,),
        ).fetchone()
        if row:
            seeds.append({"path": pth, "name": str(row[0]), "kind": str(row[1]), "line": int(row[2] or 0)})
        else:
            seeds.append({"path": pth, "name": "", "kind": "file", "line": 0})

    return seeds[:_MAX_SEEDS]


def _symbols_in_file(conn: Any, rel: str) -> list[dict]:
    """Top symbols defined in *rel* (for context in trace results)."""
    rows = conn.execute(
        "SELECT name, kind, line FROM symbols WHERE path = ? ORDER BY line LIMIT ?",
        (rel, _MAX_SYMS_PER_FILE),
    ).fetchall()
    return [{"name": str(r[0]), "kind": str(r[1]), "line": int(r[2] or 0)} for r in rows]


def _add_neighbor(
    layer: list[dict],
    nxt: list[str],
    visited: set[str],
    *,
    path: str,
    from_path: str,
    via: str,
    spec: str = "",
    symbol: str = "",
    line: int = 0,
    conn: Any = None,
) -> bool:
    """Add one neighbor node. Returns True if added, False if skipped."""
    if not path or path in visited or _path_has_skipped_segment(path):
        return False
    visited.add(path)
    node: dict[str, Any] = {
        "path": path,
        "from": from_path,
        "via": via,
        "line": line,
    }
    if spec:
        node["spec"] = spec
    if symbol:
        node["symbol"] = symbol
    if conn is not None:
        node["symbols"] = _symbols_in_file(conn, path)
    layer.append(node)
    nxt.append(path)
    return True


def _bfs_trace(
    conn: Any,
    seeds: list[dict],
    *,
    direction: str,
    max_depth: int,
) -> dict:
    """BFS over file_deps + internal_refs from seed paths.

    Each discovered node carries a ``from`` field (the frontier node it was
    discovered from) so the caller can reconstruct the actual edge.
    A per-node budget ``_MAX_NEIGHBORS_PER_NODE`` is shared across all 4
    queries, preventing hub nodes from flooding the result set.
    """
    want_callers = direction in ("callers", "both")
    want_callees = direction in ("callees", "both")

    seed_paths = [s["path"] for s in seeds]
    visited: set[str] = set(seed_paths)
    layers: list[dict] = []
    total = 0
    truncated = False
    frontier = list(seed_paths)

    for depth in range(1, max(max_depth, 1) + 1):
        if not frontier:
            break
        nxt: list[str] = []
        layer: list[dict] = []

        for cur in frontier:
            if total >= _MAX_NODES:
                truncated = True
                break

            remaining = _MAX_NEIGHBORS_PER_NODE

            # ── Callers: who imports / references *cur* ──
            if want_callers and remaining > 0:
                for row in conn.execute(
                    "SELECT from_path, spec, line FROM file_deps "
                    "WHERE to_path = ? LIMIT ?",
                    (cur, remaining),
                ).fetchall():
                    if total >= _MAX_NODES:
                        truncated = True
                        break
                    if _add_neighbor(
                        layer, nxt, visited,
                        path=str(row[0]), from_path=cur, via="import",
                        spec=str(row[1]), line=int(row[2] or 0), conn=conn,
                    ):
                        total += 1
                        remaining -= 1
                        if remaining <= 0:
                            break

            if want_callers and remaining > 0 and not truncated:
                for row in conn.execute(
                    "SELECT DISTINCT from_path, symbol, line FROM internal_refs "
                    "WHERE to_path = ? LIMIT ?",
                    (cur, remaining),
                ).fetchall():
                    if total >= _MAX_NODES:
                        truncated = True
                        break
                    if _add_neighbor(
                        layer, nxt, visited,
                        path=str(row[0]), from_path=cur, via="internal_ref",
                        symbol=str(row[1] or ""), line=int(row[2] or 0), conn=conn,
                    ):
                        total += 1
                        remaining -= 1
                        if remaining <= 0:
                            break

            # ── Callees: what *cur* imports / references ──
            if want_callees and remaining > 0 and not truncated:
                for row in conn.execute(
                    "SELECT to_path, spec, line FROM file_deps "
                    "WHERE from_path = ? AND to_path IS NOT NULL LIMIT ?",
                    (cur, remaining),
                ).fetchall():
                    if total >= _MAX_NODES:
                        truncated = True
                        break
                    if _add_neighbor(
                        layer, nxt, visited,
                        path=str(row[0]), from_path=cur, via="import",
                        spec=str(row[1]), line=int(row[2] or 0), conn=conn,
                    ):
                        total += 1
                        remaining -= 1
                        if remaining <= 0:
                            break

            if want_callees and remaining > 0 and not truncated:
                for row in conn.execute(
                    "SELECT DISTINCT to_path, symbol, line FROM internal_refs "
                    "WHERE from_path = ? LIMIT ?",
                    (cur, remaining),
                ).fetchall():
                    if total >= _MAX_NODES:
                        truncated = True
                        break
                    if _add_neighbor(
                        layer, nxt, visited,
                        path=str(row[0]), from_path=cur, via="internal_ref",
                        symbol=str(row[1] or ""), line=int(row[2] or 0), conn=conn,
                    ):
                        total += 1
                        remaining -= 1
                        if remaining <= 0:
                            break

        if layer:
            layers.append({"depth": depth, "nodes": layer})
        frontier = nxt

    return {
        "ok": True,
        "direction": direction,
        "max_depth": max_depth,
        "layers": layers,
        "total_nodes": total,
        "truncated": truncated,
    }


@tool("trace_call_chain", description=TRACE_CALL_CHAIN_DESCRIPTION, parse_docstring=False)
def trace_call_chain_hd(
    symbol: str = "",
    path: str = "",
    *,
    direction: str = "both",
    max_depth: int = 3,
    runtime: ToolRuntime,
) -> str:
    """Trace call/dependency chain from a symbol or file."""
    sym = str(symbol or "").strip()
    pth = str(path or "").strip().replace("\\", "/").strip("/")
    if not sym and not pth:
        return json.dumps(
            {"ok": False, "error": "Provide at least one of `symbol` or `path`"},
            ensure_ascii=False,
        )

    direction = str(direction or "both").strip().lower()
    if direction not in ("callers", "callees", "both"):
        direction = "both"
    try:
        max_depth = int(max_depth)
    except (TypeError, ValueError):
        max_depth = 3
    max_depth = max(1, min(max_depth, _MAX_DEPTH))

    conn = None
    try:
        from evoflow.tools.host_direct.workspace_path_guard import resolve_search_workspace_root

        resolved = resolve_search_workspace_root(runtime=runtime)
        if isinstance(resolved, str):
            return resolved
        root, thread_id = resolved

        from evoflow.code_index.store import _connect, _ensure_schema

        conn = _connect(root)
        _ensure_schema(conn)

        # ── Index readiness check ──
        stats = _index_stats(conn)
        if stats["symbols"] == 0 and stats["deps"] == 0:
            return json.dumps(
                {
                    "ok": False,
                    "error": "Workspace code index is empty. Run a full index build first "
                    "(POST /api/workspaces/index-build or index-warm), then retry.",
                    "index_stats": stats,
                },
                ensure_ascii=False,
            )

        seeds = _find_seed_paths(conn, sym, pth)
        if not seeds:
            hint = f" symbol={sym!r}" if sym else ""
            hint += f" path={pth!r}" if pth else ""
            return json.dumps(
                {
                    "ok": False,
                    "error": f"No matching symbols or files found for{hint}",
                    "index_stats": stats,
                    "suggestion": "Try a broader symbol name, or use `path` to trace from a specific file.",
                },
                ensure_ascii=False,
            )
        result = _bfs_trace(conn, seeds, direction=direction, max_depth=max_depth)
        result["seeds"] = seeds
        result["index_stats"] = stats
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        logger.exception("trace_call_chain failed")
        return json.dumps(
            {"ok": False, "error": f"Internal error: {exc!r}", "symbol": sym, "path": pth},
            ensure_ascii=False,
        )
    finally:
        if conn is not None:
            conn.close()
