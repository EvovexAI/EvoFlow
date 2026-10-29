"""Job description block — one body; system_prompt wins over soul."""

from __future__ import annotations

from typing import Any

from evoflow.proactive.employee_prompting._scan import scan_prompt_piece, strip_soul_wrapper

DUTY_PROMPT_SECTION = "## 岗位职责"


def merge_duty_into_system_prompt(
    system_prompt: str = "",
    responsibilities: Any = None,
) -> str:
    """Merge legacy role responsibilities into agent system_prompt (idempotent).

    Used by edit UI, create/update employee, assemble (inject-time), and overlap.
    Does not write to disk — callers decide persistence.
    """
    sp = str(system_prompt or "").strip()
    lines: list[str] = []
    if isinstance(responsibilities, str):
        lines = [ln.strip() for ln in responsibilities.splitlines() if ln.strip()]
    elif isinstance(responsibilities, (list, tuple)):
        for item in responsibilities:
            if isinstance(item, str) and "\n" in item:
                lines.extend(part.strip() for part in item.splitlines() if part.strip())
            else:
                s = str(item or "").strip()
                if s:
                    lines.append(s)
    if not lines:
        return sp
    if DUTY_PROMPT_SECTION in sp:
        return sp
    if all(line in sp for line in lines):
        return sp
    block = DUTY_PROMPT_SECTION + "\n" + "\n".join(f"- {line}" for line in lines)
    return f"{sp}\n\n{block}" if sp else block


def build_employee_job_block(*, soul: str = "", custom_system_prompt: str = "") -> str:
    """One job description. ``system_prompt`` wins; soul is only the fallback copy.

    ``save_agent_config`` copies soul into ``system_prompt`` for the scheduler.
    Never emits both, and never emits ``<habits>``.
    """
    extra = strip_soul_wrapper(custom_system_prompt)
    bare_soul = strip_soul_wrapper(soul)
    body = extra or bare_soul
    body = scan_prompt_piece(body, source="custom_system_prompt")
    if not body:
        return ""
    return f"<agent_system_prompt>\n{body}\n</agent_system_prompt>"
