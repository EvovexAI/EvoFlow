"""Structured I/O contract: binding resolution indexes steps by numeric AND semantic ref.

``{{steps.<ref>.output}}`` is the documented grammar and is what the App editor
writes for a semantic step ref, but the runtime subtask row is numbered. Before
the alias mirror, only the numeric key existed, so any LLM node binding written
against a semantic ref hard-failed at dispatch::

    Unresolved input bindings (production mode): payload: unresolved {{steps.x1.output}}

(produced by a real 3-node run whose upstream had valid structured output).
"""

from __future__ import annotations

from typing import Any

from evoflow.collab.expression_resolver import (
    build_steps_output_from_subtasks,
    resolve_bindings,
    resolve_step_inputs,
)


def _upstream(*, ref: str = "1", semantic: str = "x1") -> dict[str, Any]:
    return {
        "id": "s1",
        "ref": ref,
        "semantic_ref": semantic,
        "status": "completed",
        "result_summary": "摘要",
        "structured_output": {"product": "降噪耳机 Aero", "points": ["a", "b", "c"]},
        "outputs": [{"type": "text", "key": "text", "value": "摘要"}],
    }


def test_steps_output_exposes_numeric_and_semantic_keys():
    m = build_steps_output_from_subtasks([_upstream()])
    assert set(m) == {"1", "x1"}
    assert m["x1"] is m["1"]  # same entry, not a copy that can drift
    assert m["x1"]["output"]["product"] == "降噪耳机 Aero"


def test_binding_by_semantic_ref_resolves_whole_output_dict():
    """The exact production failure shape: payload ← {{steps.x1.output}}."""
    step = {"ref": "2", "input_bindings": {"payload": "{{steps.x1.output}}"}}
    res = resolve_step_inputs(step, params={}, subtasks=[_upstream()])
    assert res["has_bindings"] is True
    raw = res["resolved"]["payload"]
    assert raw != "{{steps.x1.output}}", "binding stayed unresolved"
    assert isinstance(raw, dict), type(raw)
    assert raw["product"] == "降噪耳机 Aero"
    assert len(raw["points"]) == 3


def test_binding_by_numeric_ref_still_works():
    step = {"ref": "2", "input_bindings": {"n": "{{steps.1.output.product}}"}}
    res = resolve_step_inputs(step, params={}, subtasks=[_upstream()])
    assert res["resolved"]["n"] == "降噪耳机 Aero"
    # Same expression via the alias resolves identically (one shared entry).
    step2 = {"ref": "2", "input_bindings": {"n": "{{steps.x1.output.product}}"}}
    assert resolve_step_inputs(step2, params={}, subtasks=[_upstream()])["resolved"]["n"] == "降噪耳机 Aero"


def test_worker_profile_semantic_ref_is_also_an_alias_source():
    """Rows persisted before ``semantic_ref`` was hoisted keep it in worker_profile."""
    st = _upstream()
    st.pop("semantic_ref")
    st["worker_profile"] = {"semantic_ref": "x1"}
    assert "x1" in build_steps_output_from_subtasks([st])


def test_numeric_ref_wins_when_a_semantic_ref_collides_with_a_step_number():
    """Alias must never masquerade as another real step (setdefault, not [k]=)."""
    step_two = {
        "id": "s2",
        "ref": "2",
        "status": "completed",
        "result_summary": "二步",
        "structured_output": {"who": "step2"},
    }
    step_one = {**_upstream(), "semantic_ref": "2"}  # alias claims key "2"
    m = build_steps_output_from_subtasks([step_two, step_one])
    assert m["2"]["output"]["who"] == "step2", "real step 2 must not be shadowed"
    assert m["1"]["output"]["product"] == "降噪耳机 Aero"


def test_unresolved_expression_survives_verbatim_for_the_gate_to_catch():
    """Contract: unresolvable → left as ``{{…}}`` in the resolved value.

    ``step_prompt_builder`` scans the built prompt for that residue and raises
    ``_has_unresolved_bindings``, which supervisor/execution turns into a hard
    fail. If the resolver silently blanked it instead, the node would run with
    empty inputs and the failure would never surface.
    """
    step = {"ref": "3", "input_bindings": {"x": "{{steps.nosuch.output}}"}}
    res = resolve_step_inputs(step, params={}, subtasks=[_upstream()])
    assert res["resolved"]["x"] == "{{steps.nosuch.output}}"


def test_incomplete_upstream_is_not_indexed():
    """A running/failed step must not expose half-baked output to dependents."""
    for bad in ("executing", "failed", "pending", "planned"):
        m = build_steps_output_from_subtasks([{**_upstream(), "status": bad}])
        assert m == {}, bad
        resolved = resolve_bindings({"p": "{{steps.x1.output}}"}, params={}, steps_output=m)
        assert resolved["p"] == "{{steps.x1.output}}", bad
