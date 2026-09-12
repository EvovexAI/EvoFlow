"""Execute the standalone ``mind_map`` tool (persist ops + optional soft hints)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.exploration_graph.config import get_exploration_graph_config, is_exploration_graph_enabled
from evoflow.exploration_graph.mind_map_diag import log_mind_map
from evoflow.exploration_graph.mind_map_enforce import (
    MIND_MAP_GOAL_REQUIRED_ERROR,
    MIND_MAP_OPS_EMPTY_ERROR,
    graph_has_goal,
    ops_include_set_goal,
)

logger = logging.getLogger(__name__)

# When the graph has more than this many active nodes, skip orphan listing to keep
# the tool result short. Models still see the orphan count.
_ORPHAN_LIST_MAX = 8


def _normalize_ops(ops: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in ops or []:
        if isinstance(item, dict):
            out.append(dict(item))
        elif hasattr(item, "model_dump"):
            out.append(item.model_dump(by_alias=True, exclude_none=True))
    return out


def _resolve_mind_map_scope_thread(thread_id: str, session_key: str = "") -> str:
    """Resolve the graph row to read/write — session-scoped, survives LangGraph thread rotation."""
    tid = str(thread_id or "").strip()
    sk = str(session_key or "").strip()
    if not sk and tid:
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            sk = str(find_session_key_by_thread_id(tid) or "").strip()
        except Exception:
            pass
    try:
        from evoflow.persistence.exploration_graph_repositories import resolve_mind_map_thread_id

        return resolve_mind_map_thread_id(tid or None, session_key=sk or None)
    except Exception:
        from evoflow.persistence.exploration_graph_repositories import resolve_scope_thread_id

        return resolve_scope_thread_id(tid)


def _append_soft_hints_text(
    content: str,
    *,
    tool_name: str,
    ops: list[dict[str, Any]],
    thread_id: str,
) -> str:
    try:
        from evoflow.exploration_graph.mind_map_hints import collect_mind_map_soft_hints
    except Exception:
        return content
    hints = collect_mind_map_soft_hints(
        tool_name=tool_name,
        tool_args={},
        ops=ops,
        thread_id=thread_id,
    )
    if not hints:
        return content
    block = "\n\n[思维导图提示] " + " ".join(f"({i + 1}) {h}" for i, h in enumerate(hints))
    return f"{content.rstrip()}{block}"


def _scan_orphans(thread_id: str) -> tuple[int, list[str]]:
    """Return (orphan_count, sample_ids) — nodes with **no** incoming or outgoing edge.

    A node is "wired" if it is the source or target of any active edge, OR if it is
    a root (``goal:``) which is allowed to have only outgoing edges (no parent).
    ``goal:session`` is always excluded.

    Returns at most ``_ORPHAN_LIST_MAX`` sample ids for inclusion in tool feedback;
    the count reflects the true total.
    """
    try:
        from evoflow.persistence.exploration_graph_repositories import list_edges, list_nodes
    except Exception:
        return 0, []
    try:
        nodes = list_nodes(thread_id, limit=400)
        edges = list_edges(thread_id, limit=2000)
    except Exception:
        return 0, []
    wired: set[str] = set()
    for e in edges:
        st = str(getattr(e, "status", "active") or "active").strip().lower()
        if st != "active":
            continue
        wired.add(str(e.from_external_id or ""))
        wired.add(str(e.to_external_id or ""))
    orphans: list[str] = []
    for n in nodes:
        st = str(getattr(n, "status", "active") or "active").strip().lower()
        if st not in {"active", "stale"}:
            continue
        eid = str(getattr(n, "external_id", "") or "")
        if not eid or eid == "goal:session":
            continue
        if eid in wired:
            continue
        # goal:* is allowed at the root (only outgoing edges)
        if eid.startswith("goal:"):
            continue
        orphans.append(eid)
    return len(orphans), orphans[:_ORPHAN_LIST_MAX]


def _format_apply_summary(result: Any) -> str:
    """Format applied/rejected counts + per-op error list for the tool result."""
    applied_ok = sum(1 for r in result.applied if r.apply_status == "ok")
    rejected = [r for r in result.applied if r.apply_status != "ok"]
    parts = [f"applied={applied_ok}", f"rejected={len(rejected)}"]
    if rejected:
        details: list[str] = []
        for r in rejected[:5]:
            tag = r.target_external_id or "?"
            msg = (r.error_message or "").strip().splitlines()[0][:140] if r.error_message else "?"
            details.append(f"{r.op}({tag}): {msg}")
        parts.append("rejected_ops=[" + " | ".join(details) + "]")
    return "; ".join(parts)


def _format_snapshot(*, thread_id: str, session_key: str = "", prompt_language: str | None = None) -> str:
    """Render current graph for tool results (not model-prefix injection)."""
    try:
        from evoflow.exploration_graph.prompt import build_mind_map_section
    except Exception:
        return ""
    try:
        section = build_mind_map_section(
            thread_id,
            prompt_language=prompt_language,
            session_key=session_key or None,
        )
    except Exception:
        logger.debug("mind_map snapshot render failed", exc_info=True)
        return ""
    return str(section or "").strip()


def execute_mind_map(
    ops: list[Any] | None = None,
    *,
    thread_id: str,
    session_key: str = "",
    tool_call_id: str = "",
    turn_id: str = "",
    run_id: str | None = None,
    query: bool = False,
) -> str:
    """Persist mind-map ops and/or return a snapshot string."""
    cfg = get_exploration_graph_config()
    tid = str(thread_id or "").strip()
    scope_tid = _resolve_mind_map_scope_thread(tid, session_key)
    sk = str(session_key or "").strip()

    if query:
        if not is_exploration_graph_enabled():
            return "OK: mind map query (feature disabled)."
        if not scope_tid:
            return "Error: mind_map query requires thread_id in runtime context."
        snap = _format_snapshot(thread_id=scope_tid, session_key=sk)
        if not snap:
            return "OK: mind map is empty (no goal/nodes yet). Use ops with set_goal to start."
        return f"OK: mind map snapshot.\n\n{snap}"

    if not is_exploration_graph_enabled():
        return f"OK: mind map updated ({len(ops or [])} op(s))."

    norm_ops = _normalize_ops(ops or [])
    call_id = str(tool_call_id or "").strip()
    has_goal = graph_has_goal(scope_tid) if scope_tid else False
    has_set_goal = ops_include_set_goal(norm_ops)
    graph_version: int | None = None
    node_count: int | None = None
    edge_count: int | None = None
    apply_summary = ""

    log_mind_map(
        "mind_map工具执行",
        call_id=call_id,
        thread_id=tid or "(空)",
        scope_thread_id=scope_tid or "(空)",
        session_key=sk or "(未解析)",
        ops_count=len(norm_ops),
        ops=norm_ops,
        已有goal=has_goal,
        含set_goal=has_set_goal,
        require_ops=cfg.require_mind_map_ops,
    )

    if not norm_ops:
        if cfg.require_mind_map_ops:
            log_mind_map("拒绝mind_map", reason="ops缺失或为空", call_id=call_id)
            return MIND_MAP_OPS_EMPTY_ERROR
        return (
            "Error: mind_map requires ops to update, or query=true to read the current snapshot."
        )

    if cfg.require_mind_map_ops and not norm_ops:
        log_mind_map("拒绝mind_map", reason="ops缺失或为空", call_id=call_id)
        return MIND_MAP_OPS_EMPTY_ERROR

    if not scope_tid and norm_ops:
        log_mind_map("拒绝mind_map", reason="thread_id为空", call_id=call_id, ops=norm_ops)
        return "Error: mind_map persist requires thread_id in runtime context."

    if norm_ops and scope_tid and not (has_goal or has_set_goal):
        log_mind_map(
            "拒绝mind_map",
            reason="会话尚无goal且本次无set_goal",
            thread_id=scope_tid,
            call_id=call_id,
            ops=norm_ops,
        )
        return MIND_MAP_GOAL_REQUIRED_ERROR

    if norm_ops and scope_tid:
        log_mind_map("开始写入图库", thread_id=scope_tid, call_id=call_id, ops=norm_ops)
        try:
            from evoflow.persistence.exploration_graph_repositories import apply_mind_map_ops

            result = apply_mind_map_ops(
                tid or scope_tid,
                norm_ops,
                scope_thread_id=scope_tid,
                turn_id=turn_id or None,
                run_id=run_id or None,
                tool_name="mind_map",
                tool_call_id=call_id or None,
            )
            graph_version = int(result.graph_version or 0) or None
            node_count = int(result.node_count or 0)
            edge_count = int(result.edge_count or 0)
            apply_summary = _format_apply_summary(result)
            rejected = [r for r in result.applied if r.apply_status != "ok"]
            log_mind_map(
                "落库完成",
                thread_id=result.scope_thread_id,
                tool="mind_map",
                call_id=call_id,
                graph_version=result.graph_version,
                node_count=result.node_count,
                edge_count=result.edge_count,
                applied=len(result.applied),
                rejected=len(rejected),
                ops=norm_ops,
            )
        except Exception as exc:
            log_mind_map(
                "落库异常",
                thread_id=scope_tid,
                tool="mind_map",
                call_id=call_id,
                error=str(exc)[:300],
            )
            logger.warning("mind_map apply failed thread=%s call=%s", scope_tid, call_id, exc_info=True)
            return f"Error: mind map persist failed — {exc}"

    if cfg.require_mind_map_ops and scope_tid and not graph_has_goal(scope_tid):
        log_mind_map("拒绝mind_map", reason="会话尚无goal", thread_id=scope_tid, call_id=call_id)
        return MIND_MAP_GOAL_REQUIRED_ERROR

    body = f"OK: mind map updated ({len(norm_ops)} op(s))"
    if graph_version is None and norm_ops:
        log_mind_map("拒绝mind_map", reason="未落库", thread_id=scope_tid, call_id=call_id)
        return MIND_MAP_GOAL_REQUIRED_ERROR
    if graph_version is not None:
        body += f"; graph_version={graph_version}"
        if node_count is not None:
            body += f" nodes={node_count}"
        if edge_count is not None:
            body += f" edges={edge_count}"
    body += "."

    # ── 反馈：apply_summary + 孤立节点（无入边/出边） ─────────────────────────
    if apply_summary:
        body += f"\n[apply] {apply_summary}"

    # Soft empty-body / concurrent-mind_map / orphan nags are chat-oriented;
    # skip on proactive duty sessions (session_key proactive:*) to avoid dig loops.
    skip_soft = False
    sk_check = sk
    if not sk_check and tid:
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            sk_check = str(find_session_key_by_thread_id(tid) or "").strip()
        except Exception:
            sk_check = ""
    if sk_check.startswith("proactive:"):
        skip_soft = True

    if scope_tid and norm_ops and not skip_soft:
        orphan_count, orphan_sample = _scan_orphans(scope_tid)
        if orphan_count:
            sample = ", ".join(orphan_sample)
            more = " …" if orphan_count > len(orphan_sample) else ""
            body += (
                f"\n[结构告警] 孤立节点 {orphan_count} 个（没有任何 upsert_edge 连接）：{sample}{more}"
                f"\n下一轮请用 upsert_edge 把这些节点连到 flow:/file:/fn: 等已有节点上，"
                f"例如 {{\"op\":\"upsert_edge\",\"from\":\"flow:X\",\"to\":\"{orphan_sample[0]}\",\"rel\":\"contains\"}}"
            )

    if cfg.soft_hints and norm_ops and scope_tid and not skip_soft:
        body = _append_soft_hints_text(body, tool_name="mind_map", ops=norm_ops, thread_id=scope_tid)

    if cfg.return_snapshot_on_update and scope_tid and not skip_soft:
        snap = _format_snapshot(thread_id=scope_tid, session_key=sk_check or sk)
        if snap:
            body += f"\n\n{snap}"

    log_mind_map("允许mind_map", call_id=call_id, thread_id=scope_tid or tid or "(空)")
    return body
