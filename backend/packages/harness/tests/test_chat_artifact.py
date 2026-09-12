"""Unit tests for chat artifact normalization."""

from evoflow.artifacts.chat_artifact import (
    make_artifact_id,
    normalize_chat_artifact,
    normalize_chat_artifacts,
)


def test_normalize_path_file():
    item = normalize_chat_artifact({"path": "D:/ws/report.md", "name": "报告"})
    assert item is not None
    assert item["type"] == "file"
    assert item["path"] == "D:/ws/report.md"
    assert item["name"] == "报告"
    assert item["id"].startswith("path:")


def test_normalize_image_by_ext():
    item = normalize_chat_artifact({"path": "/tmp/chart.PNG"})
    assert item is not None
    assert item["type"] == "image"


def test_normalize_url_video():
    item = normalize_chat_artifact({"type": "video", "url": "https://cdn.example/a.mp4"})
    assert item is not None
    assert item["type"] == "video"
    assert item["url"].startswith("https://")


def test_normalize_html_content():
    item = normalize_chat_artifact({"type": "html", "content": "<html><body>hi</body></html>", "name": "page"})
    assert item is not None
    assert item["type"] == "html"
    assert "content" in item
    assert item["id"].startswith("content:")


def test_dedupe_list():
    items = normalize_chat_artifacts(
        [
            {"path": "/a.md"},
            {"path": "/a.md"},
            "https://example.com/x",
        ]
    )
    assert len(items) == 2


def test_make_artifact_id_stable():
    a = make_artifact_id(type_="file", path="/x/y.md")
    b = make_artifact_id(type_="file", path="/x/y.md")
    assert a == b


def test_normalize_platform_artifact():
    item = normalize_chat_artifact(
        {
            "type": "platform",
            "id": "platform:call_1",
            "label": "修改待办成功",
            "platformAction": "items.update",
            "platformDomain": "items",
            "platformFeedbackKind": "success",
            "url": "/tasks?tab=items",
            "toolCallId": "call_1",
            "platformActions": [{"label": "查看事项", "route": "/tasks?tab=items"}],
        }
    )
    assert item is not None
    assert item["type"] == "platform"
    assert item["platformAction"] == "items.update"
    assert item["toolCallId"] == "call_1"
    assert item["platformActions"][0]["route"] == "/tasks?tab=items"
