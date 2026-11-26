"""Parallel platform 生图 must not raise INVALID_CONCURRENT_GRAPH_UPDATE.

Regression (2026-11-26 manju-director): batch generate_image wrote multiple
``viewed_images`` Commands in one step. ``ViewImageMiddlewareState`` declared a
plain dict; ``create_agent`` merges schemas via a ``set`` so that plain field
could overwrite ``ThreadState``'s Annotated merge → LastValue channel →
「At key 'viewed_images': Can receive only one value per step」.
"""

from __future__ import annotations

from typing import get_type_hints, get_origin, Annotated

from langchain.agents import AgentState
from langchain.agents.factory import _resolve_schema
from langgraph.channels.binop import BinaryOperatorAggregate
from langgraph.graph.state import _get_channels

from evoflow.agents.middlewares.view_image_middleware import ViewImageMiddlewareState
from evoflow.agents.thread_state import ThreadState, merge_viewed_images


def test_view_image_middleware_state_keeps_merge_reducer() -> None:
    hints = get_type_hints(ViewImageMiddlewareState, include_extras=True)
    viewed = hints["viewed_images"]
    assert get_origin(viewed) is Annotated
    assert merge_viewed_images in viewed.__metadata__


def test_resolved_schema_viewed_images_is_binop_even_if_plain_would_overwrite() -> None:
    """Many middleware schemas + ThreadState: channel must stay BinaryOperatorAggregate."""
    extras = [type(f"_MwState{i}", (AgentState,), {"__annotations__": {}}) for i in range(48)]
    # Intentionally put ViewImageMiddlewareState in the set; order is hash-based.
    state_schemas = set(extras)
    state_schemas.add(ViewImageMiddlewareState)
    state_schemas.add(ThreadState)
    resolved = _resolve_schema(state_schemas, "StateSchema", None)
    channels, _, _ = _get_channels(resolved)
    ch = channels["viewed_images"]
    assert isinstance(ch, BinaryOperatorAggregate), (
        f"viewed_images channel must merge concurrent updates, got {type(ch).__name__}"
    )


def test_merge_viewed_images_combines_parallel_tool_updates() -> None:
    a = {"/a.png": {"path": "/a.png", "mime_type": "image/png", "auto": True}}
    b = {"/b.png": {"path": "/b.png", "mime_type": "image/png", "auto": True}}
    merged = merge_viewed_images(a, b)
    assert set(merged) == {"/a.png", "/b.png"}
