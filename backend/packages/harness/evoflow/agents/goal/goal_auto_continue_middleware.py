"""Single-run hosted goal: after each agent turn, auto-continue inside one lead_agent run."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import hook_config
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime

from evoflow.agents.goal.goal_reply_interpreter import (
    GoalReplyVerdict,
    interpret_goal_reply_async,
    interpret_goal_reply_sync,
)
from evoflow.agents.goal.goal_runtime import (
    build_continue_nudge,
    clip_goal_summary_text,
    goal_active,
    goal_mode_from_runtime,
    load_goal_row,
    patch_goal_state,
    resolve_session_key,
    runtime_context_dict,
    set_pending_goal_nudge,
)
from evoflow.agents.goal.goal_state import GOAL_CONTROLLER_SOURCE, GOAL_SYNTHETIC_USER_NAME
from evoflow.agents.goal.goal_trace_log import format_goal_state_patch, log_goal_trace
from evoflow.agents.middlewares.transcript_middleware import TranscriptMiddleware

logger = logging.getLogger(__name__)

# 判定器连续 fallback 硬熔断阈值：达到后暂停 Goal，避免判定模型挂掉时
# 一直续跑到 max_steps 烧 token。与 goal_reply_interpreter._FALLBACK_MAX_STREAK
# 对齐（interpreter 内部是 3 次仍 continue，这里 3 次后直接熔断暂停）。
_FALLBACK_HARD_LIMIT = 3


def _text_from_ai(msg: AIMessage) -> str:
    content = getattr(msg, "content", "") or ""
    if isinstance(content, str):
        return content.strip()
    return str(content).strip()


def _count_goal_turns(messages: list[Any]) -> int:
    """Count goal intervention turns (synthetic user injections only).

    The user's initial goal message is NOT counted — max_steps limits how many
    times the judge intervenes to continue the goal, not the total conversation
    turns. So we only count synthetic user messages.

    - synth=0: first turn (user sent goal, AI replied) → turn_no=1 (first AI reply)
    - synth=1: judge injected 1st nudge, AI replied → turn_no=2
    - synth=N: judge injected Nth nudge, AI replied → turn_no=N+1

    max_steps check uses ``turn_no > max_steps`` (not ``>=``) so that
    max_steps=8 allows exactly 8 AI replies (7 interventions + 1 initial).
    """
    synth = 0
    for msg in messages or []:
        if isinstance(msg, HumanMessage):
            name = str(getattr(msg, "name", "") or "").strip()
            if name == GOAL_SYNTHETIC_USER_NAME:
                synth += 1
    return max(1, synth + 1)


def _last_ai(messages: list[Any]) -> AIMessage | None:
    for msg in reversed(messages or []):
        if isinstance(msg, AIMessage):
            return msg
    return None


def _synthetic_continue_message(text: str) -> HumanMessage:
    return HumanMessage(
        content=text,
        name=GOAL_SYNTHETIC_USER_NAME,
        additional_kwargs={
            "internal": True,
            "source": GOAL_CONTROLLER_SOURCE,
            "synthetic": True,
            "visibility": "internal",
        },
    )


def _flush_assistant_transcript(state: AgentState, runtime: Runtime) -> None:
    try:
        TranscriptMiddleware.flush_messages_now(state, runtime)
    except Exception:
        logger.debug("goal auto-continue transcript flush failed", exc_info=True)


def _runtime_configurable(runtime: Runtime) -> dict[str, Any]:
    ctx = runtime_context_dict(runtime)
    try:
        from langgraph.config import get_config

        cfg = get_config()
        conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
        merged = dict(conf) if isinstance(conf, dict) else {}
        merged.update({k: v for k, v in ctx.items() if v is not None})
        return merged
    except Exception:
        return dict(ctx)


class GoalAutoContinueMiddleware(AgentMiddleware[AgentState]):
    """When goal mode is active, loop model turns until complete / wait / cap."""

    @override
    @hook_config(can_jump_to=["model", "end"])
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._apply_sync(state, runtime)

    @override
    @hook_config(can_jump_to=["model", "end"])
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        result = await self._apply_async(state, runtime)
        # #5: step_delay_ms — 仅在续跑（jump_to=model）时延迟，避免阻塞终止分支
        if result and result.get("jump_to") == "model":
            sk = resolve_session_key(runtime)
            if sk:
                row = load_goal_row(sk)
                if row:
                    delay_ms = int(row.get("step_delay_ms") or 0)
                    if delay_ms > 0:
                        await asyncio.sleep(delay_ms / 1000.0)
        return result

    def _apply_sync(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        ctx = self._prepare_turn(state, runtime)
        if ctx is None or ctx.get("early"):
            return ctx.get("result") if ctx else None
        # 问题③: 判定前写 paused，让前端能看到「目标判断中」
        patch_goal_state(str(ctx["session_key"]), status="paused", step_count=int(ctx["turn_no"]))
        verdict = interpret_goal_reply_sync(
            goal_text=str(ctx["goal_text"]),
            assistant_reply=str(ctx["reply"]),
            turn_no=int(ctx["turn_no"]),
            max_steps=int(ctx["max_steps"]),
            configurable=ctx["configurable"],
        )
        # 判定后重新读 SQLite，如果已写终态则不覆盖
        fresh_row = load_goal_row(str(ctx["session_key"]))
        if fresh_row and not goal_active(fresh_row):
            log_goal_trace(
                "判定后-已终态-跳过",
                session_key=str(ctx["session_key"]),
                turn_no=int(ctx["turn_no"]),
                max_steps=int(ctx["max_steps"]),
                goal_text=str(ctx["goal_text"]),
                judgment=f"interpreter verdict={verdict.verdict} 但 SQLite 已终态，跳过",
                decision="已写入终态，判定器结果不覆盖",
            )
            return None
        return self._finish_from_verdict(
            session_key=str(ctx["session_key"]),
            goal_text=str(ctx["goal_text"]),
            max_steps=int(ctx["max_steps"]),
            turn_no=int(ctx["turn_no"]),
            reply=str(ctx["reply"]),
            row=ctx["row"],
            verdict=verdict,
        )

    async def _apply_async(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        ctx = self._prepare_turn(state, runtime)
        if ctx is None or ctx.get("early"):
            return ctx.get("result") if ctx else None
        # 问题③: 判定前写 paused，让前端能看到「目标判断中」
        patch_goal_state(str(ctx["session_key"]), status="paused", step_count=int(ctx["turn_no"]))
        verdict = await interpret_goal_reply_async(
            goal_text=str(ctx["goal_text"]),
            assistant_reply=str(ctx["reply"]),
            turn_no=int(ctx["turn_no"]),
            max_steps=int(ctx["max_steps"]),
            configurable=ctx["configurable"],
        )
        # 判定后重新读 SQLite，如果已写终态则不覆盖
        fresh_row = load_goal_row(str(ctx["session_key"]))
        if fresh_row and not goal_active(fresh_row):
            log_goal_trace(
                "判定后-已终态-跳过",
                session_key=str(ctx["session_key"]),
                turn_no=int(ctx["turn_no"]),
                max_steps=int(ctx["max_steps"]),
                goal_text=str(ctx["goal_text"]),
                judgment=f"interpreter verdict={verdict.verdict} 但 SQLite 已终态，跳过",
                decision="已写入终态，判定器结果不覆盖",
            )
            return None
        return self._finish_from_verdict(
            session_key=str(ctx["session_key"]),
            goal_text=str(ctx["goal_text"]),
            max_steps=int(ctx["max_steps"]),
            turn_no=int(ctx["turn_no"]),
            reply=str(ctx["reply"]),
            row=ctx["row"],
            verdict=verdict,
        )

    def _prepare_turn(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        session_key = resolve_session_key(runtime)
        goal_mode = goal_mode_from_runtime(runtime)
        if not goal_mode:
            row_peek = load_goal_row(session_key) if session_key else None
            if row_peek:
                log_goal_trace(
                    "一轮结束-未参与",
                    session_key=session_key,
                    goal_text=str(row_peek.get("prompt") or ""),
                    decision=(
                        "goal_mode 未生效"
                        f"（db_status={row_peek.get('status')} goal_status={row_peek.get('goal_status')}）"
                    ),
                )
            return None

        row = load_goal_row(session_key)
        if not row:
            log_goal_trace(
                "一轮结束-未参与",
                session_key=session_key,
                decision="未找到已启用的托管 Goal 会话（SQLite）",
                reason="enabled=0 或 session_key 未绑定",
            )
            return None

        goal_text = str(row.get("prompt") or "").strip()
        max_steps = int(row.get("max_steps") or 50)
        db_status = str(row.get("status") or "").strip().lower()
        goal_status = str(row.get("goal_status") or "").strip().lower()

        if not goal_active(row):
            log_goal_trace(
                "一轮结束-未参与",
                session_key=session_key,
                max_steps=max_steps,
                goal_text=goal_text,
                decision="Goal 非 active 或已 suppress",
                goal_status=goal_status,
                db_status=db_status,
                continuation_suppressed=bool(row.get("continuation_suppressed")),
            )
            return None

        if db_status == "idle":
            log_goal_trace(
                "一轮结束-已停止续跑",
                session_key=session_key,
                max_steps=max_steps,
                goal_text=goal_text,
                decision="会话状态 idle，Goal 已结束",
                db_status=db_status,
            )
            return None

        if db_status == "waiting" and bool(row.get("pending_feedback")):
            log_goal_trace(
                "一轮结束-已停止续跑",
                session_key=session_key,
                max_steps=max_steps,
                goal_text=goal_text,
                decision="等待用户反馈（pending_feedback）",
                db_status=db_status,
            )
            return None

        _flush_assistant_transcript(state, runtime)

        auto_stop_minutes = int(row.get("auto_stop_minutes") or 0)
        start_time_ms = int(row.get("start_time") or 0)
        if auto_stop_minutes > 0 and start_time_ms > 0:
            elapsed_ms = int(time.time() * 1000) - start_time_ms
            if elapsed_ms > auto_stop_minutes * 60_000:
                patch_goal_state(
                    session_key,
                    goal_status="completed",
                    status="idle",
                    step_count=int(row.get("step_count") or 0),
                    last_error=f"定时停止：已运行 {auto_stop_minutes} 分钟",
                    ended_at=int(time.time() * 1000),
                    completion_outcome="定时停止",
                    goal_summary=f"定时停止：已运行 {auto_stop_minutes} 分钟，目标自动结束",
                )
                log_goal_trace(
                    "一轮结束-定时停止",
                    session_key=session_key,
                    turn_no=int(row.get("step_count") or 0),
                    max_steps=max_steps,
                    goal_text=goal_text,
                    judgment=f"auto_stop_minutes={auto_stop_minutes} 已超时（elapsed={elapsed_ms // 1000}s）",
                    decision="定时停止，结束 Goal",
                    action="jump_to=end",
                    state_patch=format_goal_state_patch(
                        goal_status="completed", status="idle", last_error="定时停止"
                    ),
                )
                return {"early": True, "result": {"jump_to": "end"}}

        messages = list(state.get("messages") or [])
        db_step = int(row.get("step_count") or 0)
        # turn_no = 当前 AI 回复轮次（从 1 开始）。
        # 首轮（用户发目标 → AI 回复）turn_no=1；判定器续跑注入 nudge 后 turn_no 递增。
        # max_steps 检查用 turn_no > max_steps（非 >=），确保 max_steps=8 时第 8 轮仍可正常判定。
        # 任意一轮判定器判定 complete 即立即结束，不强制跑满 max_steps。
        turn_no = max(_count_goal_turns(messages), db_step if db_step > 0 else 0, 1)

        # 防泄漏：目标已完成后的普通对话不应被判定器误触发。
        # 如果本轮 messages 中没有 synthetic user（即用户手动发的新消息），
        # 且 goal_status 虽然是 active 但 status 不是 running/waiting（说明目标可能已完成但 SQLite 写入失败），
        # 则不参与判定，避免对普通对话注入 synthetic user 续跑。
        has_synth = any(
            isinstance(msg, HumanMessage)
            and str(getattr(msg, "name", "") or "").strip() == GOAL_SYNTHETIC_USER_NAME
            for msg in messages
        )
        if not has_synth and db_status not in {"running", "waiting"}:
            log_goal_trace(
                "一轮结束-普通对话不参与判定",
                session_key=session_key,
                turn_no=turn_no,
                max_steps=max_steps,
                goal_text=goal_text,
                decision="本轮无 synthetic user 且 status 非 running/waiting，视为普通对话",
                db_status=db_status,
                goal_status=goal_status,
            )
            return None

        last_ai = _last_ai(messages)

        if last_ai is None:
            log_goal_trace(
                "一轮结束-跳过",
                session_key=session_key,
                turn_no=turn_no,
                max_steps=max_steps,
                goal_text=goal_text,
                decision="无助手消息，无法判定",
            )
            return None

        if getattr(last_ai, "tool_calls", None):
            tool_names = [
                str(getattr(tc, "name", None) or (tc.get("name") if isinstance(tc, dict) else "") or "").strip()
                for tc in (last_ai.tool_calls or [])
            ]
            tool_names = [n for n in tool_names if n]
            log_goal_trace(
                "一轮结束-等待工具",
                session_key=session_key,
                turn_no=turn_no,
                max_steps=max_steps,
                goal_text=goal_text,
                decision="助手已发起工具调用，本轮不续跑",
                tools=",".join(tool_names) if tool_names else "（未知）",
            )
            return None

        reply = _text_from_ai(last_ai)

        if not reply:
            cur_error_count = int(row.get("error_count") or 0) + 1
            retry_limit = int(row.get("retry_limit") or 0)
            if retry_limit > 0 and cur_error_count <= retry_limit:
                patch_goal_state(
                    session_key,
                    status="running",
                    step_count=turn_no,
                    error_count=cur_error_count,
                    last_error=f"模型空回复（第 {cur_error_count}/{retry_limit} 次重试）",
                )
                nudge = build_continue_nudge(
                    goal_text=goal_text,
                    turn_no=turn_no + 1,
                    max_steps=max_steps,
                    initiative=int(row.get("initiative") or 60),
                )
                log_goal_trace(
                    "一轮结束-空回复重试",
                    session_key=session_key,
                    turn_no=turn_no,
                    max_steps=max_steps,
                    goal_text=goal_text,
                    assistant_output=reply,
                    judgment=f"助手正文为空，error_count={cur_error_count}/{retry_limit}，继续重试",
                    decision="空回复但未超重试上限，注入 synthetic user 继续",
                    action="jump_to=model",
                    nudge_input=nudge,
                    state_patch=format_goal_state_patch(
                        status="running", step_count=turn_no, error_count=cur_error_count
                    ),
                )
                set_pending_goal_nudge(session_key, nudge)
                return {
                    "early": True,
                    "result": {
                        "jump_to": "model",
                    },
                }
            patch_goal_state(
                session_key,
                status="paused",
                step_count=turn_no,
                last_error="模型空回复，已停止自动续跑",
                error_count=cur_error_count,
            )
            log_goal_trace(
                "一轮结束-空回复停止",
                session_key=session_key,
                turn_no=turn_no,
                max_steps=max_steps,
                goal_text=goal_text,
                assistant_output=reply,
                judgment="助手正文为空",
                decision="无正文且无 tool_calls，停止续跑避免空消息落库",
                action="jump_to=end",
                state_patch=format_goal_state_patch(
                    status="paused", step_count=turn_no, last_error="模型空回复"
                ),
            )
            return {"early": True, "result": {"jump_to": "end"}}

        return {
            "session_key": session_key,
            "goal_text": goal_text,
            "max_steps": max_steps,
            "turn_no": turn_no,
            "reply": reply,
            "row": row,
            "configurable": {
                **_runtime_configurable(runtime),
                "interpreter_fallback_streak": int(row.get("interpreter_fallback_streak") or 0),
            },
        }

    def _finish_from_verdict(
        self,
        *,
        session_key: str,
        goal_text: str,
        max_steps: int,
        turn_no: int,
        reply: str,
        row: dict[str, Any],
        verdict: GoalReplyVerdict,
    ) -> dict[str, Any] | None:
        judgment = (
            f"interpreter verdict={verdict.verdict}"
            + (f" reason={verdict.reason}" if verdict.reason else "")
        )

        if verdict.verdict == "complete":
            complete_summary = clip_goal_summary_text(verdict.summary or reply or "任务完成")
            patch_goal_state(
                session_key,
                goal_status="completed",
                status="idle",
                step_count=turn_no,
                ended_at=int(time.time() * 1000),
                completion_outcome="任务完成",
                goal_summary=complete_summary,
            )
            try:
                from evoflow.memory.episodes import record_goal_episode

                record_goal_episode(
                    session_key=session_key,
                    goal_text=goal_text,
                    summary=complete_summary,
                    outcome="completed",
                )
            except Exception:
                logger.debug("goal complete → memory episode skipped", exc_info=True)
            # 主动更新 session 表 run_status — 判定器认定完成时立即写 terminal，
            # 不依赖流结束兜底（避免时间窗口内 session 仍显示"运行中"）。
            try:
                from evoflow.session_execution.lifecycle import force_end_session_turn

                force_end_session_turn(
                    session_key=session_key,
                    source="goal_auto_continue_complete",
                    reason="completed",
                )
            except Exception:
                logger.debug(
                    "goal auto-continue complete: force_end_session_turn failed sk=%s",
                    session_key,
                    exc_info=True,
                )
            log_goal_trace(
                "一轮结束-目标完成",
                session_key=session_key,
                turn_no=turn_no,
                max_steps=max_steps,
                goal_text=goal_text,
                assistant_output=reply,
                judgment=judgment,
                decision="判定器认定目标已完成，结束 run",
                action="jump_to=end",
                state_patch=format_goal_state_patch(
                    goal_status="completed", status="idle", step_count=turn_no
                ),
            )
            return {"jump_to": "end"}

        if turn_no > max_steps:
            patch_goal_state(
                session_key,
                goal_status="completed",
                status="idle",
                step_count=turn_no,
                last_error=f"达到最大步数 {max_steps}",
                ended_at=int(time.time() * 1000),
                completion_outcome="达到步数上限",
                goal_summary=f"已达到最大步数 {max_steps}，目标自动结束 · 共 {turn_no} 轮",
            )
            log_goal_trace(
                "一轮结束-达到步数上限",
                session_key=session_key,
                turn_no=turn_no,
                max_steps=max_steps,
                goal_text=goal_text,
                assistant_output=reply,
                judgment=f"turn_no={turn_no} >= max_steps={max_steps}",
                decision="强制结束 Goal",
                action="jump_to=end",
                state_patch=format_goal_state_patch(
                    goal_status="completed", status="idle", step_count=turn_no
                ),
            )
            return {"jump_to": "end"}

        # 问题①: 判定成功时重置 fallback streak；fallback 时递增
        if verdict.reason and "interpreter_failed" in verdict.reason:
            cur_streak = int(row.get("interpreter_fallback_streak") or 0) + 1
            patch_goal_state(session_key, status="running", step_count=turn_no, interpreter_fallback_streak=cur_streak)
        else:
            cur_streak = 0
            patch_goal_state(session_key, status="running", step_count=turn_no, interpreter_fallback_streak=0)

        # 硬熔断：连续 fallback 达到上限，暂停目标避免判定模型挂了时一直续跑烧 token
        if cur_streak >= _FALLBACK_HARD_LIMIT:
            patch_goal_state(
                session_key,
                goal_status="paused",
                status="paused",
                step_count=turn_no,
                last_error=f"判定器连续失败 {cur_streak} 次，已暂停自动续跑",
                interpreter_fallback_streak=cur_streak,
            )
            log_goal_trace(
                "一轮结束-判定器熔断",
                session_key=session_key,
                turn_no=turn_no,
                max_steps=max_steps,
                goal_text=goal_text,
                assistant_output=reply,
                judgment=f"interpreter_fallback_streak={cur_streak} >= {_FALLBACK_HARD_LIMIT}",
                decision="判定器连续失败达到硬上限，暂停 Goal，等待用户介入",
                action="jump_to=end",
                state_patch=format_goal_state_patch(
                    goal_status="paused", status="paused", step_count=turn_no,
                    interpreter_fallback_streak=cur_streak, last_error="判定器熔断",
                ),
            )
            return {"jump_to": "end"}

        initiative = int(row.get("initiative") or 60)
        nudge = build_continue_nudge(goal_text=goal_text, turn_no=turn_no + 1, max_steps=max_steps, initiative=initiative)
        log_goal_trace(
            "一轮结束-自动续跑",
            session_key=session_key,
            turn_no=turn_no,
            max_steps=max_steps,
            goal_text=goal_text,
            assistant_output=reply,
            judgment=judgment,
            decision=f"判定器认定继续推进，注入第 {turn_no + 1} 轮 synthetic user",
            action="jump_to=model",
            nudge_input=nudge,
            state_patch=format_goal_state_patch(status="running", step_count=turn_no),
        )
        set_pending_goal_nudge(session_key, nudge)
        return {
            "jump_to": "model",
        }
