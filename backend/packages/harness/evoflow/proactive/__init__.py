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
"""

from evoflow.proactive.decision_gate import DecisionGate
from evoflow.proactive.engine import ProactiveEngine
from evoflow.proactive.models import (
    Approval,
    ApprovalStatus,
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveRole,
    ProactiveRoleConfig,
)
from evoflow.proactive.repositories import (
    ProactiveMemoryRepository,
    ProactiveRepository,
)
from evoflow.proactive.runner import ProactiveRunner

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
