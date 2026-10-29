"""MCP tool result budget — 对齐 Zcode 的 resultBudget / 图片归一化。

MCP server 可能返回大 base64 图片和超大文本。Zcode 的做法：
- 图片 block 不直接进模型上下文——存副本、替换为占位引用，防止 provider
  请求体被打爆；
- 文本超预算（普通 MCP 50KB）按 head preview 截断。

本模块在连接池调用层（``pool._invoke_tool``）对返回值做同样的归一化：

- ``{"type": "image", "base64": ...}`` 超过内联阈值 → 落盘到 mcp_images/，
  替换为文本占位块（含路径，模型可用 ``read`` 工具按需查看——与合并后的
  read 图片分流正好衔接）；
- 文本总字符数超预算 → head 截断 + 截断说明；
- ``ToolMessage`` / ``Command`` 形态（interceptor 路径）原样放行。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_TEXT_BUDGET_ENV = "EVOFLOW_MCP_TEXT_BUDGET_CHARS"
_TEXT_BUDGET_DEFAULT = 50_000
_IMAGE_INLINE_ENV = "EVOFLOW_MCP_IMAGE_INLINE_BYTES"
# 与 Zcode MCP_IMAGE_INLINE_RAW_BYTES / 截图 200KB 预算同量级。
_IMAGE_INLINE_DEFAULT = 200_000

_MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def text_budget_chars() -> int:
    raw = os.environ.get(_TEXT_BUDGET_ENV, "").strip()
    if not raw:
        return _TEXT_BUDGET_DEFAULT
    try:
        return max(1_000, int(raw))
    except ValueError:
        return _TEXT_BUDGET_DEFAULT


def image_inline_bytes() -> int:
    raw = os.environ.get(_IMAGE_INLINE_ENV, "").strip()
    if not raw:
        return _IMAGE_INLINE_DEFAULT
    try:
        return max(0, int(raw))
    except ValueError:
        return _IMAGE_INLINE_DEFAULT


def _images_dir() -> Path:
    env_dir = os.environ.get("EVOFLOW_MCP_IMAGES_DIR", "").strip()
    if env_dir:
        base = Path(env_dir)
    else:
        try:
            from evoflow.config.data_paths import resolve_data_base_dir

            base = resolve_data_base_dir() / "mcp_images"
        except Exception:
            base = Path.home() / ".evoflow" / "mcp_images"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _save_image_bytes(image_bytes: bytes, mime_type: str) -> Path | None:
    digest = hashlib.sha1(image_bytes).hexdigest()[:12]
    ext = _MIME_EXTENSIONS.get((mime_type or "").lower(), ".png")
    path = _images_dir() / f"mcp_{int(time.time())}_{digest}{ext}"
    try:
        path.write_bytes(image_bytes)
        return path
    except OSError:
        logger.warning("Failed to save oversized MCP image to %s", path, exc_info=True)
        return None


def _decode_base64(data: str) -> bytes | None:
    try:
        return base64.b64decode(data, validate=False)
    except (binascii.Error, ValueError):
        return None


def _format_bytes(n: int) -> str:
    return f"{n / 1024:.0f}KB" if n < 1024 * 1024 else f"{n / (1024 * 1024):.1f}MB"


def _replace_oversized_image(block: dict[str, Any], tool_name: str) -> dict[str, Any] | None:
    """超阈值 image block → 落盘 + 文本占位块；None 表示保留原图。"""
    data = block.get("base64")
    mime = str(block.get("mime_type") or block.get("mimeType") or "image/png")
    if not isinstance(data, str) or not data:
        return None
    image_bytes = _decode_base64(data)
    if image_bytes is None:
        return None
    if len(image_bytes) <= image_inline_bytes():
        return None
    path = _save_image_bytes(image_bytes, mime)
    if path is None:
        # 落盘失败也不把大图发给模型——宁可丢图不能打爆请求体。
        note = (
            f"[MCP image content omitted: {mime}, {_format_bytes(len(image_bytes))} "
            f"exceeds inline budget]"
        )
    else:
        note = (
            f"[MCP image ({mime}, {_format_bytes(len(image_bytes))}) saved to "
            f"{path} — call the read tool with this path to view it]"
        )
    logger.info(
        "MCP result image normalized: tool=%r %d bytes -> %s",
        tool_name,
        len(image_bytes),
        note[:120],
    )
    return {"type": "text", "text": note}


def _truncate_texts(blocks: list[dict[str, Any]], tool_name: str) -> list[dict[str, Any]]:
    budget = text_budget_chars()
    total = sum(
        len(b.get("text") or "") for b in blocks if b.get("type") == "text"
    )
    if total <= budget:
        return blocks
    out: list[dict[str, Any]] = []
    remaining = budget
    truncated_chars = 0
    for block in blocks:
        if block.get("type") != "text":
            out.append(block)
            continue
        text = str(block.get("text") or "")
        if remaining <= 0:
            truncated_chars += len(text)
            continue
        if len(text) <= remaining:
            remaining -= len(text)
            out.append(block)
            continue
        truncated_chars += len(text) - remaining
        out.append({"type": "text", "text": text[:remaining]})
        remaining = 0
    if truncated_chars > 0:
        out.append(
            {
                "type": "text",
                "text": (
                    f"[MCP output truncated: {truncated_chars} of {total} characters omitted "
                    f"(budget {budget} chars; tune {_TEXT_BUDGET_ENV})]"
                ),
            }
        )
    logger.info(
        "MCP result text truncated: tool=%r %d -> %d chars",
        tool_name,
        total,
        budget,
    )
    return out


def _normalize_blocks(
    blocks: list[Any], tool_name: str
) -> tuple[list[Any], int]:
    images_normalized = 0
    out: list[Any] = []
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "image":
            replaced = _replace_oversized_image(block, tool_name)
            if replaced is not None:
                images_normalized += 1
                out.append(replaced)
                continue
        out.append(block)
    out = _truncate_texts(out, tool_name)
    return out, images_normalized


def normalize_mcp_tool_result(tool_name: str, result: Any) -> Any:
    """归一化 MCP 工具返回值（pool 调用层统一入口）。

    形态覆盖 langchain-mcp-adapters 的 ``_convert_call_tool_result`` 输出：
    - ``str``：纯文本，按预算截断；
    - ``(content, artifact)`` 元组：归一化 content，artifact 原样保留
      （structuredContent 属结构化数据，体积通常可控，且 Zcode 同样不预算它）；
      **必须保持二元组**——即便 artifact 为 ``None``。pool 绑定工具声明
      ``response_format='content_and_artifact'``，拆成裸 list/str 会触发
      LangChain ``ValueError``。
    - content blocks 列表：图片归一 + 文本截断；
    - ``ToolMessage`` / ``Command`` / 其他：原样放行。
    """
    if result is None:
        return result

    was_tuple = isinstance(result, tuple) and len(result) == 2
    artifact: Any = None
    content: Any = result
    if was_tuple:
        content, artifact = result

    def _pack(normalized: Any) -> Any:
        return (normalized, artifact) if was_tuple else normalized

    try:
        if isinstance(content, str):
            budget = text_budget_chars()
            if len(content) > budget:
                logger.info(
                    "MCP result text truncated: tool=%r %d -> %d chars",
                    tool_name,
                    len(content),
                    budget,
                )
                content = (
                    content[:budget]
                    + f"\n\n[MCP output truncated: {len(content) - budget} of "
                    f"{len(content)} characters omitted (budget {budget} chars; "
                    f"tune {_TEXT_BUDGET_ENV})]"
                )
            return _pack(content)

        if isinstance(content, list):
            blocks, images = _normalize_blocks(content, tool_name)
            if images and artifact is None and not blocks:
                blocks = f"[MCP returned {images} oversized image(s) only]"
            return _pack(blocks)
    except Exception:  # noqa: BLE001 - 归一化失败绝不能弄丢工具结果
        logger.warning(
            "MCP result normalization failed for %r; returning raw result", tool_name,
            exc_info=True,
        )
        return result

    # ToolMessage / Command / 其他形态：不解析，原样放行（元组则保持形状）。
    return _pack(content) if was_tuple else result
