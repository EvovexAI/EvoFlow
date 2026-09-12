"""Tests for workflow step handoff sanitization (context overflow prevention)."""

from __future__ import annotations

from evoflow.collab.workflow_handoff_sanitize import (
    format_upstream_subtask_handoff,
    is_path_or_url,
    json_for_handoff_prompt,
    sanitize_output_item,
    sanitize_output_value_field,
    sanitize_resolved_bindings,
    sanitize_steps_output_entry,
    sanitize_string_for_handoff,
    sanitize_value_for_handoff,
    strip_binary_payloads_from_text,
)


def test_strip_data_image_uri() -> None:
    blob = "data:image/png;base64,AAAA" + ("A" * 600)
    out = strip_binary_payloads_from_text(f"prefix {blob} suffix")
    assert "base64" not in out.lower() or "omitted" in out.lower()
    assert "prefix" in out


def test_sanitize_output_value_rejects_base64() -> None:
    huge = "data:image/jpeg;base64," + ("X" * 1000)
    assert "omitted" in sanitize_output_value_field(huge).lower()


def test_sanitize_value_preserves_paths() -> None:
    path = "outputs/run_123/scene_01.png"
    assert sanitize_value_for_handoff(path) == path
    assert is_path_or_url(path)


def test_sanitize_value_truncates_large_json() -> None:
    big = {"text": "x" * 5000}
    out = sanitize_value_for_handoff(big)
    assert isinstance(out, dict)
    assert len(str(out["text"])) < 5000
    assert "truncated" in str(out["text"]).lower()


def test_sanitize_resolved_bindings_strips_nested_base64() -> None:
    resolved = {
        "storyboard": {
            "frames": [{"image_base64": "data:image/png;base64," + ("B" * 800)}],
            "path": "outputs/storyboard.md",
        }
    }
    safe = sanitize_resolved_bindings(resolved)
    assert safe["storyboard"]["path"] == "outputs/storyboard.md"
    assert "omitted" in str(safe["storyboard"]["frames"][0]["image_base64"]).lower()


def test_json_for_handoff_prompt_caps_size() -> None:
    text = json_for_handoff_prompt({"a": "z" * 10000}, max_chars=500)
    assert len(text) < 700
    assert "truncated" in text.lower()


def test_sanitize_steps_output_entry() -> None:
    entry = sanitize_steps_output_entry(
        {
            "output": {"prompt": "p" * 3000},
            "summary": "done",
            "artifacts": [
                {
                    "type": "file",
                    "key": "img1",
                    "value": "outputs/img1.png",
                    "label": "frame 1",
                }
            ],
            "artifacts_keyed": {},
        }
    )
    assert entry["artifacts"][0]["value"] == "outputs/img1.png"
    assert len(str(entry["output"]["prompt"])) < 3000


def test_sanitize_output_item() -> None:
    item = sanitize_output_item(
        {
            "type": "file",
            "key": "v1",
            "value": "data:image/png;base64," + ("C" * 900),
            "label": "clip",
        }
    )
    assert "omitted" in item["value"].lower()
    assert item["label"] == "clip"


def test_format_upstream_subtask_handoff_path_first() -> None:
    dep = {
        "status": "completed",
        "task_report": "分镜完成，详见产出路径。",
        "outputs": [
            {"type": "file", "key": "brief", "value": "outputs/brief.md"},
        ],
        "evidence_paths": ["outputs/brief.md"],
    }
    text = format_upstream_subtask_handoff(dep, dep_name="Step 1", dep_id="st_1")
    assert "brief.md" in text
    assert "data:image" not in text


def test_sanitize_string_for_handoff() -> None:
    s = sanitize_string_for_handoff("hello " + ("world " * 500), max_len=100)
    assert len(s) < 200
    assert "truncated" in s.lower()
