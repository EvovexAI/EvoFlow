"""Echo external memory: per-thread JSON files under ``{base_dir}/memory-providers/echo/``.

* **Store:** after each ``sync_turn``, append one turn and atomically write JSON (same tmp+replace
  pattern as ``FileMemoryStorage``).
* **Query (prefetch):** not full-text search — loads the thread file (if mtime changed), then
  formats the **last up to 5 turns** in order. The user ``query`` is only echoed in a header line
  as context for the model; it does **not** filter which turns are returned.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from collections import deque
from datetime import UTC, datetime
from pathlib import Path

from langchain_core.messages import HumanMessage

from evoflow.agents.memory_plugins.base import ExternalMemoryProvider
from evoflow.agents.memory_plugins.plugin_memory_audit import pm_event
from evoflow.config.memory_config import get_memory_config
from evoflow.config.paths import get_paths

logger = logging.getLogger(__name__)

_MAX_TURNS_PER_THREAD = 32
_MAX_PROMPT_CHARS = 6000
_SAFE_THREAD_RE = re.compile(r"[^a-zA-Z0-9_-]+")


def _echo_dir() -> Path:
    d = get_paths().base_dir / "memory-providers" / "echo"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _thread_file(thread_id: str) -> Path:
    safe = _SAFE_THREAD_RE.sub("_", (thread_id or "").strip())[:120] or "default"
    return _echo_dir() / f"{safe}.json"


def _clip(text: str, n: int) -> str:
    t = (text or "").strip()
    if len(t) <= n:
        return t
    return t[: n - 1] + "…"


class EchoMemoryProvider(ExternalMemoryProvider):
    """File-backed echo memory: one JSON file per ``thread_id``."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._turns: dict[str, deque[tuple[str, str]]] = {}
        self._summaries: dict[str, deque[str]] = {}
        # Last known on-disk mtime per thread (for reload-before-read).
        self._file_mtime: dict[str, float | None] = {}

    @property
    def name(self) -> str:
        return "echo"

    def system_prompt_block(self) -> str:
        return ""

    def _read_disk(self, thread_id: str) -> None:
        path = _thread_file(thread_id)
        dq: deque[tuple[str, str]] = deque(maxlen=_MAX_TURNS_PER_THREAD)
        sq: deque[str] = deque(maxlen=_MAX_TURNS_PER_THREAD)
        mtime: float | None = None
        if path.exists():
            try:
                mtime = path.stat().st_mtime
                raw = json.loads(path.read_text(encoding="utf-8"))
                for item in (raw.get("turns") or [])[-_MAX_TURNS_PER_THREAD:]:
                    if not isinstance(item, dict):
                        continue
                    dq.append(
                        (
                            str(item.get("user", ""))[:8000],
                            str(item.get("assistant", ""))[:8000],
                        )
                    )
                    sq.append(str(item.get("summary", "") or "")[:4000])
            except (json.JSONDecodeError, OSError, TypeError) as e:
                logger.warning("Echo memory load failed %s: %s", path, e)
                mtime = None
        with self._lock:
            self._turns[thread_id] = dq
            self._summaries[thread_id] = sq
            self._file_mtime[thread_id] = mtime

    def _maybe_reload(self, thread_id: str) -> None:
        path = _thread_file(thread_id)
        try:
            cur = path.stat().st_mtime if path.exists() else None
        except OSError:
            cur = None
        with self._lock:
            prev = self._file_mtime.get(thread_id)
            if thread_id in self._turns and prev == cur:
                return
        self._read_disk(thread_id)

    def _persist(self, thread_id: str) -> None:
        path = _thread_file(thread_id)
        with self._lock:
            dq = self._turns.get(thread_id)
            sq = self._summaries.get(thread_id)
            if dq is None:
                return
            uas = list(dq)
            sums = list(sq) if sq is not None else []
            while len(sums) < len(uas):
                sums.append("")
            turns_out = [{"user": u, "assistant": a, "summary": s} for (u, a), s in zip(uas, sums, strict=False)]
            payload = {
                "version": "1",
                "thread_id": thread_id,
                "updatedAt": datetime.now(UTC).isoformat(),
                "turns": turns_out,
            }
        tmp = path.with_suffix(".tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)
            mtime = path.stat().st_mtime
        except OSError as e:
            logger.error("Echo memory save failed %s: %s", path, e)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return
        with self._lock:
            self._file_mtime[thread_id] = mtime
        pm_event("echo_memory_saved", thread_id=thread_id, path=str(path), turns=len(turns_out))

    def _summarize_turn(self, user_content: str, assistant_content: str) -> str:
        cfg = get_memory_config()
        if not cfg.echo_summarize_enabled:
            return ""
        try:
            from evoflow.agents.memory.updater import _extract_text
            from evoflow.models import create_chat_model

            model_name = cfg.echo_summarize_model or cfg.model_name
            pm_event(
                "echo_summarize_llm_invoke",
                model=str(model_name or "default_first_model"),
                user_chars=len(user_content or ""),
                assistant_chars=len(assistant_content or ""),
            )
            model = create_chat_model(name=model_name, thinking_enabled=False, invocation_kind="memory")
            prompt = (
                "Compress this single user–assistant chat turn for long-term recall.\n"
                'Output ONLY 1–3 short bullet lines starting with "- ". '
                "Use the same primary language as the user's message.\n"
                "No title, no preamble.\n\n"
                f"User:\n{_clip(user_content, _MAX_PROMPT_CHARS)}\n\n"
                f"Assistant:\n{_clip(assistant_content, _MAX_PROMPT_CHARS)}"
            )
            resp = model.invoke([HumanMessage(content=prompt)])
            text = _extract_text(resp.content).strip()
            out = text[:4000]
            if out:
                pm_event(
                    "echo_summarize_llm_done",
                    summary_chars=len(out),
                    summary_preview=out,
                )
            else:
                pm_event("echo_summarize_llm_empty", reason="model_returned_blank")
            return out
        except Exception as e:
            logger.warning("Echo summarize_turn skipped: %s", e)
            pm_event("echo_summarize_llm_failed", error=str(e))
            return ""

    def sync_turn(self, user_content: str, assistant_content: str, *, thread_id: str = "") -> None:
        if not thread_id:
            return
        u = (user_content or "").strip()
        a = (assistant_content or "").strip()
        if not u and not a:
            return

        self._maybe_reload(thread_id)

        summary = self._summarize_turn(u, a) if get_memory_config().echo_summarize_enabled else ""

        with self._lock:
            dq = self._turns.setdefault(thread_id, deque(maxlen=_MAX_TURNS_PER_THREAD))
            dq.append((u[:8000], a[:8000]))
            sq = self._summaries.setdefault(thread_id, deque(maxlen=_MAX_TURNS_PER_THREAD))
            sq.append(summary.strip() if summary else "")

        self._persist(thread_id)

    def prefetch(self, query: str, *, thread_id: str = "") -> str:
        if not thread_id:
            return ""
        self._maybe_reload(thread_id)

        with self._lock:
            dq = self._turns.get(thread_id)
            if not dq:
                return ""
            turns_list = list(dq)[-5:]
            sq = self._summaries.get(thread_id)
            sums_list = list(sq)[-5:] if sq else []

        if len(sums_list) < len(turns_list):
            sums_list = [""] * (len(turns_list) - len(sums_list)) + sums_list
        elif len(sums_list) > len(turns_list):
            sums_list = sums_list[-len(turns_list) :]

        lines: list[str] = []
        for j, ((u, a), s) in enumerate(zip(turns_list, sums_list), start=1):
            parts: list[str] = []
            if s.strip():
                parts.append(f"**Summary:**\n{s.strip()[:1200]}")
            parts.append(f"**User:** {u[:1200]}\n**Assistant:** {a[:1200]}")
            lines.append(f"### Turn {j}\n" + "\n\n".join(parts))

        q = (query or "").strip()
        header = f"(last user query preview: {q[:200]})\n\n" if q else ""
        body = header + "\n\n".join(lines)
        pm_event(
            "echo_prefetch_built",
            thread_id=thread_id,
            query_preview=q,
            body_chars=len(body),
            includes_summary=bool(any("**Summary:**" in ln for ln in lines)),
            turn_blocks=len(lines),
        )
        return body
