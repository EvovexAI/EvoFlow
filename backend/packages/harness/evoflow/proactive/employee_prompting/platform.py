"""Optional platform shell (identity / communication / contract).

Not injected by ``assemble_employee_system_prompt`` — job text is enough.
Kept for explicit callers and tests.
"""

from __future__ import annotations

from typing import Any

from evoflow.proactive.employee_prompting.identity import identity_or_fallback


def build_employee_identity_block(
    identity: dict[str, Any] | None = None,
    *,
    agent_code: str | None = None,
    role_name: str = "",
    prompt_language: str | None = None,
) -> str:
    """Shared ``<identity>`` for chat and duty."""
    _ = prompt_language
    info = identity_or_fallback(identity, agent_code=agent_code, role_name=role_name)
    code = str(info.get("code") or "").strip()
    name = str(role_name or info.get("role_name") or code or "本岗同事").strip()
    dept = str(info.get("department") or "").strip()
    who = f"你是「{name}」（agent_code=`{code}`）"
    if dept:
        who = f"{who}，所属{dept}"
    who = f"{who}。"
    return f"<identity>\n{who}\n</identity>"


def build_employee_stance_block(*, prompt_language: str | None = None) -> str:
    """Deprecated — stance removed; kept empty for API compat."""
    _ = prompt_language
    return ""


def build_employee_communication_block(
    *,
    prompt_language: str | None = None,
    include_panel_set: bool = False,
) -> str:
    """Communication norms. ``panel_set`` guidance lives on the tool description only."""
    _ = include_panel_set
    lang = str(prompt_language or "zh").strip().lower()
    if lang.startswith("en"):
        return """<communication>
Tone: professional, warm, practical. Short for chitchat; lead with the answer for Q&A; concise for tech.
Refuse unsafe requests; never expose tool/orchestration internals.
Follow brevity/format asks; after finishing, one optional next step (skip if user wants ultra-short).
</communication>"""
    return """<communication>
气质：专业、温和、务实。闲聊短句；答疑结论先行；技术精简。
拒绝违规/危险请求；勿向用户暴露工具与编排细节。
配合简洁/详细与格式要求；完成后可酌情给一项下一步建议（用户要极简时省略）。
</communication>"""


def build_employee_contract_block(
    identity: dict[str, Any],
    *,
    prompt_language: str | None = None,
) -> str:
    _ = prompt_language
    resp = [str(x).strip() for x in (identity.get("responsibilities") or []) if str(x).strip()]
    workspace = str(identity.get("workspace_path") or "").strip()
    lines = ["<contract>"]
    if resp:
        lines.append("本职职责：")
        for item in resp[:8]:
            lines.append(f"- {item}")
    else:
        # Avoid contradicting a filled <agent_system_prompt> job body.
        lines.append("本职职责：以上方 `<agent_system_prompt>` 作业说明为准。")
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
    """Legacy habits API — assemble path does not emit this."""
    _ = prompt_language
    raw = str(soul_text or "").strip()
    if not raw:
        return ""
    try:
        from evoflow.person_kernel import format_soul_prompt_block

        block = format_soul_prompt_block(
            raw,
            max_chars=400,
            omit_identity=True,
            omit_lessons_learned=True,
        )
        body = str(block or "").strip()
        if not body:
            return ""
        if body.startswith("<soul>") and body.endswith("</soul>"):
            inner = body[len("<soul>") : -len("</soul>")].strip()
            return f"<habits>\n{inner}\n</habits>" if inner else ""
        return f"<habits>\n{body}\n</habits>"
    except Exception:
        return f"<habits>\n{raw[:400]}\n</habits>"


def build_employee_platform_block(
    identity: dict[str, Any],
    *,
    prompt_language: str | None = None,
) -> str:
    """Platform shell: who you are, tone, and contract. Sits under the job prompt."""
    inner = "\n\n".join(
        p
        for p in (
            build_employee_identity_block(identity, prompt_language=prompt_language),
            build_employee_communication_block(prompt_language=prompt_language),
            build_employee_contract_block(identity, prompt_language=prompt_language),
        )
        if p
    )
    return f"<platform>\n{inner}\n</platform>"


__all__ = [
    "build_employee_communication_block",
    "build_employee_contract_block",
    "build_employee_habits_block",
    "build_employee_identity_block",
    "build_employee_platform_block",
    "build_employee_stance_block",
]
