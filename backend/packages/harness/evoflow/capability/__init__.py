"""Capability registry core framework.

A Python/Pydantic port of nomifun-tauri's ``nomifun-gateway/src/registry/capability.rs``.
The single source of truth for one operable platform capability: its MCP tool
name, LLM-facing description, JSON Schema (generated from a Pydantic model),
danger tier, per-surface permission policy, and handler.

Design rule (ported from Rust): a capability owns ONE typed request model ``P``.
Its JSON Schema is generated from ``P`` (``model.model_json_schema()``), its
runtime arguments are validated into the SAME ``P``, and the handler receives a
typed ``P``. Schema, validation, and execution can no longer disagree.
"""

from __future__ import annotations

from .models import (
    CallerCtx,
    CapabilityMeta,
    DangerTier,
    Decision,
    Surface,
    ToolSpec,
)
from .registry import (
    Capability,
    CapabilityRegistry,
    capability,
    decide,
    default_decision,
    get_registry,
)

__all__ = [
    "CallerCtx",
    "Capability",
    "CapabilityMeta",
    "CapabilityRegistry",
    "DangerTier",
    "Decision",
    "Surface",
    "ToolSpec",
    "capability",
    "decide",
    "default_decision",
    "get_registry",
]
