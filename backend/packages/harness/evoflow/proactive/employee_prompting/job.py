"""Job description block — one body; system_prompt wins over soul."""

from __future__ import annotations

from evoflow.proactive.employee_prompting._scan import scan_prompt_piece, strip_soul_wrapper


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
