from __future__ import annotations

import json
import platform
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from evoflow.debug.trace_sink import debug_file_path


def _log_paths() -> list[Path]:
    return [debug_file_path("collab_lifecycle_cn.log")]


def log_collab_lifecycle_cn(阶段: str, 数据: dict[str, Any]) -> None:
    """写入协作生命周期中文关键日志（JSONL）。"""
    try:
        row = {
            "时间": datetime.now(UTC).isoformat(),
            "阶段": str(阶段 or "").strip(),
            "关键环境": {
                "系统": platform.system(),
                "系统版本": platform.version(),
                "Python": platform.python_version(),
            },
            **(数据 or {}),
        }
        line = json.dumps(row, ensure_ascii=False) + "\n"
        for p in _log_paths():
            try:
                p.parent.mkdir(parents=True, exist_ok=True)
                with p.open("a", encoding="utf-8") as f:
                    f.write(line)
            except Exception:
                continue
    except Exception:
        return
