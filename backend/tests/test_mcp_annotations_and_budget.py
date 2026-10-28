"""Tests for MCP annotations risk grading and result budget normalization."""

from __future__ import annotations

import base64
import importlib
from types import SimpleNamespace

import pytest


# ── annotations registry ────────────────────────────────────────────


def _reset():
    from evoflow.mcp import annotations as ann

    ann.reset_tool_annotations()
    return ann


def test_record_extracts_hints_from_metadata():
    ann = _reset()
    tool = SimpleNamespace(
        name="mcp__github__search",
        metadata={"readOnlyHint": True, "idempotentHint": True, "_meta": {}},
    )
    assert ann.record_tools_annotations([tool]) == 1
    hints = ann.get_tool_hints("mcp__github__search")
    assert hints == {"readOnlyHint": True, "idempotentHint": True}


def test_record_skips_non_mcp_and_hintless():
    ann = _reset()
    tools = [
        SimpleNamespace(name="read", metadata={"readOnlyHint": True}),
        SimpleNamespace(name="mcp__x__y", metadata={"_meta": {}}),
        SimpleNamespace(name="mcp__x__z", metadata=None),
    ]
    assert ann.record_tools_annotations(tools) == 0
    assert ann.get_tool_hints("mcp__x__y") is None


def test_record_is_case_insensitive_on_lookup():
    ann = _reset()
    ann.record_tools_annotations(
        [SimpleNamespace(name="MCP__Srv__Tool", metadata={"readOnlyHint": True})]
    )
    assert ann.get_tool_hints("mcp__srv__tool") == {"readOnlyHint": True}


def test_reset_clears_records():
    ann = _reset()
    ann.record_tools_annotations(
        [SimpleNamespace(name="mcp__a__b", metadata={"destructiveHint": True})]
    )
    ann.reset_tool_annotations()
    assert ann.get_tool_hints("mcp__a__b") is None


# ── risk grading ────────────────────────────────────────────────────


@pytest.fixture()
def clean_env(monkeypatch):
    monkeypatch.delenv("EVOFLOW_MCP_AUTO_TOOLS", raising=False)
    _reset()
    yield
    _reset()


def _risk(name: str) -> str:
    from evoflow.agents.tool_approval_config import _mcp_tool_risk

    return _mcp_tool_risk(name)


def test_risk_default_session_without_hints(clean_env):
    assert _risk("mcp__unknown__tool") == "session"


def test_risk_readonly_hint_maps_auto(clean_env):
    from evoflow.mcp.annotations import record_tools_annotations

    record_tools_annotations(
        [SimpleNamespace(name="mcp__db__query", metadata={"readOnlyHint": True})]
    )
    assert _risk("mcp__db__query") == "auto"


def test_risk_destructive_hint_maps_confirm(clean_env):
    from evoflow.mcp.annotations import record_tools_annotations

    record_tools_annotations(
        [SimpleNamespace(name="mcp__db__drop", metadata={"destructiveHint": True})]
    )
    assert _risk("mcp__db__drop") == "confirm"


def test_risk_destructive_wins_over_readonly(clean_env):
    from evoflow.mcp.annotations import record_tools_annotations

    record_tools_annotations(
        [
            SimpleNamespace(
                name="mcp__x__both",
                metadata={"readOnlyHint": True, "destructiveHint": True},
            )
        ]
    )
    assert _risk("mcp__x__both") == "confirm"


def test_risk_node_repl_stays_confirm(clean_env):
    from evoflow.mcp.annotations import record_tools_annotations

    # 即使 node_repl 工具自报只读，宿主执行内核仍按 confirm。
    record_tools_annotations(
        [SimpleNamespace(name="mcp__node_repl__js", metadata={"readOnlyHint": True})]
    )
    assert _risk("mcp__node_repl__js") == "confirm"


def test_risk_env_allowlist_beats_destructive_hint(clean_env, monkeypatch):
    from evoflow.mcp.annotations import record_tools_annotations

    monkeypatch.setenv("EVOFLOW_MCP_AUTO_TOOLS", "mcp__db__drop")
    record_tools_annotations(
        [SimpleNamespace(name="mcp__db__drop", metadata={"destructiveHint": True})]
    )
    assert _risk("mcp__db__drop") == "auto"


def test_non_mcp_tool_returns_none(clean_env):
    assert _risk("read") is None
    assert _risk("bash") is None


def test_cache_reset_clears_annotations(clean_env):
    from evoflow.mcp.annotations import record_tools_annotations
    from evoflow.mcp.cache import reset_mcp_tools_cache

    record_tools_annotations(
        [SimpleNamespace(name="mcp__a__b", metadata={"readOnlyHint": True})]
    )
    reset_mcp_tools_cache()
    from evoflow.mcp.annotations import get_tool_hints

    assert get_tool_hints("mcp__a__b") is None


# ── result budget ───────────────────────────────────────────────────


@pytest.fixture()
def budget_env(monkeypatch, tmp_path):
    monkeypatch.setenv("EVOFLOW_MCP_IMAGES_DIR", str(tmp_path / "imgs"))
    from evoflow.mcp import result_budget

    importlib.reload(result_budget)
    yield result_budget, tmp_path / "imgs"
    monkeypatch.delenv("EVOFLOW_MCP_IMAGES_DIR", raising=False)


def test_text_under_budget_untouched(budget_env):
    rb, _ = budget_env
    assert rb.normalize_mcp_tool_result("t", "hello") == "hello"


def test_text_over_budget_truncated_head(budget_env):
    rb, _ = budget_env
    rb._TEXT_BUDGET_DEFAULT = 100  # module default; env not needed — patch function
    rb.text_budget_chars = lambda: 100
    out = rb.normalize_mcp_tool_result("t", "x" * 300)
    assert isinstance(out, str)
    assert out.startswith("x" * 100)
    assert "truncated" in out and "300" in out


def test_big_image_saved_and_replaced(budget_env):
    rb, img_dir = budget_env
    raw = bytes(range(256)) * 1024  # 256KB
    b64 = base64.b64encode(raw).decode()
    blocks = [{"type": "image", "base64": b64, "mime_type": "image/png"}]
    out = rb.normalize_mcp_tool_result("mcp__s__t", blocks)
    assert isinstance(out, list) and len(out) == 1
    assert out[0]["type"] == "text"
    assert "read tool" in out[0]["text"]
    # 落盘文件真实存在且字节一致
    saved = [p for p in img_dir.iterdir() if p.suffix == ".png"]
    assert len(saved) == 1 and saved[0].read_bytes() == raw


def test_small_image_kept_inline(budget_env):
    rb, img_dir = budget_env
    raw = b"\x89PNG" + b"0" * 100
    b64 = base64.b64encode(raw).decode()
    blocks = [{"type": "image", "base64": b64, "mime_type": "image/png"}]
    out = rb.normalize_mcp_tool_result("mcp__s__t", blocks)
    assert out[0]["type"] == "image" and out[0]["base64"] == b64
    assert not img_dir.exists() or not list(img_dir.iterdir())


def test_tuple_shape_preserved_with_artifact(budget_env):
    rb, _ = budget_env
    blocks = [
        {"type": "text", "text": "short"},
        {"type": "image", "base64": base64.b64encode(b"x" * 300000).decode(), "mime_type": "image/png"},
    ]
    out = rb.normalize_mcp_tool_result("t", (blocks, {"structured": 1}))
    assert isinstance(out, tuple) and len(out) == 2
    content, artifact = out
    assert artifact == {"structured": 1}
    assert content[0]["type"] == "text"
    assert content[1]["type"] == "text" and "saved to" in content[1]["text"]


def test_tuple_shape_preserved_when_artifact_is_none(budget_env):
    """adapters always return (content, artifact|None); unwrapping breaks content_and_artifact."""
    rb, _ = budget_env
    blocks = [{"type": "text", "text": '{"ok": true}'}]
    out = rb.normalize_mcp_tool_result("mcp__ecommerce-shangce__health", (blocks, None))
    assert isinstance(out, tuple) and len(out) == 2
    content, artifact = out
    assert artifact is None
    assert content == blocks


def test_blocks_text_budget_across_blocks(budget_env):
    rb, _ = budget_env
    rb.text_budget_chars = lambda: 150
    blocks = [
        {"type": "text", "text": "a" * 100},
        {"type": "image", "base64": base64.b64encode(b"img").decode(), "mime_type": "image/png"},
        {"type": "text", "text": "b" * 100},
    ]
    out = rb.normalize_mcp_tool_result("t", blocks)
    texts = [b for b in out if b["type"] == "text"]
    assert sum(len(t["text"]) for t in texts if "truncated" not in t["text"]) <= 150
    assert any("truncated" in t["text"] for t in texts)
    # image block（小于阈值）原样保留在原位置
    assert any(b["type"] == "image" for b in out)


def test_tool_message_passthrough(budget_env):
    rb, _ = budget_env
    sentinel = SimpleNamespace(type="tool_message")
    assert rb.normalize_mcp_tool_result("t", sentinel) is sentinel


def test_none_passthrough(budget_env):
    rb, _ = budget_env
    assert rb.normalize_mcp_tool_result("t", None) is None


def test_corrupt_base64_image_falls_back_to_original_block(budget_env):
    rb, _ = budget_env
    blocks = [{"type": "image", "base64": "!!!not-base64!!!", "mime_type": "image/png"}]
    out = rb.normalize_mcp_tool_result("mcp__s__t", blocks)
    # 无法解码 → 无法判定大小 → 保留原块（adapters 层会在渲染时兜底）
    assert out[0]["type"] == "image"


def test_image_inline_budget_zero_forces_all_to_disk(budget_env, monkeypatch):
    rb, img_dir = budget_env
    monkeypatch.setenv("EVOFLOW_MCP_IMAGE_INLINE_BYTES", "0")
    importlib.reload(rb)
    monkeypatch.setenv("EVOFLOW_MCP_IMAGES_DIR", str(img_dir))
    importlib.reload(rb)
    b64 = base64.b64encode(b"tiny").decode()
    out = rb.normalize_mcp_tool_result(
        "t", [{"type": "image", "base64": b64, "mime_type": "image/png"}]
    )
    assert out[0]["type"] == "text" and "saved to" in out[0]["text"]
