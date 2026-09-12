"""Middleware for automatic thread title generation."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from contextlib import contextmanager

try:
    from typing import NotRequired, override
except ImportError:
    from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from evoflow.agents.automation_runtime import is_unattended_automation
from evoflow.agents.middlewares.message_usage_helpers import infer_usage_metadata_for_ai_message
from evoflow.config.title_config import get_title_config
from evoflow.models import create_chat_model

logger = logging.getLogger(__name__)

# One background title task per thread (avoid duplicate LLM calls on retries).
_TITLE_BG_TASKS: dict[str, asyncio.Task[None]] = {}


@contextmanager
def _suppress_stream_callbacks_for_nested_llm():
    """Nested ``model.invoke`` inside agent middleware inherits parent streaming config and leaks tokens (LC #34382).

    Clear callbacks on a child RunnableConfig so title generation does not appear as extra assistant output.
    """
    try:
        from langchain_core.runnables.config import ensure_config, var_child_runnable_config
    except ImportError:
        yield
        return

    raw = ensure_config()
    try:
        cfg = dict(raw) if raw is not None else {}
    except Exception:
        cfg = {}
    cfg["callbacks"] = []
    token = var_child_runnable_config.set(cfg)
    try:
        yield
    finally:
        var_child_runnable_config.reset(token)


class TitleMiddlewareState(AgentState):
    """Compatible with the `ThreadState` schema."""

    title: NotRequired[str | None]


class TitleMiddleware(AgentMiddleware[TitleMiddlewareState]):
    """Automatically generate a title for the thread after the first user message."""

    state_schema = TitleMiddlewareState

    def _normalize_content(self, content: object) -> str:
        if isinstance(content, str):
            return content

        if isinstance(content, list):
            parts = [self._normalize_content(item) for item in content]
            return "\n".join(part for part in parts if part)

        if isinstance(content, dict):
            text_value = content.get("text")
            if isinstance(text_value, str):
                return text_value

            nested_content = content.get("content")
            if nested_content is not None:
                return self._normalize_content(nested_content)

        return ""

    # ── DB-backed title check ──────────────────────────────────────────────
    # Previously relied on an in-memory ``_TITLE_SCHEDULED_FOR_THREAD`` set that
    # was never cleared on failure — a single transient error (session not yet
    # bound, LLM timeout) permanently blocked title generation for the thread.
    # We now query the DB directly: if a non-placeholder title already exists,
    # skip; otherwise allow (re)generation on every turn.

    def _thread_has_real_title(self, thread_id: str) -> bool:
        """Return True if the session bound to *thread_id* already has a non-placeholder title."""
        if not thread_id:
            return False
        try:
            from evoflow.persistence import session_repositories as sess_repo

            sk = sess_repo.find_session_key_by_thread_id(thread_id)
            if not sk:
                return False
            row = sess_repo.load_session_map().get(sk) or {}
            title = str(row.get("title") or "").strip()
            if not title:
                return False
            return not sess_repo.is_replaceable_session_title(title)
        except Exception:
            return False

    def _should_generate_title(self, state: TitleMiddlewareState, thread_id: str | None) -> bool:
        """Check if we should generate a title for this thread.

        Conditions:
        - Title generation enabled in config.
        - At least one human + one AI message in state.
        - DB does not already have a real (non-placeholder) title for this thread.
        """
        config = get_title_config()
        if not config.enabled:
            return False

        messages = state.get("messages", [])
        if len(messages) < 2:
            return False

        user_messages = [m for m in messages if m.type == "human"]
        assistant_messages = [m for m in messages if m.type == "ai"]

        if len(user_messages) < 1 or len(assistant_messages) < 1:
            return False

        # DB is the source of truth — if a real title already exists, skip.
        if thread_id and self._thread_has_real_title(thread_id):
            return False

        return True

    def _build_title_prompt(self, state: TitleMiddlewareState) -> tuple[str, str]:
        config = get_title_config()
        messages = state.get("messages", [])

        user_msg_content = next((m.content for m in messages if m.type == "human"), "")
        assistant_msg_content = next((m.content for m in messages if m.type == "ai"), "")

        user_msg = self._normalize_content(user_msg_content)
        assistant_msg = self._normalize_content(assistant_msg_content)

        prompt = config.prompt_template.format(
            max_words=config.max_words,
            user_msg=user_msg[:500],
            assistant_msg=assistant_msg[:500],
        )
        return prompt, user_msg

    def _parse_title(self, content: object) -> str:
        config = get_title_config()
        title_content = self._normalize_content(content)
        title = title_content.strip().strip('"').strip("'")
        return title[: config.max_chars] if len(title) > config.max_chars else title

    def _fallback_title(self, user_msg: str) -> str:
        from evoflow.persistence.session_repositories import provisional_session_title_from_user_text

        config = get_title_config()
        prov = provisional_session_title_from_user_text(user_msg, max_chars=config.max_chars)
        return prov or "New Conversation"

    def _resolve_thread_id(self, runtime: Runtime) -> str | None:
        tid = runtime.context.get("thread_id") if runtime and runtime.context else None
        if tid:
            return str(tid).strip() or None
        try:
            from langgraph.config import get_config

            cfg = get_config()
            c = cfg.get("configurable") if isinstance(cfg, dict) else {}
            if isinstance(c, dict):
                raw = c.get("thread_id")
                if isinstance(raw, str) and raw.strip():
                    return raw.strip()
        except Exception:
            pass
        return None

    def _persist_title_to_session_index(self, thread_id: str, title: str) -> bool:
        """Persist *title* to the session row. Returns True on success.

        Retries up to 3 times with 1 s delay to handle the race where the
        session↔thread binding has not yet been committed to DB.
        """
        if not thread_id or not title:
            return False
        from evoflow.persistence import session_repositories as sess_repo

        last_err: Exception | None = None
        for attempt in range(3):
            try:
                sk = sess_repo.find_session_key_by_thread_id(thread_id)
                if sk:
                    row = sess_repo.load_session_map().get(sk) or {}
                    ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
                    if str(ctx.get("source") or "").strip() == "automation":
                        return True  # automation session — skip but treat as "done"
                    sess_repo.upsert_session_row(sk, title=title)
                    return True
            except Exception as exc:
                last_err = exc
            # Session not yet bound or transient error — wait and retry.
            time.sleep(1.0)

        if last_err:
            logger.warning(
                "title persist failed after 3 attempts thread=%s err=%s",
                thread_id[:8],
                last_err,
            )
        else:
            logger.warning(
                "title persist skipped — session not found for thread=%s after 3 attempts",
                thread_id[:8],
            )
        return False

    def _persist_title_token_usage(self, thread_id: str, usage: dict[str, int]) -> None:
        """Accumulate title-generation token usage onto the session rollup."""
        if not thread_id or not usage:
            return
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id
            from evoflow.persistence.session_run_state import add_session_token_usage

            sk = find_session_key_by_thread_id(thread_id)
            if not sk:
                return
            add_session_token_usage(
                sk,
                input_tokens=usage.get("input_tokens", 0),
                output_tokens=usage.get("output_tokens", 0),
                total_tokens=usage.get("total_tokens"),
                cache_read_tokens=usage.get("cache_read_tokens", 0),
                cache_creation_tokens=usage.get("cache_creation_tokens", 0),
                cache_miss_tokens=usage.get("cache_miss_tokens", 0),
            )
        except Exception:
            logger.debug("title token usage persist failed thread=%s", thread_id, exc_info=True)

    def _broadcast_title_updated(self, thread_id: str, session_key: str | None, title: str) -> None:
        """Best-effort SSE broadcast so the frontend can refresh the sidebar immediately."""
        try:
            from app.gateway.routers.events import broadcaster

            data: dict[str, object] = {"title": title}
            if session_key:
                data["session_key"] = session_key
            # broadcaster.broadcast is async — fire-and-forget via a background thread.
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(broadcaster.broadcast(thread_id, "panel:title_updated", data))
            except RuntimeError:
                # No running loop (we're in a background thread) — create one.
                asyncio.run(broadcaster.broadcast(thread_id, "panel:title_updated", data))
        except Exception:
            logger.debug("title broadcast failed thread=%s", thread_id, exc_info=True)

    async def _generate_title_llm(
        self, prompt: str, user_msg: str, *, model_name: str | None = None
    ) -> tuple[str, dict[str, int] | None]:
        """Generate a title via LLM. Returns (title, usage_metadata or None)."""
        config = get_title_config()
        resolved = config.model_name or model_name
        try:
            model = create_chat_model(name=resolved, thinking_enabled=False, invocation_kind="title")
            with _suppress_stream_callbacks_for_nested_llm():
                response = await model.ainvoke(prompt)
            # Extract token usage before discarding the response object.
            usage = infer_usage_metadata_for_ai_message(response)
            title = self._parse_title(response.content)
            if title:
                return title, usage
        except Exception:
            logger.exception("Failed to generate title (background)")
        return self._fallback_title(user_msg), None

    async def _background_title_job(self, thread_id: str, prompt: str, user_msg: str, *, model_name: str | None = None) -> None:
        try:
            title, usage = await self._generate_title_llm(prompt, user_msg, model_name=model_name)
            persisted = await asyncio.to_thread(self._persist_title_to_session_index, thread_id, title)
            if persisted:
                # Persist token usage from title generation to the session rollup.
                if usage:
                    await asyncio.to_thread(self._persist_title_token_usage, thread_id, usage)
                # Broadcast so frontend can refresh sidebar without polling.
                try:
                    from evoflow.persistence import session_repositories as sess_repo
                    sk = sess_repo.find_session_key_by_thread_id(thread_id)
                except Exception:
                    sk = None
                await asyncio.to_thread(self._broadcast_title_updated, thread_id, sk, title)
                logger.info("title generated thread=%s len=%d", thread_id[:8], len(title or ""))
            else:
                logger.warning("title generated but persist failed thread=%s — will retry next turn", thread_id[:8])
        finally:
            _TITLE_BG_TASKS.pop(thread_id, None)

    def _schedule_background_title(self, thread_id: str, prompt: str, user_msg: str, *, model_name: str | None = None) -> None:
        prev = _TITLE_BG_TASKS.get(thread_id)
        if prev is not None and not prev.done():
            try:
                prev.cancel()
            except Exception:
                pass

        def _thread_runner() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(self._background_title_job(thread_id, prompt, user_msg, model_name=model_name))
            finally:
                try:
                    loop.run_until_complete(loop.shutdown_asyncgens())
                except Exception:
                    pass
                try:
                    loop.run_until_complete(loop.shutdown_default_executor())
                except Exception:
                    pass
                try:
                    loop.close()
                except Exception:
                    pass
                asyncio.set_event_loop(None)

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            t = threading.Thread(
                target=_thread_runner,
                name=f"evoflow-title-{thread_id[:8]}",
                daemon=True,
            )
            t.start()
            return

        task = loop.create_task(
            self._background_title_job(thread_id, prompt, user_msg, model_name=model_name),
            name=f"evoflow-title-{thread_id[:8]}",
        )
        _TITLE_BG_TASKS[thread_id] = task

    def _resolve_model_name(self, runtime: Runtime) -> str | None:
        """Extract session model_name from runtime context (follows user-selected model).

        Works for both dict context and LeadAgentRuntimeContext dataclass (both have .get()).
        Falls back to langgraph get_config() if runtime context is empty.
        """
        ctx = getattr(runtime, "context", None)
        if ctx is not None:
            try:
                name = ctx.get("model_name") if hasattr(ctx, "get") else None
                if name:
                    return str(name).strip() or None
            except Exception:
                pass
        try:
            from langgraph.config import get_config

            cfg = get_config()
            c = cfg.get("configurable") if isinstance(cfg, dict) else {}
            if isinstance(c, dict):
                name = c.get("model_name")
                if name:
                    return str(name).strip() or None
        except Exception:
            pass
        # DB fallback: thread_id → session → model_name
        try:
            _tid = ctx.get("thread_id") if ctx is not None and hasattr(ctx, "get") else None
            if not _tid:
                try:
                    from langgraph.config import get_config as _gc
                    _tid = _gc().get("configurable", {}).get("thread_id")
                except Exception:
                    pass
            if _tid:
                from evoflow.persistence.session_repositories import get_model_name_for_thread
                _name = get_model_name_for_thread(str(_tid).strip())
                if _name:
                    return str(_name).strip() or None
        except Exception:
            pass
        return None

    def _after_model_fast_path(self, state: TitleMiddlewareState, runtime: Runtime) -> dict | None:
        """Schedule LLM title in background; do not bind user-message fallback into graph state."""
        if is_unattended_automation(runtime):
            return None
        tid = self._resolve_thread_id(runtime)
        if not tid:
            return None
        if not self._should_generate_title(state, tid):
            return None
        # Skip if a background title task is already running for this thread.
        prev = _TITLE_BG_TASKS.get(tid)
        if prev is not None and not prev.done():
            return None
        prompt, user_msg = self._build_title_prompt(state)
        # Resolve session model_name from runtime context (follows user-selected model)
        session_model = self._resolve_model_name(runtime)
        self._schedule_background_title(tid, prompt, user_msg, model_name=session_model)
        return None

    @override
    def after_model(self, state: TitleMiddlewareState, runtime: Runtime) -> dict | None:
        return self._after_model_fast_path(state, runtime)

    @override
    async def aafter_model(self, state: TitleMiddlewareState, runtime: Runtime) -> dict | None:
        return self._after_model_fast_path(state, runtime)
