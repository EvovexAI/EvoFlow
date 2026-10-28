"""Employee system-prompt SSOT: one skeleton, mode=chat|duty.

Order: job → ``<employee_org>`` (roster) → ``<employee_collab>`` (handoff) →
[duty extras] → session → memory.

- Org **data**: ``evoflow.proactive.org``
- Org **prompt roster**: ``org_roster.py``
- Task **handoff prompt**: ``collab_rules.py``
- Hire/create **notices**: ``evoflow.admin.org_hire_notice``

Public API::

    assemble_employee_system_prompt(mode=\"chat\"|\"duty\", ...)
    resolve_employee_identity / is_employee_chat_session
    build_employee_chat_system_prompt  # compat → assemble(mode=chat)
"""

from __future__ import annotations

from evoflow.proactive.employee_prompting.assemble import (
    DUTY_BRIEF_CLOSE,
    DUTY_BRIEF_OPEN,
    DUTY_CONTRACT_MARKER,
    EMPLOYEE_CHAT_FRAME_CLOSE,
    EMPLOYEE_CHAT_FRAME_OPEN,
    EMPLOYEE_V2_CLOSE,
    EMPLOYEE_V2_OPEN,
    assemble_employee_system_prompt,
    build_employee_chat_framing,
    build_employee_chat_system_prompt,
)
from evoflow.proactive.employee_prompting.collab_rules import build_employee_collab_block
from evoflow.proactive.employee_prompting.identity import (
    is_employee_chat_session,
    load_role_for_code,
    normalize_employee_agent_code,
    resolve_employee_identity,
)
from evoflow.proactive.employee_prompting.job import (
    DUTY_PROMPT_SECTION,
    build_employee_job_block,
    merge_duty_into_system_prompt,
)
from evoflow.proactive.employee_prompting.memory import build_employee_memory_policy_block
from evoflow.proactive.employee_prompting.org_roster import build_employee_org_roster_block
from evoflow.proactive.employee_prompting.org_section import (
    build_collab_rules_section,
    build_employee_org_section,
    build_org_collab_section,
    build_org_system_section,
)
from evoflow.proactive.employee_prompting.platform import (
    build_employee_communication_block,
    build_employee_contract_block,
    build_employee_habits_block,
    build_employee_identity_block,
    build_employee_platform_block,
    build_employee_stance_block,
)
from evoflow.proactive.employee_prompting.session import build_employee_session_block

# Private name kept for prompt.py / tests that imported underscore helper.
_normalize_employee_agent_code = normalize_employee_agent_code

__all__ = [
    "DUTY_BRIEF_CLOSE",
    "DUTY_BRIEF_OPEN",
    "DUTY_CONTRACT_MARKER",
    "DUTY_PROMPT_SECTION",
    "EMPLOYEE_CHAT_FRAME_CLOSE",
    "EMPLOYEE_CHAT_FRAME_OPEN",
    "EMPLOYEE_V2_CLOSE",
    "EMPLOYEE_V2_OPEN",
    "_normalize_employee_agent_code",
    "assemble_employee_system_prompt",
    "build_collab_rules_section",
    "build_employee_chat_framing",
    "build_employee_chat_system_prompt",
    "build_employee_collab_block",
    "build_employee_communication_block",
    "build_employee_contract_block",
    "build_employee_habits_block",
    "build_employee_identity_block",
    "build_employee_job_block",
    "build_employee_memory_policy_block",
    "build_employee_org_roster_block",
    "build_employee_org_section",
    "build_employee_platform_block",
    "build_employee_session_block",
    "build_employee_stance_block",
    "build_org_collab_section",
    "build_org_system_section",
    "is_employee_chat_session",
    "load_role_for_code",
    "merge_duty_into_system_prompt",
    "normalize_employee_agent_code",
    "resolve_employee_identity",
]
