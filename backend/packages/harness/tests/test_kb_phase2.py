"""Phase 2 KB search fusion + LLM JSON parsing tests."""

from types import SimpleNamespace

from evoflow.knowledge.llm_indexer import _extract_json_object
from evoflow.knowledge.service import _rerank_search_hits


def test_extract_json_object_from_fence():
    raw = '说明\n```json\n{"summary_text": "hi", "chunks": []}\n```'
    data = _extract_json_object(raw)
    assert data is not None
    assert data["summary_text"] == "hi"


def test_rerank_boosts_sections_from_summary_match():
    hits = [
        SimpleNamespace(chunk_id="summary_file_a", score=0.9, distance=0.1),
        SimpleNamespace(chunk_id="chunk_b", score=0.55, distance=0.45),
        SimpleNamespace(chunk_id="chunk_a", score=0.5, distance=0.5),
    ]
    chunk_map = {
        "summary_file_a": {"chunk_id": "summary_file_a", "file_id": "file_a", "content": "summary"},
        "chunk_a": {"chunk_id": "chunk_a", "file_id": "file_a", "content": "section a"},
        "chunk_b": {"chunk_id": "chunk_b", "file_id": "file_b", "content": "section b"},
    }
    ranked = _rerank_search_hits(hits, chunk_map, top_k=2)
    assert len(ranked) == 2
    # chunk_a should beat chunk_b due to summary boost on file_a
    assert ranked[0][0].chunk_id == "chunk_a"
