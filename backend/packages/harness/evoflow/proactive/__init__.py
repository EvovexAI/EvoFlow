"""Proactive AI (智能体员工) module.

Each AI agent acts as a real job-role owner: it proactively wakes up on a
heartbeat schedule, assesses its domain, proposes initiatives, and routes
risky actions through a human Decision Gate (Feishu approval / desktop
notification).  Humans only make decisions; the AI does everything else.

Public API:
    from evoflow.proactive import (
        ProactiveRole, Initiative, Approval, ProactiveMemory,
        ProactiveEngine, DecisionGate, ProactiveRunner,
    )

Lazy attributes (PEP 562) — 2026-11-18 perf fix
-----------------------------------------------
``engine`` and ``runner`` import ``evoflow.models`` (→ langchain → transformers
→ ``torch``) at module scope: 2.5s / 2.4s cold. This package used to re-export
them eagerly, so *any* submodule import — e.g. the
``from evoflow.proactive.repositories import ProactiveRepository`` that runs
inside ``tasks`` list row projection — first executed this ``__init__`` and made
the whole task board pay for the model stack (measured: first
``list_tasks(limit=10)`` 5.4s, subsequent 18ms).

Attributes now resolve on first access, so light consumers (repositories,
models, decision_gate) never touch torch. Behaviour is unchanged for
``from evoflow.proactive import ProactiveEngine`` / ``*`` / attribute access;
tests that ``monkeypatch.setattr`` a real submodule path are unaffected.
"""

from __future__ import annotations

from typing import Any

# 轻量子模块：无模型依赖，保持 eager（也是历史调用方最常走的路径）。
from evoflow.proactive.decision_gate import DecisionGate
from evoflow.proactive.models import (
    Approval,
    ApprovalStatus,
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveMemory,
    ProactiveRole,
    ProactiveRoleConfig,
)
from evoflow.proactive.repositories import (
    ProactiveMemoryRepository,
    ProactiveRepository,
)

# 重量子模块：只在被真正用到时才加载。
_LAZY: dict[str, tuple[str, str]] = {
    "ProactiveEngine": ("evoflow.proactive.engine", "ProactiveEngine"),
    "ProactiveRunner": ("evoflow.proactive.runner", "ProactiveRunner"),
}

__all__ = [
    "ProactiveRole",
    "ProactiveRoleConfig",
    "Initiative",
    "InitiativeStatus",
    "InitiativeActionType",
    "InitiativeRiskLevel",
    "Approval",
    "ApprovalStatus",
    "ProactiveAutonomyLevel",
    "ProactiveMemory",
    "ProactiveRepository",
    "ProactiveMemoryRepository",
    "ProactiveEngine",
    "DecisionGate",
    "ProactiveRunner",
]


def __getattr__(name: str) -> Any:
    target = _LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib

    module_name, attr = target
    value = getattr(importlib.import_module(module_name), attr)
    globals()[name] = value  # cache: only the first access pays
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_LAZY))

