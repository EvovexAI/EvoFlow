"""Skip LLM __rollup__ when answer_from_ref / single leaf is enough."""

from __future__ import annotations

from evoflow.collab.app_rollup import needs_auto_rollup, prefer_answer_node_rollup
from evoflow.collab.workflow_handoff_sanitize import RESOLVED_BINDING_STR_MAX, _DEFAULT_SUMMARY_MAX


def _chain_app(**extra):
    return {
        "steps": [
            {"ref": "s1", "name": "提炼", "depends_on": []},
            {"ref": "s2", "name": "扩写", "depends_on": ["s1"]},
        ],
        **extra,
    }


def _fan_in_app(**extra):
    return {
        "steps": [
            {"ref": "a", "name": "A", "depends_on": []},
            {"ref": "b", "name": "B", "depends_on": []},
            {"ref": "c", "name": "合并", "depends_on": ["a", "b"]},
        ],
        **extra,
    }


def test_single_leaf_chain_prefers_copy():
    prefer, ref = prefer_answer_node_rollup(_chain_app())
    assert prefer is True
    assert ref == "s2"
    assert needs_auto_rollup(_chain_app()) is False


def test_answer_from_ref_prefers_copy():
    app = _fan_in_app(answer_from_ref="c", final_rollup="auto")
    prefer, ref = prefer_answer_node_rollup(app)
    assert prefer is True
    assert ref == "c"
    assert needs_auto_rollup(app) is False


def test_explicit_answer_node_only():
    app = _chain_app(final_rollup="answer_node_only", answer_from_ref="s2")
    prefer, ref = prefer_answer_node_rollup(app)
    assert prefer is True
    assert ref == "s2"
    assert needs_auto_rollup(app) is False


def test_multi_leaf_keeps_llm_rollup():
    # Two leaves a,b with no merge step that depends on both as sole leaf —
    # wait, fan_in has single leaf c. Need true multi-leaf:
    app = {
        "steps": [
            {"ref": "a", "depends_on": []},
            {"ref": "b", "depends_on": []},
        ],
        "final_rollup": "auto",
    }
    prefer, ref = prefer_answer_node_rollup(app)
    assert prefer is False
    assert ref == ""
    assert needs_auto_rollup(app) is True


def test_custom_instruction_keeps_llm_without_answer_ref():
    app = _fan_in_app(final_rollup="auto", final_rollup_instruction="请按验收标准写综述")
    # fan_in has single leaf "c" — prefer_answer_node still wins via single leaf
    # unless custom instr blocks when no answer_ref... our logic:
    # custom_instr and not answer_ref → False. Single leaf check is AFTER that.
    # So custom instruction without answer_ref forces LLM even for single leaf.
    prefer, _ = prefer_answer_node_rollup(app)
    assert prefer is False
    assert needs_auto_rollup(app) is True


def test_custom_instruction_with_answer_ref_still_copies():
    app = _fan_in_app(
        final_rollup="auto",
        answer_from_ref="c",
        final_rollup_instruction="ignored when answer ref set",
    )
    prefer, ref = prefer_answer_node_rollup(app)
    assert prefer is True
    assert ref == "c"


def test_single_step_no_rollup():
    app = {"steps": [{"ref": "only"}]}
    assert needs_auto_rollup(app) is False
    assert prefer_answer_node_rollup(app) == (False, "")


def test_handoff_limits_raised():
    assert _DEFAULT_SUMMARY_MAX >= 2400
    assert RESOLVED_BINDING_STR_MAX >= 3000
