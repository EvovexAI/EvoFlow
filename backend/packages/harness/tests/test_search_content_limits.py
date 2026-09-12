"""search_content wall-clock, scan limits, and index-backed candidate narrowing."""

from __future__ import annotations

import tempfile
from pathlib import Path

from evoflow.code_index.store import build_index
from evoflow.tools.host_direct import search_content as sc_mod
from evoflow.tools.host_direct.search_content import (
    _attach_no_match_hint,
    _fts_search_terms,
    _is_complex_regex,
    _misuse_hint,
    _run_search_content,
)


def test_fts_term_extraction_pipe_syntax():
    terms = _fts_search_terms("CredentialPool|credential_pool")
    assert "CredentialPool" in terms
    assert "credential_pool" in terms


def test_complex_regex_detection():
    assert _is_complex_regex(r"def \w+\(")
    assert not _is_complex_regex("feishu_channel")


def test_search_content_completes_small_tree():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "a.py").write_text("def feishu_channel(): pass\n", encoding="utf-8")
        out = _run_search_content(
            pattern="feishu",
            path=str(root),
            thread_id=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            glob_pattern="*.py",
            max_results=20,
            max_depth=6,
        )
        assert "feishu" in out.lower() or "a.py" in out


def test_search_content_single_file_path():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        fp = root / "only.js"
        fp.write_text("installModelDetailDelegate\n", encoding="utf-8")
        out = _run_search_content(
            pattern="installModelDetailDelegate",
            path=str(fp),
            thread_id=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            glob_pattern=None,
            max_results=20,
            max_depth=6,
        )
        assert "installModelDetailDelegate" in out
        assert "Workspace root is not a directory" not in out


def test_search_content_index_narrows_candidates():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "hit.py").write_text("class UniqZebraToken: pass\n", encoding="utf-8")
        (root / "noise.py").write_text("class OtherThing: pass\n", encoding="utf-8")
        build_index(str(root), force=True)
        out = _run_search_content(
            pattern="UniqZebraToken",
            path=str(root),
            thread_id=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="files_with_matches",
            glob_pattern="*.py",
            max_results=20,
            max_depth=6,
        )
        assert "index-backed" in out
        assert "hit.py" in out.replace("\\", "/")
        assert "noise.py" not in out.replace("\\", "/")


def test_search_content_timeout_message(monkeypatch):
    def _hang(**_kwargs):
        import time

        time.sleep(0.5)

    monkeypatch.setattr(sc_mod, "_run_search_content", _hang)
    monkeypatch.setattr(sc_mod, "_MAX_WALL_SECONDS", 0.05)
    monkeypatch.setattr(
        "evoflow.tools.host_direct.workspace_path_guard.resolve_filesystem_search_root",
        lambda **_: (".", None),
    )
    from langgraph.prebuilt.tool_node import ToolRuntime

    from evoflow.tools.host_direct.search_content import search_content_hd

    rt = ToolRuntime(
        state={"messages": []},
        context={},
        config={"configurable": {}},
        store=None,
        stream_writer=lambda x: None,
        tool_call_id="tc-1",
    )

    out = search_content_hd.invoke({"pattern": "x", "runtime": rt})
    assert "timed out" in out.lower()


def test_misuse_hint_for_pipe_keyword_list():
    hint = _misuse_hint("dalle|DALL-E|images/generations")
    assert "search_code_index" in hint
    body = _attach_no_match_hint("dalle|dall-e", "(no matches)")
    assert "search_code_index" in body


def test_no_misuse_hint_for_real_regex():
    assert _misuse_hint(r"def \w+\(") == ""


def test_search_content_redirects_pipe_keywords_to_index():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "chat.py").write_text(
            "def applyAssistantTextDelta():\n    pass\n",
            encoding="utf-8",
        )
        build_index(str(root), force=True)
        out = _run_search_content(
            pattern="applyAssistantTextDelta|TextDelta|mergeStream",
            path=str(root),
            thread_id=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            glob_pattern="*.py",
            max_results=20,
            max_depth=6,
        )
        assert "search_content → code index" in out
        assert "chat.py" in out.replace("\\", "/")


def test_jieba_segments_chinese_query_terms():
    from evoflow.code_index.tokenize import tokens_from_text

    terms = tokens_from_text("飞书消息推送配置")
    assert any("飞书" in t or "消息" in t or "推送" in t for t in terms)


def test_search_content_skips_tree_walk_when_index_has_no_candidates():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "only.py").write_text("class AlphaBeta: pass\n", encoding="utf-8")
        build_index(str(root), force=True)
        out = _run_search_content(
            pattern="ZZZ_NO_MATCH_TOKEN_XYZ",
            path=str(root),
            thread_id=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            glob_pattern="*.py",
            max_results=20,
            max_depth=6,
        )
        assert "scanning workspace tree" not in out.lower()
        assert "(no matches)" in out


def test_search_content_tree_walk_without_glob_when_index_disabled(monkeypatch):
    monkeypatch.setattr(
        "evoflow.tools.host_direct.search_content._index_search_bundle",
        lambda *args, **kwargs: (None, None, ""),
    )
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "a.py").write_text("hello = 1\n", encoding="utf-8")
        out = _run_search_content(
            pattern="hello",
            path=str(root),
            thread_id=None,
            context_before=0,
            context_after=0,
            case_sensitive=False,
            output_mode="content",
            glob_pattern=None,
            max_results=20,
            max_depth=6,
        )
        assert "Error:" not in out
        assert "hello" in out or "a.py" in out
