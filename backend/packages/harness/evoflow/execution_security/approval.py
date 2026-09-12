"""AskForApproval semantics + bridge from EvoFlow tool_approval policies.

Phase 0 only defines the decision surface. Shell still goes through the
existing tool_approval middleware; this module is the single place to map
EvoFlow policy names onto native-style approval intensity so Phase 1–2 can
route all shell decisions here without double-prompting.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class AskForApproval(str, Enum):
    """Ask-for-approval intensity (kebab-case wire values)."""

    UNTRUSTED = "untrusted"  # UnlessTrusted
    ON_REQUEST = "on-request"
    NEVER = "never"


@dataclass(frozen=True)
class ApprovalDecision:
    """Whether the caller should interrupt for user confirmation."""

    needs_approval: bool
    reason: str
    ask: AskForApproval
    evoflow_policy: str | None = None


def normalize_ask(raw: AskForApproval | str | None) -> AskForApproval:
    if isinstance(raw, AskForApproval):
        return raw
    s = str(raw or "").strip().lower().replace("_", "-")
    aliases = {
        "unless-trusted": AskForApproval.UNTRUSTED,
        "unless_trusted": AskForApproval.UNTRUSTED,
        "on-failure": AskForApproval.ON_REQUEST,  # runtime alias
        "on_request": AskForApproval.ON_REQUEST,
        "grant-all": AskForApproval.NEVER,
        "grant_all": AskForApproval.NEVER,
    }
    if s in aliases:
        return aliases[s]
    for member in AskForApproval:
        if member.value == s or member.name.lower().replace("_", "-") == s:
            return member
    return AskForApproval.ON_REQUEST


def map_evoflow_policy_to_ask(policy: str | None) -> AskForApproval:
    """Map legacy EvoFlow ``tool_approval`` modes to AskForApproval."""
    m = str(policy or "").strip().lower()
    if m in ("grant_all", "grant-all"):
        return AskForApproval.NEVER
    if m in ("prompt",):
        return AskForApproval.UNTRUSTED
    if m in ("session",):
        return AskForApproval.ON_REQUEST
    return normalize_ask(m) if m else AskForApproval.ON_REQUEST


def decide_shell_approval(
    *,
    ask: AskForApproval | str | None = None,
    evoflow_policy: str | None = None,
    profile_id: str | None = None,
    command: str | None = None,
    already_granted: bool = False,
) -> ApprovalDecision:
    """Decide whether a shell command should pause for user approval.

    This is intentionally conservative and does **not** replace the existing
    middleware yet: when ``already_granted`` is True (session grant / prior
    approve), we skip. ``danger-full-access`` + ``never`` also skips.
    """
    policy = evoflow_policy
    resolved = normalize_ask(ask) if ask is not None else map_evoflow_policy_to_ask(policy)
    cmd = (command or "").strip()
    profile = str(profile_id or "").strip().lower()

    if already_granted:
        return ApprovalDecision(
            needs_approval=False,
            reason="already_granted",
            ask=resolved,
            evoflow_policy=policy,
        )

    if resolved is AskForApproval.NEVER:
        return ApprovalDecision(
            needs_approval=False,
            reason="ask_never",
            ask=resolved,
            evoflow_policy=policy,
        )

    if profile in ("danger-full-access", ":danger-full-access", "danger_full_access"):
        if resolved is AskForApproval.ON_REQUEST:
            # Full access still asks under OnRequest for destructive shell by default;
            # Phase 2 can refine with runtime execpolicy. For now: no extra gate here.
            return ApprovalDecision(
                needs_approval=False,
                reason="danger_full_access_on_request_deferred",
                ask=resolved,
                evoflow_policy=policy,
            )

    if not cmd:
        return ApprovalDecision(
            needs_approval=False,
            reason="empty_command",
            ask=resolved,
            evoflow_policy=policy,
        )

    if resolved is AskForApproval.UNTRUSTED:
        return ApprovalDecision(
            needs_approval=True,
            reason="untrusted_requires_approval",
            ask=resolved,
            evoflow_policy=policy,
        )

    # OnRequest: model/tool layer still drives prompts via existing middleware;
    # this helper marks shell as "should consult approval UI" for new call sites.
    return ApprovalDecision(
        needs_approval=True,
        reason="on_request_shell",
        ask=resolved,
        evoflow_policy=policy,
    )


def decision_as_dict(decision: ApprovalDecision) -> dict[str, Any]:
    return {
        "needs_approval": decision.needs_approval,
        "reason": decision.reason,
        "ask": decision.ask.value,
        "evoflow_policy": decision.evoflow_policy,
    }
