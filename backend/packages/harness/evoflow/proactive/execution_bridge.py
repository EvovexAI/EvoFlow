"""ExecutionBridge - connects approved initiatives to existing execution infrastructure.

Routes initiatives to the appropriate executor:
- code_change / optimization  -> LangGraph lead_agent run
- task_delegation              -> supervisor tool delegation
- analysis / report / alert   -> direct LangGraph run (read-only)

Reuses the same LangGraph client + automation patterns as automation_runner.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from evoflow.proactive.models import Initiative
from evoflow.proactive.prompt import build_execution_prompt

logger = logging.getLogger(__name__)

DEFAULT_LANGGRAPH_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph")
DEFAULT_ASSISTANT_ID = os.getenv("EVOFLOW_PROACTIVE_ASSISTANT_ID", "lead_agent")
DEFAULT_TIMEOUT_SECONDS = int(os.getenv("EVOFLOW_PROACTIVE_EXECUTION_TIMEOUT", "600"))


class ExecutionBridge:
    """Bridges approved initiatives to LangGraph / supervisor execution."""

    def __init__(
        self,
        *,
        langgraph_url: str | None = None,
        assistant_id: str | None = None,
    ) -> None:
        self._langgraph_url = langgraph_url or DEFAULT_LANGGRAPH_URL
        self._assistant_id = assistant_id or DEFAULT_ASSISTANT_ID
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

    async def execute(self, initiative: Initiative) -> str:
        """Execute an approved initiative and return a result summary.

        For Phase 1, this launches a LangGraph run with a non-interactive
        prompt (same pattern as automation_runner cron runs).
        """
        action_plan_str = json.dumps(initiative.action_plan, ensure_ascii=False, indent=2)

        user_prompt = build_execution_prompt(
            initiative_title=initiative.title,
            initiative_description=initiative.description,
            action_plan=action_plan_str,
            initiative_id=initiative.id,
        )

        try:
            # Align execute transcript with the think duty round in work log.
            round_id = str(initiative.round_id or "").strip() or f"exec:{initiative.id}"
            result = await self._run_langgraph(
                user_prompt=user_prompt,
                role_agent_code=initiative.role_agent_code,
                initiative_id=initiative.id,
                round_id=round_id,
            )
            logger.info(
                "proactive.execute.done initiative=%s type=%s",
                initiative.id,
                initiative.action_type.value,
            )
            return result
        except Exception as exc:
            # Prefer already-humanized RuntimeError from _wait_for_run.
            from evoflow.proactive.run_errors import humanize_execution_result

            msg = humanize_execution_result(str(exc)) or f"执行失败：{exc}"
            logger.error(
                "proactive.execute.failed initiative=%s error=%s",
                initiative.id,
                msg,
                exc_info=True,
            )
            from evoflow.proactive.models import InitiativeStatus
            from evoflow.proactive.repositories import ProactiveRepository

            # Adapter ids (task:…) are not real initiative rows — caller owns Task status.
            if not str(initiative.id or "").startswith("task:"):
                ProactiveRepository.update_initiative_status(
                    initiative.id,
                    InitiativeStatus.FAILED,
                    execution_result=msg,
                )
            return msg

    async def _run_langgraph(
        self,
        *,
        user_prompt: str,
        role_agent_code: str,
        initiative_id: str,
        round_id: str | None = None,
    ) -> str:
        """Launch a LangGraph run and collect the final state.

        Uses the langgraph_sdk client, same as automation_runner.
        """
        from evoflow.proactive.chat_session import (
            finalize_proactive_chat_session,
            prepare_proactive_chat_session,
            resolve_work_session_key,
        )
        from evoflow.proactive.limits import resolve_proactive_recursion_limit
        from evoflow.proactive.repositories import ProactiveRepository

        client = self._get_client()
        role = ProactiveRepository.get_role(role_agent_code)
        role_name = role.role_name if role else role_agent_code
        max_turns = getattr(getattr(role, "config", None), "max_turns", None) if role else None
        rid = str(round_id or "").strip() or f"exec:{initiative_id}"

        # Prefer task-scoped conversation when initiative id is a collab task adapter.
        task_id = ""
        init_s = str(initiative_id or "").strip()
        if init_s.startswith("task:"):
            task_id = init_s[len("task:") :].strip()
        session_key = resolve_work_session_key(
            agent_code=role_agent_code,
            kind="task" if task_id else "duty",
            round_id=rid,
            task_id=task_id or None,
        )

        try:
            from evoflow.agents.automation_runtime import bootstrap_unattended_automation_scenarios

            bootstrap_unattended_automation_scenarios(session_key=session_key)
        except Exception:
            logger.debug("proactive.execute: scenario bootstrap failed (non-fatal)", exc_info=True)

        # Create a thread for this initiative
        thread = await client.threads.create(
            metadata={
                "session_key": session_key,
                "proactive_initiative_id": initiative_id,
                "proactive_role": role_agent_code,
                "round_id": rid,
                "source": "proactive_execute",
            },
        )
        thread_id = thread["thread_id"]

        # Prepend the non-interactive automation rules (same as automation_runner)
        from app.gateway.automation_runner import _AUTOMATION_LANGGRAPH_OUTER_RULES

        from evoflow.proactive.prompt import build_system_prompt

        full_prompt = _AUTOMATION_LANGGRAPH_OUTER_RULES + user_prompt
        # Phase F: duty archival retrieval keyed off this shift's prompt/goal text
        duty_query = str(user_prompt or "").strip()[:500]
        duty_system = (
            build_system_prompt(role, query=duty_query) if role else ""
        )

        task_title = ""
        if task_id:
            try:
                from evoflow.proactive.work_items import load_work_item_task

                row = load_work_item_task(task_id) or {}
                task_title = str(row.get("name") or row.get("title") or "").strip()
            except Exception:
                task_title = ""
        if not task_title:
            # Initiative title is the human label when not a collab Task adapter.
            try:
                from evoflow.proactive.repositories import ProactiveRepository

                init = ProactiveRepository.get_initiative(str(initiative_id or "").strip())
                task_title = str(getattr(init, "title", "") or "").strip() if init else ""
            except Exception:
                task_title = ""

        prepare_proactive_chat_session(
            agent_code=role_agent_code,
            role_name=role_name,
            thread_id=thread_id,
            prompt=full_prompt,
            round_id=rid,
            initiative_id=initiative_id,
            kind="execute",
            session_key=session_key,
            task_id=task_id or None,
            task_title=task_title or None,
            workspace_kind="task" if task_id else "duty",
            workspace_root=(role.config.workspace_path or "") if role else "",
        )

        # Graph id is always lead_agent; bind employee via agent_name + context (not configurable).
        from evoflow.langgraph_run_config import merge_configurable_into_context

        assistant_id = self._assistant_id
        run_input = {"messages": [{"role": "user", "content": full_prompt}]}
        recursion_limit = resolve_proactive_recursion_limit(max_turns, for_execute=True)
        run_config: dict = {"recursion_limit": recursion_limit}
        run_context: dict = {
            "triggered_by": "proactive_engine",
            "session_mode": "agent",
            "session_key": session_key,
            "agent_name": role_agent_code,
            "agent_id": role_agent_code,
            "position_code": str(getattr(role, "position_code", "") or "").strip(),
            "proactive_process": True,
            "proactive_agent_code": role_agent_code,
            "proactive_initiative_id": initiative_id,
            "round_id": rid,
            "proactive_system_prompt": duty_system,
            "is_plan_mode": False,
        }
        try:
            from evoflow.authz.runtime_identity import resolve_identity_from_agent

            for k, v in resolve_identity_from_agent(role_agent_code).items():
                if v:
                    run_context[k] = v
        except Exception:
            logger.debug("proactive.execute: identity inject failed", exc_info=True)
        if role is not None:
            try:
                from evoflow.proactive.prompt import resolve_role_duty_skills

                duty_skills = resolve_role_duty_skills(role)
                if duty_skills:
                    run_context["preferred_skills"] = duty_skills
            except Exception:
                logger.debug("proactive.execute: resolve duty skills failed", exc_info=True)
        model_name = str(getattr(getattr(role, "config", None), "model_name", None) or "").strip()
        if model_name:
            run_context["model_name"] = model_name
        ws = (getattr(role.config, "workspace_path", None) or "").strip() if role else ""
        if ws:
            run_context["local_workspace_root"] = ws
            run_context["use_virtual_paths"] = False
        run_config, run_context = merge_configurable_into_context(run_config, run_context)
        if isinstance(run_context, dict):
            run_context.setdefault("evf_interactive", False)
            run_context.setdefault("source", "proactive")
        logger.info(
            "proactive.execute.run initiative=%s agent=%s graph=%s recursion_limit=%d model=%s workspace=%s",
            initiative_id,
            role_agent_code,
            assistant_id,
            recursion_limit,
            model_name or "(agent/default)",
            ws or "(none)",
        )
        run = await client.runs.create(
            thread_id=thread_id,
            assistant_id=assistant_id,
            input=run_input,
            config=run_config,
            context=run_context,
        )

        # Wait for completion (with timeout)
        import asyncio

        # Resolve per-role timeout if configured (fallback to global default)
        timeout_seconds = DEFAULT_TIMEOUT_SECONDS
        if role is not None:
            role_timeout = getattr(getattr(role, "config", None), "execution_timeout", None)
            if role_timeout and int(role_timeout) > 0:
                timeout_seconds = int(role_timeout)

        try:
            final_state = await asyncio.wait_for(
                self._wait_for_run(client, thread_id, run["run_id"], timeout=timeout_seconds),
                timeout=timeout_seconds,
            )
        except TimeoutError:
            finalize_proactive_chat_session(
                session_key=session_key,
                thread_id=thread_id,
                reason="proactive_timeout",
            )
            return f"Execution timed out after {timeout_seconds}s"
        except Exception:
            finalize_proactive_chat_session(
                session_key=session_key,
                thread_id=thread_id,
                reason="proactive_error",
            )
            raise
        else:
            finalize_proactive_chat_session(
                session_key=session_key,
                thread_id=thread_id,
                reason="proactive_completed",
            )

        # Extract the last AI message
        messages = final_state.get("messages", []) if final_state else []
        if messages:
            last = messages[-1]
            content = last.get("content", "") if isinstance(last, dict) else str(last)
            if isinstance(content, list):
                content = "".join(
                    b.get("text", "") if isinstance(b, dict) else str(b) for b in content
                )
            return str(content)[:5000]

        return "Execution completed (no output)"

    async def _wait_for_run(self, client, thread_id: str, run_id: str, *, timeout: int | None = None) -> dict[str, Any]:
        """Poll the run until completion.

        Args:
            timeout: Max polling seconds. Defaults to DEFAULT_TIMEOUT_SECONDS.
        """
        import asyncio

        max_iterations = timeout or DEFAULT_TIMEOUT_SECONDS
        for _ in range(max_iterations):
            await asyncio.sleep(1)
            run = await client.runs.get(thread_id=thread_id, run_id=run_id)
            status = run.get("status", "")
            if status in ("done", "completed"):
                return run.get("results", {})
            elif status in ("error", "failed", "cancelled"):
                from evoflow.proactive.run_errors import format_langgraph_run_failure

                raise RuntimeError(format_langgraph_run_failure(status, run))
        raise TimeoutError(f"Run polling exceeded {max_iterations}s")
