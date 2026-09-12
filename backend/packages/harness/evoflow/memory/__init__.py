"""Unified agent memory on Owned KB engine (mem_* tables).

See ``internal design docs (not published in this repository)``.
"""

from evoflow.memory.facade import (
    consolidate,
    forget,
    get_core,
    list_atoms,
    mark_atom_stale,
    mark_related_memories_stale,
    pin_atom,
    recall,
    remember,
)
from evoflow.memory.namespaces import (
    agent_ns,
    person_ns,
    user_ns,
    workspace_ns,
)

__all__ = [
    "agent_ns",
    "consolidate",
    "forget",
    "get_core",
    "list_atoms",
    "mark_atom_stale",
    "mark_related_memories_stale",
    "person_ns",
    "pin_atom",
    "recall",
    "remember",
    "user_ns",
    "workspace_ns",
]