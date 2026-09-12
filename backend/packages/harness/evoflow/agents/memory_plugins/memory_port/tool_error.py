"""JSON tool errors for Hermes-ported memory plugins."""

from __future__ import annotations

import json


def tool_error(message: str, **extra) -> str:
    result: dict = {"error": str(message)}
    if extra:
        result.update(extra)
    return json.dumps(result, ensure_ascii=False)
