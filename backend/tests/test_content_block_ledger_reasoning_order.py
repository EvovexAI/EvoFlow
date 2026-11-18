"""正文出现后，迟到 reasoning 不得在结论下再开孤儿思考卡。"""

from __future__ import annotations

from app.gateway.content_block_ledger import (
    BLOCK_KIND_BODY,
    BLOCK_KIND_REASONING,
    BLOCK_KIND_TOOLS,
    ContentBlockLedger,
)


def test_late_reasoning_after_body_reopens_previous_reasoning() -> None:
    ledger = ContentBlockLedger()
    ledger.reset("run-orphan")
    r1 = ledger.reasoning_delta("All work is done. Let changes")
    assert r1 is not None
    body = ledger.delta_text("## 结论\n已完成", content_phase="post_tools")
    assert body is not None
    assert ledger.blocks[r1.block_id]["status"] == "closed"

    r2 = ledger.reasoning_delta(" take effect.")
    assert r2 is not None
    # 必须并回上一张，而不是新开一张挂在正文后
    assert r2.block_id == r1.block_id
    assert ledger.blocks[r1.block_id]["text"].endswith(" take effect.")
    kinds = [str(ledger.blocks[bid]["kind"]) for bid in ledger.order]
    assert kinds.count(BLOCK_KIND_REASONING) == 1
    assert BLOCK_KIND_BODY in kinds


def test_reasoning_before_any_body_still_allocates_new() -> None:
    ledger = ContentBlockLedger()
    ledger.reset("run-pre")
    r1 = ledger.reasoning_delta("first thought")
    ledger.before_tools()
    r2 = ledger.reasoning_delta("after tool batch")
    assert r1 is not None and r2 is not None
    assert r2.block_id != r1.block_id


def test_reasoning_after_body_and_tools_opens_new_card() -> None:
    """多轮工具穿插：正文后的新思考不得并进轮头第一张卡。"""
    ledger = ContentBlockLedger()
    ledger.reset("run-mid-tools")
    r1 = ledger.reasoning_delta("先看技能文档")
    assert r1 is not None
    tools1 = ledger.before_tools()
    assert tools1 is not None
    body1 = ledger.delta_text("先改第一处。", content_phase="post_tools")
    assert body1 is not None
    assert ledger.blocks[body1.block_id]["kind"] == BLOCK_KIND_BODY
    tools2 = ledger.before_tools()
    assert tools2 is not None
    assert tools2.block_id != tools1.block_id

    r2 = ledger.reasoning_delta("工具结果出来了，继续核对根因")
    assert r2 is not None
    assert r2.block_id != r1.block_id
    kinds = [str(ledger.blocks[bid]["kind"]) for bid in ledger.order]
    assert kinds.count(BLOCK_KIND_REASONING) == 2
    assert BLOCK_KIND_BODY in kinds
    assert kinds.count(BLOCK_KIND_TOOLS) == 2
