"""Duty overlap detection for proactive roles (O5.3)."""

from __future__ import annotations

import re
from typing import Any

from evoflow.proactive.models import ProactiveRole

_TOKEN_RE = re.compile(r"[\w./\-]+", re.UNICODE)


def _tokens(text: str) -> set[str]:
    raw = str(text or "").strip().lower()
    if not raw:
        return set()
    return {t for t in _TOKEN_RE.findall(raw) if len(t) > 1}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def score_role_overlap(
    candidate: dict[str, Any],
    existing: ProactiveRole,
) -> dict[str, Any]:
    """Score overlap between a candidate config and an existing role.

    ``candidate`` keys: responsibilities, role_name, agent_code.
    """
    cand_resp = candidate.get("responsibilities") or []
    if isinstance(cand_resp, str):
        cand_resp = [x.strip() for x in cand_resp.splitlines() if x.strip()]

    exist_resp = list(existing.config.responsibilities or [])

    resp_tokens_a = set()
    for line in cand_resp:
        resp_tokens_a |= _tokens(line)
    resp_tokens_b = set()
    for line in exist_resp:
        resp_tokens_b |= _tokens(line)

    overall = round(_jaccard(resp_tokens_a, resp_tokens_b), 3)

    return {
        "agent_code": existing.agent_code,
        "role_name": existing.role_name,
        "status": existing.status,
        "responsibilities_overlap": overall,
        "overlap": overall,
        "high": overall >= 0.5,
        "message": (
            f"与「{existing.role_name}」职责高度重叠（{int(overall * 100)}%），建议合并或明确分工"
            if overall >= 0.5
            else ""
        ),
    }


def find_overlaps(
    candidate: dict[str, Any],
    roles: list[ProactiveRole],
    *,
    exclude_agent_code: str = "",
    min_overlap: float = 0.5,
) -> list[dict[str, Any]]:
    """Return high-overlap roles sorted by score desc."""
    exclude = str(exclude_agent_code or "").strip()
    cand_code = str(candidate.get("agent_code") or "").strip()
    out: list[dict[str, Any]] = []
    for role in roles:
        if role.status == "draft":
            continue
        if exclude and role.agent_code == exclude:
            continue
        if cand_code and role.agent_code == cand_code:
            continue
        scored = score_role_overlap(candidate, role)
        if scored["overlap"] >= min_overlap:
            out.append(scored)
    out.sort(key=lambda x: x["overlap"], reverse=True)
    return out
