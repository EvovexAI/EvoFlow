"""用户事项 admin facade（CLI / platform 共用）.

Thin wrappers over ``evoflow.items.service``.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
from typing import Any

from evoflow.admin.errors import ValidationError
from evoflow.items import service as items_svc


def list_items(
    *,
    status: str | None = None,
    priority: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    include_done: bool = True,
    page: int = 1,
    page_size: int = 50,
) -> dict[str, Any]:
    return items_svc.list_items(
        status=status,
        priority=priority,
        tag=tag,
        q=q,
        include_done=include_done,
        page=page,
        page_size=page_size,
    )


def get_item(item_id: str) -> dict[str, Any]:
    return items_svc.get_item(item_id)


def create_item(payload: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    data = dict(payload or {})
    data.update({k: v for k, v in kwargs.items() if v is not None})
    title = str(data.get("title") or data.get("name") or "").strip()
    if not title:
        raise ValidationError("title is required")
    return items_svc.create_item(
        title=title,
        notes=str(data.get("notes") or data.get("description") or ""),
        conclusion=str(data.get("conclusion") or data.get("result") or ""),
        status=str(data.get("status") or "").strip() or None,
        priority=str(data.get("priority") or "").strip() or None,
        due_at=str(data.get("due_at") or data.get("due") or "").strip() or None,
        tags=data.get("tags"),
        assignee_intent=str(
            data.get("assignee_intent") or data.get("assignee") or data.get("agent_code") or ""
        ).strip()
        or None,
        assignee_label=str(data.get("assignee_label") or data.get("role") or "").strip() or None,
        source=str(data.get("source") or "cli").strip() or "cli",
        source_ref=str(data.get("source_ref") or "").strip() or None,
        progress=int(data["progress"]) if data.get("progress") is not None else None,
    )


def update_item(item_id: str, patch: dict[str, Any] | None) -> dict[str, Any]:
    return items_svc.update_item(item_id, patch)


def delete_item(item_id: str) -> dict[str, Any]:
    return items_svc.delete_item(item_id)


def dispatch_item(
    item_id: str,
    *,
    agent_code: str,
    wake_now: bool = True,
    goal: str | None = None,
    force: bool = False,
    interrupt: bool = False,
) -> dict[str, Any]:
    """Sync wrapper around async ``items_svc.dispatch_item``."""
    iid = str(item_id or "").strip()
    code = str(agent_code or "").strip()
    if not iid:
        raise ValidationError("item_id is required")
    if not code:
        raise ValidationError("agent_code is required")

    async def _run() -> dict[str, Any]:
        return await items_svc.dispatch_item(
            iid,
            agent_code=code,
            wake_now=bool(wake_now),
            goal=str(goal or "").strip() or None,
            force=bool(force),
            interrupt=bool(interrupt),
        )

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(lambda: asyncio.run(_run())).result(timeout=60)
    return asyncio.run(_run())
