"""Tests for exploration graph diagram helpers."""

from evoflow.exploration_graph.diagram import (
    detect_diagram_type_from_source,
    diagram_type_label,
    enrich_diagram_meta,
    is_diagram_node,
    normalize_diagram_type,
)


def test_normalize_diagram_type_aliases() -> None:
    assert normalize_diagram_type("seq") == "sequence"
    assert normalize_diagram_type("flow") == "flowchart"


def test_detect_diagram_type_from_source() -> None:
    assert detect_diagram_type_from_source("sequenceDiagram\n  A->>B: hi") == "sequence"
    assert detect_diagram_type_from_source("```mermaid\nflowchart TD\n  A --> B\n```") == "flowchart"
    assert detect_diagram_type_from_source("plain text") == ""


def test_enrich_diagram_meta_from_body() -> None:
    meta = enrich_diagram_meta(meta={}, kind="diagram", body="stateDiagram-v2\n  [*] --> On")
    assert meta["diagram_type"] == "state"
    assert meta["diagram_lang"] == "mermaid"


def test_enrich_diagram_meta_explicit_type() -> None:
    meta = enrich_diagram_meta(meta={}, kind="note", diagram_type="er", body="erDiagram\n  A ||--o{ B : has")
    assert meta["diagram_type"] == "er"


def test_diagram_type_label_zh() -> None:
    assert diagram_type_label("sequence") == "时序图"
    assert diagram_type_label("unknown") == "图表"


def test_is_diagram_node() -> None:
    assert is_diagram_node("diagram", "diagram:foo")
    assert is_diagram_node("note", "diagram:foo")
    assert not is_diagram_node("file", "file:x.py")
