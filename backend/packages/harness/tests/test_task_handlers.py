"""Tests for Task downstream handlers (处理人 + content + read_outputs)."""

from evoflow.collab.task_handlers import (
    normalize_handler_entry,
    normalize_task_handlers,
    task_handlers_of,
)


def test_normalize_handler_entry_full():
    row = normalize_handler_entry(
        {
            "agent_code": "frontend-dev",
            "content": "修闪烁",
            "read_outputs": [
                {"type": "file", "key": "report", "value": "docs/a.md", "label": "报告"}
            ],
            "role": "前端",
        }
    )
    assert row["agent_code"] == "frontend-dev"
    assert row["content"] == "修闪烁"
    assert row["role"] == "前端"
    assert row["read_outputs"][0]["value"] == "docs/a.md"
    assert row["read_outputs"][0]["label"] == "报告"


def test_normalize_handler_legacy_outputs_key():
    row = normalize_handler_entry(
        {
            "agent_code": "frontend-dev",
            "content": "修闪烁",
            "outputs": [{"type": "file", "key": "report", "value": "docs/a.md", "label": "报告"}],
        }
    )
    assert row["read_outputs"][0]["value"] == "docs/a.md"
    assert "outputs" not in row


def test_normalize_handler_aliases_and_bare_code():
    a = normalize_handler_entry({"assignee": "backend-dev", "description": "查超时"})
    assert a["agent_code"] == "backend-dev"
    assert a["content"] == "查超时"
    bare = normalize_handler_entry("qa-lead")
    assert bare == {"agent_code": "qa-lead", "content": "", "read_outputs": []}


def test_normalize_task_handlers_json_and_per_person_outputs():
    raw = [
        {
            "agent_code": "frontend-dev",
            "content": "改 UI",
            "outputs": ["outputs/team/qa/analysis/a.md"],
        },
        {
            "agent_code": "backend-dev",
            "content": "查接口",
            "read_outputs": [
                {"type": "file", "key": "report", "value": "outputs/team/qa/analysis/a.md"},
                {"type": "file", "key": "log", "value": "logs/timeout.log"},
            ],
        },
    ]
    items = normalize_task_handlers(raw)
    assert len(items) == 2
    assert items[0]["read_outputs"][0]["value"].endswith("a.md")
    assert len(items[1]["read_outputs"]) == 2


def test_normalize_task_handlers_json_string():
    items = normalize_task_handlers(
        '[{"agent_code":"x","content":"do","outputs":[{"type":"file","key":"a","value":"a.md"}]}]'
    )
    assert items[0]["agent_code"] == "x"
    assert items[0]["read_outputs"][0]["value"] == "a.md"


def test_normalize_task_handlers_rejects_comma_split_of_object_blob():
    """Malformed pseudo-JSON must not become N fake agent_code rows."""
    raw = (
        "[{agent_code:quality-inspector, content:审核 ContentOS 产品定位文档，"
        "重点关注技术可行性（内置浏览器方案、平台 Cookie 拦截、EvoFlow）, "
        "outputs:[{type:file, key:report, "
        "value:docs/roles/product-manager/20260724-09/contentos-product-pos.md, "
        "label:ContentOS 产品定位文档}]}]"
    )
    items = normalize_task_handlers(raw)
    assert len(items) == 1
    assert items[0]["agent_code"] == "quality-inspector"
    assert "ContentOS" in items[0]["content"]
    assert items[0]["read_outputs"][0]["value"].endswith("contentos-product-pos.md")
    assert items[0]["read_outputs"][0].get("label") == "ContentOS 产品定位文档"


def test_normalize_task_handlers_reassembles_comma_split_fragments():
    fragments = [
        "[{agent_code:quality-inspector",
        "content:审核 ContentOS 文档",
        "outputs:[{type:file",
        "key:report",
        "value:docs/a.md",
        "label:报告}]}]",
    ]
    items = normalize_task_handlers(fragments)
    assert len(items) == 1
    assert items[0]["agent_code"] == "quality-inspector"
    assert items[0]["content"] == "审核 ContentOS 文档"
    assert items[0]["read_outputs"][0]["value"] == "docs/a.md"


def test_task_handlers_of_prefers_handlers():
    row = {
        "handlers": [{"agent_code": "a", "content": "1"}],
        "suggested_handlers": [{"agent_code": "b", "content": "2"}],
    }
    assert task_handlers_of(row)[0]["agent_code"] == "a"
    assert task_handlers_of({"suggested_handlers": [{"agent_code": "b", "content": "2"}]})[0][
        "agent_code"
    ] == "b"
