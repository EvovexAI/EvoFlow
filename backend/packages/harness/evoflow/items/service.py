"""用户事项业务：CRUD、派发为 Task、从 inbox 迁移。"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.items.models import (
    ITEM_PRIORITIES,
    ITEM_STATUSES,
    ItemPriority,
    ItemStatus,
    UserItem,
)
from evoflow.items import store as item_store
from evoflow.timeutil import beijing_now_iso

logger = logging.getLogger(__name__)


def _now() -> str:
    return beijing_now_iso()


def _new_id() -> str:
    return f"item_{uuid.uuid4().hex[:12]}"


def _normalize_tags(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace("，", ",").split(",")]
        return [p for p in parts if p][:20]
    if isinstance(raw, list):
        out: list[str] = []
        for x in raw:
            s = str(x or "").strip()
            if s and s not in out:
                out.append(s)
            if len(out) >= 20:
                break
        return out
    return []


def _parse_item(row: dict[str, Any]) -> UserItem:
    try:
        return UserItem.model_validate(row)
    except Exception as exc:
        raise ValidationError(f"invalid item row: {exc}") from exc


def list_items(
    *,
    status: str | None = None,
    priority: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    include_done: bool = True,
    page: int = 1,
    page_size: int = 20,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
    filter_visibility: bool = False,
) -> dict[str, Any]:
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    status_f = str(status or "").strip().lower() or None
    priority_f = str(priority or "").strip().lower() or None
    tag_f = str(tag or "").strip() or None
    query = str(q or "").strip().lower() or None
    try:
        page_n = max(1, int(page or 1))
    except (TypeError, ValueError):
        page_n = 1
    try:
        size_n = int(page_size or 20)
    except (TypeError, ValueError):
        size_n = 20
    size_n = max(1, min(200, size_n))

    rows: list[dict[str, Any]] = []
    for raw in item_store.list_raw_items():
        if not isinstance(raw, dict):
            continue
        try:
            item = _parse_item(raw)
        except ValidationError:
            continue
        if filter_visibility and not owner_scope_visible_to_principal(
            item.owner_scope_id,
            principal,
            is_admin=is_admin,
            personal_scope=personal_scope,
            org_scope=org_scope,
        ):
            continue
        if status_f and str(item.status) != status_f:
            continue
        if priority_f and str(item.priority) != priority_f:
            continue
        if not include_done and item.status == ItemStatus.DONE:
            continue
        if tag_f and tag_f not in (item.tags or []):
            continue
        if query:
            blob = f"{item.title} {item.notes} {item.conclusion} {' '.join(item.tags or [])}".lower()
            if query not in blob:
                continue
        rows.append(item.to_public_dict())
    rows.sort(key=lambda r: (r.get("updated_at") or "", r.get("created_at") or ""), reverse=True)
    total = len(rows)
    pages = max(1, (total + size_n - 1) // size_n) if total else 1
    if page_n > pages:
        page_n = pages
    start = (page_n - 1) * size_n
    page_rows = rows[start : start + size_n]
    return {
        "ok": True,
        "items": page_rows,
        "total": total,
        "page": page_n,
        "page_size": size_n,
        "pages": pages,
    }


def item_visible_to_principal(
    item_id: str,
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
) -> bool:
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    iid = str(item_id or "").strip()
    if not iid:
        return False
    for raw in item_store.list_raw_items():
        if isinstance(raw, dict) and str(raw.get("id") or "") == iid:
            try:
                item = _parse_item(raw)
            except ValidationError:
                return False
            return owner_scope_visible_to_principal(
                item.owner_scope_id,
                principal,
                is_admin=is_admin,
                personal_scope=personal_scope,
                org_scope=org_scope,
            )
    return False


def get_item(item_id: str) -> dict[str, Any]:
    iid = str(item_id or "").strip()
    if not iid:
        raise ValidationError("item_id is required")
    for raw in item_store.list_raw_items():
        if isinstance(raw, dict) and str(raw.get("id") or "") == iid:
            return {"ok": True, "item": _parse_item(raw).to_public_dict()}
    raise NotFoundError(f"item '{iid}' not found")


def create_item(
    *,
    title: str,
    notes: str = "",
    conclusion: str = "",
    status: str | None = None,
    priority: str | None = None,
    due_at: str | None = None,
    tags: Any = None,
    assignee_intent: str | None = None,
    assignee_label: str | None = None,
    source: str = "user",
    source_ref: str | None = None,
    progress: int | None = None,
    org_id: str | None = None,
    owner_scope_id: str | None = None,
    created_by: str | None = None,
) -> dict[str, Any]:
    title_n = str(title or "").strip()
    if not title_n:
        raise ValidationError("title is required")
    st = str(status or ItemStatus.TODO).strip().lower()
    if st not in ITEM_STATUSES:
        raise ValidationError(f"invalid status: {st}")
    pri = str(priority or ItemPriority.NORMAL).strip().lower()
    if pri not in ITEM_PRIORITIES:
        raise ValidationError(f"invalid priority: {pri}")
    now = _now()
    item = UserItem(
        id=_new_id(),
        title=title_n,
        notes=str(notes or "").strip(),
        conclusion=str(conclusion or "").strip(),
        status=ItemStatus(st),
        priority=ItemPriority(pri),
        due_at=str(due_at or "").strip() or None,
        tags=_normalize_tags(tags),
        assignee_intent=str(assignee_intent or "").strip() or None,
        assignee_label=str(assignee_label or "").strip() or None,
        linked_task_ids=[],
        progress=max(0, min(100, int(progress if progress is not None else 0))),
        source=str(source or "user").strip() or "user",
        source_ref=str(source_ref or "").strip() or None,
        org_id=str(org_id or "").strip() or None,
        owner_scope_id=str(owner_scope_id or "").strip() or None,
        created_by=str(created_by or "").strip() or None,
        created_at=now,
        updated_at=now,
    )
    saved = item_store.upsert_raw_item(item.model_dump())
    return {"ok": True, "item": _parse_item(saved).to_public_dict()}


def update_item(item_id: str, patch: dict[str, Any] | None) -> dict[str, Any]:
    iid = str(item_id or "").strip()
    if not iid:
        raise ValidationError("item_id is required")
    patch = patch if isinstance(patch, dict) else {}
    found: dict[str, Any] | None = None
    for raw in item_store.list_raw_items():
        if isinstance(raw, dict) and str(raw.get("id") or "") == iid:
            found = dict(raw)
            break
    if found is None:
        raise NotFoundError(f"item '{iid}' not found")
    item = _parse_item(found)

    if "title" in patch:
        title_n = str(patch.get("title") or "").strip()
        if not title_n:
            raise ValidationError("title cannot be empty")
        item.title = title_n
    if "notes" in patch:
        item.notes = str(patch.get("notes") or "").strip()
    if "conclusion" in patch:
        item.conclusion = str(patch.get("conclusion") or "").strip()
    if "status" in patch and patch.get("status") is not None:
        st = str(patch.get("status") or "").strip().lower()
        if st not in ITEM_STATUSES:
            raise ValidationError(f"invalid status: {st}")
        item.status = ItemStatus(st)
        if item.status == ItemStatus.DONE and item.progress < 100:
            item.progress = 100
    if "priority" in patch and patch.get("priority") is not None:
        pri = str(patch.get("priority") or "").strip().lower()
        if pri not in ITEM_PRIORITIES:
            raise ValidationError(f"invalid priority: {pri}")
        item.priority = ItemPriority(pri)
    if "due_at" in patch:
        due = str(patch.get("due_at") or "").strip()
        item.due_at = due or None
    if "tags" in patch:
        item.tags = _normalize_tags(patch.get("tags"))
    if "assignee_intent" in patch:
        item.assignee_intent = str(patch.get("assignee_intent") or "").strip() or None
    if "assignee_label" in patch:
        item.assignee_label = str(patch.get("assignee_label") or "").strip() or None
    if "progress" in patch and patch.get("progress") is not None:
        item.progress = max(0, min(100, int(patch.get("progress") or 0)))
    if "linked_task_ids" in patch and isinstance(patch.get("linked_task_ids"), list):
        ids: list[str] = []
        for x in patch["linked_task_ids"]:
            s = str(x or "").strip()
            if s and s not in ids:
                ids.append(s)
        item.linked_task_ids = ids

    item.updated_at = _now()
    saved = item_store.upsert_raw_item(item.model_dump())
    public = _parse_item(saved).to_public_dict()
    # Minimal memory hygiene: when an item is marked done, stale matching memories.
    if "status" in patch and str(public.get("status") or "") == "done":
        try:
            from evoflow.memory.stale_on_close import stale_memories_on_close

            stale = stale_memories_on_close(
                title=str(public.get("title") or ""),
                notes=str(public.get("notes") or ""),
                agent_code=str(public.get("assignee_intent") or ""),
                source_ref=f"item:{iid}",
                reason="item marked done",
            )
            return {"ok": True, "item": public, "memories_stale": stale}
        except Exception:
            logger.debug("item done → memory stale hook failed", exc_info=True)
    return {"ok": True, "item": public}


def delete_item(item_id: str) -> dict[str, Any]:
    iid = str(item_id or "").strip()
    if not iid:
        raise ValidationError("item_id is required")
    if not item_store.delete_raw_item(iid):
        raise NotFoundError(f"item '{iid}' not found")
    return {"ok": True, "deleted": iid}


def _stamp_task_user_item(task_id: str, item_id: str) -> None:
    """在 Task 文档上写入 user_item_id（双向关联）。"""
    tid = str(task_id or "").strip()
    iid = str(item_id or "").strip()
    if not tid or not iid:
        return
    try:
        from evoflow.collab.storage import find_main_task, get_project_storage

        storage = get_project_storage()
        found = find_main_task(storage, tid, bypass_cache=True)
        if not found:
            return
        project, task = found
        if not isinstance(task, dict) or not isinstance(project, dict):
            return
        task["user_item_id"] = iid
        storage.save_project(project)
    except Exception:
        logger.debug("stamp user_item_id on task failed", exc_info=True)


def _link_task(item_id: str, task_id: str, *, status: ItemStatus | None = ItemStatus.WAITING) -> dict[str, Any]:
    data = get_item(item_id)
    item = data["item"]
    linked = list(item.get("linked_task_ids") or [])
    tid = str(task_id or "").strip()
    if tid and tid not in linked:
        linked.append(tid)
    patch: dict[str, Any] = {"linked_task_ids": linked}
    if status is not None:
        patch["status"] = str(status)
    return update_item(item_id, patch)


_OPEN_TASK_STATUSES = frozenset(
    {
        "inbox",
        "pending",
        "planned",
        "planning",
        "executing",
        "waiting_dispatch",
        "waiting_user",
        "awaiting_close",
        "paused",
    }
)

_TERMINAL_LINK_STATUSES = frozenset({"cancelled", "canceled", "deleted"})

_dispatch_locks_guard = threading.Lock()
_dispatch_locks: dict[str, threading.Lock] = {}


def _item_agent_lock(item_id: str, agent_code: str) -> threading.Lock:
    key = f"{str(item_id or '').strip()}::{str(agent_code or '').strip().lower()}"
    with _dispatch_locks_guard:
        lock = _dispatch_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _dispatch_locks[key] = lock
        return lock


def _find_open_linked_task_for_agent(item: dict[str, Any], agent_code: str) -> dict[str, Any] | None:
    """Return an open linked Task for this agent, if any (idempotent dispatch)."""
    code = str(agent_code or "").strip().lower()
    if not code:
        return None
    try:
        from evoflow.proactive.work_items import load_work_item_task
    except Exception:
        return None
    for raw_tid in item.get("linked_task_ids") or []:
        tid = str(raw_tid or "").strip()
        if not tid:
            continue
        try:
            row = load_work_item_task(tid)
        except Exception:
            row = None
        if not isinstance(row, dict):
            continue
        assigned = str(row.get("assigned_to") or "").strip().lower()
        status = str(row.get("status") or "").strip().lower().replace("-", "_")
        if assigned == code and status in _OPEN_TASK_STATUSES:
            return row
    return None


def _prune_cancelled_linked_ids(item_id: str) -> None:
    """Drop cancelled/deleted Task ids from linked_task_ids (keep completed for history)."""
    try:
        from evoflow.proactive.work_items import load_work_item_task
    except Exception:
        return
    data = get_item(item_id)
    item = data["item"]
    linked = [str(x).strip() for x in (item.get("linked_task_ids") or []) if str(x).strip()]
    if not linked:
        return
    keep: list[str] = []
    changed = False
    for tid in linked:
        try:
            row = load_work_item_task(tid)
        except Exception:
            row = None
        st = str((row or {}).get("status") or "").strip().lower().replace("-", "_")
        if st in _TERMINAL_LINK_STATUSES:
            changed = True
            continue
        keep.append(tid)
    if changed:
        update_item(item_id, {"linked_task_ids": keep})


def resolve_item_id_for_task(task: dict[str, Any] | None) -> str:
    """Resolve linked User Item id from ``user_item_id`` or ``source_ref=item:…``."""
    if not isinstance(task, dict):
        return ""
    uid = str(task.get("user_item_id") or "").strip()
    if uid:
        return uid
    ref = str(task.get("source_ref") or "").strip()
    if ref.lower().startswith("item:"):
        return ref.split(":", 1)[1].strip()
    return ""


def sync_item_from_linked_task(
    task_id: str,
    *,
    task: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Reflect main-task status/progress onto the linked User Item (best-effort).

    Policy (matches e2e expectation: Task completed → Item done):
    - If any linked Task is still open → item ``waiting``, progress = max of linked.
    - Else if ≥1 linked Task ``completed`` → item ``done`` / progress 100.
    - Else (all failed/cancelled) → item ``parked``.
    - Manual ``parked`` items are left alone.
    """
    tid = str(task_id or "").strip()
    if not tid:
        return None
    row = task if isinstance(task, dict) else None
    if row is None:
        try:
            from evoflow.proactive.work_items import load_work_item_task

            row = load_work_item_task(tid)
        except Exception:
            row = None
    if not isinstance(row, dict):
        return None

    iid = resolve_item_id_for_task(row)
    if not iid:
        return None
    try:
        item = get_item(iid)["item"]
    except Exception:
        return None

    cur_status = str(item.get("status") or "").strip().lower()
    if cur_status == ItemStatus.PARKED:
        return {"ok": True, "skipped": "item_parked", "item_id": iid}

    linked = [str(x).strip() for x in (item.get("linked_task_ids") or []) if str(x).strip()]
    if tid not in linked:
        linked = [*linked, tid]

    try:
        from evoflow.proactive.work_items import load_work_item_task
    except Exception:
        return None

    open_count = 0
    completed_count = 0
    failed_or_cancelled = 0
    progress_max = 0
    for link_tid in linked:
        try:
            link_row = load_work_item_task(link_tid)
        except Exception:
            link_row = None
        if link_tid == tid and isinstance(row, dict):
            # Prefer the just-saved row (loader may be briefly stale).
            link_row = {**(link_row or {}), **row, "id": tid}
        if not isinstance(link_row, dict):
            continue
        st = str(link_row.get("status") or "").strip().lower().replace("-", "_")
        if st in {"canceled", "deleted"}:
            st = "cancelled"
        try:
            prog = max(0, min(100, int(link_row.get("progress") or 0)))
        except (TypeError, ValueError):
            prog = 0
        if st == "completed":
            prog = 100
            completed_count += 1
        elif st in {"failed", "cancelled"}:
            failed_or_cancelled += 1
        elif st in _OPEN_TASK_STATUSES or st in {"", "idle"}:
            open_count += 1
        else:
            # Unknown non-terminal → treat as open so we do not close the item early.
            open_count += 1
        progress_max = max(progress_max, prog)

    patch: dict[str, Any] = {}
    if linked != list(item.get("linked_task_ids") or []):
        patch["linked_task_ids"] = linked

    if open_count > 0:
        desired_status = str(ItemStatus.WAITING)
        desired_progress = progress_max
    elif completed_count > 0:
        desired_status = str(ItemStatus.DONE)
        desired_progress = 100
    elif failed_or_cancelled > 0:
        desired_status = str(ItemStatus.PARKED)
        desired_progress = int(item.get("progress") or 0)
    else:
        return {"ok": True, "skipped": "no_linked_rows", "item_id": iid}

    if cur_status != desired_status:
        patch["status"] = desired_status
    try:
        cur_prog = int(item.get("progress") or 0)
    except (TypeError, ValueError):
        cur_prog = 0
    if cur_prog != desired_progress:
        patch["progress"] = desired_progress

    if not patch:
        return {
            "ok": True,
            "item_id": iid,
            "unchanged": True,
            "status": cur_status,
            "progress": cur_prog,
        }

    updated = update_item(iid, patch)
    public = (updated or {}).get("item") or {}
    return {
        "ok": True,
        "item_id": iid,
        "status": public.get("status") or desired_status,
        "progress": public.get("progress") if public.get("progress") is not None else desired_progress,
        "patched": sorted(patch.keys()),
    }


def _interpret_wake_result(dispatch_result: dict[str, Any] | None) -> tuple[bool, bool, bool, str]:
    """Return (woke, queued, interrupted, hint)."""
    if not isinstance(dispatch_result, dict):
        return False, False, False, ""
    interrupted = bool(dispatch_result.get("interrupted"))
    if dispatch_result.get("queued_behind_busy"):
        return False, True, False, str(
            dispatch_result.get("message")
            or dispatch_result.get("hint")
            or "员工忙碌，已排队待续跑"
        )
    if dispatch_result.get("busy") and dispatch_result.get("ok") is False:
        return False, False, False, str(dispatch_result.get("error") or "员工忙碌")
    if dispatch_result.get("ok") is False:
        return False, False, False, str(dispatch_result.get("error") or dispatch_result.get("hint") or "")
    if dispatch_result.get("dispatched") or dispatch_result.get("scheduled"):
        hint = str(dispatch_result.get("message") or "") if interrupted else ""
        return True, False, interrupted, hint
    if dispatch_result.get("skipped"):
        return False, False, False, str(dispatch_result.get("message") or dispatch_result.get("reason") or "已跳过")
    return False, False, False, ""


async def _wake_employee_for_item(
    *,
    agent_code: str,
    goal: str,
    description: str,
    task_id: str,
    interrupt: bool = False,
) -> dict[str, Any]:
    """Wake employee for an item-linked task; survive sync asyncio.run bridges.

    Platform/CLI wraps ``dispatch_item`` in a short-lived ``asyncio.run()``. If we
    ``create_task`` on that nested loop, the wake is cancelled when ``run`` exits.
    Prefer the long-lived Gateway ``ProactiveRunner`` loop via threadsafe schedule.

    ``interrupt=True`` cancels the current duty round before waking (L2).
    """
    from evoflow.proactive.runner import get_proactive_runner

    runner = get_proactive_runner()
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    owner = getattr(runner, "_asyncio_loop", None)
    kwargs = dict(
        description=description,
        related_task_id=task_id,
        source="user_item",
        priority="normal",
        interrupt=bool(interrupt),
    )
    if running is not None and owner is not None and running is owner:
        return await runner.dispatch_task_fire_and_forget(agent_code, goal, **kwargs)
    if owner is not None and owner.is_running():
        return runner.schedule_dispatch_fire_and_forget(agent_code, goal, **kwargs)
    if running is not None:
        runner._asyncio_loop = running
        return await runner.dispatch_task_fire_and_forget(agent_code, goal, **kwargs)
    return runner.schedule_dispatch_fire_and_forget(agent_code, goal, **kwargs)


async def _finish_dispatch_with_optional_wake(
    *,
    item_id: str,
    code: str,
    role_name: str,
    title: str,
    notes: str,
    task_id: str,
    already: bool,
    wake_now: bool,
    interrupt: bool = False,
) -> dict[str, Any]:
    update_item(
        item_id,
        {
            "assignee_intent": code,
            "assignee_label": role_name or code,
            "status": str(ItemStatus.WAITING),
        },
    )
    _prune_cancelled_linked_ids(item_id)
    dispatch_result: dict[str, Any] | None = None
    woke = False
    queued = False
    interrupted = False
    wake_hint = ""
    if wake_now and task_id:
        try:
            dispatch_result = await _wake_employee_for_item(
                agent_code=code,
                goal=title,
                description=notes or title,
                task_id=task_id,
                interrupt=interrupt,
            )
            woke, queued, interrupted, wake_hint = _interpret_wake_result(dispatch_result)
        except Exception as exc:
            logger.warning(
                "dispatch_item wake failed item=%s task=%s: %s",
                item_id,
                task_id,
                exc,
            )
            return {
                "ok": True,
                "item": get_item(item_id)["item"],
                "task_id": task_id,
                "already_dispatched": already,
                "dispatched": False,
                "queued_behind_busy": False,
                "interrupted": False,
                "dispatch_error": str(exc),
                "code": "WAKE_FAILED",
                "hint": (
                    f"事项已关联任务，但立刻叫醒失败；员工下次值班仍可领取。"
                ),
            }
    hint_parts: list[str] = []
    if already:
        hint_parts.append(f"事项已派发给 {role_name or code}，复用未结 Task，未重复建单。")
    if wake_now and interrupted and woke:
        hint_parts.append(wake_hint or "已中断当前轮次并立即叫醒。")
    elif wake_now and woke:
        hint_parts.append("已叫醒员工立即推进。")
    elif wake_now and queued:
        hint_parts.append(wake_hint or "员工忙碌，已排队待当前轮结束后续跑。")
    elif wake_now and wake_hint:
        hint_parts.append(wake_hint)
    code_out = "QUEUED_BEHIND_BUSY" if queued else (
        "INTERRUPTED_AND_WOKEN" if interrupted and woke else (
            "ALREADY_DISPATCHED" if already else ("WOKEN" if woke else "TASK_READY")
        )
    )
    return {
        "ok": True,
        "item": get_item(item_id)["item"],
        "task_id": task_id,
        "already_dispatched": already,
        "dispatched": bool(wake_now) and woke,
        "queued_behind_busy": queued,
        "interrupted": interrupted,
        "dispatch": dispatch_result,
        "code": code_out,
        "hint": "".join(hint_parts) or None,
    }


async def dispatch_item(
    item_id: str,
    *,
    agent_code: str,
    wake_now: bool = True,
    goal: str | None = None,
    force: bool = False,
    interrupt: bool = False,
) -> dict[str, Any]:
    """从事项派生可执行 Task，并可选立刻叫醒员工。

    Idempotent by default: if this item already has an **open** Task for the same
    ``agent_code`` (or an open same-title board Task), reuse it (optionally re-wake).
    Pass ``force=True`` to create another Task deliberately.

    ``interrupt=True`` (with ``wake_now``) cancels the employee's current duty round
    before waking; default is queue-behind-busy.

    Concurrency: per ``(item_id, agent_code)`` lock so double-click cannot mint two Tasks.
    """
    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    iid = str(item_id or "").strip()
    if not iid:
        raise ValidationError("item_id is required")

    lock = _item_agent_lock(iid, code)
    # Hold lock only for read+create+link; wake outside to avoid long holds.
    with lock:
        data = get_item(iid)
        item = data["item"]
        title = str(goal or item.get("title") or "").strip()
        notes = str(item.get("notes") or "").strip()
        if not title:
            raise ValidationError("item title is empty")

        role_name = ""
        try:
            from evoflow.proactive.repositories import ProactiveRepository

            role = ProactiveRepository.get_role(code)
            if role is not None:
                role_name = str(getattr(role, "role_name", None) or "").strip()
        except Exception:
            role_name = ""

        existing = None if force else _find_open_linked_task_for_agent(item, code)
        task_id = ""
        already = False
        if existing is not None:
            task_id = str(existing.get("id") or existing.get("task_id") or "").strip()
            already = True
        elif not force:
            # Secondary: same assignee + near-same title open board row (proactive path).
            try:
                from evoflow.proactive.work_items import find_open_work_item_by_title

                dedupe_tid = find_open_work_item_by_title(code, title) or ""
            except Exception:
                dedupe_tid = ""
            if dedupe_tid:
                task_id = dedupe_tid
                already = True
                _stamp_task_user_item(task_id, iid)
                _link_task(iid, task_id, status=ItemStatus.WAITING)

        if not task_id:
            from evoflow.admin import tasks as admin_tasks

            created = admin_tasks.create_task(
                name=title,
                description=notes or title,
                assignee=code,
                assigned_role=role_name or None,
                initial_status="pending",
                source="role",
                source_ref=f"item:{iid}",
                raised_by="user",
            )
            task_id = str(created.get("id") or created.get("task_id") or "").strip()
            if not task_id:
                raise ValidationError("failed to create linked task")
            _stamp_task_user_item(task_id, iid)
            _link_task(iid, task_id, status=ItemStatus.WAITING)
            already = False

    return await _finish_dispatch_with_optional_wake(
        item_id=iid,
        code=code,
        role_name=role_name,
        title=title,
        notes=notes,
        task_id=task_id,
        already=already,
        wake_now=wake_now,
        interrupt=bool(interrupt),
    )


def migrate_inbox_tasks(
    *,
    dry_run: bool = False,
    org_id: str | None = None,
    owner_scope_id: str | None = None,
    created_by: str | None = None,
) -> dict[str, Any]:
    """把任务中心里 status=inbox 的随手待办迁成用户事项（幂等，按 source_ref）。"""
    from evoflow.collab.storage import get_project_storage

    existing_refs = {
        str(r.get("source_ref") or "")
        for r in item_store.list_raw_items()
        if isinstance(r, dict) and str(r.get("source") or "") == "migrated_inbox"
    }
    storage = get_project_storage()
    migrated: list[dict[str, Any]] = []
    skipped = 0
    for proj in storage.list_projects() or []:
        pid = str(proj.get("id") or "").strip()
        if not pid:
            continue
        project = storage.load_project(pid)
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            if str(task.get("status") or "").strip().lower() != "inbox":
                continue
            # 仅迁「用户登记」类：无复杂子任务 / 非执行中
            tid = str(task.get("id") or "").strip()
            if not tid:
                continue
            ref = tid
            if ref in existing_refs:
                skipped += 1
                continue
            if dry_run:
                migrated.append({"task_id": tid, "title": task.get("name")})
                continue
            title = str(task.get("name") or task.get("description") or "未命名事项").strip()
            notes = str(task.get("description") or "").strip()
            if notes == title:
                notes = ""
            assignee = str(task.get("assigned_to") or "").strip() or None
            role = str(task.get("assigned_role") or "").strip() or None
            pri_raw = str(task.get("priority") or "").strip().upper()
            pri_map = {"P0": "urgent", "P1": "high", "P2": "normal", "P3": "low"}
            priority = pri_map.get(pri_raw, "normal")
            created = create_item(
                title=title,
                notes=notes,
                status="todo",
                priority=priority,
                due_at=str(task.get("due_at") or "").strip() or None,
                assignee_intent=assignee,
                assignee_label=role or assignee,
                source="migrated_inbox",
                source_ref=ref,
                org_id=org_id,
                owner_scope_id=owner_scope_id,
                created_by=created_by,
            )
            # 若 inbox 已有关联执行痕迹，保留 link；否则不造 Task
            item_id = created["item"]["id"]
            if assignee and str(task.get("status")) != "inbox":
                _link_task(item_id, tid, status=None)
            # 标记原 inbox 任务，避免任务中心再当「个人事项」主入口
            try:
                task["migrated_to_item_id"] = item_id
                task["status"] = "cancelled"
                task["result"] = task.get("result") or "已迁移至用户事项"
                storage.save_project(project)
            except Exception:
                logger.debug("mark migrated inbox task failed", exc_info=True)
            existing_refs.add(ref)
            migrated.append({"task_id": tid, "item_id": item_id, "title": title})

    return {
        "ok": True,
        "dry_run": bool(dry_run),
        "migrated_count": len(migrated),
        "skipped": skipped,
        "migrated": migrated[:100],
    }
