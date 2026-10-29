"""Shared media URL extraction across vendor payload shapes."""

from __future__ import annotations

from evoflow.admin.platform_media import _enrich_preview
from evoflow.admin.platform_ui_feedback import _media_preview_items
from evoflow.community.media_generation.url_extract import (
    extract_media_urls,
    extract_media_urls_from_text,
    guess_media_kind,
    primary_media_url,
)


def test_extract_jimeng_style_data_list():
    urls = extract_media_urls(
        {"data": [{"url": "https://cdn.example.com/a.png"}], "created": 1},
        also_scan_text=False,
    )
    assert urls == ["https://cdn.example.com/a.png"]


def test_extract_minimax_h3_nested_content():
    urls = extract_media_urls(
        {
            "task": {
                "status": "Success",
                "content": {"url": "https://cdn.minimax.example/out.mp4"},
            }
        },
        also_scan_text=False,
    )
    assert urls[0].endswith(".mp4")


def test_extract_wan_output_video_url():
    assert (
        primary_media_url({"output": {"task_status": "SUCCEEDED", "video_url": "https://x/v.mp4"}})
        == "https://x/v.mp4"
    )


def test_extract_kling_task_result_list():
    urls = extract_media_urls(
        {
            "data": {
                "task_status": "succeed",
                "task_result": {"videos": [{"url": "https://kling.example/a.mp4"}]},
            }
        },
        also_scan_text=False,
    )
    assert urls == ["https://kling.example/a.mp4"]


def test_extract_openai_videos_download_url():
    assert (
        primary_media_url({"status": "completed", "download_url": "https://gw.example/file.bin?sig=1"})
        == "https://gw.example/file.bin?sig=1"
    )


def test_regex_fallback_from_text():
    text = 'done path=C:/Users/admin/.evoflow-dev/outputs/media_image_1.jpeg ok'
    found = extract_media_urls_from_text(text)
    assert any(x.endswith("media_image_1.jpeg") for x in found)


def test_guess_media_kind():
    assert guess_media_kind("https://x/a.mp4") == "video"
    assert guess_media_kind("D:/out/x.png") == "image"


def test_enrich_preview_fills_from_nested_vendor_shape():
    blob = _enrich_preview(
        {
            "ok": True,
            "provider": "minimax",
            "task_id": "oai:task_x",
            "status": "succeeded",
            "data": {"download_url": "https://cdn.example/v.mp4"},
        },
        media_kind="video",
    )
    assert blob.get("url") == "https://cdn.example/v.mp4"
    assert blob.get("preview", {}).get("src") == "https://cdn.example/v.mp4"
    assert blob.get("preview", {}).get("kind") == "video"


def test_media_preview_items_uses_extract_fallback():
    items = _media_preview_items(
        {
            "ok": True,
            "media_kind": "video",
            "provider": "minimax",
            "output": {"content": {"url": "https://cdn.example/clip.mp4"}},
        }
    )
    assert len(items) == 1
    assert items[0]["kind"] == "video"
    assert items[0]["artifactUri"].endswith(".mp4")


def test_enrich_preview_prefers_local_path():
    blob = _enrich_preview(
        {
            "ok": True,
            "absolute_path": r"C:\out\media_image_1.png",
            "url": "https://remote.example/a.png",
        },
        media_kind="image",
    )
    assert blob["preview"]["src"].endswith("media_image_1.png")
    assert blob["url"] == "https://remote.example/a.png"
