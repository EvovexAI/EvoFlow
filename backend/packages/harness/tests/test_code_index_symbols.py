from pathlib import Path

import pytest

from evoflow.code_index.symbols import extract_symbols


def test_python_ast_extracts_nested_defs():
    text = """
class Outer:
    def method(self):
        pass

async def top_level():
    return 1

def _private():
    pass
"""
    syms = extract_symbols(Path("mod.py"), text)
    names = {s["name"] for s in syms}
    kinds = {s["name"]: s["kind"] for s in syms}
    assert "Outer" in names and kinds["Outer"] == "class"
    assert "method" in names
    assert "top_level" in names
    assert "_private" not in names
    assert any(s.get("parser") == "python_ast" for s in syms)


def test_java_javalang_extracts_class_and_method():
    pytest.importorskip("javalang")
    text = """
package demo;
public class UserService {
    public String findById(String id) { return id; }
}
interface Repo {
    void save();
}
"""
    syms = extract_symbols(Path("UserService.java"), text)
    names = {s["name"] for s in syms}
    assert "UserService" in names
    assert "findById" in names
    assert "Repo" in names
    assert any("java_ast" in str(s.get("parser")) for s in syms)


def test_javascript_regex_fallback_without_tree_sitter():
    text = """
export class Widget {
  render() {}
}
function loadAll() {}
const onClick = () => {}
"""
    syms = extract_symbols(Path("app.js"), text)
    names = {s["name"] for s in syms}
    assert "Widget" in names
    assert "loadAll" in names
    assert "onClick" in names


def test_typescript_regex_interface_and_type():
    text = """
export interface Config { port: number }
export type Handler = (x: string) => void
class App {}
"""
    syms = extract_symbols(Path("app.ts"), text)
    names = {s["name"] for s in syms}
    assert "Config" in names
    assert "Handler" in names
    assert "App" in names
