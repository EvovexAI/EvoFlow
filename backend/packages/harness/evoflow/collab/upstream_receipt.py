"""Upstream receipt: child Task terminal → soft-wake orchestrating superior.

Parent Tasks are often ``awaiting_close`` after handoff (本岗已交、整单待验收),
so we do **not** reopen or rewrite parent status/progress. The value is an
action signal:

- Direct manager (parent ``assigned_to``) can fan-out the next hop (e.g. test).
- When all siblings under that parent are terminal, also nudge ``raised_by``
  one hop up (e.g. product / 小V) to accept and ``completed`` the root.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_TERMINAL = frozenset(
    {
        "completed",
        "reviewed",
        "awaiting_close",
        "failed",
        "error",
        "cancelled",
        "canceled",
    }
)


def is_terminal_status(status: Any) -> bool:
    return str(status or "").strip().lower() in _TERMINAL


def list_child_task_rows(parent_task_id: str) -> list[dict[str, Any]]:
    """All main-task rows whose ``parent_task_id`` matches."""
    from evoflow.collab.storage import get_project_storage

    pid = str(parent_task_id or "").strip()
    if not pid:
        return []
    storage = get_project_storage()
    out: list[dict[str, Any]] = []
    for summary in storage.list_projects():
        proj = storage.load_project(summary["id"])
        if not proj:
            continue
        for t in proj.get("tasks") or []:
            if str(t.get("parent_task_id") or "").strip() != pid:
                continue
            tid = str(t.get("id") or "").strip()
            if tid:
                out.append(t)
    return out


def sibling_rollup(parent_task_id: str) -> dict[str, Any]:
    """Count terminal vs open direct children under ``parent_task_id``."""
    rows = list_child_task_rows(parent_task_id)
    done: list[dict[str, str]] = []
    open_rows: list[dict[str, str]] = []
    for t in rows:
        tid = str(t.get("id") or "").strip()
        st = str(t.get("status") or "").strip().lower()
        assignee = str(t.get("assigned_to") or "").strip()
        bit = {"task_id": tid, "status": st, "assigned_to": assignee}
        if is_terminal_status(st):
            done.append(bit)
        else:
            open_rows.append(bit)
    return {
        "total": len(rows),
        "done": len(done),
        "open": len(open_rows),
        "all_done": bool(rows) and not open_rows,
        "done_rows": done,
        "open_rows": open_rows,
    }


def list_descendant_task_rows(root_task_id: str) -> list[dict[str, Any]]:
    """All descendants under ``root_task_id`` (BFS via ``parent_task_id``)."""
    root = str(root_task_id or "").strip()
    if not root:
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    queue = [root]
    while queue:
        pid = queue.pop(0)
        for child in list_child_task_rows(pid):
            cid = str(child.get("id") or "").strip()
            if not cid or cid in seen:
                continue
            seen.add(cid)
            out.append(child)
            queue.append(cid)
    return out


def find_root_task_row(task: dict[str, Any]) -> dict[str, Any] | None:
    """Climb ``parent_task_id`` until the root main-task row."""
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    cur = dict(task or {})
    seen: set[str] = set()
    while True:
        tid = str(cur.get("id") or cur.get("task_id") or "").strip()
        parent_id = str(cur.get("parent_task_id") or "").strip()
        if not parent_id:
            return cur if tid else None
        if tid:
            seen.add(tid)
        if parent_id in seen:
            return cur
        found = find_main_task(storage, parent_id, bypass_cache=True)
        if not found:
            return cur if tid else None
        cur = found[1]


def tree_descendants_all_terminal(root_task_id: str) -> dict[str, Any]:
    """Whether every descendant under the root is terminal (root itself ignored)."""
    rows = list_descendant_task_rows(root_task_id)
    open_rows = [
        {
            "task_id": str(t.get("id") or "").strip(),
            "status": str(t.get("status") or "").strip().lower(),
            "assigned_to": str(t.get("assigned_to") or "").strip(),
        }
        for t in rows
        if not is_terminal_status(t.get("status"))
    ]
    done_n = len(rows) - len(open_rows)
    return {
        "total": len(rows),
        "done": done_n,
        "open": len(open_rows),
        "all_done": bool(rows) and not open_rows,
        "open_rows": open_rows,
        "rows": rows,
    }


def build_tree_receipt_summary_lines(
    *,
    root: dict[str, Any],
    tree: dict[str, Any],
) -> list[str]:
    lines: list[str] = []
    name = str(root.get("name") or "").strip()
    if name:
        lines.append(f"标题：{name}")
    summary = str(root.get("summary") or root.get("result") or "").strip()
    if summary:
        if len(summary) > 200:
            summary = summary[:199] + "…"
        lines.append(f"根结论：{summary}")
    lines.append(f"下游结案：{tree.get('done', 0)}/{tree.get('total', 0)}")
    for t in (tree.get("rows") or [])[:8]:
        tid = str(t.get("id") or "").strip()
        st = str(t.get("status") or "").strip().lower()
        who = str(t.get("assigned_to") or "").strip() or "?"
        bit = str(t.get("summary") or t.get("result") or "").strip()
        if len(bit) > 80:
            bit = bit[:79] + "…"
        line = f"- `{tid}` [{st}] {who}"
        if bit:
            line += f"：{bit}"
        lines.append(line)
    return lines


def _run_async(coro: Any) -> Any:
    """Run ``coro`` whether or not a loop is already running."""
    import asyncio
    import concurrent.futures

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


def maybe_push_tree_receipt_feishu(
    *,
    child: dict[str, Any],
    parent: dict[str, Any],
    all_siblings_done: bool,
) -> dict[str, Any] | None:
    """When the whole handoff tree under the root is terminal, push Feishu once."""
    if not all_siblings_done:
        return None

    root = find_root_task_row(parent) or find_root_task_row(child)
    if not root:
        return None
    root_id = str(root.get("id") or root.get("task_id") or "").strip()
    if not root_id:
        return None
    if str(root.get("tree_receipt_pushed_at") or "").strip():
        return {"ok": True, "skipped": True, "reason": "already_pushed", "root_task_id": root_id}

    tree = tree_descendants_all_terminal(root_id)
    # Ensure current child counts as done (storage race).
    child_id = str(child.get("id") or child.get("task_id") or "").strip()
    if child_id and any(
        str(r.get("task_id") or "") == child_id for r in (tree.get("open_rows") or [])
    ):
        tree = dict(tree)
        tree["open"] = max(0, int(tree.get("open") or 0) - 1)
        tree["done"] = int(tree.get("done") or 0) + 1
        tree["open_rows"] = [
            r for r in (tree.get("open_rows") or []) if str(r.get("task_id") or "") != child_id
        ]
        tree["all_done"] = tree["open"] == 0 and int(tree.get("total") or 0) > 0

    if not tree.get("all_done"):
        return {
            "ok": True,
            "skipped": True,
            "reason": "tree_not_complete",
            "root_task_id": root_id,
            "open": tree.get("open"),
            "total": tree.get("total"),
        }

    try:
        from evoflow.proactive.feishu_notify import push_collab_tree_receipt

        mid = _run_async(
            push_collab_tree_receipt(
                root_task_id=root_id,
                root_name=str(root.get("name") or "").strip(),
                summary_lines=build_tree_receipt_summary_lines(root=root, tree=tree),
                child_task_id=child_id,
                raised_by=str(root.get("raised_by") or "").strip(),
            )
        )
    except Exception as e:
        logger.exception("upstream_receipt: feishu tree push failed root=%s", root_id)
        return {"ok": False, "root_task_id": root_id, "error": str(e)}

    if mid:
        try:
            from evoflow.collab.storage import (
                get_project_storage,
                patch_collab_main_task_in_project_storage,
            )
            from evoflow.timeutil import utc_now_iso_z

            patch_collab_main_task_in_project_storage(
                get_project_storage(),
                root_id,
                {"tree_receipt_pushed_at": utc_now_iso_z()},
            )
        except Exception:
            logger.debug("upstream_receipt: stamp tree_receipt_pushed_at failed", exc_info=True)

    # Best-effort: Feishu is the user-facing receipt; desktop is optional later.
    return {
        "ok": bool(mid),
        "root_task_id": root_id,
        "message_id": mid,
        "done": tree.get("done"),
        "total": tree.get("total"),
    }


def resolve_upstream_targets(
    child: dict[str, Any],
    parent: dict[str, Any],
    *,
    all_siblings_done: bool,
) -> list[str]:
    """Ordered unique agent_codes to soft-wake (manager first, then raised_by)."""
    child_code = str(child.get("assigned_to") or "").strip()
    targets: list[str] = []

    def _add(code: str) -> None:
        c = str(code or "").strip()
        if not c or c.lower() in {"user", "system"}:
            return
        if c == child_code:
            return
        if c not in targets:
            targets.append(c)

    _add(str(parent.get("assigned_to") or "").strip())
    # Fallback when parent has no assignee: child's raised_by (usually dispatcher).
    if not targets:
        _add(str(child.get("raised_by") or "").strip())
        _add(str(parent.get("raised_by") or "").strip())

    # One hop up when this fan-out batch is fully settled.
    if all_siblings_done:
        _add(str(parent.get("raised_by") or "").strip())

    return targets


def build_receipt_goal(
    *,
    child: dict[str, Any],
    parent: dict[str, Any],
    child_status: str,
    rollup: dict[str, Any],
) -> str:
    child_id = str(child.get("id") or child.get("task_id") or "").strip()
    parent_id = str(parent.get("id") or parent.get("task_id") or "").strip()
    child_name = str(child.get("name") or "").strip() or child_id
    child_assignee = str(child.get("assigned_to") or "").strip() or "?"
    summary = str(child.get("summary") or child.get("result") or "").strip()
    if len(summary) > 240:
        summary = summary[:239] + "…"
    st = str(child_status or "").strip().lower() or "?"
    st_zh = {
        "completed": "已完成",
        "reviewed": "已完成",
        "awaiting_close": "待闭环",
        "failed": "失败",
        "error": "失败",
        "cancelled": "已取消",
        "canceled": "已取消",
    }.get(st, st)

    lines = [
        "【下游回执】系统自动通知：你派发/编排的下游已结案。",
        "这是验收信号，**禁止新建**任何任务（含同名「下游回执」单）。",
        "请只在下方「上游编排单」上复核并操作：",
        "- 验收通过 → 对该编排单/根单 ``tasks state … --status completed`` 真正闭环；",
        "- 仍需下游 → 在该单上再填 handlers 派下一步；不要重做已完成的下游单。",
        f"- 下游 Task `{child_id}`（{child_assignee}）状态：**{st_zh}** · {child_name}",
    ]
    if summary:
        lines.append(f"- 下游结论：{summary}")
    lines.append(
        f"- 同级进度：{rollup.get('done', 0)}/{rollup.get('total', 0)} 已结案"
        + ("（全部结案）" if rollup.get("all_done") else "")
    )
    if rollup.get("open_rows"):
        open_bits = [
            f"`{r['task_id']}`({r.get('assigned_to') or '?'})"
            for r in (rollup.get("open_rows") or [])[:6]
        ]
        lines.append(f"- 仍未结：{', '.join(open_bits)}")
    if rollup.get("all_done"):
        lines.append(
            "- 建议：同级下游已齐。编排岗继续下一步；提出人请验收根单并 ``completed`` 闭环"
            "（根单若仍是「待闭环 / awaiting_close」不要当成已完成；进度 100% ≠ 整单结束）。"
        )
    else:
        lines.append("- 建议：可等待其余同级结案，或先处理已回执项——仍在原编排单上操作。")
    if parent_id:
        lines.append(
            f"- 你的上游编排单：`{parent_id}`（本轮 wake 已绑定此 id；待闭环期间可继续编排，验收后再 completed）"
        )
    return "\n".join(lines)


def notify_upstream_on_child_terminal(
    child_task: dict[str, Any],
    *,
    terminal_status: str,
) -> dict[str, Any] | None:
    """Soft-wake superiors after a child main-task reaches a terminal status.

    Idempotent per child via ``upstream_receipt_at``. Never raises to callers.
    """
    from evoflow.collab.storage import (
        find_main_task,
        get_project_storage,
        patch_collab_main_task_in_project_storage,
    )
    from evoflow.timeutil import utc_now_iso_z

    child = dict(child_task or {})
    child_id = str(child.get("id") or child.get("task_id") or "").strip()
    parent_id = str(child.get("parent_task_id") or "").strip()
    if not child_id or not parent_id:
        return None
    if str(child.get("upstream_receipt_at") or "").strip():
        try:
            from evoflow.person_kernel import on_handoff_fulfilled

            on_handoff_fulfilled(
                child_task_id=child_id,
                child_agent=str(child.get("assigned_to") or "").strip(),
                upstream_agent=str(child.get("raised_by") or "").strip(),
            )
        except Exception:
            logger.debug(
                "person_kernel on_handoff_fulfilled (idempotent skip path) failed",
                exc_info=True,
            )
        return {"ok": True, "skipped": True, "reason": "already_notified", "task_id": child_id}
    if not is_terminal_status(terminal_status):
        return None

    storage = get_project_storage()
    found = find_main_task(storage, parent_id, bypass_cache=True)
    if not found:
        return {"ok": False, "reason": "parent_missing", "parent_task_id": parent_id}
    _proj, parent = found

    # Merge latest status onto child view for goal text.
    child = {**child, "status": terminal_status}
    rollup = sibling_rollup(parent_id)
    # Ensure current child counts as done even if storage race.
    if not any(r.get("task_id") == child_id for r in rollup.get("done_rows") or []):
        rollup = dict(rollup)
        rollup["done"] = int(rollup.get("done") or 0) + 1
        rollup["open"] = max(0, int(rollup.get("open") or 0) - 1)
        rollup["total"] = max(int(rollup.get("total") or 0), rollup["done"] + rollup["open"])
        rollup["all_done"] = rollup["open"] == 0 and rollup["total"] > 0
        rollup.setdefault("done_rows", []).append(
            {
                "task_id": child_id,
                "status": str(terminal_status).lower(),
                "assigned_to": str(child.get("assigned_to") or ""),
            }
        )

    targets = resolve_upstream_targets(
        child, parent, all_siblings_done=bool(rollup.get("all_done"))
    )
    now = utc_now_iso_z()
    wakes: list[dict[str, Any]] = []
    goal = ""
    if targets:
        goal = build_receipt_goal(
            child=child,
            parent=parent,
            child_status=terminal_status,
            rollup=rollup,
        )
        try:
            from evoflow.admin import employees as employees_admin
            from evoflow.admin.errors import ConflictError, ValidationError
        except Exception:
            logger.exception("upstream_receipt: cannot import employees admin")
            return {"ok": False, "reason": "import_failed", "task_id": child_id}

        from_agent = str(child.get("assigned_to") or "").strip() or "system"
        for code in targets:
            try:
                # Soft-wake on the *parent* orchestration board row — never mint a
                # fresh「【下游回执】…」wrapper Task (task-center duplicate noise).
                result = employees_admin.wake(
                    code,
                    goal=goal,
                    from_agent=from_agent,
                    description="下游回执（系统）",
                    source="role",
                    task_id=parent_id,
                    skip_done_guard=True,
                )
                wakes.append({"agent_code": code, "ok": True, "result": result})
            except ConflictError as e:
                wakes.append({"agent_code": code, "ok": False, "busy": True, "error": str(e)})
                logger.info(
                    "upstream_receipt: target busy agent=%s child=%s", code, child_id
                )
            except ValidationError as e:
                wakes.append({"agent_code": code, "ok": False, "error": str(e)})
                logger.info(
                    "upstream_receipt: wake validation agent=%s child=%s err=%s",
                    code,
                    child_id,
                    e,
                )
            except Exception as e:
                wakes.append({"agent_code": code, "ok": False, "error": str(e)})
                logger.exception(
                    "upstream_receipt: wake failed agent=%s child=%s", code, child_id
                )

    feishu_push: dict[str, Any] | None = None
    try:
        feishu_push = maybe_push_tree_receipt_feishu(
            child=child,
            parent=parent,
            all_siblings_done=bool(rollup.get("all_done")),
        )
    except Exception:
        logger.exception("upstream_receipt: tree feishu push failed child=%s", child_id)

    receipt = {
        "at": now,
        "child_task_id": child_id,
        "child_status": str(terminal_status).strip().lower(),
        "child_assignee": str(child.get("assigned_to") or "").strip(),
        "all_siblings_done": bool(rollup.get("all_done")),
        "wakes": [
            {"agent_code": w.get("agent_code"), "ok": w.get("ok"), "busy": w.get("busy")}
            for w in wakes
        ],
        "feishu_tree_receipt": feishu_push,
    }
    try:
        existing = list(parent.get("downstream_receipts") or [])
        if not isinstance(existing, list):
            existing = []
        existing.append(receipt)
        patch_collab_main_task_in_project_storage(
            storage,
            parent_id,
            {"downstream_receipts": existing[-30:]},
        )
    except Exception:
        logger.debug("upstream_receipt: stamp parent receipts failed", exc_info=True)

    try:
        patch_collab_main_task_in_project_storage(
            storage,
            child_id,
            {"upstream_receipt_at": now},
        )
    except Exception:
        logger.debug("upstream_receipt: stamp child failed", exc_info=True)

    # Person Kernel Phase D: close open handoff commitments + soft affect
    try:
        from evoflow.person_kernel import on_handoff_fulfilled

        child_agent = str(child.get("assigned_to") or "").strip()
        upstream = ""
        if targets:
            upstream = str(targets[0] or "").strip()
        if not upstream:
            upstream = str(parent.get("assigned_to") or parent.get("raised_by") or "").strip()
        on_handoff_fulfilled(
            child_task_id=child_id,
            child_agent=child_agent,
            upstream_agent=upstream,
        )
    except Exception:
        logger.debug(
            "person_kernel on_handoff_fulfilled skipped child=%s",
            child_id,
            exc_info=True,
        )

    return {
        "ok": (
            any(w.get("ok") for w in wakes)
            or any(w.get("busy") for w in wakes)
            or bool(feishu_push and feishu_push.get("ok"))
            or (not targets and feishu_push is not None)
        ),
        "task_id": child_id,
        "parent_task_id": parent_id,
        "targets": targets,
        "all_siblings_done": bool(rollup.get("all_done")),
        "wakes": wakes,
        "receipt": receipt,
        "feishu_tree_receipt": feishu_push,
    }
