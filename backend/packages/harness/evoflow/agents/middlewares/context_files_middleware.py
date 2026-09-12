"""Inject user-attached workspace files into the agent context (composer-style @file)."""

from __future__ import annotations

import logging
import os
from pathlib import Path

try:
    from typing import Any, NotRequired, override
except ImportError:
    from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import BaseMessage, HumanMessage
from langgraph.runtime import Runtime

from evoflow.tools.builtins.vision_analysis_core import (
    bytes_to_data_url,
    load_image_bytes_for_native,
    main_model_supports_vision,
    prepare_image_bytes_for_native,
)

logger = logging.getLogger(__name__)

_INLINE_MAX_CHARS = 12_000
_INLINE_MAX_LINES = 400

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"}


class ContextFilesMiddlewareState(AgentState):
    context_files: NotRequired[list[dict] | None]


class ContextFilesMiddleware(AgentMiddleware[ContextFilesMiddlewareState]):
    """Inject ``<context_files>`` after transcript hydration (``before_model``).

    When the main model supports vision, image attachments are injected as native
    ``image_url`` blocks on the user turn (Hermes-style) instead of prompting
    ``view_image``.
    """

    state_schema = ContextFilesMiddlewareState

    def _resolve_path(self, entry: dict, workspace_root: str | None) -> Path | None:
        raw = str(entry.get("path") or entry.get("absolute_path") or "").strip()
        if not raw:
            return None
        p = Path(os.path.expanduser(os.path.expandvars(raw)))
        if p.is_absolute():
            resolved = p.resolve()
        elif workspace_root:
            base = Path(os.path.expanduser(os.path.expandvars(workspace_root))).resolve()
            resolved = (base / raw.replace("\\", "/").lstrip("/")).resolve()
            try:
                resolved.relative_to(base)
            except ValueError:
                logger.warning("Context file escapes workspace: %s", raw)
                return None
        else:
            resolved = p.resolve()
        if not resolved.is_file():
            return None
        return resolved

    def _is_image_file(self, path: Path) -> bool:
        return path.suffix.lower() in _IMAGE_EXTENSIONS

    def _is_binary_file(self, path: Path) -> bool:
        ext = path.suffix.lower()
        if ext in _IMAGE_EXTENSIONS:
            return True
        if ext in {
            ".pdf",
            ".zip",
            ".gz",
            ".7z",
            ".rar",
            ".exe",
            ".dll",
            ".so",
            ".dylib",
            ".mp3",
            ".mp4",
            ".mov",
            ".avi",
            ".wav",
            ".woff",
            ".woff2",
            ".ttf",
            ".otf",
            ".docx",
            ".xlsx",
            ".pptx",
            ".doc",
            ".xls",
            ".ppt",
        }:
            return True
        try:
            with path.open("rb") as f:
                chunk = f.read(1024)
            if b"\x00" in chunk:
                return True
        except OSError:
            return True
        return False

    def _read_snippet(self, path: Path, entry: dict, *, native_vision: bool) -> str:
        if self._is_image_file(path):
            if native_vision:
                return (
                    "(image attached below as pixels — already visible to the vision model; "
                    "do NOT call view_image for this path)"
                )
            size = path.stat().st_size if path.exists() else 0
            return (
                f"(binary image, {size} bytes — do not inline; "
                "use view_image with this Path)"
            )
        if self._is_binary_file(path):
            size = path.stat().st_size if path.exists() else 0
            return (
                f"(binary file, {size} bytes — do not inline; "
                "use read_file / vision tools with this Path)"
            )
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return f"(unreadable: {e})"
        start = entry.get("start_line")
        end = entry.get("end_line")
        if start is not None or end is not None:
            lines = text.splitlines()
            s = max(1, int(start or 1)) - 1
            e = int(end) if end is not None else len(lines)
            text = "\n".join(lines[s:e])
        if len(text) > _INLINE_MAX_CHARS:
            lines = text.splitlines()
            if len(lines) > _INLINE_MAX_LINES:
                text = "\n".join(lines[:_INLINE_MAX_LINES])
            if len(text) > _INLINE_MAX_CHARS:
                text = text[:_INLINE_MAX_CHARS] + "\n… [truncated — use read_file for full content]"
        return text

    def _build_block(
        self,
        entries: list[dict],
        workspace_root: str | None,
        *,
        native_vision: bool,
    ) -> str:
        has_native_images = False
        lines = ["<context_files>", "User-attached workspace files for this turn:", ""]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name") or Path(str(entry.get("path") or "")).name or "file")
            resolved = self._resolve_path(entry, workspace_root)
            if not resolved:
                lines.append(f"- {name}: (not found or not allowed)")
                lines.append("")
                continue
            if native_vision and self._is_image_file(resolved):
                has_native_images = True
            snippet = self._read_snippet(resolved, entry, native_vision=native_vision)
            lines.append(f"- {name}")
            lines.append(f"  Path: {resolved}")
            lines.append("  ```")
            lines.extend(snippet.splitlines() or ["(empty)"])
            lines.append("  ```")
            lines.append("")
        if has_native_images:
            lines.append(
                "Attached images are included as pixels in this user message; "
                "do not call view_image for these paths."
            )
        else:
            lines.append("Prefer these paths when editing or explaining; use read_file for more.")
        lines.append("</context_files>")
        return "\n".join(lines)

    def _build_block_virtual(self, entries: list[dict]) -> str:
        lines = ["<context_files>", "User-attached workspace files (virtual paths):", ""]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            rel = str(entry.get("path") or "").strip().replace("\\", "/").lstrip("/")
            name = str(entry.get("name") or Path(rel).name or "file")
            vpath = f"/mnt/user-data/workspace/{rel}" if rel else "/mnt/user-data/workspace"
            lines.append(f"- {name}")
            lines.append(f"  Path: {vpath}")
            lines.append("")
        lines.append("Use read_file with the virtual paths above.")
        lines.append("</context_files>")
        return "\n".join(lines)

    def _native_image_blocks(self, entries: list[dict], workspace_root: str | None) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            resolved = self._resolve_path(entry, workspace_root)
            if not resolved or not self._is_image_file(resolved):
                continue
            loaded = load_image_bytes_for_native(local_path=str(resolved))
            if isinstance(loaded, str):
                logger.warning("context_files native image load failed path=%s err=%s", resolved, loaded)
                continue
            raw_bytes, mime = loaded
            prepared, out_mime = prepare_image_bytes_for_native(raw_bytes, mime)
            blocks.append(
                {
                    "type": "image_url",
                    "image_url": {"url": bytes_to_data_url(prepared, out_mime)},
                }
            )
            logger.info(
                "context_files native image block path=%s size_kb=%.1f",
                resolved,
                len(prepared) / 1024,
            )
        return blocks

    def _context_files_from_message(self, message: HumanMessage) -> list[dict] | None:
        raw = (message.additional_kwargs or {}).get("context_files")
        if not isinstance(raw, list) or not raw:
            return None
        out = [x for x in raw if isinstance(x, dict) and str(x.get("path") or "").strip()]
        return out or None

    def _normalize_entries(self, raw: Any) -> list[dict] | None:
        if not isinstance(raw, list) or not raw:
            return None
        out = [x for x in raw if isinstance(x, dict) and str(x.get("path") or "").strip()]
        return out or None

    def _entries_for_turn(self, state: ContextFilesMiddlewareState, messages: list[BaseMessage]) -> list[dict] | None:
        stored = self._normalize_entries(state.get("context_files"))
        if stored:
            return stored
        for msg in reversed(messages):
            if isinstance(msg, HumanMessage):
                entries = self._context_files_from_message(msg)
                if entries:
                    return entries
        return None

    def _human_text(self, message: HumanMessage) -> str:
        content = message.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block_item in content:
                if isinstance(block_item, str):
                    parts.append(block_item)
                elif isinstance(block_item, dict) and block_item.get("type") == "text":
                    parts.append(str(block_item.get("text") or ""))
            return "\n".join(parts)
        return str(content or "")

    def _already_injected(self, message: HumanMessage) -> bool:
        return "<context_files>" in self._human_text(message)

    def _content_blocks_from_message(self, message: HumanMessage) -> list[str | dict[str, Any]]:
        content = message.content
        if isinstance(content, str):
            return [{"type": "text", "text": content}]
        if isinstance(content, list):
            return list(content)
        return [{"type": "text", "text": str(content or "")}]

    def _inject_block(self, last: HumanMessage, block: str, *, image_blocks: list[dict[str, Any]] | None = None) -> HumanMessage:
        blocks = self._content_blocks_from_message(last)
        prefix = blocks[0] if blocks and isinstance(blocks[0], dict) and blocks[0].get("type") == "text" else None
        original = self._human_text(last)
        merged_text = f"{block}\n\n{original}"
        if prefix and isinstance(prefix, dict):
            blocks[0] = {"type": "text", "text": merged_text}
        else:
            blocks = [{"type": "text", "text": merged_text}, *blocks]
        if image_blocks:
            blocks.extend(image_blocks)
        if len(blocks) == 1 and isinstance(blocks[0], dict) and blocks[0].get("type") == "text":
            return HumanMessage(
                content=str(blocks[0].get("text") or ""),
                id=last.id,
                additional_kwargs=last.additional_kwargs,
            )
        return HumanMessage(
            content=blocks,
            id=last.id,
            additional_kwargs=last.additional_kwargs,
        )

    @override
    def before_agent(self, state: ContextFilesMiddlewareState, runtime: Runtime) -> dict | None:
        messages = list(state.get("messages", []))
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, HumanMessage):
            return None
        entries = self._context_files_from_message(last)
        if not entries:
            return None
        return {"context_files": entries}

    @override
    def before_model(self, state: ContextFilesMiddlewareState, runtime: Runtime) -> dict | None:
        messages = list(state.get("messages", []))
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, HumanMessage):
            return None
        if self._already_injected(last):
            return None
        entries = self._entries_for_turn(state, messages)
        if not entries:
            return None

        ctx = runtime.context or {}
        workspace_root = str(ctx.get("local_workspace_root") or "").strip() or None
        use_virtual = bool(ctx.get("use_virtual_paths"))
        native_vision = main_model_supports_vision(runtime)
        block = (
            self._build_block_virtual(entries)
            if use_virtual and not workspace_root
            else self._build_block(entries, workspace_root, native_vision=native_vision)
        )
        image_blocks = self._native_image_blocks(entries, workspace_root) if native_vision else None
        updated = self._inject_block(last, block, image_blocks=image_blocks or None)
        paths = [str(e.get("path") or "") for e in entries]
        logger.info(
            "context_files injected before_model: count=%d paths=%s native_images=%d workspace_root=%s",
            len(entries),
            paths,
            len(image_blocks or []),
            workspace_root or "(none)",
        )
        return {"context_files": entries, "messages": [updated]}

    @override
    async def abefore_model(self, state: ContextFilesMiddlewareState, runtime: Runtime) -> dict | None:
        return self.before_model(state, runtime)
