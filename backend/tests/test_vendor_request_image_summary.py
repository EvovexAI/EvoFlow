"""Vendor request image presence summary for ModelRequest logs."""

from __future__ import annotations

from evoflow.models.request_payload_logger import summarize_vendor_request_images


def test_summarize_detects_data_uri_and_path_hint():
    tiny = (
        "data:image/jpeg;base64,"
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwg"
        "JC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIy"
        "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFw"
        "ABAQEBAAAAAAAAAAAAAAAAAAUGB//EABUBAQEAAAAAAAAAAAAAAAAAAAAB/8QAFQEBAQAAAAAAAAAAAAAA"
        "AAAAAQL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAP/EABQQAQAAAAAAAAAAAAAAA"
        "AAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAA"
        "AAAAAAAAAD/2gAIAQIBAT8Bf//Z"
    )
    payload = {
        "model": "glm-x",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Here are the images you've viewed:"},
                    {
                        "type": "text",
                        "text": "\n- **D:\\dev\\github\\demo\\media_image_abc.jpeg** (image/jpeg)\n"
                        "[Image attached at: D:\\dev\\github\\demo\\media_image_abc.jpeg]",
                    },
                    {"type": "image_url", "image_url": {"url": tiny}},
                ],
            }
        ],
    }
    summary = summarize_vendor_request_images(payload)
    assert summary["has_images"] is True
    assert summary["image_count"] == 1
    assert summary["data_uri_count"] == 1
    assert summary["names"] == ["media_image_abc.jpeg"]
    assert summary["images"][0]["kind"] == "data_uri"
    assert summary["images"][0]["mime"] == "image/jpeg"
    assert int(summary["images"][0]["approx_bytes"] or 0) > 0


def test_summarize_http_image():
    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": "https://cdn.example.com/path/shot.png?x=1"},
                    }
                ],
            }
        ]
    }
    summary = summarize_vendor_request_images(payload)
    assert summary["has_images"] is True
    assert summary["http_count"] == 1
    assert summary["names"] == ["shot.png"]


def test_summarize_no_images():
    summary = summarize_vendor_request_images(
        {"messages": [{"role": "user", "content": "hello only text"}]}
    )
    assert summary["has_images"] is False
    assert summary["image_count"] == 0
    assert summary["names"] == []
