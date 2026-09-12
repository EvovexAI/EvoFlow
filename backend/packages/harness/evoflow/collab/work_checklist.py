"""Structured work checklist for subtasks (status / content / result table)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Literal

from evoflow.collab.storage import find_main_task, find_subtask_by_ids
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

WorkChecklistStatus = Literal["pending", "in_progress", "completed", "cancelled"]

_VALID_STATUS = frozenset({"pending", "in_progress", "completed", "cancelled"})


def _norm_status(raw: Any) -> WorkChecklistStatus:
    s = str(raw or "pending").strip().lower().replace("-", "_")
    if s in _VALID_STATUS:
        return s  # type: ignore[return-value]
    return "pending"


def normalize_checklist_items(raw: Any) -> list[dict[str, Any]]:
    """Normalize user/lead-provided checklist rows."""
    if isinstance(raw, str):
        s = raw.strip()
        if s and s[0] in "[{":
            try:
                raw = json.loads(s)
            except json.JSONDecodeError:
                return []
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for i, row in enumerate(raw):
        if isinstance(row, str):
            text = row.strip()
            if not text:
                continue
            out.append(
                {
                    "id": str(len(out) + 1),
                    "content": text,
                    "status": "pending",
                    "result": "",
                    "updated_at": utc_now_iso_z(),
                }
            )
            continue
        if not isinstance(row, dict):
            continue
        content = str(row.get("content") or row.get("text") or row.get("name") or "").strip()
        if not content:
            continue
        item_id = str(row.get("id") or "").strip() or str(len(out) + 1)
        out.append(
            {
                "id": item_id,
                "content": content,
                "status": _norm_status(row.get("status")),
                "result": str(row.get("result") or "").strip(),
                "updated_at": str(row.get("updated_at") or utc_now_iso_z()),
            }
        )
    return out


def resolve_checklist_item(items: list[dict[str, Any]], item_ref: str) -> dict[str, Any] | None:
    """Match checklist row by persisted id, 1-based table row #, or legacy ``wc_N_*`` id."""
    needle = str(item_ref or "").strip()
    if not needle or not items:
        return None
    for it in items:
        if str(it.get("id") or "").strip() == needle:
            return it
    if needle.isdigit():
        idx = int(needle)
        if 1 <= idx <= len(items):
            return items[idx - 1]
    m = re.match(r"^wc_(\d+)(?:_|$)", needle, re.IGNORECASE)
    if m:
        idx = int(m.group(1))
        if 1 <= idx <= len(items):
            return items[idx - 1]
    for it in items:
        iid = str(it.get("id") or "").strip()
        if iid.startswith(f"wc_{needle}_") or iid == f"wc_{needle}":
            return it
    return None


def checklist_item_ref_hint(items: list[dict[str, Any]]) -> str:
    """Human/model hint when update ref does not match."""
    parts: list[str] = []
    for i, row in enumerate(items, 1):
        iid = str(row.get("id") or "").strip() or str(i)
        parts.append(f"#{i}→id={iid}")
    return ", ".join(parts) if parts else "(empty)"


def get_subtask_work_checklist(subtask_row: dict[str, Any]) -> list[dict[str, Any]]:
    raw = subtask_row.get("work_checklist")
    if not isinstance(raw, list):
        return []
    return [x for x in normalize_checklist_items(raw) if isinstance(x, dict)]


def checklist_is_ready(items: list[dict[str, Any]], *, min_items: int = 1) -> bool:
    return len(items) >= max(1, int(min_items))


def checklist_progress_percent(items: list[dict[str, Any]]) -> int:
    if not items:
        return 0
    score = 0
    for x in items:
        st = _norm_status(x.get("status"))
        if st == "completed":
            score += 100
        elif st == "cancelled":
            score += 100
        elif st == "in_progress":
            score += 50
    return max(0, min(100, int(round(score / len(items)))))


def format_checklist_markdown_table(items: list[dict[str, Any]]) -> str:
    if not items:
        return "| # | 状态 | 事项 | 结果 |\n|---:|---|---|---|\n| — | — | （尚未定义待办） | — |"
    lines = [
        "| # | 状态 | 事项 | 结果 |",
        "|---:|---|---|---|",
    ]
    for i, row in enumerate(items, 1):
        st = _norm_status(row.get("status"))
        content = str(row.get("content") or "").replace("|", "\\|").replace("\n", " ")
        result = str(row.get("result") or "").replace("|", "\\|").replace("\n", " ")
        if not result and st == "completed":
            result = "（已完成，未填写结果摘要）"
        lines.append(f"| {i} | {st} | {content} | {result or '—'} |")
    return "\n".join(lines)


def format_worker_checklist_bootstrap_block() -> str:
    """Prompt block when worker has not initialized checklist yet (tool-driven, no Lead duty)."""
    return """<work_checklist>
你是本子任务的执行者。理解任务目标与 Plan 片段后，**先**用 `subtask_work_checklist`（action=`set`）写入你本领域的执行步骤（每项含 content；完成后用 action=`update` 写 status 与 result）。
Lead 负责下发与验收，不代你维护此列表。动手改代码/跑命令前完成 `set`。
**进度**：checklist 更新会自动折算子任务 `progress`（%）；阶段边界请再调 `subtask_progress_report(progress=…, current_step=…)` 同步 UI。
</work_checklist>"""


def format_checklist_system_block(items: list[dict[str, Any]]) -> str:
    """Inject persisted checklist snapshot; worker keeps it current via tool."""
    snapshot = format_checklist_markdown_table(items)
    return f"""<work_checklist>
当前子任务进度（由 `subtask_work_checklist` 持久化，请保持同步）：

{snapshot}

执行中：用 `subtask_work_checklist` action=`update` 更新 status；完成项填写 result。
`item_id` 可用表格「#」列序号（如 `"1"`、`"2"`）或 `list` 返回的 `items[].id`。每完成一项或进入新阶段，调用 `subtask_progress_report` 上报 0–100 进度与 `current_step`。
全部完成后在回复中说明验收证据，并调用 `subtask_outcome_report`。
</work_checklist>"""


def format_main_chat_todos_table(todos: list[dict[str, Any]]) -> str:
    """Markdown table for main-chat write_todos (includes optional result)."""
    if not todos:
        return ""
    lines = [
        "| # | 状态 | 事项 | 结果 |",
        "|---:|---|---|---|",
    ]
    for i, row in enumerate(todos, 1):
        st = _norm_status(row.get("status"))
        content = str(row.get("content") or "").replace("|", "\\|").replace("\n", " ")
        result = str(row.get("result") or row.get("outcome") or "").replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {i} | {st} | {content} | {result or '—'} |")
    return "\n".join(lines)


def set_subtask_work_checklist(
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    items: list[dict[str, Any]],
    *,
    replace: bool = True,
) -> tuple[bool, str, list[dict[str, Any]]]:
    normalized = normalize_checklist_items(items)
    if not normalized:
        return False, "work_checklist must contain at least one item with content", []
    row = find_main_task(storage, main_task_id)
    if not row:
        return False, f"Task '{main_task_id}' not found", []
    project, task = row
    target: dict[str, Any] | None = None
    for st in task.get("subtasks") or []:
        if str(st.get("id") or "").strip() == subtask_id:
            target = st
            break
    if target is None:
        return False, f"Subtask '{subtask_id}' not found", []
    if replace:
        target["work_checklist"] = normalized
    else:
        existing = get_subtask_work_checklist(target)
        by_id = {str(x.get("id")): x for x in existing}
        for item in normalized:
            by_id[str(item.get("id"))] = item
        target["work_checklist"] = list(by_id.values())
    target["work_checklist_updated_at"] = utc_now_iso_z()
    target["progress"] = checklist_progress_percent(normalized)
    task["updated_at"] = utc_now_iso_z()
    project["updated_at"] = task["updated_at"]
    storage.save_project(project)
    return True, "ok", normalized


def update_subtask_checklist_item(
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    item_id: str,
    *,
    status: str | None = None,
    result: str | None = None,
    content: str | None = None,
) -> tuple[bool, str, list[dict[str, Any]]]:
    row = find_main_task(storage, main_task_id)
    if not row:
        return False, f"Task '{main_task_id}' not found", []
    project, task = row
    st = find_subtask_by_ids(storage, main_task_id, subtask_id)
    if not st:
        return False, f"Subtask '{subtask_id}' not found", []
    items = get_subtask_work_checklist(st)
    if not items:
        return False, "work_checklist is empty; lead must set_subtask_work_checklist before execution", []
    target_item = resolve_checklist_item(items, item_id)
    if target_item is None:
        return (
            False,
            f"Checklist item '{item_id}' not found. Valid refs: {checklist_item_ref_hint(items)}",
            items,
        )
    if status is not None:
        target_item["status"] = _norm_status(status)
    if result is not None:
        target_item["result"] = str(result).strip()
    if content is not None and str(content).strip():
        target_item["content"] = str(content).strip()
    target_item["updated_at"] = utc_now_iso_z()
    for i, st_row in enumerate(task.get("subtasks") or []):
        if str(st_row.get("id") or "").strip() == subtask_id:
            task["subtasks"][i]["work_checklist"] = items
            task["subtasks"][i]["work_checklist_updated_at"] = utc_now_iso_z()
            task["subtasks"][i]["progress"] = checklist_progress_percent(items)
            break
    task["updated_at"] = utc_now_iso_z()
    project["updated_at"] = task["updated_at"]
    storage.save_project(project)
    return True, "ok", items


async def broadcast_checklist_progress(
    main_task_id: str,
    subtask_id: str,
    items: list[dict[str, Any]],
) -> None:
    try:
        from evoflow.tools.builtins.supervisor.memory import _broadcast_task_event

        await _broadcast_task_event(
            main_task_id,
            "task:progress",
            {
                "task_id": subtask_id,
                "collab_subtask_id": subtask_id,
                "progress": checklist_progress_percent(items),
                "work_checklist": items,
            },
        )
    except Exception:
        logger.debug("broadcast_checklist_progress failed", exc_info=True)
