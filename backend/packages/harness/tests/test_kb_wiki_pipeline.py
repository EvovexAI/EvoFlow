"""Wiki auto-chunker tests."""

from evoflow.knowledge.index_builder import build_document_summary, enrich_chunk_indexes
from evoflow.knowledge.wiki_chunker import auto_chunk_document


def test_auto_chunk_markdown_by_headings():
    text = "# Intro\n\nFirst paragraph with enough content to stand alone.\n\n## Install\n\nInstall steps go here with more details.\n\n## Usage\n\nUsage section with additional explanatory text."
    chunks = auto_chunk_document(text, file_name="guide.md")
    assert chunks
    assert any("Install" in (c.get("heading_path") or "") or "Intro" in (c.get("heading_path") or "") for c in chunks)


def test_document_summary_and_chunk_index():
    text = "# 产品手册\n\n这是产品手册的正文内容，用于测试摘要与索引。"
    summary_text, summary_index = build_document_summary(text, file_name="产品手册.md")
    assert "产品手册" in summary_text
    assert summary_index

    chunks = enrich_chunk_indexes(auto_chunk_document(text, file_name="产品手册.md"), file_name="产品手册.md")
    assert chunks
    assert chunks[0].get("index_text")
