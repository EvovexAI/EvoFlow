"""IM channel user run_id must own following assistant/tool rows for V4 hydrate."""

from __future__ import annotations

from evoflow.persistence.transcript_run_id import enrich_run_ids_in_order


def test_enrich_rewrites_assistant_hop_id_to_user_turn() -> None:
    rows = [
        {"role": "user", "run_id": "channel-uuid", "content": "hi"},
        {"role": "assistant", "run_id": "lg-hop-1", "content": "tools…"},
        {"role": "tool", "run_id": "lg-hop-2", "content": "{}"},
        {"role": "assistant", "run_id": "lg-hop-3", "content": "done"},
    ]
    out = enrich_run_ids_in_order(rows)
    assert [r["run_id"] for r in out] == [
        "channel-uuid",
        "channel-uuid",
        "channel-uuid",
        "channel-uuid",
    ]


def test_enrich_starts_new_turn_on_next_user() -> None:
    rows = [
        {"role": "user", "run_id": "a", "content": "1"},
        {"role": "assistant", "run_id": "hop", "content": "r1"},
        {"role": "user", "run_id": "b", "content": "2"},
        {"role": "assistant", "run_id": "hop2", "content": "r2"},
    ]
    out = enrich_run_ids_in_order(rows)
    assert [r["run_id"] for r in out] == ["a", "a", "b", "b"]


def test_enrich_fills_missing_assistant_run_id() -> None:
    rows = [
        {"role": "user", "run_id": "u1", "content": "q"},
        {"role": "assistant", "content": "a"},
    ]
    out = enrich_run_ids_in_order(rows)
    assert out[1]["run_id"] == "u1"
