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


def _lines_from_candidate(candidate: dict[str, Any]) -> list[str]:
    """Prefer system_prompt; fall back to responsibilities lines (legacy)."""
    sp = str(candidate.get("system_prompt") or "").strip()
    if sp:
        return [ln.strip() for ln in sp.splitlines() if ln.strip()]
    cand_resp = candidate.get("responsibilities") or []
    if isinstance(cand_resp, str):
        return [x.strip() for x in cand_resp.splitlines() if x.strip()]
    return [str(x).strip() for x in cand_resp if str(x).strip()]


def _lines_from_role(role: ProactiveRole) -> list[str]:
    """Prefer agent system_prompt; fall back to role responsibilities."""
    code = str(role.agent_code or "").strip()
    if code:
        try:
            from evoflow.config.agents_config import load_agent_config
            from evoflow.proactive.employee_prompting.job import merge_duty_into_system_prompt

            agent_cfg = load_agent_config(code)
            sp = str(getattr(agent_cfg, "system_prompt", None) or "").strip() if agent_cfg else ""
            legacy = list(role.config.responsibilities or [])
            merged = merge_duty_into_system_prompt(sp, legacy)
            if merged:
                return [ln.strip() for ln in merged.splitlines() if ln.strip()]
        except Exception:
            pass
    return [str(x).strip() for x in (role.config.responsibilities or []) if str(x).strip()]


def score_role_overlap(
    candidate: dict[str, Any],
    existing: ProactiveRole,
) -> dict[str, Any]:
    """Score overlap between a candidate config and an existing role.

    ``candidate`` keys: system_prompt, responsibilities, role_name, agent_code.
    """
    cand_lines = _lines_from_candidate(candidate)
    exist_lines = _lines_from_role(existing)

    resp_tokens_a: set[str] = set()
    for line in cand_lines:
        resp_tokens_a |= _tokens(line)
    resp_tokens_b: set[str] = set()
    for line in exist_lines:
        resp_tokens_b |= _tokens(line)

    overall = round(_jaccard(resp_tokens_a, resp_tokens_b), 3)
    label = str(existing.role_name or existing.agent_code or "").strip() or existing.agent_code

    return {
        "agent_code": existing.agent_code,
        "role_name": existing.role_name,
        "status": existing.status,
        "responsibilities_overlap": overall,
        "overlap": overall,
        "high": overall >= 0.5,
        "message": (
            f"与「{label}」提示词高度重叠（{int(overall * 100)}%），建议合并或明确分工"
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
