"""Owned KB chunking: chunk_size is authoritative; overlap keeps readable context."""

from __future__ import annotations

from evoflow.knowledge.owned.chunking import _NO_SPLIT_MAX_CHARS, _overlap_tail, split_text


def test_doc_under_chunk_size_stays_one_piece():
    body = "段落一。\n\n" + ("这是一段说明文字。" * 40)
    assert len(body) < 2048
    pieces = split_text(body, chunk_size=2048, chunk_overlap=64, strategy="recursive")
    assert len(pieces) == 1
    assert pieces[0].content == body.strip()


def test_chunk_size_is_honored_even_when_under_old_5000_ceiling():
    """FAQ pack ~3k used to collapse to 1 chunk because of a fixed 5000 no-split.

    With chunk_size=512 the same body must actually split.
    """
    unit = "Q：能不能开发票？A：可以，企业微信联系财务开具增值税普通发票。"
    body = "\n\n".join(f"## FAQ{i}\n\n{unit}" for i in range(40))
    assert 1500 < len(body) < 5000
    pieces = split_text(body, chunk_size=512, chunk_overlap=64, strategy="recursive")
    assert len(pieces) >= 3, f"expected multi-chunk for ~{len(body)} chars @512, got {len(pieces)}"


def test_heading_strategy_splits_medium_faq_pack():
    parts = []
    for i in range(8):
        parts.append(f"## 主题{i}\n\n")
        parts.append(("本节 FAQ 说明内容，保留检索粒度。" * 20) + "\n\n")
    body = "".join(parts)
    assert len(body) > _NO_SPLIT_MAX_CHARS
    assert len(body) < 5000
    pieces = split_text(body, chunk_size=512, chunk_overlap=64, strategy="heading")
    assert len(pieces) >= 4
    assert any(p.heading_path for p in pieces)


def test_long_doc_splits_with_boundary_overlap():
    para = "这是完整的一句结束。\n\n"
    body = para * 800
    assert len(body) > 5000
    pieces = split_text(body, chunk_size=1200, chunk_overlap=200, strategy="recursive")
    assert len(pieces) >= 2
    for a, b in zip(pieces, pieces[1:]):
        assert "这是完整的一句结束。" in a.content
        shared = _overlap_tail(a.content, 200)
        if shared:
            assert b.content.startswith(shared[: min(20, len(shared))]) or shared[:20] in b.content[: len(shared) + 40]


def test_heading_strategy_keeps_section_context():
    parts = []
    for i in range(20):
        parts.append(f"## 章节{i}\n\n")
        parts.append(("本节说明内容，保留上下文。" * 60) + "\n\n")
    body = "".join(parts)
    assert len(body) > 5000
    pieces = split_text(body, chunk_size=1500, chunk_overlap=180, strategy="heading")
    assert len(pieces) >= 2
    assert any(p.heading_path for p in pieces)
    assert any(p.context_header for p in pieces)


def test_overlap_tail_snaps_to_sentence():
    text = "前文填充。" * 30 + "关键边界。后续才是重点内容。"
    tail = _overlap_tail(text, 40)
    assert tail.startswith("后续") or "后续才是重点内容" in tail
    assert not tail.startswith("填")
