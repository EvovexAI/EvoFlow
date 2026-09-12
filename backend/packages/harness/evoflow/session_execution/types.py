from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SessionStopResult:
    ok: bool = True
    session_key: str = ""
    run_id: str | None = None
    phase: str = "done"
    cancelled_run_ids: list[str] = field(default_factory=list)
    session: dict[str, Any] | None = None
