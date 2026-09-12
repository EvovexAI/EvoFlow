"""Tier classification and ordering for local scheduler."""

from __future__ import annotations

from pathlib import Path

from evoflow.config.agent_orchestration_config import get_agent_orchestration_config
from evoflow.scheduler.task_plan import TaskOp

_TIER2_OPS = frozenset({"write", "run"})
_TIER1_OPS = frozenset({"read", "search", "list_dir"})
_ENTRY_NAMES = frozenset(
    {
        "main.py",
        "index.ts",
        "index.tsx",
        "app.py",
        "__main__.py",
        "mod.rs",
    }
)


def _is_tier0_path(path: str | None, tier0_names: set[str]) -> bool:
    if not path:
        return False
    name = Path(path).name
    if name in _ENTRY_NAMES:
        return True
    return name in tier0_names


def classify_ops(ops: list[TaskOp]) -> tuple[list[TaskOp], list[TaskOp], list[TaskOp]]:
    """Return (tier0_serial, tier1_parallel, tier2_serial)."""
    cfg = get_agent_orchestration_config().local_scheduler
    tier0_names = {Path(p).name for p in cfg.tier0_paths}

    tier0: list[TaskOp] = []
    tier1: list[TaskOp] = []
    tier2: list[TaskOp] = []

    for op in ops:
        kind = op.op
        if kind in _TIER2_OPS or kind == "write":
            tier2.append(op)
        elif _is_tier0_path(op.path, tier0_names) or (op.paths and any(_is_tier0_path(p, tier0_names) for p in op.paths)):
            tier0.append(op)
        elif kind in _TIER1_OPS:
            tier1.append(op)
        else:
            tier1.append(op)
    return tier0, tier1, tier2
