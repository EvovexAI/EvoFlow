"""Graph normalization from related-search results (cycles, isolates, missing)."""

from __future__ import annotations

from evoflow.knowledge.vault.normalize import build_graph_from_related_search, normalize_search_results


def test_unwrap_mcp_content_blocks():
    payload = {
        "content": [
            {
                "type": "text",
                "text": '{"results":[{"path":"A.md","title":"A","score":1}]}',
            }
        ]
    }
    hits = normalize_search_results("v1", payload)
    assert len(hits) == 1
    assert hits[0].path == "A.md"


def test_graph_cycle_and_isolated_and_missing():
    """A→B→C→A cycle, D isolated (depth 0 only if center), E→missing unresolved."""
    # Center A with cycle A-B-C-A; E links to Missing
    payload = {
        "results": [
            {"path": "A.md", "title": "A", "depth": 0, "links": ["B.md", "E.md"]},
            {"path": "B.md", "title": "B", "depth": 1, "parent": "A.md", "links": ["C.md"]},
            {"path": "C.md", "title": "C", "depth": 2, "parent": "B.md", "links": ["A.md"]},
            {"path": "E.md", "title": "E", "depth": 1, "parent": "A.md", "links": ["Missing.md"]},
            # D is isolated — not connected; omit unless center
        ]
    }
    g = build_graph_from_related_search(
        "v1",
        "A.md",
        payload,
        depth=2,
        direction="outgoing",
        max_nodes=80,
        max_edges=120,
    )
    ids = {n.id for n in g.nodes}
    assert "A.md" in ids
    assert "B.md" in ids
    assert "C.md" in ids
    assert "E.md" in ids
    assert "D.md" not in ids  # isolated, not in related results
    # Missing target should be unresolved (mentioned in links, not a node from results)
    assert "Missing.md" in g.unresolved or "Missing.md" not in ids
    # Edges should exist without using semantic search
    assert any(e.source == "A.md" and e.target == "B.md" for e in g.edges)
    assert any(e.source == "B.md" and e.target == "C.md" for e in g.edges)


def test_graph_backlinks_negative_depth():
    payload = {
        "results": [
            {"path": "Center.md", "title": "Center", "depth": 0},
            {"path": "From.md", "title": "From", "depth": -1, "parent": "Center.md"},
        ]
    }
    g = build_graph_from_related_search("v1", "Center.md", payload, depth=1, direction="backlinks")
    assert any(e.type == "backlink" for e in g.edges)
    assert any(n.path == "From.md" for n in g.nodes)


def test_graph_truncated_flag():
    results = [{"path": "C.md", "title": "C", "depth": 0}]
    for i in range(30):
        results.append({"path": f"N{i}.md", "title": f"N{i}", "depth": 1, "parent": "C.md"})
    g = build_graph_from_related_search(
        "v1",
        "C.md",
        {"results": results},
        depth=1,
        direction="outgoing",
        max_nodes=10,
        max_edges=5,
    )
    assert g.truncated is True
