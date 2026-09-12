"""Task plan model and XML/JSON parsing."""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, Field

TaskOpKind = Literal["read", "search", "write", "run", "list_dir"]

_TASK_PLAN_RE = re.compile(r"<task_plan>\s*([\s\S]*?)\s*</task_plan>", re.IGNORECASE)


class TaskOp(BaseModel):
    op: TaskOpKind
    path: str | None = None
    paths: list[str] | None = None
    query: str | None = None
    content: str | None = None
    command: str | None = None
    workspace_root: str | None = None
    limit: int | None = None


class TaskPlan(BaseModel):
    ops: list[TaskOp] = Field(default_factory=list)
    workspace_root: str | None = None


def parse_task_plan_from_text(text: str) -> TaskPlan | None:
    """Parse ``<task_plan>`` JSON block from model output."""
    raw = str(text or "")
    m = _TASK_PLAN_RE.search(raw)
    if not m:
        return None
    body = m.group(1).strip()
    if not body:
        return None
    try:
        data: dict[str, Any] = json.loads(body)
    except json.JSONDecodeError:
        return None
    ops_raw = data.get("ops") or data.get("operations") or []
    if not isinstance(ops_raw, list):
        return None
    ops: list[TaskOp] = []
    for item in ops_raw:
        if not isinstance(item, dict):
            continue
        op_name = str(item.get("op") or item.get("kind") or "").strip().lower()
        if not op_name:
            continue
        ops.append(TaskOp(**{**item, "op": op_name}))
    if not ops:
        return None
    return TaskPlan(ops=ops, workspace_root=data.get("workspace_root"))
