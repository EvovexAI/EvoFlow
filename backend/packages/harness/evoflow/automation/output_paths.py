"""Canonical deliverable paths for prompt-only automation runs."""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path

from evoflow.config.paths import get_paths

_SAFE_SEGMENT_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_DEFAULT_EXT = "md"


def _slug_segment(text: str, *, fallback: str = "report") -> str:
    raw = (text or "").strip()
    if not raw:
        return fallback
    ascii_part = _SAFE_SEGMENT_RE.sub("-", raw).strip("-._")
    if ascii_part:
        return ascii_part[:48]
    # Non-ASCII names (e.g. 每日AI日报) → stable short id prefix.
    return fallback


def resolve_automation_outputs_root() -> Path:
    """``~/.evoflow/outputs/automations/`` (created on demand)."""
    root = get_paths().base_dir / "outputs" / "automations"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _normalize_ext(ext: str | None) -> str:
    e = str(ext or _DEFAULT_EXT).strip().lstrip(".")
    if not e or "/" in e or "\\" in e:
        return _DEFAULT_EXT
    return e[:12]


def _format_output_template(
    template: str,
    *,
    automation_id: str,
    automation_name: str,
    run_id: str,
    run_date: datetime,
) -> str:
    ymd = run_date.strftime("%Y%m%d")
    ymd_dash = run_date.strftime("%Y-%m-%d")
    slug = _slug_segment(automation_name, fallback=automation_id[:16] or "report")
    mapping = {
        "automation_id": automation_id,
        "automation_name": automation_name,
        "run_id": run_id,
        "date": ymd,
        "date_dash": ymd_dash,
        "slug": slug,
        "ext": _DEFAULT_EXT,
    }
    out = template
    for key, val in mapping.items():
        out = out.replace("{" + key + "}", val)
    return out.strip()


def resolve_automation_deliverable_path(
    automation_id: str,
    *,
    automation_name: str = "",
    run_id: str = "",
    run_at: datetime | None = None,
    output_template: str | None = None,
    ext: str | None = None,
) -> Path:
    """Absolute host path for one automation run deliverable.

    Default layout::

        ~/.evoflow/outputs/automations/{automation_id}/{YYYYMMDD}.md

    Optional TOML ``output_path`` template (relative to ``outputs/`` or absolute)::

        automations/{automation_id}/{date}-{slug}.{ext}
    """
    aid = str(automation_id or "").strip()
    if not aid:
        raise ValueError("automation_id is required")

    when = run_at or datetime.now(timezone.utc)
    ext_norm = _normalize_ext(ext)
    name = str(automation_name or "").strip()
    rid = str(run_id or "").strip()

    tpl = str(output_template or "").strip()
    if tpl:
        rel = _format_output_template(
            tpl,
            automation_id=aid,
            automation_name=name,
            run_id=rid,
            run_date=when,
        )
        if not rel.endswith(f".{ext_norm}") and "." not in Path(rel).name:
            rel = f"{rel.rstrip('/')}.{ext_norm}"
        p = Path(rel).expanduser()
        if p.is_absolute():
            target = p
        else:
            # Strip leading outputs/ so templates can be written either way.
            rel_s = rel.replace("\\", "/").lstrip("/")
            if rel_s.startswith("outputs/"):
                rel_s = rel_s[len("outputs/") :]
            target = get_paths().base_dir / "outputs" / rel_s
    else:
        ymd = when.strftime("%Y%m%d")
        target = resolve_automation_outputs_root() / aid / f"{ymd}.{ext_norm}"

    target.parent.mkdir(parents=True, exist_ok=True)
    return target.resolve()


def automation_deliverable_rel_path(abs_path: Path | str) -> str:
    """Workspace-relative path under ``outputs/`` for UI cards."""
    p = Path(abs_path).expanduser().resolve()
    outputs_root = (get_paths().base_dir / "outputs").resolve()
    try:
        rel = p.relative_to(outputs_root)
        return f"outputs/{rel.as_posix()}"
    except ValueError:
        return str(p).replace("\\", "/")


def automation_output_instructions(abs_path: Path | str, *, rel_path: str = "") -> str:
    """Prompt block instructing the agent to write the deliverable file."""
    abs_s = str(Path(abs_path).expanduser().resolve()).replace("\\", "/")
    rel_s = str(rel_path or automation_deliverable_rel_path(abs_s)).replace("\\", "/")
    home = str(get_paths().base_dir).replace("\\", "/")
    return (
        "【交付文件 · 必须遵守】\n"
        f"1. 将完整结果写入文件（使用 write / write_to_file 工具）：\n"
        f"   绝对路径：{abs_s}\n"
        f"   相对路径（工作区）：{rel_s}\n"
        f"2. 结案时必须用 tasks 工具 outputs 数组登记该文件，例如：\n"
        f'   [{{"type":"file","key":"report","label":"交付报告","value":"{abs_s}"}}]\n'
        f"3. **禁止**在文件未成功写入前将任务标记为 completed。\n"
        f"4. 工作区根目录为 {home}；不要使用其它随意路径（如 outputs/ai-daily-report-*.md）。\n"
    )
