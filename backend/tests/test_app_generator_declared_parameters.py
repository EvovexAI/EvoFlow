"""``workflow.generate`` must not discard author-declared parameter definitions.

Regression for the 2026-11-07 run: generating F3 with ``parameters=[{topic…},
{output_dir… default="outputs/wf3"}]`` came back with every ``default`` blanked,
``required`` forced to true and Chinese labels replaced by "Topic"/"Output Dir" —
because extraction rebound the argument it was also supposed to merge with.
"""

from __future__ import annotations

from evoflow.collab.app_generator import _merge_declared_parameters, generate_app_from_plan


def test_declared_defaults_and_labels_win():
    extracted = [
        {"name": "topic", "label": "Topic", "type": "text", "required": True, "default": ""},
        {"name": "output_dir", "label": "Output Dir", "type": "text", "required": True, "default": ""},
    ]
    declared = [
        {"name": "topic", "label": "检索主题", "type": "text", "default": "工作流", "required": True},
        {"name": "output_dir", "label": "输出目录", "type": "text", "default": "outputs/wf3", "required": False},
    ]
    merged = {p["name"]: p for p in _merge_declared_parameters(extracted, declared)}
    assert merged["topic"]["label"] == "检索主题"
    assert merged["output_dir"]["default"] == "outputs/wf3"
    assert merged["output_dir"]["required"] is False


def test_blank_declared_fields_do_not_clobber_extracted():
    extracted = [{"name": "a", "label": "A", "type": "text", "required": True, "default": "x"}]
    merged = _merge_declared_parameters(extracted, [{"name": "a", "label": "", "default": None}])
    assert merged[0]["label"] == "A"
    assert merged[0]["default"] == "x"


def test_declared_only_param_is_appended():
    merged = _merge_declared_parameters([{"name": "a", "label": "A"}], [{"name": "b", "default": "1"}])
    names = {p["name"] for p in merged}
    assert names == {"a", "b"}
    assert merged[-1]["default"] == "1"


def test_no_declared_keeps_extraction_untouched():
    extracted = [{"name": "a", "label": "A", "required": True}]
    assert _merge_declared_parameters(extracted, None) == extracted


def test_generate_app_from_plan_preserves_declared_parameters():
    app = generate_app_from_plan(
        goal="围绕 {{topic}} 成稿写入 {{output_dir}}",
        steps=[{"ref": "s1", "name": "检索", "goal": "检索 {{topic}}"}],
        name="验证流",
        parameters=[
            {"name": "topic", "label": "检索主题", "type": "text", "default": "工作流", "required": True},
            {"name": "output_dir", "label": "输出目录", "type": "text", "default": "outputs/wf3", "required": False},
        ],
    )
    params = {p["name"]: p for p in app["parameters"]}
    assert params["topic"]["default"] == "工作流"
    assert params["output_dir"]["default"] == "outputs/wf3"
    assert params["output_dir"]["required"] is False
    assert params["topic"]["label"] == "检索主题"


def test_auto_parameterized_tag_only_for_heuristic_extracts():
    """Author-declared params must not be reported as auto-extracted."""
    app = generate_app_from_plan(
        goal="固定流程（无占位符）",
        steps=[{"ref": "s1", "name": "采集", "goal": "写文件"}],
        name="无占位符流",
        parameters=[{"name": "date", "label": "日期", "default": "2026-11-07"}],
    )
    assert "auto-parameterized" not in app["tags"]
    assert {p["name"]: p for p in app["parameters"]}["date"]["default"] == "2026-11-07"


def test_without_declared_behaves_as_before():
    app = generate_app_from_plan(
        goal="围绕 {{topic}} 做速览",
        steps=[{"ref": "s1", "name": "调研", "goal": "查 {{topic}}"}],
        name="竞品速览",
    )
    assert {p["name"] for p in app["parameters"]} >= {"topic"}
    assert "auto-parameterized" in app["tags"]
