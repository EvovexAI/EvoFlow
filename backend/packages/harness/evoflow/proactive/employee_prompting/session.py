"""Session block: skills, workspace, and (once) user identity/profile."""

from __future__ import annotations

import re
from typing import Any

from evoflow.proactive.employee_prompting._scan import scan_prompt_piece

# 【self-evolution-bot · 2026-11-23 · 第130轮 · 模型:qwen3.8-flash】
# 为什么：场景包占位符 `${ORG_WORKSPACE}` 未展开时会经本块原样注入「用户工作目录:」，
# 模型照着写进回复的文件路径 → 前端点卡片 → 网关 root/path 带占位符 → HTTP 400
# （现网 gateway-2026-11-23.log 09:11 批量实证）。读侧已做容错，这里堵住新增泄漏。
# 改了什么：渲染前剥掉占位符段；全剥空则退到 host 根（与网关读侧同一取值，
# 实测为本机 `profiles/default`，正是 `outputs/` 的父目录），绝不把 `${…}` 印给模型。
_PLACEHOLDER_SEGMENT_RE = re.compile(r"^\$\{[A-Za-z0-9_.]+\}$")


def _strip_placeholder_segments(raw: str) -> str:
    """Drop literal ``${ORG_*}/…`` segments; return '' when nothing real remains."""
    text = str(raw or "").strip()
    if not text or "${" not in text:
        return text
    parts = [p for p in text.replace("\\", "/").split("/") if p]
    kept = [p for p in parts if not _PLACEHOLDER_SEGMENT_RE.match(p.strip())]
    return "/".join(kept)


def _clean_workspace_hint(*candidates: str) -> str:
    """First placeholder-free candidate wins; else host root (never a raw ``${…}``)."""
    for cand in candidates:
        cleaned = _strip_placeholder_segments(str(cand or ""))
        if cleaned:
            return cleaned
    try:
        from evoflow.tools.host_direct.workspace_context import evoflow_home_project_root

        return evoflow_home_project_root()
    except Exception:  # pragma: no cover - best effort only
        return ""


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
    include_user_profile: bool = True,
) -> str:
    """This-turn context: skills, workspace, and global user profile when memory is on.

    One global user profile SoT (``profile/USER.md``) — same document as main chat.
    ``include_user_profile`` follows the memory gate (same as main): off → no profile,
    and do not auto-fetch a fallback. Profile lives here only — not again in
    ``<memory_assets>``.
    """
    parts: list[str] = []
    skills = str(skills_section or "").strip()
    if skills:
        parts.append(f"<skills>\n{skills}\n</skills>")

    ws_root = _clean_workspace_hint(
        str(workspace_root_hint or ""),
        str(identity.get("workspace_path") or ""),
    ) or "(未指定)"
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

    if include_user_profile:
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
