from evoflow.code_index.lsp_client import flatten_document_symbols


def test_flatten_hierarchical_document_symbols():
    items = [
        {
            "name": "Outer",
            "kind": 5,
            "range": {"start": {"line": 0, "character": 0}, "end": {"line": 10, "character": 0}},
            "children": [
                {
                    "name": "inner_fn",
                    "kind": 12,
                    "range": {"start": {"line": 2, "character": 4}, "end": {"line": 5, "character": 0}},
                }
            ],
        }
    ]
    out = flatten_document_symbols(items, parser="lsp_python")
    names = [s["name"] for s in out]
    assert names == ["Outer", "inner_fn"]
    assert out[0]["parser"] == "lsp_python"
    assert out[0]["kind"] == "class"
    assert out[1]["line"] == 3


def test_flatten_skips_private_names():
    items = [{"name": "_private", "kind": 12, "range": {"start": {"line": 0}}}]
    assert flatten_document_symbols(items, parser="lsp_python") == []
