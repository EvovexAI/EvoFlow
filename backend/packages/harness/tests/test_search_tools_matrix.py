"""Comprehensive tests: search_code_index vs rg boundaries, prompts, and accuracy."""

from __future__ import annotations

import tempfile
import time
from pathlib import Path

import pytest

from evoflow.code_index.store import build_index, search_index
from evoflow.exploration.search_tool_matrix import (
    SEARCH_MATRIX_MARKER_EN,
    classify_search_intent,
    expected_tool_for_query,
    format_search_tool_matrix_en,
    format_search_tool_matrix_zh,
)
from evoflow.exploration.task_router import looks_like_filename_query
from evoflow.tools.host_direct.rg import _run_rg_wallclock
from evoflow.tools.host_direct.search_content import (
    _is_pipe_literal_keyword_list,
    _looks_like_index_keyword_query,
)
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace


def test_workspace_code_workflow_skill_includes_search_tool_matrix():
    skill_path = Path(__file__).resolve().parents[4] / "skills/public/workspace-code-workflow/SKILL.md"
    text = skill_path.read_text(encoding="utf-8")
    assert SEARCH_MATRIX_MARKER_EN in text
    assert "renderModelResponseTypeCell" in text
    assert "同义词 OR" in text
    assert "<task_router>" in text
    assert "<worker_tool_guidance>" in text


def test_search_code_index_docstring_has_boundary_examples():
    src = Path(__file__).resolve().parents[1] / "evoflow/tools/host_direct/search_code_index.py"
    text = src.read_text(encoding="utf-8")
    assert "When NOT to use" in text
    assert "path:evopanel/src/pages" in text
    assert "fetch_tools_summary" in text


def test_rg_docstring_has_boundary_examples():
    src = Path(__file__).resolve().parents[1] / "evoflow/tools/host_direct/rg.py"
    text = src.read_text(encoding="utf-8")
    assert "kind" in text
    assert "renderModelResponseTypeCell" in text


@pytest.mark.parametrize(
    ("query", "intent", "tool"),
    [
        ("agent-trace-obs-sqlite.js", "filename", "find"),
        ("*agent-trace-model-response*", "filename", "find"),
        (
            "path:evopanel/src/pages renderModelResponseTypeCell|summarizeModelResponse",
            "symbol",
            "search_code_index",
        ),
        ("回复类型|response_summary|kind_label", "symbol", "search_code_index"),
        ("fetch_tools_summary", "symbol", "search_code_index"),
        ("def fetch_tools_summary", "literal", "rg"),
        ("Error: rg timed out", "literal", "rg"),
    ],
)
def test_classify_search_intent_and_tool(query: str, intent: str, tool: str):
    assert classify_search_intent(query) == intent
    assert expected_tool_for_query(query) == tool


def test_filename_query_blocked_from_index():
    assert looks_like_filename_query("agent-trace-obs-sqlite.js")
    assert not looks_like_filename_query(
        "path:evopanel/src/pages renderModelResponseTypeCell|summarizeModelResponse"
    )


@pytest.mark.parametrize(
    "pattern",
    [
        "回复类型|返回类型|kind_label|response_summary|responseKind|kind",
        "responseTypeCell|renderModelResponseTypeCell|response_summary",
        "renderModelResponseTypeCell|summarizeModelResponse",
        "MemoryLiveFooter|MemoryRuntimeControl",
    ],
)
def test_pipe_patterns_detected_as_keyword_queries(pattern: str):
    assert _is_pipe_literal_keyword_list(pattern)
    assert _looks_like_index_keyword_query(pattern)


def _mini_repo() -> str:
    tmp = Path(tempfile.mkdtemp(prefix="search-matrix-"))
    pages = tmp / "evopanel" / "src" / "pages"
    pages.mkdir(parents=True)
    (pages / "agent-trace-obs-sqlite.js").write_text(
        "import { renderModelResponseTypeCell, summarizeModelResponse } from './agent-trace-model-response.js'\n"
        "const response_summary = row.response_summary\n",
        encoding="utf-8",
    )
    (pages / "agent-trace-model-response.js").write_text(
        "export function summarizeModelResponse(r) {}\n"
        "export function renderModelResponseTypeCell(s, opts) {}\n",
        encoding="utf-8",
    )
    backend = tmp / "backend" / "pkg"
    backend.mkdir(parents=True)
    (backend / "summaries.py").write_text("def fetch_tools_summary():\n    pass\n", encoding="utf-8")
    build_index(str(tmp), force=True)
    return str(tmp)


def test_index_finds_scoped_evopanel_symbols():
    root = _mini_repo()
    data = search_index(
        root,
        "path:evopanel/src/pages renderModelResponseTypeCell|summarizeModelResponse",
        limit=10,
    )
    blob = " ".join(
        str(x.get("path") or x.get("name") or "")
        for x in (data.get("symbols") or []) + (data.get("hits") or [])
    )
    assert (
        "agent-trace" in blob
        or "renderModelResponseTypeCell" in blob
        or "summarizeModelResponse" in blob
    )


def test_index_finds_backend_symbol():
    root = _mini_repo()
    data = search_index(root, "fetch_tools_summary", limit=8)
    blob = " ".join(
        str(x.get("path") or x.get("name") or "")
        for x in (data.get("symbols") or []) + (data.get("hits") or [])
    )
    assert "summaries.py" in blob


def test_rg_pipe_redirects_or_fixed_string_not_timeout():
    root = _mini_repo()
    rt = runtime_with_workspace(root, "matrix-rg")
    t0 = time.perf_counter()
    out = _run_rg_wallclock(
        pattern="renderModelResponseTypeCell|summarizeModelResponse|kind",
        path="evopanel/src/pages",
        glob_pattern=None,
        context_before=0,
        context_after=0,
        case_sensitive=False,
        output_mode="content",
        max_results=20,
        runtime=rt,
    )
    elapsed = time.perf_counter() - t0
    assert elapsed < 30.0, f"took {elapsed:.1f}s — likely regex OR timeout"
    assert "timed out" not in out.lower()
    assert (
        "code index" in out
        or "fixed-string" in out
        or "renderModelResponseTypeCell" in out
        or "summarizeModelResponse" in out
    )


def test_rg_literal_finds_line_in_file():
    root = _mini_repo()
    rt = runtime_with_workspace(root, "matrix-rg-lit")
    out = _run_rg_wallclock(
        pattern="response_summary",
        path="evopanel/src/pages/agent-trace-obs-sqlite.js",
        glob_pattern=None,
        context_before=0,
        context_after=0,
        case_sensitive=False,
        output_mode="content",
        max_results=10,
        runtime=rt,
    )
    assert "response_summary" in out
    assert "timed out" not in out.lower()


def test_format_search_tool_matrix_contains_examples():
    en = format_search_tool_matrix_en()
    zh = format_search_tool_matrix_zh()
    assert "find(pattern=" in en
    assert "search_code_index" in en
    assert "find(pattern=" in zh


_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.mark.skipif(
    not (_EVOFLOW_ROOT / "evopanel").is_dir(),
    reason="EvoFlow workspace root not found",
)
def test_evoflow_repo_index_vs_rg_smoke():
    from evoflow.code_index.store import index_status

    root = str(_EVOFLOW_ROOT)
    st = index_status(workspace_root=root)
    if not st.get("ready") or int(st.get("files") or 0) < 100:
        pytest.skip("code index not ready")

    idx = search_index(
        root,
        "path:evopanel/src/pages renderModelResponseTypeCell|summarizeModelResponse",
        limit=8,
    )
    syms = [s.get("name") for s in (idx.get("symbols") or [])]
    paths = [h.get("path") for h in (idx.get("hits") or []) + (idx.get("symbols") or [])]
    merged = " ".join(str(x) for x in syms + paths)
    assert "agent-trace" in merged or "renderModel" in merged or "summarizeModel" in merged

    rt = runtime_with_workspace(root, "matrix-smoke")
    t0 = time.perf_counter()
    rg_out = _run_rg_wallclock(
        pattern="renderModelResponseTypeCell|summarizeModelResponse",
        path="evopanel/src/pages",
        glob_pattern=None,
        context_before=0,
        context_after=0,
        case_sensitive=False,
        output_mode="content",
        max_results=20,
        runtime=rt,
    )
    assert time.perf_counter() - t0 < 40.0
    assert "timed out" not in rg_out.lower()
