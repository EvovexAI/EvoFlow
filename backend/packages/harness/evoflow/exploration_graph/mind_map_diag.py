"""中文诊断日志 — 思维导图 mind_map_ops 落库链路排查。"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("evoflow.mind_map")


def _fmt_ops(ops: list[dict[str, Any]] | None) -> str:
    if not ops:
        return "无"
    parts: list[str] = []
    for raw in ops[:4]:
        if not isinstance(raw, dict):
            continue
        op = str(raw.get("op") or "?")
        eid = str(raw.get("id") or "")
        title = str(raw.get("title") or raw.get("body") or "")[:40]
        parts.append(f"{op}:{eid or title or '?'}")
    extra = f"+{len(ops)-4}" if len(ops) > 4 else ""
    return ",".join(parts) + extra


def log_mind_map(stage: str, **fields: Any) -> None:
    """统一格式：[思维导图] 阶段 | key=val ..."""
    bits: list[str] = []
    for key, val in fields.items():
        if key == "ops" and isinstance(val, list):
            bits.append(f"ops={_fmt_ops(val)}")
        elif val is None:
            bits.append(f"{key}=null")
        else:
            bits.append(f"{key}={val}")
    logger.debug("[思维导图] %s | %s", stage, " ".join(bits))
