"""Tests for workflow plan/runtime step ref bridging."""

from __future__ import annotations

from evoflow.collab.app_step_ref_bridge import (
    build_step_ref_alias_map,
    enrich_step_detail,
    find_step_by_ref,
    mirror_ref_aliases,
    pick_preferred_run_outputs_step,
    resolve_step_ref,
)


def test_build_alias_map_merges_semantic_and_numeric_refs() -> None:
    plan = [
        {"ref": "brief", "name": "分镜与口播"},
        {"ref": "assemble", "name": "拼接成片"},
    ]
    steps = [
        {"ref": "1", "semantic_ref": "brief", "status": "completed"},
        {"ref": "5", "semantic_ref": "assemble", "status": "completed", "outputs": [{"value": "final.mp4"}]},
    ]
    aliases = build_step_ref_alias_map(plan, steps, app_steps=plan)
    assert resolve_step_ref("brief", aliases) == "1"
    assert resolve_step_ref("assemble", aliases) == "5"


def test_mirror_ref_aliases_duplicates_status_maps() -> None:
    aliases = {"brief": "1", "1": "1"}
    subtask_status = {"1": "completed"}
    mirror_ref_aliases(subtask_status, aliases)
    assert subtask_status["brief"] == "completed"


def test_pick_preferred_run_outputs_resolves_answer_semantic_ref() -> None:
    steps = [
        {"ref": "1", "status": "completed", "outputs": []},
        {
            "ref": "5",
            "semantic_ref": "assemble",
            "status": "completed",
            "outputs": [{"type": "file", "value": "outputs/final.mp4"}],
        },
    ]
    aliases = build_step_ref_alias_map(
        [{"ref": "assemble"}],
        steps,
        app_steps=[{"ref": "assemble"}],
    )
    hit = pick_preferred_run_outputs_step(steps, answer_ref="assemble", alias_map=aliases)
    assert hit is not None
    assert hit["ref"] == "5"
    assert hit["outputs"][0]["value"] == "outputs/final.mp4"


def test_pick_preferred_falls_back_to_last_successful_outputs() -> None:
    steps = [
        {"ref": "1", "status": "completed", "outputs": [{"value": "a.md"}]},
        {"ref": "2", "status": "completed", "outputs": [{"value": "z.mp4"}]},
    ]
    hit = pick_preferred_run_outputs_step(steps, answer_ref="", alias_map={})
    assert hit is not None
    assert hit["ref"] == "2"


def test_enrich_step_detail_prefers_plan_display_name() -> None:
    row = enrich_step_detail(
        {"ref": "1", "name": "Step 1: 分镜与口播", "status": "completed"},
        subtask={"ref": "1"},
        plan_step={"ref": "brief", "name": "分镜与口播"},
        app_step={"ref": "brief", "name": "分镜与口播"},
        index=0,
    )
    assert row["semantic_ref"] == "brief"
    assert row["display_name"] == "分镜与口播"


def test_find_step_by_ref_with_alias() -> None:
    steps = [{"ref": "3", "semantic_ref": "videos", "outputs": ["x"]}]
    aliases = build_step_ref_alias_map([{"ref": "videos"}], steps)
    hit = find_step_by_ref(steps, "videos", aliases)
    assert hit is not None
    assert hit["ref"] == "3"
