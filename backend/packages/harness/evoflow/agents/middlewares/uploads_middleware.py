"""Middleware to inject uploaded files information into agent context."""

import logging
from pathlib import Path

try:
    from typing import Any, NotRequired, override
except ImportError:
    from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import BaseMessage, HumanMessage
from langgraph.runtime import Runtime

from evoflow.config.paths import Paths, get_paths

logger = logging.getLogger(__name__)

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif"}


class UploadsMiddlewareState(AgentState):
    """State schema for uploads middleware."""

    uploaded_files: NotRequired[list[dict] | None]


class UploadsMiddleware(AgentMiddleware[UploadsMiddlewareState]):
    """Inject ``<uploaded_files>`` after transcript hydration (``before_model``).

    ``before_agent`` captures ``additional_kwargs.files`` onto agent state.
    Injection runs after ``SessionTranscriptHydrationMiddleware`` rebuilds history.
    """

    state_schema = UploadsMiddlewareState

    def __init__(self, base_dir: str | None = None):
        super().__init__()
        self._paths = Paths(base_dir) if base_dir else get_paths()

    def _read_attachment_text(self, file: dict, uploads_dir: Path | None) -> str:
        if not uploads_dir:
            return ""
        path = uploads_dir / str(file.get("filename") or "")
        if not path.is_file() or path.suffix.lower() in _IMAGE_SUFFIXES:
            return ""
        try:
            from evoflow.knowledge.parser import parse_file

            text = parse_file(path).strip()
            if len(text) > 30000:
                text = text[:30000] + "\n[文件内容已截断]"
            return text
        except Exception:
            logger.exception("Failed to extract uploaded file %s", path.name)
            return ""

    def _display_path(
        self,
        file: dict,
        uploads_dir: Path | None,
        *,
        use_virtual_paths: bool,
    ) -> str:
        filename = str(file.get("filename") or "")
        virtual = str(file.get("path") or f"/mnt/user-data/uploads/{filename}")
        if use_virtual_paths:
            return virtual
        host = str(file.get("absolute_path") or "").strip()
        if host:
            return host
        if uploads_dir and filename:
            candidate = uploads_dir / filename
            if candidate.is_file():
                try:
                    return str(candidate.resolve())
                except OSError:
                    return str(candidate)
        return virtual

    def _create_files_message(
        self,
        new_files: list[dict],
        historical_files: list[dict],
        uploads_dir: Path | None,
        *,
        use_virtual_paths: bool = True,
    ) -> str:
        lines = ["<uploaded_files>"]

        lines.append("The following files were uploaded in this message:")
        lines.append("")
        if new_files:
            for file in new_files:
                size_kb = file["size"] / 1024
                size_str = f"{size_kb:.1f} KB" if size_kb < 1024 else f"{size_kb / 1024:.1f} MB"
                lines.append(f"- {file['filename']} ({size_str})")
                lines.append(f"  Path: {self._display_path(file, uploads_dir, use_virtual_paths=use_virtual_paths)}")
                if Path(file["filename"]).suffix.lower() in _IMAGE_SUFFIXES:
                    lines.append(
                        "  Image attached as pixels in this message; inspect the image itself. "
                        "For edit/generate (e.g. media.generate_image), pass this Path as reference_image_urls — "
                        "do not search the filesystem for the original paste source."
                    )
                else:
                    extracted = self._read_attachment_text(file, uploads_dir)
                    if extracted:
                        lines.append("  Extracted content:")
                        lines.append(extracted)
                    else:
                        lines.append("  Content extraction failed; the file is still available at the path above.")
                lines.append("")
        else:
            lines.append("(empty)")

        if historical_files:
            lines.append("The following files were uploaded in previous messages and are still available:")
            lines.append("")
            for file in historical_files:
                size_kb = file["size"] / 1024
                size_str = f"{size_kb:.1f} KB" if size_kb < 1024 else f"{size_kb / 1024:.1f} MB"
                lines.append(f"- {file['filename']} ({size_str})")
                lines.append(f"  Path: {self._display_path(file, uploads_dir, use_virtual_paths=use_virtual_paths)}")
                lines.append("")

        lines.append("You can read these files using the `read` tool with the paths shown above.")
        lines.append("</uploaded_files>")

        return "\n".join(lines)

    def _files_from_kwargs(self, message: HumanMessage, uploads_dir: Path | None = None) -> list[dict] | None:
        kwargs_files = (message.additional_kwargs or {}).get("files")
        if not isinstance(kwargs_files, list) or not kwargs_files:
            return None

        files = []
        for f in kwargs_files:
            if not isinstance(f, dict):
                continue
            filename = f.get("filename") or ""
            if not filename or Path(filename).name != filename:
                continue
            if uploads_dir is not None and not (uploads_dir / filename).is_file():
                continue
            entry = {
                "filename": filename,
                "size": int(f.get("size") or 0),
                "path": str(f.get("path") or f"/mnt/user-data/uploads/{filename}"),
                "extension": Path(filename).suffix,
            }
            abs_path = str(f.get("absolute_path") or "").strip()
            if abs_path:
                entry["absolute_path"] = abs_path
            files.append(entry)
        return files if files else None

    def _human_text(self, message: HumanMessage) -> str:
        content = message.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
            return "\n".join(parts)
        return str(content or "")

    def _already_injected(self, message: HumanMessage) -> bool:
        return "<uploaded_files>" in self._human_text(message)

    def _content_blocks_from_message(self, message: HumanMessage) -> list[str | dict[str, Any]]:
        content = message.content
        if isinstance(content, str):
            return [{"type": "text", "text": content}]
        if isinstance(content, list):
            return list(content)
        return [{"type": "text", "text": str(content or "")}]

    def _inject_block(self, last: HumanMessage, block: str) -> HumanMessage:
        """Prefix ``<uploaded_files>`` without dropping multimodal ``image_url`` blocks."""
        blocks = self._content_blocks_from_message(last)
        prefix = blocks[0] if blocks and isinstance(blocks[0], dict) and blocks[0].get("type") == "text" else None
        original = self._human_text(last)
        merged_text = f"{block}\n\n{original}"
        if prefix and isinstance(prefix, dict):
            blocks[0] = {"type": "text", "text": merged_text}
        else:
            blocks = [{"type": "text", "text": merged_text}, *blocks]
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

    def _resolve_uploads_dir(self, runtime: Runtime) -> Path | None:
        thread_id = (runtime.context or {}).get("thread_id")
        return self._paths.sandbox_uploads_dir(thread_id) if thread_id else None

    def _collect_new_files(
        self,
        state: UploadsMiddlewareState,
        messages: list[BaseMessage],
        uploads_dir: Path | None,
    ) -> list[dict]:
        stored = state.get("uploaded_files")
        if isinstance(stored, list) and stored:
            return [f for f in stored if isinstance(f, dict)]
        for msg in reversed(messages):
            if isinstance(msg, HumanMessage):
                found = self._files_from_kwargs(msg, uploads_dir)
                if found:
                    return found
        return []

    @override
    def before_agent(self, state: UploadsMiddlewareState, runtime: Runtime) -> dict | None:
        messages = list(state.get("messages", []))
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, HumanMessage):
            return None
        uploads_dir = self._resolve_uploads_dir(runtime)
        new_files = self._files_from_kwargs(last, uploads_dir) or []
        if not new_files:
            return None
        return {"uploaded_files": new_files}

    @override
    def before_model(self, state: UploadsMiddlewareState, runtime: Runtime) -> dict | None:
        messages = list(state.get("messages", []))
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, HumanMessage):
            return None
        if self._already_injected(last):
            return None

        uploads_dir = self._resolve_uploads_dir(runtime)
        use_virtual_paths = bool((runtime.context or {}).get("use_virtual_paths"))
        new_files = self._collect_new_files(state, messages, uploads_dir)
        new_filenames = {f["filename"] for f in new_files}
        historical_files: list[dict] = []
        if uploads_dir and uploads_dir.exists():
            for file_path in sorted(uploads_dir.iterdir()):
                if file_path.is_file() and file_path.name not in new_filenames:
                    stat = file_path.stat()
                    historical_files.append(
                        {
                            "filename": file_path.name,
                            "size": stat.st_size,
                            "path": f"/mnt/user-data/uploads/{file_path.name}",
                            "absolute_path": str(file_path.resolve()),
                            "extension": file_path.suffix,
                        }
                    )

        if not new_files and not historical_files:
            return None

        block = self._create_files_message(
            new_files,
            historical_files,
            uploads_dir,
            use_virtual_paths=use_virtual_paths,
        )
        updated = self._inject_block(last, block)
        logger.info(
            "uploaded_files injected before_model: new=%s historical=%s uploads_dir=%s use_virtual=%s",
            [f.get("filename") for f in new_files],
            [f.get("filename") for f in historical_files],
            str(uploads_dir) if uploads_dir else "(none)",
            use_virtual_paths,
        )
        return {"uploaded_files": new_files, "messages": [updated]}

    @override
    async def abefore_model(self, state: UploadsMiddlewareState, runtime: Runtime) -> dict | None:
        return self.before_model(state, runtime)
