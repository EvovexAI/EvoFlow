"""Human-gate tools: graph turn ends (``goto END``) until the user acts in EvoPanel or chat.

Not the same as the user clicking **Stop** on stream — that is run cancellation.

Human-gate pattern (LangGraph):
  ``Command(update={"messages": [ToolMessage(...)]}, goto=END)``

Transcript rule:
  Call ``persist_transcript_tool_message_now`` when emitting the gate ToolMessage so
  ``seq`` is fixed before the user's follow-up row (clarify answer, approval, etc.).
"""

from __future__ import annotations

from typing import Literal

from evoflow.agents.tool_approval_config import RISK_AUTO, TOOL_RISK_LEVELS, tool_requires_approval

HumanGateKind = Literal["clarification", "tool_approval"]

# Fixed tool name → gate kind (middleware may intercept)
HUMAN_GATE_TOOL_KINDS: dict[str, HumanGateKind] = {
    "ask_clarification": "clarification",
}

# Dynamic: any tool whose risk level is session or confirm (derived from TOOL_RISK_LEVELS)
# Updated automatically — no manual maintenance needed when tools are added.
HUMAN_GATE_APPROVAL_TOOL_NAMES = frozenset(
    name for name, level in TOOL_RISK_LEVELS.items() if level != RISK_AUTO
) | {"worker"}  # worker has dynamic risk — always routed through approval middleware

# Stable transcript message_id prefix per kind (see persist_transcript_tool_message_now)
HUMAN_GATE_MESSAGE_ID_PREFIX: dict[HumanGateKind, str] = {
    "clarification": "clarify-tool",
    "tool_approval": "approval-pending",
}

# User follow-up markers (EvoPanel / chat) — used by UI & plan_guard, not exhaustive here
USER_RESPONSE_MARKERS: dict[HumanGateKind, tuple[str, ...]] = {
    "clarification": ("__EVF_CLARIFY_ANS_V1__:",),
    "tool_approval": (
        "__evf_tool_approval_v1__:",
        "__evf_tool_approval_replay_v1__:",
    ),
}


def human_gate_kind_for_tool(tool_name: str) -> HumanGateKind | None:
    name = str(tool_name or "").strip().lower()
    if not name:
        return None
    kind = HUMAN_GATE_TOOL_KINDS.get(name)
    if kind:
        return kind
    if tool_requires_approval(name):
        return "tool_approval"
    return None


def message_id_prefix_for_gate(kind: HumanGateKind) -> str:
    return HUMAN_GATE_MESSAGE_ID_PREFIX.get(kind, "gate-tool")
