"""Server-side resume for tool-approval human gates (replay run or deny continuation)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from evoflow.agents.tool_approval_trace_log import log_tool_approval_trace

logger = logging.getLogger(__name__)

DEFAULT_ASSISTANT_ID = "lead_agent"
DEFAULT_LANGGRAPH_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").strip()


def build_tool_approval_resume_payload(
    *,
    action: str,
    tool_call_ids: list[str] | None = None,
    tool_call_id: str | None = None,
) -> dict[str, Any]:
    """Legacy interrupt resume payload (kept for compatibility)."""
    act = str(action or "").strip().lower()
    ids = [str(x).strip() for x in (tool_call_ids or []) if str(x).strip()]
    if act == "deny":
        tc = str(tool_call_id or "").strip()
        if tc and tc not in ids:
            ids.insert(0, tc)
        if len(ids) > 1:
            return {"action": "deny", "tool_call_ids": ids, "tool_call_id": ids[0]}
        return {"action": "deny", "tool_call_id": ids[0]} if ids else {"action": "deny"}
    if act == "await_next":
        return {"action": "await_next"}
    if tool_call_id:
        tc = str(tool_call_id).strip()
        if tc and tc not in ids:
            ids.insert(0, tc)
    return {"action": "execute_approved", "tool_call_ids": ids}


def get_latest_checkpoint_id_for_thread(thread_id: str) -> str | None:
    """Best-effort checkpoint id for Command(resume) on an interrupted thread."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    try:
        from evoflow.agents.checkpointer.provider import get_checkpointer

        tup = get_checkpointer().get_tuple({"configurable": {"thread_id": tid}})
        if tup is None:
            return None
        cfg = tup.config if isinstance(tup.config, dict) else {}
        conf = cfg.get("configurable") if isinstance(cfg.get("configurable"), dict) else {}
        cid = str(conf.get("checkpoint_id") or "").strip()
        return cid or None
    except Exception:
        logger.debug("get_latest_checkpoint_id failed thread=%s", tid, exc_info=True)
        return None


def build_lead_run_config(
    *,
    session_key: str,
    thread_id: str,
    workspace_root: str | None = None,
    extra_configurable: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from evoflow.persistence.session_repositories import get_session_context_for_run_config
    from evoflow.runtime.long_run_limits import LONG_RUN_RECURSION_LIMIT

    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    ctx = get_session_context_for_run_config(sk) if sk else {}
    configurable: dict[str, Any] = {**ctx, "thread_id": tid, "session_key": sk}
    ws = str(workspace_root or ctx.get("local_workspace_root") or "").strip()
    if ws:
        configurable["local_workspace_root"] = ws
    if isinstance(extra_configurable, dict):
        configurable.update({k: v for k, v in extra_configurable.items() if v is not None})
    return {"recursion_limit": LONG_RUN_RECURSION_LIMIT, "configurable": configurable}


async def build_lead_run_config_async(
    *,
    session_key: str,
    thread_id: str,
    workspace_root: str | None = None,
    extra_configurable: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Thread-pool wrapper — avoid blocking the Gateway event loop on SQLite."""
    return await asyncio.to_thread(
        build_lead_run_config,
        session_key=session_key,
        thread_id=thread_id,
        workspace_root=workspace_root,
        extra_configurable=extra_configurable,
    )


async def _poll_latest_run_id(thread_id: str, *, attempts: int = 24, delay_s: float = 0.125) -> str | None:
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    try:
        from langgraph_sdk import get_client
    except ImportError:
        return None
    client = get_client(url=DEFAULT_LANGGRAPH_URL)
    for _ in range(max(1, attempts)):
        try:
            runs = await client.runs.list(tid, limit=1)
            items = runs if isinstance(runs, list) else getattr(runs, "data", None) or []
            if items:
                rid = str(getattr(items[0], "run_id", None) or items[0].get("run_id") or "").strip()
                if rid:
                    return rid
        except Exception:
            logger.debug("tool_approval resume: poll run_id failed thread=%s", tid, exc_info=True)
        await asyncio.sleep(delay_s)
    return None


async def _touch_run_started_after_poll(thread_id: str) -> None:
    """Best-effort run_id discovery — must not block the approval HTTP response."""
    run_id = await _poll_latest_run_id(thread_id)
    if not run_id:
        return
    try:
        from app.gateway.routers.langgraph_proxy import _touch_session_run_started

        await asyncio.to_thread(_touch_session_run_started, thread_id, run_id=run_id)
    except Exception:
        logger.debug("touch session run started failed thread=%s", thread_id, exc_info=True)


async def _start_background_stream_run(
    *,
    thread_id: str,
    session_key: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    from app.gateway.streaming.background_worker import StreamBackgroundWorker

    tid = str(thread_id or "").strip()
    sk = str(session_key or "").strip()
    if not tid:
        return {"started": False, "run_id": None, "error": "missing thread_id"}

    if not sk:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        sk = str(await asyncio.to_thread(find_session_key_by_thread_id, tid) or "").strip()

    encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
    worker, is_new = await StreamBackgroundWorker.get_or_create_with_langgraph(
        thread_id=tid,
        langgraph_path=f"threads/{tid}/runs/stream",
        request_method="POST",
        request_body=encoded,
        request_headers={
            "content-type": "application/json",
            "x-evoflow-stream-resume": "1",
        },
    )
    if is_new or not StreamBackgroundWorker.is_worker_running(tid):
        await worker.start()
        logger.info("tool_approval stream worker started thread=%s session=%s", tid, sk or "?")
    else:
        logger.info("tool_approval stream worker already running thread=%s", tid)

    asyncio.create_task(_touch_run_started_after_poll(tid))

    log_tool_approval_trace("后台流·worker启动", thread_id=tid, side="resume",
        event_data={"is_new": is_new, "worker_running": StreamBackgroundWorker.is_worker_running(tid),
                    "langgraph_base": DEFAULT_LANGGRAPH_URL,
                    "langgraph_path": f"threads/{tid}/runs/stream",
                    "request_method": "POST",
                    "body_size": len(encoded) if encoded else 0})
    return {
        "started": True,
        "run_id": None,
        "thread_id": tid,
        "session_key": sk or None,
        "stream_resume_recommended": True,
    }


async def trigger_tool_approval_replay_run(
    *,
    thread_id: str,
    session_key: str,
    replay_tool_call_ids: list[str],
    workspace_root: str | None = None,
) -> dict[str, Any]:
    """Execute approved tools via replay marker (graph ended at pending gate)."""
    from evoflow.agents.tool_approval_service import build_replay_message

    ids = [str(x).strip() for x in (replay_tool_call_ids or []) if str(x).strip()]
    if not ids:
        return {"started": False, "run_id": None, "error": "no replay ids"}
    marker = build_replay_message(ids)
    log_tool_approval_trace("replay_run·启动", thread_id=thread_id, side="resume",
        event_data={"replay_ids": ids, "session_key": session_key, "replay_marker": marker})
    run_config = await build_lead_run_config_async(
        session_key=session_key,
        thread_id=thread_id,
        workspace_root=workspace_root,
        # Belt-and-suspenders: survive SessionTranscriptHydration wiping the marker HumanMessage.
        extra_configurable={"tool_approval_replay_ids": ids},
    )
    # 诊断：确认 run_config 里的 thread_id / configurable 结构
    _cfg_diag = {}
    if isinstance(run_config, dict):
        _conf = run_config.get("configurable")
        if isinstance(_conf, dict):
            _cfg_diag = {k: (str(v)[:80] if v is not None else None)
                         for k, v in _conf.items()
                         if k in ("thread_id", "session_key", "local_workspace_root", "tool_approval_replay_ids")}
    log_tool_approval_trace("replay_run·config检查", thread_id=thread_id, side="resume",
        event_data={"configurable_keys": sorted(list(_cfg_diag.keys())) if _cfg_diag else [],
                    "configurable_snapshot": _cfg_diag})
    body = {
        "assistant_id": DEFAULT_ASSISTANT_ID,
        "input": {"messages": [{"role": "user", "content": marker}]},
        "config": run_config,
        "stream_mode": "messages-tuple",
        "multitask_strategy": "enqueue",
    }
    log_tool_approval_trace("replay_run·请求体构建完成", thread_id=thread_id, side="resume",
        event_data={"assistant_id": DEFAULT_ASSISTANT_ID,
                    "input_messages": 1,
                    "stream_mode": "messages-tuple",
                    "multitask_strategy": "enqueue"})
    return await _start_background_stream_run(
        thread_id=thread_id,
        session_key=session_key,
        body=body,
    )


async def trigger_tool_approval_deny_run(
    *,
    thread_id: str,
    session_key: str,
    tool_call_id: str,
    workspace_root: str | None = None,
    denied_tool_call_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Swap pending tool output to denied, then let the lead agent continue."""
    tc_id = str(tool_call_id or "").strip()
    deny_ids = [str(x).strip() for x in (denied_tool_call_ids or []) if str(x).strip()]
    if tc_id and tc_id not in deny_ids:
        deny_ids.insert(0, tc_id)
    if not deny_ids:
        return {"started": False, "run_id": None, "error": "missing tool_call_id"}
    log_tool_approval_trace(
        "用户拒绝：启动 deny 续跑 run",
        thread_id=thread_id,
        session_key=session_key,
        tool_call_id=deny_ids[0],
        event_data={"denied_ids": deny_ids},
    )
    run_config = await build_lead_run_config_async(
        session_key=session_key,
        thread_id=thread_id,
        workspace_root=workspace_root,
        extra_configurable={
            "tool_approval_deny_tool_call_id": deny_ids[0],
            "tool_approval_deny_tool_call_ids": deny_ids,
        },
    )
    body = {
        "assistant_id": DEFAULT_ASSISTANT_ID,
        "input": None,
        "config": run_config,
        "stream_mode": "messages-tuple",
        "multitask_strategy": "enqueue",
    }
    return await _start_background_stream_run(
        thread_id=thread_id,
        session_key=session_key,
        body=body,
    )


async def trigger_tool_approval_resume_inplace(
    *,
    thread_id: str,
    session_key: str,
    resume_payload: dict[str, Any],
    workspace_root: str | None = None,
) -> dict[str, Any]:
    """Resume the interrupted run on the active POST middle layer (same SSE)."""
    tid = str(thread_id or "").strip()
    sk = str(session_key or "").strip()
    if not tid:
        return {"started": False, "run_id": None, "error": "missing thread_id", "same_sse": False}

    log_tool_approval_trace("resume_inplace·开始", thread_id=tid, side="resume",
        event_data={"session_key": sk, "resume_payload": resume_payload})

    try:
        from app.gateway.streaming.stream_middle_layer import (
            get_active_middle_layer,
            resume_middle_layer_tool_approval,
        )

        layer = get_active_middle_layer(tid)
        run_id = str(layer.run_id or "").strip() if layer else ""
        log_tool_approval_trace("resume_inplace·middle_layer检查", thread_id=tid, side="resume",
            event_data={"layer_exists": layer is not None, "run_id": run_id})
        if layer is not None:
            # Browser SSE is still open: MUST resume on this layer.
            # Falling back to StreamBackgroundWorker would let the model keep
            # running while the UI stays stuck on pending_approval (orphan run).
            last_err: Exception | None = None
            for attempt in (1, 2):
                try:
                    logger.info(
                        "【工具授权·同SSE】resume 尝试 attempt=%s/%s thread=%s payload=%s",
                        attempt,
                        2,
                        tid,
                        resume_payload,
                    )
                    # 每个 attempt 加 8 秒超时保护，防止 middle layer 同步等待无限卡住 API 响应
                    ok = await asyncio.wait_for(
                        resume_middle_layer_tool_approval(
                            thread_id=tid,
                            resume_payload=resume_payload,
                            session_key=sk,
                            workspace_root=workspace_root,
                        ),
                        timeout=8.0,
                    )
                    if ok:
                        log_tool_approval_trace("resume_inplace·同SSE成功", thread_id=tid, side="resume",
                            event_data={"attempt": attempt, "run_id": run_id})
                        return {
                            "started": True,
                            "run_id": run_id or None,
                            "thread_id": tid,
                            "session_key": sk or None,
                            "stream_resume_recommended": False,
                            "same_sse": True,
                        }
                    log_tool_approval_trace("resume_inplace·同SSE失败", thread_id=tid, side="resume",
                        level=logging.WARNING, event_data={"attempt": attempt, "error": "resume returned False"})
                    logger.warning(
                        "【工具授权·同SSE】resume 返回失败（不回退后台流）attempt=%s thread=%s",
                        attempt,
                        tid,
                    )
                except asyncio.TimeoutError:
                    last_err = TimeoutError("middle layer resume timed out after 8s")
                    log_tool_approval_trace("resume_inplace·同SSE失败", thread_id=tid, side="resume",
                        level=logging.WARNING, event_data={"attempt": attempt, "error": "timeout"})
                    logger.warning(
                        "【工具授权·同SSE】resume 超时 attempt=%s/%s thread=%s — 回退到下一轮",
                        attempt,
                        2,
                        tid,
                    )
                except Exception as exc:
                    last_err = exc
                    log_tool_approval_trace("resume_inplace·同SSE失败", thread_id=tid, side="resume",
                        level=logging.WARNING, event_data={"attempt": attempt, "error": str(exc)})
                    logger.exception(
                        "【工具授权·同SSE】resume 异常 attempt=%s thread=%s",
                        attempt,
                        tid,
                    )
                if attempt < 2:
                    await asyncio.sleep(0.05)
            log_tool_approval_trace(
                "同 SSE resume：失败，回退后台流（避免死锁）",
                thread_id=tid,
                session_key=sk,
                run_id=run_id,
                error=str(last_err or "resume returned False"),
            )
            logger.warning(
                "【工具授权·同SSE】resume 2次失败，回退后台流 thread=%s error=%s",
                tid,
                str(last_err or "resume returned False"),
            )

        logger.warning(
            "【工具授权·同SSE】middle layer 不可用 thread=%s（POST SSE 可能已关闭），回退后台流",
            tid,
        )
    except Exception:
        logger.exception("tool approval inplace resume failed thread=%s", tid)

    log_tool_approval_trace("resume_inplace·回退后台流", thread_id=tid, side="resume",
        level=logging.WARNING, event_data={"reason": "middle_layer不可用或resume失败"})

    # 关键修复：middle layer 不存在时，原始 interrupted run 已经结束了，
    # Command(resume) 无处可恢复。必须改用 replay marker 启动新 run，
    # 让 ToolApprovalReplayMiddleware 执行已批准的工具。
    act = str((resume_payload or {}).get("action") or "").strip().lower()
    if act == "execute_approved":
        replay_ids = list((resume_payload or {}).get("tool_call_ids") or [])
        if replay_ids:
            log_tool_approval_trace("resume_inplace·改用replay_run启动新run", thread_id=tid, side="resume",
                event_data={"replay_ids": replay_ids, "reason": "middle_layer不存在，Command(resume)无效"})
            logger.info(
                "【工具授权·回退】middle layer 不存在，改用 replay_run 启动新 run thread=%s ids=%s",
                tid,
                replay_ids,
            )
            out = await trigger_tool_approval_replay_run(
                thread_id=tid,
                session_key=sk,
                replay_tool_call_ids=replay_ids,
                workspace_root=workspace_root,
            )
        else:
            log_tool_approval_trace("resume_inplace·replay_ids为空，无法恢复", thread_id=tid, side="resume",
                level=logging.ERROR, event_data={"reason": "execute_approved但无tool_call_ids"})
            out = {"started": False, "run_id": None, "error": "no replay ids", "same_sse": False}
    elif act == "deny":
        deny_tc = str((resume_payload or {}).get("tool_call_id") or "").strip()
        deny_ids = [
            str(x).strip()
            for x in ((resume_payload or {}).get("tool_call_ids") or [])
            if str(x).strip()
        ]
        if deny_tc and deny_tc not in deny_ids:
            deny_ids.insert(0, deny_tc)
        if deny_ids:
            log_tool_approval_trace("resume_inplace·改用deny_run启动新run", thread_id=tid, side="resume",
                event_data={"tool_call_id": deny_ids[0], "denied_ids": deny_ids, "reason": "middle_layer不存在"})
            out = await trigger_tool_approval_deny_run(
                thread_id=tid,
                session_key=sk,
                tool_call_id=deny_ids[0],
                denied_tool_call_ids=deny_ids,
                workspace_root=workspace_root,
            )
        else:
            out = {"started": False, "run_id": None, "error": "deny without tool_call_id", "same_sse": False}
    else:
        # await_next 或其他：不应该走到这里，但兜底用 legacy 方式
        log_tool_approval_trace("resume_inplace·未知action，用legacy恢复", thread_id=tid, side="resume",
            level=logging.WARNING, event_data={"action": act})
        out = await trigger_tool_approval_resume(
            thread_id=tid,
            session_key=sk,
            resume_payload=resume_payload,
            workspace_root=workspace_root,
        )
    out["same_sse"] = False
    return out


async def trigger_tool_approval_resume(
    *,
    thread_id: str,
    session_key: str,
    resume_payload: dict[str, Any],
    workspace_root: str | None = None,
) -> dict[str, Any]:
    """Legacy background stream resume when no active middle layer exists."""
    tid = str(thread_id or "").strip()
    sk = str(session_key or "").strip()
    if not tid:
        return {"started": False, "run_id": None, "error": "missing thread_id"}

    log_tool_approval_trace("resume·legacy后台流启动", thread_id=tid, side="resume",
        event_data={"session_key": sk})
    run_config = await build_lead_run_config_async(session_key=sk, thread_id=tid, workspace_root=workspace_root)
    body = _build_resume_stream_body(
        resume_payload=resume_payload,
        run_config=run_config,
        thread_id=tid,
    )
    return await _start_background_stream_run(thread_id=tid, session_key=sk, body=body)


def _build_resume_stream_body(
    *,
    resume_payload: dict[str, Any],
    run_config: dict[str, Any],
    thread_id: str,
) -> dict[str, Any]:
    """LangGraph POST body for tool-approval Command(resume) on same thread."""
    config = dict(run_config) if isinstance(run_config, dict) else {}
    configurable = dict(config.get("configurable") or {})
    cid = get_latest_checkpoint_id_for_thread(thread_id)
    if cid:
        configurable["checkpoint_id"] = cid
    config["configurable"] = configurable
    return {
        "assistant_id": DEFAULT_ASSISTANT_ID,
        "input": None,
        "command": {"resume": resume_payload or {}},
        "config": config,
        "stream_mode": ["messages-tuple", "values", "custom"],
        "multitask_strategy": "enqueue",
    }


__all__ = [
    "build_lead_run_config",
    "build_lead_run_config_async",
    "build_tool_approval_resume_payload",
    "get_latest_checkpoint_id_for_thread",
    "trigger_tool_approval_deny_run",
    "trigger_tool_approval_replay_run",
    "trigger_tool_approval_resume",
    "trigger_tool_approval_resume_inplace",
]
