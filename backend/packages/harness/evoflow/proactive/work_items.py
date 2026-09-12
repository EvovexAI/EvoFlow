"""Role work items: Task + assigned_role is the sole actionable model.

Patrol / dispatch propose work by creating collab Tasks (not actionable
initiatives). ExecutionBridge still speaks Initiative shapes via a thin adapter.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.proactive.models import (
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveRole,
    needs_approval,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_OPEN_TASK_STATUSES = frozenset(
    {
        "inbox",  # 已分配的随手待办（未分配不会匹配本岗 assigned_role/to）
        "pending",
        "idle",
        "req_confirm",
        "waiting_user",
        "executing",
        "in_progress",
        "approved",
        "awaiting_close",
    }
)

# Terminal success — must not be re-dispatched / woken as "retry".
_DONE_TASK_STATUSES = frozenset(
    {
        "completed",
        "reviewed",
        "cancelled",
        "canceled",
        "rejected",
    }
)

_FAILED_TASK_STATUSES = frozenset({"failed", "error"})

_HUMAN_RAISERS = frozenset({"user", "human", "manual", "me", "owner", "operator"})


def format_raised_by_label(raised_by: str | None, *, roster: list[ProactiveRole] | None = None) -> str:
    """人 → ``用户``；员工 → 岗位名；未知 code 原样返回。"""
    raw = str(raised_by or "").strip()
    if not raw:
        return ""
    if raw.lower() in _HUMAN_RAISERS:
        return "用户"
    roles = roster
    if roles is None:
        try:
            from evoflow.proactive.repositories import ProactiveRepository

            # Prefer direct lookup (agent_code); fall back to full roster for role_name match.
            emp = ProactiveRepository.get_role(raw)
            if emp and str(emp.role_name or "").strip():
                return str(emp.role_name).strip()
            roles = ProactiveRepository.list_roles()
        except Exception:
            roles = []
    key = raw.lower()
    for r in roles or []:
        code = str(r.agent_code or "").strip()
        name = str(r.role_name or "").strip()
        if not name:
            continue
        if code.lower() == key or name.lower() == key:
            return name
    return raw


def format_raised_by_meta(raised_by: str | None, *, roster: list[ProactiveRole] | None = None) -> str:
    label = format_raised_by_label(raised_by, roster=roster)
    return f"来源 · {label}" if label else ""


DISPATCH_RATIONALE_ZH: dict[str, str] = {
    "employee_page": "用户从员工页派发",
    "chat_mention": "用户在主聊天 @ 派发",
    "manual": "手动派发",
    "role": "同事跨岗派发",
    "xiaomi": "小V催办派发",
    "event": "事件触发派发",
}


def dispatch_rationale_zh(source: str) -> str:
    s = str(source or "").strip().lower()
    if not s:
        return "用户派发"
    if s in DISPATCH_RATIONALE_ZH:
        return DISPATCH_RATIONALE_ZH[s]
    if s.startswith("event:"):
        return DISPATCH_RATIONALE_ZH["event"]
    return f"派发来源：{source}"


def dispatch_source_line(source: str, *, from_agent: str = "") -> str:
    """Human-readable 来源: category + who dispatched (岗位名, not bare agent_code)."""
    base = dispatch_rationale_zh(source)
    code = str(from_agent or "").strip()
    if not code:
        return base
    label = format_raised_by_label(code)
    if not label or label == "用户":
        return base
    # 「同事跨岗派发 · 产品经理」— no raw code, no redundant「叫醒」
    return f"{base} · {label}"


def is_work_item_done(status: str | None, *, progress: int | None = None) -> bool:
    """True when a board Task should not be woken or re-executed."""
    st = str(status or "").strip().lower()
    # 待闭环：本岗已交、整单未验收 — 仍是活单，可被回执叫醒验收
    if st == "awaiting_close":
        return False
    if st in _DONE_TASK_STATUSES:
        return True
    if st in _FAILED_TASK_STATUSES:
        return False
    try:
        prog = int(progress) if progress is not None else -1
    except (TypeError, ValueError):
        prog = -1
    # Some runs leave status open but progress already at 100%.
    return prog >= 100 and st in {"executing", "in_progress", "approved"}


def find_open_work_item_by_title(
    assignee: str,
    title: str,
    *,
    similarity_threshold: float = 0.92,
) -> str | None:
    """Return newest open board task id for assignee with same/near title, or None.

    Used by dispatch to reuse instead of minting duplicate wrapper Tasks.
    Cross-assignee fan-out (same title, different employees) is intentionally
    not collapsed here.
    """
    code = str(assignee or "").strip()
    want = str(title or "").strip()
    if not code or not want:
        return None
    try:
        from evoflow.collab.storage import get_project_storage
        from evoflow.proactive.title_similarity import (
            normalize_proactive_title,
            title_similarity,
        )
    except Exception:
        return None

    want_norm = normalize_proactive_title(want) or want.lower()
    best_id = ""
    best_updated = ""
    storage = get_project_storage()
    for summary in storage.list_projects():
        proj = storage.load_project(summary["id"])
        if not proj:
            continue
        for task in proj.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            assignee_s = str(task.get("assigned_to") or "").strip()
            if assignee_s.lower() != code.lower():
                continue
            st = str(task.get("status") or "").strip().lower()
            if is_work_item_done(st, progress=task.get("progress")):
                continue
            if st in {"cancelled", "canceled", "deleted", "failed", "error"}:
                continue
            name = str(task.get("name") or "").strip()
            if not name:
                continue
            if name == want or normalize_proactive_title(name) == want_norm:
                score = 1.0
            else:
                score = title_similarity(name, want)
            if score < similarity_threshold:
                continue
            tid = str(task.get("id") or "").strip()
            if not tid:
                continue
            updated = str(task.get("updated_at") or task.get("created_at") or "")
            if not best_id or updated >= best_updated:
                best_id = tid
                best_updated = updated
    return best_id or None


def extract_task_ids_from_text(*parts: str) -> list[str]:
    """Pull task ids from goal / description text (order preserved).

    Accepts legacy ``Task_…`` and short ``YYMMDDHHMM_xxxx`` forms.
    """
    from evoflow.collab.id_format import TASK_ID_FINDALL_RE

    seen: set[str] = set()
    out: list[str] = []
    for part in parts:
        for m in TASK_ID_FINDALL_RE.findall(str(part or "")):
            if m not in seen:
                seen.add(m)
                out.append(m)
    return out


def load_work_item_statuses(task_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Map task_id → ``{status, progress, name}`` for ids that resolve."""
    out: dict[str, dict[str, Any]] = {}
    for tid in task_ids:
        code = str(tid or "").strip()
        if not code:
            continue
        try:
            task = load_work_item_task(code)
        except Exception:
            task = None
        if not task:
            continue
        try:
            prog = int(task.get("progress") or 0)
        except (TypeError, ValueError):
            prog = 0
        out[code] = {
            "status": str(task.get("status") or "").strip().lower(),
            "progress": prog,
            "name": str(task.get("name") or "").strip(),
        }
    return out


def all_referenced_tasks_done(*texts: str) -> tuple[bool, list[str]]:
    """If text cites Task ids and every resolvable one is done → (True, ids)."""
    ids = extract_task_ids_from_text(*texts)
    if not ids:
        return False, []
    info = load_work_item_statuses(ids)
    if not info:
        return False, ids
    if all(is_work_item_done(v.get("status"), progress=v.get("progress")) for v in info.values()):
        return True, list(info.keys())
    return False, list(info.keys())


def _parse_action_type(raw: Any) -> InitiativeActionType:
    try:
        return InitiativeActionType(str(raw or "analysis"))
    except ValueError:
        return InitiativeActionType.ANALYSIS


def _parse_risk(raw: Any) -> InitiativeRiskLevel:
    try:
        return InitiativeRiskLevel(str(raw or "low"))
    except ValueError:
        return InitiativeRiskLevel.LOW


def create_role_work_item(
    role: ProactiveRole,
    data: dict[str, Any],
    *,
    round_id: str = "",
    goal: str = "",
    outcome: str = "",
    source: str = "proactive_patrol",
    source_ref: str | None = None,
    raised_by: str = "user",
    parent_task_id: str | None = None,
) -> dict[str, Any] | None:
    """Create a collab Task stamped with ``assigned_role`` for the employee board.

    Prefer ``tasks`` tool (``action=create``) for duty-raised items. This helper remains
    for **human dispatch** (and tests); always pass ``raised_by`` explicitly
    (``user`` for dispatch).
    """
    title = str(data.get("title") or "").strip()
    if not title:
        return None

    description = str(data.get("description") or "").strip() or title
    action_type = _parse_action_type(data.get("action_type"))
    risk_level = _parse_risk(data.get("risk_level"))
    plan = data.get("action_plan")
    if not isinstance(plan, dict):
        plan = {}
    steps = data.get("steps")
    files = data.get("target_files")
    if isinstance(steps, list) and steps and "steps" not in plan:
        plan = {**plan, "steps": [str(s) for s in steps if str(s).strip()]}
    if isinstance(files, list) and files and "target_files" not in plan:
        plan = {**plan, "target_files": [str(f) for f in files if str(f).strip()]}

    src = str(source or "proactive_patrol").strip() or "proactive_patrol"
    ref = str(source_ref if source_ref is not None else round_id or "").strip() or None
    default_raiser = str(role.agent_code or "").strip() or "user"
    raiser = str(raised_by or default_raiser).strip() or default_raiser
    parent = str(parent_task_id or data.get("parent_task_id") or "").strip() or None

    from evoflow.admin import tasks as admin_tasks
    from evoflow.collab.storage import (
        get_project_storage,
        patch_collab_main_task_in_project_storage,
    )
    from evoflow.collab.task_source import TASK_SOURCE_ROLE, resolve_write_source

    # Canonical 任务来源 = role；细渠道保留在 source_channel（via create_task）
    _canon, _ = resolve_write_source(src, default=TASK_SOURCE_ROLE)

    created = admin_tasks.create_task(
        name=title[:200],
        description=description,
        assignee=str(role.agent_code or "").strip() or None,
        assigned_role=str(role.role_name or "").strip() or None,
        initial_status="pending",
        source=src,  # create_task normalizes + sets source_channel
        source_ref=ref,
        raised_by=raiser,
        risk_level=risk_level.value,
        action_type=action_type.value,
        round_id=str(round_id or "").strip() or None,
        parent_task_id=parent,
    )
    task_id = str(created.get("task_id") or "").strip()
    if not task_id:
        return None

    extras: dict[str, Any] = {
        "rationale": str(data.get("rationale") or "").strip(),
        "expected_outcome": str(data.get("expected_outcome") or "").strip(),
        "action_plan": plan,
        "goal": str(goal or "").strip(),
        "outcome": str(outcome or "").strip(),
        "proactive_work_item": True,
    }
    try:
        storage = get_project_storage()
        patch_collab_main_task_in_project_storage(storage, task_id, extras)
    except Exception:
        logger.warning(
            "proactive.work_items: failed to patch extras task=%s",
            task_id,
            exc_info=True,
        )

    logger.info(
        "proactive.work_items: created task=%s role=%s raised_by=%s source=%s channel=%s risk=%s",
        task_id,
        role.agent_code,
        raiser,
        created.get("source") or _canon,
        created.get("source_channel") or src,
        risk_level.value,
    )
    return {
        **created,
        "task_id": task_id,
        "title": title,
        "raised_by": raiser,
        "parent_task_id": parent,
        "risk_level": risk_level.value,
        "action_type": action_type.value,
        "needs_approval": needs_approval(risk_level, role.config.autonomy_level),
    }


def load_work_item_task(task_id: str) -> dict[str, Any] | None:
    """Load a main-task dict (with extra_json merged via storage) or None."""
    tid = str(task_id or "").strip()
    if not tid:
        return None
    try:
        from evoflow.collab.storage import find_main_task, get_project_storage

        found = find_main_task(get_project_storage(), tid, bypass_cache=True)
    except Exception:
        return None
    if not found:
        return None
    _project, task = found
    if not isinstance(task, dict):
        return None
    out = dict(task)
    out["id"] = str(task.get("id") or tid)
    out["task_id"] = out["id"]
    return out


def list_role_tasks_for_round(
    role: ProactiveRole,
    round_id: str,
) -> list[dict[str, Any]]:
    """All role-stamped tasks for this duty round (any status).

    Matches ``source_ref`` or ``round_id`` to the duty stamp. Used for Person
    Kernel auto wrap-up after agent-loop (Task SSOT, no submit_work).
    """
    rid = str(round_id or "").strip()
    role_name = str(role.role_name or "").strip().lower()
    agent_code = str(role.agent_code or "").strip().lower()
    if not rid or (not role_name and not agent_code):
        return []
    try:
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        projects = [storage.load_project(p["id"]) for p in storage.list_projects()]
    except Exception:
        logger.debug("proactive.work_items: list_role_tasks_for_round failed", exc_info=True)
        return []

    out: list[dict[str, Any]] = []
    for project in projects:
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            ar = str(task.get("assigned_role") or "").strip().lower()
            at = str(task.get("assigned_to") or "").strip().lower()
            if role_name and ar == role_name:
                pass
            elif agent_code and at == agent_code:
                pass
            else:
                continue
            ref = str(task.get("source_ref") or "").strip()
            rround = str(task.get("round_id") or "").strip()
            if ref != rid and rround != rid:
                continue
            tid = str(task.get("id") or "").strip()
            if not tid:
                continue
            row = dict(task)
            row["id"] = tid
            row["task_id"] = tid
            out.append(row)
    return out


def list_pending_work_items_for_round(
    role: ProactiveRole,
    round_id: str,
) -> list[dict[str, Any]]:
    """Pending role-stamped tasks whose source_ref/round_id matches this duty round."""
    rid = str(round_id or "").strip()
    role_name = str(role.role_name or "").strip().lower()
    if not rid or not role_name:
        return []
    try:
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        projects = [storage.load_project(p["id"]) for p in storage.list_projects()]
    except Exception:
        logger.debug("proactive.work_items: list round tasks failed", exc_info=True)
        return []

    out: list[dict[str, Any]] = []
    for project in projects:
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            ar = str(task.get("assigned_role") or "").strip().lower()
            if ar != role_name:
                continue
            status = str(task.get("status") or "").strip().lower()
            if status not in {"pending", "idle", "req_confirm", "waiting_user"}:
                continue
            ref = str(task.get("source_ref") or "").strip()
            rround = str(task.get("round_id") or "").strip()
            if ref != rid and rround != rid:
                continue
            tid = str(task.get("id") or "").strip()
            if not tid:
                continue
            row = dict(task)
            row["id"] = tid
            row["task_id"] = tid
            out.append(row)
    return out


def list_role_open_tasks(
    role: ProactiveRole,
    *,
    limit: int = 12,
    include_recent_closed: int = 3,
) -> list[dict[str, Any]]:
    """Open board Tasks for this role — full fields for duty brief.

    Recent *failed* items may be appended as context. Reviewed/completed are
    **not** included — they previously baited employees into redoing finished work
    (especially when result text still said「等待超时」).
    """
    role_name = str(role.role_name or "").strip().lower()
    agent_code = str(role.agent_code or "").strip().lower()
    if not role_name and not agent_code:
        return []
    try:
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        projects = [storage.load_project(p["id"]) for p in storage.list_projects()]
    except Exception:
        logger.debug("proactive.work_items: list_role_open_tasks failed", exc_info=True)
        return []

    open_rows: list[dict[str, Any]] = []
    failed_rows: list[dict[str, Any]] = []
    for project in projects:
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            ar = str(task.get("assigned_role") or "").strip().lower()
            at = str(task.get("assigned_to") or "").strip().lower()
            if role_name and ar == role_name:
                pass
            elif agent_code and at == agent_code:
                pass
            else:
                continue
            tid = str(task.get("id") or "").strip()
            if not tid:
                continue
            status = str(task.get("status") or "").strip().lower()
            try:
                progress = int(task.get("progress") or 0)
            except (TypeError, ValueError):
                progress = 0
            # Treat 100% "open" rows as done for the duty board.
            if is_work_item_done(status, progress=progress):
                continue
            row = {
                "task_id": tid,
                "id": tid,
                "name": str(task.get("name") or "").strip(),
                "description": str(task.get("description") or "").strip(),
                "status": status,
                "progress": progress,
                "assigned_to": str(task.get("assigned_to") or "").strip() or None,
                "assigned_role": str(task.get("assigned_role") or "").strip() or None,
                "raised_by": str(task.get("raised_by") or "").strip() or None,
                "parent_task_id": str(task.get("parent_task_id") or "").strip() or None,
                "source_ref": str(task.get("source_ref") or "").strip() or None,
                "round_id": str(task.get("round_id") or "").strip() or None,
                "updated_at": str(task.get("updated_at") or "").strip() or None,
                "result": str(task.get("result") or task.get("error") or "").strip() or None,
            }
            if status in _OPEN_TASK_STATUSES:
                open_rows.append(row)
            elif status in _FAILED_TASK_STATUSES:
                failed_rows.append(row)

    def _sort_key(r: dict[str, Any]) -> str:
        return str(r.get("updated_at") or "")

    open_rows.sort(key=_sort_key, reverse=True)
    failed_rows.sort(key=_sort_key, reverse=True)
    out = open_rows[: max(1, int(limit))]
    if include_recent_closed > 0 and len(out) < limit:
        room = max(0, int(limit) - len(out))
        # Only failed — never reviewed/completed — as "recent closed" context.
        out.extend(failed_rows[: min(include_recent_closed, room)])
    return out


def list_role_recent_tasks(
    role: ProactiveRole,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Recent board Tasks for this role — open + closed, for meeting Q&A memory.

    Unlike ``list_role_open_tasks``, includes completed/reviewed so the employee
    can answer status questions without looking tasks up again.
    """
    role_name = str(role.role_name or "").strip().lower()
    agent_code = str(role.agent_code or "").strip().lower()
    if not role_name and not agent_code:
        return []
    try:
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        projects = [storage.load_project(p["id"]) for p in storage.list_projects()]
    except Exception:
        logger.debug("proactive.work_items: list_role_recent_tasks failed", exc_info=True)
        return []

    rows: list[dict[str, Any]] = []
    for project in projects:
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            ar = str(task.get("assigned_role") or "").strip().lower()
            at = str(task.get("assigned_to") or "").strip().lower()
            if role_name and ar == role_name:
                pass
            elif agent_code and at == agent_code:
                pass
            else:
                continue
            tid = str(task.get("id") or "").strip()
            if not tid:
                continue
            status = str(task.get("status") or "").strip().lower()
            try:
                progress = int(task.get("progress") or 0)
            except (TypeError, ValueError):
                progress = 0
            rows.append(
                {
                    "task_id": tid,
                    "id": tid,
                    "name": str(task.get("name") or "").strip(),
                    "description": str(task.get("description") or "").strip(),
                    "status": status,
                    "progress": progress,
                    "assigned_to": str(task.get("assigned_to") or "").strip() or None,
                    "assigned_role": str(task.get("assigned_role") or "").strip() or None,
                    "raised_by": str(task.get("raised_by") or "").strip() or None,
                    "parent_task_id": str(task.get("parent_task_id") or "").strip() or None,
                    "created_at": str(task.get("created_at") or "").strip() or None,
                    "updated_at": str(task.get("updated_at") or "").strip() or None,
                    "result": str(task.get("result") or task.get("error") or "").strip() or None,
                }
            )

    rows.sort(key=lambda r: str(r.get("updated_at") or ""), reverse=True)
    return rows[: max(1, int(limit))]


def _meeting_task_time_snip(raw: str | None) -> str:
    """Compact ISO timestamp → ``MM-DD`` for oral progress reports."""
    s = str(raw or "").strip()
    if not s:
        return ""
    # 2026-08-01T12:34:56Z / 2026-08-01 12:34:56
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return f"{s[5:7]}-{s[8:10]}"
    return s[:10]


def format_meeting_task_memory_for_prompt(tasks: list[dict[str, Any]]) -> str:
    """Compact recent-task memory for AI员工聊天室 system prompt (not duty board)."""
    if not tasks:
        return "（近况：本岗暂无近期任务记录）"

    done_n = open_n = failed_n = 0
    for t in tasks:
        status = str(t.get("status") or "").strip().lower()
        try:
            progress = int(t.get("progress") or 0)
        except (TypeError, ValueError):
            progress = 0
        if status in _FAILED_TASK_STATUSES:
            failed_n += 1
        elif status in _DONE_TASK_STATUSES or is_work_item_done(status, progress=progress):
            done_n += 1
        else:
            open_n += 1

    lines = [
        "以下为本岗近况任务记忆（已自动加载，含状态与时间；被问进度时据此直接答，无需再查）：",
        (
            f"概况：近 {len(tasks)} 条里，已完成 {done_n}，未结 {open_n}，失败 {failed_n}。"
            "汇报工作进度时请说出这些数量，并点 1～2 件具体事项（含大致时间）。"
        ),
        "",
    ]
    for t in tasks:
        tid = str(t.get("task_id") or t.get("id") or "").strip()
        if not tid:
            continue
        name = str(t.get("name") or "").strip() or tid
        status = str(t.get("status") or "?").strip()
        try:
            progress = int(t.get("progress") or 0)
        except (TypeError, ValueError):
            progress = 0
        when = _meeting_task_time_snip(t.get("updated_at")) or _meeting_task_time_snip(
            t.get("created_at")
        )
        line = f"- `{tid}` [{status}] {progress}% · {name}"
        if when:
            line += f" · 更新 {when}"
        result = str(t.get("result") or "").strip()
        if result and (
            status in _DONE_TASK_STATUSES
            or status in _FAILED_TASK_STATUSES
            or progress >= 100
        ):
            if len(result) > 80:
                result = result[:79] + "…"
            line += f" → {result}"
        lines.append(line)
    return "\n".join(lines)


def format_task_board_for_prompt(tasks: list[dict[str, Any]]) -> str:
    """Render board Tasks with id / status / progress / description for the duty brief."""
    if not tasks:
        return "（本岗看板暂无未结 Task）"

    roster: list[ProactiveRole] | None = None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        roster = ProactiveRepository.list_roles()
    except Exception:
        roster = []

    lines = [
        "## 本岗看板 Task（可执行；``tasks(action=progress|state)`` 用这里的 id）",
        "",
        "规则：只推进下方**未结**项；勿因结果文案含「超时」去重做已 reviewed/completed 的单；",
        "同主题多张 pending 时合并推进一张，其余 ``state --status cancelled``。",
        "",
    ]
    for t in tasks:
        tid = str(t.get("task_id") or t.get("id") or "").strip()
        if not tid:
            continue
        name = str(t.get("name") or "").strip() or tid
        status = str(t.get("status") or "").strip() or "?"
        try:
            progress = int(t.get("progress") or 0)
        except (TypeError, ValueError):
            progress = 0
        desc = str(t.get("description") or "").strip()
        if desc == name:
            desc = ""
        # Cap description so one long plan doesn't blow the brief.
        if len(desc) > 400:
            desc = desc[:399] + "…"

        tag = ""
        if status in _FAILED_TASK_STATUSES:
            tag = " · 失败上下文（确认是否真需重开，勿盲目重做）"
        lines.append(f"- `{tid}` [{status}] {progress}% · {name}{tag}")
        if desc:
            # Indent multi-line descriptions for readability.
            for i, chunk in enumerate(desc.splitlines()[:8]):
                prefix = "  描述: " if i == 0 else "        "
                lines.append(f"{prefix}{chunk}")
        parent = str(t.get("parent_task_id") or "").strip()
        raised = str(t.get("raised_by") or "").strip()
        meta_bits: list[str] = []
        if parent:
            meta_bits.append(f"parent=`{parent}`")
        if raised:
            meta_bits.append(format_raised_by_meta(raised, roster=roster) or f"raised_by={raised}")
        if meta_bits:
            lines.append(f"  ({' · '.join(meta_bits)})")
        result = str(t.get("result") or "").strip()
        if result and status in _FAILED_TASK_STATUSES:
            lines.append(f"  结果: {result[:160]}")
    return "\n".join(lines)


_LIVE_TASKS_OPEN = "<proactive_live_tasks>"
_LIVE_TASKS_CLOSE = "</proactive_live_tasks>"


def format_live_duty_tasks_section(role: ProactiveRole, *, limit: int = 8) -> str:
    """Fresh task board for ephemeral HumanMessage injection (like ``session_mind_map``).

    Appended at the end of user context before each model call so the employee
    always sees current Task ids / status / progress.
    """
    tasks = list_role_open_tasks(role, limit=limit, include_recent_closed=0)
    lines = [
        _LIVE_TASKS_OPEN,
        "本岗**当前未结 Task**（每次 model 前刷新；与 `<session_mind_map>` 同级、写在上下文末尾）：",
        "含用户从任务中心派给你的待办（status 可能为 inbox/pending）与本岗自建单；优先推进这些，勿空建单。",
        "",
    ]
    if not tasks:
        lines.append("（暂无未结 — 可巡检结束；勿空建单）")
        lines.append(_LIVE_TASKS_CLOSE)
        return "\n".join(lines)

    for t in tasks:
        tid = str(t.get("task_id") or t.get("id") or "").strip()
        if not tid:
            continue
        name = str(t.get("name") or "").strip() or tid
        status = str(t.get("status") or "?").strip()
        try:
            progress = int(t.get("progress") or 0)
        except (TypeError, ValueError):
            progress = 0
        desc = str(t.get("description") or "").strip()
        if len(desc) > 160:
            desc = desc[:159] + "…"
        raised_meta = format_raised_by_meta(t.get("raised_by"))
        suffix = f" · {raised_meta}" if raised_meta else ""
        lines.append(f"- `{tid}` [{status}] {progress}% · {name}{suffix}")
        if desc and desc != name:
            lines.append(f"  {desc}")
    lines.extend(
        [
            "",
            "动作：推进 ``tasks(action=\"progress\", task_id=…, progress=N)``；",
            "干完结案 ``tasks(action=\"state\", task_id=…, status=\"completed\", "
            "summary=\"做了什么/验收要点\", "
            "outputs=[{\"type\":\"file\",\"key\":\"report\",\"value\":\"路径\"}], "
            "handlers=[{\"agent_code\":\"…\",\"content\":\"做什么\",\"read_outputs\":[…]}])``"
            "（已完成；handlers 仅直属下级；medium+ 交接由系统挂待审批后再 wake；"
            "勿经 terminal 拼 handlers JSON；勿对本岗交接再 create+wake 下级）；",
            "取证/改码时**同批并发** ``mind_map``；证据返回后下一轮立刻 patch 导图并回写进度。",
            _LIVE_TASKS_CLOSE,
        ]
    )
    return "\n".join(lines)


def task_risk_level(task: dict[str, Any]) -> InitiativeRiskLevel:
    return _parse_risk(task.get("risk_level"))


def task_action_type(task: dict[str, Any]) -> InitiativeActionType:
    return _parse_action_type(task.get("action_type"))


def task_needs_approval(role: ProactiveRole, task: dict[str, Any]) -> bool:
    autonomy = role.config.autonomy_level
    if not isinstance(autonomy, ProactiveAutonomyLevel):
        try:
            autonomy = ProactiveAutonomyLevel(str(autonomy))
        except ValueError:
            autonomy = ProactiveAutonomyLevel.APPROVAL_FOR_RISKY
    return needs_approval(task_risk_level(task), autonomy)


def task_to_bridge_initiative(task: dict[str, Any]) -> Initiative:
    """Thin adapter: Task → Initiative shape for ExecutionBridge (no DB write)."""
    tid = str(task.get("id") or task.get("task_id") or "").strip()
    plan = task.get("action_plan")
    if not isinstance(plan, dict):
        plan = {}
    return Initiative(
        id=f"task:{tid}" if tid else "task:unknown",
        role_agent_code=str(task.get("assigned_to") or "").strip(),
        title=str(task.get("name") or task.get("title") or "").strip() or tid,
        description=str(task.get("description") or "").strip(),
        rationale=str(task.get("rationale") or "").strip(),
        action_type=task_action_type(task),
        risk_level=task_risk_level(task),
        action_plan=plan,
        expected_outcome=str(task.get("expected_outcome") or "").strip(),
        status=InitiativeStatus.APPROVED,
        round_id=str(task.get("round_id") or task.get("source_ref") or "").strip() or None,
        goal=str(task.get("goal") or "").strip(),
        outcome=str(task.get("outcome") or "").strip(),
        created_at=str(task.get("created_at") or utc_now_iso_z()),
        updated_at=str(task.get("updated_at") or utc_now_iso_z()),
    )


def set_work_item_status(
    task_id: str,
    status: str,
    *,
    result: str | None = None,
    progress: int | None = None,
) -> None:
    """Update task state via admin API (state machine).

    Never overwrite a terminal success (reviewed/completed) with a later
    timeout/failure result — that false「等待超时」text caused re-dispatch loops.
    """
    from evoflow.admin import tasks as admin_tasks
    from evoflow.collab.storage import (
        get_project_storage,
        patch_collab_main_task_in_project_storage,
    )

    tid = str(task_id or "").strip()
    if not tid:
        return
    target = str(status or "").strip().lower()

    current = load_work_item_task(tid)
    cur_status = str((current or {}).get("status") or "").strip().lower()
    try:
        cur_prog = int((current or {}).get("progress") or 0)
    except (TypeError, ValueError):
        cur_prog = 0
    already_done = is_work_item_done(cur_status, progress=cur_prog)

    if already_done and target in _FAILED_TASK_STATUSES | {"executing", "in_progress", "pending"}:
        logger.info(
            "proactive.work_items: skip downgrade task=%s current=%s@%s%% → %s",
            tid,
            cur_status,
            cur_prog,
            target,
        )
        return

    try:
        if progress is not None:
            admin_tasks.update_progress(tid, int(progress), status=target)
        else:
            admin_tasks.set_task_state(tid, target)
    except Exception:
        logger.warning(
            "proactive.work_items: set_task_state failed task=%s status=%s",
            tid,
            target,
            exc_info=True,
        )
        return
    if result is not None:
        # Don't stamp timeout/failure prose onto an already-successful task.
        if already_done and target in _DONE_TASK_STATUSES - {"cancelled", "canceled", "rejected"}:
            low = str(result).lower()
            if (
                "timeout" in low
                or "timed out" in low
                or "等待超时" in str(result)
                or str(result).strip().startswith("执行失败")
            ):
                logger.info(
                    "proactive.work_items: skip failure result on done task=%s",
                    tid,
                )
                return
        try:
            from evoflow.proactive.run_errors import humanize_execution_result

            storage = get_project_storage()
            text = humanize_execution_result(str(result)) or str(result)[:8000]
            patch: dict[str, Any] = {"result": text[:8000]}
            # Auto-handoff / failure: also stamp 任务总结 for panel list/detail.
            if target in {"reviewed", "completed", "failed", "error"}:
                existing = str((current or {}).get("summary") or "").strip()
                if not existing:
                    patch["summary"] = text[:8000]
            if target in {"failed", "error"}:
                patch["error"] = text[:2000]
            patch_collab_main_task_in_project_storage(storage, tid, patch)
        except Exception:
            logger.debug(
                "proactive.work_items: patch result failed task=%s",
                tid,
                exc_info=True,
            )


async def execute_work_item(task_id: str) -> str:
    """Execute an approved work-item Task via ExecutionBridge adapter."""
    from evoflow.proactive.execution_bridge import ExecutionBridge

    task = load_work_item_task(task_id)
    if not task:
        return f"Work item task '{task_id}' not found"
    # Normalize id
    tid = str(task.get("id") or task.get("task_id") or task_id).strip()
    task = {**task, "id": tid, "task_id": tid}

    set_work_item_status(tid, "executing", progress=5)
    try:
        await _maybe_push_running_card(task, tid)
    except Exception:
        logger.debug(
            "proactive.work_items: feishu running card skipped task=%s",
            tid,
            exc_info=True,
        )
    initiative = task_to_bridge_initiative(task)
    bridge = ExecutionBridge()
    # Bridge marks initiative FAILED on error using synthetic id — ignore that path;
    # we drive Task status ourselves.
    try:
        result = await bridge.execute(initiative)
    except Exception as exc:
        set_work_item_status(tid, "failed", result=f"Execution error: {exc}", progress=0)
        raise

    # Prefer user cancel from Feishu control card over bridge outcome
    current = load_work_item_task(tid)
    if current and str(current.get("status") or "").strip().lower() == "cancelled":
        return str(result or "已取消")

    failed = _is_execution_failure(result)
    cancelled = _is_execution_cancelled(result)
    if cancelled:
        set_work_item_status(tid, "cancelled", result=result, progress=0)
    elif failed:
        set_work_item_status(tid, "failed", result=result, progress=0)
    else:
        # 岗位干完 → completed（结案）；交接审核见 handlers + needs_approval
        set_work_item_status(tid, "completed", result=result, progress=100)
        try:
            await _maybe_push_review_card(task, tid, result)
        except Exception:
            logger.debug(
                "proactive.work_items: feishu review card skipped task=%s",
                tid,
                exc_info=True,
            )
    return result


async def _maybe_push_running_card(task: dict[str, Any], tid: str) -> None:
    from evoflow.proactive.feishu_notify import push_running_work_card
    from evoflow.proactive.repositories import ProactiveRepository

    code = str(task.get("assigned_to") or "").strip()
    if not code:
        return
    role = ProactiveRepository.get_role(code)
    if role is None:
        return
    title = str(task.get("name") or task.get("title") or tid)
    await push_running_work_card(role, task_id=tid, title=title)


async def _maybe_push_review_card(task: dict[str, Any], tid: str, result: str) -> None:
    from evoflow.proactive.feishu_notify import push_review_card
    from evoflow.proactive.repositories import ProactiveRepository

    code = str(task.get("assigned_to") or "").strip()
    if not code:
        return
    role = ProactiveRepository.get_role(code)
    if role is None:
        return
    title = str(task.get("name") or task.get("title") or tid)
    summary = str(result or task.get("summary") or task.get("result") or "")[:2000]
    await push_review_card(role, task_id=tid, title=title, summary=summary)


def _is_execution_cancelled(result: str) -> bool:
    s = str(result or "").strip().lower()
    if not s:
        return False
    return (
        "已被取消" in s
        or "已取消" in s
        or "cancelled" in s
        or "canceled" in s
    )


def _is_execution_failure(result: str) -> bool:
    s = str(result or "").strip().lower()
    if not s:
        return False
    return (
        s.startswith("execution failed")
        or s.startswith("execution error")
        or s.startswith("执行失败")
        or "步数用尽" in s
        or "recursion limit" in s
    )


def initiative_status_to_task_status(status: InitiativeStatus | str) -> str:
    """Map legacy initiative status → collab task status (migration / UI)."""
    raw = status.value if isinstance(status, InitiativeStatus) else str(status or "")
    mapping = {
        "proposed": "pending",
        "approved": "pending",
        "pending_approval": "pending",
        "rejected": "cancelled",
        "timeout_rejected": "cancelled",
        "skipped": "cancelled",
        "executing": "executing",
        "completed": "reviewed",
        "failed": "failed",
    }
    return mapping.get(raw, "pending")
