"""Session block: skills, workspace, and (once) user identity/profile."""

from __future__ import annotations

from typing import Any

from evoflow.proactive.employee_prompting._scan import scan_prompt_piece


def build_employee_session_block(
    identity: dict[str, Any],
    *,
    skills_section: str = "",
    workspace_root_hint: str = "",
    runtime_os: str = "",
    runtime_shell: str = "",
    runtime_host_hint: str = "",
    runtime_now: str = "",
    user_profile_block: str = "",
    prompt_language: str | None = None,
) -> str:
    """This-turn context: skills, workspace, and global user profile when it has real facts.

    One global user profile SoT — empty/scaffold dims omitted by the profile builder.
    Profile lives here only — not again inside ``<memory_assets>``.
    """
    parts: list[str] = []
    skills = str(skills_section or "").strip()
    if skills:
        parts.append(f"<skills>\n{skills}\n</skills>")

    ws_root = str(workspace_root_hint or identity.get("workspace_path") or "").strip() or "(未指定)"
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

            # Global user profile; content-only (no empty dims / usage essays).
            profile = build_user_profile_injection_block(
                prompt_language=prompt_language,
                scope="full",
            ).strip()
        except Exception:
            profile = ""
    profile = scan_prompt_piece(profile, source="user_profile")
    if profile:
        parts.append(profile)
    inner = "\n\n".join(parts)
    return f"<session>\n{inner}\n</session>"
