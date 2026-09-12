from evoflow.scheduler.rules import classify_ops
from evoflow.scheduler.task_plan import TaskOp, parse_task_plan_from_text


def test_parse_task_plan_json():
    text = """Here is the plan:
<task_plan>
{"ops": [{"op": "read", "path": "/tmp/a.py"}, {"op": "search", "query": "foo"}]}
</task_plan>
"""
    plan = parse_task_plan_from_text(text)
    assert plan is not None
    assert len(plan.ops) == 2
    assert plan.ops[0].op == "read"
    assert plan.ops[1].query == "foo"


def test_tier_classification():
    tier0, tier1, tier2 = classify_ops(
        [
            TaskOp(op="read", path="package.json"),
            TaskOp(op="read", path="src/util.py"),
            TaskOp(op="write", path="out.txt", content="x"),
        ]
    )
    assert len(tier0) == 1
    assert tier0[0].path == "package.json"
    assert len(tier1) == 1
    assert len(tier2) == 1
