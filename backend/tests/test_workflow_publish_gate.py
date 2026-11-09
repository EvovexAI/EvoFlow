"""Publish gate must see the dependency graph the author actually wrote.

Regressions from the 2026-11-07 workflow verification run:

* T3 (negative case): a step declaring ``depends_on: ["ghost"]`` came back as
  ``depends_on: []`` — ``_sync_depends_on_from_canvas`` rebuilds the list from
  canvas edges, and edges whose source is not a step are skipped. So Check 1
  (which *does* detect non-existent deps) never saw it, publish succeeded, and
  the step quietly became an entry point that fires immediately.
* condition nodes were publishable with no expression / no branch target /
  branch refs pointing at nothing, because no check looked at them at all.
"""

from __future__ import annotations

from evoflow.collab.app_schema import normalize_app_document
from evoflow.collab.workflow_validator import validate_app_definition


def _app(steps: list[dict], *, parameters: list[dict] | None = None) -> dict:
    return {
        "name": "验证流",
        "goal_template": "",
        "parameters": parameters or [],
        "steps": steps,
    }


# ── unknown depends_on must survive normalization ───────────────────────


def test_unknown_dep_survives_normalization_and_blocks_publish():
    doc = _app(
        [
            {"ref": "a", "name": "A", "goal": "做点事", "assigned_agent": "agent"},
            {"ref": "b", "name": "B", "goal": "等幽灵", "assigned_agent": "agent",
             "depends_on": ["ghost"]},
        ]
    )
    norm = normalize_app_document(doc)
    b = next(s for s in norm["steps"] if s["ref"] == "b")
    assert "ghost" in b["depends_on"], "未知依赖被静默清空 → 该节点变成即刻可跑的入口"

    res = validate_app_definition(norm)
    assert not res["valid"]
    assert any("non-existent step 'ghost'" in e for e in res["errors"])


def test_canvas_is_still_the_execution_truth_for_known_steps():
    """删线的正确表达（UI 发不带 depends_on 的 steps + 画布无边）必须照旧生效。"""
    steps = [
        {"ref": "a", "name": "A", "goal": "x", "assigned_agent": "agent"},
        {"ref": "b", "name": "B", "goal": "y", "assigned_agent": "agent"},  # 依赖已被用户删掉
        {"ref": "c", "name": "C", "goal": "z", "assigned_agent": "agent",
         "depends_on": ["a"]},
    ]
    canvas = {
        "nodes": [
            {"nodeId": "__start__", "type": "start"},
            {"nodeId": "a", "type": "agentStep"},
            {"nodeId": "b", "type": "agentStep"},
            {"nodeId": "c", "type": "agentStep"},
        ],
        "edges": [
            {"source": "__start__", "target": "a"},
            {"source": "__start__", "target": "b"},
            {"source": "a", "target": "c"},
        ],
    }
    norm = normalize_app_document(_app(steps) | {"canvas": canvas})
    by_ref = {s["ref"]: s for s in norm["steps"]}
    assert by_ref["b"]["depends_on"] == [], "画布无边 → 依赖保持为空（真删除语义未被削弱）"
    assert by_ref["c"]["depends_on"] == ["a"]
    assert validate_app_definition(norm)["valid"]


def test_step_declared_dep_is_backfilled_into_canvas():
    """CORE-WF-05：steps 写了 depends_on，画布要补出对应边（未知名除外）。"""
    norm = normalize_app_document(
        _app([
            {"ref": "a", "name": "A", "goal": "x", "assigned_agent": "agent"},
            {"ref": "b", "name": "B", "goal": "y", "assigned_agent": "agent",
             "depends_on": ["a"]},
        ])
    )
    edges = {(e["source"], e["target"]) for e in norm["canvas"]["edges"]}
    assert ("a", "b") in edges
    assert ("ghost", "b") not in edges, "未知 ref 不应被画成边"


def test_mixed_known_and_unknown_deps_keep_both_signals():
    norm = normalize_app_document(
        _app([
            {"ref": "a", "name": "A", "goal": "x", "assigned_agent": "agent"},
            {"ref": "b", "name": "B", "goal": "y", "assigned_agent": "agent",
             "depends_on": ["a", "nope"]},
        ])
    )
    b = next(s for s in norm["steps"] if s["ref"] == "b")
    assert "a" in b["depends_on"] and "nope" in b["depends_on"]
    res = validate_app_definition(norm)
    assert not res["valid"] and any("nope" in e for e in res["errors"])


# ── condition node integrity ────────────────────────────────────────────


def _cond(cond: dict, branches: list[str] | None = None) -> list[dict]:
    steps = [
        {"ref": "s1", "name": "S1", "goal": "x", "assigned_agent": "agent"},
        {"ref": "cond", "name": "判定", "goal": "判断", "assigned_agent": "agent",
         "step_type": "condition", "depends_on": ["s1"], "condition": cond},
    ]
    for ref in branches or ["pass", "fail"]:
        steps.append({"ref": ref, "name": ref.upper(), "goal": "动作",
                      "assigned_agent": "agent", "depends_on": ["cond"]})
    return steps


def test_condition_valid_shape_passes_with_honest_warning():
    norm = normalize_app_document(
        _app(_cond({"expression": "{{score}} >= 60", "true_branch": "pass",
                    "false_branch": "fail"}),
             parameters=[{"name": "score", "type": "text", "required": True, "default": "85"}])
    )
    res = validate_app_definition(norm)
    assert res["valid"], res["errors"]
    assert any("两条分支都会派发执行" in w for w in res["warnings"]), "必须如实告知分流未生效"
    assert any("executor=template" in w for w in res["warnings"]), "要给出可用的替代做法"


def test_condition_without_expression_is_error():
    norm = normalize_app_document(_app(_cond({"true_branch": "pass"})))
    res = validate_app_definition(norm)
    assert not res["valid"]
    assert any("no expression" in e for e in res["errors"])


def test_condition_without_branch_target_is_error():
    norm = normalize_app_document(_app(_cond({"expression": "1 == 1"})))
    res = validate_app_definition(norm)
    assert not res["valid"]
    assert any("declares no branch target" in e for e in res["errors"])


def test_condition_branch_pointing_nowhere_is_error():
    norm = normalize_app_document(
        _app(_cond({"expression": "{{score}} >= 60", "true_branch": "ghost",
                    "false_branch": "fail"}),
             parameters=[{"name": "score", "type": "text", "required": True}])
    )
    res = validate_app_definition(norm)
    assert not res["valid"]
    assert any("true_branch references non-existent step 'ghost'" in e for e in res["errors"])


def test_condition_placeholder_is_not_a_defect():
    """app 定义里就该存 {{param}}（运行时才替换）——别把它判成错误。"""
    cond = {"expression": "{{score}} >= 60", "true_branch": "pass", "false_branch": "fail"}
    norm = normalize_app_document(
        _app(_cond(cond), parameters=[{"name": "score", "type": "text", "required": True}])
    )
    assert validate_app_definition(norm)["valid"]


def test_single_branch_condition_is_allowed():
    """只写 true_branch（达标才做，否则什么都不做）是合法形状。"""
    norm = normalize_app_document(
        _app(_cond({"expression": "{{score}} >= 60", "true_branch": "pass"}, branches=["pass"]),
             parameters=[{"name": "score", "type": "text", "required": True}])
    )
    cond = next(s for s in norm["steps"] if s["ref"] == "cond")
    assert cond["step_type"] == "condition"
    assert "false_branch" not in cond["condition"]
    assert validate_app_definition(norm)["valid"], norm
