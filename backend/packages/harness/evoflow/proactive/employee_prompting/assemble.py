"""Single employee system-prompt assembler: mode=chat|duty."""

from __future__ import annotations

from typing import Any, Literal

from evoflow.proactive.models import ProactiveRole

EmployeePromptMode = Literal["chat", "duty"]

DUTY_BRIEF_OPEN = '<proactive_duty_brief version="1">'
DUTY_BRIEF_CLOSE = "</proactive_duty_brief>"
DUTY_CONTRACT_MARKER = "<proactive_duty_brief"

EMPLOYEE_CHAT_FRAME_OPEN = '<employee_chat_frame version="1">'
EMPLOYEE_CHAT_FRAME_CLOSE = "</employee_chat_frame>"
EMPLOYEE_V2_OPEN = ""
EMPLOYEE_V2_CLOSE = ""


def _resolve_job_sources(
    role: ProactiveRole | None,
    *,
    soul: str = "",
    custom_system_prompt: str = "",
) -> tuple[str, str]:
    """Return (soul, system_prompt) with agent config preferred for duty."""
    job_soul = str(soul or "").strip()
    job_sp = str(custom_system_prompt or "").strip()
    if role is None:
        return job_soul, job_sp

    code = str(role.agent_code or "").strip()
    try:
        extra = role.config.extra_context if isinstance(role.config.extra_context, dict) else {}
        inherit = not bool(extra.get("override_capabilities"))
    except Exception:
        inherit = True

    if inherit and code:
        try:
            from evoflow.config.agents_config import load_agent_config, load_agent_soul

            if not job_sp:
                agent_cfg = load_agent_config(code)
                if agent_cfg and agent_cfg.system_prompt:
                    job_sp = str(agent_cfg.system_prompt).strip()
            if not job_soul:
                agent_soul = (load_agent_soul(code) or "").strip()
                if agent_soul:
                    job_soul = agent_soul
        except Exception:
            pass

    if not job_soul:
        job_soul = str(getattr(role.config, "soul_md", None) or "").strip()
    return job_soul, job_sp


def _identity_from_role(role: ProactiveRole) -> dict[str, Any]:
    cfg = role.config
    resp = [str(x).strip() for x in (cfg.responsibilities or []) if str(x).strip()]
    return {
        "code": str(role.agent_code or "").strip(),
        "role_name": str(role.role_name or role.agent_code or "").strip(),
        "department": str(role.department or getattr(cfg, "department", None) or "").strip(),
        "responsibilities": resp[:8],
        "workspace_path": str(cfg.workspace_path or "").strip(),
        "status": str(role.status or "").strip(),
    }


def _resolve_include_memory(
    include_memory: bool | None,
    role: ProactiveRole | None,
) -> bool:
    """Caller override wins; else role ``memory_enabled`` (default True)."""
    if include_memory is not None:
        return bool(include_memory)
    if role is None:
        return True
    try:
        from evoflow.agents.memory.runtime_overrides import role_memory_enabled_from_config

        return role_memory_enabled_from_config(getattr(role, "config", None))
    except Exception:
        return True


def assemble_employee_system_prompt(
    *,
    mode: EmployeePromptMode = "chat",
    role: ProactiveRole | None = None,
    roster: list[ProactiveRole] | None = None,
    query: str = "",
    agent_code: str | None = None,
    identity: dict[str, Any] | None = None,
    soul: str = "",
    skills_section: str = "",
    workspace_root_hint: str = "",
    runtime_os: str = "",
    runtime_shell: str = "",
    runtime_host_hint: str = "",
    runtime_now: str = "",
    memory_context: str = "",
    person_memory_context: str = "",
    user_profile_block: str = "",
    custom_system_prompt: str = "",
    prompt_language: str | None = None,
    include_panel_set: bool = False,
    include_memory: bool | None = None,
    loaded_tool_names: set[str] | list[str] | tuple[str, ...] | None = None,
) -> str:
    """Assemble employee system prompt.

    Shared order: job → org → [duty workflow] → session → memory → [duty resources].

    No system ``<platform>`` shell (identity/tone/contract) — job text owns who you are.
    Builders in ``platform.py`` remain for callers/tests that want them explicitly.

    ``include_memory``: when False, skip ``<memory_assets>`` and duty person memory/craft.
    When None, use role ``config.memory_enabled`` (default on). Session/runtime override
    is applied later by DynamicSystemPrompt / strip_memory_xml_blocks.
    """
    _ = include_panel_set
    _ = loaded_tool_names

    if mode == "duty" and role is not None:
        try:
            from evoflow.agents.xiaomi.duty import build_xiaomi_duty_system_prompt
            from evoflow.agents.xiaomi.identity import is_xiaomi_agent

            if is_xiaomi_agent(role.agent_code):
                return build_xiaomi_duty_system_prompt(role)
        except Exception:
            pass

    from evoflow.proactive.employee_prompting.duty_extras import (
        build_duty_resources_block,
        build_standard_workflow_section,
    )
    from evoflow.proactive.employee_prompting.identity import (
        identity_or_fallback,
        load_role_for_code,
    )
    from evoflow.proactive.employee_prompting.job import build_employee_job_block
    from evoflow.proactive.employee_prompting.memory import build_employee_memory_policy_block
    from evoflow.proactive.employee_prompting.collab_rules import build_employee_collab_block
    from evoflow.proactive.employee_prompting.org_roster import build_employee_org_roster_block
    from evoflow.proactive.employee_prompting.session import build_employee_session_block

    duty_role = role
    if duty_role is None and agent_code:
        duty_role = load_role_for_code(agent_code)

    if identity is not None:
        info = identity
    elif duty_role is not None:
        info = _identity_from_role(duty_role)
    else:
        info = identity_or_fallback(None, agent_code=agent_code)

    mem_on = _resolve_include_memory(include_memory, duty_role)

    job_soul, job_sp = _resolve_job_sources(
        duty_role,
        soul=soul,
        custom_system_prompt=custom_system_prompt,
    )

    org_detail = "full" if mode == "duty" else "compact"
    org_role = duty_role
    if org_role is None and info.get("code"):
        org_role = load_role_for_code(str(info.get("code")))

    docs_rel = ""
    if mode == "duty" and duty_role is not None:
        try:
            from evoflow.proactive.artifacts import role_docs_rel_dir

            docs_rel = role_docs_rel_dir(duty_role)
        except Exception:
            docs_rel = ""

    # job → org roster (people) → collab rules (task flow) → [duty workflow] → …
    parts: list[str] = [
        build_employee_job_block(soul=job_soul, custom_system_prompt=job_sp),
        build_employee_org_roster_block(org_role, roster=roster, detail=org_detail),
        build_employee_collab_block(org_role, roster=roster),
    ]

    if mode == "duty" and duty_role is not None:
        parts.append(
            build_standard_workflow_section(duty_role, roster=roster, docs_rel=docs_rel)
        )

    # Duty: skills live in duty_resources; chat uses caller skills_section.
    session_skills = "" if mode == "duty" else skills_section
    ws_hint = workspace_root_hint
    if not ws_hint and duty_role is not None:
        ws_hint = str(duty_role.config.workspace_path or "").strip()

    parts.append(
        build_employee_session_block(
            info,
            skills_section=session_skills,
            workspace_root_hint=ws_hint,
            runtime_os=runtime_os,
            runtime_shell=runtime_shell,
            runtime_host_hint=runtime_host_hint,
            runtime_now=runtime_now,
            user_profile_block=user_profile_block,
            prompt_language=prompt_language,
        )
    )
    if mem_on:
        parts.append(
            build_employee_memory_policy_block(
                info,
                memory_context=memory_context,
                person_memory_context=person_memory_context,
                prompt_language=prompt_language,
            )
        )

    if mode == "duty" and duty_role is not None:
        parts.append(
            build_duty_resources_block(
                duty_role,
                query=query,
                include_memory=mem_on,
            )
        )

    if EMPLOYEE_V2_CLOSE:
        parts.append(EMPLOYEE_V2_CLOSE)

    body = "\n\n".join(p for p in parts if p).strip() + "\n"
    if mode == "duty":
        if DUTY_CONTRACT_MARKER in body:
            return body
        return f"{DUTY_BRIEF_OPEN}\n{body}{DUTY_BRIEF_CLOSE}\n"
    return body


def build_employee_chat_system_prompt(**kwargs: Any) -> str:
    """Compat: chat mode assemble."""
    kwargs.pop("mode", None)
    return assemble_employee_system_prompt(mode="chat", **kwargs)


def build_employee_chat_framing(agent_code: str | None = None, *, role_name: str = "") -> str:
    """Legacy framing API — identity only."""
    from evoflow.proactive.employee_prompting.identity import (
        identity_or_fallback,
        resolve_employee_identity,
    )
    from evoflow.proactive.employee_prompting.platform import build_employee_identity_block

    info = resolve_employee_identity(agent_code)
    if info is None and (agent_code or role_name):
        info = identity_or_fallback(None, agent_code=agent_code, role_name=role_name)
    identity = build_employee_identity_block(info, role_name=role_name)
    return f"{EMPLOYEE_CHAT_FRAME_OPEN}\n{identity}\n{EMPLOYEE_CHAT_FRAME_CLOSE}\n"
