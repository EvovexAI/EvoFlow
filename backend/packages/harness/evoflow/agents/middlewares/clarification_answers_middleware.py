"""Normalize structured clarification answers from frontend into readable user text."""

from __future__ import annotations

import json
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime

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


def _to_readable_text(payload: dict[str, Any]) -> str:
    answers = payload.get("answers")
    free_text = str(payload.get("free_text") or "").strip()
    lines: list[str] = ["用户已提交结构化澄清答案："]
    if isinstance(answers, list) and answers:
        for idx, item in enumerate(answers, 1):
            if not isinstance(item, dict):
                continue
            qid = str(item.get("question_id") or "").strip() or f"q{idx}"
            labels = item.get("selected_option_labels")
            ids = item.get("selected_option_ids")
            opts: list[str] = []
            if isinstance(labels, list):
                opts = [str(x).strip() for x in labels if str(x).strip()]
            if not opts and isinstance(ids, list):
                opts = [str(x).strip() for x in ids if str(x).strip()]
            if opts:
                lines.append(f"- {qid}: {', '.join(opts)}")
            else:
                lines.append(f"- {qid}: (未选择)")
    if free_text:
        lines.append(f"- 补充说明: {free_text}")
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

        rewritten = last.model_copy(update={"content": _to_readable_text(payload)})
        return {"messages": [rewritten]}

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:  # noqa: ARG002
        return self._normalize(state)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._normalize(state)
