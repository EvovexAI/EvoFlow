"""Regression: .tsx must use the tsx grammar, not typescript.

Wrong mapping caused parser.parse() to hang for minutes on normal React files
(e.g. ToolCallBody.tsx), aborting whole-repo index builds and leaving code_vec empty.
"""

from __future__ import annotations

import time
from pathlib import Path

from evoflow.code_index.tree_sitter_core import (
    extract_symbols_tree_sitter,
    language_for_path,
    parse_tree,
    tree_sitter_available,
)

import pytest

pytestmark = pytest.mark.skipif(not tree_sitter_available(), reason="tree-sitter not installed")

_SAMPLE_TSX = """\
import React from "react";

export function Hello({ name }: { name: string }) {
  return (
    <div className="wrap">
      <span>{name}</span>
    </div>
  );
}

function Helper() {
  return <p>x</p>;
}
"""


def test_tsx_suffix_maps_to_tsx_grammar() -> None:
    assert language_for_path(Path("Foo.tsx")) == "tsx"
    assert language_for_path(Path("Foo.ts")) == "typescript"


def test_tsx_parse_and_symbols_complete_quickly(tmp_path: Path) -> None:
    path = tmp_path / "Hello.tsx"
    path.write_text(_SAMPLE_TSX, encoding="utf-8")
    t0 = time.perf_counter()
    parsed = parse_tree(path, _SAMPLE_TSX)
    assert parsed is not None
    root, _src, lang = parsed
    assert lang == "tsx"
    assert root.has_error is False
    syms = extract_symbols_tree_sitter(path, _SAMPLE_TSX) or []
    elapsed = time.perf_counter() - t0
    names = {s["name"] for s in syms}
    assert "Hello" in names
    assert "Helper" in names
    # Wrong grammar historically hung for minutes; keep a generous but tight bound.
    assert elapsed < 2.0, f"tsx extract too slow ({elapsed:.3f}s) — grammar regression?"
