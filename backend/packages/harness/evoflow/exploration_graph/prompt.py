"""Render persisted session mind map (思维导图) for model-context injection."""

from __future__ import annotations

import re
from typing import Any

from evoflow.exploration_graph.config import get_exploration_graph_config, is_exploration_graph_enabled
from evoflow.exploration_graph.node_status import (
    ACTIVE_NODE_STATUSES,
    ARCHIVED_NODE_STATUSES,
    COLLAPSED_STATUS,
    PARKED_NODE_STATUSES,
    normalize_node_status,
)

# Backward-compatible aliases used throughout this module.
_ACTIVE_NODE_STATUSES = ACTIVE_NODE_STATUSES
_ARCHIVED_NODE_STATUSES = ARCHIVED_NODE_STATUSES
_PARKED_NODE_STATUSES = PARKED_NODE_STATUSES
_COLLAPSED_STATUS = COLLAPSED_STATUS
# Max archived / parked node summaries to inject (keeps token cost low).
# Prefer fewer archived lines — long resolved_history re-steers the model into redo loops.
_MAX_ARCHIVED_SUMMARIES = 6
_MAX_PARKED_SUMMARIES = 6
_ARCHIVED_BODY_MAX_CHARS = 80
# Only these kinds in <resolved_history> (file/note bodies bloat context).
_ARCHIVED_INJECT_KINDS = frozenset({"flow", "gap", "claim"})

# Live-injected block + legacy English tag names (strip before refresh).
_SESSION_MIND_MAP_RE = re.compile(
    r"<(?:session_mind_map|session_knowledge_map|思维导图)>[\s\S]*?</(?:session_mind_map|session_knowledge_map|思维导图)>",
    re.IGNORECASE,
)

# Live footer / tool snapshot — full policy lives on the mind_map tool description.
_INTRO_ZH = (
    "本会话思维导图快照（由 **mind_map** 工具返回；**不会**自动注入模型上下文，以免破坏提示词缓存）。"
    "需要时再 `mind_map(query=true)` 拉取，或在更新 ops 后的工具结果中查看。"
    "有**新确认事实**再更新；无新发现勿为记账而调用。"
    "已归档分支勿重做；若用户否定已解决结论，以用户最新反馈为准。"
)
_INTRO_EN = (
    "Session mind map snapshot (returned by the **mind_map** tool; **not** auto-injected into "
    "model context, to preserve prompt-cache hits). Call `mind_map(query=true)` when you need it, "
    "or read the snapshot appended after update ops. Update only with **new confirmed facts**. "
    "Do not redo archived branches; if the user rejects a resolved claim, follow the user."
)


def strip_mind_map_from_system_prompt(text: str) -> str:
    out = _SESSION_MIND_MAP_RE.sub("", text or "")
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _node_status(n: Any) -> str:
    """Return normalized node status (default 'active' if missing/blank)."""
    return normalize_node_status(getattr(n, "status", None))


_KIND_PREFIX_MAP_INJECT = {
    "goal:": "goal",
    "flow:": "flow",
    "gap:": "gap",
    "claim:": "claim",
    "file:": "file",
    "diagram:": "diagram",
}


def _effective_kind(n: Any) -> str:
    """Return the effective kind for bucketing, inferring from external_id prefix.

    When the stored kind is ``'note'`` (the default that may not have been set
    correctly by the model), we infer the kind from the external_id prefix
    (``flow:`` → ``flow``, ``gap:`` → ``gap``, …).  This ensures that nodes
    like ``flow:deep-audit`` are bucketed into ``<flows>`` instead of ``<notes>``
    even if they were stored with ``kind='note'``.
    """
    stored = str(getattr(n, "kind", None) or "").strip().lower()
    if stored and stored != "note":
        return stored
    eid = str(getattr(n, "external_id", None) or "").strip().lower()
    for prefix, kind in _KIND_PREFIX_MAP_INJECT.items():
        if eid.startswith(prefix):
            return kind
    return stored or "note"


def _compute_effectively_archived(nodes: list[Any]) -> set[str]:
    """Return IDs of nodes that are archived OR descend from an archived/parked node.

    When a flow is marked resolved/verified/refuted/blocked/parked, its tracked
    children (gaps, sub-flows) are semantically done too — even if their individual
    status was never updated.  This cascade prevents orphaned child nodes
    from appearing as active roots in the injected tree.
    """
    from evoflow.exploration_graph.node_status import ARCHIVED_NODE_STATUSES, PARKED_NODE_STATUSES

    closed_statuses = ARCHIVED_NODE_STATUSES | PARKED_NODE_STATUSES
    directly_archived = {
        n.external_id for n in nodes
        if _node_status(n) in closed_statuses
    }
    children_map: dict[str, list[str]] = {}
    for n in nodes:
        parent = str(getattr(n, "parent_external_id", None) or "").strip()
        if parent:
            children_map.setdefault(parent, []).append(n.external_id)
    effectively_archived = set(directly_archived)
    queue = list(directly_archived)
    while queue:
        current = queue.pop()
        for child_id in children_map.get(current, []):
            if child_id not in effectively_archived:
                effectively_archived.add(child_id)
                queue.append(child_id)
    return effectively_archived


def _compute_effectively_hidden(nodes: list[Any]) -> set[str]:
    """Return IDs of collapsed nodes and all their descendants.

    A ``collapsed`` flow is completely removed from injection — neither in
    ``<tree>`` nor in ``<resolved_history>``.  Its children are hidden too
    (same cascade logic as archived nodes).
    """
    directly_hidden = {
        n.external_id for n in nodes
        if _node_status(n) == _COLLAPSED_STATUS
    }
    if not directly_hidden:
        return set()
    children_map: dict[str, list[str]] = {}
    for n in nodes:
        parent = str(getattr(n, "parent_external_id", None) or "").strip()
        if parent:
            children_map.setdefault(parent, []).append(n.external_id)
    effectively_hidden = set(directly_hidden)
    queue = list(directly_hidden)
    while queue:
        current = queue.pop()
        for child_id in children_map.get(current, []):
            if child_id not in effectively_hidden:
                effectively_hidden.add(child_id)
                queue.append(child_id)
    return effectively_hidden


def _compute_effectively_parked(nodes: list[Any]) -> set[str]:
    """Return IDs of parked nodes and all their descendants.

    Parked nodes and their cascade children should go to ``<parked_notes>``,
    NOT ``<resolved_history>``.  This is separate from
    :func:`_compute_effectively_archived` (which also includes parked for the
    purpose of excluding them from live ``<tree>`` injection) so that
    ``select_archived_summaries`` can exclude parked nodes while
    ``select_parked_summaries`` can include them.
    """
    directly_parked = {
        n.external_id for n in nodes
        if _node_status(n) in _PARKED_NODE_STATUSES
    }
    if not directly_parked:
        return set()
    children_map: dict[str, list[str]] = {}
    for n in nodes:
        parent = str(getattr(n, "parent_external_id", None) or "").strip()
        if parent:
            children_map.setdefault(parent, []).append(n.external_id)
    effectively_parked = set(directly_parked)
    queue = list(directly_parked)
    while queue:
        current = queue.pop()
        for child_id in children_map.get(current, []):
            if child_id not in effectively_parked:
                effectively_parked.add(child_id)
                queue.append(child_id)
    return effectively_parked


def select_nodes_for_injection(nodes: list[Any], *, max_nodes: int) -> list[Any]:
    """Prefer structured nodes over step notes when injection budget is tight.

    Only **active/stale** nodes are selected for full injection (with body).
    Archived nodes (resolved/verified/refuted/blocked) are excluded here —
    they are handled separately by :func:`select_archived_summaries` as
    compressed one-line entries to prevent stale problems from polluting
    the model's context.

    **Archive cascade**: nodes whose ancestor is archived are also excluded
    from live injection, because a resolved flow implies all its children
    (claims, files, gaps) are done.  Without this, orphaned children become
    root nodes in the tree and re-inject stale conclusions with full body.
    """
    cap = max(1, int(max_nodes))
    effectively_archived = _compute_effectively_archived(nodes)
    effectively_hidden = _compute_effectively_hidden(nodes)
    # Only inject active/stale nodes with full detail, excluding those
    # whose ancestor is archived (cascade) or collapsed (hidden).
    live = [
        n for n in nodes
        if _node_status(n) in _ACTIVE_NODE_STATUSES
        and n.external_id not in effectively_archived
        and n.external_id not in effectively_hidden
    ]
    flows = [n for n in live if _effective_kind(n) == "flow"]
    gaps = [n for n in live if _effective_kind(n) == "gap"]
    goals = [n for n in live if _effective_kind(n) == "goal" or getattr(n, "external_id", None) == "goal:session"]
    artifacts = [n for n in live if _effective_kind(n) not in {"gap", "flow", "note", "goal"}]
    notes = [n for n in live if _effective_kind(n) == "note"]
    selected: list[Any] = []
    for bucket in (goals, flows, gaps, artifacts, notes):
        for n in bucket:
            if len(selected) >= cap:
                return selected
            selected.append(n)
    return selected


def select_archived_summaries(nodes: list[Any], *, max_summaries: int = _MAX_ARCHIVED_SUMMARIES) -> list[Any]:
    """Return archived nodes (resolved/verified/refuted/blocked) for compressed injection.

    These nodes are injected as ``id [status]: title`` only — no body — so the
    model knows what has already been handled without being tempted to redo it.

    **Archive cascade**: children of archived ancestors are also included here
    (as compressed summaries), because :func:`select_nodes_for_injection` now
    excludes them from live injection.  Without surfacing them here, they would
    vanish entirely — the model would lose visibility of completed claims/files
    and might re-derive them.  Cascade children are marked with their actual
    status (e.g. ``active``) plus a ``(archived-parent)`` note in the summary.
    """
    cap = max(0, int(max_summaries))
    if cap == 0:
        return []
    effectively_archived = _compute_effectively_archived(nodes)
    effectively_hidden = _compute_effectively_hidden(nodes)
    effectively_parked = _compute_effectively_parked(nodes)
    # Include both directly-archived nodes and cascade-archived children,
    # but exclude collapsed nodes (hidden) and parked nodes (→ <parked_notes>).
    archived = [
        n for n in nodes
        if n.external_id in effectively_archived
        and n.external_id not in effectively_parked
        and n.external_id not in effectively_hidden
        and _effective_kind(n) in _ARCHIVED_INJECT_KINDS
    ]
    # Prefer flows and gaps first (most likely to cause "redo" confusion),
    # then claims. Within the same kind, keep list_nodes order (updated_at DESC).
    kind_priority = {"flow": 0, "gap": 1, "claim": 2}
    archived.sort(key=lambda n: kind_priority.get(_effective_kind(n), 6))
    return archived[:cap]


def select_parked_summaries(nodes: list[Any], *, max_summaries: int = _MAX_PARKED_SUMMARIES) -> list[Any]:
    """Return parked nodes and their cascade children for compressed injection."""
    cap = max(0, int(max_summaries))
    if cap == 0:
        return []
    effectively_hidden = _compute_effectively_hidden(nodes)
    effectively_parked = _compute_effectively_parked(nodes)
    parked = [
        n for n in nodes
        if n.external_id in effectively_parked and n.external_id not in effectively_hidden
    ]
    kind_priority = {"flow": 0, "gap": 1, "claim": 2, "diagram": 2, "file": 3, "goal": 4, "note": 5}
    parked.sort(key=lambda n: kind_priority.get(_effective_kind(n), 6))
    return parked[:cap]


def _build_tree_lines(nodes: list[Any], body_max_chars: int) -> list[str]:
    """Build indented tree lines from nodes using ``parent_external_id``.

    Replaces flat kind-bucketed blocks with a single tree view so the model
    can see the full investigation chain (goal → flow → file/gap/claim)
    instead of scattered buckets that require mental reconstruction.
    """
    if not nodes:
        return []

    node_ids = {n.external_id for n in nodes}
    children: dict[str, list[Any]] = {}
    roots: list[Any] = []

    for n in nodes:
        parent = str(n.parent_external_id or "").strip()
        if parent and parent in node_ids:
            children.setdefault(parent, []).append(n)
        else:
            roots.append(n)

    kind_order = {"goal": 0, "flow": 1, "diagram": 2, "file": 3, "gap": 4, "claim": 5, "note": 6}

    def _sort_key(n: Any) -> tuple[int, str]:
        return (kind_order.get(_effective_kind(n), 6), str(n.external_id))

    for kids in children.values():
        kids.sort(key=_sort_key)
    roots.sort(key=_sort_key)

    lines: list[str] = []
    visited: set[str] = set()

    def _emit(n: Any, prefix: str, is_last: bool) -> None:
        if n.external_id in visited:
            return
        visited.add(n.external_id)
        connector = "└─ " if is_last else "├─ "
        body = _truncate(n.body, body_max_chars)
        ekind = _effective_kind(n)
        suffix = f" — {body}" if body else ""
        lines.append(
            f"{prefix}{connector}{n.external_id} [{ekind}]: {n.title or n.external_id}{suffix}"
        )

        kids = children.get(n.external_id, [])
        child_prefix = prefix + ("   " if is_last else "│  ")
        for i, kid in enumerate(kids):
            _emit(kid, child_prefix, i == len(kids) - 1)

    for i, root in enumerate(roots):
        _emit(root, "", i == len(roots) - 1)

    # Append any nodes not reached by the tree (orphans due to cycles or
    # parent not in the current injection set).
    orphans = [n for n in nodes if n.external_id not in visited]
    if orphans:
        orphans.sort(key=_sort_key)
        if lines:
            lines.append("")
        lines.append("<!-- orphan nodes (parent missing or cycle) -->")
        for n in orphans:
            body = _truncate(n.body, body_max_chars)
            ekind = _effective_kind(n)
            suffix = f" — {body}" if body else ""
            parent = f" (parent={n.parent_external_id})" if n.parent_external_id else ""
            lines.append(
                f"- {n.external_id} [{ekind}]{parent}: {n.title or n.external_id}{suffix}"
            )

    return lines


def build_mind_map_section(
    thread_id: str,
    *,
    prompt_language: str | None = None,
    session_key: str | None = None,
) -> str:
    cfg = get_exploration_graph_config()
    if not is_exploration_graph_enabled():
        return ""

    try:
        from evoflow.persistence.exploration_graph_repositories import (
            get_graph_header,
            list_edges,
            list_nodes,
            resolve_mind_map_thread_id,
        )
    except Exception:
        return ""

    scope = resolve_mind_map_thread_id(thread_id, session_key=session_key)
    if not scope:
        return ""
    header = get_graph_header(scope)
    if header is None:
        return ""

    raw_nodes = list_nodes(scope, limit=max(cfg.inject_max_nodes * 4, 120))
    nodes = select_nodes_for_injection(raw_nodes, max_nodes=cfg.inject_max_nodes)
    archived = select_archived_summaries(raw_nodes)
    parked = select_parked_summaries(raw_nodes)
    effectively_hidden = _compute_effectively_hidden(raw_nodes)
    edges = list_edges(scope, limit=cfg.inject_max_edges) if cfg.inject_max_edges else []
    goal_text = str(header.goal or "").strip()
    if not goal_text:
        goal_node = next((n for n in raw_nodes if n.kind == "goal" or n.external_id == "goal:session"), None)
        if goal_node is not None:
            goal_text = str(goal_node.title or goal_node.body or "").strip()
    if not nodes and not edges and not goal_text and not archived and not str(header.render_summary or "").strip():
        return ""

    zh = not str(prompt_language or "").strip().lower().startswith("en")
    intro = _INTRO_ZH if zh else _INTRO_EN
    lines: list[str] = ["<session_mind_map>", intro]

    if goal_text:
        lines.extend(["<goal>", goal_text, "</goal>"])

    summary = str(header.render_summary or "").strip()
    if summary:
        lines.extend(["<summary>", summary, "</summary>"])

    tree_lines = _build_tree_lines(nodes, cfg.node_body_max_chars)
    if tree_lines:
        lines.append("<tree>")
        lines.extend(tree_lines)
        lines.append("</tree>")

    if archived:
        lines.append("<resolved_history>")
        lines.append(
            "<!-- 已处理分支摘要（勿重做）；用户若否定结论，以用户最新反馈为准 -->"
        )
        directly_archived_ids = {
            n.external_id for n in raw_nodes
            if _node_status(n) in _ARCHIVED_NODE_STATUSES
        }
        for n in archived:
            st = _node_status(n)
            # Cascade-archived children (own status still active but ancestor is
            # archived) are shown as [archived] to avoid confusing the model
            # with an [active] entry in the resolved-history block.
            if st in _ACTIVE_NODE_STATUSES and n.external_id not in directly_archived_ids:
                st = "archived"
            title = str(n.title or "").strip()
            body_summary = _truncate(str(n.body or ""), _ARCHIVED_BODY_MAX_CHARS)
            if title:
                label = f"{title} — {body_summary}" if body_summary else title
            else:
                label = body_summary or n.external_id
            lines.append(f"- {n.external_id} [{st}]: {label}")
        lines.append("</resolved_history>")

    if parked:
        lines.append("<parked_notes>")
        lines.append("<!-- 以下节点已搁置：不必再当作进行中处理，但未声称已解决；用户可能手动标记 -->")
        for n in parked:
            title = str(n.title or "").strip()
            body_summary = _truncate(str(n.body or ""), 150)
            if title:
                label = f"{title} — {body_summary}" if body_summary else title
            else:
                label = body_summary or n.external_id
            lines.append(f"- {n.external_id} [parked]: {label}")
        lines.append("</parked_notes>")

    if edges:
        active_ids = {n.external_id for n in nodes}
        archived_ids = {n.external_id for n in archived}
        parked_ids = {n.external_id for n in parked}
        visible_ids = active_ids | archived_ids | parked_ids
        # Keep edges where both endpoints are visible AND at least one is
        # active.  Edges between two archived nodes are redundant (both
        # appear in <resolved_history> with implicit parent-child links).
        # Edges touching collapsed/hidden nodes are dropped entirely.
        visible_edges = [
            e for e in edges
            if e.from_external_id in visible_ids
            and e.to_external_id in visible_ids
            and (e.from_external_id in active_ids or e.to_external_id in active_ids)
        ]
        if visible_edges:
            lines.append("<relations>")
            for e in visible_edges:
                label = f" ({e.label})" if e.label else ""
                lines.append(f"- {e.external_id}: {e.from_external_id} -{e.rel}-> {e.to_external_id}{label}")
            lines.append("</relations>")

    if header.graph_version:
        omitted = max(0, int(header.node_count or 0) - len(nodes))
        hidden_count = len(effectively_hidden)
        omit_hint = f" omitted_notes={omitted}" if omitted else ""
        hidden_hint = f" hidden={hidden_count}" if hidden_count else ""
        lines.append(
            f"<!-- graph_version={header.graph_version} nodes={header.node_count} edges={header.edge_count}{omit_hint}{hidden_hint} -->"
        )

    lines.append("</session_mind_map>")
    return "\n".join(lines)


def _truncate(text: str, cap: int) -> str:
    s = str(text or "").strip()
    if len(s) <= cap:
        return s
    return s[: max(0, cap - 1)] + "…"


# Backward-compatible aliases
strip_session_knowledge_map_from_system_prompt = strip_mind_map_from_system_prompt
build_session_knowledge_map_section = build_mind_map_section
