"""Compat shim — canonical SSOT is ``evoflow.proactive.employee_prompting``.

Prefer::

    from evoflow.proactive.employee_prompting import assemble_employee_system_prompt
"""

from __future__ import annotations

from evoflow.proactive.employee_prompting import (  # noqa: F401
    EMPLOYEE_CHAT_FRAME_CLOSE,
    EMPLOYEE_CHAT_FRAME_OPEN,
    EMPLOYEE_V2_CLOSE,
    EMPLOYEE_V2_OPEN,
    _normalize_employee_agent_code,
    assemble_employee_system_prompt,
    build_employee_chat_framing,
    build_employee_chat_system_prompt,
    build_employee_communication_block,
    build_employee_contract_block,
    build_employee_habits_block,
    build_employee_identity_block,
    build_employee_job_block,
    build_employee_memory_policy_block,
    build_employee_platform_block,
    build_employee_session_block,
    build_employee_stance_block,
    is_employee_chat_session,
    resolve_employee_identity,
)

__all__ = [
    "EMPLOYEE_CHAT_FRAME_CLOSE",
    "EMPLOYEE_CHAT_FRAME_OPEN",
    "EMPLOYEE_V2_CLOSE",
    "EMPLOYEE_V2_OPEN",
    "_normalize_employee_agent_code",
    "assemble_employee_system_prompt",
    "build_employee_chat_framing",
    "build_employee_chat_system_prompt",
    "build_employee_communication_block",
    "build_employee_contract_block",
    "build_employee_habits_block",
    "build_employee_identity_block",
    "build_employee_job_block",
    "build_employee_memory_policy_block",
    "build_employee_platform_block",
    "build_employee_session_block",
    "build_employee_stance_block",
    "is_employee_chat_session",
    "resolve_employee_identity",
]
