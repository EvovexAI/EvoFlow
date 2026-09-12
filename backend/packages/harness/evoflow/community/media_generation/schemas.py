from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field

ImageProvider = Literal["jimeng", "kling", "wan"]
VideoProvider = Literal["jimeng", "kling", "wan"]
ImageMode = Literal["text2image", "image2image"]
VideoMode = Literal["text2video", "image2video"]
VoiceProvider = Literal["volcengine", "dashscope"]
SubtitleFormat = Literal["srt", "vtt"]


class MediaToolResponse(BaseModel):
    ok: bool = True
    provider: str = ""
    task_id: str | None = None
    status: str = "submitted"
    url: str | None = None
    local_path: str | None = None
    absolute_path: str | None = None
    first_frame_url: str | None = None
    urls: list[str] = Field(default_factory=list)
    message: str = ""
    next_action: str = ""
    extra: dict[str, Any] = Field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(self.model_dump(exclude_none=True), ensure_ascii=False, indent=2)


def _with_envelope(data: dict[str, Any], *, ok: bool, message: str = "") -> str:
    from evoflow.agents.tool_response_envelope import EVOFLOW_TOOL_META_KEY

    meta: dict[str, Any] = {"status": "ok" if ok else "error"}
    if message:
        meta["message"] = message
    data[EVOFLOW_TOOL_META_KEY] = meta
    return json.dumps(data, ensure_ascii=False, indent=2)


def success_response(**kwargs: Any) -> str:
    data = MediaToolResponse(ok=True, **kwargs).model_dump(exclude_none=True)
    return _with_envelope(data, ok=True)


def error_response(message: str, **kwargs: Any) -> str:
    data = MediaToolResponse(ok=False, status="error", message=message, **kwargs).model_dump(exclude_none=True)
    return _with_envelope(data, ok=False, message=message)
