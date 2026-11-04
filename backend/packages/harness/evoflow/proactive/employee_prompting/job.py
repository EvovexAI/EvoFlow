"""Job + soul L0 blocks for employee prompts.

Architecture: L0 is **duty skeleton** (``system_prompt``) plus optional **style**
(``SOUL.md``). Durable experience / process / reflection live in Asset Hub
(standing + catalog + on-demand bodies). Do not dual-write know-how into
``system_prompt``.
"""

from __future__ import annotations

import re
from typing import Any

from evoflow.proactive.employee_prompting._scan import scan_prompt_piece, strip_soul_wrapper

DUTY_PROMPT_SECTION = "## 岗位职责"

# Appended once so the model sees the SoT boundary next to the job text.
# Do not embed literal ``<memory_assets>`` here — tests / strip_memory_xml treat that tag
# as the real memory region; a mention in the job footer would false-positive.
_JOB_LAYER_FOOTER = (
    "\n\n---\n"
    "【知识分层】本块 = 岗位职责骨架（L0）。踩坑 / 制度演进 / 样本路径 / 可复用做法 "
    "→ 资产 catalog + standing（L1/L2），细节用 `assets` read/search（L3）。"
    "禁止把经验全文再写进本说明书或 `agents.update` system_prompt。"
)


def merge_duty_into_system_prompt(
    system_prompt: str = "",
    responsibilities: Any = None,
) -> str:
    """Merge legacy role responsibilities into agent system_prompt (idempotent).

    Used by edit UI, create/update employee, assemble (inject-time), and overlap.
    Does not write to disk — callers decide persistence.
    """
    sp = str(system_prompt or "").strip()
    lines: list[str] = []
    if isinstance(responsibilities, str):
        lines = [ln.strip() for ln in responsibilities.splitlines() if ln.strip()]
    elif isinstance(responsibilities, (list, tuple)):
        for item in responsibilities:
            if isinstance(item, str) and "\n" in item:
                lines.extend(part.strip() for part in item.splitlines() if part.strip())
            else:
                s = str(item or "").strip()
                if s:
                    lines.append(s)
    if not lines:
        return sp
    if DUTY_PROMPT_SECTION in sp:
        return sp
    if all(line in sp for line in lines):
        return sp
    block = DUTY_PROMPT_SECTION + "\n" + "\n".join(f"- {line}" for line in lines)
    return f"{sp}\n\n{block}" if sp else block


def _strip_identity_wrappers(text: str) -> str:
    t = strip_soul_wrapper(text)
    raw = str(t or "").strip()
    for tag in ("agent_system_prompt", "soul"):
        open_t, close_t = f"<{tag}>", f"</{tag}>"
        if raw.startswith(open_t) and raw.endswith(close_t):
            raw = raw[len(open_t) : -len(close_t)].strip()
    return raw


def _normalize_job_body(text: str) -> str:
    """Collapse markdown noise so mirrored soul/system_prompt dedupe correctly."""
    t = _strip_identity_wrappers(text)
    t = re.sub(r"^#+\s*", "", t, flags=re.MULTILINE)
    t = t.replace("**", "").replace("__", "").replace("*", "")
    return re.sub(r"\s+", " ", t).strip().casefold()


def _with_job_footer(body: str) -> str:
    text = str(body or "").strip()
    if not text:
        return ""
    if "【知识分层】" not in text:
        text = text.rstrip() + _JOB_LAYER_FOOTER
    return text


def build_employee_job_block(*, soul: str = "", custom_system_prompt: str = "") -> str:
    """Emit L0 layers: ``<agent_system_prompt>`` (duty) then ``<soul>`` (style).

    - Distinct soul and system_prompt → both tags (duty first, soul below).
    - Same / near-duplicate (scheduler often mirrors soul into system_prompt) → one
      ``<agent_system_prompt>`` only.
    - Only soul → ``<agent_system_prompt>`` with soul body (duty fallback).
    - Never emits ``<habits>``.
    """
    bare_soul = _strip_identity_wrappers(soul)
    bare_extra = _strip_identity_wrappers(custom_system_prompt)
    safe_soul = scan_prompt_piece(bare_soul, source="soul") if bare_soul else ""
    safe_extra = (
        scan_prompt_piece(bare_extra, source="custom_system_prompt") if bare_extra else ""
    )

    parts: list[str] = []
    same = bool(
        safe_soul
        and safe_extra
        and (
            safe_soul == safe_extra
            or _normalize_job_body(safe_soul) == _normalize_job_body(safe_extra)
        )
    )

    if safe_soul and safe_extra and not same:
        duty = _with_job_footer(safe_extra)
        parts.append(f"<agent_system_prompt>\n{duty}\n</agent_system_prompt>")
        parts.append(f"<soul>\n{safe_soul}\n</soul>")
    else:
        body = _with_job_footer(safe_extra or safe_soul)
        if body:
            parts.append(f"<agent_system_prompt>\n{body}\n</agent_system_prompt>")

    return "\n\n".join(parts)
