"""Capability registry: permission matrix, decision logic, and dispatch.

Python/Pydantic port of ``nomifun-gateway/src/registry/capability.rs``.

Provides:

* :func:`default_decision` — the ``(surface, danger)`` permission matrix.
* :func:`decide` — the final gate decision honoring ``deny_on``/``confirm_on``
  overrides and the caller's ``confirm`` flag.
* :class:`Capability` — one operable capability: metadata + generated schema +
  handler (+ optional streaming handler).
* :class:`CapabilityRegistry` — singleton registry with ``register`` /
  ``tool_specs`` / ``dispatch`` / ``dispatch_stream``.
* :func:`capability` — decorator that builds a :class:`Capability` from a
  function whose first parameter is a Pydantic model, auto-generating the JSON
  Schema via ``model.model_json_schema()``.
* :func:`get_registry` — process-wide singleton accessor.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import typing
from typing import Any, Callable, Optional

from pydantic import BaseModel, ValidationError

from .models import (
    CallerCtx,
    CapabilityMeta,
    DangerTier,
    Decision,
    Surface,
    ToolSpec,
)

# A buffered handler: ``(ctx, args) -> result dict``. The handler receives the
# already-validated Pydantic request model as its second argument.
Handler = Callable[[CallerCtx, Any], dict]
# A streaming handler: ``(ctx, args, sink) -> result dict``. ``sink`` is a
# callable that receives incremental progress values; the handler returns the
# final result dict. Adapters that don't stream just run the buffered Handler.
StreamingHandler = Callable[[CallerCtx, Any, Callable[[Any], None]], dict]
# A callable that receives incremental progress values during a streaming run.
ProgressSink = Callable[[Any], None]


def default_decision(surface: Surface, danger: DangerTier) -> Decision:
    """The default decision for a ``(surface, danger)`` pair.

    The policy matrix from the design spec §4 (identical to nomifun):

    | Surface  | Read | Write | Destructive | Sensitive |
    |----------|------|-------|-------------|-----------|
    | Desktop  | Allow | Allow | Confirm | Confirm |
    | Channel  | Allow | Allow | Deny    | Deny    |
    | Remote   | Allow | Allow | Confirm | Deny    |

    Capability-level ``deny_on`` / ``confirm_on`` overrides refine this in
    :func:`decide`.
    """
    if danger in (DangerTier.Read, DangerTier.Write):
        return Decision.Allow
    if surface == Surface.Desktop:
        # Destructive | Sensitive → Confirm
        return Decision.Confirm
    if surface == Surface.Channel:
        # Destructive | Sensitive → Deny
        return Decision.Deny
    # surface == Remote
    if danger == DangerTier.Destructive:
        return Decision.Confirm
    # Sensitive → Deny
    return Decision.Deny


def decide(meta: CapabilityMeta, surface: Surface, confirmed: bool) -> Decision:
    """Resolve the final gate decision for a capability on a surface.

    Honors the capability's explicit ``deny_on`` / ``confirm_on`` overrides and
    whether the caller already passed ``confirm=True``. Mirrors the Rust
    ``decide`` function exactly.
    """
    if surface in meta.deny_on:
        return Decision.Deny
    base = default_decision(surface, meta.danger)
    if base == Decision.Deny:
        return Decision.Deny
    needs_confirm = base == Decision.Confirm or surface in meta.confirm_on
    if needs_confirm and not confirmed:
        return Decision.Confirm
    return Decision.Allow


def _schema_for_params(model: type[BaseModel]) -> dict:
    """Generate the MCP-facing JSON Schema object for a request model.

    Strips the meta keys Pydantic adds (``title``, ``$defs`` is kept as it may be
    referenced) that MCP clients ignore, and guarantees ``type`` /
    ``properties`` keys exist so clients render an empty-args form rather than
    rejecting the schema. Mirrors the Rust ``schema_for_params``.
    """
    schema = model.model_json_schema()
    schema.pop("title", None)
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    return schema


def _inject_confirm_property(schema: dict) -> None:
    """Add the cross-cutting ``confirm`` argument to a confirm-gated schema.

    Lets the LLM discover the ``confirm`` flag for destructive/sensitive tools.
    Mirrors the Rust ``inject_confirm_property``.
    """
    props = schema.setdefault("properties", {})
    props["confirm"] = {
        "type": "boolean",
        "description": (
            "Set true ONLY after restating the exact destructive/sensitive "
            "action and its target to the user and getting explicit agreement. "
            "Required to execute confirm-gated actions."
        ),
    }


def _strip_confirm(args: dict) -> dict:
    """Remove the gate-only ``confirm`` key before typed validation.

    ``confirm`` is a cross-cutting gate field injected into the schema, not part
    of the request model; drop it so validation would not choke on it.
    """
    args.pop("confirm", None)
    return args


class Capability:
    """One operable capability: metadata + generated schema + handler.

    The single source of truth (ported from Rust): a capability owns ONE typed
    request model ``P``. Its JSON Schema is generated from ``P``
    (``model.model_json_schema()``), incoming arguments are validated into the
    SAME ``P``, and the handler receives a typed ``P``. A validation failure
    returns a structured ``{"error": …}`` the agent can self-correct from — it
    never reaches the handler.
    """

    def __init__(
        self,
        meta: CapabilityMeta,
        input_schema: dict,
        handler: Handler,
        stream_handler: Optional[StreamingHandler] = None,
    ) -> None:
        """Assemble a capability from its parts.

        Prefer :meth:`from_model` (or the :func:`capability` decorator) which
        auto-generate the schema and wrap validation; this constructor is for
        advanced/manual assembly.
        """
        self.meta: CapabilityMeta = meta
        self.input_schema: dict = input_schema
        self.handler: Handler = handler
        self.stream_handler: Optional[StreamingHandler] = stream_handler

    @classmethod
    def from_model(
        cls,
        meta: CapabilityMeta,
        model: type[BaseModel],
        handler: Callable[[CallerCtx, Any], dict],
        stream_handler: Optional[Callable[[CallerCtx, Any, Callable[[Any], None]], dict]] = None,
    ) -> "Capability":
        """Build a capability from a typed request model and a handler.

        ``model`` is the single source: its ``model_json_schema()`` becomes the
        MCP ``inputSchema``, and incoming arguments are validated into ``model``
        before the handler runs. A :class:`ValidationError` returns a structured
        ``{"error": …}`` and never reaches the handler.

        Args:
            meta: Static capability metadata.
            model: The Pydantic request model — single source for schema +
                validation.
            handler: Buffered handler ``(ctx, validated_model) -> result dict``.
            stream_handler: Optional streaming handler
                ``(ctx, validated_model, sink) -> result dict``. When provided,
                :meth:`CapabilityRegistry.dispatch_stream` emits incremental
                progress; the buffered ``handler`` always remains available so
                non-streaming adapters are unaffected.
        """
        input_schema = _schema_for_params(model)
        if meta.confirmable():
            _inject_confirm_property(input_schema)

        def _validated_handler(ctx: CallerCtx, args: dict) -> dict:
            args = _strip_confirm(dict(args))
            try:
                p = model.model_validate(args)
            except ValidationError as e:
                return {"error": f"invalid arguments for this tool: {e}"}
            return handler(ctx, p)

        wrapped_stream: Optional[StreamingHandler] = None
        if stream_handler is not None:

            def _validated_stream(
                ctx: CallerCtx, args: dict, sink: Callable[[Any], None]
            ) -> dict:
                args = _strip_confirm(dict(args))
                try:
                    p = model.model_validate(args)
                except ValidationError as e:
                    return {"error": f"invalid arguments for this tool: {e}"}
                return stream_handler(ctx, p, sink)

            wrapped_stream = _validated_stream

        return cls(meta, input_schema, _validated_handler, wrapped_stream)


def _run_coroutine_sync(coro: Any) -> Any:
    """Run an async capability handler from a synchronous dispatch path.

    Uses a fresh event loop on a worker thread when the caller already has a
    running loop (e.g. FastAPI / MCP stdio bridge), otherwise ``asyncio.run``.
    """

    def _run() -> Any:
        return asyncio.run(coro)

    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None and running.is_running():
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(_run).result()
    return _run()


class CapabilityRegistry:
    """Process-wide registry of capabilities.

    Deps-free (ported from Rust): handlers receive their dependencies as
    arguments at dispatch time, so the registry constructs no services. The
    identical registry therefore serves both an in-process server (which
    dispatches with real deps) and a bridge (which only reads ``tool_specs`` to
    answer ``tools/list``).
    """

    def __init__(self) -> None:
        """Create an empty registry."""
        self._caps: dict[str, Capability] = {}

    def register(self, capability: Capability) -> None:
        """Register a capability under its ``meta.name``.

        Args:
            capability: The :class:`Capability` to register.

        Raises:
            ValueError: If a capability with the same name is already registered.
        """
        if capability.meta.name in self._caps:
            raise ValueError(
                f"capability already registered: {capability.meta.name!r}"
            )
        self._caps[capability.meta.name] = capability

    def get(self, name: str) -> Optional[Capability]:
        """Look up a capability by name, or ``None`` if not registered."""
        return self._caps.get(name)

    def tool_specs(self, surface: Surface) -> list[ToolSpec]:
        """List MCP ``tools/list`` descriptors visible on a surface.

        A capability is visible on a surface unless it is hard-denied there
        (``decide(...) == Deny`` with no confirmation needed to determine that).
        Mirrors the Rust ``Registry::tool_specs`` filtering.

        Args:
            surface: The calling surface.

        Returns:
            The list of :class:`ToolSpec` descriptors for visible capabilities.
        """
        specs: list[ToolSpec] = []
        for cap in self._caps.values():
            # Hard-denied capabilities are hidden from the surface's tool list.
            if decide(cap.meta, surface, confirmed=False) == Decision.Deny:
                continue
            specs.append(
                ToolSpec(
                    name=cap.meta.name,
                    domain=cap.meta.domain,
                    description=cap.meta.summary,
                    input_schema=cap.input_schema,
                    danger=cap.meta.danger,
                )
            )
        return specs

    def dispatch(self, name: str, args: dict, ctx: CallerCtx) -> dict:
        """Dispatch a buffered (non-streaming) tool call.

        Flow (ported from Rust): ``decide()`` → ``Deny`` returns
        ``{"error": "denied"}`` → ``Confirm`` returns
        ``{"needs_confirmation": True}`` → ``Allow`` executes the handler with
        the validated request model.

        Args:
            name: The capability name (``meta.name``).
            args: Raw arguments dict (may contain the gate-only ``confirm`` key).
            ctx: The calling-session context.

        Returns:
            The handler's result dict, or a gate/validation error dict.
        """
        cap = self._caps.get(name)
        if cap is None:
            return {"error": f"unknown capability: {name!r}"}

        confirmed = bool(args.get("confirm", False))
        surface = ctx.surface()
        decision = decide(cap.meta, surface, confirmed)
        if decision == Decision.Deny:
            return {"error": "denied"}
        if decision == Decision.Confirm:
            return {"needs_confirmation": True}
        # Decision.Allow
        result = cap.handler(ctx, args)
        if inspect.iscoroutine(result):
            result = _run_coroutine_sync(result)
        return result

    def dispatch_stream(
        self,
        name: str,
        args: dict,
        ctx: CallerCtx,
        sink: ProgressSink,
    ) -> dict:
        """Dispatch a streaming tool call, emitting incremental progress.

        Same gate flow as :meth:`dispatch`; on ``Allow`` runs the streaming
        handler (if any), feeding ``sink`` with intermediate progress values and
        returning the final result dict. If the capability has no streaming
        handler, falls back to the buffered :meth:`dispatch` path.

        Args:
            name: The capability name (``meta.name``).
            args: Raw arguments dict (may contain the gate-only ``confirm`` key).
            ctx: The calling-session context.
            sink: Callable receiving incremental progress values.

        Returns:
            The handler's final result dict, or a gate/validation error dict.
        """
        cap = self._caps.get(name)
        if cap is None:
            return {"error": f"unknown capability: {name!r}"}

        confirmed = bool(args.get("confirm", False))
        surface = ctx.surface()
        decision = decide(cap.meta, surface, confirmed)
        if decision == Decision.Deny:
            return {"error": "denied"}
        if decision == Decision.Confirm:
            return {"needs_confirmation": True}
        # Decision.Allow
        if cap.stream_handler is not None:
            result = cap.stream_handler(ctx, args, sink)
            if inspect.iscoroutine(result):
                result = _run_coroutine_sync(result)
            return result
        # Fall back to the buffered handler for non-streaming capabilities.
        return self.dispatch(name, args, ctx)


# --- Decorator ---------------------------------------------------------------

def capability(
    name: str,
    domain: str,
    danger: DangerTier,
    summary: str = "",
    deny_on: Optional[list[Surface]] = None,
    confirm_on: Optional[list[Surface]] = None,
    stream: bool = False,
    registry: Optional["CapabilityRegistry"] = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator that builds and registers a :class:`Capability`.

    The decorated function's first parameter (after any ``ctx``) must be
    annotated with a Pydantic model ``P``; its JSON Schema is auto-generated via
    ``model.model_json_schema()`` (the single source for schema + validation),
    matching the Rust ``Capability::new<P>`` pattern.

    The handler signature is ``handler(ctx, p)`` for buffered capabilities, or
    ``handler(ctx, p, sink)`` for streaming ones (``stream=True``).

    Args:
        name: MCP tool name.
        domain: Coarse domain label.
        danger: Danger tier.
        summary: LLM-facing one-line description (defaults to the function
            docstring's first line, or ``name`` if absent).
        deny_on: Surfaces where this capability is hard-denied.
        confirm_on: Surfaces where this capability additionally requires
            confirmation.
        stream: If True, treat the function as a streaming handler
            ``(ctx, p, sink) -> dict``.
        registry: Registry to register into (defaults to the global singleton
            from :func:`get_registry`).

    Returns:
        The original function (unchanged), with the capability registered.

    Raises:
        TypeError: If the function signature lacks a Pydantic-model parameter.
    """

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        # Resolve real types from annotations (handles PEP 563 string annotations
        # when the caller uses ``from __future__ import annotations``).
        try:
            hints = typing.get_type_hints(fn)
        except Exception:
            hints = {}
        sig = inspect.signature(fn)
        params = list(sig.parameters.values())
        # Expect (ctx, p[, sink]) — locate the Pydantic-model request parameter.
        # ``CallerCtx`` is itself a Pydantic model but is the session context, not
        # the request model, so skip any parameter typed as ``CallerCtx``.
        model_param: Optional[inspect.Parameter] = None
        model: Optional[type[BaseModel]] = None
        for p in params:
            ann = hints.get(p.name, p.annotation)
            if isinstance(ann, type) and issubclass(ann, BaseModel) and ann is not CallerCtx:
                model_param = p
                model = ann
                break
        if model_param is None or model is None:
            raise TypeError(
                f"@capability({name!r}): handler {fn.__qualname__!r} must have a "
                "parameter annotated with a Pydantic BaseModel"
            )

        desc = summary
        if not desc:
            doc = inspect.getdoc(fn)
            desc = doc.splitlines()[0] if doc else name

        meta = CapabilityMeta(
            name=name,
            domain=domain,
            summary=desc,
            danger=danger,
            deny_on=list(deny_on) if deny_on else [],
            confirm_on=list(confirm_on) if confirm_on else [],
        )

        if stream:
            def handler(ctx: CallerCtx, p: Any, sink: Callable[[Any], None]) -> dict:
                return fn(ctx, p, sink)

            cap = Capability.from_model(meta, model, handler, stream_handler=handler)  # type: ignore[arg-type]
        else:
            def handler(ctx: CallerCtx, p: Any) -> dict:
                return fn(ctx, p)

            cap = Capability.from_model(meta, model, handler)

        (registry or get_registry()).register(cap)
        return fn

    return decorator


# --- Global singleton --------------------------------------------------------

_registry: Optional[CapabilityRegistry] = None


def get_registry() -> CapabilityRegistry:
    """Return the process-wide :class:`CapabilityRegistry` singleton.

    Lazily created on first call.
    """
    global _registry
    if _registry is None:
        _registry = CapabilityRegistry()
    return _registry
