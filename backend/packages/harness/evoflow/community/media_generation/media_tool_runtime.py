"""Runtime media tool schemas: expose only configured + enabled providers to the LLM."""

from __future__ import annotations

from typing import Any, Literal, Optional, Union

from langchain.tools import BaseTool
from pydantic import BaseModel, Field, create_model

from evoflow.community.media_generation.config_helpers import (
    available_media_providers,
    configured_image_providers,
    configured_video_providers,
    configured_voice_providers,
    ensure_media_credentials,
)

_MEDIA_TOOL_NAMES = frozenset(
    {
        "media_image_generate",
        "media_video_generate",
        "media_task_wait",
        "media_voiceover_synthesize",
    }
)

_PROVIDER_LABELS: dict[str, str] = {
    "jimeng": "火山方舟(jimeng)",
    "wan": "通义万相(wan)",
    "kling": "可灵(kling)",
    "volcengine": "火山 TTS",
    "dashscope": "DashScope TTS",
}


def media_providers_runtime_hint(*, lang: str = "zh") -> str:
    """Short system-prompt block: only list providers the user actually enabled."""
    ensure_media_credentials()
    avail = available_media_providers()
    image = avail.get("image") or []
    video = avail.get("video") or []
    voice = avail.get("voice") or []
    if lang.startswith("zh"):
        if not image and not video:
            return (
                "<media_providers_runtime>\n"
                "当前**无可用**媒体生图/生视频渠道。请配置环境变量（如 `VOLCENGINE_API_KEY`、`AGNES_API_KEY`）或在 EvoFlow 设置 → 模型 → 创意媒体 中填写并启用。"
                "**禁止**在工具参数中传入 `wan`、`kling` 或任何未在下列列表中的 provider。\n"
                "</media_providers_runtime>"
            )
        parts = []
        if image:
            parts.append(f"生图仅可用 provider：`{'`、`'.join(image)}`")
        if video:
            parts.append(f"生视频仅可用：`{'`、`'.join(video)}`")
        if voice:
            parts.append(f"配音仅可用：`{'`、`'.join(voice)}`")
        return (
            "<media_providers_runtime>\n"
            + "；".join(parts)
            + "。**禁止**传入未启用或未配置的 provider（如已停用的 wan/kling）。"
            " jimeng 失败时不要自动换厂商，应提示用户检查 API Key 与模型设置。\n"
            "</media_providers_runtime>"
        )
    if not image and not video:
        return (
            "<media_providers_runtime>\n"
            "No media image/video providers are configured. Set env vars (e.g. VOLCENGINE_API_KEY, AGNES_API_KEY) or configure EvoFlow Settings → Models → Creative Media. "
            "Do not pass `wan`, `kling`, or other providers in tool args.\n"
            "</media_providers_runtime>"
        )
    parts = []
    if image:
        parts.append(f"image providers: {', '.join(image)}")
    if video:
        parts.append(f"video providers: {', '.join(video)}")
    if voice:
        parts.append(f"voice providers: {', '.join(voice)}")
    return (
        "<media_providers_runtime>\n"
        + "; ".join(parts)
        + ". Do not pass disabled or unconfigured providers. Do not failover to wan/kling on jimeng errors.\n"
        "</media_providers_runtime>"
    )


def _label_providers(providers: list[str]) -> str:
    return "、".join(_PROVIDER_LABELS.get(p, p) for p in providers)


def _provider_field_description(providers: list[str], *, required: bool) -> str:
    if not providers:
        return "当前无可用 provider；请先在 EvoPanel 配置视频模型。"
    if len(providers) == 1:
        p = providers[0]
        return f"固定为 {_PROVIDER_LABELS.get(p, p)}（仅此渠道已启用）。"
    names = _label_providers(providers)
    req = "必填。" if required else "可选；"
    return f"{req}仅允许：{names}。禁止 wan/kling 等未启用渠道。"


def _providers_for_tool(name: str) -> tuple[list[str], bool]:
    """Return (provider ids, provider_field_required)."""
    if name == "media_voiceover_synthesize":
        return list(configured_voice_providers()), False
    if name == "media_task_wait":
        return list(configured_video_providers() or configured_image_providers()), True
    if name == "media_image_generate":
        return list(configured_image_providers()), False
    if name == "media_video_generate":
        return list(configured_video_providers()), False
    return [], False


def _runtime_tool_description(tool: BaseTool, providers: list[str], *, required: bool) -> str:
    base = str(tool.description or "")
    if not providers:
        return (
            base
            + "\n\n**Runtime**: No media provider is configured/enabled. "
            "Ask the user to configure Volcengine Ark in EvoPanel before calling this tool."
        )
    if len(providers) == 1:
        p = providers[0]
        return (
            base
            + f"\n\n**Runtime**: Only `{p}` is available. Do **not** pass `provider` or try other vendors."
        )
    names = ", ".join(f"`{p}`" for p in providers)
    req = "required" if required else "optional"
    return (
        base
        + f"\n\n**Runtime**: `provider` is {req}; allowed values only: {names}. "
        "Do not use disabled providers (e.g. wan/kling when not enabled)."
    )


def _provider_type(providers: list[str], *, required: bool) -> Any:
    if not providers:
        return None
    if len(providers) == 1:
        lit = Literal[providers[0]]  # type: ignore[valid-type]
        return lit if required else Optional[lit]  # noqa: UP045
    lit = Literal[tuple(providers)]  # type: ignore[valid-type]
    return lit if required else Union[lit, None]  # noqa: UP007


def _provider_field(providers: list[str], *, required: bool) -> tuple[Any, Any] | None:
    ptype = _provider_type(providers, required=required)
    if ptype is None:
        return None
    desc = _provider_field_description(providers, required=required)
    if required:
        return (ptype, Field(..., description=desc))
    return (ptype, Field(None, description=desc))


def _llm_args_schema(tool_name: str, providers: list[str], *, required: bool) -> type[BaseModel] | None:
    """Schema exposed to the LLM (no injected ToolRuntime field)."""
    pf = _provider_field(providers, required=required)
    if tool_name == "media_image_generate":
        fields: dict[str, Any] = {
            "prompt": (str, Field(..., description="Text description of the image to generate.")),
            "mode": (
                Literal["text2image", "image2image"],
                Field("text2image", description="text2image or image2image (requires reference_image_urls)."),
            ),
            "reference_image_urls": (
                Optional[str],  # noqa: UP045
                Field(None, description="Comma-separated URLs or JSON array of reference images."),
            ),
            "aspect_ratio": (str, Field("16:9", description="e.g. 16:9, 1:1, 9:16.")),
            "max_wait_seconds": (int, Field(300, description="Max time to poll async providers.")),
        }
        if pf and (len(providers) > 1 or required):
            fields["provider"] = pf
        return create_model("MediaImageGenerateInputRuntime", **fields)  # type: ignore[call-overload, return-value]

    if tool_name == "media_video_generate":
        fields = {
            "prompt": (str, Field(..., description="Motion/scene description.")),
            "mode": (
                Literal["text2video", "image2video"],
                Field("text2video", description="text2video or image2video (needs first_frame_url)."),
            ),
            "first_frame_url": (Optional[str], Field(None, description="First-frame image URL for image2video.")),  # noqa: UP045
            "audio_url": (Optional[str], Field(None, description="Optional external driving audio.")),  # noqa: UP045
            "duration": (int, Field(5, description="Target seconds (5 or 10 typical).")),
            "aspect_ratio": (str, Field("16:9", description="e.g. 16:9, 9:16.")),
            "generate_audio": (Optional[bool], Field(None, description="Seedance native audio (jimeng default true).")),  # noqa: UP045
        }
        if pf and (len(providers) > 1 or required):
            fields["provider"] = pf
        return create_model("MediaVideoGenerateInputRuntime", **fields)  # type: ignore[call-overload, return-value]

    if tool_name == "media_task_wait":
        if not pf:
            return None
        fields = {
            "task_id": (str, Field(..., description="Task ID from media_video_generate.")),
            "provider": pf,
            "media_kind": (
                Literal["image", "video", "audio"],
                Field("video", description="image, video, or audio."),
            ),
            "max_wait_seconds": (int, Field(600, description="Max poll time.")),
        }
        return create_model("MediaTaskWaitInputRuntime", **fields)  # type: ignore[call-overload, return-value]

    if tool_name == "media_voiceover_synthesize":
        fields = {
            "text": (str, Field(..., description="Narration script (plain text).")),
            "output_filename": (str, Field("voiceover.mp3", description="File name under outputs/.")),
        }
        if pf and (len(providers) > 1 or required):
            fields["provider"] = pf
        return create_model("MediaVoiceoverInputRuntime", **fields)  # type: ignore[call-overload, return-value]

    return None


def _delegate_execution(patched: BaseTool, exec_tool: BaseTool) -> BaseTool:
    """Run through the original tool so ToolRuntime injection still works."""

    def invoke(input: Any, config: Any = None, **kwargs: Any) -> Any:
        return exec_tool.invoke(input, config=config, **kwargs)

    async def ainvoke(input: Any, config: Any = None, **kwargs: Any) -> Any:
        return await exec_tool.ainvoke(input, config=config, **kwargs)

    object.__setattr__(patched, "invoke", invoke)
    object.__setattr__(patched, "ainvoke", ainvoke)
    object.__setattr__(patched, "func", exec_tool.func)
    if getattr(exec_tool, "coroutine", None):
        object.__setattr__(patched, "coroutine", exec_tool.coroutine)
    return patched


def patch_media_tool_for_runtime(tool: BaseTool) -> BaseTool:
    name = str(getattr(tool, "name", "") or "").strip()
    if name not in _MEDIA_TOOL_NAMES:
        return tool
    ensure_media_credentials()
    providers, required = _providers_for_tool(name)
    new_desc = _runtime_tool_description(tool, providers, required=required)
    llm_schema = _llm_args_schema(name, providers, required=required)
    if llm_schema is None:
        tool.description = new_desc
        return tool

    exec_tool = tool
    try:
        patched = exec_tool.model_copy(update={"args_schema": llm_schema, "description": new_desc})
    except Exception:
        patched = exec_tool
        patched.args_schema = llm_schema
        patched.description = new_desc
    return _delegate_execution(patched, exec_tool)


def apply_runtime_media_tool_schemas(tools: list[BaseTool]) -> list[BaseTool]:
    """Return tools list with media provider enums narrowed to configured vendors."""
    return [patch_media_tool_for_runtime(t) for t in tools]
