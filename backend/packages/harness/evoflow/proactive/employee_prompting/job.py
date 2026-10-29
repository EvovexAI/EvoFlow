"""Job description block — one body; system_prompt wins over soul.

Architecture: this block is **L0 job skeleton only**. Durable experience /
process / reflection live in Asset Hub (standing + catalog + on-demand bodies).
Do not dual-write know-how into ``system_prompt``.
"""

from __future__ import annotations

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


def build_employee_job_block(*, soul: str = "", custom_system_prompt: str = "") -> str:
    """One job description. ``system_prompt`` wins; soul is only the fallback copy.

    ``save_agent_config`` copies soul into ``system_prompt`` for the scheduler.
    Never emits both, and never emits ``<habits>``.
    """
    extra = strip_soul_wrapper(custom_system_prompt)
    bare_soul = strip_soul_wrapper(soul)
    body = extra or bare_soul
    body = scan_prompt_piece(body, source="custom_system_prompt")
    if not body:
        return ""
    if "【知识分层】" not in body:
        body = body.rstrip() + _JOB_LAYER_FOOTER
    return f"<agent_system_prompt>\n{body}\n</agent_system_prompt>"
