import tempfile
from pathlib import Path

from evoflow.code_index.store import build_index, merge_search_queries, search_index
from evoflow.tools.arg_coerce import coerce_str_list, normalize_search_query_inputs


def test_coerce_str_list_accepts_json_string():
    assert coerce_str_list('["feishu", "lark"]') == ["feishu", "lark"]
    assert coerce_str_list(["a", "b"]) == ["a", "b"]


def test_pipe_query_syntax():
    primary, extra = normalize_search_query_inputs("飞书|feishu|lark")
    assert primary == "飞书"
    assert extra == ["feishu", "lark"]
    label, explicit = merge_search_queries("飞书|feishu|lark")
    assert label == "飞书 | feishu | lark"
    assert explicit == ["飞书", "feishu", "lark"]


def test_merge_search_queries_with_json_string_aliases():
    label, explicit = merge_search_queries("飞书", queries=coerce_str_list('["feishu", "lark"]'))
    assert "飞书" in label
    assert "feishu" in explicit
    assert "lark" in explicit


def test_build_and_search_code_index():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "main.py").write_text(
            "def hello_world():\n    return 'hi'\n\nclass Greeter:\n    pass\n",
            encoding="utf-8",
        )
        out = build_index(str(root), force=True)
        assert out.get("ok") is True
        assert (out.get("files") or 0) >= 1

        data = search_index(str(root), "hello_world", limit=5)
        symbols = data.get("symbols") or []
        assert any(s.get("name") == "hello_world" for s in symbols)


def test_search_index_splits_natural_language_query():
    """Multi-word LLM queries must still match symbols (not whole-string LIKE)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "channels.py").write_text(
            "class FeishuChannel:\n    '''Feishu IM channel.'''\n    pass\n",
            encoding="utf-8",
        )
        build_index(str(root), force=True)

        data = search_index(str(root), "FeishuChannel feishu channel usage", limit=10)
        terms = data.get("search_terms") or []
        assert "FeishuChannel" in terms

        symbols = data.get("symbols") or []
        assert any(s.get("name") == "FeishuChannel" for s in symbols)


def test_search_index_queries_synonyms_list():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "feishu.py").write_text("class FeishuChannel:\n    pass\n", encoding="utf-8")
        build_index(str(root), force=True)

        data = search_index(
            str(root),
            "FeishuChannel",
            queries=["feishu", "lark"],
            limit=10,
        )
        assert "FeishuChannel" in (data.get("search_terms") or [])
        term_fold = {str(t).casefold() for t in (data.get("search_terms") or [])}
        assert "feishu" in term_fold
        assert "lark" in term_fold
        symbols = data.get("symbols") or []
        assert any(s.get("name") == "FeishuChannel" for s in symbols)


def test_fts_matches_snake_case_in_content():
    """unicode61 + path indexing must find identifiers porter would miss."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "stream.py").write_text(
            "def on_session_message():\n    if event == 'assistant_chunk':\n        pass\n",
            encoding="utf-8",
        )
        build_index(str(root), force=True)
        data = search_index(str(root), "assistant_chunk", limit=10)
        hits = data.get("hits") or []
        paths = {h.get("path") for h in hits}
        assert "stream.py" in paths or any(
            s.get("name") == "on_session_message" for s in (data.get("symbols") or [])
        )


def test_expand_search_terms_splits_path_and_snake():
    from evoflow.code_index.store import _expand_search_terms

    terms = _expand_search_terms("images/generations", explicit_terms=["images/generations"])
    assert "images" in terms
    assert "generations" in terms


def test_fts_matches_camel_case_fragment_after_tokenization():
    """Split CamelCase at index time so partial queries hit without full-tree scan."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "app.tsx").write_text(
            "export function applyAssistantTextDelta() { return 1 }\n",
            encoding="utf-8",
        )
        build_index(str(root), force=True)
        data = search_index(str(root), "TextDelta", limit=10)
        hits = data.get("hits") or []
        paths = {h.get("path") for h in hits}
        assert "app.tsx" in paths


def test_tokenize_splits_camel_case():
    from evoflow.code_index.tokenize import split_identifier, tokens_from_text

    assert "Text" in split_identifier("applyAssistantTextDelta")
    assert "Delta" in split_identifier("applyAssistantTextDelta")
    assert "assistant" in {t.casefold() for t in tokens_from_text("applyAssistantTextDelta")}


def test_build_index_recent_index_only_when_ready(tmp_path):
    from evoflow.code_index.store import _connect, build_index, index_status

    root = tmp_path
    (root / "a.py").write_text("x=1\n", encoding="utf-8")
    build_index(str(root), force=True)

    conn = _connect(str(root))
    conn.execute("DELETE FROM meta")
    conn.commit()
    conn.close()

    assert index_status(workspace_root=str(root)).get("ready") is False

    out = build_index(str(root), force=False)
    assert out.get("reason") != "recent_index"


def test_resolve_search_workspace_root_requires_binding():
    from evoflow.tools.host_direct.workspace_path_guard import (
        NO_WORKSPACE_BOUND,
        resolve_search_workspace_root,
    )

    class _Ctx:
        def get(self, key, default=None):
            return default

    class _Rt:
        context = _Ctx()

    assert resolve_search_workspace_root(runtime=_Rt()) == NO_WORKSPACE_BOUND


def test_build_fts_match_query_and_vs_or():
    from evoflow.code_index.store import _build_fts_match_query

    assert " AND " in _build_fts_match_query(["FeishuChannel", "feishu"], original="x", combine_mode="and")
    assert " OR " in _build_fts_match_query(["feishu", "lark"], original="x", combine_mode="or")


def test_hyphen_variant_expansion():
    from evoflow.code_index.store import _expand_search_terms

    terms = _expand_search_terms("dall-e", explicit_terms=["dall-e"], synonym_mode=True)
    assert "dall-e" in terms
    assert "dalle" in terms


def test_search_index_hyphen_variant_finds_symbol():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "api.py").write_text(
            "def create_dall_e_image():\n    '''uses dall-e endpoint'''\n    pass\n",
            encoding="utf-8",
        )
        build_index(str(root), force=True)
        data = search_index(str(root), "dalle", limit=5)
        hits = data.get("hits") or []
        assert any("api.py" in str(h.get("path") or "") for h in hits)


def test_nl_query_filters_stopwords_from_fts_terms():
    from evoflow.code_index.store import _expand_search_terms, _nl_fts_terms

    terms = _expand_search_terms("FeishuChannel feishu channel usage", synonym_mode=False)
    nl = _nl_fts_terms(terms, primary="FeishuChannel")
    assert "FeishuChannel" in nl
    assert "usage" not in nl


def test_path_scope_empty_does_not_auto_relax():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "backend").mkdir()
        (root / "frontend").mkdir()
        (root / "backend" / "target.py").write_text("class TargetService:\n    pass\n", encoding="utf-8")
        (root / "frontend" / "noise.py").write_text("class TargetService:\n    pass\n", encoding="utf-8")
        build_index(str(root), force=True)
        data = search_index(str(root), "path:backend TargetService", limit=5)
        paths = [str(s.get("path") or "") for s in (data.get("symbols") or [])]
        paths += [str(h.get("path") or "") for h in (data.get("hits") or [])]
        assert all(p.startswith("backend/") for p in paths)
        assert not data.get("path_scope_relaxed")
