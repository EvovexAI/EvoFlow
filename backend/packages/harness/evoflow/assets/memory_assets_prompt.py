"""Single ``<memory_assets>`` region: write policy + recalled content.

Gated with the same ``memory_enabled`` / ``assets`` tool switch — when memory is
off, ``strip_memory_xml_blocks`` removes this whole region and the tool is unbound.
"""

from __future__ import annotations

from typing import Any, Literal

MEMORY_ASSETS_TAG = "memory_assets"

Scope = Literal["main", "employee", "compact"]


def memory_assets_policy_text(
    *,
    scope: Scope = "main",
    agent_code: str = "",
    prompt_language: str | None = None,
) -> str:
    """No prose. The switch is runtime: on → inject content; off → this region is absent."""
    _ = (scope, agent_code, prompt_language)
    return ""


def wrap_memory_assets(*parts: str) -> str:
    """Join non-empty parts into one ``<memory_assets>`` block."""
    body = "\n\n".join(p.strip() for p in parts if str(p or "").strip())
    if not body:
        return ""
    return f"<{MEMORY_ASSETS_TAG}>\n{body}\n</{MEMORY_ASSETS_TAG}>"


def build_memory_assets_block(
    *,
    scope: Scope = "main",
    agent_code: str = "",
    prompt_language: str | None = None,
    memory_context: str = "",
    person_memory_context: str = "",
    extra_body_parts: list[str] | None = None,
    include_pending_inbox: bool = False,
    include_policy: bool = True,
) -> str:
    """Build the unified memory+assets region (policy + optional recall)."""
    parts: list[str] = []
    if include_policy:
        parts.append(
            memory_assets_policy_text(
                scope=scope,
                agent_code=agent_code,
                prompt_language=prompt_language,
            )
        )

    user_mem = str(memory_context or "").strip()
    if user_mem:
        parts.append(f"<!-- user memory: reference only -->\n{user_mem}")

    code = str(agent_code or "").strip()
    person_mem = str(person_memory_context or "").strip()
    if person_mem:
        label = (
            f"<!-- person memory: assets/employees/{code}/ ，reference only -->"
            if code
            else "<!-- person memory: reference only -->"
        )
        parts.append(f"{label}\n{person_mem}")

    if include_pending_inbox and code:
        try:
            from evoflow.assets.ad_hoc_note import format_pending_inbox_notes_for_prompt
            from evoflow.assets.paths import EntityRef

            pending = format_pending_inbox_notes_for_prompt(EntityRef("employee", code))
            if pending:
                parts.append(pending)
        except Exception:
            pass

    for extra in extra_body_parts or []:
        e = str(extra or "").strip()
        if e:
            parts.append(e)

    return wrap_memory_assets(*parts)


def build_employee_memory_assets_block(
    identity: dict[str, Any],
    *,
    memory_context: str = "",
    person_memory_context: str = "",
    prompt_language: str | None = None,
) -> str:
    """Employee-chat entry: policy + user/person recall + pending inbox."""
    code = str(identity.get("code") or "").strip() or "employee"
    return build_memory_assets_block(
        scope="employee",
        agent_code=code,
        prompt_language=prompt_language,
        memory_context=memory_context,
        person_memory_context=person_memory_context,
        include_pending_inbox=True,
        include_policy=True,
    )
