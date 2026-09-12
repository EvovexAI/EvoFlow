from evoflow.community.media_generation.aspect_ratio import (
    jimeng_image_size_for_quality,
    jimeng_video_resolution_for_quality,
)


def test_jimeng_4k_image_size_16_9() -> None:
    assert jimeng_image_size_for_quality("16:9", "4k") == "3840x2160"


def test_jimeng_video_resolution_4k() -> None:
    assert jimeng_video_resolution_for_quality("4k") == "4k"
