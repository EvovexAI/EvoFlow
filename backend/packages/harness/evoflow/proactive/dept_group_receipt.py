"""部门群聊自动回执：后台 run 终态 → 群时间线气泡。

员工在群聊被叫醒的回合里启动的耗时工作（工作流 run 等），生命周期往往长于
那个回合；回合结束群气泡就定稿了，之后任务真正完成/失败时群里没有任何声音
——「员工悄悄干完了，群里永远不知道」。

链路：员工 sticky 工作会话（``proactive:{code}:chat:dept-{id}``）的上下文里
带 ``dept_group_timeline_session``（前端 dept-member-work-session.ts 每轮写入，
此前后端零消费）。run 终态时（唯一写 chokepoint
``app_repositories.update_run_status``）：

1. 由 run.thread_id / run.task_id 反查发起会话；
2. 发起会话上下文有 ``dept_group_timeline_session`` → 解析员工身份；
3. 以该员工名义往群会话 append 一条 ``final`` 气泡，正文明确标注自动回执。

幂等：message_id 固定 ``dept-receipt-{run_id}``，append 走
skip_if_message_id_exists，reconciler 反复 heal 同一终态不会刷屏。
"""

from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)

TERMINAL_RUN_STATUSES = ("completed", "failed", "cancelled")

_STATUS_LABEL = {
    "completed": "已完成",
    "failed": "失败",
    "cancelled": "已取消",
}


def _excerpt(raw: Any, limit: int = 200) -> str:
    text = str(raw or "").strip().replace("\r", "").replace("\n", " ")
    return text[:limit]


def _reverse_session_by_collab_task(task_id: str) -> str:
    """collab 任务（含主任务 id）→ 绑定会话 session_key（best-effort）。"""
    tid = str(task_id or "").strip()
    if not tid:
        return ""
    try:
        from evoflow.persistence.db import get_db

        conn = get_db()
        main_row = conn.execute(
            "SELECT main_task_id FROM evoflow_collab_tasks WHERE task_id = ? LIMIT 1",
            (tid,),
        ).fetchone()
        candidates = [tid]
        if main_row and str(main_row[0] or "").strip():
            candidates.append(str(main_row[0]).strip())
        placeholders = ",".join("?" for _ in candidates)
        row = conn.execute(
            f"""
            SELECT session_key FROM evoflow_chat_sessions
            WHERE collab_task_id IN ({placeholders}) AND is_deleted = 0
            ORDER BY updated_at DESC LIMIT 1
            """,
            candidates,
        ).fetchone()
        return str(row[0] or "").strip() if row else ""
    except Exception:
        logger.debug("dept receipt task reverse lookup failed", exc_info=True)
        return ""


def _resolve_source_session(run: dict[str, Any]) -> str:
    """run → 发起会话 session_key（thread 直查优先，collab 任务反查兜底）。"""
    from evoflow.persistence.session_repositories import find_session_key_by_thread_id

    tid = str(run.get("thread_id") or "").strip()
    if tid:
        try:
            sk = find_session_key_by_thread_id(tid)
        except Exception:
            sk = None
        if sk:
            return str(sk).strip()

    return _reverse_session_by_collab_task(str(run.get("task_id") or ""))


def build_dept_group_run_receipt(run: dict[str, Any], status: str) -> str:
    label = _STATUS_LABEL.get(str(status or "").strip().lower(), status or "结束")
    app_name = str(run.get("app_name") or run.get("app_id") or "任务").strip()
    summary = _excerpt(run.get("result_summary"))
    err = _excerpt(run.get("error"))
    head = f"「{app_name}」{label}（自动回执，后台任务，非本人输入）"
    if status == "failed" and err:
        return f"{head}：{err}"
    if summary:
        return f"{head}：{summary}"
    return head


def _load_source_session_ctx(source_sk: str) -> dict[str, Any]:
    """发起会话 → dept 群回执所需上下文（原始 context_json，见下）。

    直接读原始 context_json：扁平视图会把 agent_id 镜像进 agent_name，
    顺手把员工真正的角色名顶掉（session_context_fields.context_from_flat_row）。
    dept_group_* 键都不在 _FLAT_KEYS，原始 JSON 一定保有它们。
    """
    import json as _json

    from evoflow.persistence.db import get_db

    row = get_db().execute(
        "SELECT context_json FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
        (str(source_sk or "").strip(),),
    ).fetchone()
    ctx: dict[str, Any] = {}
    if row and str(row[0] or "").strip():
        try:
            parsed = _json.loads(str(row[0]))
            if isinstance(parsed, dict):
                ctx = parsed
        except Exception:
            ctx = {}
    return ctx


def _append_dept_group_receipt(
    *,
    group_sk: str,
    dept_id: str,
    dept_name: str,
    agent_code: str,
    agent_name: str,
    text: str,
    message_id: str,
    extra_meta: dict[str, Any] | None = None,
    source_sk: str = "",
) -> bool:
    meta: dict[str, Any] = {
        "dept_id": dept_id,
        "dept_name": dept_name or None,
        # 无员工身份可解析时退化为 system 条（前端 kind=system 走系统样式）
        "msg_kind": "agent" if agent_code else "system",
        "speaker_code": agent_code or None,
        "speaker_name": agent_name or None,
        "stream_state": "final",
        "auto_receipt": True,
        **(extra_meta or {}),
    }
    content_json = {"content": text, "dept_group": meta}
    try:
        from evoflow.persistence import chat_session_service as chat_svc

        # dept 气泡与 finalize 同一写法：upsert by message_id（幂等）且写 turn_state，
        # 普通 append INSERT 不落 turn_state，前端 stale-streaming 判定会缺列。
        chat_svc.upsert_message_and_touch_session(
            group_sk,
            role="assistant",
            message_id=message_id,
            content=text,
            content_json=content_json,
            turn_state="final",
        )
        return True
    except Exception:
        logger.warning("dept receipt append failed group=%s src=%s", group_sk, source_sk, exc_info=True)
        return False


def push_dept_group_run_receipt(
    run_id: str,
    status: str,
    *,
    result_summary: str = "",
    error: str = "",
) -> bool:
    """终态回执落群。任何失败都静默降级（不拖垮状态写路径）。"""
    status_norm = str(status or "").strip().lower()
    if status_norm not in TERMINAL_RUN_STATUSES:
        return False
    rid = str(run_id or "").strip()
    if not rid:
        return False
    try:
        from evoflow.persistence.app_repositories import load_run

        run = load_run(rid) or {}
    except Exception:
        logger.debug("dept receipt load_run failed run=%s", rid, exc_info=True)
        return False
    if result_summary and not str(run.get("result_summary") or "").strip():
        run["result_summary"] = result_summary
    if error and not str(run.get("error") or "").strip():
        run["error"] = error
    try:
        from evoflow.persistence.db import get_db

        app_row = get_db().execute(
            "SELECT name FROM evoflow_apps WHERE id = ?",
            (str(run.get("app_id") or ""),),
        ).fetchone()
        if app_row and str(app_row[0] or "").strip():
            run["app_name"] = str(app_row[0]).strip()
    except Exception:
        pass

    source_sk = _resolve_source_session(run)
    if not source_sk:
        return False

    try:
        ctx = _load_source_session_ctx(source_sk)
        group_sk = str(ctx.get("dept_group_timeline_session") or "").strip()
        agent_code = str(ctx.get("proactive_agent_code") or "").strip()
        agent_name = str(ctx.get("agent_name") or "").strip() or agent_code
        dept_id = str(ctx.get("dept_group_id") or "").strip()
        dept_name = str(ctx.get("dept_group_name") or "").strip()
    except Exception:
        logger.debug("dept receipt context read failed sk=%s", source_sk, exc_info=True)
        return False
    if not group_sk:
        return False

    text = build_dept_group_run_receipt(run, status_norm)
    return _append_dept_group_receipt(
        group_sk=group_sk,
        dept_id=dept_id,
        dept_name=dept_name,
        agent_code=agent_code,
        agent_name=agent_name,
        text=text,
        message_id=f"dept-receipt-{rid}",
        extra_meta={"receipt_run_id": rid, "receipt_status": status_norm},
        source_sk=source_sk,
    )


def maybe_push_dept_group_run_receipt_async(
    run_id: str,
    status: str,
    *,
    result_summary: str = "",
    error: str = "",
) -> None:
    """终态钩子入口：终态才投递，daemon 线程执行（不得拖慢状态写/事件循环）。"""
    if str(status or "").strip().lower() not in TERMINAL_RUN_STATUSES:
        return
    rid = str(run_id or "").strip()
    if not rid:
        return

    def _work() -> None:
        try:
            push_dept_group_run_receipt(
                rid,
                status,
                result_summary=result_summary,
                error=error,
            )
        except Exception:
            logger.debug("dept receipt async push failed run=%s", rid, exc_info=True)

    try:
        threading.Thread(
            target=_work,
            name=f"dept-receipt-{rid[:24]}",
            daemon=True,
        ).start()
    except Exception:
        logger.debug("dept receipt thread spawn failed run=%s", rid, exc_info=True)


def build_dept_group_task_receipt(name: str, status: str, error_text: str = "") -> str:
    label = _STATUS_LABEL.get(str(status or "").strip().lower(), status or "结束")
    head = f"「{str(name or '').strip() or '协作任务'}」{label}（自动回执，非本人输入）"
    err = _excerpt(error_text)
    if str(status or "").strip().lower() == "failed" and err:
        return f"{head}：{err}"
    return head


def push_dept_group_task_receipt(
    main_task_id: str,
    status: str,
    *,
    name: str = "",
    error_text: str = "",
) -> bool:
    """协作主任务终态回执落群。app/workflow 源的任务不投（run 回执已覆盖，避免双报）。"""
    status_norm = str(status or "").strip().lower()
    if status_norm not in TERMINAL_RUN_STATUSES:
        return False
    mid = str(main_task_id or "").strip()
    if not mid:
        return False

    # 主任务行状态 + app 源检测（extra_json 带 app_definition_snapshot 即 app run，已有 run 回执）
    name_fallback = name
    err_fallback = error_text
    try:
        from evoflow.persistence.db import get_db

        row = get_db().execute(
            "SELECT name, status, error_text, extra_json FROM evoflow_collab_tasks "
            "WHERE main_task_id = ? AND task_id = main_task_id LIMIT 1",
            (mid,),
        ).fetchone()
        if row:
            if not name_fallback:
                name_fallback = str(row[0] or "").strip()
            if not err_fallback:
                err_fallback = str(row[2] or "").strip()
            if '"app_definition_snapshot"' in str(row[3] or ""):
                return False
    except Exception:
        logger.debug("dept receipt task row read failed main=%s", mid, exc_info=True)

    # 发起会话：主任务 thread 直查优先，collab_task_id 反查兜底
    source_sk = ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        source_sk = _reverse_session_by_collab_task(mid)
        if not source_sk:
            from evoflow.persistence.task_repositories import get_main_thread_id

            tid = str(get_main_thread_id(mid) or "").strip()
            if tid:
                source_sk = str(find_session_key_by_thread_id(tid) or "").strip()
    except Exception:
        logger.debug("dept receipt task session resolve failed main=%s", mid, exc_info=True)
    if not source_sk:
        return False

    try:
        ctx = _load_source_session_ctx(source_sk)
        group_sk = str(ctx.get("dept_group_timeline_session") or "").strip()
        agent_code = str(ctx.get("proactive_agent_code") or "").strip()
        agent_name = str(ctx.get("agent_name") or "").strip() or agent_code
        dept_id = str(ctx.get("dept_group_id") or "").strip()
        dept_name = str(ctx.get("dept_group_name") or "").strip()
    except Exception:
        logger.debug("dept receipt task context read failed sk=%s", source_sk, exc_info=True)
        return False
    if not group_sk:
        return False

    text = build_dept_group_task_receipt(name_fallback, status_norm, err_fallback)
    return _append_dept_group_receipt(
        group_sk=group_sk,
        dept_id=dept_id,
        dept_name=dept_name,
        agent_code=agent_code,
        agent_name=agent_name,
        text=text,
        message_id=f"dept-receipt-task-{mid}",
        extra_meta={"receipt_task_id": mid, "receipt_status": status_norm},
        source_sk=source_sk,
    )


def maybe_push_dept_group_task_receipt_async(
    main_task_id: str,
    status: str,
    *,
    name: str = "",
    error_text: str = "",
) -> None:
    if str(status or "").strip().lower() not in TERMINAL_RUN_STATUSES:
        return
    mid = str(main_task_id or "").strip()
    if not mid:
        return

    def _work() -> None:
        try:
            push_dept_group_task_receipt(mid, status, name=name, error_text=error_text)
        except Exception:
            logger.debug("dept receipt async push failed main=%s", mid, exc_info=True)

    try:
        threading.Thread(
            target=_work,
            name=f"dept-receipt-t-{mid[:24]}",
            daemon=True,
        ).start()
    except Exception:
        logger.debug("dept receipt task thread spawn failed main=%s", mid, exc_info=True)
