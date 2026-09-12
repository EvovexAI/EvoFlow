"""用户事项 API — 与任务中心分离的个人进度账本。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from evoflow.admin.errors import AdminError, NotFoundError, ValidationError
from evoflow.authz.http_guard import require_item_visible, resolve_authz_from_request
from evoflow.authz.resource_visibility import stamp_kwargs_from_request
from evoflow.items import service as items_svc

router = APIRouter(prefix="/api/items", tags=["items"])


def _raise_admin(exc: AdminError) -> None:
    if isinstance(exc, NotFoundError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, ValidationError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise HTTPException(status_code=400, detail=str(exc)) from exc


class CreateItemRequest(BaseModel):
    title: str = Field(..., description="事项标题")
    notes: str = Field(default="", description="备注")
    conclusion: str = Field(default="", description="处理结论")
    status: str | None = Field(default=None, description="todo|in_progress|waiting|done|parked")
    priority: str | None = Field(default=None, description="none|low|normal|high|urgent")
    due_at: str | None = Field(default=None)
    tags: list[str] | str | None = Field(default=None)
    assignee_intent: str | None = Field(default=None, description="意向责任人 agent_code")
    assignee_label: str | None = Field(default=None)
    source: str = Field(default="user")
    progress: int | None = Field(default=None)


class UpdateItemRequest(BaseModel):
    title: str | None = None
    notes: str | None = None
    conclusion: str | None = None
    status: str | None = None
    priority: str | None = None
    due_at: str | None = None
    tags: list[str] | str | None = None
    assignee_intent: str | None = None
    assignee_label: str | None = None
    progress: int | None = None
    linked_task_ids: list[str] | None = None


class DispatchItemRequest(BaseModel):
    agent_code: str = Field(..., description="派发给的员工 agent_code")
    wake_now: bool = Field(default=True, description="是否立刻叫醒推进")
    goal: str | None = Field(default=None, description="覆盖事项标题作为任务目标")
    force: bool = Field(
        default=False,
        description="强制新建 Task；默认对同员工未结 Task 幂等复用",
    )
    interrupt: bool = Field(
        default=False,
        description="为 true 时中断员工当前轮次再叫醒；默认忙碌则排队",
    )


@router.get("", summary="List user items")
async def list_items(
    request: Request,
    status: str | None = Query(default=None),
    priority: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    q: str | None = Query(default=None),
    include_done: bool = Query(default=True),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
) -> dict[str, Any]:
    try:
        authz = resolve_authz_from_request(request)
        return items_svc.list_items(
            status=status,
            priority=priority,
            tag=tag,
            q=q,
            include_done=include_done,
            page=page,
            page_size=page_size,
            is_admin=bool(authz.get("is_admin")),
            personal_scope=authz.get("personal_scope"),
            org_scope=authz.get("org_scope"),
            principal=authz.get("principal"),
            filter_visibility=True,
        )
    except AdminError as exc:
        _raise_admin(exc)


@router.post("", summary="Create user item")
async def create_item(request: Request, req: CreateItemRequest) -> dict[str, Any]:
    try:
        stamp = stamp_kwargs_from_request(request)
        return items_svc.create_item(
            title=req.title,
            notes=req.notes,
            conclusion=req.conclusion,
            status=req.status,
            priority=req.priority,
            due_at=req.due_at,
            tags=req.tags,
            assignee_intent=req.assignee_intent,
            assignee_label=req.assignee_label,
            source=req.source,
            progress=req.progress,
            org_id=stamp.get("org_id"),
            owner_scope_id=stamp.get("owner_scope_id"),
            created_by=stamp.get("created_by"),
        )
    except AdminError as exc:
        _raise_admin(exc)


@router.post("/migrate-inbox", summary="Migrate task-center inbox rows into user items")
async def migrate_inbox(
    request: Request, dry_run: bool = Query(default=False)
) -> dict[str, Any]:
    try:
        stamp = stamp_kwargs_from_request(request)
        return items_svc.migrate_inbox_tasks(
            dry_run=dry_run,
            org_id=stamp.get("org_id"),
            owner_scope_id=stamp.get("owner_scope_id"),
            created_by=stamp.get("created_by"),
        )
    except AdminError as exc:
        _raise_admin(exc)


@router.get("/{item_id}", summary="Get user item")
async def get_item(request: Request, item_id: str) -> dict[str, Any]:
    require_item_visible(request, item_id)
    try:
        return items_svc.get_item(item_id)
    except AdminError as exc:
        _raise_admin(exc)


@router.patch("/{item_id}", summary="Update user item")
@router.put("/{item_id}", summary="Update user item")
async def update_item(
    request: Request, item_id: str, req: UpdateItemRequest
) -> dict[str, Any]:
    require_item_visible(request, item_id)
    try:
        patch = req.model_dump(exclude_unset=True)
        return items_svc.update_item(item_id, patch)
    except AdminError as exc:
        _raise_admin(exc)


@router.delete("/{item_id}", summary="Delete user item")
async def delete_item(request: Request, item_id: str) -> dict[str, Any]:
    require_item_visible(request, item_id)
    try:
        return items_svc.delete_item(item_id)
    except AdminError as exc:
        _raise_admin(exc)


@router.post("/{item_id}/dispatch", summary="Dispatch item to employee as Task")
async def dispatch_item(
    request: Request, item_id: str, req: DispatchItemRequest
) -> dict[str, Any]:
    require_item_visible(request, item_id)
    try:
        return await items_svc.dispatch_item(
            item_id,
            agent_code=req.agent_code,
            wake_now=req.wake_now,
            goal=req.goal,
            force=req.force,
            interrupt=req.interrupt,
        )
    except AdminError as exc:
        _raise_admin(exc)
