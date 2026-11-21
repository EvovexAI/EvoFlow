"""page_dump evaluate fallback must keep JS string escapes intact."""

from evoflow.tools.builtins.panel_engine import build_page_dump_evaluate_expr


def test_page_dump_expr_keeps_js_newline_escape() -> None:
    expr = build_page_dump_evaluate_expr(max_turns=5, max_chars_per_turn=200)
    # JS source must contain the two-char sequence \n inside join('...'),
    # not a real newline (which breaks ExecuteScript → null).
    assert "lines.join('\\n')" in expr
    join_idx = expr.index("lines.join(")
    snippet = expr[join_idx : join_idx + 20]
    assert "\n" not in snippet
    assert "kind:'page_dump'" in expr
    assert "maxTurns=5" in expr
    assert "maxChars=200" in expr


def test_page_dump_expr_clamps_bounds() -> None:
    expr = build_page_dump_evaluate_expr(max_turns=0, max_chars_per_turn=10)
    assert "maxTurns=1" in expr
    assert "maxChars=80" in expr
