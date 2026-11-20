"""In-flight user must survive hydration even when DB stitch has conversation_summary.

FE fire-and-forget appends the user row while POST /runs/stream already starts.
If hydration replaces runtime from DB before the row lands and skips merging the
LG input Human, the model answers the *previous* user turn.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
    _collect_missing_state_humans,
    _is_injected_runtime_human_text,
)
from evoflow.models.request_payload_logger import extract_latest_user_preview_from_vendor_payload


def test_collect_missing_state_humans_merges_even_with_compaction_summary() -> None:
    summary = HumanMessage(
        content="[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns…",
        name="conversation_summary",
        id="sum-1",
    )
    prior = HumanMessage(content="重启好了", id="user-old")
    db_lc = [summary, prior, AIMessage(content="ok")]
    in_flight = HumanMessage(content="哈哈哈", id="user-new")
    state = [summary, prior, AIMessage(content="ok"), in_flight]

    missing = _collect_missing_state_humans(db_lc, state)
    assert len(missing) == 1
    assert missing[0].content == "哈哈哈"
    assert missing[0].id == "user-new"


def test_collect_missing_state_humans_noop_when_text_already_in_db() -> None:
    summary = HumanMessage(
        content="[CONTEXT COMPACTION — REFERENCE ONLY] …",
        name="conversation_summary",
        id="sum-1",
    )
    user = HumanMessage(content="哈哈哈", id="user-db")
    db_lc = [summary, user]
    # LG auto-id differs from transcript message_id but text matches.
    state = [HumanMessage(content="哈哈哈", id="lg-auto-id")]
    assert _collect_missing_state_humans(db_lc, state) == []


def test_collect_missing_state_humans_skips_synthetic_tail() -> None:
    real = HumanMessage(content="如果我去操作", id="user-1")
    affect = HumanMessage(content="<affect>\n# 情感\n平稳\n", name="session_memory_live", id="live-1")
    db_lc = [HumanMessage(content="旧问题", id="user-old")]
    missing = _collect_missing_state_humans(db_lc, [real, affect])
    assert len(missing) == 1
    assert missing[0].content == "如果我去操作"


def test_injected_runtime_markers_include_affect_and_explore() -> None:
    assert _is_injected_runtime_human_text("<affect>\n平稳")
    assert _is_injected_runtime_human_text("[探索过久] 本轮已连续")
    assert not _is_injected_runtime_human_text("哈哈哈")


def test_extract_latest_user_preview_skips_affect_footer() -> None:
    payload = {
        "messages": [
            {"role": "user", "content": "哈哈哈"},
            {
                "role": "user",
                "name": "session_memory_live",
                "content": "<affect>\n# 情感\n平稳\n",
            },
        ]
    }
    assert extract_latest_user_preview_from_vendor_payload(payload) == "哈哈哈"


def test_extract_latest_user_preview_skips_explore_warning_by_content() -> None:
    payload = {
        "messages": [
            {"role": "user", "content": "重启好了"},
            {
                "role": "user",
                "content": "[探索过久] 本轮已连续多次只读探索且未落地修改。",
            },
        ]
    }
    assert extract_latest_user_preview_from_vendor_payload(payload) == "重启好了"
