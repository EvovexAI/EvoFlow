"""Estimate model-call overhead tokens (system prompt + bound tools) from wire shapes.

Uses LangChain's ``convert_to_openai_tool`` so compaction gating matches the
OpenAI-compatible ``tools`` array actually sent to providers — not inflated
Pydantic ``model_json_schema()`` blobs with ``$defs``.

For the system prompt, tokens are further split into sub-rows:
- ``system_skills_tokens``: tokens inside ``<skill_injection>...</skill_injection>``
- ``system_assets_tokens``: tokens inside ``<entity_assets>...</entity_assets>``
- ``system_memory_tokens``: tokens inside ``<!-- memory:`` / ``<!-- memory: reference only-->`` blocks
"""

from __future__ import annotations

import contextvars
import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from evoflow.context.compaction_token_utils import count_text_tokens

logger = logging.getLogger(__name__)

# Small JSON-array / ChatML framing on top of serialized tool specs.
_TOOLS_ARRAY_FRAMING_TOKENS = 8

_GATE_OVERHEAD_META: contextvars.ContextVar[dict[str, int] | None] = contextvars.ContextVar(
    "evoflow_gate_overhead_meta",
    default=None,
)


@dataclass(frozen=True)
class ModelCallOverheadEstimate:
    system_tokens: int
    tools_tokens: int
    tool_count: int
    system_skills_tokens: int = 0
    system_assets_tokens: int = 0
    system_memory_tokens: int = 0

    @property
    def total(self) -> int:
        return self.system_tokens + self.tools_tokens

    def to_meta(self) -> dict[str, int]:
        return {
            "system_tokens": self.system_tokens,
            "tools_tokens": self.tools_tokens,
            "tool_count": self.tool_count,
            "system_skills_tokens": self.system_skills_tokens,
            "system_assets_tokens": self.system_assets_tokens,
            "system_memory_tokens": self.system_memory_tokens,
        }


def set_gate_overhead_meta(meta: dict[str, int] | None) -> contextvars.Token:
    return _GATE_OVERHEAD_META.set(meta)


def reset_gate_overhead_meta(token: contextvars.Token) -> None:
    _GATE_OVERHEAD_META.reset(token)


def current_gate_overhead_meta() -> dict[str, int] | None:
    return _GATE_OVERHEAD_META.get()


# ---- Section markers used to split system-prompt tokens ----
# Match <skill_injection> ... </skill_injection>
_RE_SKILL_INJECTION = re.compile(r"<skill_injection\b.*?</skill_injection>", re.DOTALL | re.IGNORECASE)
# Match <entity_assets> ... </entity_assets>
_RE_ENTITY_ASSETS = re.compile(r"<entity_assets\b.*?</entity_assets>", re.DOTALL | re.IGNORECASE)
# Match <!-- memory: ... -->  (also the reference-only variant)
_RE_MEMORY_BLOCK = re.compile(r"<!--\s*memory\s*:.*?-->", re.IGNORECASE)


def _system_message_text(request: Any) -> str:
    sm = getattr(request, "system_message", None) or getattr(request, "system", None)
    if sm is None:
        return ""
    text = getattr(sm, "content", sm) if not isinstance(sm, str) else sm
    if isinstance(text, list):
        parts: list[str] = []
        for block in text:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return str(text) if text else ""


def _extract_system_sub_tokens(text: str, model: str | None) -> tuple[int, int, int]:
    """Return (skills_tokens, assets_tokens, memory_tokens) for known section markers."""
    skills_text = "".join(m.group() for m in _RE_SKILL_INJECTION.finditer(text))
    assets_text = "".join(m.group() for m in _RE_ENTITY_ASSETS.finditer(text))
    memory_text = "".join(m.group() for m in _RE_MEMORY_BLOCK.finditer(text))
    return (
        count_text_tokens(skills_text, model=model) if skills_text else 0,
        count_text_tokens(assets_text, model=model) if assets_text else 0,
        count_text_tokens(memory_text, model=model) if memory_text else 0,
    )


def estimate_system_prompt_tokens(request: Any, *, model: str | None = None) -> int:
    text = _system_message_text(request)
    if not text.strip():
        return 0
    return count_text_tokens(text, model=model)


def wire_openai_tool_spec(tool: Any) -> dict[str, Any] | None:
    """Normalize a bound tool to OpenAI ``{"type":"function","function":{...}}``."""
    if isinstance(tool, dict):
        if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
            return tool
        if isinstance(tool.get("function"), dict):
            return {"type": "function", "function": tool["function"]}
        if "name" in tool and ("parameters" in tool or "input_schema" in tool):
            fn = dict(tool)
            if "parameters" not in fn and "input_schema" in fn:
                fn["parameters"] = fn.pop("input_schema")
            return {"type": "function", "function": fn}
        return tool

    try:
        from langchain_core.utils.function_calling import convert_to_openai_tool

        spec = convert_to_openai_tool(tool)
        if isinstance(spec, dict):
            return spec
    except Exception:
        logger.debug("convert_to_openai_tool failed for %r", tool, exc_info=True)

    name = getattr(tool, "name", None) or getattr(tool, "__name__", None) or "tool"
    description = getattr(tool, "description", "") or ""
    args = getattr(tool, "args", None)
    return {
        "type": "function",
        "function": {
            "name": str(name),
            "description": str(description),
            "parameters": args if isinstance(args, dict) else {"type": "object", "properties": {}},
        },
    }


def wire_openai_tools_array(tools: Sequence[Any]) -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []
    for tool in tools:
        spec = wire_openai_tool_spec(tool)
        if isinstance(spec, dict) and spec:
            specs.append(spec)
    return specs


def estimate_bound_tools_tokens(tools: Sequence[Any], *, model: str | None = None) -> tuple[int, int]:
    """Return ``(token_count, tool_count)`` for the provider ``tools`` JSON array."""
    specs = wire_openai_tools_array(tools)
    if not specs:
        return 0, 0
    try:
        blob = json.dumps(specs, ensure_ascii=False, separators=(",", ":"), default=str)
    except Exception:
        blob = str(specs)
    tokens = count_text_tokens(blob, model=model) + _TOOLS_ARRAY_FRAMING_TOKENS
    return tokens, len(specs)


def estimate_model_call_overhead(request: Any, *, model: str | None = None) -> ModelCallOverheadEstimate:
    """System prompt + wire-format tool schemas (matches provider request body)."""
    system_text = _system_message_text(request)
    system_tokens = count_text_tokens(system_text, model=model) if system_text.strip() else 0
    skills_tok, assets_tok, memory_tok = _extract_system_sub_tokens(system_text, model=model)
    tools = getattr(request, "tools", None) or []
    tools_tokens, tool_count = estimate_bound_tools_tokens(tools, model=model)
    return ModelCallOverheadEstimate(
        system_tokens=system_tokens,
        tools_tokens=tools_tokens,
        tool_count=tool_count,
        system_skills_tokens=skills_tok,
        system_assets_tokens=assets_tok,
        system_memory_tokens=memory_tok,
    )
