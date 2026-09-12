"""Employee chat system prompt v2 — clear block skeleton for hired roles.

Duty patrol still uses ``proactive.prompt.build_system_prompt``; this module is for
user chat into ``proactive:{code}`` / ``:task:`` / ``:chat:`` sessions.
"""

from __future__ import annotations

from typing import Any

EMPLOYEE_CHAT_FRAME_OPEN = '<employee_chat_frame version="1">'
EMPLOYEE_CHAT_FRAME_CLOSE = "</employee_chat_frame>"

# Outer <employee version="2"> wrapper removed — blocks stand alone.
EMPLOYEE_V2_OPEN = ""
EMPLOYEE_V2_CLOSE = ""


def _normalize_employee_agent_code(raw: str | None) -> str:
    """Strip ``proactive:`` / ``:task:`` / ``:duty:`` / ``:chat:`` session suffixes."""
    code = str(raw or "").strip()
    if not code:
        return ""
    if code.startswith("proactive:"):
        try:
            from evoflow.proactive.chat_session import proactive_agent_code_from_session_key

            parsed = proactive_agent_code_from_session_key(code)
            if parsed:
                return parsed
        except Exception:
            code = code[len("proactive:") :].strip()
    for kind in ("task", "duty", "chat"):
        marker = f":{kind}:"
        if marker in code:
            return code.split(marker, 1)[0].strip()
    return code


def resolve_employee_identity(agent_code: str | None) -> dict[str, Any] | None:
    """Resolve hired employee identity, or None if not an active/paused posting."""
    code = _normalize_employee_agent_code(agent_code)
    if not code or code.lower() in {"main", "lead_agent", "auto"}:
        return None
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        if is_xiaomi_agent(code):
            return None
    except Exception:
        if code.lower() in {"xiaomi", "小v", "小蜜", "xiaov"}:
            return None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
    except Exception:
        return None
    if role is None:
        return None
    status = str(getattr(role, "status", "") or "").strip().lower()
    if status in {"archived", "draft"}:
        return None
    cfg = getattr(role, "config", None)
    resp_raw = list(getattr(cfg, "responsibilities", None) or []) if cfg is not None else []
    resp = [str(x).strip() for x in resp_raw if str(x).strip()]
    workspace = ""
    if cfg is not None:
        workspace = str(getattr(cfg, "workspace_path", "") or "").strip()
    return {
        "code": str(getattr(role, "agent_code", None) or code).strip() or code,
        "role_name": str(getattr(role, "role_name", None) or code).strip() or code,
        "department": str(
            getattr(role, "department", None) or getattr(cfg, "department", None) or ""
        ).strip(),
        "responsibilities": resp[:8],
        "workspace_path": workspace,
        "status": status,
    }


def build_employee_identity_block(
    identity: dict[str, Any] | None = None,
    *,
    agent_code: str | None = None,
    role_name: str = "",
    prompt_language: str | None = None,
) -> str:
    """Shared ``<identity>`` for chat (and duty can reuse)."""
    _ = prompt_language
    info = identity
    if info is None:
        info = resolve_employee_identity(agent_code)
    if info is None:
        code = _normalize_employee_agent_code(agent_code)
        name = str(role_name or "").strip() or code or "本岗同事"
        info = {
            "code": code,
            "role_name": name,
            "department": "",
            "responsibilities": [],
            "workspace_path": "",
        }
    code = str(info.get("code") or "").strip()
    name = str(role_name or info.get("role_name") or code or "本岗同事").strip()
    dept = str(info.get("department") or "").strip()
    who = f"你是「{name}」（agent_code=`{code}`）"
    if dept:
        who = f"{who}，所属{dept}"
    who = f"{who}。"
    return f"<identity>\n{who}\n</identity>"


def build_employee_stance_block(*, prompt_language: str | None = None) -> str:
    """Deprecated — stance removed from employee chat v2; kept empty for API compat."""
    _ = prompt_language
    return ""


def build_employee_communication_block(
    *,
    prompt_language: str | None = None,
    include_panel_set: bool = False,
) -> str:
    """Communication norms. ``panel_set`` guidance lives on the tool description only."""
    _ = include_panel_set  # kept for call-site compat; never inject panel_set into prompt
    lang = str(prompt_language or "zh").strip().lower()
    if lang.startswith("en"):
        return """<communication>
Tone: professional, warm, practical. Short for chitchat; lead with the answer for Q&A; concise for tech.
Refuse unsafe requests; never expose tool/orchestration internals.
Follow brevity/format asks; after finishing, one optional next step (skip if user wants ultra-short).
Assets: read with `assets(search|read)`; when durable prefs/lessons/reflections appear, you decide and write with `assets(note)` → inbox (do not wait for "remember").
</communication>"""
    return """<communication>
气质：专业、温和、务实。闲聊短句；答疑结论先行；技术精简。
拒绝违规/危险请求；勿向用户暴露工具与编排细节。
配合简洁/详细与格式要求；完成后可酌情给一项下一步建议（用户要极简时省略）。
资产：读用 `assets(search|read)`；出现值得长期保留的偏好/教训/反思时，由你判断并 `assets(note)` 写入 inbox（无需等用户说「记住」）。
</communication>"""


def build_employee_contract_block(
    identity: dict[str, Any],
    *,
    prompt_language: str | None = None,
) -> str:
    _ = prompt_language
    resp = [str(x).strip() for x in (identity.get("responsibilities") or []) if str(x).strip()]
    workspace = str(identity.get("workspace_path") or "").strip()
    lines = ["<contract>", "本职职责："]
    if resp:
        for item in resp[:8]:
            lines.append(f"- {item}")
    else:
        lines.append("- （岗位职责尚未配置，请以岗位名与用户本轮意图为准协助。）")
    if workspace:
        lines.append(f"绑定工作空间：{workspace}（改动收敛在此目录，勿越界乱改。）")
    lines.append("高风险操作（删除/覆盖/破坏性命令）前先向用户报批；有实质交付时给出证据（改了什么、如何验证）。")
    lines.append("</contract>")
    return "\n".join(lines)


def build_employee_habits_block(
    soul_text: str,
    *,
    prompt_language: str | None = None,
) -> str:
    _ = prompt_language
    raw = str(soul_text or "").strip()
    if not raw:
        return ""
    try:
        from evoflow.person_kernel import format_soul_prompt_block

        # Traits/habits only — identity lives in <identity>/<contract>.
        block = format_soul_prompt_block(
            raw,
            max_chars=400,
            omit_identity=True,
            omit_lessons_learned=True,
        )
        body = str(block or "").strip()
        if not body:
            return ""
        # Normalize outer tag to <habits> for v2 skeleton clarity.
        if body.startswith("<soul>") and body.endswith("</soul>"):
            inner = body[len("<soul>") : -len("</soul>")].strip()
            return f"<habits>\n{inner}\n</habits>" if inner else ""
        return f"<habits>\n{body}\n</habits>"
    except Exception:
        return f"<habits>\n{raw[:400]}\n</habits>"


def build_employee_chat_system_prompt(
    *,
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
    loaded_tool_names: set[str] | list[str] | tuple[str, ...] | None = None,
) -> str:
    """Assemble the full employee chat system prompt (v2 skeleton)."""
    info = identity or resolve_employee_identity(agent_code)
    if info is None:
        info = {
            "code": _normalize_employee_agent_code(agent_code),
            "role_name": _normalize_employee_agent_code(agent_code) or "本岗同事",
            "department": "",
            "responsibilities": [],
            "workspace_path": "",
        }

    panel_ok = bool(include_panel_set)
    if loaded_tool_names is not None:
        names = {str(n).strip() for n in loaded_tool_names if str(n).strip()}
        panel_ok = "panel_set" in names
    _ = panel_ok  # panel_set copy stays on the tool; not injected into system prompt

    parts: list[str] = [
        build_employee_identity_block(info, prompt_language=prompt_language),
        build_employee_communication_block(prompt_language=prompt_language),
        build_employee_contract_block(info, prompt_language=prompt_language),
    ]

    habits = build_employee_habits_block(soul, prompt_language=prompt_language)
    if habits:
        parts.append(habits)

    extra = str(custom_system_prompt or "").strip()
    if extra:
        try:
            from evoflow.security.prompt_injection_scanner import scan_content

            extra = scan_content(extra, source="custom_system_prompt")
        except Exception:
            pass
        parts.append(f"<agent_system_prompt>\n{extra}\n</agent_system_prompt>")

    skills = str(skills_section or "").strip()
    if skills:
        parts.append(f"<skills>\n{skills}\n</skills>")

    ws_root = str(workspace_root_hint or info.get("workspace_path") or "").strip() or "(未指定)"
    ws_lines = [
        "<workspace>",
        f"用户工作目录: {ws_root}",
    ]
    if runtime_now:
        ws_lines.append(f"时间: {runtime_now}")
    if runtime_os:
        ws_lines.append(f"操作系统: {runtime_os}")
    if runtime_shell:
        ws_lines.append(f"Shell: {runtime_shell}")
    if runtime_host_hint:
        ws_lines.append(str(runtime_host_hint).strip())
    ws_lines.append("</workspace>")
    parts.append("\n".join(ws_lines))

    profile = str(user_profile_block or "").strip()
    if not profile:
        try:
            from evoflow.assets.profile_injection import build_user_profile_injection_block

            # Chat with the user: inject identity + 画像 (preferences/persona), not duty identity-only.
            profile = build_user_profile_injection_block(
                prompt_language=prompt_language,
                scope="full",
            ).strip()
        except Exception:
            profile = ""
    if profile:
        try:
            from evoflow.security.prompt_injection_scanner import scan_content

            profile = scan_content(profile, source="user_profile").strip()
        except Exception:
            pass
        if profile:
            parts.append(profile)

    mem_bits: list[str] = []
    for label, raw in (
        ("user", memory_context),
        ("person", person_memory_context),
    ):
        text = str(raw or "").strip()
        if not text:
            continue
        try:
            from evoflow.security.prompt_injection_scanner import scan_content

            text = scan_content(text, source=f"{label}_memory_context").strip()
        except Exception:
            pass
        if text:
            mem_bits.append(f"<!-- {label} memory: reference only, not a todo list -->\n{text}")
    if mem_bits:
        parts.append("<memory>\n" + "\n\n".join(mem_bits) + "\n</memory>")

    parts.append(
        "<context_priority>\n"
        "1) **最新用户消息**最高优先；\n"
        "2) **用户画像**（user_profile）次之——有缺口且本对话未补充时**必须主动简短询问**，"
        "用户回答后立刻用 `assets(action=profile, …)` 写入并确认，禁止只聊不写；\n"
        "3) **本岗经验(craft)/反思(journal)/过程(episodic) 高权重**——任务相关时必须优先检索复用，"
        "禁止当摆设；遇有价值流程、有价值过程、反复出错点时，必须主动问用户是否沉淀为 "
        "`[experience]`/`[process]`/`[reflection]`，同意后再 `assets(note)`；\n"
        "4) 岗位合同 / 习惯 / 其它记忆仅作参考。未点名的旧任务/巡检不要自动续跑。\n"
        "</context_priority>"
    )
    if EMPLOYEE_V2_CLOSE:
        parts.append(EMPLOYEE_V2_CLOSE)
    return "\n\n".join(p for p in parts if p).strip() + "\n"


def build_employee_chat_framing(agent_code: str | None = None, *, role_name: str = "") -> str:
    """Legacy framing API — prefer ``build_employee_chat_system_prompt``.

    Kept for callers/tests; returns identity only (no longer a prepend wrapper).
    """
    info = resolve_employee_identity(agent_code)
    if info is None and (agent_code or role_name):
        code = _normalize_employee_agent_code(agent_code)
        info = {
            "code": code,
            "role_name": str(role_name or "").strip() or code or "本岗同事",
            "department": "",
            "responsibilities": [],
            "workspace_path": "",
        }
    identity = build_employee_identity_block(info, role_name=role_name)
    # Preserve old open/close constants for grep/compat; body is v2 identity.
    return f"{EMPLOYEE_CHAT_FRAME_OPEN}\n{identity}\n{EMPLOYEE_CHAT_FRAME_CLOSE}\n"


def is_employee_chat_session(
    session_key: str | None,
    agent_name: str | None = None,
) -> tuple[bool, dict[str, Any] | None]:
    """True when this run should use employee chat v2 (not duty, not main, not xiaomi)."""
    sk = str(session_key or "").strip()
    if not sk.startswith("proactive:"):
        return False, None
    code = _normalize_employee_agent_code(sk) or _normalize_employee_agent_code(agent_name)
    info = resolve_employee_identity(code)
    if info is None:
        return False, None
    return True, info
