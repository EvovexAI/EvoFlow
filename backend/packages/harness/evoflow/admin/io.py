"""Shared JSON I/O helpers for admin commands."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from evoflow.admin.errors import ValidationError


def emit_json(data: Any, *, pretty: bool = True) -> None:
    if pretty:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(data, ensure_ascii=False, separators=(",", ":")))


def emit_error(message: str, *, exit_code: int = 1) -> None:
    emit_json({"error": message}, pretty=True)
    raise SystemExit(exit_code)


def read_json_file(path: str | Path) -> Any:
    p = Path(path)
    if not p.is_file():
        raise ValidationError(f"JSON file not found: {p}")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValidationError(f"Invalid JSON in {p}: {e}") from e


def read_json_stdin() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValidationError("Expected JSON on stdin")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValidationError(f"Invalid JSON on stdin: {e}") from e
