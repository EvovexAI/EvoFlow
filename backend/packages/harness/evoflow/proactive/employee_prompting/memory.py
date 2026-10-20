"""Memory assets region for the employee skeleton (recall only — no second profile)."""

from __future__ import annotations

import re
from typing import Any

from evoflow.proactive.employee_prompting._scan import scan_prompt_piece

_PROFILE_TAG_RE = re.compile(
    r"<(?:user_profile|user_identity)\b[^>]*>[\s\S]*?</(?:user_profile|user_identity)>\s*",
    re.IGNORECASE,
)


def _strip_profile_tags(text: str) -> str:
    """Drop profile/identity blocks — those belong in ``<session>`` once."""
    return _PROFILE_TAG_RE.sub("", str(text or "")).strip()


def build_employee_memory_policy_block(
    identity: dict[str, Any],
    *,
    memory_context: str = "",
    person_memory_context: str = "",
    prompt_language: str | None = None,
) -> str:
    """``<memory_assets>``: user/person recall + inbox. No duplicate user_identity."""
    from evoflow.assets.memory_assets_prompt import build_employee_memory_assets_block

    return build_employee_memory_assets_block(
        identity,
        memory_context=scan_prompt_piece(
            _strip_profile_tags(memory_context), source="user_memory_context"
        ),
        person_memory_context=scan_prompt_piece(
            person_memory_context, source="person_memory_context"
        ),
        prompt_language=prompt_language,
    )
