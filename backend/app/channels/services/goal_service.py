import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Optional

from langgraph_sdk.client import LangGraphClient

from app.channels.models.goal import (
    GoalChannelType,
    GoalConfig,
    GoalHistoryItem,
    GoalHistoryRole,
    GoalSession,
    GoalStatus,
)
from app.channels.services.goal_context_compressor import (
    GoalContextCompressor,
    compress_goal_history,
)
from evoflow.agents.goal.goal_trace_log import log_goal_trace
from evoflow.config import get_app_config
from evoflow.langgraph_run_config import (
    default_langgraph_thread_metadata,
    ensure_langgraph_thread_exists,
    json_safe_run_dict,
    merge_configurable_into_context,
)
from evoflow.models import create_chat_model
from evoflow.persistence.session_context_fields import agent_id_from_session_key
from evoflow.utils.model_context_length import resolve_model_context_length

# Default LangGraph graph ids (``langgraph.json``); keep in sync with gateway / ChannelManager.
_GOAL_LEAD_ASSISTANT_ID = "lead_agent"
_GOAL_GRAPH_ASSISTANT_ID = "goal_agent"
_GOAL_RUN_CONFIG: dict[str, Any] = {"recursion_limit": 100}
_GOAL_RUN_CONTEXT_BASE: dict[str, Any] = {
    "session_mode": "flash",
    "thinking_enabled": False,
    "reasoning_effort": "minimum",
    "is_plan_mode": False,
    "subagent_enabled": False,
}

# -------------------------- 资源限制配置 --------------------------
MAX_CONCURRENT_GOALS = 10  # 全局最多同时运行10个托管任务
# 单用户最多同时运行5个托管任务（1c：从 1 提升到 5，支持多窗口并行托管）
MAX_USER_CONCURRENT_GOALS = 5
# 单任务最长墙钟时间（含等待用户）；长任务允许 7×24 小时
_MAX_RUN_HOURS = 7 * 24
MAX_RUN_MINUTES = _MAX_RUN_HOURS * 60  # 10080
PUSH_RETRY_TIMES = 2  # 消息推送失败重试次数
PUSH_RETRY_INTERVAL = 1  # 推送重试间隔秒数
# 等待用户澄清/反馈：与 MAX_RUN 对齐，避免长跑任务因用户暂时离线被误杀
CLARIFICATION_TIMEOUT_MINUTES = MAX_RUN_MINUTES

# -------------------------- 全局状态锁 --------------------------
global_lock = asyncio.Lock()
task_locks: dict[str, asyncio.Lock] = {}
global_running_count: int = 0
user_running_counts: dict[str, int] = {}

logger = logging.getLogger(__name__)

# 目标系统提示词，和前端保持一致
HOSTED_SYSTEM_PROMPT = """你是一个目标调度Agent。你的职责是：根据用户设定的目标，持续引导EvoFlow AI Agent完成任务。
规则：
1. 你每一轮只输出一条简洁的指令（1-3句话），发给EvoFlow执行
2. 根据EvoFlow的回复评估进展，决定下一步指令
""" + (
    "3. 如果任务已完成或无法继续，输出 <completed>完成原因</completed> 来结束循环，不要输出其他内容。"
    "<completed> 标签是唯一的结束信号——系统检测到该标签后会立即终止目标调度。"
    "仅在以下情况使用：(a) 至少完成一轮 EvoFlow 执行后，用户目标已完全达成；"
    "(b) 任务确实无法继续（如 EvoFlow 连续多次失败且无其他可行路径）。"
    "严禁在以下情况使用：新一轮目标的首轮调度（step=0）、任务仍在进行中、"
    "下一步指令尚未发出、你只是暂时卡住或需要换一种方式尝试。误用会导致目标被意外终止。\n"
    "4. 不要重复相同的指令，不要输出解释性文字，只输出下一步要执行的指令\n"
)




class GoalService:
    """托管核心调度服务"""

    _instance: Optional["GoalService"] = None

    def __init__(self, langgraph_client: LangGraphClient):
        self.client = langgraph_client
        # 托管会话存储，key为会话ID
        self._sessions: dict[str, GoalSession] = {}
        # 托管历史存储，key为会话ID，value为历史列表
        self._histories: dict[str, list[GoalHistoryItem]] = {}
        # 运行中的任务，key为会话ID，value为asyncio.Task
        self._running_tasks: dict[str, asyncio.Task] = {}
        # 调度循环在后台 task；Web 面板通过 /api/hosted/by-key 轮询状态
        self._hosted_loop_tasks: dict[str, asyncio.Task] = {}
        self._web_goal_continue_tasks: dict[str, asyncio.Task] = {}
        self._run_slot_held: set[str] = set()
        self._context_compressor = GoalContextCompressor()

    @classmethod
    def get_instance(cls, langgraph_client: LangGraphClient | None = None) -> "GoalService":
        """单例模式获取实例"""
        if cls._instance is None:
            if langgraph_client is None:
                raise ValueError("langgraph_client is required for first initialization")
            cls._instance = GoalService(langgraph_client)
        return cls._instance

    @staticmethod
    def _hosted_now_str() -> str:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())

    def _hosted_step_label(self, session: GoalSession, *, round_no: int | None = None) -> str:
        idx = max(1, int(round_no if round_no is not None else session.current_step + 1))
        return f"第{idx}/{max(1, session.config.max_steps)}步"

    def _hosted_op_log(
        self,
        event: str,
        session: GoalSession | None = None,
        *,
        level: int = logging.INFO,
        round_no: int | None = None,
        elapsed_s: float | None = None,
        **fields: Any,
    ) -> None:
        """托管操作日志：时间 | 事件 | 会话 | 第几步 | 附加字段。"""
        parts: list[str] = [self._hosted_now_str(), "hosted", event]
        if session is not None:
            parts.append(f"id={session.id}")
            sk = str(session.associated_session_key or "").strip()
            if sk:
                parts.append(f"sk={sk}")
            parts.append(self._hosted_step_label(session, round_no=round_no))
        extras: list[str] = []
        if elapsed_s is not None:
            extras.append(f"elapsed={elapsed_s:.2f}s")
        for key, val in fields.items():
            if val is None or val == "":
                continue
            text = str(val).replace("\n", " ").strip()
            if len(text) > 160:
                text = text[:160] + "…"
            extras.append(f"{key}={text}")
        msg = " | ".join(parts)
        if extras:
            msg = f"{msg} | {' | '.join(extras)}"
        logger.log(level, msg, exc_info=level >= logging.ERROR)

    def _build_system_prompt(self, config: GoalConfig, user_goal: str) -> str:
        """构建托管系统提示词，包含主动性等配置"""
        initiative_rule = "主动性高：可主动补全缺失信息并给出明确下一步。" if config.initiative >= 80 else "主动性中等：优先跟随目标，必要时给出1条关键建议。" if config.initiative >= 50 else "主动性保守：避免过多发散，先按用户目标执行。"

        emotion_rule = "启用情绪智能：根据上下文调整语气，避免冒犯与压力式措辞。" if config.emotional_intelligence else "关闭情绪智能：保持中性执行语气。"

        return "\n".join(
            [
                HOSTED_SYSTEM_PROMPT,
                "",
                f"主动性：{config.initiative}%（{initiative_rule}）",
                emotion_rule,
                "",
                f"用户目标: {user_goal}",
            ]
        )

    @staticmethod
    def _resolve_planner_model_name() -> str | None:
        """Fallback planner model (primary / first configured)."""
        config = get_app_config()
        primary = (config.primary_model or "").strip()
        if primary and config.get_model_config(primary) is not None:
            return primary
        if config.models:
            return config.models[0].name
        return None

    def _resolve_planner_model_name_for_session(self, session: GoalSession) -> str | None:
        """Planner model: prefer bound chat session ``model_name``, else global primary."""
        sk = str(session.associated_session_key or "").strip()
        if sk:
            try:
                from evoflow.persistence.session_repositories import get_session_row_for_ui

                row = get_session_row_for_ui(sk) or {}
                name = str(row.get("model_name") or row.get("modelName") or "").strip()
                if name:
                    config = get_app_config()
                    if config.get_model_config(name) is not None:
                        return name
            except Exception:
                logger.debug("hosted: resolve session model failed sk=%s", sk, exc_info=True)
        return self._resolve_planner_model_name()

    def _planner_context_length(self, session: GoalSession | None = None) -> tuple[str | None, int]:
        name = self._resolve_planner_model_name_for_session(session) if session else self._resolve_planner_model_name()
        return name, resolve_model_context_length(name)

    def _load_hosted_db_row(self, session: GoalSession) -> dict[str, Any] | None:
        sk = str(session.associated_session_key or "").strip()
        if not sk:
            return None
        try:
            from evoflow.persistence import goal_repositories as goal_repo

            row = goal_repo.load_goal_session(sk)
        except Exception:
            logger.debug("hosted: load db row failed sk=%s", sk, exc_info=True)
            return None
        return row if isinstance(row, dict) else None

    def _sync_session_from_hosted_db(self, session: GoalSession) -> dict[str, Any] | None:
        row = self._load_hosted_db_row(session)
        if row:
            self._apply_goal_db_row(session, row)
        return row

    async def _interpret_goal_text_reply(
        self,
        session: GoalSession,
        reply: str,
        *,
        turn_no: int | None = None,
    ):
        from evoflow.agents.goal.goal_reply_interpreter import interpret_goal_reply_async

        turn = max(int(turn_no if turn_no is not None else session.current_step or 0), 1)
        model_name = self._resolve_planner_model_name_for_session(session)
        configurable: dict[str, Any] = {}
        if model_name:
            configurable["planner_model_name"] = model_name
            configurable["model_name"] = model_name
        return await interpret_goal_reply_async(
            goal_text=session.config.prompt,
            assistant_reply=reply,
            turn_no=turn,
            max_steps=int(session.config.max_steps or 50),
            configurable=configurable,
        )

    async def _apply_goal_reply_verdict(
        self,
        session: GoalSession,
        reply: str,
        verdict: Any,
    ) -> str | None:
        """Apply interpreter verdict to in-memory session (+ DB when needed). Returns completion outcome."""
        from evoflow.agents.goal.goal_runtime import clip_goal_summary_text

        if verdict.verdict == "complete":
            hint = clip_goal_summary_text(verdict.summary or verdict.reason or reply or "")
            await self._finalize_goal_completion(session, completion_hint=hint)
            return "任务完成"
        if str(session.goal_status or "") == "active":
            session.status = GoalStatus.PAUSED
        return None

    async def _ensure_completed_session_finalized(self, session: GoalSession, *, reply: str = "") -> None:
        """When SQLite/middleware already marked completed, ensure panel has summary + slot released."""
        if str(session.goal_status or "").strip().lower() not in {"completed", "cleared"}:
            return
        if str(session.goal_summary or "").strip():
            await self._release_run_slot(session)
            return
        hint = str(reply or "").strip()
        await self._finalize_goal_completion(session, completion_hint=hint)

    async def _finalize_goal_completion(
        self,
        session: GoalSession,
        *,
        completion_hint: str = "",
    ) -> None:
        """统一处理目标完成：设置状态、持久化、推送。

        汇报来源优先级（唯一来源，不再二次调用 LLM）：
        1. session.goal_summary — 主AI 通过 goal_report(complete, summary=...) 已写入
        2. completion_hint — 判定器 verdict.summary 或回复正文（fallback）
        3. 默认占位文本
        """
        from evoflow.persistence import goal_repositories as goal_repo

        from evoflow.agents.goal.goal_runtime import clip_goal_summary_text

        outcome = "任务完成"
        sk = str(session.associated_session_key or "").strip()

        # 先从 SQLite 刷新内存 session，获取中间件已写入的 goal_summary
        if sk:
            try:
                row = goal_repo.load_goal_session(sk)
                if row:
                    self._apply_goal_db_row(session, row)
            except Exception:
                logger.debug("hosted: _finalize refresh from db failed sk=%s", sk, exc_info=True)

        # 确定完成汇报内容（主AI summary > hint > 默认占位）
        summary = clip_goal_summary_text(session.goal_summary or "")
        if not summary:
            summary = clip_goal_summary_text(completion_hint or "")
        if not summary:
            summary = f"目标任务已结束 · 共 {session.current_step} 轮"

        session.goal_status = "completed"
        session.status = GoalStatus.IDLE
        session.ended_at = time.time()
        session.completion_outcome = outcome
        session.goal_summary = summary
        await self._release_run_slot(session)

        # 持久化 + 广播完成状态（一次到位，带完整 summary）
        if sk:
            goal_repo.patch_goal_report_fields(
                sk,
                goal_summary=session.goal_summary,
                completion_outcome=outcome,
            )
        self._persist_session_snapshot(session)
        await self._broadcast_panel_state(session)

        # 飞书推送（如已配置，复用同一份 summary）
        await self._maybe_push_feishu_completion(
            session, outcome=session.completion_outcome, detail=session.goal_summary
        )

        self._hosted_op_log(
            "托管目标完成",
            session,
            outcome=session.completion_outcome,
            summary_len=len(session.goal_summary or ""),
        )

    async def _acquire_run_slot(self, session: GoalSession) -> None:
        if session.id in self._run_slot_held:
            return
        global global_running_count
        async with global_lock:
            global_running_count += 1
            if session.user_id:
                user_running_counts[session.user_id] = user_running_counts.get(session.user_id, 0) + 1
        self._run_slot_held.add(session.id)

    async def _release_run_slot(self, session: GoalSession) -> None:
        if session.id not in self._run_slot_held:
            return
        global global_running_count
        async with global_lock:
            global_running_count = max(0, global_running_count - 1)
            if session.user_id:
                user_running_counts[session.user_id] = max(0, user_running_counts.get(session.user_id, 0) - 1)
        self._run_slot_held.discard(session.id)

    async def _retire_sessions_for_key(self, session_key: str) -> None:
        """结束同 chat session 上的旧托管实例，避免 <completed> 后无法再次启动。"""
        sk = str(session_key or "").strip()
        if not sk:
            return
        for sid in [s for s, sess in list(self._sessions.items()) if sess.associated_session_key == sk]:
            sess = self._sessions.get(sid)
            if not sess:
                continue
            # #13: 取消 LangGraph 服务端的活跃 run，否则旧 middleware 继续读写 DB 干扰新目标
            await self._cancel_active_lead_run(sess)
            if sid in self._hosted_loop_tasks:
                loop_task = self._hosted_loop_tasks.pop(sid, None)
                if loop_task and not loop_task.done():
                    loop_task.cancel()
                    try:
                        await loop_task
                    except asyncio.CancelledError:
                        pass
            task = self._running_tasks.pop(sid, None)
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            sess.status = GoalStatus.IDLE
            sess.ended_at = time.time()
            await self._release_run_slot(sess)
            self._context_compressor.clear_session(sid)
            self._sessions.pop(sid, None)
            self._histories.pop(sid, None)
        try:
            from evoflow.persistence import goal_repositories as goal_repo

            goal_repo.patch_goal_session_state(
                sk,
                state={"status": "idle", "stepCount": 0, "lastError": "", "pending": False},
                enabled=False,
                goal_status="cleared",
                continuation_suppressed=True,
                compaction_summary="",
                goal_summary="",
                completion_outcome="",
            )
            goal_repo.upsert_goal_session(sk, goal_session_id="")
        except Exception:
            logger.debug("hosted: retire patch db failed sk=%s", sk, exc_info=True)

    async def retire_all_web_goals(self, *, reason: str = "client_disconnect") -> list[str]:
        """Stop all web-channel active goals (EvoPanel client restart)."""
        try:
            from evoflow.persistence import goal_repositories as goal_repo
        except Exception:
            logger.warning("retire_all_web_goals: import goal_repositories failed", exc_info=True)
            return []
        try:
            rows = goal_repo.list_goal_sessions(goal_active_only=True, limit=500)
        except Exception:
            logger.warning("retire_all_web_goals: list sessions failed", exc_info=True)
            return []
        stopped: list[str] = []
        for row in rows:
            ch = str(row.get("channel_type") or "web").strip().lower()
            if ch != "web":
                continue
            sk = str(row.get("session_key") or "").strip()
            if not sk:
                continue
            try:
                await self._retire_sessions_for_key(sk)
                stopped.append(sk)
                logger.info("web goal retired on %s session_key=%s", reason, sk)
            except Exception:
                logger.warning(
                    "web goal retire failed on %s session_key=%s",
                    reason,
                    sk,
                    exc_info=True,
                )
        return stopped

    async def _ensure_context_compressed(
        self,
        session_id: str,
        *,
        aggressive: bool = False,
    ) -> None:
        """Compress in-place when token budget is exceeded (LLM summary)."""
        history = self._histories.get(session_id, [])
        if not history:
            return
        session = self._sessions.get(session_id)
        model_name, ctx_len = self._planner_context_length(session)
        compressed, changed = await compress_goal_history(
            history,
            session_id=session_id,
            context_length=ctx_len,
            model_name=model_name,
            aggressive=aggressive,
            compressor=self._context_compressor,
        )
        if changed:
            self._histories[session_id] = compressed

    def _build_chat_messages(self, session_id: str) -> list[dict[str, str]]:
        """构建大模型调用的消息列表（历史应在调用前已压缩）。"""
        history = self._histories.get(session_id, [])
        messages = []
        for item in history:
            if item.role == GoalHistoryRole.SYSTEM:
                messages.append({"role": "system", "content": item.content})
            elif item.role == GoalHistoryRole.ASSISTANT:
                messages.append({"role": "assistant", "content": item.content})
            else:
                messages.append({"role": "user", "content": item.content})

        # 确保至少有一条user消息，避免部分模型报错
        has_user = any(msg["role"] == "user" for msg in messages)
        if not has_user and history:
            config = self._sessions[session_id].config
            messages.append({"role": "user", "content": config.prompt})

        return messages

    async def _call_planner_model(
        self,
        session: GoalSession,
        messages: list[dict[str, str]],
        *,
        round_no: int | None = None,
    ) -> str:
        """调用调度大模型（与 compress / 内部摘要同路径：create_chat_model + ainvoke_internal_chat_model）。"""
        from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model

        step = round_no if round_no is not None else session.current_step + 1
        model_name = self._resolve_planner_model_name_for_session(session)
        self._hosted_op_log(
            "调用调度模型开始",
            session,
            round_no=step,
            model=model_name or "default",
            msg_count=len(messages),
        )
        t0 = time.monotonic()
        model = create_chat_model(
            name=model_name,
            thinking_enabled=False,
            invocation_kind="hosted_planner",
        )
        try:
            response = await ainvoke_internal_chat_model(model, messages)
            content = getattr(response, "content", "") or ""
            if not isinstance(content, str):
                content = str(content)
            text = content.strip()
            self._hosted_op_log(
                "调用调度模型完成",
                session,
                round_no=step,
                elapsed_s=time.monotonic() - t0,
                preview=text[:120],
            )
            return text
        except Exception as exc:
            self._hosted_op_log(
                "调用调度模型失败",
                session,
                level=logging.ERROR,
                round_no=step,
                elapsed_s=time.monotonic() - t0,
                error=str(exc),
            )
            raise

    def _goal_thread_id(self, *, lead_thread_id: str, session_id: str) -> str:
        from evoflow.collab.thread_ids import goal_checkpoint_thread_id

        return goal_checkpoint_thread_id(lead_thread_id, session_id)

    def _sync_session_from_goal_state(self, session: GoalSession, state: dict[str, Any]) -> None:
        if not isinstance(state, dict):
            return
        session.current_step = int(state.get("current_step") or session.current_step)
        gs = str(state.get("goal_status") or session.goal_status or "active").strip().lower()
        if gs:
            session.goal_status = gs
        goal_sum = str(state.get("goal_summary") or "").strip()
        if goal_sum:
            session.goal_summary = goal_sum
        session.continuation_suppressed = bool(state.get("continuation_suppressed", session.continuation_suppressed))
        st = str(state.get("status") or "").strip()
        if st == "waiting_user":
            session.pending_feedback = True
            session.feedback_prompt = str(state.get("clarification_prompt") or "")
            session.status = GoalStatus.PAUSED
        elif st == "failed":
            session.status = GoalStatus.ERROR
            session.last_error = str(state.get("last_error") or session.last_error or "")
        elif gs in {"completed", "cleared"}:
            session.status = GoalStatus.IDLE
            session.ended_at = session.ended_at or time.time()
        elif session.continuation_suppressed or gs == "paused":
            session.status = GoalStatus.PAUSED
        elif st in {"continuing", "running"} or gs == "active":
            session.status = GoalStatus.RUNNING

    async def _persist_goal_as_user_message(self, session: GoalSession, text: str) -> None:
        """Goal.create：目标文本作为第一条真实 user 消息落库（可见，非 synthetic）。"""
        content = str(text or "").strip()
        sk = str(session.associated_session_key or "").strip()
        if not content or not sk:
            return
        try:
            from evoflow.persistence.chat_session_service import persist_user_message

            await persist_user_message(sk, content, message_id=str(uuid.uuid4()))
        except Exception:
            logger.debug("hosted: persist goal user message failed sk=%s", sk, exc_info=True)

    async def _cancel_hosted_tasks(self, session_id: str) -> None:
        loop_task = self._hosted_loop_tasks.pop(session_id, None)
        if loop_task and not loop_task.done():
            loop_task.cancel()
            try:
                await loop_task
            except asyncio.CancelledError:
                pass
        task = self._running_tasks.pop(session_id, None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _cancel_active_lead_run(self, session: GoalSession) -> None:
        sk = str(session.associated_session_key or "").strip()
        if not sk:
            return
        try:
            from evoflow.persistence.chat_session_service import ensure_session_thread
            from evoflow.persistence.session_run_state import peek_current_run_id

            thread_id = await ensure_session_thread(sk)
            run_id = peek_current_run_id(session_key=sk, thread_id=thread_id)
            if run_id:
                await self.client.runs.cancel(thread_id, run_id)
        except Exception:
            logger.debug("hosted: cancel lead run failed sk=%s", sk, exc_info=True)

    async def _run_goal_graph(
        self,
        session_id: str,
        *,
        run_trigger: str = "goal_created",
        frontend_chat_done: bool = False,
    ) -> None:
        """Run in-graph hosted goal loop (GoalController → MainAgent) via LangGraph."""
        session = self._sessions.get(session_id)
        if not session:
            return

        sk = str(session.associated_session_key or "").strip()
        start_time = time.time()
        user_cap_min = int(session.config.auto_stop_minutes or 0)
        effective_max_minutes = MAX_RUN_MINUTES
        if user_cap_min > 0:
            effective_max_minutes = min(MAX_RUN_MINUTES, user_cap_min)
        lead_thread_id = ""
        goal_thread_id = ""

        try:
            from evoflow.persistence.chat_session_service import ensure_session_thread

            lead_thread_id = await ensure_session_thread(sk)
            goal_thread_id = self._goal_thread_id(lead_thread_id=lead_thread_id, session_id=session.id)
            planner_system = self._build_system_prompt(session.config, session.config.prompt)
            planner_model = self._resolve_planner_model_name_for_session(session)
            goal_revision = int(session.goal_revision or 1)
            last_reply = ""
            if frontend_chat_done and sk:
                try:
                    from evoflow.persistence.transcript_resume_anchor import latest_turn_reply_text

                    last_reply = latest_turn_reply_text(sk) or ""
                except Exception:
                    last_reply = ""

            input_state: dict[str, Any] = {
                "goal_id": session.id,
                "goal_text": session.config.prompt,
                "goal_revision": goal_revision,
                "goal_status": str(session.goal_status or "active"),
                "run_status": "idle",
                "run_trigger": run_trigger,
                "continuation_suppressed": bool(session.continuation_suppressed),
                "frontend_chat_done": bool(frontend_chat_done),
                "status": "running",
                "planner_system_prompt": planner_system,
                "max_steps": session.config.max_steps,
                "current_step": session.current_step,
                "goal_session_id": session.id,
                "session_key": sk,
                "lead_thread_id": lead_thread_id,
                "started_at": start_time,
                "goal_events": [],
                "pending_continuation": None,
                "completed_steps": [],
                "last_agent_reply": last_reply,
                "single_lead_run": True,
            }

            configurable = {
                "thread_id": goal_thread_id,
                "lead_thread_id": lead_thread_id,
                "session_key": sk,
                "planner_model_name": planner_model,
                "max_steps": session.config.max_steps,
                "max_run_minutes": effective_max_minutes,
                "run_trigger": run_trigger,
                "single_lead_run": True,
            }
            run_context = {
                **_GOAL_RUN_CONTEXT_BASE,
                "thread_id": lead_thread_id,
                "agent_name": agent_id_from_session_key(sk) or "main",
                "goal_automated": True,
                "goal_mode": True,
                "prompt_source": "goal_controller",
            }

            session.status = GoalStatus.RUNNING
            session.last_run_at = time.time()
            self._hosted_op_log(
                "托管 Goal 图开始",
                session,
                round_no=session.current_step + 1,
                goal_thread=goal_thread_id,
            )

            run_config = {"configurable": configurable, "recursion_limit": 200}
            run_config, run_context = merge_configurable_into_context(run_config, run_context)
            run_config = json_safe_run_dict(run_config)
            run_context = json_safe_run_dict(run_context)

            lead_meta = default_langgraph_thread_metadata(source="goal_lead", session_key=sk)
            lead_meta["goal_session_id"] = session.id
            goal_meta = default_langgraph_thread_metadata(source="goal_checkpoint", session_key=sk)
            goal_meta["goal_session_id"] = session.id
            goal_meta["lead_thread_id"] = lead_thread_id
            await ensure_langgraph_thread_exists(self.client, lead_thread_id, metadata=lead_meta)
            await ensure_langgraph_thread_exists(self.client, goal_thread_id, metadata=goal_meta)

            final_state: dict[str, Any] = {}
            async for chunk in self.client.runs.stream(
                goal_thread_id,
                _GOAL_GRAPH_ASSISTANT_ID,
                input=input_state,
                config=run_config,
                context=run_context,
                stream_mode=["values"],
                multitask_strategy="reject",
            ):
                data = getattr(chunk, "data", None)
                if isinstance(data, dict):
                    final_state = data
                    self._sync_session_from_goal_state(session, data)
                    self._persist_session_snapshot(session)
                    await self._broadcast_panel_state(session)

            self._sync_session_from_goal_state(session, final_state)
            st = str(final_state.get("status") or "completed")
            gs = str(final_state.get("goal_status") or session.goal_status or "active")
            session.goal_status = gs
            if st == "completed" or gs in {"completed", "cleared"}:
                reason = ""
                for evt in reversed(final_state.get("goal_events") or []):
                    if isinstance(evt, dict) and evt.get("event_type") == "goal_completed":
                        reason = str(evt.get("content") or "")
                        break
                self._hosted_op_log(
                    "托管任务完成",
                    session,
                    reason=reason or st,
                    elapsed_s=time.time() - start_time,
                )
                await self._finalize_goal_completion(
                    session,
                    completion_hint=reason,
                )
            elif st == "failed":
                err_msg = str(final_state.get("last_error") or "")
                session.goal_status = "completed"
                session.status = GoalStatus.ERROR
                session.ended_at = time.time()
                session.completion_outcome = f"执行异常: {err_msg[:200]}" if err_msg else "执行异常"
                session.goal_summary = f"目标执行过程中发生错误 · 共 {session.current_step} 轮"
                await self._release_run_slot(session)
                self._persist_session_snapshot(session)
                await self._broadcast_panel_state(session)
                self._hosted_op_log(
                    "托管 Goal 图失败",
                    session,
                    level=logging.ERROR,
                    error=err_msg,
                )
            elif st == "waiting_user":
                session.status = GoalStatus.PAUSED
            elif gs in {"active", "paused"}:
                session.goal_status = gs
                if session.continuation_suppressed or gs == "paused" or st == "interrupted":
                    session.status = GoalStatus.PAUSED
                elif st in {"continuing", "running"} and not str(final_state.get("pending_continuation") or "").strip():
                    session.status = GoalStatus.PAUSED
                    session.last_error = session.last_error or str(final_state.get("last_error") or "Goal 本轮结束，等待恢复")
                else:
                    session.status = GoalStatus.PAUSED
            else:
                await self._finalize_goal_completion(session)

        except asyncio.CancelledError:
            if str(session.goal_status or "") in {"active", "paused"}:
                session.status = GoalStatus.PAUSED
            else:
                session.status = GoalStatus.IDLE
            session.ended_at = time.time()
            self._hosted_op_log("托管 Goal 图被取消", session, elapsed_s=time.time() - start_time)
            raise
        except Exception as exc:
            err = str(exc)
            if "not found" in err.lower():
                err = (
                    f"{err}（请确认 LangGraph 已重启，且 langgraph.json 已注册 goal_agent；"
                    f"goal_thread={goal_thread_id or '?'} lead_thread={lead_thread_id or '?'}）"
                )
            session.status = GoalStatus.ERROR
            session.last_error = err
            session.ended_at = time.time()
            self._hosted_op_log(
                "托管 Goal 图异常",
                session,
                level=logging.ERROR,
                error=err,
            )
            logger.error("hosted goal graph failed session_id=%s: %s", session_id, err, exc_info=True)

    def _hosted_loop_is_active(self, session_id: str) -> bool:
        task = self._hosted_loop_tasks.get(session_id)
        return task is not None and not task.done()

    async def ensure_goal_stream_loop(
        self,
        session_id: str,
        *,
        run_trigger: str = "goal_created",
        frontend_chat_done: bool = False,
    ) -> None:
        """启动后台 Goal 图（LangGraph goal_agent）。"""
        if self._hosted_loop_is_active(session_id):
            return
        session = self._sessions.get(session_id)
        if session:
            self._hosted_op_log(
                "托管 Goal 图启动",
                session,
                round_no=session.current_step + 1,
                run_trigger=run_trigger,
                frontend_chat_done=frontend_chat_done,
            )
        self._hosted_loop_tasks[session_id] = asyncio.create_task(
            self._run_hosted_stream_loop(
                session_id,
                run_trigger=run_trigger,
                frontend_chat_done=frontend_chat_done,
            ),
            name=f"goal-goal-{session_id}",
        )

    def submit_frontend_step_result(
        self,
        session_id: str,
        *,
        result_text: str = "",
        pending_clarification: bool = False,
        clarification_prompt: str = "",
        error: str = "",
    ) -> bool:
        """Deprecated：托管已改后端 runs.wait，前端无需再回传 step-result。"""
        _ = (session_id, result_text, pending_clarification, clarification_prompt, error)
        return False

    async def _invoke_callback(self, callback: Callable, session: GoalSession, msg_type: str, content: str):
        """调用回调，带重试机制，失败不影响任务运行"""
        if not callback:
            return
        for attempt in range(PUSH_RETRY_TIMES + 1):
            try:
                await callback(session, msg_type, content)
                return
            except Exception as e:
                logger.warning(f"托管回调调用失败 (attempt {attempt + 1}/{PUSH_RETRY_TIMES + 1})：{e}")
                if attempt < PUSH_RETRY_TIMES:
                    await asyncio.sleep(PUSH_RETRY_INTERVAL)
        logger.error(f"托管回调调用最终失败，消息已丢弃：{msg_type} - {content[:50]}...")

    async def _maybe_push_feishu_completion(self, session: GoalSession, *, outcome: str, detail: str) -> None:
        """目标结束时向所选渠道推送摘要。"""
        from app.gateway.goal_feishu_completion import push_goal_completion_markdown

        c = session.config
        body = self._markdown_hosted_completion_summary(session, outcome=outcome, detail=detail)
        ok, msg = await push_goal_completion_markdown(
            push_enabled=bool(c.feishu_push_on_complete),
            push_channel=str(getattr(c, "push_channel", "") or ""),
            push_target_id=str(getattr(c, "push_target_id", "") or ""),
            title="目标结束汇报",
            markdown_body=body,
        )
        if ok:
            ch = str(getattr(c, "push_channel", "") or "feishu")
            logger.info("hosted %s: completion pushed via %s", session.id, ch)
        else:
            logger.info("hosted %s: completion not sent (%s)", session.id, msg)

    def _markdown_hosted_completion_summary(self, session: GoalSession, *, outcome: str, detail: str) -> str:
        goal = (session.config.prompt or "").strip()
        if len(goal) > 800:
            goal = goal[:800] + "…"
        lines = [
            f"- **结果**: {outcome}",
            f"- **目标 ID**: `{session.id}`",
            f"- **关联会话**: `{session.associated_session_key}`",
            f"- **渠道**: {session.channel_type.value}",
            f"- **执行步数**: {session.current_step} / {session.config.max_steps}",
        ]
        if session.last_error:
            err = session.last_error[:600]
            lines.append(f"- **最后错误**: {err}")
        if detail:
            d = detail.strip()
            if len(d) > 1200:
                d = d[:1200] + "…"
            lines.append(f"- **说明**: {d}")
        lines.append("")
        lines.append("**任务目标**")
        lines.append(goal or "（无）")
        hist = self._histories.get(session.id, [])
        last_target = ""
        for item in reversed(hist):
            if item.role == GoalHistoryRole.TARGET and (item.content or "").strip():
                last_target = (item.content or "").strip()
                break
        if last_target:
            if len(last_target) > 2500:
                last_target = last_target[:2500] + "…"
            lines.extend(["", "**最近一轮 EvoFlow 输出（节选）**", "```", last_target, "```"])
        return "\n".join(lines)

    async def _run_goal_session(self, session_id: str, callback: Callable[[GoalSession, str, str], Awaitable[None]] | None = None):
        """Legacy IM/callback entry — delegates to in-graph ``goal_agent`` loop."""
        _ = callback
        await self._run_hosted_stream_loop(session_id)

    # ==================== Web 托管后台循环 ====================

    async def run_goal_session_streaming(self, session_id: str):
        """Deprecated：托管改后台 runs.wait + 前端轮询 by-key；此接口仅 ensure loop。"""
        session = self._sessions.get(session_id)
        if not session:
            yield f"data: {json.dumps({'type': 'error', 'message': '目标会话不存在'}, ensure_ascii=False)}\n\n"
            return
        await self.ensure_goal_stream_loop(session_id)
        yield f"data: {json.dumps({'type': 'deprecated', 'message': '请轮询 /api/hosted/by-key 获取目标状态'}, ensure_ascii=False)}\n\n"

    async def _run_hosted_stream_loop(
        self,
        session_id: str,
        *,
        run_trigger: str = "goal_created",
        frontend_chat_done: bool = False,
    ) -> None:
        """Background task wrapper for in-graph ``goal_agent``."""
        session = self._sessions.get(session_id)
        if not session:
            return
        start_time = time.time()
        try:
            await self._run_goal_graph(
                session_id,
                run_trigger=run_trigger,
                frontend_chat_done=frontend_chat_done,
            )
        finally:
            session = self._sessions.get(session_id)
            if not session:
                self._hosted_loop_tasks.pop(session_id, None)
                return
            self._hosted_op_log(
                "托管 Goal 图结束",
                session,
                completed_steps=session.current_step,
                status=str(session.status),
                goal_status=str(session.goal_status or ""),
                elapsed_s=time.time() - start_time,
            )
            self._hosted_loop_tasks.pop(session_id, None)
            gs = str(session.goal_status or "").strip().lower()
            goal_alive = gs in {"active", "paused"}
            if goal_alive:
                if session.status == GoalStatus.RUNNING:
                    session.status = GoalStatus.PAUSED
            elif session.status == GoalStatus.RUNNING:
                session.status = GoalStatus.IDLE
            if not goal_alive and session.status not in {GoalStatus.PAUSED, GoalStatus.WAITING}:
                session.ended_at = session.ended_at or time.time()
                await self._release_run_slot(session)
            self._persist_session_snapshot(session)
            await self._broadcast_panel_state(session)

    async def start_goal(
        self,
        user_id: str | None,
        channel_type: GoalChannelType,
        channel_chat_id: str,
        associated_session_key: str,
        config: GoalConfig,
        callback: Callable[[GoalSession, str, str], Awaitable[None]] | None = None,
        *,
        use_frontend_chat: bool = True,
    ) -> GoalSession:
        """启动托管任务

        ``use_frontend_chat=True``（Web 默认）：首条 user 由 EvoPanel ``chatSend`` 发出，
        ``use_frontend_chat=True``（Web 默认）：首条 user 由 EvoPanel ``chatSend`` 发出；
        续跑在同一 ``lead_agent`` run 内由 ``GoalAutoContinueMiddleware`` 完成。
        """
        global global_running_count
        # 同 session_key 的旧实例先清掉（含 natural <completed> 结束但未释放 slot 的情况）
        await self._retire_sessions_for_key(associated_session_key)
        try:
            from evoflow.persistence import goal_repositories as goal_repo

            goal_repo.patch_goal_report_fields(
                associated_session_key,
                goal_summary="",
                completion_outcome="",
            )
        except Exception:
            pass
        # 惰性恢复：首次进入时尝试把库里 enabled=1 的会话续跑
        try:
            await self.recover_persisted_sessions()
        except Exception as e:
            logger.warning("hosted recover at start_goal skipped: %s", e)

        next_goal_revision = 1
        try:
            from evoflow.persistence import goal_repositories as goal_repo

            prior = goal_repo.load_goal_session(associated_session_key) or {}
            next_goal_revision = max(1, int(prior.get("goal_revision") or 0) + 1)
        except Exception:
            pass

        async with global_lock:
            # 全局并发限制
            if global_running_count >= MAX_CONCURRENT_GOALS:
                raise RuntimeError(f"当前运行的目标任务过多，请稍后再试（最多同时运行{MAX_CONCURRENT_GOALS}个）")

            # 单用户并发限制
            if user_id and user_running_counts.get(user_id, 0) >= MAX_USER_CONCURRENT_GOALS:
                raise RuntimeError(f"您已经有{MAX_USER_CONCURRENT_GOALS}个正在运行的目标任务，请先停止再启动新的")

        # 创建会话
        session = GoalSession(
            user_id=user_id,
            channel_type=channel_type,
            channel_chat_id=channel_chat_id,
            associated_session_key=associated_session_key,
            config=config,
            status=GoalStatus.RUNNING,
            goal_status="active",
            goal_revision=next_goal_revision,
            continuation_suppressed=False,
            goal_summary="",
            completion_outcome="",
        )

        # 初始化历史，加入系统提示
        system_prompt = self._build_system_prompt(config, config.prompt)
        self._histories[session.id] = [
            GoalHistoryItem(
                session_id=session.id,
                step=0,
                role=GoalHistoryRole.SYSTEM,
                content=system_prompt,
            )
        ]

        self._sessions[session.id] = session

        if use_frontend_chat and channel_type == GoalChannelType.WEB:
            session.awaiting_frontend_chat = True
            session.status = GoalStatus.WAITING
            self._hosted_op_log(
                "托管等待前端 chatSend",
                session,
                round_no=1,
                goal=(config.prompt or "")[:80],
            )
        else:
            await self._persist_goal_as_user_message(session, config.prompt)
            await self._acquire_run_slot(session)
            await self.ensure_goal_stream_loop(session.id, run_trigger="goal_created")

        if not session.awaiting_frontend_chat:
            await self._acquire_run_slot(session)

        # 镜像写入 SQLite + 推送 SSE 状态（失败均不影响调度）
        self._persist_session_snapshot(
            session,
            system_prompt=system_prompt,
            compaction_summary="",
        )
        await self._broadcast_panel_state(session)

        log_goal_trace(
            "目标启动",
            session_key=associated_session_key,
            turn_no=1,
            max_steps=config.max_steps,
            goal_text=config.prompt,
            user_input=config.prompt if not use_frontend_chat else "（等待前端 chatSend 发出首条 user）",
            action="start_goal",
            decision="Web 首条由 chatSend" if session.awaiting_frontend_chat else "Goal 文本已落库为 user",
            hosted_id=session.id,
        )

        self._hosted_op_log(
            "托管启动",
            session,
            round_no=1,
            user_id=user_id or "",
            channel=str(channel_type),
            max_steps=config.max_steps,
            goal=(config.prompt or "")[:80],
        )
        return session

    def _web_goal_continue_active(self, session_id: str) -> bool:
        task = self._web_goal_continue_tasks.get(session_id)
        return task is not None and not task.done()

    async def _continue_web_goal_after_frontend_chat(self, session_id: str) -> None:
        """Fallback when single-run middleware did not auto-continue (e.g. stale LangGraph / missing context)."""
        session = self._sessions.get(session_id)
        if not session:
            return
        if session.continuation_suppressed or str(session.goal_status or "") != "active":
            return

        sk = str(session.associated_session_key or "").strip()
        if not sk:
            return

        turn_no = max(1, int(session.current_step or 0))
        if turn_no >= int(session.config.max_steps or 50):
            return

        try:
            from evoflow.agents.goal.goal_runtime import build_continue_nudge
            from evoflow.agents.goal.main_agent_runner import stream_lead_agent_goal_step
            from evoflow.persistence.chat_session_service import ensure_session_thread
            from evoflow.persistence.transcript_resume_anchor import latest_turn_reply_text

            lead_thread_id = await ensure_session_thread(sk)
            nudge = build_continue_nudge(
                goal_text=session.config.prompt,
                turn_no=turn_no + 1,
                max_steps=int(session.config.max_steps or 50),
                initiative=int(session.config.initiative or 60),
            )

            session.status = GoalStatus.RUNNING
            session.last_run_at = time.time()
            self._persist_session_snapshot(session)
            await self._broadcast_panel_state(session)
            await self._acquire_run_slot(session)

            log_goal_trace(
                "前端 chat 结束-兜底续跑",
                session_key=sk,
                turn_no=turn_no,
                max_steps=session.config.max_steps,
                goal_text=session.config.prompt,
                judgment="middleware 未在单 run 内续跑（db_step<=1）",
                decision=f"Gateway 发起第 {turn_no + 1} 轮 lead_agent",
                action="stream_lead_agent_goal_step",
                nudge_input=nudge,
                hosted_id=session.id,
            )

            lead_config: dict[str, Any] = {
                "configurable": {
                    "thread_id": lead_thread_id,
                    "session_key": sk,
                    "pending_continuation": nudge,
                },
                "recursion_limit": 200,
            }
            run_context: dict[str, Any] = {
                **_GOAL_RUN_CONTEXT_BASE,
                "thread_id": lead_thread_id,
                "session_key": sk,
                "goal_automated": True,
                "goal_mode": True,
                "prompt_source": "goal_controller",
                "agent_name": agent_id_from_session_key(sk) or "main",
            }

            await stream_lead_agent_goal_step(
                lead_thread_id=lead_thread_id,
                session_key=sk,
                continuation=nudge,
                lead_config=lead_config,
                run_context=run_context,
            )

            reply = latest_turn_reply_text(sk) or ""
            row = self._sync_session_from_hosted_db(session)
            db_gs = str(session.goal_status or "").strip().lower()
            if db_gs in {"completed", "cleared"}:
                await self._ensure_completed_session_finalized(session, reply=reply)
            elif session.status == GoalStatus.WAITING or str((row or {}).get("status") or "") == "waiting":
                session.status = GoalStatus.WAITING
            elif reply and str(session.goal_status or "") == "active":
                db_step = int((row or {}).get("step_count") or 0)
                if db_step >= 1:
                    if session.status not in {GoalStatus.WAITING, GoalStatus.IDLE}:
                        session.status = GoalStatus.PAUSED
                else:
                    verdict = await self._interpret_goal_text_reply(session, reply, turn_no=turn_no + 1)
                    await self._apply_goal_reply_verdict(session, reply, verdict)
            elif str(session.goal_status or "") == "active":
                session.status = GoalStatus.PAUSED
            session.current_step = max(session.current_step, turn_no + 1)
            session.last_run_at = time.time()
            log_goal_trace(
                "兜底续跑-结束",
                session_key=sk,
                turn_no=session.current_step,
                max_steps=session.config.max_steps,
                goal_text=session.config.prompt,
                assistant_output=reply,
                decision=(
                    f"goal_status={session.goal_status} session_status="
                    f"{session.status.value if hasattr(session.status, 'value') else session.status}"
                ),
                hosted_id=session.id,
            )
        except asyncio.CancelledError:
            if str(session.goal_status or "") in {"active", "paused"}:
                session.status = GoalStatus.PAUSED
            raise
        except Exception as exc:
            session.status = GoalStatus.ERROR
            session.last_error = str(exc)
            log_goal_trace(
                "兜底续跑-异常",
                session_key=sk,
                turn_no=turn_no,
                max_steps=session.config.max_steps,
                goal_text=session.config.prompt,
                decision=str(exc),
                level=logging.ERROR,
            )
            logger.error("hosted web goal continue failed session_id=%s: %s", session_id, exc, exc_info=True)
        finally:
            self._web_goal_continue_tasks.pop(session_id, None)
            self._persist_session_snapshot(session)
            await self._broadcast_panel_state(session)

    def _schedule_web_goal_continue_after_frontend_chat(self, session_id: str) -> None:
        if self._web_goal_continue_active(session_id):
            return
        self._web_goal_continue_tasks[session_id] = asyncio.create_task(
            self._continue_web_goal_after_frontend_chat(session_id),
            name=f"goal-web-continue-{session_id}",
        )

    async def after_frontend_chat_turn(
        self,
        session_id: str,
        *,
        assistant_text: str = "",
        user_id: str | None = None,
    ) -> bool:
        """Web chatSend 首轮结束后同步 Goal 状态（续跑已在同一 lead_agent run 内完成）。"""
        session = self.get_session(session_id, user_id)
        if not session:
            return False
        if not session.awaiting_frontend_chat and session.current_step > 0:
            return True
        session.awaiting_frontend_chat = False
        session.current_step = max(int(session.current_step or 0), 1)
        session.last_run_at = time.time()
        reply = str(assistant_text or "").strip()
        row = self._sync_session_from_hosted_db(session)
        completed_reason: str | None = None
        verdict_continue = False

        db_gs = str(session.goal_status or "").strip().lower()
        if db_gs in {"completed", "cleared"}:
            await self._ensure_completed_session_finalized(session, reply=reply)
            completed_reason = session.completion_outcome or "任务完成"
        elif session.status == GoalStatus.WAITING or str((row or {}).get("status") or "") == "waiting":
            session.status = GoalStatus.WAITING
        elif reply and str(session.goal_status or "") == "active":
            session.last_error = None
            db_step = int((row or {}).get("step_count") or 0)
            if db_step >= 1:
                if session.status not in {GoalStatus.WAITING, GoalStatus.IDLE}:
                    session.status = GoalStatus.PAUSED
            else:
                verdict = await self._interpret_goal_text_reply(session, reply)
                if verdict.verdict == "complete":
                    completed_reason = await self._apply_goal_reply_verdict(session, reply, verdict)
                else:
                    verdict_continue = True
                    await self._apply_goal_reply_verdict(session, reply, verdict)

        sk = str(session.associated_session_key or "").strip()
        should_fallback_continue = False
        if (
            str(session.goal_status or "") == "active"
            and not session.continuation_suppressed
            and completed_reason is None
            and verdict_continue
            and session.current_step < int(session.config.max_steps or 50)
        ):
            db_step = int((row or {}).get("step_count") or 0)
            db_goal_status = str((row or {}).get("goal_status") or "").strip().lower()
            if db_goal_status == "completed":
                session.goal_status = "completed"
                session.status = GoalStatus.IDLE
                session.ended_at = time.time()
                await self._release_run_slot(session)
            elif db_step < 1:
                should_fallback_continue = True
            else:
                log_goal_trace(
                    "前端 chat 结束-跳过兜底",
                    session_key=sk,
                    turn_no=session.current_step,
                    max_steps=session.config.max_steps,
                    decision=f"db_step={db_step}>1，假定 middleware 已续跑",
                )

        self._persist_session_snapshot(session)
        await self._broadcast_panel_state(session)

        log_goal_trace(
            "前端 chat 流结束-状态同步",
            session_key=sk,
            turn_no=session.current_step,
            max_steps=session.config.max_steps,
            goal_text=session.config.prompt,
            assistant_output=reply,
            decision=(
                f"goal_status={session.goal_status} session_status={session.status.value if hasattr(session.status, 'value') else session.status}"
                + ("; 将触发兜底续跑" if should_fallback_continue else "")
            ),
            completed_reason=completed_reason or "",
            hosted_id=session.id,
        )
        self._hosted_op_log(
            "托管前端首轮完成（单 run 同步）",
            session,
            round_no=session.current_step,
            completed=session.goal_status == "completed",
            reply_preview=reply[:160] if reply else "",
        )
        if should_fallback_continue:
            self._schedule_web_goal_continue_after_frontend_chat(session_id)
        return True

    async def cancel_current_run(self, session_id: str, user_id: str | None = None, *, reason: str = "user_stop") -> bool:
        """停止当前 Run（run.cancel）；Goal 保持 active，禁止自动 continuation。"""
        session = self._sessions.get(session_id)
        if not session:
            return False
        if user_id and session.user_id and session.user_id != user_id:
            raise PermissionError("您没有权限停止这个目标任务")

        await self._cancel_active_lead_run(session)
        await self._cancel_hosted_tasks(session_id)

        session.continuation_suppressed = True
        session.goal_status = "active"
        session.status = GoalStatus.PAUSED

        self._persist_session_snapshot(session)
        await self._broadcast_panel_state(session)
        self._hosted_op_log(
            "托管 run.cancel",
            session,
            reason=reason,
            goal_status=session.goal_status,
        )
        return True

    async def pause_goal(self, session_id: str, user_id: str | None = None) -> bool:
        """暂停 Goal：停止当前 run 且禁止 Goal Controller 自动续跑。"""
        session = self._sessions.get(session_id)
        if not session:
            return False
        if user_id and session.user_id and session.user_id != user_id:
            raise PermissionError("您没有权限暂停这个目标任务")

        await self._cancel_active_lead_run(session)
        await self._cancel_hosted_tasks(session_id)

        session.goal_status = "paused"
        session.continuation_suppressed = True
        session.status = GoalStatus.PAUSED

        self._persist_session_snapshot(session)
        await self._broadcast_panel_state(session)
        self._hosted_op_log("托管 goal.pause", session)
        return True

    async def resume_goal(self, session_id: str, user_id: str | None = None) -> bool:
        """恢复 Goal：goal.resume → Goal Controller 生成 continuation 或继续 user_steering。"""
        session = self.get_session(session_id, user_id)
        if not session:
            return False
        if session.goal_status not in {"active", "paused"}:
            return False

        session.goal_status = "active"
        session.continuation_suppressed = False
        session.status = GoalStatus.RUNNING
        session.ended_at = None

        if not self._hosted_loop_is_active(session_id):
            await self._acquire_run_slot(session)
            await self.ensure_goal_stream_loop(session_id, run_trigger="goal_resume")

        self._persist_session_snapshot(session)
        await self._broadcast_panel_state(session)
        self._hosted_op_log("托管 goal.resume", session)
        return True

    async def end_goal(self, session_id: str, user_id: str | None = None) -> bool:
        """结束 Goal（cleared/completed），释放资源。"""
        session = self._sessions.get(session_id)
        if not session:
            return False
        if user_id and session.user_id and session.user_id != user_id:
            raise PermissionError("您没有权限结束这个目标任务")

        await self._cancel_active_lead_run(session)
        await self._cancel_hosted_tasks(session_id)

        session.goal_status = "cleared"
        session.continuation_suppressed = True
        session.status = GoalStatus.IDLE
        session.ended_at = time.time()

        await self._release_run_slot(session)
        self._context_compressor.clear_session(session_id)
        self._persist_session_snapshot(session)
        await self._broadcast_panel_state(session)
        self._hosted_op_log("托管 goal.end", session)
        return True

    async def stop_goal(self, session_id: str, user_id: str | None = None) -> bool:
        """兼容旧接口：等同「停止当前 Run」，不结束 Goal。"""
        return await self.cancel_current_run(session_id, user_id, reason="user_stop")

    # -------------------------- SQLite 镜像持久化 + 面板 SSE 推送 --------------------------
    @staticmethod
    def _goal_enabled(session: GoalSession) -> bool:
        return str(session.goal_status or "").strip().lower() in {"active", "paused"}

    def _session_to_db_kwargs(
        self,
        session: GoalSession,
        *,
        system_prompt: str | None = None,
        compaction_summary: str | None = None,
    ) -> dict[str, Any]:
        c = session.config
        status = session.status.value if hasattr(session.status, "value") else str(session.status)
        kwargs: dict[str, Any] = {
            "user_id": session.user_id or "",
            "goal_session_id": session.id,
            "prompt": c.prompt,
            "max_steps": c.max_steps,
            "step_delay_ms": c.step_delay_ms,
            "retry_limit": c.retry_limit,
            "auto_stop_minutes": c.auto_stop_minutes,
            "initiative": c.initiative,
            "emotional_intelligence": c.emotional_intelligence,
            "feishu_push_on_complete": c.feishu_push_on_complete,
            "push_channel": c.push_channel,
            "push_target_id": c.push_target_id,
            "continuous_learning": False,
            "use_evolution_skill": False,
            "goal_status": str(session.goal_status or "active"),
            "goal_revision": int(session.goal_revision or 1),
            "continuation_suppressed": bool(session.continuation_suppressed),
            "status": str(status),
            "step_count": session.current_step,
            "enabled": self._goal_enabled(session),
            "last_run_at": int((session.last_run_at or 0) * 1000),
            "last_error": session.last_error or "",
            "pending_feedback": session.pending_feedback,
            "feedback_prompt": getattr(session, "feedback_prompt", None) or "",
            "error_count": session.error_count,
            "ended_at": int((session.ended_at or 0) * 1000) if session.ended_at else 0,
            "start_time": int(session.created_at * 1000) if session.created_at else 0,
            "channel_type": session.channel_type.value if hasattr(session.channel_type, "value") else str(session.channel_type),
            "goal_summary": str(getattr(session, "goal_summary", "") or ""),
            "completion_outcome": str(getattr(session, "completion_outcome", "") or ""),
        }
        if system_prompt is not None:
            kwargs["system_prompt"] = system_prompt
        if compaction_summary is not None:
            kwargs["compaction_summary"] = compaction_summary
        return kwargs

    def load_settings_by_key(self, session_key: str) -> dict[str, Any] | None:
        """Load Goal panel settings from SQLite (draft or active)."""
        from evoflow.persistence import goal_repositories as goal_repo

        sk = str(session_key or "").strip()
        if not sk:
            return None
        row = goal_repo.load_goal_session(sk)
        if not row:
            return None
        return goal_repo.row_to_frontend_settings(row)

    async def save_settings_by_key(
        self,
        session_key: str,
        config: GoalConfig,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Persist Goal form draft to SQLite without starting a run."""
        from evoflow.persistence import goal_repositories as goal_repo

        sk = str(session_key or "").strip()
        if not sk:
            raise ValueError("session_key required")
        existing = goal_repo.load_goal_session(sk) or {}
        goal_repo.upsert_goal_session(
            sk,
            user_id=(user_id or existing.get("user_id") or ""),
            goal_session_id=str(existing.get("goal_session_id") or ""),
            prompt=config.prompt,
            max_steps=config.max_steps,
            step_delay_ms=config.step_delay_ms,
            retry_limit=config.retry_limit,
            auto_stop_minutes=config.auto_stop_minutes,
            initiative=config.initiative,
            emotional_intelligence=config.emotional_intelligence,
            feishu_push_on_complete=config.feishu_push_on_complete,
            push_channel=config.push_channel,
            push_target_id=config.push_target_id,
            goal_status=str(existing.get("goal_status") or "cleared"),
            goal_revision=int(existing.get("goal_revision") or 1),
            continuation_suppressed=bool(existing.get("continuation_suppressed")),
            status=str(existing.get("status") or "idle"),
            step_count=int(existing.get("step_count") or 0),
            enabled=self._goal_enabled_from_row(existing),
            system_prompt=str(existing.get("system_prompt") or ""),
            compaction_summary=str(existing.get("compaction_summary") or ""),
        )
        row = goal_repo.load_goal_session(sk)
        return goal_repo.row_to_frontend_settings(row or {})

    @staticmethod
    def _goal_enabled_from_row(row: dict[str, Any]) -> bool:
        gs = str(row.get("goal_status") or "").strip().lower()
        return gs in {"active", "paused"}

    def _persist_session_snapshot(
        self,
        session: GoalSession,
        *,
        system_prompt: str | None = None,
        compaction_summary: str | None = None,
    ) -> None:
        """把 session 内存状态镜像写入 SQLite。失败仅记日志，不抛异常。"""
        try:
            from evoflow.persistence import goal_repositories as goal_repo

            sk = (session.associated_session_key or "").strip()
            if not sk:
                return
            if system_prompt is None or compaction_summary is None:
                existing = goal_repo.load_goal_session(sk) or {}
                if system_prompt is None:
                    system_prompt = str(existing.get("system_prompt") or "")
                if compaction_summary is None:
                    compaction_summary = str(existing.get("compaction_summary") or "")
            kwargs = self._session_to_db_kwargs(
                session,
                system_prompt=system_prompt,
                compaction_summary=compaction_summary,
            )
            existing = goal_repo.load_goal_session(sk) or {}
            if existing:
                existing_hid = str(existing.get("goal_session_id") or "").strip()
                new_hid = str(kwargs.get("goal_session_id") or "").strip()
                existing_gs = str(existing.get("goal_status") or "").strip().lower()
                new_gs = str(kwargs.get("goal_status") or "").strip().lower()
                same_goal_instance = bool(existing_hid and new_hid and existing_hid == new_hid)
                if same_goal_instance:
                    kwargs["step_count"] = max(
                        int(kwargs.get("step_count") or 0),
                        int(existing.get("step_count") or 0),
                    )
                    if existing_gs in {"completed", "cleared"} and new_gs in {"active", "paused"}:
                        kwargs["goal_status"] = existing_gs
                        kwargs["status"] = str(existing.get("status") or "idle")
                        kwargs["enabled"] = False
                    if not str(kwargs.get("goal_summary") or "").strip():
                        kwargs["goal_summary"] = str(existing.get("goal_summary") or "")
                    if not str(kwargs.get("completion_outcome") or "").strip():
                        kwargs["completion_outcome"] = str(existing.get("completion_outcome") or "")
                elif new_gs in {"active", "paused"}:
                    # 新 goal 实例：不继承上一轮 completed/cleared 的终态字段
                    kwargs["goal_summary"] = ""
                    kwargs["completion_outcome"] = ""
                    kwargs["step_count"] = int(kwargs.get("step_count") or 0)
            goal_repo.upsert_goal_session(sk, **kwargs)
        except Exception as e:
            logger.warning(
                "hosted: persist snapshot failed sk=%s: %s",
                session.associated_session_key,
                e,
            )

    async def _broadcast_panel_state(self, session: GoalSession) -> None:
        """按 associated_session_key 作为 SSE thread_id，把当前状态推到前端面板。

        前端 ``useHostedAgent.ts`` 已经在 ``subscribeThreadPanelSse(sessionKey)``
        上订阅，所以这里直接用 ``session.associated_session_key`` 作为 broadcast key。
        失败仅 warning，不影响调度。
        """
        try:
            from app.gateway.routers.events import EventBroadcaster
            sk = (session.associated_session_key or "").strip()
            if not sk:
                return
            # #9: 先从 SQLite 刷新内存 session，避免推送过期状态
            try:
                from evoflow.persistence import goal_repositories as goal_repo

                row = goal_repo.load_goal_session(sk)
                if row:
                    self._apply_goal_db_row(session, row)
            except Exception:
                logger.debug("hosted: broadcast refresh from db failed sk=%s", sk, exc_info=True)

            status = session.status.value if hasattr(session.status, "value") else str(session.status)
            payload = {
                "sessionKey": sk,
                "goalId": session.id,
                "status": str(status),
                "stepCount": session.current_step,
                "lastError": session.last_error or "",
                "pending": session.pending_feedback,
                "errorCount": session.error_count,
                "enabled": str(session.goal_status or "active") in ("active", "paused"),
                "goalStatus": str(session.goal_status or "active"),
                "continuationSuppressed": bool(session.continuation_suppressed),
                "goalRevision": int(session.goal_revision or 1),
                "endedAt": int((session.ended_at or 0) * 1000) if session.ended_at else 0,
                "feedbackPrompt": getattr(session, "feedback_prompt", None) or "",
                "goalSummary": str(session.goal_summary or ""),
                "completionOutcome": str(session.completion_outcome or ""),
            }
            broadcaster = EventBroadcaster.get_instance()
            await broadcaster.broadcast(sk, "panel:goal_state", payload)
        except Exception as e:
            logger.warning(
                "hosted: broadcast panel state failed sk=%s: %s",
                session.associated_session_key,
                e,
            )

    async def recover_persisted_sessions(self) -> int:
        """从 SQLite 扫出 ``enabled=1`` 的托管会话，恢复成 asyncio.Task 续跑。

        进程重启后用户感知不到中断。**惰性调用**：在第一次 ``start_goal`` /
        ``/api/hosted/*`` 进来时触发即可（避免在 lifespan 中处理 langgraph_client 注入）。

        Returns: 恢复的会话数；单条失败仅 warning 不阻塞其它。
        """
        if not hasattr(self, "_recovered_sk"):
            self._recovered_sk: set[str] = set()
            self._recover_failed: dict[str, int] = {}
            self._recover_scanned = False
        _RECOVER_MAX_RETRIES = 3

        try:
            from evoflow.persistence import goal_repositories as goal_repo
        except Exception as e:
            logger.warning("hosted recover: import goal_repositories failed: %s", e)
            return 0

        if not self._recover_scanned:
            self._recover_scanned = True
            try:
                rows = goal_repo.list_goal_sessions(goal_active_only=True, limit=500)
            except Exception as e:
                logger.warning("hosted recover: list sessions failed: %s", e)
                return 0
        else:
            retry_sks = {sk for sk, cnt in self._recover_failed.items() if cnt < _RECOVER_MAX_RETRIES}
            if not retry_sks:
                return 0
            try:
                all_rows = goal_repo.list_goal_sessions(goal_active_only=True, limit=500)
                rows = [r for r in all_rows if str(r.get("session_key") or "").strip() in retry_sks]
            except Exception as e:
                logger.warning("hosted recover: list sessions for retry failed: %s", e)
                return 0

        if not rows:
            return 0

        recovered = 0
        for row in rows:
            sk = str(row.get("session_key") or "").strip()
            if not sk:
                continue
            if not bool(row.get("enabled")):
                continue
            status_raw = str(row.get("status") or "").strip().lower()
            if status_raw in {"idle", "error", ""}:
                continue
            # 已经在内存里就跳过（重复调用保险）
            already = any(s.associated_session_key == sk for s in self._sessions.values())
            if already:
                continue
            try:
                cfg = GoalConfig(
                    prompt=str(row.get("prompt") or ""),
                    max_steps=int(row.get("max_steps") or 8),
                    step_delay_ms=int(row.get("step_delay_ms") or 1200),
                    retry_limit=int(row.get("retry_limit") or 2),
                    auto_stop_minutes=int(row.get("auto_stop_minutes") or 0),
                    initiative=int(row.get("initiative") or 70),
                    emotional_intelligence=bool(row.get("emotional_intelligence", True)),
                    feishu_push_on_complete=bool(row.get("feishu_push_on_complete", False)),
                    push_channel=str(row.get("push_channel") or ""),
                    push_target_id=str(row.get("push_target_id") or ""),
                )
                run_status = str(row.get("status") or "running").strip().lower()
                try:
                    hosted_status = GoalStatus(run_status)
                except ValueError:
                    hosted_status = GoalStatus.RUNNING
                session = GoalSession(
                    id=str(row.get("goal_session_id") or "").strip() or f"goal-{uuid.uuid4().hex[:16]}",
                    user_id=row.get("user_id") or None,
                    channel_type=GoalChannelType.WEB,
                    channel_chat_id=sk,
                    associated_session_key=sk,
                    config=cfg,
                    status=hosted_status,
                    current_step=int(row.get("step_count") or 0),
                    goal_status=str(row.get("goal_status") or "active"),
                    goal_revision=int(row.get("goal_revision") or 1),
                    continuation_suppressed=bool(row.get("continuation_suppressed")),
                    error_count=int(row.get("error_count") or 0),
                    last_error=str(row.get("last_error") or "") or None,
                    last_run_at=(int(row.get("last_run_at") or 0) / 1000.0) if row.get("last_run_at") else time.time(),
                    pending_feedback=bool(row.get("pending_feedback")),
                    feedback_prompt=str(row.get("feedback_prompt") or "") or None,
                )
                # 复原 system prompt 历史
                sys_prompt = str(row.get("system_prompt") or "")
                if not sys_prompt:
                    sys_prompt = self._build_system_prompt(cfg, cfg.prompt)
                self._histories[session.id] = [
                    GoalHistoryItem(
                        session_id=session.id,
                        step=0,
                        role=GoalHistoryRole.SYSTEM,
                        content=sys_prompt,
                    )
                ]
                self._sessions[session.id] = session

                # 启动调度循环
                await self.ensure_goal_stream_loop(session.id)

                await self._acquire_run_slot(session)

                # 镜像 + SSE
                self._persist_session_snapshot(session, system_prompt=sys_prompt)
                await self._broadcast_panel_state(session)
                recovered += 1
                self._recovered_sk.add(sk)
                self._recover_failed.pop(sk, None)
                logger.info("hosted recover: resumed sk=%s hosted_id=%s", sk, session.id)
            except Exception as e:
                cur_cnt = self._recover_failed.get(sk, 0)
                self._recover_failed[sk] = cur_cnt + 1
                if cur_cnt + 1 >= _RECOVER_MAX_RETRIES:
                    logger.warning("hosted recover: giving up sk=%s after %d attempts: %s", sk, cur_cnt + 1, e)
                else:
                    logger.warning("hosted recover: failed sk=%s (attempt %d/%d): %s", sk, cur_cnt + 1, _RECOVER_MAX_RETRIES, e)

        if recovered:
            logger.info("hosted recover: %d session(s) resumed from SQLite", recovered)
        return recovered

    def _apply_goal_db_row(self, session: GoalSession, row: dict[str, Any]) -> None:
        """Overlay SQLite runtime onto in-memory session (LangGraph middleware writes DB only)."""
        session.current_step = max(session.current_step, int(row.get("step_count") or 0))
        gs = str(row.get("goal_status") or session.goal_status or "active").strip().lower()
        if gs:
            session.goal_status = gs
        session.continuation_suppressed = bool(row.get("continuation_suppressed"))
        session.pending_feedback = bool(row.get("pending_feedback"))
        fp = str(row.get("feedback_prompt") or "").strip()
        if fp:
            session.feedback_prompt = fp
        err = str(row.get("last_error") or "").strip()
        if err:
            session.last_error = err
        session.goal_summary = str(row.get("goal_summary") or getattr(session, "goal_summary", "") or "")
        session.completion_outcome = str(
            row.get("completion_outcome") or getattr(session, "completion_outcome", "") or ""
        )
        db_status = str(row.get("status") or "").strip().lower()
        if gs in {"completed", "cleared"}:
            session.status = GoalStatus.IDLE
            ended = int(row.get("ended_at") or 0)
            if ended:
                session.ended_at = ended / 1000.0 if ended > 1e12 else float(ended)
            elif not session.ended_at:
                session.ended_at = time.time()
        elif db_status == "waiting":
            session.status = GoalStatus.WAITING
        elif db_status == "running":
            session.status = GoalStatus.RUNNING
        elif db_status == "paused":
            session.status = GoalStatus.PAUSED
        elif db_status == "error":
            session.status = GoalStatus.ERROR

    def _lightweight_session_from_db_row(self, row: dict[str, Any]) -> GoalSession | None:
        """Build a poll-only GoalSession from SQLite (no scheduler / stream loop)."""
        sk = str(row.get("session_key") or "").strip()
        if not sk:
            return None
        cfg = GoalConfig(
            prompt=str(row.get("prompt") or ""),
            max_steps=int(row.get("max_steps") or 8),
            step_delay_ms=int(row.get("step_delay_ms") or 1200),
            retry_limit=int(row.get("retry_limit") or 2),
            auto_stop_minutes=int(row.get("auto_stop_minutes") or 0),
            initiative=int(row.get("initiative") or 70),
            emotional_intelligence=bool(row.get("emotional_intelligence", True)),
            feishu_push_on_complete=bool(row.get("feishu_push_on_complete", False)),
            push_channel=str(row.get("push_channel") or ""),
            push_target_id=str(row.get("push_target_id") or ""),
        )
        run_status = str(row.get("status") or "running").strip().lower()
        try:
            hosted_status = GoalStatus(run_status)
        except ValueError:
            hosted_status = GoalStatus.RUNNING
        session = GoalSession(
            id=str(row.get("goal_session_id") or "").strip() or f"goal-{uuid.uuid4().hex[:16]}",
            user_id=row.get("user_id") or None,
            channel_type=GoalChannelType.WEB,
            channel_chat_id=sk,
            associated_session_key=sk,
            config=cfg,
            status=hosted_status,
            current_step=int(row.get("step_count") or 0),
            goal_status=str(row.get("goal_status") or "active"),
            goal_revision=int(row.get("goal_revision") or 1),
            continuation_suppressed=bool(row.get("continuation_suppressed")),
            error_count=int(row.get("error_count") or 0),
            last_error=str(row.get("last_error") or "") or None,
            last_run_at=(int(row.get("last_run_at") or 0) / 1000.0) if row.get("last_run_at") else time.time(),
            pending_feedback=bool(row.get("pending_feedback")),
            feedback_prompt=str(row.get("feedback_prompt") or "") or None,
        )
        self._apply_goal_db_row(session, row)
        return session

    def resolve_goal_session_for_poll(self, session_key: str) -> GoalSession | None:
        """Merge SQLite runtime into memory session for frontend ``/by-key`` polling."""
        sk = str(session_key or "").strip()
        if not sk:
            return None
        try:
            from evoflow.persistence import goal_repositories as goal_repo

            row = goal_repo.load_goal_session(sk)
        except Exception:
            row = None

        mem = self.get_session_by_key(sk)
        if row:
            gs = str(row.get("goal_status") or "").strip().lower()
            if mem:
                row_hid = str(row.get("goal_session_id") or "").strip()
                mem_hid = str(mem.id or "").strip()
                if not row_hid or not mem_hid or row_hid == mem_hid:
                    self._apply_goal_db_row(mem, row)
                return mem
            if gs in {"active", "paused", "completed", "cleared"}:
                db_status = str(row.get("status") or "").strip().lower()
                if gs in {"completed", "cleared"} or db_status in {"running", "waiting", "paused"}:
                    return self._lightweight_session_from_db_row(row)
        return mem

    def get_session_by_key(self, session_key: str) -> GoalSession | None:
        """按 associated_session_key 查找活跃 Goal 会话（goal 未 cleared/completed）。"""
        sk = str(session_key or "").strip()
        terminal_goal = {"completed", "cleared"}
        visible_status = {GoalStatus.RUNNING, GoalStatus.WAITING, GoalStatus.PAUSED, GoalStatus.ERROR}
        best: GoalSession | None = None
        for session in self._sessions.values():
            if session.associated_session_key != sk:
                continue
            gs = str(session.goal_status or "").strip().lower()
            if gs in terminal_goal:
                continue
            if gs in {"active", "paused"} or session.status in visible_status:
                if best is None or session.created_at >= best.created_at:
                    best = session
        return best

    def get_session(self, session_id: str, user_id: str | None = None) -> GoalSession | None:
        """获取托管会话信息"""
        session = self._sessions.get(session_id)
        if not session:
            return None
        # 权限校验
        if user_id and session.user_id and session.user_id != user_id:
            raise PermissionError("您没有权限查看这个目标任务")
        return session

    def get_session_history(self, session_id: str, user_id: str | None = None, limit: int = 20) -> list[GoalHistoryItem]:
        """获取托管会话历史"""
        session = self.get_session(session_id, user_id)
        if not session:
            return []
        history = self._histories.get(session_id, [])
        return history[-limit:] if limit > 0 else history

    async def apply_user_steering(
        self,
        session_key: str,
        content: str,
        *,
        user_id: str | None = None,
    ) -> bool:
        """用户 steering：cancel run → 真实 user 消息 → revision++ → 新 run。"""
        session = self.get_session_by_key(session_key)
        if not session or str(session.goal_status or "") not in {"active", "paused"}:
            return False
        text = str(content or "").strip()
        if not text:
            return False

        await self._cancel_active_lead_run(session)
        await self._cancel_hosted_tasks(session.id)

        sk = str(session.associated_session_key or "").strip()
        if sk:
            try:
                from evoflow.persistence.chat_session_service import persist_user_message

                await persist_user_message(sk, text)
            except Exception:
                logger.debug("hosted steering persist failed sk=%s", sk, exc_info=True)

        session.goal_revision = int(session.goal_revision or 1) + 1
        session.continuation_suppressed = False
        session.goal_status = "active"
        session.status = GoalStatus.RUNNING
        session.ended_at = None

        if not self._hosted_loop_is_active(session.id):
            await self._acquire_run_slot(session)
            await self.ensure_goal_stream_loop(session.id, run_trigger="user_steering")

        self._persist_session_snapshot(session)
        await self._broadcast_panel_state(session)
        self._hosted_op_log("托管 user.steering", session, feedback_preview=text[:120])
        return True

    async def submit_feedback(self, session_id: str, feedback: str, user_id: str | None = None) -> bool:
        """提交人工反馈，继续执行"""
        session = self.get_session(session_id, user_id)
        if not session or not session.pending_feedback:
            return False

        # 添加反馈到历史
        self._histories[session_id].append(
            GoalHistoryItem(
                session_id=session_id,
                step=session.current_step,
                role=GoalHistoryRole.USER,
                content=feedback,
            )
        )

        session.pending_feedback = False
        session.feedback_prompt = None
        session.goal_revision = int(session.goal_revision or 1) + 1

        sk = str(session.associated_session_key or "").strip()
        if sk and str(feedback or "").strip():
            try:
                from evoflow.persistence.chat_session_service import (
                    append_message_and_touch_session,
                    ensure_session_thread,
                )

                thread_id = await ensure_session_thread(sk)
                append_message_and_touch_session(
                    sk,
                    role="user",
                    content=str(feedback).strip(),
                    thread_id=thread_id,
                )
            except Exception:
                logger.debug("hosted: persist feedback user message failed sk=%s", sk, exc_info=True)

        self._hosted_op_log(
            "收到用户澄清反馈",
            session,
            round_no=session.current_step + 1,
            feedback_preview=str(feedback or "")[:120],
        )

        # Web SSE 模式：执行循环在后台 task；若已结束则尝试 recover
        if not self._hosted_loop_is_active(session_id):
            if session.status in (GoalStatus.PAUSED, GoalStatus.IDLE):
                session.status = GoalStatus.RUNNING
                session.ended_at = None
                await self.ensure_goal_stream_loop(session_id)

        # 镜像写入 SQLite + 推送 SSE 状态
        self._persist_session_snapshot(session)
        await self._broadcast_panel_state(session)

        return True
