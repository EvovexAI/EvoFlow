"""Archive-cascade tests for mind map injection.

Verifies that when a parent flow is archived (resolved/verified/refuted/blocked),
its children (claims, files, gaps) that are still ``active`` are:

1. Excluded from live injection (``select_nodes_for_injection``) — they must NOT
   appear as orphan root nodes in the ``<tree>`` block.
2. Included as compressed summaries (``select_archived_summaries``) — so the
   model retains visibility without full body pollution.

This was the root cause of stale problem nodes polluting the model's context:
``claim:final-summary`` (active) whose parent ``flow:fix-injection`` (resolved)
was injected as an orphan root with full body, causing the model to re-derive
already-solved problems.
"""

from __future__ import annotations

from dataclasses import dataclass

from evoflow.exploration_graph.prompt import (
    _compute_effectively_archived,
    select_archived_summaries,
    select_nodes_for_injection,
)


@dataclass
class _MockNode:
    external_id: str
    kind: str = "note"
    status: str = "active"
    parent_external_id: str | None = None
    title: str = ""
    body: str = ""


def _make_stale_scenario() -> list[_MockNode]:
    """Reproduce the exact pollution scenario from production.

    - ``flow:fix-injection`` is ``resolved`` (archived).
    - ``claim:final-summary`` is ``active`` but its parent is the resolved flow.
    - ``claim:fix-complete`` is ``active`` but its parent is the resolved flow.
    - ``flow:current-task`` is ``active`` (live, should be injected).
    - ``gap:open-question`` is ``active`` under the live flow (should be injected).
    """
    return [
        _MockNode("goal:session", kind="goal", status="active", title="Fix bug"),
        _MockNode(
            "flow:fix-injection",
            kind="flow",
            status="resolved",
            parent_external_id="goal:session",
            title="Old fix branch",
            body="This is a resolved flow with a long body that should NOT be injected.",
        ),
        _MockNode(
            "claim:final-summary",
            kind="claim",
            status="active",  # <-- still active, but parent is resolved
            parent_external_id="flow:fix-injection",
            title="Old conclusion",
            body="STALE BODY: this conclusion was already delivered but the claim status was never updated.",
        ),
        _MockNode(
            "claim:fix-complete",
            kind="claim",
            status="active",  # <-- still active, but parent is resolved
            parent_external_id="flow:fix-injection",
            title="Old fix claim",
            body="STALE BODY: another stale claim under a resolved flow.",
        ),
        _MockNode(
            "flow:current-task",
            kind="flow",
            status="active",
            parent_external_id="goal:session",
            title="Current task",
            body="This is the live flow that SHOULD be injected.",
        ),
        _MockNode(
            "gap:open-question",
            kind="gap",
            status="active",
            parent_external_id="flow:current-task",
            title="Open question",
            body="This gap is under a live flow and SHOULD be injected.",
        ),
    ]


def test_compute_effectively_archived_cascades_to_children() -> None:
    """Children of archived nodes are marked effectively-archived even if active."""
    nodes = _make_stale_scenario()
    archived = _compute_effectively_archived(nodes)
    # Directly archived
    assert "flow:fix-injection" in archived
    # Cascade-archived children (status still 'active' but parent resolved)
    assert "claim:final-summary" in archived
    assert "claim:fix-complete" in archived
    # Live nodes NOT in archived set
    assert "goal:session" not in archived
    assert "flow:current-task" not in archived
    assert "gap:open-question" not in archived


def test_select_nodes_for_injection_excludes_cascade_children() -> None:
    """Cascade-archived children must NOT appear in live injection."""
    nodes = _make_stale_scenario()
    injected = select_nodes_for_injection(nodes, max_nodes=50)
    injected_ids = {n.external_id for n in injected}

    # Stale claims must NOT be injected (they'd become orphan roots)
    assert "claim:final-summary" not in injected_ids
    assert "claim:fix-complete" not in injected_ids
    # Resolved flow must NOT be injected
    assert "flow:fix-injection" not in injected_ids

    # Live nodes SHOULD be injected
    assert "goal:session" in injected_ids
    assert "flow:current-task" in injected_ids
    assert "gap:open-question" in injected_ids


def test_select_archived_summaries_includes_cascade_children() -> None:
    """Cascade-archived children appear as compressed summaries (no body)."""
    nodes = _make_stale_scenario()
    summaries = select_archived_summaries(nodes)
    summary_ids = {n.external_id for n in summaries}

    # Both directly-archived and cascade-archived nodes appear
    assert "flow:fix-injection" in summary_ids
    assert "claim:final-summary" in summary_ids
    assert "claim:fix-complete" in summary_ids

    # Live nodes do NOT appear in archived summaries
    assert "flow:current-task" not in summary_ids
    assert "gap:open-question" not in summary_ids


def test_no_false_cascade_when_parent_is_active() -> None:
    """Children of ACTIVE parents must NOT be cascade-archived."""
    nodes = [
        _MockNode("goal:session", kind="goal", status="active"),
        _MockNode("flow:live", kind="flow", status="active", parent_external_id="goal:session"),
        _MockNode("claim:live-child", kind="claim", status="active", parent_external_id="flow:live"),
    ]
    archived = _compute_effectively_archived(nodes)
    assert archived == set()  # Nothing is archived

    injected = select_nodes_for_injection(nodes, max_nodes=50)
    injected_ids = {n.external_id for n in injected}
    assert "claim:live-child" in injected_ids  # Should be injected


def test_deeply_nested_cascade() -> None:
    """Cascade works for multi-level nesting: flow→gap→claim→file."""
    nodes = [
        _MockNode("flow:parent", kind="flow", status="resolved"),
        _MockNode("gap:child", kind="gap", status="active", parent_external_id="flow:parent"),
        _MockNode("claim:grandchild", kind="claim", status="active", parent_external_id="gap:child"),
        _MockNode("file:great-grandchild", kind="file", status="active", parent_external_id="claim:grandchild"),
    ]
    archived = _compute_effectively_archived(nodes)
    # All descendants of the resolved flow are cascade-archived
    assert archived == {"flow:parent", "gap:child", "claim:grandchild", "file:great-grandchild"}

    injected = select_nodes_for_injection(nodes, max_nodes=50)
    assert injected == []  # Nothing live to inject
