"""Tree-sitter symbol extraction when optional extra is installed."""

from pathlib import Path

import pytest

from evoflow.code_index.tree_sitter_core import extract_symbols_tree_sitter, tree_sitter_available

pytestmark = pytest.mark.skipif(not tree_sitter_available(), reason="tree-sitter-languages not installed")


def test_python_tree_sitter_symbols():
    text = "class A:\n    def m(self):\n        pass\n\ndef top():\n    pass\n"
    out = extract_symbols_tree_sitter(Path("m.py"), text)
    assert out is not None
    names = {s["name"] for s in out}
    assert "A" in names and "m" in names and "top" in names
    assert any("tree_sitter_python" in str(s.get("parser")) for s in out)


def test_typescript_tree_sitter_symbols():
    text = "export interface Config { x: number }\nexport class App { run() {} }\n"
    out = extract_symbols_tree_sitter(Path("app.ts"), text)
    assert out is not None
    names = {s["name"] for s in out}
    assert "Config" in names and "App" in names
