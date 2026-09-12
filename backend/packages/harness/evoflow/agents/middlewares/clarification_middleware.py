"""Middleware for intercepting clarification requests and presenting them to the user."""

import json
import logging
import re
from collections.abc import Callable
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.graph import END
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from evoflow.agents.human_gate_tools import message_id_prefix_for_gate
from evoflow.agents.middlewares.transcript_middleware import (
    persist_transcript_tool_message_now,
)
from evoflow.tools.clarification_questions_repair import (
    MAX_CLARIFICATION_QUESTIONS,
    cap_clarification_questions,
    repair_clarification_questions,
)

logger = logging.getLogger(__name__)


def _unattended_automation_context(request: ToolCallRequest) -> bool:
    """True when LangGraph was started by Gateway automation (no user to answer clarifications)."""
    try:
        from evoflow.agents.automation_runtime import is_unattended_automation

        rt = getattr(request, "runtime", None)
        return is_unattended_automation(rt)
    except Exception:
        return False


def _subagent_focus_clarification_tool_result(request: ToolCallRequest) -> ToolMessage:
    """Ultra/subagent-focus: do not interrupt the user; steer the model to delegate."""
    args = request.tool_call.get("args") if isinstance(request.tool_call.get("args"), dict) else {}
    question = str((args or {}).get("question") or "").strip()
    qsnippet = (question[:200] + "…") if len(question) > 200 else question
    content = "[子智能体模式] 勿向用户发起结构化询问（ask_clarification）。信息缺口请用 subagent 委派调研，或根据已有信息直接推进。"
    if qsnippet:
        content += f"\n（已忽略询问摘要: {qsnippet}）"
    return ToolMessage(
        content=content,
        tool_call_id=str(request.tool_call.get("id") or ""),
        name="ask_clarification",
    )


def _synthetic_clarification_tool_result(request: ToolCallRequest) -> ToolMessage:
    """Return a tool result instead of Command(goto=END) so the agent graph can continue."""
    args = request.tool_call.get("args") if isinstance(request.tool_call.get("args"), dict) else {}
    question = str((args or {}).get("question") or "").strip()
    qsnippet = (question[:280] + "…") if len(question) > 280 else question
    content = (
        f"[定时/无人值守任务] 当前无用户在线，不得中断等待选择。请根据任务目标与已有信息自行做合理假设并继续执行；若必须二选一，选更稳妥、可完成的任务路径，并在最终回复中简述假设。\n（模型曾请求澄清，摘要: {qsnippet or '（无摘要）'}）"
    )
    return ToolMessage(
        content=content,
        tool_call_id=str(request.tool_call.get("id") or ""),
        name="ask_clarification",
    )


class ClarificationMiddlewareState(AgentState):
    """Compatible with the `ThreadState` schema."""

    pass


class ClarificationMiddleware(AgentMiddleware[ClarificationMiddlewareState]):
    """Intercepts clarification tool calls and interrupts execution to present questions to the user.

    When the model calls the `ask_clarification` tool, this middleware:
    1. Intercepts the tool call before execution
    2. Extracts the clarification question and metadata
    3. Formats a user-friendly message
    4. Returns a Command that interrupts execution and presents the question
    5. Waits for user response before continuing

    This replaces the tool-based approach where clarification continued the conversation flow.
    """

    state_schema = ClarificationMiddlewareState

    def _is_chinese(self, text: str) -> bool:
        """Check if text contains Chinese characters.

        Args:
            text: Text to check

        Returns:
            True if text contains Chinese characters
        """
        return any("\u4e00" <= char <= "\u9fff" for char in text)

    def _normalize_option_labels(self, options: object, question: str) -> list[str]:
        labels: list[str] = []
        if isinstance(options, list):
            labels = []
            for opt in options:
                if isinstance(opt, dict):
                    lb = str(opt.get("label") or opt.get("text") or "").strip()
                    if lb:
                        labels.append(lb)
                else:
                    s = str(opt).strip()
                    if s:
                        labels.append(s)
        elif isinstance(options, str):
            raw = options.strip()
            if raw:
                parsed: object | None = None
                try:
                    parsed = json.loads(raw)
                except Exception:
                    parsed = None
                if isinstance(parsed, list):
                    labels = [str(opt).strip() for opt in parsed if str(opt).strip()]
                else:
                    # fallback: split by common delimiters
                    parts = [x.strip() for x in re.split(r"[,\n;；]+", raw) if x.strip()]
                    labels = parts

        # If tool passed one giant string item like '["a","b"]', parse that item again.
        if len(labels) == 1 and labels[0].startswith("[") and labels[0].endswith("]"):
            try:
                parsed2 = json.loads(labels[0])
                if isinstance(parsed2, list):
                    labels = [str(opt).strip() for opt in parsed2 if str(opt).strip()]
            except Exception:
                pass

        # Middleware should not invent semantic options; this is model responsibility.
        # We only keep transport compatibility and a minimal UI fallback.
        if not labels:
            labels = ["请补充必要信息", "其他（请补充）"]

        normalized = [str(lb).strip() for lb in labels if str(lb).strip()]
        if not normalized:
            normalized = ["请补充必要信息", "其他（请补充）"]
        if not any("其他" in lb for lb in normalized):
            normalized.append("其他（请补充）")
        return normalized

    @staticmethod
    def _strip_existing_choice_prefix(label: str) -> str:
        """模型若已写「A.」「A)」等与中间层重复的序号则去掉，避免展示成「A. A. xxx」。"""
        s = str(label or "").strip()
        return re.sub(r"^[A-Za-z][\.\)、:：]\s*", "", s).strip() or s

    @staticmethod
    def _choice_letter(idx: int) -> str:
        """第 idx 项（0-based）→ A/B/…/Z，超过 26 项时用数字序号。"""
        if 0 <= idx < 26:
            return chr(ord("A") + idx)
        return str(idx + 1)

    def _coerce_questions_list(self, raw: object) -> list[dict[str, Any]] | None:
        """Parse ``questions`` from tool args (list or JSON string)."""
        if raw is None:
            return None
        if isinstance(raw, str):
            s = raw.strip()
            if not s:
                return None
            try:
                raw = json.loads(s)
            except Exception:
                return None
        if not isinstance(raw, list) or not raw:
            return None
        items: list[dict[str, Any]] = [it for it in raw if isinstance(it, dict)]
        return items if items else None

    def _format_multi_questions_payload(self, args: dict, items: list[dict[str, Any]]) -> str | None:
        """Build native ``{ title, questions[] }`` payload; return None if nothing valid."""
        clarification_type = args.get("clarification_type", "missing_info")
        title_map = {
            "missing_info": "补充关键信息",
            "ambiguous_requirement": "需求待确认",
            "approach_choice": "方案选择",
            "risk_confirmation": "风险确认",
            "suggestion": "请确认建议",
        }
        user_title = str(args.get("title") or "").strip()
        title = user_title or title_map.get(str(clarification_type or "").strip(), "请确认")

        used_ids: set[str] = set()
        questions_out: list[dict[str, Any]] = []

        for i, q in enumerate(items):
            raw_id = str(q.get("id") or "").strip()
            qid = raw_id or f"q{i + 1}"
            if qid in used_ids:
                suffix = 2
                base = qid
                while f"{base}_{suffix}" in used_ids:
                    suffix += 1
                qid = f"{base}_{suffix}"
            used_ids.add(qid)

            prompt = str(q.get("prompt") or q.get("question") or "").strip()
            qctx = str(q.get("context") or "").strip()
            full_prompt = f"{qctx}\n{prompt}".strip() if qctx else prompt
            if not full_prompt:
                full_prompt = "请从下列选项中选择"

            option_labels = self._normalize_option_labels(q.get("options", []), full_prompt)
            option_items: list[dict[str, str]] = []
            for idx, raw_label in enumerate(option_labels):
                body = self._strip_existing_choice_prefix(raw_label)
                letter = self._choice_letter(idx)
                display = f"{letter}. {body}" if body else letter
                option_items.append({"id": f"opt_{idx + 1}", "label": display})

            questions_out.append(
                {
                    "id": qid,
                    "prompt": full_prompt,
                    "options": option_items,
                    "allow_multiple": bool(q.get("allow_multiple")),
                }
            )

        if not questions_out:
            return None
        payload = {"title": title, "questions": questions_out}
        return json.dumps(payload, ensure_ascii=False)

    def _format_clarification_message(self, args: dict) -> str:
        """Format clarification arguments into structured JSON for frontend form rendering.

        Args:
            args: The tool call arguments containing clarification details

        Returns:
            JSON string matching ThreadPanel clarify payload schema
        """
        coerced = self._coerce_questions_list(args.get("questions"))
        if coerced:
            coerced, hoisted_title = repair_clarification_questions(coerced)
            before_cap = len(coerced)
            coerced = cap_clarification_questions(coerced)
            if before_cap > len(coerced):
                logger.info(
                    "ask_clarification: truncating %d questions to %d",
                    before_cap,
                    MAX_CLARIFICATION_QUESTIONS,
                )
            if hoisted_title and not str(args.get("title") or "").strip():
                args = {**args, "title": hoisted_title}
            multi = self._format_multi_questions_payload(args, coerced)
            if multi:
                return multi

        question = str(args.get("question", "") or "").strip()
        clarification_type = args.get("clarification_type", "missing_info")
        context = str(args.get("context") or "").strip()
        options = args.get("options", [])

        title_map = {
            "missing_info": "补充关键信息",
            "ambiguous_requirement": "需求待确认",
            "approach_choice": "方案选择",
            "risk_confirmation": "风险确认",
            "suggestion": "请确认建议",
        }
        user_title = str(args.get("title") or "").strip()
        title = user_title or title_map.get(str(clarification_type or "").strip(), "请确认")
        prompt = question or "请补充必要信息。"

        option_labels = self._normalize_option_labels(options, question)

        question_id = "q1"
        option_items = []
        for idx, raw_label in enumerate(option_labels):
            body = self._strip_existing_choice_prefix(raw_label)
            letter = self._choice_letter(idx)
            display = f"{letter}. {body}" if body else letter
            # id 保持 opt_1/opt_2… 以便前端与历史载荷兼容；字母仅体现在 label 展示上。
            option_items.append({"id": f"opt_{idx + 1}", "label": display})
        payload = {
            "title": title,
            "questions": [
                {
                    "id": question_id,
                    "prompt": prompt if not context else f"{context}\n{prompt}",
                    "options": option_items,
                    "allow_multiple": False,
                }
            ],
        }
        return json.dumps(payload, ensure_ascii=False)

    def _handle_clarification(self, request: ToolCallRequest) -> Command:
        """Handle clarification request and return command to interrupt execution.

        Args:
            request: Tool call request

        Returns:
            Command that interrupts execution with the formatted clarification message
        """
        # Extract clarification arguments
        args = request.tool_call.get("args", {})
        question = args.get("question", "")

        logger.info("Intercepted clarification request")
        logger.debug("Clarification question: %s", question)

        # Format the clarification message
        formatted_message = self._format_clarification_message(args)

        # Get the tool call ID
        tool_call_id = str(request.tool_call.get("id") or "").strip()
        stable_id = (
            f"{message_id_prefix_for_gate('clarification')}-{tool_call_id}"
            if tool_call_id
            else None
        )

        # Create a ToolMessage with the formatted question
        # This will be added to the message history
        tool_message = ToolMessage(
            content=formatted_message or "",
            tool_call_id=tool_call_id or None,
            name="ask_clarification",
            id=stable_id,
        )

        # 立即落库：避免用户提交澄清后 seq 排在 tool 之前（下一轮 orphan 补写才进表）
        persist_transcript_tool_message_now(
            getattr(request, "runtime", None),
            tool_message,
            message_id_prefix=message_id_prefix_for_gate("clarification"),
        )

        # Return a Command that:
        # 1. Adds the formatted tool message
        # 2. Interrupts execution by going to __end__
        # Note: We don't add an extra AIMessage here - the frontend will detect
        # and display ask_clarification tool messages directly
        return Command(
            update={"messages": [tool_message]},
            goto=END,
        )

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        """Intercept ask_clarification tool calls and interrupt execution (sync version).

        Args:
            request: Tool call request
            handler: Original tool execution handler

        Returns:
            Command that interrupts execution with the formatted clarification message
        """
        # Check if this is an ask_clarification tool call
        if request.tool_call.get("name") != "ask_clarification":
            # Not a clarification call, execute normally
            return handler(request)

        if _unattended_automation_context(request):
            logger.info("ClarificationMiddleware: unattended automation — skip interrupt, synthetic ask_clarification result")
            return _synthetic_clarification_tool_result(request)

        try:
            from evoflow.agents.middlewares.plan_guard_middleware import is_subagent_focus_mode

            rt = getattr(request, "runtime", None)
            ctx = getattr(rt, "context", None) or {}
            if isinstance(ctx, dict) and is_subagent_focus_mode(configurable=ctx, collab_phase=ctx.get("collab_phase")):
                logger.info("ClarificationMiddleware: subagent-focus (ultra) — skip interrupt")
                return _subagent_focus_clarification_tool_result(request)
        except Exception:
            pass

        return self._handle_clarification(request)

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        """Intercept ask_clarification tool calls and interrupt execution (async version).

        Args:
            request: Tool call request
            handler: Original tool execution handler (async)

        Returns:
            Command that interrupts execution with the formatted clarification message
        """
        # Check if this is an ask_clarification tool call
        if request.tool_call.get("name") != "ask_clarification":
            # Not a clarification call, execute normally
            return await handler(request)

        if _unattended_automation_context(request):
            logger.info("ClarificationMiddleware: unattended automation — skip interrupt, synthetic ask_clarification result")
            return _synthetic_clarification_tool_result(request)

        try:
            from evoflow.agents.middlewares.plan_guard_middleware import is_subagent_focus_mode

            rt = getattr(request, "runtime", None)
            ctx = getattr(rt, "context", None) or {}
            if isinstance(ctx, dict) and is_subagent_focus_mode(configurable=ctx, collab_phase=ctx.get("collab_phase")):
                logger.info("ClarificationMiddleware: subagent-focus (ultra) — skip interrupt")
                return _subagent_focus_clarification_tool_result(request)
        except Exception:
            pass

        return self._handle_clarification(request)
