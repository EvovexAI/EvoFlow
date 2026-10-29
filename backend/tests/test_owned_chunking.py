"""Owned KB chunking: short docs stay whole; overlap keeps readable context."""

from __future__ import annotations

from evoflow.knowledge.owned.chunking import _NO_SPLIT_MAX_CHARS, _overlap_tail, split_text


def test_short_doc_not_split():
    body = "段落一。\n\n" + ("这是一段说明文字。" * 80)  # well under 5k
    assert len(body) < _NO_SPLIT_MAX_CHARS
    pieces = split_text(body, chunk_size=512, chunk_overlap=64, strategy="recursive")
    assert len(pieces) == 1
    assert pieces[0].content == body.strip()


def test_around_5000_chars_still_one_chunk():
    # Just under the no-split ceiling — must not shatter into 512-char scraps.
    unit = "上下文连续性测试句。"
    body = unit * ((_NO_SPLIT_MAX_CHARS // len(unit)) - 1)
    assert len(body) <= _NO_SPLIT_MAX_CHARS
    pieces = split_text(body, chunk_size=512, chunk_overlap=64)
    assert len(pieces) == 1


def test_long_doc_splits_with_boundary_overlap():
    para = "这是完整的一句结束。\n\n"
    body = para * 800  # >> 5000
    assert len(body) > _NO_SPLIT_MAX_CHARS
    pieces = split_text(body, chunk_size=1200, chunk_overlap=200, strategy="recursive")
    assert len(pieces) >= 2
    # Neighboring chunk should open on a sentence/paragraph boundary, not mid-句.
    for a, b in zip(pieces, pieces[1:]):
        assert "这是完整的一句结束。" in a.content
        # overlap carried: next chunk shares a readable tail of previous
        shared = _overlap_tail(a.content, 200)
        if shared:
            assert b.content.startswith(shared[: min(20, len(shared))]) or shared[:20] in b.content[: len(shared) + 40]


def test_heading_strategy_keeps_section_context():
    parts = []
    for i in range(20):
        parts.append(f"## 章节{i}\n\n")
        parts.append(("本节说明内容，保留上下文。" * 60) + "\n\n")
    body = "".join(parts)
    assert len(body) > _NO_SPLIT_MAX_CHARS
    pieces = split_text(body, chunk_size=1500, chunk_overlap=180, strategy="heading")
    assert len(pieces) >= 2
    assert any(p.heading_path for p in pieces)
    assert any(p.context_header for p in pieces)


def test_overlap_tail_snaps_to_sentence():
    text = "前文填充。" * 30 + "关键边界。后续才是重点内容。"
    tail = _overlap_tail(text, 40)
    assert tail.startswith("后续") or "后续才是重点内容" in tail
    assert not tail.startswith("填")
