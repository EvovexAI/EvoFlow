"""Content block ledger: stable id + seq for assistant turn slices."""

from __future__ import annotations

from app.gateway.content_block_ledger import (
    BLOCK_KIND_BODY,
    BLOCK_KIND_PLAN,
    BLOCK_KIND_REASONING,
    BLOCK_KIND_TOOLS,
    ContentBlockLedger,
)


def test_delta_text_opens_plan_then_body_after_tools():
    ledger = ContentBlockLedger()
    ledger.reset("run-1:0")
    plan = ledger.delta_text("## plan", "pre_tools")
    assert plan is not None
    assert plan.block_kind == BLOCK_KIND_PLAN
    assert plan.seq == 1
    tools = ledger.before_tools()
    assert tools.block_kind == BLOCK_KIND_TOOLS
    assert tools.seq == 2
    think = ledger.reasoning_delta("think live")
    assert think is not None
    assert think.block_kind == BLOCK_KIND_REASONING
    assert think.seq == 3
    body = ledger.delta_text("## report", "post_tools")
    assert body is not None
    assert body.block_kind == BLOCK_KIND_BODY
    assert body.seq == 4
    segs = ledger.export_display_segments()
    assert [s["seq"] for s in segs] == [1, 2, 3, 4]
    assert segs[0]["kind"] == "text"
    assert segs[1]["kind"] == "tools"
    assert segs[2]["kind"] == "reasoning"
    assert segs[3]["kind"] == "text"


def test_register_tool_id_on_tools_block():
    ledger = ContentBlockLedger()
    ledger.reset("run-2:0")
    meta = ledger.before_tools()
    ledger.register_tool_id(meta.block_id, "tc-abc")
    segs = ledger.export_display_segments()
    assert segs[0]["ids"] == ["tc-abc"]


def test_finalize_for_persist_closes_blocks_and_keeps_seq():
    ledger = ContentBlockLedger()
    ledger.reset("run-3:0")
    ledger.delta_text("plan", "pre_tools")
    ledger.before_tools()
    ledger.reasoning_delta("after tools think")
    ledger.delta_text("final body", "post_tools")
    segs = ledger.finalize_for_persist()
    assert [s["seq"] for s in segs] == [1, 2, 3, 4]
    assert all(s.get("id") for s in segs)
    assert ledger.reasoning_segments() == ["after tools think"]


def test_reasoning_segments_returns_each_block_not_joined():
    ledger = ContentBlockLedger()
    ledger.reset("run-4:0")
    ledger.reasoning_delta("first")
    ledger.before_tools()
    ledger.reasoning_delta("second")
    assert ledger.reasoning_segments() == ["first", "second"]


def test_before_tools_drains_closed_plan_block():
    ledger = ContentBlockLedger()
    ledger.reset("run-5:0")
    ledger.delta_text("plan", "pre_tools")
    assert ledger.drain_closed() == []
    ledger.before_tools()
    closed = ledger.drain_closed()
    assert len(closed) == 1
    assert closed[0].block_kind == BLOCK_KIND_PLAN
    assert closed[0].seq == 1


def test_body_text_closes_open_reasoning_block():
    ledger = ContentBlockLedger()
    ledger.reset("run-6:0")
    ledger.before_tools()
    ledger.reasoning_delta("think")
    assert ledger.drain_closed() == []
    ledger.delta_text("report", "post_tools")
    closed = ledger.drain_closed()
    assert len(closed) == 1
    assert closed[0].block_kind == BLOCK_KIND_REASONING


def test_tools_reasoning_tools_allocates_separate_tools_blocks():
    """Second tool batch after interleaved reasoning must not reuse the first tools block."""
    ledger = ContentBlockLedger()
    ledger.reset("run-7:0")
    t1 = ledger.before_tools()
    ledger.register_tool_id(t1.block_id, "tc-1")
    ledger.reasoning_delta("think between batches")
    t2 = ledger.before_tools()
    assert t1.block_id != t2.block_id
    assert t2.seq > t1.seq
    ledger.register_tool_id(t2.block_id, "tc-2")
    segs = ledger.export_display_segments()
    assert [s["seq"] for s in segs] == [1, 2, 3]
    assert segs[0]["kind"] == "tools"
    assert segs[0]["ids"] == ["tc-1"]
    assert segs[1]["kind"] == "reasoning"
    assert segs[2]["kind"] == "tools"
    assert segs[2]["ids"] == ["tc-2"]


def test_text_tools_text_tools_allocates_separate_tools_blocks():
    """CRUD rounds without reasoning: each tool batch gets its own tools block."""
    ledger = ContentBlockLedger()
    ledger.reset("run-8:0")
    ledger.delta_text("plan intro", "pre_tools")
    t1 = ledger.before_tools()
    ledger.register_tool_id(t1.block_id, "tc-1")
    ledger.delta_text("after batch 1", "post_tools")
    t2 = ledger.before_tools()
    assert t1.block_id != t2.block_id
    assert t2.seq > t1.seq
    ledger.register_tool_id(t2.block_id, "tc-2")
    ledger.delta_text("after batch 2", "post_tools")
    segs = ledger.export_display_segments()
    assert [s["kind"] for s in segs] == ["text", "tools", "text", "tools", "text"]
    assert segs[1]["ids"] == ["tc-1"]
    assert segs[3]["ids"] == ["tc-2"]
    assert [s["seq"] for s in segs] == [1, 2, 3, 4, 5]
