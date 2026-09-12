"""Tests for structured task outputs + summary helpers."""

from __future__ import annotations

from pathlib import Path

from evoflow.admin.tasks import _outcome_patch, normalize_task_summary, task_summary_of, _summary_patch
from evoflow.collab.task_outputs import (
    evidence_paths_from_outputs,
    normalize_task_outputs,
    outputs_from_evidence_paths,
    task_outputs_of,
)


def test_normalize_task_summary_trims_and_caps():
    assert normalize_task_summary("  hello  ") == "hello"
    assert normalize_task_summary(None) == ""
    long = "x" * 9000
    assert len(normalize_task_summary(long)) == 8000


def test_task_summary_of_prefers_summary():
    row = {"summary": "done A", "result": "legacy", "outcome": "out"}
    assert task_summary_of(row) == "done A"
    assert task_summary_of({"result": "only-result"}) == "only-result"
    assert task_summary_of({"result_summary": "from rollup"}) == "from rollup"
    assert task_summary_of({}) == ""


def test_summary_patch_mirrors_to_result():
    patch = _summary_patch("摸底完成；报告已写 artifacts/x.md")
    assert patch["summary"].startswith("摸底完成")
    assert patch["result"] == patch["summary"]
    assert "error" not in patch


def test_summary_patch_failed_sets_error():
    patch = _summary_patch("卡在权限", target_status="failed")
    assert patch["summary"] == "卡在权限"
    assert patch["error"] == "卡在权限"


def test_normalize_task_outputs_typed_items():
    items = normalize_task_outputs(
        [
            {"type": "file", "key": "report", "value": "docs/a.md", "label": "报告"},
            {"type": "url", "key": "pr", "value": "https://example.com/pr/1"},
            {"type": "text", "key": "note", "value": "已核对"},
            {"type": "path", "key": "legacy", "value": "x.py"},  # alias → file
            {"value": ""},  # dropped
        ]
    )
    assert len(items) == 4
    assert items[0] == {"type": "file", "key": "report", "value": "docs/a.md", "label": "报告"}
    assert items[1]["type"] == "url"
    assert items[3]["type"] == "file"


def test_normalize_task_outputs_json_string_and_bare_path():
    items = normalize_task_outputs('[{"type":"file","key":"a","value":"a.md"}]')
    assert items[0]["value"] == "a.md"
    bare = normalize_task_outputs("artifacts/report.md")
    assert bare == [{"type": "file", "key": "artifact", "value": "artifacts/report.md"}]


def test_normalize_task_outputs_repairs_path_label_pseudo_json():
    """Agents often emit ``[{path.md,label:标题}]`` instead of JSON."""
    messy = (
        "[{docs/roles/evoflow-marketing-director/20260722-14/"
        "抖音口播稿_EvoFlow智能体员工.md,label:抖音口播稿 - EvoFlow智能体员工}]"
    )
    items = normalize_task_outputs(messy)
    assert len(items) == 1
    assert items[0]["type"] == "file"
    assert items[0]["value"].endswith("抖音口播稿_EvoFlow智能体员工.md")
    assert "," not in items[0]["value"]
    assert items[0]["label"] == "抖音口播稿 - EvoFlow智能体员工"

    # Already-persisted dirty value field also repairs on read/normalize.
    dirty_value = (
        "docs/roles/x/20260722-14/抖音口播稿_EvoFlow智能体员工.md,"
        "label:抖音口播稿 - EvoFlow智能体员工}]"
    )
    one = normalize_task_outputs([{"type": "file", "key": "a", "value": dirty_value}])
    assert one[0]["value"].endswith("抖音口播稿_EvoFlow智能体员工.md")
    assert one[0]["label"] == "抖音口播稿 - EvoFlow智能体员工"


def test_normalize_task_outputs_repairs_type_key_value_blob():
    blob = (
        "type:file,key:口播稿,value:docs/roles/evoflow-marketing-director/"
        "20260722-14/抖音口播稿_EvoFlow智能体员工.md"
    )
    items = normalize_task_outputs(blob)
    assert len(items) == 1
    assert items[0]["key"] == "口播稿"
    assert items[0]["value"].endswith("抖音口播稿_EvoFlow智能体员工.md")
    assert "type:" not in items[0]["value"]

    nested = normalize_task_outputs(
        [
            {
                "type": "file",
                "key": "script",
                "value": blob,
                "label": "抖音口播稿 - EvoFlow智能体员工",
            }
        ]
    )
    assert nested[0]["value"].endswith("抖音口播稿_EvoFlow智能体员工.md")
    assert nested[0]["label"] == "抖音口播稿 - EvoFlow智能体员工"


def test_evidence_paths_roundtrip():
    outs = outputs_from_evidence_paths(["a.md", "b.md", ""])
    assert len(outs) == 2
    assert all(o["type"] == "file" for o in outs)
    assert evidence_paths_from_outputs(outs) == ["a.md", "b.md"]


def test_task_outputs_of_prefers_outputs_then_evidence():
    row = {
        "outputs": [{"type": "url", "key": "link", "value": "https://x"}],
        "evidence_paths": ["ignored.md"],
    }
    assert task_outputs_of(row)[0]["type"] == "url"
    assert task_outputs_of({"evidence_paths": ["only.md"]})[0]["value"] == "only.md"
    assert task_outputs_of({"worker_profile": {"evidence_paths": ["wp.md"]}})[0]["value"] == "wp.md"


def test_outcome_patch_writes_summary_and_outputs():
    patch = _outcome_patch(
        "摸底完成",
        [{"type": "file", "key": "report", "value": "docs/x.md"}],
    )
    assert patch["summary"] == "摸底完成"
    assert patch["result"] == "摸底完成"
    assert patch["outputs"][0]["value"] == "docs/x.md"
    assert patch["evidence_paths"] == ["docs/x.md"]


def test_outcome_patch_absolutizes_relative_file_outputs(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    rel = "docs/roles/pm/plan.md"
    (root / "docs" / "roles" / "pm").mkdir(parents=True)
    (root / rel).write_text("# ok", encoding="utf-8")
    patch = _outcome_patch(
        "done",
        [{"type": "file", "key": "plan", "value": rel}],
        workspace_root=str(root),
        agent_code="pm",
    )
    value = patch["outputs"][0]["value"]
    assert Path(value).is_absolute()
    assert value.replace("\\", "/").endswith("docs/roles/pm/plan.md")
    assert Path(value).exists()


def test_absolutize_file_path_finds_basename_under_role_docs(tmp_path):
    from evoflow.collab.task_outputs import absolutize_file_path

    root = tmp_path / "ws"
    target = root / "docs" / "roles" / "product-manager" / "20260725" / "empty-state-copy-polish-plan.md"
    target.parent.mkdir(parents=True)
    target.write_text("plan", encoding="utf-8")
    abs_path = absolutize_file_path(
        "empty-state-copy-polish-plan.md",
        str(root),
        agent_code="product-manager",
    )
    assert Path(abs_path).resolve() == target.resolve()


def test_task_outputs_of_absolutizes_when_workspace_known(tmp_path, monkeypatch):
    from evoflow.collab import task_outputs as to

    root = tmp_path / "ws"
    (root / "docs").mkdir(parents=True)
    monkeypatch.setattr(to, "workspace_root_for_task_row", lambda _row: str(root))
    monkeypatch.setattr(to, "agent_code_for_task_row", lambda _row: "pm")
    items = task_outputs_of(
        {
            "assigned_to": "pm",
            "outputs": [{"type": "file", "key": "a", "value": "docs/a.md"}],
        }
    )
    assert Path(items[0]["value"]).is_absolute()
    assert items[0]["value"].replace("\\", "/").endswith("docs/a.md")
