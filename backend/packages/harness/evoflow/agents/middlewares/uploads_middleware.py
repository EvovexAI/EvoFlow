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

    def _create_files_message(self, new_files: list[dict], historical_files: list[dict]) -> str:
        lines = ["<uploaded_files>"]

        lines.append("The following files were uploaded in this message:")
        lines.append("")
        if new_files:
            for file in new_files:
                size_kb = file["size"] / 1024
                size_str = f"{size_kb:.1f} KB" if size_kb < 1024 else f"{size_kb / 1024:.1f} MB"
                lines.append(f"- {file['filename']} ({size_str})")
                lines.append(f"  Path: {file['path']}")
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
                lines.append(f"  Path: {file['path']}")
                lines.append("")

        lines.append("You can read these files using the `read_file` tool with the paths shown above.")
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
            files.append(
                {
                    "filename": filename,
                    "size": int(f.get("size") or 0),
                    "path": str(f.get("path") or f"/mnt/user-data/uploads/{filename}"),
                    "extension": Path(filename).suffix,
                }
            )
        return files if files else None

    def _human_text(self, message: HumanMessage) -> str:
        content = message.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
            return "\n".join(parts)
        return str(content or "")

    def _already_injected(self, message: HumanMessage) -> bool:
        return "<uploaded_files>" in self._human_text(message)

    def _inject_block(self, last: HumanMessage, block: str) -> HumanMessage:
        original = self._human_text(last)
        return HumanMessage(
            content=f"{block}\n\n{original}",
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
                            "extension": file_path.suffix,
                        }
                    )

        if not new_files and not historical_files:
            return None

        block = self._create_files_message(new_files, historical_files)
        updated = self._inject_block(last, block)
        logger.info(
            "uploaded_files injected before_model: new=%s historical=%s uploads_dir=%s",
            [f.get("filename") for f in new_files],
            [f.get("filename") for f in historical_files],
            str(uploads_dir) if uploads_dir else "(none)",
        )
        return {"uploaded_files": new_files, "messages": [updated]}

    @override
    async def abefore_model(self, state: UploadsMiddlewareState, runtime: Runtime) -> dict | None:
        return self.before_model(state, runtime)
