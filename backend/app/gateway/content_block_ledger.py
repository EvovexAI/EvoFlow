"""Turn-scoped content blocks with stable id + monotonic seq for SSE / display_segments."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

BLOCK_KIND_PLAN = "plan_text"
BLOCK_KIND_REASONING = "reasoning"
BLOCK_KIND_TOOLS = "tools"
BLOCK_KIND_BODY = "body_text"


@dataclass(frozen=True)
class BlockWireMeta:
    block_id: str
    block_kind: str
    seq: int

    def as_wire(self) -> dict[str, Any]:
        return {"block_id": self.block_id, "block_kind": self.block_kind, "seq": self.seq}


@dataclass
class ContentBlockLedger:
    """Assign block_id/seq for each visible content slice in one assistant turn."""

    run_key: str = "run"
    next_seq: int = 0
    blocks: dict[str, dict[str, Any]] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    _open_text_id: str | None = None
    _open_text_kind: str | None = None
    _open_reasoning_id: str | None = None
    _open_tools_id: str | None = None
    _has_tools_in_turn: bool = False
    _pending_closes: list[BlockWireMeta] = field(default_factory=list)

    def reset(self, run_key: str) -> None:
        self.run_key = str(run_key or "run").strip() or "run"
        self.next_seq = 0
        self.blocks.clear()
        self.order.clear()
        self._open_text_id = None
        self._open_text_kind = None
        self._open_reasoning_id = None
        self._open_tools_id = None
        self._has_tools_in_turn = False
        self._pending_closes.clear()

    def _alloc(self, kind: str) -> BlockWireMeta:
        self.next_seq += 1
        bid = f"{self.run_key}:b{self.next_seq}"
        self.blocks[bid] = {
            "id": bid,
            "kind": kind,
            "seq": self.next_seq,
            "status": "open",
            "text": "",
            "tool_ids": [],
        }
        self.order.append(bid)
        return BlockWireMeta(bid, kind, self.next_seq)

    def _close(self, block_id: str | None) -> None:
        if not block_id:
            return
        blk = self.blocks.get(block_id)
        if blk and blk.get("status") == "open":
            blk["status"] = "closed"
            meta = self.meta_for(block_id)
            if meta:
                self._pending_closes.append(meta)

    def drain_closed(self) -> list[BlockWireMeta]:
        out = list(self._pending_closes)
        self._pending_closes.clear()
        return out

    def snapshot_display_segments(self) -> list[dict[str, Any]]:
        """Current segments for incremental persist (does not close open blocks)."""
        return self.export_display_segments()

    def close_block(self, block_id: str | None) -> BlockWireMeta | None:
        """Mark one block closed (for ``block_close`` wire / persist)."""
        self._close(block_id)
        return self.meta_for(block_id)

    def finalize_for_persist(self) -> list[dict[str, Any]]:
        """Close all open blocks and export ordered display_segments."""
        for bid in list(self.order):
            self._close(bid)
        return self.export_display_segments()

    def reasoning_segments(self) -> list[str]:
        out: list[str] = []
        for bid in self.order:
            blk = self.blocks.get(bid)
            if not blk or blk.get("kind") != BLOCK_KIND_REASONING:
                continue
            text = str(blk.get("text") or "").strip()
            if text:
                out.append(str(blk.get("text") or ""))
        return out

    def _close_open_text(self) -> None:
        self._close(self._open_text_id)
        self._open_text_id = None
        self._open_text_kind = None

    def _close_open_reasoning(self) -> None:
        self._close(self._open_reasoning_id)
        self._open_reasoning_id = None

    def _close_open_tools(self) -> None:
        self._close(self._open_tools_id)
        self._open_tools_id = None

    def meta_for(self, block_id: str | None) -> BlockWireMeta | None:
        if not block_id:
            return None
        blk = self.blocks.get(block_id)
        if not blk:
            return None
        return BlockWireMeta(str(blk["id"]), str(blk["kind"]), int(blk["seq"]))

    def _resolve_text_kind(self, content_phase: str | None) -> str:
        if content_phase == "post_tools" or self._has_tools_in_turn:
            return BLOCK_KIND_BODY
        if content_phase == "pre_tools":
            return BLOCK_KIND_PLAN
        return BLOCK_KIND_PLAN

    def delta_text(self, piece: str, content_phase: str | None = None) -> BlockWireMeta | None:
        text = str(piece or "")
        if not text:
            return self.meta_for(self._open_text_id)
        kind = self._resolve_text_kind(content_phase)
        if self._open_text_kind and self._open_text_kind != kind:
            self._close_open_text()
        if kind == BLOCK_KIND_BODY:
            self._close_open_reasoning()
            # NOTE: do NOT close the open tools block here. The tools block
            # stays open across body deltas; it is closed by finalize_for_persist
            # (or by an explicit close on tool_result completion). Closing it
            # eagerly on the first body delta breaks the contract verified by
            # test_body_text_closes_open_reasoning_block (only reasoning closes).
        if not self._open_text_id or self.blocks.get(self._open_text_id, {}).get("status") != "open":
            meta = self._alloc(kind)
            self._open_text_id = meta.block_id
            self._open_text_kind = kind
        blk = self.blocks[self._open_text_id]
        blk["text"] = str(blk.get("text") or "") + text
        return self.meta_for(self._open_text_id)

    def reasoning_delta(self, piece: str) -> BlockWireMeta | None:
        text = str(piece or "")
        if not text:
            return self.meta_for(self._open_reasoning_id)
        # NOTE: do NOT close the open tools block here — reasoning can
        # legitimately interleave with an in-flight tools block (model
        # thinks while tool_calls are still streaming). Tools block is
        # closed when body_text starts (post_tools phase) or on finalize.
        if not self._open_reasoning_id or self.blocks.get(self._open_reasoning_id, {}).get("status") != "open":
            self._close_open_reasoning()
            meta = self._alloc(BLOCK_KIND_REASONING)
            self._open_reasoning_id = meta.block_id
        blk = self.blocks[self._open_reasoning_id]
        blk["text"] = str(blk.get("text") or "") + text
        return self.meta_for(self._open_reasoning_id)

    def _tools_block_has_reasoning_after(self, tools_block_id: str) -> bool:
        try:
            tools_idx = self.order.index(tools_block_id)
        except ValueError:
            return False
        return any(
            self.blocks.get(bid, {}).get("kind") == BLOCK_KIND_REASONING
            for bid in self.order[tools_idx + 1 :]
        )

    def _tools_block_has_text_after(self, tools_block_id: str) -> bool:
        """Body/plan text after tools means the prior tool batch finished (CRUD round)."""
        try:
            tools_idx = self.order.index(tools_block_id)
        except ValueError:
            return False
        return any(
            self.blocks.get(bid, {}).get("kind") in {BLOCK_KIND_PLAN, BLOCK_KIND_BODY}
            for bid in self.order[tools_idx + 1 :]
        )

    def before_tools(self) -> BlockWireMeta:
        self._close_open_text()
        self._close_open_reasoning()
        self._has_tools_in_turn = True
        if self._open_tools_id and self.blocks.get(self._open_tools_id, {}).get("status") == "open":
            # Reuse only while the same in-flight batch is still streaming (no text/reasoning after).
            if self._tools_block_has_reasoning_after(self._open_tools_id):
                self._close_open_tools()
            elif self._tools_block_has_text_after(self._open_tools_id):
                self._close_open_tools()
            else:
                return self.meta_for(self._open_tools_id)  # type: ignore[return-value]
        else:
            self._close_open_tools()
        meta = self._alloc(BLOCK_KIND_TOOLS)
        self._open_tools_id = meta.block_id
        return meta

    def register_tool_id(self, block_id: str, tool_call_id: str) -> None:
        cid = str(tool_call_id or "").strip()
        if not cid:
            return
        blk = self.blocks.get(block_id)
        if not blk:
            return
        ids: list[str] = list(blk.get("tool_ids") or [])
        if cid not in ids:
            ids.append(cid)
            blk["tool_ids"] = ids

    def export_display_segments(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for bid in self.order:
            blk = self.blocks.get(bid)
            if not blk:
                continue
            kind = str(blk.get("kind") or "")
            seq = int(blk.get("seq") or 0)
            base: dict[str, Any] = {"id": bid, "seq": seq, "block_kind": kind}
            if kind == BLOCK_KIND_TOOLS:
                ids = [str(x).strip() for x in (blk.get("tool_ids") or []) if str(x).strip()]
                # Always export the tools slot once allocated — it preserves the
                # ordered seq sequence (plan→tools→reasoning→body) on the wire
                # even when tool_call_ids have not been registered yet (early
                # before_tools / snapshot mid-stream). ``ids`` may be empty.
                out.append({**base, "kind": "tools", "ids": ids})
            elif kind == BLOCK_KIND_REASONING:
                text = str(blk.get("text") or "").strip()
                if text:
                    out.append({**base, "kind": "reasoning", "text": text})
            elif kind in {BLOCK_KIND_PLAN, BLOCK_KIND_BODY}:
                text = str(blk.get("text") or "").strip()
                if text:
                    out.append({**base, "kind": "text", "text": text})
        return out

    def snapshot_agui_messages(
        self,
        tool_registry: dict[str, dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """AG-UI ``Message[]`` for ``MESSAGES_SNAPSHOT``."""
        reg = tool_registry or {}
        messages: list[dict[str, Any]] = []
        for seg in self.export_display_segments():
            kind = str(seg.get("kind") or "")
            seg_id = str(seg.get("id") or "")
            seq = int(seg.get("seq") or 0)
            block_kind = str(seg.get("block_kind") or kind)
            wire_meta: dict[str, Any] = {}
            if seq > 0:
                wire_meta["seq"] = seq
            if block_kind:
                wire_meta["blockKind"] = block_kind
            if kind == "text":
                text = str(seg.get("text") or "")
                if text.strip():
                    messages.append({"id": seg_id, "role": "assistant", "content": text, **wire_meta})
            elif kind == "reasoning":
                text = str(seg.get("text") or "")
                if text.strip():
                    messages.append({"id": seg_id, "role": "reasoning", "content": text, **wire_meta})
            elif kind == "tools":
                tool_calls: list[dict[str, Any]] = []
                for tid in seg.get("ids") or []:
                    cid = str(tid).strip()
                    if not cid:
                        continue
                    meta = reg.get(cid, {})
                    tool_calls.append(
                        {
                            "id": cid,
                            "type": "function",
                            "function": {
                                "name": str(meta.get("name") or "tool"),
                                "arguments": str(meta.get("arguments") or "{}"),
                            },
                        }
                    )
                if tool_calls:
                    messages.append({"id": seg_id, "role": "assistant", "toolCalls": tool_calls, **wire_meta})
                    for tc in tool_calls:
                        cid = str(tc.get("id") or "")
                        meta = reg.get(cid, {})
                        result = str(meta.get("result") or "")
                        if result:
                            messages.append(
                                {
                                    "id": f"{cid}-result",
                                    "role": "tool",
                                    "toolCallId": cid,
                                    "content": result,
                                }
                            )
        return messages
