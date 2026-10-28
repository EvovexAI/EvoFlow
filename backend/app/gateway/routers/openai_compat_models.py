"""OpenAI-compatible facade over **configured platform models** (not Apps).

Paths (isolated from App ``/v1``):
  GET  /openai/v1/models
  POST /openai/v1/chat/completions

Auth: same Gateway bearer as ``/api/models/*`` (user/install token).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from evoflow.models.openai_compat_invoke import (
    OpenAICompatError,
    ainvoke_chat_completion,
    list_configured_models_openai,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/openai/v1", tags=["openai-compat-models"])


class ChatMessage(BaseModel):
    role: str
    content: Any = None


class ChatCompletionsRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    model: str | None = None
    stream: bool = False
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    thinking_enabled: bool | None = None


@router.get("/models")
async def list_models() -> dict[str, Any]:
    """List EvoFlow-configured models in OpenAI ``/v1/models`` shape."""
    return list_configured_models_openai()


@router.post("/chat/completions")
async def chat_completions(body: ChatCompletionsRequest) -> dict[str, Any]:
    """Single-shot chat completion (text + optional vision multimodal content).

    Phase-1: ``stream=false`` only. Use platform media APIs for image/video generation.
    """
    if body.stream:
        raise HTTPException(
            status_code=400,
            detail="stream=true is not supported yet on /openai/v1/chat/completions; use stream=false",
        )
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages is required")
    messages = [{"role": m.role, "content": m.content} for m in body.messages]
    try:
        return await ainvoke_chat_completion(
            model=body.model,
            messages=messages,
            temperature=body.temperature,
            thinking_enabled=body.thinking_enabled,
            record_usage=True,
        )
    except OpenAICompatError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message) from e
    except Exception as e:
        logger.exception("openai_compat chat/completions failed")
        raise HTTPException(status_code=502, detail=str(e)) from e
