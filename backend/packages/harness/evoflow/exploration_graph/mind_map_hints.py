"""Soft (non-blocking) hints when mind_map_ops quality can improve."""

from __future__ import annotations

import re
from typing import Any

from langchain_core.messages import ToolMessage

EVIDENCE_TOOLS = frozenset(
    {
        "read",
        "read_file",
        "read_files",
        "rg",
        "grep",
        "search_code_index",
        "search",
        "find",
        "worker",
    }
)

_INTENT_BODY_RE = re.compile(
    r"(查看|待读|继续搜|继续查|待查|下一步|先读|先搜|look\s+at|check\s+the|todo:?|待确认)",
    re.IGNORECASE,
)

_STEP_NOTE_ID_RE = re.compile(r"^note:step[-_]?\d+$", re.IGNORECASE)


def _op_body_text(raw: dict[str, Any]) -> str:
    return str(raw.get("body") or raw.get("append_body") or "").strip()


def _op_text(raw: dict[str, Any]) -> str:
    return " ".join(
        str(raw.get(k) or "")
        for k in ("body", "append_body", "title")
    ).strip()


def _op_kind(raw: dict[str, Any]) -> str:
    return str(raw.get("kind") or "").strip().lower()


def _op_id(raw: dict[str, Any]) -> str:
    return str(raw.get("id") or "").strip()


def _op_parent(raw: dict[str, Any]) -> str:
    return str(raw.get("parent") or raw.get("parent_external_id") or "").strip()


def ops_are_step_note_diaries(ops: list[dict[str, Any]]) -> bool:
    upserts = [o for o in ops if str(o.get("op") or "").strip() == "upsert_node"]
    if not upserts:
        return False
    return all(_op_kind(o) == "note" and _STEP_NOTE_ID_RE.match(_op_id(o)) for o in upserts)


def ops_include_body_distill(ops: list[dict[str, Any]]) -> bool:
    for raw in ops:
        op = str(raw.get("op") or "").strip()
        if op == "patch_node" and _op_body_text(raw):
            return True
        if op != "upsert_node":
            continue
        kind = _op_kind(raw)
        body = _op_body_text(raw)
        if not body:
            continue
        if kind in {"flow", "gap"} and _INTENT_BODY_RE.search(body):
            continue
        if kind in {"file", "flow", "gap", "claim", "decision"}:
            return True
    return False


def ops_touch_file_ids(ops: list[dict[str, Any]]) -> set[str]:
    touched: set[str] = set()
    for raw in ops:
        op = str(raw.get("op") or "").strip()
        eid = _op_id(raw)
        if op in {"patch_node", "upsert_node", "delete_node"} and eid.startswith("file:"):
            touched.add(eid)
        if op == "upsert_node" and _op_kind(raw) == "file" and eid:
            touched.add(eid if eid.startswith("file:") else f"file:{eid}")
    return touched


def ops_flat_under_goal_only(ops: list[dict[str, Any]]) -> bool:
    for raw in ops:
        if str(raw.get("op") or "").strip() != "upsert_node":
            continue
        kind = _op_kind(raw)
        if kind in {"file", "gap", "claim"}:
            parent = _op_parent(raw)
            if not parent or parent in {"goal:session", "goal"}:
                return True
    return False


def ops_have_intent_flow_gap_body(ops: list[dict[str, Any]]) -> bool:
    for raw in ops:
        if str(raw.get("op") or "").strip() != "upsert_node":
            continue
        if _op_kind(raw) not in {"flow", "gap"}:
            continue
        if _INTENT_BODY_RE.search(_op_text(raw)):
            return True
    return False


def ops_include_edge(ops: list[dict[str, Any]]) -> bool:
    return any(str(o.get("op") or "").strip() == "upsert_edge" for o in ops)


def _path_from_tool_args(tool_name: str, args: dict[str, Any]) -> str:
    if tool_name in {"read", "read_file"}:
        return str(args.get("path") or args.get("file_path") or "").strip()
    return ""


def _list_empty_file_nodes(thread_id: str) -> list[str]:
    try:
        from evoflow.persistence.exploration_graph_repositories import list_nodes, resolve_scope_thread_id

        scope = resolve_scope_thread_id(thread_id)
        if not scope:
            return []
        out: list[str] = []
        for n in list_nodes(scope, limit=80):
            if n.kind != "file":
                continue
            if str(n.body or "").strip():
                continue
            out.append(n.external_id)
        return out[:5]
    except Exception:
        return []


def _list_flow_ids(thread_id: str) -> list[str]:
    try:
        from evoflow.persistence.exploration_graph_repositories import list_nodes, resolve_scope_thread_id

        scope = resolve_scope_thread_id(thread_id)
        if not scope:
            return []
        return [n.external_id for n in list_nodes(scope, kind="flow", limit=20)]
    except Exception:
        return []


def _graph_node_count(thread_id: str) -> int:
    try:
        from evoflow.persistence.exploration_graph_repositories import get_graph_header, resolve_scope_thread_id

        header = get_graph_header(resolve_scope_thread_id(thread_id))
        return int(header.node_count or 0) if header else 0
    except Exception:
        return 0


def _graph_edge_count(thread_id: str) -> int:
    try:
        from evoflow.persistence.exploration_graph_repositories import get_graph_header, resolve_scope_thread_id

        header = get_graph_header(resolve_scope_thread_id(thread_id))
        return int(header.edge_count or 0) if header else 0
    except Exception:
        return 0


_CLOSED_STATUSES = frozenset({"resolved", "verified", "refuted", "blocked", "done", "closed", "parked", "collapsed"})


def ops_upsert_claim_parents(ops: list[dict[str, Any]]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for raw in ops:
        if str(raw.get("op") or "").strip() != "upsert_node":
            continue
        if _op_kind(raw) != "claim":
            continue
        parent = _op_parent(raw)
        if parent:
            out.append((_op_id(raw), parent))
    return out


def ops_status_patched_ids(ops: list[dict[str, Any]]) -> set[str]:
    patched: set[str] = set()
    for raw in ops:
        if str(raw.get("op") or "").strip() != "patch_node":
            continue
        eid = _op_id(raw)
        status = str(raw.get("status") or "").strip().lower()
        if eid and status:
            patched.add(eid)
    return patched


def _node_status(thread_id: str, external_id: str) -> str:
    try:
        from evoflow.persistence.exploration_graph_repositories import get_node, resolve_scope_thread_id

        node = get_node(resolve_scope_thread_id(thread_id), external_id)
        if node is None:
            return ""
        return str(node.status or "active").strip().lower()
    except Exception:
        return ""


def _list_active_gaps_for_flow(thread_id: str, flow_id: str) -> list[str]:
    try:
        from evoflow.persistence.exploration_graph_repositories import list_nodes, resolve_scope_thread_id

        scope = resolve_scope_thread_id(thread_id)
        if not scope:
            return []
        out: list[str] = []
        for n in list_nodes(scope, kind="gap", limit=40):
            if str(n.parent_external_id or "").strip() != flow_id:
                continue
            if str(n.status or "active").strip().lower() in _CLOSED_STATUSES:
                continue
            out.append(n.external_id)
        return out[:5]
    except Exception:
        return []


_EMPTY_EVIDENCE_OUTPUT_PREFIXES = (
    "(no matches)",
    "(empty)",
    "(page appears empty",
)


def _strip_tool_banner_lines(lines: list[str]) -> list[str]:
    """Drop leading ``[rg]`` / ``[index]`` style one-line banners."""
    out = list(lines)
    while out:
        head = out[0].strip()
        if head.startswith("[") and "]" in head[:48]:
            out.pop(0)
            continue
        break
    return out


def evidence_tool_output_has_substance(content: str) -> bool:
    """Return False when an evidence tool returned nothing worth distilling."""
    text = str(content or "").strip()
    if not text:
        return False
    lines = _strip_tool_banner_lines([ln for ln in text.splitlines() if ln.strip()])
    if not lines:
        return False
    remainder = "\n".join(lines).strip()
    if not remainder:
        return False
    lower = remainder.lower()
    return not any(lower.startswith(prefix) for prefix in _EMPTY_EVIDENCE_OUTPUT_PREFIXES)


def collect_mind_map_soft_hints(
    *,
    tool_name: str,
    tool_args: dict[str, Any],
    ops: list[dict[str, Any]],
    thread_id: str,
) -> list[str]:
    """Return short hint strings (zh); never blocks tool execution."""
    if not ops:
        return []

    hints: list[str] = []
    name = str(tool_name or "").strip().lower()

    if ops_are_step_note_diaries(ops):
        hints.append("请改用 file:/flow:/gap:/claim: 记录结构化认知，避免 note:step-N 动作流水账。")

    if ops_have_intent_flow_gap_body(ops):
        hints.append("flow:/gap: 的 body 请写已确认事实或待验证问题，勿写「查看/待读/继续搜」类计划。")

    if thread_id and ops_flat_under_goal_only(ops):
        flows = _list_flow_ids(thread_id)
        if flows:
            sample = flows[0]
            hints.append(
                f"已有链路节点（如 {sample}）；新建 file:/gap: 请 parent 指向 flow:…，勿全部挂 goal:session。"
            )

    if name in EVIDENCE_TOOLS and not ops_include_body_distill(ops):
        path = _path_from_tool_args(name, tool_args)
        fid = f"file:{path}" if path else "file:…"
        hints.append(
            f"取证已执行；若有新确认事实，可用 mind_map patch_node append_body 追加 {fid}。"
            "无新发现则跳过 mind_map，优先 replace/write 或收口。"
        )

    if thread_id:
        empty_files = _list_empty_file_nodes(thread_id)
        touched = ops_touch_file_ids(ops)
        pending = [eid for eid in empty_files if eid not in touched]
        if pending and not ops_include_body_distill(ops):
            joined = "、".join(pending[:3])
            hints.append(
                f"以下 file 节点 body 仍为空：{joined}；有结论时再 patch_node append_body，勿空转。"
            )

    if thread_id and _graph_node_count(thread_id) >= 4 and _graph_edge_count(thread_id) == 0 and not ops_include_edge(ops):
        hints.append("可用 upsert_edge 连接 flow→file 或 flow→gap（rel: depends / part_of），便于导图成树。")

    status_patched = ops_status_patched_ids(ops)
    for _claim_id, parent in ops_upsert_claim_parents(ops):
        if not parent.startswith("flow:"):
            continue
        if parent in status_patched:
            continue
        # No thread_id → still remind; with thread_id skip if flow already closed.
        flow_open = (not thread_id) or (
            _node_status(thread_id, parent) not in _CLOSED_STATUSES
        )
        if flow_open:
            hints.append(
                f"已写 claim；该分支处理完请同步 patch_node {parent} 设置 status=resolved/verified 并用 body 覆盖写结论（勿 append_body）。"
            )
        active_gaps = _list_active_gaps_for_flow(thread_id, parent) if thread_id else []
        untouched_gaps = [g for g in active_gaps if g not in status_patched]
        if untouched_gaps:
            sample = "、".join(untouched_gaps[:3])
            hints.append(
                f"分支 {parent} 下仍有 open gap（{sample}）；若已证实/排除请 patch_node 更新 gap 的 status 与 body。"
            )

    # de-dupe while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for h in hints:
        if h in seen:
            continue
        seen.add(h)
        out.append(h)
    return out[:4]


def sibling_tool_names_for_call(messages: list[Any], tool_call_id: str) -> tuple[list[str], bool]:
    """Return tool names from the AIMessage batch that issued ``tool_call_id``."""
    from langchain_core.messages import AIMessage

    cid = str(tool_call_id or "").strip()
    if not cid:
        return [], False
    for msg in reversed(messages or []):
        if not isinstance(msg, AIMessage):
            continue
        tcs = getattr(msg, "tool_calls", None) or []
        batch: list[str] = []
        matched = False
        for tc in tcs:
            if not isinstance(tc, dict):
                continue
            tc_id = str(tc.get("id") or "").strip()
            name = str(tc.get("name") or "").strip().lower()
            if tc_id:
                batch.append(name)
            if tc_id == cid:
                matched = True
        if matched:
            return batch, True
    return [], False


def sibling_evidence_tool_call_ids(messages: list[Any], tool_call_id: str) -> tuple[list[str], bool]:
    """Return evidence tool_call ids from the AIMessage batch that issued ``tool_call_id``."""
    from langchain_core.messages import AIMessage

    cid = str(tool_call_id or "").strip()
    if not cid:
        return [], False
    for msg in reversed(messages or []):
        if not isinstance(msg, AIMessage):
            continue
        tcs = getattr(msg, "tool_calls", None) or []
        evidence_ids: list[str] = []
        matched = False
        for tc in tcs:
            if not isinstance(tc, dict):
                continue
            tc_id = str(tc.get("id") or "").strip()
            name = str(tc.get("name") or "").strip().lower()
            if tc_id and name in EVIDENCE_TOOLS:
                evidence_ids.append(tc_id)
            if tc_id == cid:
                matched = True
        if matched:
            return evidence_ids, True
    return [], False


def collect_evidence_tool_mind_map_hints(
    *,
    tool_name: str,
    tool_args: dict[str, Any],
    batch_has_mind_map: bool,
    thread_id: str,
    is_first_evidence_in_batch: bool = True,
) -> list[str]:
    """Soft hints on evidence ToolMessages — optional append when there are new facts.

    Only nags when mind_map was NOT called in the same batch, and only for the
    **first** evidence tool in that batch (avoids N identical tips on parallel rg/read).
    """
    name = str(tool_name or "").strip().lower()
    if name not in EVIDENCE_TOOLS:
        return []
    if batch_has_mind_map:
        # Model already called mind_map in this batch — no nag needed.
        return []
    if not is_first_evidence_in_batch:
        return []
    path = _path_from_tool_args(name, tool_args)
    # Suppress nag for verification re-reads:
    #   1. path already in read registry (re-read for verification)
    #   2. path matches a file the model has written this session (read-back to verify edit)
    #   3. thread has write entries at all (active editing phase → reads are likely verification)
    if path and thread_id:
        try:
            from evoflow.context.working_memory import list_entries, list_write_entries
            already_read = any(path in str(e) for e in list_entries(thread_id))
            if already_read:
                return []
            written_paths = [str(getattr(e, "path", "") or str(e)) for e in list_write_entries(thread_id)]
            if any(path in wp or wp in path for wp in written_paths if wp):
                return []
            # If the thread has significant write activity (≥2 files modified),
            # evidence reads are almost certainly verification — suppress nag.
            if len(written_paths) >= 2:
                return []
        except Exception:
            pass
    fid = f"file:{path}" if path else "file:…"
    return [
        f"本批未并发 mind_map。若有新确认事实，可用 patch_node append_body 追加 {fid}；"
        f"无新发现则跳过，优先 replace/write 或收口总结。"
    ]


def append_evidence_tool_mind_map_hints(
    result: ToolMessage | Any,
    *,
    tool_name: str,
    tool_args: dict[str, Any],
    batch_has_mind_map: bool,
    thread_id: str,
    is_first_evidence_in_batch: bool = True,
) -> ToolMessage | Any:
    if not isinstance(result, ToolMessage):
        return result
    if str(getattr(result, "status", None) or "") == "error":
        return result
    content = str(result.content or "")
    if content.strip().startswith("Error:"):
        return result
    if "[思维导图提示]" in content:
        return result
    if not evidence_tool_output_has_substance(content):
        return result

    hints = collect_evidence_tool_mind_map_hints(
        tool_name=tool_name,
        tool_args=tool_args,
        batch_has_mind_map=batch_has_mind_map,
        thread_id=thread_id,
        is_first_evidence_in_batch=is_first_evidence_in_batch,
    )
    if not hints:
        return result

    block = "\n\n[思维导图提示] " + " ".join(f"({i + 1}) {h}" for i, h in enumerate(hints))
    return ToolMessage(
        content=f"{content.rstrip()}{block}",
        tool_call_id=result.tool_call_id,
        name=getattr(result, "name", None) or tool_name,
        status=getattr(result, "status", None),
    )


def append_mind_map_hints(
    result: ToolMessage | Any,
    *,
    tool_name: str,
    tool_args: dict[str, Any],
    ops: list[dict[str, Any]],
    thread_id: str,
) -> ToolMessage | Any:
    if not isinstance(result, ToolMessage):
        return result
    if str(getattr(result, "status", None) or "") == "error":
        return result
    content = str(result.content or "")
    if content.strip().startswith("Error:"):
        return result

    hints = collect_mind_map_soft_hints(
        tool_name=tool_name,
        tool_args=tool_args,
        ops=ops,
        thread_id=thread_id,
    )
    if not hints:
        return result

    block = "\n\n[思维导图提示] " + " ".join(f"({i + 1}) {h}" for i, h in enumerate(hints))
    return ToolMessage(
        content=f"{content.rstrip()}{block}",
        tool_call_id=result.tool_call_id,
        name=getattr(result, "name", None) or tool_name,
        status=getattr(result, "status", None),
    )
