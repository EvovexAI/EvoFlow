"""小V系统工具：名册 / 全局看板 / 派发 / 催办（不问澄清、不代替员工执行）。"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.tools import tool

from evoflow.agents.xiaomi.identity import XIAOMI_AGENT_CODE, is_xiaomi_agent

logger = logging.getLogger(__name__)


def _json(data: Any) -> str:
    try:
        return json.dumps(data, ensure_ascii=False, indent=2, default=str)
    except Exception:
        return str(data)


def _active_employee_rows() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Active roster rows excluding 小V herself + list_roles meta."""
    from evoflow.admin import employees as emp

    data = emp.list_roles(status="active")
    roles = data.get("roles") if isinstance(data, dict) else []
    rows: list[dict[str, Any]] = []
    for r in roles or []:
        if not isinstance(r, dict):
            continue
        code = str(r.get("agent_code") or "").strip()
        if is_xiaomi_agent(code):
            continue
        rows.append(
            {
                "agent_code": code,
                "role_name": r.get("role_name"),
                "department": r.get("department"),
                "busy": bool(r.get("busy")),
                "status": r.get("status"),
                "reports_to": r.get("reports_to"),
                "last_heartbeat_at": r.get("last_heartbeat_at"),
                "next_heartbeat_at": r.get("next_heartbeat_at"),
                "pending_approvals": r.get("pending_approvals"),
            }
        )
    meta = data if isinstance(data, dict) else {}
    return rows, meta


@tool("xiaomi_org_status", parse_docstring=True)
def xiaomi_org_status_tool() -> str:
    """查看有多少智能体员工、谁在岗/忙碌，供小V决定派给谁、催谁。

    只读名册与 runner 状态；不含小V自己。先调本工具再派发/催办。
    """
    try:
        rows, meta = _active_employee_rows()
        busy_n = sum(1 for r in rows if r.get("busy"))
        idle_n = len(rows) - busy_n
        pending_n = sum(int(r.get("pending_approvals") or 0) for r in rows)
        return _json(
            {
                "ok": True,
                "employee_count": len(rows),
                "busy_count": busy_n,
                "idle_count": idle_n,
                "pending_approvals_total": pending_n,
                "gateway_reachable": bool(meta.get("gateway_reachable")),
                "employees": rows,
            }
        )
    except Exception as exc:
        logger.exception("xiaomi_org_status failed")
        return _json({"ok": False, "error": str(exc)})


@tool("xiaomi_board_overview", parse_docstring=True)
def xiaomi_board_overview_tool(limit_per_role: int = 8) -> str:
    """查看各岗未结 Task 与进度，找出卡住项以便催办推进。

    Args:
        limit_per_role: 每个岗位最多列出几条未结 Task。
    """
    lim = max(1, min(20, int(limit_per_role or 8)))
    try:
        from evoflow.admin import tasks as admin_tasks

        rows, _meta = _active_employee_rows()
        boards: list[dict[str, Any]] = []
        total_open = 0
        stuck: list[dict[str, Any]] = []
        for r in rows:
            name = str(r.get("role_name") or "").strip()
            code = str(r.get("agent_code") or "").strip()
            if not name:
                continue
            try:
                listed = admin_tasks.list_tasks(role=name, include_subtasks=False)
                tasks = list(listed.get("tasks") or [])
            except Exception:
                tasks = []
            open_all = [
                t
                for t in tasks
                if str(t.get("status") or "").lower()
                not in {"completed", "reviewed", "cancelled", "canceled", "rejected"}
                and int(t.get("progress") or 0) < 100
            ]
            total_open += len(open_all)
            sample = []
            for t in open_all[:lim]:
                try:
                    prog = int(t.get("progress") or 0)
                except (TypeError, ValueError):
                    prog = 0
                st = str(t.get("status") or "").strip()
                tid = t.get("task_id") or t.get("id")
                item = {
                    "task_id": tid,
                    "name": t.get("name"),
                    "status": st,
                    "progress": prog,
                }
                sample.append(item)
                # Heuristic: open but little progress → candidate to wake.
                # Never wake 100% / near-done noise.
                if prog >= 90:
                    continue
                if prog < 30 and st.lower() not in {"blocked", "waiting_approval"}:
                    stuck.append(
                        {
                            "agent_code": code,
                            "role_name": name,
                            "busy": bool(r.get("busy")),
                            **item,
                        }
                    )
                elif st.lower() in {"blocked", "stalled", "waiting", "paused"}:
                    stuck.append(
                        {
                            "agent_code": code,
                            "role_name": name,
                            "busy": bool(r.get("busy")),
                            **item,
                        }
                    )
            boards.append(
                {
                    "agent_code": code,
                    "role_name": name,
                    "busy": bool(r.get("busy")),
                    "open_count": len(open_all),
                    "tasks": sample,
                }
            )
        return _json(
            {
                "ok": True,
                "employee_count": len(rows),
                "total_open_tasks": total_open,
                "stuck_candidates": stuck[:24],
                "boards": boards,
            }
        )
    except Exception as exc:
        logger.exception("xiaomi_board_overview failed")
        return _json({"ok": False, "error": str(exc)})


def _resolve_employee_code(agent_code_or_name: str) -> tuple[str, str | None]:
    """Resolve agent_code from code or role_name. Returns (code, error)."""
    raw = str(agent_code_or_name or "").strip()
    if not raw:
        return "", "agent_code is required"
    if is_xiaomi_agent(raw):
        return "", "cannot inspect xiaomi herself; pick an employee"
    try:
        from evoflow.admin import employees as emp
        from evoflow.admin.errors import NotFoundError

        try:
            detail = emp.get_role(raw, recent_limit=0)
            code = str(detail.get("agent_code") or raw).strip()
            if code and not is_xiaomi_agent(code):
                return code, None
        except NotFoundError:
            pass
        data = emp.list_roles(status="active", include_archived=True)
        roles = data.get("roles") if isinstance(data, dict) else []
        needle = raw.lower()
        for r in roles or []:
            if not isinstance(r, dict):
                continue
            code = str(r.get("agent_code") or "").strip()
            name = str(r.get("role_name") or "").strip()
            if is_xiaomi_agent(code):
                continue
            if code.lower() == needle or name.lower() == needle:
                return code, None
        return "", f"employee not found: {raw}"
    except Exception as exc:
        return "", str(exc)


def _is_open_task(task: dict[str, Any]) -> bool:
    st = str(task.get("status") or "").lower()
    if st in {"completed", "reviewed", "cancelled", "canceled", "rejected"}:
        return False
    try:
        prog = int(task.get("progress") or 0)
    except (TypeError, ValueError):
        prog = 0
    return prog < 100


def _task_brief_item(t: dict[str, Any]) -> dict[str, Any]:
    try:
        prog = int(t.get("progress") or 0)
    except (TypeError, ValueError):
        prog = 0
    summary = str(t.get("summary") or "").strip()
    result = t.get("result")
    result_s = ""
    if isinstance(result, str):
        result_s = result.strip()
    elif result is not None:
        result_s = str(result).strip()
    report = summary or result_s
    return {
        "task_id": t.get("task_id") or t.get("id"),
        "name": t.get("name"),
        "status": t.get("status"),
        "progress": prog,
        "assigned_role": t.get("assigned_role") or t.get("role_name"),
        "report": (report[:500] if report else None),
        "updated_at": t.get("updated_at") or t.get("completed_at") or t.get("created_at"),
    }


def _condense_work_trail(messages: list[dict[str, Any]], *, max_tools: int = 16) -> dict[str, Any]:
    """Compress duty transcript into tool sequence + last assistant snippet."""
    tools: list[str] = []
    last_assistant = ""
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or m.get("type") or "").strip().lower()
        if role in {"tool", "toolresult"}:
            name = str(m.get("tool_name") or m.get("name") or "").strip()
            if not name:
                payload = m.get("content_json")
                if isinstance(payload, dict):
                    name = str(payload.get("name") or payload.get("tool_name") or "").strip()
            if name:
                tools.append(name)
        elif role in {"assistant", "ai"}:
            payload = m.get("content_json")
            text = ""
            if isinstance(payload, str):
                text = payload
            elif isinstance(payload, dict):
                text = str(payload.get("content") or payload.get("text") or "")
                if not text and isinstance(payload.get("parts"), list):
                    bits = []
                    for p in payload["parts"]:
                        if isinstance(p, dict) and p.get("type") in {None, "text", "string"}:
                            bits.append(str(p.get("text") or p.get("content") or ""))
                        elif isinstance(p, str):
                            bits.append(p)
                    text = "".join(bits)
            elif isinstance(payload, list):
                bits = []
                for p in payload:
                    if isinstance(p, dict):
                        bits.append(str(p.get("text") or p.get("content") or ""))
                    elif isinstance(p, str):
                        bits.append(p)
                text = "".join(bits)
            text = str(text or "").strip()
            if text:
                last_assistant = text
    return {
        "tool_sequence": tools[-max(1, min(int(max_tools), 40)) :],
        "tool_count": len(tools),
        "last_assistant_text": (last_assistant[:480] if last_assistant else ""),
    }


def _employee_open_tasks(role_name: str, *, limit: int = 8) -> list[dict[str, Any]]:
    try:
        from evoflow.admin import tasks as admin_tasks

        listed = admin_tasks.list_tasks(role=role_name, include_subtasks=False)
        tasks = list(listed.get("tasks") or [])
    except Exception:
        return []
    open_tasks = [_task_brief_item(t) for t in tasks if isinstance(t, dict) and _is_open_task(t)]
    return open_tasks[: max(1, min(int(limit), 20))]


def _recent_rounds_from_chat(agent_code: str, *, limit: int = 5) -> list[dict[str, Any]]:
    """Lightweight round meta from proactive chat (avoid importing FastAPI router)."""
    code = str(agent_code or "").strip()
    if not code:
        return []
    sk = f"proactive:{code}"
    try:
        from evoflow.persistence.db import get_db

        rows = (
            get_db()
            .execute(
                """
                SELECT round_id,
                       MIN(created_at) AS first_at,
                       MAX(created_at) AS last_at,
                       COUNT(*) AS msg_n,
                       SUM(CASE WHEN role = 'tool' THEN 1 ELSE 0 END) AS tool_n
                FROM evoflow_chat_messages
                WHERE session_key = ?
                  AND round_id IS NOT NULL
                  AND TRIM(round_id) != ''
                GROUP BY round_id
                ORDER BY last_at DESC
                LIMIT ?
                """,
                (sk, max(1, min(int(limit), 20))),
            )
            .fetchall()
        )
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        rid = str(row["round_id"] or "").strip()
        if not rid:
            continue
        msg_n = int(row["msg_n"] or 0)
        tool_n = int(row["tool_n"] or 0)
        kind = "派发" if rid.startswith("dispatch:") else "值班"
        out.append(
            {
                "round_id": rid,
                "title": f"{kind}轮次",
                "outcome": f"本轮轨迹 {msg_n} 条（工具 {tool_n} 次）",
                "updated_at": str(row["last_at"] or row["first_at"] or "").strip() or None,
            }
        )
    return out


@tool("xiaomi_employee_brief", parse_docstring=True)
def xiaomi_employee_brief_tool(
    agent_code: str,
    include_trail: bool = True,
    task_limit: int = 8,
) -> str:
    """查看某个智能体员工在干嘛：忙闲、未结任务、近况摘要、最近工作轨迹。

    用户问「某某进度怎么样 / 他在干什么 / 最近干了啥」时用本工具。
    可用 agent_code（如 code-agent）或岗位中文名。

    Args:
        agent_code: 员工 agent_code 或岗位名。
        include_trail: 是否附带最近一轮工具轨迹摘要（默认 True）。
        task_limit: 最多列出几条未结 Task。
    """
    code, err = _resolve_employee_code(agent_code)
    if err:
        return _json({"ok": False, "error": err})
    try:
        from evoflow.admin import employees as emp
        from evoflow.admin.errors import NotFoundError
        from evoflow.proactive.repositories import ProactiveMemoryRepository, ProactiveRepository

        try:
            detail = emp.get_role(code, recent_limit=6)
        except NotFoundError as e:
            return _json({"ok": False, "error": str(e)})

        role = ProactiveRepository.get_role(code)
        role_name = str((detail.get("role_name") if isinstance(detail, dict) else None) or code)
        busy = False
        busy_started = ""
        try:
            from evoflow.proactive.runner import get_proactive_runner

            runner = get_proactive_runner()
            busy = bool(runner.is_role_busy(code))
            if busy:
                for row in runner.busy_roles():
                    if str(row.get("agent_code") or "") == code:
                        busy_started = str(row.get("started_at") or "")
                        break
        except Exception:
            busy = False

        mem = ProactiveMemoryRepository.get(code)
        open_tasks = _employee_open_tasks(role_name, limit=task_limit)
        recent_inits = []
        for i in list((detail or {}).get("recent_initiatives") or [])[:6]:
            if not isinstance(i, dict):
                continue
            recent_inits.append(
                {
                    "id": i.get("id"),
                    "title": i.get("title"),
                    "status": i.get("status"),
                    "result": i.get("result"),
                    "action_type": i.get("action_type"),
                    "round_id": i.get("round_id"),
                    "created_at": i.get("created_at"),
                }
            )

        rounds_meta: list[dict[str, Any]] = []
        trail: dict[str, Any] | None = None
        rounds_meta = _recent_rounds_from_chat(code, limit=5)

        if include_trail:
            try:
                from evoflow.persistence.chat_message_repositories import list_messages_for_display_all

                rid = str((rounds_meta[0] or {}).get("round_id") or "").strip() if rounds_meta else ""
                session_key = f"proactive:{code}"
                raw = list_messages_for_display_all(
                    session_key,
                    max_rows=80,
                    round_id=rid or None,
                )
                trail = {
                    "round_id": rid or None,
                    **_condense_work_trail(list(raw.get("messages") or [])),
                }
            except Exception:
                trail = {"round_id": None, "tool_sequence": [], "tool_count": 0, "last_assistant_text": ""}

        # Person Kernel Phase D: desensitized workplace affect (no journal/stance/lessons)
        person_brief: dict[str, Any] | None = None
        try:
            from evoflow.person_kernel import desensitized_person_brief

            person_brief = desensitized_person_brief(code)
        except Exception:
            person_brief = None

        return _json(
            {
                "ok": True,
                "agent_code": code,
                "role_name": role_name,
                "status": detail.get("status") if isinstance(detail, dict) else getattr(role, "status", None),
                "busy": busy,
                "busy_started_at": busy_started or None,
                "last_heartbeat_at": detail.get("last_heartbeat_at") if isinstance(detail, dict) else None,
                "next_heartbeat_at": detail.get("next_heartbeat_at") if isinstance(detail, dict) else None,
                "within_work_hours": detail.get("within_work_hours") if isinstance(detail, dict) else None,
                "last_think_at": getattr(mem, "last_think_at", None),
                "last_think_summary": (str(getattr(mem, "last_think_summary", "") or "").strip()[:600] or None),
                "open_tasks": open_tasks,
                "open_task_count": len(open_tasks),
                "recent_initiatives": recent_inits,
                "recent_rounds": rounds_meta,
                "work_trail": trail,
                "person_workplace": person_brief,
                "hint": (
                    "用白话向用户说明忙闲、未结任务与最近在干啥；"
                    "person_workplace 仅含脱敏职场情绪/开放承诺数/关系亮点，勿编造心智日记。"
                    "需要单任务详情再调 xiaomi_task_brief。"
                ),
                "watch_path": f"/proactive/{code}?live=1",
            }
        )
    except Exception as exc:
        logger.exception("xiaomi_employee_brief failed code=%s", code)
        return _json({"ok": False, "error": str(exc)})


@tool("xiaomi_task_brief", parse_docstring=True)
def xiaomi_task_brief_tool(task_id: str) -> str:
    """查看单个 Task 的进度与汇报摘要（状态、进度、summary/result）。

    用户问「这个任务怎么样了 / 汇报内容 / 完成了没」时用本工具。

    Args:
        task_id: 岗位工作项 Task id（看板里的 task_id）。
    """
    tid = str(task_id or "").strip()
    if not tid:
        return _json({"ok": False, "error": "task_id is required"})
    # Guard: duty round ids / chat round ids are not Task ids.
    if tid.startswith(("round:", "dispatch:", "chat-round:", "proactive:")):
        return _json(
            {
                "ok": False,
                "error": "that looks like a duty round id, not a Task id; use xiaomi_employee_brief instead",
            }
        )
    try:
        from evoflow.admin import tasks as admin_tasks
        from evoflow.admin.errors import NotFoundError, ValidationError

        try:
            detail = admin_tasks.get_task(tid)
        except (NotFoundError, ValidationError) as e:
            return _json({"ok": False, "error": str(e)})

        brief = _task_brief_item(detail if isinstance(detail, dict) else {})
        summary = str((detail or {}).get("summary") or "").strip()
        result = (detail or {}).get("result")
        error = (detail or {}).get("error")
        description = str((detail or {}).get("description") or "").strip()
        subtasks = []
        for st in list((detail or {}).get("subtasks") or [])[:12]:
            if isinstance(st, dict):
                subtasks.append(_task_brief_item(st))
        return _json(
            {
                "ok": True,
                **brief,
                "status_zh": (detail or {}).get("status_zh"),
                "description": (description[:400] if description else None),
                "summary": (summary[:800] if summary else None),
                "result": result if isinstance(result, (str, dict, list)) else (str(result) if result is not None else None),
                "error": error,
                "assigned_to": (detail or {}).get("assigned_to"),
                "raised_by": (detail or {}).get("raised_by"),
                "parent": (detail or {}).get("parent"),
                "subtasks": subtasks,
                "is_subtask": bool((detail or {}).get("is_subtask")),
                "created_at": (detail or {}).get("created_at"),
                "started_at": (detail or {}).get("started_at"),
                "completed_at": (detail or {}).get("completed_at"),
                "hint": "向用户口语汇报进度与结论；已结案勿再 wake；未结且卡住可 xiaomi_wake。",
            }
        )
    except Exception as exc:
        logger.exception("xiaomi_task_brief failed task_id=%s", tid)
        return _json({"ok": False, "error": str(exc)})


@tool("xiaomi_dispatch", parse_docstring=True)
def xiaomi_dispatch_tool(
    agent_code: str,
    goal: str,
    description: str = "",
) -> str:
    """把新目标派给指定智能体员工（后台值班轮），小V自己不执行。

    Args:
        agent_code: 员工 agent_code，如 code-agent / project-debugger。
        goal: 一句话目标。
        description: 可选补充说明、验收标准。
    """
    code = str(agent_code or "").strip()
    goal_s = str(goal or "").strip()
    if not code or not goal_s:
        return _json({"ok": False, "error": "agent_code and goal are required"})
    if is_xiaomi_agent(code):
        return _json({"ok": False, "error": "cannot dispatch to xiaomi herself"})
    try:
        from evoflow.admin import employees as emp
        from evoflow.admin.errors import ConflictError, NotFoundError, ValidationError

        try:
            res = emp.dispatch(
                code,
                goal_s,
                description=str(description or "").strip(),
                source="xiaomi",
                from_agent=XIAOMI_AGENT_CODE,
            )
        except ConflictError as e:
            return _json({"ok": False, "busy": True, "error": str(e)})
        except (NotFoundError, ValidationError) as e:
            return _json({"ok": False, "error": str(e)})
        return _json(res if isinstance(res, dict) else {"ok": True, "result": res})
    except Exception as exc:
        logger.exception("xiaomi_dispatch failed code=%s", code)
        return _json({"ok": False, "error": str(exc)})


@tool("xiaomi_wake", parse_docstring=True)
def xiaomi_wake_tool(
    agent_code: str,
    task_id: str = "",
    goal: str = "",
    description: str = "",
) -> str:
    """催办/叫醒员工推进已有 Task 或补一句目标（推进卡住进度用）。

    优先传 task_id；没有 Task 时传 goal。小V先看看板，再对本工具催办。

    Args:
        agent_code: 目标员工 agent_code 或岗位名。
        task_id: 已有岗位工作项 Task id（推荐）。
        goal: 无 task_id 时的一句话目标；有 task_id 时可省略。
        description: 可选补充说明。
    """
    code = str(agent_code or "").strip()
    tid = str(task_id or "").strip()
    goal_s = str(goal or "").strip()
    if not code:
        return _json({"ok": False, "error": "agent_code is required"})
    if is_xiaomi_agent(code):
        return _json({"ok": False, "error": "cannot wake xiaomi herself"})
    if not tid and not goal_s:
        return _json({"ok": False, "error": "task_id or goal is required"})
    try:
        from evoflow.admin import employees as emp
        from evoflow.admin.errors import ConflictError, NotFoundError, ValidationError

        try:
            res = emp.wake(
                code,
                goal_s,
                from_agent=XIAOMI_AGENT_CODE,
                task_id=tid,
                description=str(description or "").strip(),
                source="xiaomi",
            )
        except ConflictError as e:
            return _json({"ok": False, "busy": True, "error": str(e)})
        except (NotFoundError, ValidationError) as e:
            return _json({"ok": False, "error": str(e)})
        return _json(res if isinstance(res, dict) else {"ok": True, "result": res})
    except Exception as exc:
        logger.exception("xiaomi_wake failed code=%s", code)
        return _json({"ok": False, "error": str(exc)})



@tool("xiaomi_knowledge_search", parse_docstring=True)
async def xiaomi_knowledge_search_tool(query: str, top_k: int = 6) -> str:
    """检索本地自有知识库，回答用法/概念/文档类问题。

    用户问「怎么用」「为什么选 X」「知识库里…」时先调本工具；无命中须明说未找到，禁止编造。
    员工进度/派活仍用 org/board/dispatch/wake，不要用本工具代替。

    Args:
        query: 自然语言问题或关键词。
        top_k: 最多返回条数（默认 6，上限 12）。
    """
    import time

    q = str(query or "").strip()
    if not q:
        return _json({"ok": False, "error": "query is required"})
    lim = max(1, min(12, int(top_k or 6)))
    try:
        from evoflow.knowledge.owned import service as owned_service
        from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started

        ensure_owned_kb_worker_started()
        bases = owned_service.list_bases()
        if not bases:
            return _json(
                {
                    "ok": False,
                    "error": "no_owned_kb",
                    "message": "还没有自有知识库。请先在「知识库」页新建并导入文档，再让我检索。",
                }
            )

        name_by_id = {str(b.get("id")): str(b.get("name") or b.get("id")) for b in bases}
        kids = [str(b.get("id")) for b in bases if b.get("id")]
        per_kb = lim if len(kids) == 1 else max(lim, min(12, lim * 2))
        t0 = time.perf_counter()
        merged: list[dict[str, Any]] = []
        degraded_any = False
        for kid in kids:
            # Prefer keyword when vectors not ready — avoids cold embedding wait.
            mode = "hybrid"
            base = next((b for b in bases if str(b.get("id")) == kid), None)
            if not (base and base.get("embeddingDim")):
                mode = "keyword"
            result = await owned_service.search(kid, q, mode=mode, top_k=per_kb)
            if result.get("degraded"):
                degraded_any = True
            for item in result.get("items") or []:
                score = item.get("rrfScore") or item.get("vectorScore") or item.get("score") or 0
                try:
                    score_f = float(score)
                except (TypeError, ValueError):
                    score_f = 0.0
                merged.append(
                    {
                        "kbId": kid,
                        "kb": name_by_id.get(kid, kid),
                        "title": item.get("title") or item.get("fileName") or "片段",
                        "path": item.get("fileName") or item.get("title") or "",
                        "docId": item.get("docId"),
                        "snippet": (item.get("content") or "")[:800],
                        "score": score_f,
                        "source": "owned",
                    }
                )

        merged.sort(key=lambda h: float(h.get("score") or 0), reverse=True)
        seen_docs: set[str] = set()
        top: list[dict[str, Any]] = []
        for row in merged:
            did = str(row.get("docId") or "")
            if did and did in seen_docs:
                continue
            if did:
                seen_docs.add(did)
            top.append(row)
            if len(top) >= max(lim, 8):
                break

        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(
            "xiaomi_knowledge_search owned kbs=%s hits=%s ms=%s degraded=%s",
            len(kids),
            len(top),
            elapsed_ms,
            degraded_any,
        )
        if not top:
            return _json(
                {
                    "ok": True,
                    "query": q,
                    "count": 0,
                    "items": [],
                    "provider": "owned",
                    "elapsedMs": elapsed_ms,
                    "degraded": degraded_any,
                    "message": "自有知识库里暂时没有找到相关资料。可到「知识库」页确认文档已索引完成。",
                }
            )
        return _json(
            {
                "ok": True,
                "query": q,
                "count": len(top),
                "items": top,
                "provider": "owned",
                "elapsedMs": elapsed_ms,
                "degraded": degraded_any,
                "hint": "用片段回答用户；引用 title/path；无足够证据则说明未在知识库找到，勿编造。",
            }
        )
    except Exception as exc:
        logger.exception("xiaomi_knowledge_search failed")
        return _json({"ok": False, "error": str(exc)})


def get_xiaomi_tools() -> list:
    from evoflow.tools.builtins.platform_tool import platform_tool

    return [
        xiaomi_org_status_tool,
        xiaomi_board_overview_tool,
        xiaomi_employee_brief_tool,
        xiaomi_task_brief_tool,
        xiaomi_dispatch_tool,
        xiaomi_wake_tool,
        xiaomi_knowledge_search_tool,
        platform_tool,
    ]
