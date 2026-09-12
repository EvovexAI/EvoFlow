"""Models for the capability registry.

Python/Pydantic port of the data types in
``nomifun-gateway/src/registry/capability.rs``:

* :class:`DangerTier` / :class:`Surface` / :class:`Decision` — the three enums
  that drive the permission matrix.
* :class:`CallerCtx` — the calling-session context (mirrors the Rust struct).
* :class:`ToolSpec` — the MCP ``tools/list`` descriptor emitted per surface.
* :class:`CapabilityMeta` — static metadata for one capability (a dataclass,
  matching the Rust struct's ``name/domain/summary/danger/deny_on/confirm_on``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from pydantic import BaseModel


class DangerTier(Enum):
    """How dangerous an operation is.

    Drives the default per-surface permission decision (see
    :func:`evoflow.capability.registry.default_decision`). Promoted from IDMM's
    regex-on-command heuristic to a first-class, per-capability annotation.
    """

    #: No side effects, no secrets. Always allowed.
    Read = "read"
    #: Creates / modifies state, reversible.
    Write = "write"
    #: Irreversible deletion / reset.
    Destructive = "destructive"
    #: Reads or writes secrets / credentials.
    Sensitive = "sensitive"


class Surface(Enum):
    """Which kind of session is calling.

    Derived from :class:`CallerCtx`: a channel platform marks an external IM
    session; otherwise it is a local desktop session. ``Remote`` is reserved for
    future LAN/web/device sessions.
    """

    #: Local desktop session (companion thread or a plain local conversation).
    Desktop = "desktop"
    #: External IM channel master-agent session (telegram / lark / …).
    Channel = "channel"
    #: Future: remote LAN / web / external-device session.
    Remote = "remote"


class Decision(Enum):
    """The pre-dispatch gate outcome."""

    #: Execute the handler.
    Allow = "allow"
    #: Refuse until the agent restates the action and re-calls with ``confirm=True``.
    Confirm = "confirm"
    #: Hard-refuse on this surface regardless of confirmation.
    Deny = "deny"


class CallerCtx(BaseModel):
    """Calling-session context.

    Mirrors the Rust ``CallerCtx``. The permission surface is derived from
    ``remote`` (takes precedence) and ``channel_platform`` via
    :meth:`surface`.
    """

    #: True when the call arrives through the remote front door (LAN/web/device).
    remote: bool = False
    #: Set for an external IM channel master-agent session (telegram / lark / …).
    channel_platform: Optional[str] = None
    #: Identity of the calling user.
    user_id: str = ""
    #: Identifier of the companion thread, if any.
    companion_id: Optional[str] = None

    def surface(self) -> Surface:
        """Resolve the permission surface this caller acts on.

        ``remote`` takes precedence over ``channel_platform``; absence of both
        yields :attr:`Surface.Desktop`.
        """
        if self.remote:
            return Surface.Remote
        if self.channel_platform is not None:
            return Surface.Channel
        return Surface.Desktop


class ToolSpec(BaseModel):
    """The MCP ``tools/list`` descriptor for one capability on a surface.

    Emitted by :meth:`evoflow.capability.registry.CapabilityRegistry.tool_specs`.
    """

    #: MCP tool name.
    name: str
    #: Coarse domain label (for diagnostics / grouping).
    domain: str
    #: LLM-facing description.
    description: str
    #: JSON Schema object for the tool's arguments (MCP ``inputSchema``).
    input_schema: dict
    #: Danger tier — drives the default permission decision.
    danger: DangerTier


@dataclass
class CapabilityMeta:
    """Static metadata for one capability.

    All fields are plain values so the registry is cheap to build and the bridge
    can list tools with zero allocation beyond the schema. Matches the Rust
    ``CapabilityMeta`` struct's ``name/domain/summary/danger/deny_on/confirm_on``.
    """

    #: MCP tool name. Convention: ``<domain>_<verb_object>``, lower_snake.
    name: str
    #: Coarse domain label (for diagnostics / grouping).
    domain: str
    #: LLM-facing one-line description.
    summary: str
    #: Danger tier — drives the default permission decision.
    danger: DangerTier
    #: Surfaces where this capability is hard-denied regardless of confirmation
    #: (escape hatch beyond the danger matrix, e.g. a Write too risky for IM).
    deny_on: list[Surface] = field(default_factory=list)
    #: Surfaces where this capability additionally requires confirmation
    #: (escape hatch to force confirm on an otherwise-allowed surface).
    confirm_on: list[Surface] = field(default_factory=list)

    def confirmable(self) -> bool:
        """Whether this capability can require a ``confirm=True`` on ANY surface.

        Used to decide whether to inject the ``confirm`` property into its schema.
        Mirrors the Rust ``CapabilityMeta::confirmable``.
        """
        return self.danger in (DangerTier.Destructive, DangerTier.Sensitive) or bool(
            self.confirm_on
        )
