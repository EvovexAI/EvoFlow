"""Normalize structured clarification answers from frontend into readable user text.

zcode AskUserQuestion alignment: the model-visible text carries the **original
question text** (not just ``q1``-style ids), so the model can map answers back to
the exact questions it asked without re-reading history tool messages.
"""

from __future__ import annotations

import json
import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

_PREFIXES = (
    "__evf_clarify_ans_v1__:",  # new, explicit marker from frontend
    "clarification_answers:",  # backward-compat
)


def _extract_structured_payload(text: str) -> dict[str, Any] | None:
    raw = str(text or "").strip()
    raw_lower = raw.lower()
    hit = None
    for p in _PREFIXES:
        if raw_lower.startswith(p):
            hit = p
            break
    if not hit:
        return None
    body = raw[len(hit) :].strip()
    if not body:
        return None
    try:
        parsed = json.loads(body)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _question_map_from_messages(messages: list[Any]) -> dict[str, str]:
    """Map question id → original prompt from the last ask_clarification ToolMessage."""
    qmap: dict[str, str] = {}
    for msg in reversed(messages):
        if not isinstance(msg, ToolMessage):
            continue
        if str(getattr(msg, "name", "") or "") != "ask_clarification":
            continue
        content = msg.content
        if not isinstance(content, str):
            continue
        try:
            parsed = json.loads(content)
        except Exception:
            continue
        if not isinstance(parsed, dict):
            continue
        questions = parsed.get("questions")
        if not isinstance(questions, list):
            continue
        for q in questions:
            if not isinstance(q, dict):
                continue
            qid = str(q.get("id") or "").strip()
            prompt = str(q.get("prompt") or "").strip()
            if qid and prompt:
                qmap.setdefault(qid, prompt)
        if qmap:
            break
    return qmap


def _answer_lines(payload: dict[str, Any], qmap: dict[str, str]) -> tuple[list[str], int, int]:
    """Build ``- <question原文>: 答案`` lines; return (lines, answered, skipped)."""
    answers = payload.get("answers")
    lines: list[str] = []
    answered = 0
    skipped = 0
    if isinstance(answers, list):
        for idx, item in enumerate(answers, 1):
            if not isinstance(item, dict):
                continue
            qid = str(item.get("question_id") or "").strip() or f"q{idx}"
            # Prefer the explicit question text from the frontend payload, then
            # the id→prompt map from the ask_clarification tool message.
            qtext = str(item.get("question_text") or "").strip() or qmap.get(qid, "")
            labels = item.get("selected_option_labels")
            ids = item.get("selected_option_ids")
            opts: list[str] = []
            if isinstance(labels, list):
                opts = [str(x).strip() for x in labels if str(x).strip()]
            if not opts and isinstance(ids, list):
                opts = [str(x).strip() for x in ids if str(x).strip()]
            shown = qtext or qid
            if opts:
                answered += 1
                lines.append(f'- "{shown}": {", ".join(opts)}')
            else:
                skipped += 1
                lines.append(f'- "{shown}": (用户未选择)')
    return lines, answered, skipped


def _to_readable_text(payload: dict[str, Any], qmap: dict[str, str]) -> str:
    """Format answers zcode-style: original question text + selected answers."""
    answer_lines, answered, skipped = _answer_lines(payload, qmap)
    free_text = str(payload.get("free_text") or "").strip()

    if answered == 0 and not free_text:
        return "用户未提供这些提问的答案。请根据已有信息自行判断并继续推进。"

    header = "用户已回答你的提问："
    if answered == 0 and free_text:
        header = "用户未选择选项，仅提供了补充说明："
    elif skipped > 0:
        header = f"用户回答了部分提问（跳过 {skipped} 题）："

    lines = [header, *answer_lines]
    if free_text:
        lines.append(f'- 补充说明: "{free_text}"')
    lines.append("请根据用户的回答继续。")
    return "\n".join(lines)


class ClarificationAnswersMiddleware(AgentMiddleware[AgentState]):
    """Convert structured clarification answer payload into plain text for LLM."""

    state_schema = AgentState

    def _normalize(self, state: AgentState) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, HumanMessage):
            return None
        if not isinstance(last.content, str):
            return None

        payload = _extract_structured_payload(last.content)
        if payload is None:
            return None

        qmap = _question_map_from_messages(messages)
        rewritten = last.model_copy(update={"content": _to_readable_text(payload, qmap)})
        return {"messages": [rewritten]}

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:  # noqa: ARG002
        return self._normalize(state)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._normalize(state)
