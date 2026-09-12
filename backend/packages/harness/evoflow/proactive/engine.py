"""ProactiveEngine - the LLM-driven think cycle.

Perceives domain state -> thinks -> produces initiatives -> decides
(autonomous vs needs-approval) -> acts or routes to DecisionGate.

Phase 2 adds two modes:
- ``agent_loop``: launches a full LangGraph agent run with tool access,
  work-log context, and round-based session tracking.
- ``prompt_only``: the legacy single-LLM-call path (Phase 1 behaviour).
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from evoflow.models import create_chat_model
from evoflow.proactive.models import (
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveMemory,
    ProactiveRole,
    ThinkResult,
)
from evoflow.proactive.prompt import build_system_prompt, build_user_prompt
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Default model for think cycles; override via env.
_DEFAULT_THINK_MODEL = os.getenv("EVOFLOW_PROACTIVE_MODEL", "")
_DEFAULT_THINK_TEMPERATURE = 0.7
_DEFAULT_MAX_INITIATIVES = 3

# LangGraph connection defaults (same as execution_bridge).
_DEFAULT_LANGGRAPH_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph")


def _role_name_for_agent(agent_code: str | None) -> str | None:
    """Look up 岗位显示名 for stamping ``assigned_role`` on tasks."""
    code = str(agent_code or "").strip()
    if not code:
        return None
    try:
        role = ProactiveRepository.get_role(code)
    except Exception:
        return None
    if not role:
        return None
    name = str(role.role_name or "").strip()
    return name or None


_DEFAULT_ASSISTANT_ID = os.getenv("EVOFLOW_PROACTIVE_ASSISTANT_ID", "lead_agent")


async def _cancel_running_langgraph_runs(
    client: Any,
    thread_id: str,
    *,
    op_timeout: float = 5.0,
) -> int:
    """Best-effort cancel of pending/running runs on one LangGraph thread."""
    import asyncio

    cancelled = 0
    try:
        runs = await asyncio.wait_for(
            client.runs.list(thread_id=thread_id, limit=10),
            timeout=op_timeout,
        )
    except Exception:
        logger.debug(
            "proactive: list runs for cancel failed thread=%s",
            thread_id,
            exc_info=True,
        )
        return 0
    for run in runs or []:
        run_id = str(run.get("run_id") or run.get("id") or "").strip()
        status = str(run.get("status") or "").strip().lower()
        if not run_id or status not in ("pending", "running"):
            continue
        try:
            await asyncio.wait_for(
                client.runs.cancel(thread_id=thread_id, run_id=run_id),
                timeout=op_timeout,
            )
            cancelled += 1
        except Exception:
            logger.debug(
                "proactive: cancel run failed run=%s thread=%s",
                run_id,
                thread_id,
                exc_info=True,
            )
    return cancelled


# ── Work-log status emoji ─────────────────────────────────────────────

_STATUS_EMOJI = {
    "completed": "✅",
    "failed": "❌",
    "rejected": "🚫",
    "executing": "⏳",
    "pending_approval": "🕐",
    "proposed": "💡",
    "approved": "👍",
    "timeout_rejected": "⌛",
    "skipped": "⏭️",
}


def _is_execution_failure(result: str | None) -> bool:
    """Heuristic: treat bridge error/timeout strings as FAILED, not COMPLETED."""
    s = str(result or "").strip().lower()
    if not s:
        return False
    return (
        s.startswith("execution failed:")
        or s.startswith("execution error:")
        or s.startswith("执行失败")
        or "timed out" in s
        or "timeout" in s[:80]
        or "langgraph run error" in s
        or "langgraph run failed" in s
        or "langgraph run cancelled" in s
        or "graphrecursionerror" in s
        or "recursion limit" in s
        or "步数用尽" in s
    )


class ProactiveEngine:
    """Runs the think cycle for a single proactive role."""

    def __init__(
        self,
        *,
        model_name: str | None = None,
        temperature: float = _DEFAULT_THINK_TEMPERATURE,
        langgraph_url: str | None = None,
    ) -> None:
        self._model_name = model_name or _DEFAULT_THINK_MODEL
        self._temperature = temperature
        self._langgraph_url = langgraph_url or _DEFAULT_LANGGRAPH_URL
        self._cached_client = None

    def _get_client(self):
        """Reuse langgraph_sdk client to avoid connection pool fragmentation."""
        if self._cached_client is None:
            from langgraph_sdk import get_client
            self._cached_client = get_client(url=self._langgraph_url)
        return self._cached_client

    async def aclose(self):
        """Close the cached client and release resources."""
        if self._cached_client is not None:
            try:
                await self._cached_client.aclose()
            except Exception:
                pass
            self._cached_client = None

    # ── Public API ──────────────────────────────────────────────

    async def think(
        self,
        role: ProactiveRole,
        *,
        environment_context: str = "",
        memory: ProactiveMemory | None = None,
        round_id: str | None = None,
    ) -> ThinkResult:
        """Run a full think cycle for the given role.

        Dispatches to ``_run_agent_loop`` or ``_run_prompt_only`` based on
        the role's ``think_mode`` configuration.

        ``round_id`` (e.g. human dispatch ``dispatch:…``) stamps chat
        transcripts and work items with the same id the Panel uses to open
        the work trail.
        """
        if role.config.think_mode == "agent_loop":
            return await self._run_agent_loop(
                role,
                memory=memory,
                environment_context=environment_context,
                round_id=round_id,
            )
        return await self._run_prompt_only(
            role,
            memory=memory,
            environment_context=environment_context,
            round_id=round_id,
        )

    async def execute_initiative(self, initiative: Initiative) -> str:
        """Execute an approved initiative via LangGraph.

        Dual-write ``create_task`` after completion was removed: duty raises via
        ``evoflow tasks create``; human dispatch still uses ``create_role_work_item``.
        """
        from evoflow.proactive.execution_bridge import ExecutionBridge

        bridge = ExecutionBridge()
        result = await bridge.execute(initiative)

        # Bridge may have already marked FAILED; never overwrite that with COMPLETED.
        current = ProactiveRepository.get_initiative(initiative.id)
        if current and current.status == InitiativeStatus.FAILED:
            return result

        # Synthetic adapter ids (task:…) are not real initiative rows.
        if str(initiative.id or "").startswith("task:"):
            return result

        failed = _is_execution_failure(result)
        ProactiveRepository.update_initiative_status(
            initiative.id,
            InitiativeStatus.FAILED if failed else InitiativeStatus.COMPLETED,
            execution_result=result,
        )
        return result

    async def execute_work_item(self, task_id: str) -> str:
        """Execute an approved role work-item Task."""
        from evoflow.proactive.work_items import execute_work_item

        return await execute_work_item(task_id)

    # ── Agent-loop mode (Phase 2) ──────────────────────────────

    async def _run_agent_loop(
        self,
        role: ProactiveRole,
        *,
        memory: ProactiveMemory | None = None,
        environment_context: str = "",
        round_id: str | None = None,
    ) -> ThinkResult:
        """Think via a full LangGraph agent run with tool access."""
        from evoflow.proactive.repositories import ProactiveMemoryRepository

        if memory is None:
            memory = ProactiveMemoryRepository.get(role.agent_code)

        # 1. Board Tasks (SSOT) + initiative side notes
        recent_initiatives = ProactiveRepository.list_initiatives(
            role_agent_code=role.agent_code, limit=20,
        )
        work_log = self._build_work_log(recent_initiatives)
        from evoflow.proactive.work_items import (
            format_task_board_for_prompt,
            list_role_open_tasks,
        )

        try:
            from evoflow.agents.xiaomi.duty import format_global_boards_for_duty
            from evoflow.agents.xiaomi.identity import is_xiaomi_agent

            if is_xiaomi_agent(role.agent_code):
                task_board = format_global_boards_for_duty()
            else:
                task_board = format_task_board_for_prompt(list_role_open_tasks(role))
        except Exception:
            task_board = format_task_board_for_prompt(list_role_open_tasks(role))

        # 2. Round id (caller may pin dispatch:…) + per-round duty conversation session
        round_id = str(round_id or "").strip() or f"round:{utc_now_iso_z()}"
        from evoflow.proactive.chat_session import resolve_work_session_key

        # Prefer task-scoped session when env pins a related task (dispatch wake).
        related_task_id = ""
        blob = str(environment_context or "")
        for line in blob.splitlines():
            s = line.strip()
            low = s.lower()
            if low.startswith("related_task_id:"):
                related_task_id = s.split(":", 1)[-1].strip().strip("`")
                break
            if low.startswith("task_id:"):
                related_task_id = s.split(":", 1)[-1].strip().strip("`")
                break
            # Human-readable lines from dispatch_task extra_env
            if s.startswith("**关联 Task：**") or s.startswith("**Task：**"):
                # e.g. **Task：** `2608160050_8746`
                m = re.search(r"`([^`]+)`", s)
                if m:
                    related_task_id = m.group(1).strip()
                    break
        if related_task_id.startswith("task:"):
            related_task_id = related_task_id[len("task:") :].strip()
        session_key = resolve_work_session_key(
            agent_code=role.agent_code,
            kind="task" if related_task_id else "duty",
            round_id=round_id,
            task_id=related_task_id or None,
        )

        # 3. Build prompts
        system_prompt = build_system_prompt(
            role, query=str(environment_context or "").strip()[:500]
        )
        user_prompt = build_user_prompt(
            role,
            memory,
            environment_context=environment_context,
            work_log=work_log,
            task_board=task_board,
        )

        # 4. Launch LangGraph agent run (Task state via CLI; no submit_work journal)
        run_error, cost_info = await self._run_langgraph_agent(
            role=role,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            session_key=session_key,
            round_id=round_id,
            task_id=related_task_id or None,
        )

        # 5. Collect any legacy/round journals for this round (usually empty on Task-only path)
        round_inits = [
            i
            for i in ProactiveRepository.list_initiatives(
                role_agent_code=role.agent_code, limit=40,
            )
            if str(i.round_id or "") == round_id
        ]

        if run_error:
            # Leave round_inits as-is (usually empty). No synth wrap_up journal.
            logger.warning(
                "proactive.think: agent run error=%s role=%s round=%s (no force wrap_up)",
                run_error,
                role.agent_code,
                round_id,
            )
            # Task-scoped wakes must not stay forever at executing@N% when the
            # LangGraph run hard-fails (e.g. graph-build 422). Soft-complete the
            # heartbeat but mark the related board Task failed.
            if related_task_id:
                try:
                    from evoflow.proactive.work_items import set_work_item_status

                    set_work_item_status(
                        related_task_id,
                        "failed",
                        result=f"员工执行失败：{run_error}",
                        progress=0,
                    )
                except Exception:
                    logger.warning(
                        "proactive.think: failed to mark related task failed "
                        "task=%s role=%s err=%s",
                        related_task_id,
                        role.agent_code,
                        run_error,
                        exc_info=True,
                    )

        # Count completed/failed this round for 角色记忆 counters.
        _completed = sum(
            1
            for i in round_inits
            if i.status == InitiativeStatus.COMPLETED
            and str(
                (i.action_plan if isinstance(i.action_plan, dict) else {}).get("kind") or ""
            )
            != "round_log"
        )
        _failed = sum(
            1
            for i in round_inits
            if i.status == InitiativeStatus.FAILED
            and str(
                (i.action_plan if isinstance(i.action_plan, dict) else {}).get("kind") or ""
            )
            != "round_log"
        )

        proposed = [i for i in round_inits if i.status == InitiativeStatus.PROPOSED]
        reflection = ""
        observations: list[str] = []
        if round_inits:
            reflection = str(round_inits[0].outcome or round_inits[0].description or "")[:500]
            for init in round_inits[:5]:
                line = str(init.outcome or init.description or init.title or "").strip()
                if line:
                    observations.append(line[:240])
        from evoflow.proactive.work_items import list_pending_work_items_for_round

        pending_tasks = list_pending_work_items_for_round(role, round_id)
        result = ThinkResult(
            observations=observations,
            initiatives=[],
            reflection=reflection,
            goal=(round_inits[0].goal if round_inits else ""),
            outcome=(round_inits[0].outcome if round_inits else ""),
            created_initiative_ids=[i.id for i in proposed],
            round_id=round_id,
            round_initiative_ids=[i.id for i in round_inits],
            created_task_ids=[str(t.get("task_id") or t.get("id") or "") for t in pending_tasks],
        )

        # Persist 角色记忆 + cost log in a single transaction (R0-2: reduce RLock contention).
        # Prefer submit_work wrap_up (already wrote summary); only fallback-write
        # when still empty so「值班记忆」is not stuck blank.
        from evoflow.persistence.db import run_db_transaction
        from evoflow.proactive.repositories import ProactiveMemoryRepository

        try:
            mem = ProactiveMemoryRepository.get(role.agent_code)
            _need_mem_write = False
            _use_update_after = False
            _update_kwargs: dict[str, Any] = {}
            if not str(mem.last_think_summary or "").strip():
                if reflection or observations or _completed or _failed:
                    _need_mem_write = True
                    _use_update_after = True
                    _update_kwargs = {
                        "new_observations": observations,
                        "reflection": reflection
                        or (
                            f"本轮完成 {_completed} / 失败 {_failed}"
                            if (_completed or _failed)
                            else ""
                        ),
                        "completed": _completed,
                        "failed": _failed,
                    }
            elif _completed or _failed:
                _need_mem_write = True
                _update_kwargs = {
                    "new_observations": [],
                    "reflection": "",
                    "completed": _completed,
                    "failed": _failed,
                }

            if _need_mem_write or cost_info:
                def _batch_persist(db: Any) -> None:
                    if _need_mem_write:
                        if _use_update_after:
                            ProactiveMemoryRepository.update_after_think_in_txn(
                                db,
                                role.agent_code,
                                **_update_kwargs,
                            )
                        else:
                            # Increment counters only (save_in_txn)
                            ProactiveMemoryRepository.update_after_think_in_txn(
                                db,
                                role.agent_code,
                                new_observations=[],
                                reflection="",
                                completed=_completed,
                                failed=_failed,
                            )
                    if cost_info:
                        self._log_round_cost(
                            role,
                            round_id,
                            cost_info.get("thread_id", ""),
                            cost_info.get("model_name", ""),
                            cost_info.get("duration", 0.0),
                            cost_info.get("run_result"),
                            db=db,
                        )

                run_db_transaction(_batch_persist)
        except Exception:
            logger.debug(
                "proactive.think.agent_loop: batch persist (memory+cost) failed role=%s",
                role.agent_code,
                exc_info=True,
            )
            # Fallback: log cost standalone if batch failed
            if cost_info:
                try:
                    self._log_round_cost(
                        role,
                        round_id,
                        cost_info.get("thread_id", ""),
                        cost_info.get("model_name", ""),
                        cost_info.get("duration", 0.0),
                        cost_info.get("run_result"),
                    )
                except Exception:
                    logger.debug("proactive: fallback cost log failed", exc_info=True)

        # Person Kernel: LLM wrap-up from Task evidence (reference-adapted prompts)
        try:
            from evoflow.person_wrap_up_reflect import (
                collect_duty_wrap_up_statements,
                run_person_wrap_up_llm_async,
            )
            from evoflow.proactive.work_items import list_role_tasks_for_round

            round_tasks = list_role_tasks_for_round(role, round_id)
            tool_msg_count = 0
            try:
                from evoflow.persistence.chat_message_repositories import (
                    list_messages_for_display_all,
                )

                msgs = list_messages_for_display_all(
                    session_key,
                    max_rows=80,
                    round_id=round_id,
                )
                rows = (msgs or {}).get("messages") or []
                if isinstance(rows, list):
                    for m in rows:
                        if not isinstance(m, dict):
                            continue
                        role_name = str(m.get("role") or m.get("type") or "").lower()
                        if role_name == "tool" or m.get("tool_calls"):
                            tool_msg_count += 1
            except Exception:
                tool_msg_count = 0

            evidence = collect_duty_wrap_up_statements(
                tasks=round_tasks,
                round_initiatives=round_inits,
                environment_context=environment_context,
                run_error=run_error,
                tool_msg_count=tool_msg_count,
            )
            if evidence:
                model_name = (
                    str(getattr(role.config, "model_name", None) or "").strip() or None
                )
                pk = await run_person_wrap_up_llm_async(
                    role.agent_code,
                    statements=list(evidence.get("statements") or []),
                    round_id=round_id,
                    role_name=str(role.role_name or ""),
                    environment_context=str(
                        evidence.get("environment_context") or environment_context or ""
                    ),
                    run_error=evidence.get("run_error") or run_error,
                    model_name=model_name,
                    source="duty_llm",
                )
                if pk.get("ok") and not pk.get("skipped"):
                    logger.info(
                        "proactive.think.agent_loop: person llm wrap_up role=%s round=%s",
                        role.agent_code,
                        round_id,
                    )
                elif pk.get("error"):
                    logger.warning(
                        "proactive.think.agent_loop: person llm wrap_up failed role=%s err=%s",
                        role.agent_code,
                        pk.get("error"),
                    )
        except Exception:
            logger.debug(
                "proactive.think.agent_loop: person wrap_up skipped role=%s",
                role.agent_code,
                exc_info=True,
            )

        if not round_inits and not pending_tasks:
            logger.info(
                "proactive.think.agent_loop: no round journals/tasks for role=%s round=%s err=%s",
                role.agent_code,
                round_id,
                run_error or "-",
            )

        logger.info(
            "proactive.think.agent_loop role=%s round=%s goal=%s proposed=%d total_round=%d err=%s",
            role.agent_code,
            round_id,
            result.goal[:80],
            len(proposed),
            len(round_inits),
            run_error or "-",
        )
        return result

    async def _run_langgraph_agent(
        self,
        *,
        role: ProactiveRole,
        system_prompt: str,
        user_prompt: str,
        session_key: str,
        round_id: str,
        task_id: str | None = None,
    ) -> str | None:
        """Launch a LangGraph agent run; work state is Task + CLI (no submit_work journal).

        Returns ``(None, cost_info)`` on success, or ``(error_code, None)`` when
        the run exhausted but the heartbeat should still soft-complete.
        ``cost_info`` is a dict deferred to the caller for batch transaction (R0-2).
        """
        import asyncio

        from evoflow.proactive.chat_session import (
            finalize_proactive_chat_session,
            prepare_proactive_chat_session,
        )
        from evoflow.proactive.limits import resolve_proactive_recursion_limit
        from evoflow.langgraph_connectivity import create_langgraph_thread

        # Unattended: pre-activate agent scenario so tools aren't blocked behind activation gates
        try:
            from evoflow.agents.automation_runtime import bootstrap_unattended_automation_scenarios

            bootstrap_unattended_automation_scenarios(session_key=session_key)
        except Exception:
            logger.debug("proactive: scenario bootstrap failed (non-fatal)", exc_info=True)

        client = self._get_client()

        thread = await create_langgraph_thread(
            client,
            metadata={
                "session_key": session_key,
                "round_id": round_id,
                "proactive_role": role.agent_code,
                "source": "proactive_think",
            },
        )
        thread_id = thread["thread_id"]

        related_task = str(task_id or "").strip() or None
        task_title = ""
        if related_task:
            try:
                from evoflow.proactive.work_items import load_work_item_task

                row = load_work_item_task(related_task) or {}
                task_title = str(row.get("name") or row.get("title") or "").strip()
            except Exception:
                task_title = ""
        # Bind thread → duty/task conversation session (workspace multi-session)
        prepare_proactive_chat_session(
            agent_code=role.agent_code,
            role_name=role.role_name,
            thread_id=thread_id,
            prompt=user_prompt,
            round_id=round_id,
            kind="think",
            session_key=session_key,
            task_id=related_task,
            task_title=task_title or None,
            workspace_kind="task" if related_task else "duty",
            workspace_root=role.config.workspace_path,
        )

        # Graph system_prompt comes from lead_agent templates + agent config; inject
        # duty contract via run ``context`` (Agent Server rejects config.configurable + context together).
        assistant_id = _DEFAULT_ASSISTANT_ID
        run_input = {
            "messages": [
                {"role": "user", "content": user_prompt},
            ]
        }
        recursion_limit = resolve_proactive_recursion_limit(role.config.max_turns)
        # timeout_seconds=0 / 未配置 → 不设 wall-clock 上限（None=无限等待）。
        # 仍受 recursion_limit 保护；如需单角色限制可在 config 显式配置。
        timeout = role.config.timeout_seconds or None

        from evoflow.langgraph_run_config import merge_configurable_into_context

        run_config: dict = {"recursion_limit": recursion_limit}
        run_context: dict = {
            "triggered_by": "proactive_engine",
            "session_mode": "agent",
            "session_key": session_key,
            "agent_name": role.agent_code,
            "agent_id": role.agent_code,
            "position_code": str(getattr(role, "position_code", "") or "").strip(),
            "proactive_process": True,
            "proactive_agent_code": role.agent_code,
            "round_id": round_id,
            "proactive_system_prompt": system_prompt,
            "is_plan_mode": False,
        }
        try:
            from evoflow.authz.runtime_identity import resolve_identity_from_agent

            for k, v in resolve_identity_from_agent(role.agent_code).items():
                if v:
                    run_context[k] = v
        except Exception:
            logger.debug("proactive.think: identity inject failed", exc_info=True)
        if related_task:
            run_context["related_task_id"] = related_task
        try:
            from evoflow.proactive.prompt import resolve_role_duty_skills

            duty_skills = resolve_role_duty_skills(role)
            if duty_skills:
                run_context["preferred_skills"] = duty_skills
        except Exception:
            logger.debug("proactive: resolve duty skills failed", exc_info=True)
        model_name = str(getattr(role.config, "model_name", None) or "").strip()
        if model_name:
            run_context["model_name"] = model_name
        ws = (role.config.workspace_path or "").strip()
        if ws:
            run_context["local_workspace_root"] = ws
            run_context["use_virtual_paths"] = False
        run_config, run_context = merge_configurable_into_context(run_config, run_context)
        # Shared loop with chat: mark non-interactive so chat stream can preempt us.
        if isinstance(run_context, dict):
            run_context.setdefault("evf_interactive", False)
            run_context.setdefault("source", "proactive")


        _run_started_at = asyncio.get_event_loop().time()
        finalize_reason = "proactive_completed"

        try:
            try:
                run_result = await asyncio.wait_for(
                    client.runs.wait(
                        thread_id,
                        assistant_id,
                        input=run_input,
                        config=run_config,
                        context=run_context,
                    ),
                    timeout=timeout,
                )
                _duration = asyncio.get_event_loop().time() - _run_started_at
                # Defer cost logging to caller for batch transaction (R0-2)
                return None, {
                    "thread_id": thread_id,
                    "model_name": model_name,
                    "duration": _duration,
                    "run_result": run_result,
                }
            except TimeoutError:
                finalize_reason = "proactive_timeout"
                logger.warning(
                    "proactive.think: timeout after %ds role=%s round=%s - cancelling LangGraph run",
                    timeout,
                    role.agent_code,
                    round_id,
                )
                try:
                    n_cancelled = await _cancel_running_langgraph_runs(
                        client,
                        thread_id,
                        op_timeout=5.0,
                    )
                    logger.info(
                        "proactive.think: LangGraph run cancelled after timeout role=%s round=%s thread=%s cancelled=%d",
                        role.agent_code,
                        round_id,
                        thread_id,
                        n_cancelled,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "proactive.think: cancel wait timed out (5s) role=%s round=%s thread=%s",
                        role.agent_code,
                        round_id,
                        thread_id,
                    )
                except Exception as cancel_err:
                    logger.warning(
                        "proactive.think: cancel failed after timeout role=%s round=%s: %s",
                        role.agent_code,
                        round_id,
                        cancel_err,
                    )
                return "timeout", None
            except Exception as e:
                msg = str(e)
                if "Recursion limit" in msg or "GraphRecursionError" in msg:
                    finalize_reason = "proactive_recursion_limit"
                    logger.warning(
                        "proactive.think: recursion_limit exhausted role=%s round=%s limit=%d: %s",
                        role.agent_code,
                        round_id,
                        recursion_limit,
                        msg[:240],
                    )
                    return "recursion_limit", None
                finalize_reason = "proactive_error"
                # Soft-fail: return an error code so think/dispatch can mark the
                # related Task failed instead of leaving it hung at executing.
                status_code = getattr(getattr(e, "response", None), "status_code", None)
                if status_code == 422:
                    err_code = "graph_build_error"
                elif status_code is not None:
                    err_code = f"http_{status_code}"
                else:
                    err_code = "run_error"
                logger.error(
                    "proactive.think: agent run failed role=%s round=%s err=%s: %s",
                    role.agent_code,
                    round_id,
                    err_code,
                    msg[:240],
                    exc_info=True,
                )
                return err_code, None
        finally:
            finalize_proactive_chat_session(
                session_key=session_key,
                thread_id=thread_id,
                reason=finalize_reason,
            )
    # ── Cost tracking (O2) ─────────────────────────────────────

    @staticmethod
    def _log_round_cost(
        role: ProactiveRole,
        round_id: str,
        thread_id: str,
        model_name: str,
        duration_seconds: float,
        run_result: Any,
        *,
        db: Any = None,
    ) -> None:
        """Extract token usage from a LangGraph run result and persist cost.

        The run result may be None, a dict with ``messages``, or contain
        usage metadata.  We try several shapes to be resilient.

        If ``db`` is provided (inside a transaction), use ``log_cost_in_txn``;
        otherwise use the standalone ``log_cost`` which manages its own transaction.
        """
        input_tokens = 0
        output_tokens = 0
        total_tokens = 0
        cost_usd = 0.0
        actual_model = model_name or ""

        try:
            if isinstance(run_result, dict):
                # Shape 1: top-level usage_meta
                usage = run_result.get("usage_meta") or run_result.get("usage") or {}
                if isinstance(usage, dict):
                    input_tokens = int(usage.get("input_tokens", 0))
                    output_tokens = int(usage.get("output_tokens", 0))
                    total_tokens = int(usage.get("total_tokens", input_tokens + output_tokens))

                # Shape 2: scan messages for response_metadata usage
                if total_tokens == 0:
                    messages = run_result.get("messages") or []
                    if isinstance(messages, list):
                        for msg in messages:
                            if not isinstance(msg, dict):
                                continue
                            meta = msg.get("response_metadata") or {}
                            if not isinstance(meta, dict):
                                continue
                            u = meta.get("token_usage") or meta.get("usage") or {}
                            if isinstance(u, dict):
                                input_tokens += int(u.get("prompt_tokens", u.get("input_tokens", 0)))
                                output_tokens += int(u.get("completion_tokens", u.get("output_tokens", 0)))
                                if not actual_model:
                                    actual_model = str(meta.get("model_name", ""))
                            # Also check usage_metadata (OpenAI style)
                            um = msg.get("usage_metadata") or {}
                            if isinstance(um, dict) and um:
                                input_tokens = max(input_tokens, int(um.get("input_tokens", 0)))
                                output_tokens = max(output_tokens, int(um.get("output_tokens", 0)))
                                total_tokens = max(total_tokens, int(um.get("total_tokens", 0)))

                if total_tokens == 0:
                    total_tokens = input_tokens + output_tokens

                # Rough cost estimate: $3/M input, $15/M output (Claude-sonnet tier)
                # Real pricing should come from a model price table, but this gives
                # a visible ballpark until one is wired in.
                cost_usd = (input_tokens / 1_000_000) * 3.0 + (output_tokens / 1_000_000) * 15.0
        except Exception:
            logger.debug("proactive.cost: failed to extract token usage", exc_info=True)

        try:
            from evoflow.proactive.repositories import ProactiveCostRepository

            if db is not None:
                # Inside a transaction - use _in_txn version
                ProactiveCostRepository.log_cost_in_txn(
                    db,
                    role_agent_code=role.agent_code,
                    round_id=round_id,
                    thread_id=thread_id,
                    model_name=actual_model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                    cost_usd=round(cost_usd, 6),
                    duration_seconds=round(duration_seconds, 2),
                )
            else:
                # Standalone call - manage own transaction
                ProactiveCostRepository.log_cost(
                    role_agent_code=role.agent_code,
                    round_id=round_id,
                    thread_id=thread_id,
                    model_name=actual_model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                    cost_usd=round(cost_usd, 6),
                    duration_seconds=round(duration_seconds, 2),
                )
            if total_tokens > 0:
                logger.info(
                    "proactive.cost role=%s round=%s model=%s tokens=%d cost=$%.4f duration=%.1fs",
                    role.agent_code,
                    round_id,
                    actual_model or "(unknown)",
                    total_tokens,
                    cost_usd,
                    duration_seconds,
                )
        except Exception:
            logger.debug("proactive.cost: failed to persist cost log", exc_info=True)

    # ── Prompt-only mode (Phase 1 legacy) ───────────────────────

    async def _run_prompt_only(
        self,
        role: ProactiveRole,
        *,
        memory: ProactiveMemory | None = None,
        environment_context: str = "",
        round_id: str | None = None,
    ) -> ThinkResult:
        """Legacy single-LLM-call think path (Phase 1 behaviour)."""
        from evoflow.proactive.repositories import ProactiveMemoryRepository

        if memory is None:
            memory = ProactiveMemoryRepository.get(role.agent_code)

        # Build work log + board Tasks for context (even in prompt-only mode)
        recent_initiatives = ProactiveRepository.list_initiatives(
            role_agent_code=role.agent_code, limit=20,
        )
        work_log = self._build_work_log(recent_initiatives)
        from evoflow.proactive.work_items import (
            format_task_board_for_prompt,
            list_role_open_tasks,
        )

        try:
            from evoflow.agents.xiaomi.duty import format_global_boards_for_duty
            from evoflow.agents.xiaomi.identity import is_xiaomi_agent

            if is_xiaomi_agent(role.agent_code):
                task_board = format_global_boards_for_duty()
            else:
                task_board = format_task_board_for_prompt(list_role_open_tasks(role))
        except Exception:
            task_board = format_task_board_for_prompt(list_role_open_tasks(role))

        system_prompt = build_system_prompt(
            role, query=str(environment_context or "").strip()[:500]
        )
        user_prompt = build_user_prompt(
            role,
            memory,
            environment_context=environment_context,
            work_log=work_log,
            task_board=task_board,
        )

        raw_output = await self._call_llm(
            system_prompt,
            user_prompt,
            model_name=str(getattr(role.config, "model_name", None) or "").strip() or None,
        )
        result = ThinkResult.from_llm_output(raw_output)

        max_inits = role.config.max_initiatives_per_cycle or _DEFAULT_MAX_INITIATIVES
        if len(result.initiatives) > max_inits:
            result.initiatives = result.initiatives[:max_inits]

        # prompt_only has no shell: keep thin create with raised_by=self (dispatch uses user).
        # Agent-loop mode must use `evoflow tasks create` instead.
        from evoflow.proactive.title_similarity import find_near_duplicate_title
        from evoflow.proactive.work_items import create_role_work_item

        round_id = str(round_id or "").strip() or f"round:{utc_now_iso_z()}"
        existing_titles = [str(init.title or "").strip() for init in recent_initiatives if str(init.title or "").strip()]
        created_ids: list[str] = []
        created_task_ids: list[str] = []
        for init_data in result.initiatives:
            title = str(init_data.get("title") or "").strip()
            if not title:
                continue
            if title in existing_titles or find_near_duplicate_title(title, existing_titles):
                logger.info("proactive: skip duplicate work item '%s'", title[:80])
                continue
            created = create_role_work_item(
                role,
                init_data,
                round_id=round_id,
                goal=result.goal,
                outcome=result.outcome,
                source="proactive_patrol",
                source_ref=round_id,
                raised_by=str(role.agent_code or "").strip() or "user",
            )
            if created:
                tid = str(created.get("task_id") or "")
                if tid:
                    created_task_ids.append(tid)
                existing_titles.append(title)

        result.created_initiative_ids = created_ids
        result.created_task_ids = created_task_ids
        result.round_id = round_id
        result.round_initiative_ids = list(created_ids)

        ProactiveMemoryRepository.update_after_think(
            role.agent_code,
            new_observations=result.observations,
            reflection=result.reflection,
        )

        logger.info(
            "proactive.think.prompt_only role=%s round=%s observations=%d tasks=%d",
            role.agent_code,
            round_id,
            len(result.observations),
            len(created_task_ids),
        )
        return result

    # ── Work log ────────────────────────────────────────────────

    def _build_work_log(self, initiatives: list[Initiative]) -> str:
        """Format recent non-journal initiatives for duty brief side notes.

        Board Tasks are the SSOT (``format_task_board_for_prompt``). Round-log /
        dispatch_guard journals are omitted — they are no longer written on the
        Task-only duty path and must not drive「工作记录」.
        """
        actionable = [
            init
            for init in (initiatives or [])[:20]
            if str(
                (init.action_plan if isinstance(init.action_plan, dict) else {}).get("kind")
                or ""
            )
            not in {"round_log", "dispatch_guard"}
        ]
        if not actionable:
            return ""

        lines = ["## 近况（审批 / legacy 参考；工作记录见本岗看板 Task）\n"]
        open_lines: list[str] = []

        for init in actionable:
            emoji = _STATUS_EMOJI.get(init.status.value, "•")
            line = f"  {emoji} [{init.status.value}] id=`{init.id}` {init.title}"

            if init.execution_result:
                summary = init.execution_result[:200].replace("\n", " ")
                line += f"\n    -> 执行结果: {summary}..."

            if init.status.value in {"rejected", "timeout_rejected"}:
                try:
                    appr = ProactiveRepository.get_approval_by_initiative(init.id)
                except Exception:
                    appr = None
                reason = ""
                if appr is not None:
                    reason = str(
                        getattr(appr, "rejection_reason", "")
                        or getattr(appr, "decision_comment", "")
                        or ""
                    ).strip()
                if init.status.value == "timeout_rejected":
                    if not reason:
                        reason = "审批超时未处理，系统已自动拒绝"
                    line += (
                        "\n    -> 【待重新评估】审批超时自动拒绝。"
                        "请确认问题是否仍存在。"
                    )
                    if reason:
                        line += f"\n    -> 超时备注: {reason[:160]}"
                else:
                    if reason:
                        line += f"\n    -> 驳回原因（勿再提同题）: {reason[:160]}"

            if init.rationale:
                line += f"\n    -> 决策依据: {init.rationale[:100]}..."

            if init.goal:
                line += f"\n    -> 上岗目标: {init.goal[:80]}"

            lines.append(line)
            if init.status.value in {
                "proposed",
                "pending_approval",
                "approved",
                "executing",
            }:
                open_lines.append(f"  - `{init.id}` · {init.title} · {init.status.value}")

        reeval: list[str] = []
        for init in actionable:
            if init.status.value != "timeout_rejected":
                continue
            reeval.append(f"  - `{init.id}` · {init.title}")
        if reeval:
            lines.append("\n## 待重新评估（审批超时）\n")
            lines.extend(reeval[:8])

        if open_lines:
            from evoflow.proactive.title_similarity import find_near_duplicate_title

            collapsed: list[str] = []
            seen_titles: list[str] = []
            hidden_open = 0
            for line in open_lines:
                title_part = line
                if " · " in line:
                    bits = line.split(" · ", 2)
                    title_part = bits[1] if len(bits) >= 2 else line
                near = find_near_duplicate_title(title_part, seen_titles)
                if near:
                    hidden_open += 1
                    continue
                seen_titles.append(title_part)
                collapsed.append(line)
            lines.append("\n## 未结审批/legacy（勿与看板 Task id 混淆）\n")
            lines.extend(collapsed)
            if hidden_open:
                lines.append(f"\n  （已折叠 {hidden_open} 条近重复项）")

        return "\n".join(lines)

    # ── Internal helpers ────────────────────────────────────────

    def _build_initiative(
        self,
        role: ProactiveRole,
        data: dict[str, Any],
    ) -> Initiative | None:
        """Convert a raw LLM initiative dict into an Initiative object."""
        title = str(data.get("title") or "").strip()
        if not title:
            return None
        description = str(data.get("description") or "").strip()
        if not description:
            description = title

        try:
            action_type = InitiativeActionType(str(data.get("action_type") or "analysis"))
        except ValueError:
            action_type = InitiativeActionType.ANALYSIS

        try:
            risk_level = InitiativeRiskLevel(str(data.get("risk_level") or "low"))
        except ValueError:
            risk_level = InitiativeRiskLevel.LOW

        action_plan = data.get("action_plan") or {}
        if not isinstance(action_plan, dict):
            action_plan = {"raw": str(action_plan)}

        # Always start as PROPOSED. DecisionGate.request_approval() transitions
        # to PENDING_APPROVAL and creates the Approval row. (Previously we wrote
        # PENDING_APPROVAL here which made the runner miss the initiative.)

        return Initiative(
            id=ProactiveRepository.new_initiative_id(),
            role_agent_code=role.agent_code,
            title=title,
            description=description,
            rationale=str(data.get("rationale") or ""),
            action_type=action_type,
            risk_level=risk_level,
            action_plan=action_plan,
            expected_outcome=str(data.get("expected_outcome") or ""),
            status=InitiativeStatus.PROPOSED,
            approval_timeout_minutes=role.config.approval_timeout_minutes,
            config_autonomy_level=role.config.autonomy_level,
            created_at=utc_now_iso_z(),
            updated_at=utc_now_iso_z(),
        )

    async def _call_llm(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model_name: str | None = None,
    ) -> str:
        """Call the LLM and return raw text output."""
        name = (model_name or self._model_name or "").strip() or None
        try:
            model = create_chat_model(
                model_name=name,
                temperature=self._temperature,
            )
        except Exception:
            logger.warning("proactive: create_chat_model failed, using default", exc_info=True)
            model = create_chat_model(temperature=self._temperature)

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        response = await model.ainvoke(messages)
        content = response.content if hasattr(response, "content") else str(response)
        if isinstance(content, list):
            content = "".join(
                block.get("text", "") if isinstance(block, dict) else str(block)
                for block in content
            )
        return str(content)

    # ── LangGraph run polling ──────────────────────────────────

    async def _wait_for_run(
        self,
        client,
        thread_id: str,
        run_id: str,
        *,
        timeout: int = 300,
    ) -> dict[str, Any]:
        """Poll a LangGraph run until completion."""
        import asyncio

        try:
            return await asyncio.wait_for(
                self._poll_run(client, thread_id, run_id),
                timeout=timeout,
            )
        except TimeoutError:
            logger.warning("proactive: agent loop timed out after %ds", timeout)
            return {}

    async def _poll_run(self, client, thread_id: str, run_id: str) -> dict[str, Any]:
        import asyncio

        for _ in range(600):  # max ~10 min at 1s intervals
            await asyncio.sleep(1)
            run = await client.runs.get(thread_id=thread_id, run_id=run_id)
            status = run.get("status", "")
            if status in ("done", "completed"):
                return run.get("results", {})
            elif status in ("error", "failed", "cancelled"):
                from evoflow.proactive.run_errors import format_langgraph_run_failure

                raise RuntimeError(format_langgraph_run_failure(status, run))
        raise TimeoutError("Run polling exceeded 600 iterations")

    def _extract_final_message(self, final_state: dict[str, Any]) -> str:
        """Extract the last AI message text from a LangGraph final state."""
        messages = final_state.get("messages", []) if final_state else []
        if not messages:
            return ""
        last = messages[-1]
        content = last.get("content", "") if isinstance(last, dict) else str(last)
        if isinstance(content, list):
            content = "".join(
                b.get("text", "") if isinstance(b, dict) else str(b) for b in content
            )
        return str(content)
