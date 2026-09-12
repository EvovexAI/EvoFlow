"""Shareable approval outputs filter (no source code)."""

from __future__ import annotations

from evoflow.collab.task_outputs import is_code_output_path, shareable_approval_outputs


def test_shareable_outputs_skip_source_code():
    items = shareable_approval_outputs(
        [
            {"type": "file", "key": "plan", "value": "docs/roles/pm/plan.md", "label": "方案"},
            {"type": "file", "key": "code", "value": "apps/web/src/page.tsx", "label": "页面"},
            {"type": "file", "key": "rs", "value": "src-tauri/src/lib.rs"},
            {"type": "url", "key": "demo", "value": "https://example.com/x", "label": "演示"},
            {"type": "text", "key": "note", "value": "验收通过即可", "label": "备注"},
            {"type": "file", "key": "py", "value": "backend/foo.py"},
        ]
    )
    values = {i["value"] for i in items}
    assert "docs/roles/pm/plan.md" in values
    assert "https://example.com/x" in values
    assert "验收通过即可" in values
    assert "apps/web/src/page.tsx" not in values
    assert "src-tauri/src/lib.rs" not in values
    assert "backend/foo.py" not in values


def test_is_code_output_path():
    assert is_code_output_path("a/b/c.ts") is True
    assert is_code_output_path("docs/a.md") is False
    assert is_code_output_path("report.pdf") is False
