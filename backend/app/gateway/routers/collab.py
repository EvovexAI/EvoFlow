"""Per-thread collaboration state API (``collab_state.json`` under thread dir)."""

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from evoflow.agents.tool_approval_trace_log import log_tool_approval_trace
from evoflow.authz.http_guard import require_task_visible, require_thread_visible
from evoflow.collab.models import CollabPhase, ThreadCollabState
from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.collab.thread_collab import (
    load_thread_collab_state,
    merge_thread_collab_state,
    save_thread_collab_state,
)
from evoflow.config.paths import get_paths

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/collab", tags=["collab"])


def _resume_tool_approval_blocking(
    *,
    thread_id: str,
    session_key: str,
    action: str,
    resume_action: str,
    replay_tool_call_ids: list[str],
    tool_call_id: str | None,
    workspace_root: str | None,
    denied_tool_call_ids: list[str] | None = None,
) -> None:
    """同步阻塞版本，用于 asyncio.to_thread 在线程池中执行，不占用 Gateway 事件循环。"""
    import time

    from evoflow.agents.tool_approval_resume import (
        build_tool_approval_resume_payload,
        trigger_tool_approval_resume_inplace,
    )

    tid = str(thread_id or "").strip()
    if not tid:
        return
    sk = str(session_key or "").strip()

    log_tool_approval_trace("resume阻塞函数·开始", thread_id=tid, side="resume",
        event_data={"action": action, "resume_action": resume_action, "session_key": sk})
    t0 = time.perf_counter()
    logger.info(
        "【工具授权·线程池恢复】开始 thread=%s action=%s resume_action=%s tc=%s replay_ids=%s",
        tid,
        action,
        resume_action,
        tool_call_id or "",
        list(replay_tool_call_ids),
    )
    try:
        # 最后一次点击可能是 deny，但同批已有批准项 → 必须走 execute_approved，不能走 deny。
        if list(replay_tool_call_ids or []):
            resume_payload = build_tool_approval_resume_payload(
                action="approve",
                tool_call_ids=list(replay_tool_call_ids),
                tool_call_id=str(tool_call_id or "") or None,
            )
        elif action == "deny":
            resume_payload = build_tool_approval_resume_payload(
                action="deny",
                tool_call_id=str(tool_call_id or ""),
                tool_call_ids=list(denied_tool_call_ids or []),
            )
        elif resume_action == "await_next":
            resume_payload = build_tool_approval_resume_payload(action="await_next")
            logger.info(
                "【工具授权·线程池恢复】await_next：已批准当前工具，图将继续处理下一个待授权 thread=%s",
                tid,
            )
        else:
            replay_ids = list(replay_tool_call_ids)
            resume_payload = build_tool_approval_resume_payload(
                action=action,
                tool_call_ids=replay_ids,
                tool_call_id=str(tool_call_id or "") or None,
            )
        logger.info(
            "【工具授权·线程池恢复】resume_payload=%s thread=%s",
            resume_payload,
            tid,
        )
        # 在线程池中创建独立的事件循环来跑异步 resume 逻辑
        out = asyncio.run(
            trigger_tool_approval_resume_inplace(
                thread_id=tid,
                session_key=str(session_key or "").strip(),
                resume_payload=resume_payload,
                workspace_root=workspace_root,
            )
        )
        logger.info(
            "【工具授权·线程池恢复】完成 thread=%s ms=%.1f same_sse=%s started=%s out=%s",
            tid,
            (time.perf_counter() - t0) * 1000.0,
            out.get("same_sse"),
            out.get("started"),
            out,
        )
        if not out.get("started"):
            logger.error(
                "【工具授权·线程池恢复】resume 未真正启动 — 模型若仍在后台跑则与前端 SSE 脱节 thread=%s error=%s",
                tid,
                out.get("error"),
            )
            from app.gateway.streaming.tool_approval_stream_push import push_pending_approvals_to_live_stream

            # push_pending_approvals_to_live_stream 是 async 的，需要 asyncio.run
            asyncio.run(
                push_pending_approvals_to_live_stream(
                    tid,
                    reason=f"resume未启动 action={action} resume_action={resume_action}",
                )
            )
            logger.info(
                "【工具授权·线程池恢复】resume 未启动，补推 pending 到 SSE thread=%s",
                tid,
            )
        log_tool_approval_trace("resume阻塞函数·完成", thread_id=tid, side="resume",
            event_data={"action": action, "result_started": out.get("started", False),
                        "result_run_id": out.get("run_id"), "same_sse": out.get("same_sse", False)})
    except Exception:
        logger.exception(
            "【工具授权·线程池恢复】失败 thread=%s ms=%.1f",
            tid,
            (time.perf_counter() - t0) * 1000.0,
        )
        log_tool_approval_trace("resume阻塞函数·异常", thread_id=tid, side="resume",
            level=logging.ERROR, event_data={"error": "see logger.exception"})


async def _delayed_client_replay_fallback(
    *,
    thread_id: str,
    session_key: str,
    replay_tool_call_ids: list[str],
    workspace_root: str | None,
    delay_s: float = 12.0,
) -> None:
    """If the panel never POSTs the replay stream, start background worker as fallback."""
    tid = str(thread_id or "").strip()
    ids = [str(x).strip() for x in (replay_tool_call_ids or []) if str(x).strip()]
    if not tid or not ids:
        return
    try:
        await asyncio.sleep(max(2.0, float(delay_s)))
    except Exception:
        return
    try:
        from app.gateway.db_async import run_db
        from app.gateway.streaming.background_worker import StreamBackgroundWorker
        from evoflow.agents.tool_approval_resume import trigger_tool_approval_replay_run
        from evoflow.agents.tool_approval_service import pop_replay_queue

        if StreamBackgroundWorker.is_worker_running(tid):
            log_tool_approval_trace(
                "client_replay·fallback跳过·worker已在跑",
                thread_id=tid,
                side="API",
                event_data={"replay_ids": ids},
            )
            return
        remaining = await run_db(pop_replay_queue, tid, ids)
        if not remaining:
            log_tool_approval_trace(
                "client_replay·fallback跳过·队列已消费",
                thread_id=tid,
                side="API",
                event_data={"replay_ids": ids},
            )
            return
        log_tool_approval_trace(
            "client_replay·fallback启动后台流",
            thread_id=tid,
            side="API",
            event_data={"replay_ids": ids, "remaining": len(remaining)},
        )
        logger.warning(
            "【工具授权·client_replay】面板未接流，启动后台 fallback thread=%s ids=%s",
            tid,
            ids,
        )
        await trigger_tool_approval_replay_run(
            thread_id=tid,
            session_key=str(session_key or "").strip(),
            replay_tool_call_ids=ids,
            workspace_root=workspace_root,
        )
    except Exception:
        logger.exception("client_stream_replay fallback failed thread=%s", tid)


async def _resume_tool_approval_background(
    *,
    thread_id: str,
    session_key: str,
    action: str,
    resume_action: str,
    replay_tool_call_ids: list[str],
    tool_call_id: str | None,
    workspace_root: str | None,
    denied_tool_call_ids: list[str] | None = None,
) -> None:
    """Resume interrupted graph after approve/deny — must not block the HTTP response.

    直接在 Gateway 主事件循环上运行（通过 asyncio.create_task 调度）。
    不使用 asyncio.to_thread + asyncio.run，因为 asyncio.run() 创建的临时事件循环
    会在返回时关闭，杀死 middle layer 和 StreamBackgroundWorker 绑定在其上的后台任务。
    """
    import time

    from evoflow.agents.tool_approval_resume import (
        build_tool_approval_resume_payload,
        trigger_tool_approval_resume_inplace,
    )

    tid = str(thread_id or "").strip()
    if not tid:
        return
    t0 = time.perf_counter()
    logger.info(
        "【工具授权·后台恢复】开始 thread=%s action=%s resume_action=%s tc=%s replay_ids=%s",
        tid,
        action,
        resume_action,
        tool_call_id or "",
        list(replay_tool_call_ids),
    )
    try:
        # 最后一次点击可能是 deny，但同批已有批准项 → 必须走 execute_approved，不能走 deny。
        if list(replay_tool_call_ids or []):
            resume_payload = build_tool_approval_resume_payload(
                action="approve",
                tool_call_ids=list(replay_tool_call_ids),
                tool_call_id=str(tool_call_id or "") or None,
            )
        elif action == "deny":
            resume_payload = build_tool_approval_resume_payload(
                action="deny",
                tool_call_id=str(tool_call_id or ""),
                tool_call_ids=list(denied_tool_call_ids or []),
            )
        elif resume_action == "await_next":
            resume_payload = build_tool_approval_resume_payload(action="await_next")
            logger.info(
                "【工具授权·后台恢复】await_next：已批准当前工具，图将继续处理下一个待授权 thread=%s",
                tid,
            )
        else:
            # Standard HITL: resume lets interrupt() return the decision,
            # then handler(request) executes the tool *inside* the graph.
            # No gateway pre-execution - tool results enter graph state naturally.
            replay_ids = list(replay_tool_call_ids)
            resume_payload = build_tool_approval_resume_payload(
                action=action,
                tool_call_ids=replay_ids,
                tool_call_id=str(tool_call_id or "") or None,
            )
        logger.info(
            "【工具授权·后台恢复】resume_payload=%s thread=%s",
            resume_payload,
            tid,
        )
        out = await trigger_tool_approval_resume_inplace(
            thread_id=tid,
            session_key=str(session_key or "").strip(),
            resume_payload=resume_payload,
            workspace_root=workspace_root,
        )
        logger.info(
            "【工具授权·后台恢复】完成 thread=%s ms=%.1f same_sse=%s started=%s out=%s",
            tid,
            (time.perf_counter() - t0) * 1000.0,
            out.get("same_sse"),
            out.get("started"),
            out,
        )
        if not out.get("started"):
            logger.error(
                "【工具授权·后台恢复】resume 未真正启动 — 模型若仍在后台跑则与前端 SSE 脱节 thread=%s error=%s",
                tid,
                out.get("error"),
            )
            from app.gateway.streaming.tool_approval_stream_push import push_pending_approvals_to_live_stream

            n = await push_pending_approvals_to_live_stream(
                tid,
                reason=f"resume未启动 action={action} resume_action={resume_action}",
            )
            logger.info(
                "【工具授权·后台恢复】resume 未启动，补推 pending 到 SSE thread=%s count=%s",
                tid,
                n,
            )
    except Exception:
        logger.exception(
            "【工具授权·后台恢复】失败 thread=%s ms=%.1f",
            tid,
            (time.perf_counter() - t0) * 1000.0,
        )
async def _push_resume_failure_sse(thread_id: str, error: str) -> None:
    """Resume 失败时通过 SSE 推送错误通知，让用户知道审批后执行失败。"""
    try:
        from app.gateway.streaming.post_stream_ui_normalize import clear_thread_tool_approval_pause
        from app.gateway.streaming.stream_middle_layer import wake_middle_layer_inject
        from app.gateway.streaming.tool_approval_stream_push import push_tool_approval_decision

        tid = str(thread_id or "").strip()
        await push_tool_approval_decision(
            tid,
            tool_call_id="_resume_failed",
            tool_name="",
            status="error",
            message=f"工具执行恢复失败：{error[:200]}。请重新发送消息或重新审批。",
            reason="resume_failed",
        )
        log_tool_approval_trace("resume失败·SSE错误通知已推送", thread_id=tid, side="resume",
            level=logging.ERROR, event_data={"error": error[:200]})
        # 清除 pause 标记，让 SSE 流可以正常结束
        clear_thread_tool_approval_pause(tid)
        wake_middle_layer_inject(tid)
    except Exception:
        logger.debug("push_resume_failure_sse failed thread=%s", thread_id, exc_info=True)


class ThreadCollabStatePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    collab_phase: CollabPhase | None = None
    bound_task_id: str | None = None


class ThreadCollabStateResponse(BaseModel):
    collab_phase: CollabPhase
    bound_task_id: str | None
    sidebar_supervisor_steps: list[dict[str, Any]] = Field(default_factory=list)
    updated_at: str


class SubtaskHistoryResponse(BaseModel):
    main_task_id: str
    subtask_id: str
    count: int
    lines: list[str] = Field(default_factory=list)


class ToolApprovalActionBody(BaseModel):
    action: str = Field(..., description="approve | approve_all | deny | grant_all")
    tool_call_id: str | None = None
    local_workspace_root: str | None = None
    tool_name: str | None = None
    args: dict[str, Any] | None = None
    summary: str | None = None


class ToolApprovalActionResponse(BaseModel):
    success: bool
    message: str
    replay_message: str | None = None
    replay_tool_call_ids: list[str] = Field(default_factory=list)
    resume_run_id: str | None = None
    stream_resume_recommended: bool = False
    # True when original POST SSE already closed — panel should POST the replay
    # marker itself so the follow-up model reply streams live (not history dump).
    client_stream_replay: bool = False


class ToolApprovalPendingListResponse(BaseModel):
    thread_id: str
    pending_approvals: list[dict[str, Any]] = Field(default_factory=list)
    count: int = 0
    effective_tool_approval_policy: str = "grant_all"


@router.get("/threads/{thread_id}/tool-approval/pending", response_model=ToolApprovalPendingListResponse)
async def list_thread_tool_approval_pending(request: Request, thread_id: str) -> ToolApprovalPendingListResponse:
    require_thread_visible(request, thread_id)
    from app.gateway.db_async import run_db
    from evoflow.agents.tool_approval_service import list_pending_approvals
    from evoflow.persistence.tool_approval_policy import effective_policy_for_thread

    tid = str(thread_id or "").strip()
    if not tid:
        raise HTTPException(status_code=422, detail="thread_id required")
    pending = await run_db(list_pending_approvals, tid)
    policy = await run_db(effective_policy_for_thread, tid)
    return ToolApprovalPendingListResponse(
        thread_id=tid,
        pending_approvals=pending,
        count=len(pending),
        effective_tool_approval_policy=policy,
    )


@router.post("/threads/{thread_id}/tool-approval", response_model=ToolApprovalActionResponse)
async def post_thread_tool_approval(
    request: Request, thread_id: str, body: ToolApprovalActionBody
) -> ToolApprovalActionResponse:
    require_thread_visible(request, thread_id)
    import asyncio
    import time

    from evoflow.agents.tool_approval_service import apply_user_approval_with_session

    t0 = time.perf_counter()
    tid = str(thread_id or "").strip()
    if not tid:
        raise HTTPException(status_code=422, detail="thread_id required")
    action = str(body.action or "").strip().lower()
    tc_id = str(body.tool_call_id or "").strip()
    logger.info(
        "【工具授权·API】进入 thread=%s action=%s tool=%s tc=%s",
        tid,
        action,
        str(body.tool_name or ""),
        tc_id,
    )
    if action not in {"approve", "approve_all", "deny", "grant_all"}:
        raise HTTPException(status_code=422, detail="action must be approve, approve_all, deny, or grant_all")
    data: dict[str, Any] = {"action": action}
    if body.tool_call_id:
        data["tool_call_id"] = tc_id
    if body.tool_name:
        data["tool_name"] = str(body.tool_name).strip()
    if isinstance(body.args, dict):
        data["args"] = body.args
    if body.summary:
        data["summary"] = str(body.summary).strip()
    ws = str(body.local_workspace_root or "").strip() or None
    log_tool_approval_trace("API收到审批请求", thread_id=tid, side="API",
        event_data={"action": action, "tool_call_id": tc_id, "tool_name": str(body.tool_name or "")})
    logger.info("tool approval API trace logged thread=%s ms=%.1f", tid, (time.perf_counter() - t0) * 1000.0)
    from app.gateway.db_async import run_db

    t_db = time.perf_counter()
    try:
        bundle = await asyncio.wait_for(
            run_db(apply_user_approval_with_session, tid, data, workspace_root=ws),
            timeout=8.0,
        )
    except TimeoutError:
        logger.error(
            "tool approval DB timed out thread=%s tool_call_id=%s waited_ms=%.1f",
            tid,
            tc_id,
            (time.perf_counter() - t_db) * 1000.0,
        )
        raise HTTPException(status_code=503, detail="授权处理超时，请稍后重试（数据库繁忙）") from None
    result = bundle.result
    sk = str(bundle.session_key or "").strip()
    resume_action = str(getattr(result, "resume_action", "") or "").strip().lower()
    # 重要：部分批准/部分拒绝（await_next）只更新 DB/UI，绝不 Command(resume)。
    # 否则 LangGraph 可能用 rollback/enqueue 开新一轮，同批 sibling 仍 pending 时图已继续。
    # 仅当全部决策完毕（有 replay_ids，或纯拒绝且无剩余 pending）才 resume。
    should_resume = bool(result.replay_tool_call_ids) or (
        action == "deny"
        and bool(data.get("tool_call_id"))
        and resume_action != "await_next"
        and not bundle.still_pending
    )
    log_tool_approval_trace("API·DB操作完成", thread_id=tid, side="API",
        event_data={"reply": result.reply, "replay_ids": list(result.replay_tool_call_ids),
                     "still_pending": bundle.still_pending, "should_resume": should_resume,
                     "resume_action": resume_action})
    logger.info(
        "【工具授权·API】DB完成 thread=%s ms=%.1f still_pending=%s replay_ids=%s resume_action=%s 回复=%s",
        tid,
        (time.perf_counter() - t_db) * 1000.0,
        bundle.still_pending,
        list(result.replay_tool_call_ids),
        resume_action,
        result.reply,
    )
    try:
        from app.gateway.streaming.post_stream_ui_normalize import (
            clear_thread_tool_approval_pause,
            invalidate_defer_run_finished_cache,
            thread_in_tool_approval_pause,
        )
        from app.gateway.streaming.stream_middle_layer import wake_middle_layer_inject

        invalidate_defer_run_finished_cache(tid)
        if not bundle.still_pending and not should_resume:
            clear_thread_tool_approval_pause(tid)
        elif not bundle.still_pending:
            logger.info(
                "【工具授权·API】保持 pause 直到 resume 完成 thread=%s should_resume=%s",
                tid,
                should_resume,
            )
        # 立刻把「已批准/已拒绝」推到当前 SSE，避免 UI 卡在 pending 而模型已继续
        try:
            from app.gateway.streaming.tool_approval_stream_push import (
                push_pending_approvals_to_live_stream,
                push_tool_approval_decision,
            )

            if action == "deny" and tc_id:
                await push_tool_approval_decision(
                    tid,
                    tool_call_id=tc_id,
                    tool_name=str(data.get("tool_name") or ""),
                    status="denied",
                    message="已拒绝该工具调用。",
                    reason="api_deny",
                )
                if resume_action == "await_next":
                    n = await push_pending_approvals_to_live_stream(
                        tid,
                        reason="deny_await_next_no_resume",
                    )
                    logger.info(
                        "【工具授权·API】deny await_next 不 resume，仅补推剩余 pending thread=%s count=%s",
                        tid,
                        n,
                    )
            elif action in {"approve", "approve_all", "grant_all"}:
                if action == "approve" and tc_id and resume_action == "await_next":
                    await push_tool_approval_decision(
                        tid,
                        tool_call_id=tc_id,
                        tool_name=str(data.get("tool_name") or ""),
                        status="approved_waiting",
                        message="当前工具已批准，等待其他待授权工具确认后统一执行。",
                        reason="api_approve_await_next",
                    )
                    n = await push_pending_approvals_to_live_stream(
                        tid,
                        reason="await_next_no_resume",
                    )
                    logger.info(
                        "【工具授权·API】await_next 不 resume，仅补推剩余 pending thread=%s count=%s",
                        tid,
                        n,
                    )
                else:
                    decision_ids = (
                        [tc_id]
                        if action == "approve" and tc_id and not result.replay_tool_call_ids
                        else list(result.replay_tool_call_ids) or ([tc_id] if tc_id else [])
                    )
                    for rid in decision_ids:
                        if not rid:
                            continue
                        await push_tool_approval_decision(
                            tid,
                            tool_call_id=str(rid),
                            tool_name=str(data.get("tool_name") or ""),
                            status="approved",
                            message="已批准，正在执行…",
                            reason=f"api_{action}",
                        )
        except Exception:
            logger.exception("【工具授权·API】推送决策 SSE 失败 thread=%s", tid)
        wake_middle_layer_inject(tid)
        logger.info(
            "【工具授权·API】唤醒 middle layer inject thread=%s pause_flag=%s still_pending=%s should_resume=%s",
            tid,
            thread_in_tool_approval_pause(tid),
            bundle.still_pending,
            should_resume,
        )
    except Exception:
        logger.exception("tool approval post-db wake failed thread=%s", tid)

    # SSE决策推送记录
    log_tool_approval_trace("API·SSE决策已推送", thread_id=tid, side="API",
        event_data={"action": action, "pushed_ids": decision_ids if 'decision_ids' in dir() else []})

    resume_run_id: str | None = None
    stream_resume_recommended = False
    client_stream_replay = False
    replay_message: str | None = None
    if should_resume:
        replay_ids = list(result.replay_tool_call_ids or [])
        layer = None
        try:
            from app.gateway.streaming.stream_middle_layer import get_active_middle_layer

            layer = get_active_middle_layer(tid)
        except Exception:
            layer = None

        if layer is not None:
            # Original POST SSE still open — resume on the same stream.
            log_tool_approval_trace(
                "API·启动resume后台任务",
                thread_id=tid,
                side="API",
                event_data={
                    "should_resume": True,
                    "resume_action": resume_action,
                    "replay_ids": replay_ids,
                    "mode": "same_sse",
                },
            )
            logger.info(
                "【工具授权·API】调度同 SSE resume thread=%s resume_action=%s replay_ids=%s",
                tid,
                resume_action,
                replay_ids,
            )
            resume_task = asyncio.create_task(
                _resume_tool_approval_background(
                    thread_id=tid,
                    session_key=sk,
                    action=action,
                    resume_action=resume_action,
                    replay_tool_call_ids=replay_ids,
                    tool_call_id=str(data.get("tool_call_id") or "") or None,
                    workspace_root=ws,
                    denied_tool_call_ids=list(result.denied_tool_call_ids or []),
                )
            )

            def _on_resume_done(task: asyncio.Task) -> None:
                """Resume 失败时通过 SSE 通知前端，避免假成功。"""
                if task.cancelled():
                    logger.warning("【工具授权·resume】后台 resume 被取消 thread=%s", tid)
                    return
                exc = task.exception()
                if exc is None:
                    return
                logger.error(
                    "【工具授权·resume】后台 resume 失败 thread=%s error=%s",
                    tid,
                    exc,
                    exc_info=exc,
                )
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(_push_resume_failure_sse(tid, str(exc)))
                except RuntimeError:
                    logger.debug("resume failure SSE push failed thread=%s (no running loop)", tid)
                except Exception:
                    logger.debug("resume failure SSE push failed thread=%s", tid, exc_info=True)

            resume_task.add_done_callback(_on_resume_done)
            stream_resume_recommended = False
            if layer.run_id:
                resume_run_id = str(layer.run_id).strip() or None
        elif replay_ids:
            # POST SSE already closed — let the panel open a fresh /runs/stream
            # with the replay marker so the next model reply streams live.
            from evoflow.agents.tool_approval_service import build_replay_message

            client_stream_replay = True
            stream_resume_recommended = True
            replay_message = build_replay_message(replay_ids)
            log_tool_approval_trace(
                "API·交由面板client_stream_replay",
                thread_id=tid,
                side="API",
                event_data={"replay_ids": replay_ids, "mode": "client_stream_replay"},
            )
            logger.info(
                "【工具授权·API】交由面板 POST replay 流 thread=%s ids=%s",
                tid,
                replay_ids,
            )
            asyncio.create_task(
                _delayed_client_replay_fallback(
                    thread_id=tid,
                    session_key=sk,
                    replay_tool_call_ids=replay_ids,
                    workspace_root=ws,
                )
            )
        else:
            # deny / await_next without an open layer — keep background path.
            log_tool_approval_trace(
                "API·启动resume后台任务",
                thread_id=tid,
                side="API",
                event_data={
                    "should_resume": True,
                    "resume_action": resume_action,
                    "replay_ids": replay_ids,
                    "mode": "background_no_layer",
                },
            )
            resume_task = asyncio.create_task(
                _resume_tool_approval_background(
                    thread_id=tid,
                    session_key=sk,
                    action=action,
                    resume_action=resume_action,
                    replay_tool_call_ids=replay_ids,
                    tool_call_id=str(data.get("tool_call_id") or "") or None,
                    workspace_root=ws,
                    denied_tool_call_ids=list(result.denied_tool_call_ids or []),
                )
            )
            stream_resume_recommended = True
    else:
        logger.info(
            "【工具授权·API】无需 resume thread=%s action=%s still_pending=%s",
            tid,
            action,
            bundle.still_pending,
        )

    logger.info(
        "【工具授权·API】返回 thread=%s total_ms=%.1f should_resume=%s client_stream_replay=%s success=%s",
        tid,
        (time.perf_counter() - t0) * 1000.0,
        should_resume,
        client_stream_replay,
        bool(result.replay_tool_call_ids)
        or action == "deny"
        or action in {"grant_all", "approve_all"}
        or getattr(result, "resume_action", "") == "await_next",
    )
    return ToolApprovalActionResponse(
        success=bool(result.replay_tool_call_ids) or action == "deny" or action in {"grant_all", "approve_all"} or getattr(result, "resume_action", "") == "await_next",
        message=result.reply,
        replay_message=replay_message,
        replay_tool_call_ids=result.replay_tool_call_ids,
        resume_run_id=resume_run_id,
        stream_resume_recommended=stream_resume_recommended,
        client_stream_replay=client_stream_replay,
    )


@router.post("/threads/{thread_id}/tool-approval/cancel")
async def cancel_thread_tool_approval(request: Request, thread_id: str) -> dict[str, Any]:
    require_thread_visible(request, thread_id)
    from evoflow.agents.tool_approval_service import cancel_all_pending_approvals

    tid = str(thread_id or "").strip()
    if not tid:
        raise HTTPException(status_code=422, detail="thread_id required")
    from app.gateway.db_async import run_db

    n = await run_db(cancel_all_pending_approvals, tid, reason="user_cancel")

    # 清除 pause 标记 + 唤醒 middle layer + 推送取消通知
    try:
        from app.gateway.streaming.post_stream_ui_normalize import (
            clear_thread_tool_approval_pause,
            invalidate_defer_run_finished_cache,
        )
        from app.gateway.streaming.stream_middle_layer import wake_middle_layer_inject
        from app.gateway.streaming.tool_approval_stream_push import push_tool_approval_decision

        invalidate_defer_run_finished_cache(tid)
        clear_thread_tool_approval_pause(tid)
        wake_middle_layer_inject(tid)
        await push_tool_approval_decision(
            tid,
            tool_call_id="",
            tool_name="",
            status="cancelled",
            message="已取消所有待授权工具。",
            reason="user_cancel",
        )
        logger.info("【工具授权·cancel】已清除 pause + 唤醒 middle layer thread=%s cancelled=%s", tid, n)
    except Exception:
        logger.exception("【工具授权·cancel】清理失败 thread=%s", tid)

    log_tool_approval_trace("API·取消审批", thread_id=tid, side="API",
        event_data={"cancelled_count": n})
    return {"success": True, "cancelled_count": n}


@router.get("/threads/{thread_id}", response_model=ThreadCollabStateResponse)
async def get_thread_collab_state(request: Request, thread_id: str) -> ThreadCollabState:
    require_thread_visible(request, thread_id)
    paths = get_paths()
    try:
        state = load_thread_collab_state(paths, thread_id)
        phase_val = state.collab_phase.value if hasattr(state.collab_phase, "value") else str(state.collab_phase)
        phase = str(phase_val or "").strip().lower()
        if phase == CollabPhase.EXECUTING.value:
            task_id = str(state.bound_task_id or "").strip()
            if task_id:
                try:
                    storage = get_project_storage()
                    row = find_main_task(storage, task_id)
                    if row is not None:
                        _project, task = row
                        status = str(task.get("status") or "").strip().lower()
                        main_terminal = status in {"completed", "failed", "cancelled"}
                        if main_terminal:
                            merged = merge_thread_collab_state(state, {"collab_phase": CollabPhase.DONE.value})
                            state = save_thread_collab_state(paths, thread_id, merged)
                except Exception:
                    logger.debug("collab get_thread: terminal self-heal failed", exc_info=True)
        return state
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        logger.exception("Failed to load collab state for %s", thread_id)
        raise HTTPException(status_code=500, detail="Failed to load collaboration state.") from None


@router.get("/threads/{thread_id}/mission-analysis")
async def get_thread_mission_analysis(request: Request, thread_id: str) -> dict[str, Any]:
    """Latest async mission analysis tree (主问题 / 子问题 / 进度) from ``evoflow_mission_nodes``."""
    require_thread_visible(request, thread_id)
    from evoflow.agents.mission_state import load_mission_state
    from evoflow.persistence.mission_node_repositories import load_latest_mission_tree

    tree_payload = load_latest_mission_tree(thread_id)
    state = load_mission_state(thread_id)
    if tree_payload is None and state is None:
        raise HTTPException(status_code=404, detail="No mission analysis for this thread yet")
    return {
        "thread_id": thread_id,
        "snapshot": tree_payload,
        "mission_state": state.model_dump(mode="json") if state else None,
    }


@router.put("/threads/{thread_id}", response_model=ThreadCollabStateResponse)
async def put_thread_collab_state(
    request: Request, thread_id: str, body: dict[str, Any] = Body(default_factory=dict)
) -> ThreadCollabState:
    require_thread_visible(request, thread_id)
    paths = get_paths()
    try:
        patch_model = ThreadCollabStatePatch.model_validate(body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    patch = patch_model.model_dump(exclude_unset=True, mode="json")
    try:
        current = load_thread_collab_state(paths, thread_id)
        if not patch:
            return current
        merged = merge_thread_collab_state(current, patch)
        phase_after = merged.collab_phase.value if isinstance(merged.collab_phase, CollabPhase) else str(merged.collab_phase or "")
        if str(phase_after or "").strip().lower() in {
            CollabPhase.PLANNING.value,
            CollabPhase.PLAN_READY.value,
        }:
            try:
                from evoflow.collab.plan_session_task import ensure_plan_session_task

                ensure_plan_session_task(thread_id, paths=paths)
                merged = load_thread_collab_state(paths, thread_id)
            except Exception:
                logger.debug("put_thread_collab: ensure_plan_session_task failed", exc_info=True)
        return save_thread_collab_state(paths, thread_id, merged)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        logger.exception("Failed to save collab state for %s", thread_id)
        raise HTTPException(status_code=500, detail="Failed to save collaboration state.") from None


def _conversation_text_line(msg: dict[str, Any]) -> str:
    message = msg.get("content")
    if isinstance(message, str):
        return message.strip()
    if isinstance(message, list):
        parts: list[str] = []
        for item in message:
            if isinstance(item, str):
                parts.append(item.strip())
            elif isinstance(item, dict):
                t = item.get("text") or item.get("content")
                if isinstance(t, str):
                    parts.append(t.strip())
        return "\n".join(p for p in parts if p).strip()
    if message is not None:
        return str(message).strip()
    return ""


@router.get("/tasks/{main_task_id}/subtasks/{subtask_id}/history", response_model=SubtaskHistoryResponse)
async def get_subtask_history(
    request: Request, main_task_id: str, subtask_id: str, limit: int = 600
) -> SubtaskHistoryResponse:
    """Return persisted conversation text lines for one subtask (chat transcript)."""
    require_task_visible(request, main_task_id)
    try:
        storage = get_project_storage()
        found = find_main_task(storage, main_task_id)
        if not found:
            raise HTTPException(status_code=404, detail=f"Task '{main_task_id}' not found")
        _project, task = found
        target = str(subtask_id or "").strip()
        subtask_row = next(
            (st for st in (task.get("subtasks") or []) if str(st.get("id") or "").strip() == target),
            None,
        )
        cap = max(1, min(int(limit or 600), 5000))
        from evoflow.collab.conversation_persist import list_subtask_conversation_ui_messages

        lines: list[str] = []
        for msg in list_subtask_conversation_ui_messages(
            task,
            target,
            subtask_row=subtask_row if isinstance(subtask_row, dict) else None,
            limit=cap,
        ):
            txt = _conversation_text_line(msg)
            if txt:
                lines.append(txt)
        if len(lines) > cap:
            lines = lines[-cap:]
        return SubtaskHistoryResponse(
            main_task_id=main_task_id,
            subtask_id=subtask_id,
            count=len(lines),
            lines=lines,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        logger.exception("Failed to read subtask history main=%s sub=%s", main_task_id, subtask_id)
        raise HTTPException(status_code=500, detail="Failed to read subtask history.") from None
