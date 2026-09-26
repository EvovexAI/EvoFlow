"""Inject Knowledge Vault context before each model call (auto-injection mode).

This middleware intercepts the lead agent's message list and prepends a
``HumanMessage(name="evf_kb_injection")`` with KB search results whenever:

1. The agent's ``kb_injection.mode`` is ``"auto"`` or ``"both"``.
2. At least one vault is bound to the agent (``knowledge_vault_ids``).
3. The user's message is non-empty.

The injection is parallel to the model call (fire-and-forget with timeout)
and never blocks the agent on KB failures.

Architecture::

    User message
        │
        ▼
    KbInjectionMiddleware.wrap_model_call (sync / async)
        ├─→ [parallel] kb_service.search(vault_id, query, top_k, mode)
        ├─→ Assemble context string from top_k results
        ├─→ Truncate at max_inject_tokens chars
        └─→ Append HumanMessage(name="evf_kb_injection", content=context)
        │
        ▼
    SkillsInjectionMiddleware.wrap_model_call (next in chain)
        └─→ LLM call with KB context already in messages

Contrast with the ``knowledge`` tool (agent-tool call path):

- ``mode=agent``: Agent decides when to call ``knowledge(action=search)``.
- ``mode=auto``: System pre-injects results; Agent *also* has the tool (mode=both).
- ``mode=both``: Pre-injection + tool still available for follow-up queries.

The middleware runs AFTER ``SkillsInjectionMiddleware`` in the LangChain chain
(LangChain applies middlewares in list order; our insert point is right after it).
Both ``wrap_model_call`` (sync) and ``awrap_model_call`` (async) are implemented.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import HumanMessage

from evoflow.config.agents_config import (
    KbInjectionConfig,
    get_agent_kb_injection_config,
    get_agent_kb_vault_ids,
)
from evoflow.agents.lead_agent.runtime_context import merge_model_request_runtime_context
from evoflow.agents.middlewares.dynamic_system_prompt_middleware import (
    get_injected_sections,
    reset_injected_sections,
    set_injected_sections,
)
from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

logger = logging.getLogger(__name__)

import time  # noqa: E402  (used for perf timing in summary logs)

_KB_INJECTION_MESSAGE_NAME = "evf_kb_injection"
# Approximate chars-to-tokens ratio for mixed Chinese/English text
_CHARS_PER_TOKEN = 1.5


def _is_kb_injection_message(msg: Any) -> bool:
    return isinstance(msg, HumanMessage) and getattr(msg, "name", None) == _KB_INJECTION_MESSAGE_NAME


def _strip_kb_injection_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_kb_injection_message(m)]


def _latest_human_preview(messages: list[Any]) -> str:
    """Extract the last user message text for use as the search query."""
    for msg in reversed(messages or []):
        t = str(getattr(msg, "type", None) or "").strip().lower()
        if t not in {"human", "user"}:
            continue
        content = getattr(msg, "content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
            return "\n".join(parts).strip()
    return ""


def _emit_kb_activity(thread_id: str, kind: str, detail: str) -> None:
    """Best-effort agent_activity stream tick for the user-facing live trace.

    The KbInjectionMiddleware can be silent in three failure modes (mode=off, no
    bound vaults, search error) — without an explicit activity tick the user
    has no way of telling whether KB was consulted on this turn. We always
    emit at least one tick per middleware invocation so the live SSE carries
    "正在执行 kb_injection…" even when nothing was injected.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        from evoflow.observability.agent_activity_stream import emit_agent_activity

        emit_agent_activity(tid, kind=kind, detail=detail, force=True)
    except Exception:
        # Activity tick is a UX signal; never propagate.
        logger.debug("KbInjection activity emit failed thread=%s", tid, exc_info=True)


def _summarize_result(raw: dict[str, Any]) -> str:
    """Compact per-hit log line: ``title | vault=X | score=0.82``.

    Used in single-line summaries so a grep on the service log gives the user
    immediate "what was retrieved" without paging through tracebacks.
    """
    title = str(raw.get("title") or raw.get("file_name") or raw.get("path") or "?")
    if len(title) > 60:
        title = title[:59] + "…"
    vault = str(raw.get("vaultId") or raw.get("dataset_id") or "?")
    score = raw.get("score")
    score_str = f"{float(score):.3f}" if score is not None else "-"
    return f"{title!r} | vault={vault} | score={score_str}"


def _log_summary(
    *,
    agent_code: str | None,
    thread_id: str,
    query: str,
    config: KbInjectionConfig,
    vault_ids: list[str],
    decision: str,
    duration_ms: float | None = None,
    results: list[dict[str, Any]] | None = None,
    context_chars: int | None = None,
    err: BaseException | None = None,
) -> None:
    """Single-line structured summary for the service log.

    Levels:
      - INFO    on a real injection (success path — operator wants to see it)
      - WARNING on user-misconfig (mode=off / no vault / empty query)
      - WARNING on search error (with exc_info so the stack is captured)
      - DEBUG   on proactive / no-thread (high volume, expected)
    """
    q_preview = str(query or "").strip().replace("\n", " ")
    if len(q_preview) > 80:
        q_preview = q_preview[:79] + "…"
    duration = f" elapsed={duration_ms:.1f}ms" if duration_ms is not None else ""
    parts: list[str] = []
    if agent_code:
        parts.append(f"agent={agent_code}")
    if thread_id:
        parts.append(f"thread={thread_id[:8]}")
    parts.append(f"decision={decision}")
    parts.append(f"mode={config.mode}")
    parts.append(f"top_k={config.top_k}")
    parts.append(f"threshold={config.score_threshold}")
    parts.append(f"timeout={config.timeout_sec}s")
    parts.append(f"retrieval={config.retrieval}")
    parts.append(f"rerank={config.reranker}")
    if vault_ids:
        parts.append(f"vaults=[{','.join(vault_ids)}]")
    parts.append(f"query={q_preview!r}")
    if results is not None:
        parts.append(f"hits={len(results)}")
    if context_chars is not None:
        parts.append(f"injected_chars={context_chars}")
    if duration:
        parts.append(duration.strip())
    line = "KbInjection: " + " ".join(parts)

    if err is not None:
        logger.warning("%s err=%s: %s", line, err.__class__.__name__, err, exc_info=True)

    if decision == "ok":
        logger.info(line)
        for i, r in enumerate((results or [])[:3]):
            logger.info("  hit[%d] %s", i + 1, _summarize_result(r))
        if len(results or []) > 3:
            logger.info("  …and %d more", len(results) - 3)
        return

    # decision ∈ {skip_mode_off, skip_no_vault, skip_empty_query,
    #              skip_proactive_duty, no_hits, search_error}
    # ``no_hits`` is *legitimate* (vault has docs but query doesn't match) —
    # not a misconfig. Down-rank it to DEBUG so operators don't mistake
    # expected empty results for a fault.
    if decision in {"skip_mode_off", "skip_no_vault", "skip_empty_query"}:
        logger.debug(line)
    elif decision == "no_hits":
        logger.debug(line)
    elif decision == "search_error":
        logger.warning(line)
    else:
        # proactive duty skip: expected
        logger.debug(line)


def _agent_code_from_runtime(request: ModelRequest) -> str | None:
    """Resolve agent_code from LangGraph runtime context."""
    ctx = merge_model_request_runtime_context(request)
    # agent_id is set in make_lead_agent from cfg["agent_id"]
    return str(ctx.get("agent_id") or ctx.get("agent_name") or "").strip() or None


async def _do_kb_search(
    query: str,
    vault_ids: list[str],
    config: KbInjectionConfig,
) -> tuple[str, list[dict[str, Any]]]:
    """Run parallel KB searches across all bound vaults (self-hosted owned KB only).

    Each ``vault_id`` is resolved against ``kb_bases``:
      - ``kb_bases.id`` direct match → ``owned_service.search``.
      - ``kb_bases.sync_vault_id`` match → ``owned_service.search`` (the
        built-in user guide uses this path — alias ``evoflow-user-guide``
        maps to ``kb_builtin_user_guide``).
      - No match → warning log + skip. Obsidian / Markdown vault lookups
        are intentionally NOT supported here; this middleware only
        consults the in-house self-hosted knowledge base.

    Returns ``(context_string, results_sorted_by_score)``. ``results`` is the
    raw list of search-result dicts (one per matched chunk), pre-sorted by score
    descending and pre-truncated to ``top_k`` so it can drive both the
    injected-text formatter and the live UI citation list.
    """
    if not query or not vault_ids:
        return "", []
    if config.mode in ("off",):
        return "", []

    import asyncio

    from evoflow.knowledge.owned.db import db as _own_db
    from evoflow.knowledge.owned.service import (
        get_base as owned_get_base,
        search as owned_search,
    )

    mode = config.retrieval if config.mode in ("auto", "both") else "hybrid"

    def _resolve_kb_id(vault_id: str) -> str | None:
        """Return the owned KB id matching ``vault_id``, or ``None`` if unbound.

        A vault_id is bound if ``kb_bases.id`` matches directly OR
        ``kb_bases.sync_vault_id`` matches — the built-in user guide uses the
        second path (its stable id is ``kb_builtin_user_guide`` but it is exposed
        to the role-binding UI under ``evoflow-user-guide``).
        """
        try:
            base = owned_get_base(vault_id)
            if base is not None:
                return str(base["id"])
        except Exception:
            pass
        try:
            with _own_db() as conn:
                row = conn.execute(
                    "SELECT id FROM kb_bases WHERE sync_vault_id=? AND deleted_at IS NULL LIMIT 1",
                    (vault_id,),
                ).fetchone()
                if row and row["id"]:
                    return str(row["id"])
        except Exception:
            pass
        return None

    # Pre-resolve every vault_id once so an unbound id logs a single clear
    # warning rather than a per-iteration stack trace.
    resolved: list[tuple[str, str]] = []
    for vid in vault_ids:
        kb_id = _resolve_kb_id(vid)
        if kb_id is None:
            logger.warning(
                "KbInjection vault=%r is not bound to any owned KB "
                "(no kb_bases.id or sync_vault_id match). Skipping.",
                vid,
            )
            continue
        resolved.append((vid, kb_id))

    if not resolved:
        return "", []

    async def search_owned(source_vault_id: str, kb_id: str) -> list[dict[str, Any]]:
        t0 = time.perf_counter()
        try:
            result = await asyncio.wait_for(
                owned_search(kb_id, query, mode=mode, top_k=config.top_k),
                timeout=config.timeout_sec,
            )
            dt_ms = (time.perf_counter() - t0) * 1000
            items = result.get("items") or []
            # Normalize into the {title, snippet, content, score, vaultId} shape
            # the formatter expects.
            out: list[dict[str, Any]] = []
            for it in items:
                raw_score = (
                    it.get("rrfScore")
                    or it.get("vectorScore")
                    or it.get("fulltextScore")
                    or it.get("score")
                    or 0
                )
                try:
                    score = float(raw_score)
                except (TypeError, ValueError):
                    score = 0.0
                out.append(
                    {
                        "title": it.get("title") or it.get("path"),
                        "snippet": (it.get("content") or it.get("snippet") or "")[:512],
                        "content": it.get("content"),
                        "path": it.get("path") or it.get("fileName"),
                        "score": score,
                        "vaultId": source_vault_id,
                        "kbId": it.get("kbId") or kb_id,
                        "kbName": it.get("kbName"),
                        "provider": "owned",
                    }
                )
            logger.debug(
                "KbInjection vault=%s owned kb=%s mode=%s hits=%d elapsed=%.1fms query=%r",
                source_vault_id,
                kb_id,
                mode,
                len(out),
                dt_ms,
                query[:80],
            )
            return out
        except asyncio.TimeoutError:
            dt_ms = (time.perf_counter() - t0) * 1000
            logger.warning(
                "KbInjection vault=%s owned timed out after %.1fms (timeout=%ss) query=%r",
                source_vault_id,
                dt_ms,
                config.timeout_sec,
                query[:80],
            )
            return []
        except Exception as exc:
            dt_ms = (time.perf_counter() - t0) * 1000
            logger.warning(
                "KbInjection vault=%s owned failed after %.1fms err=%s: %s query=%r",
                source_vault_id,
                dt_ms,
                exc.__class__.__name__,
                exc,
                query[:80],
            )
            return []

    # Parallel search across all resolved owned KBs.
    all_results: list[dict[str, Any]] = []
    for res_list in await asyncio.gather(*[search_owned(vid, kid) for vid, kid in resolved]):
        all_results.extend(res_list)

    if not all_results:
        return "", []

    # Sort by score descending
    all_results.sort(key=lambda r: float(r.get("score") or 0), reverse=True)

    # Assemble context string from the top_k results
    buf: list[str] = []
    used_chars = 0
    max_chars = int(config.max_inject_tokens * _CHARS_PER_TOKEN)
    kept: list[dict[str, Any]] = []

    for r in all_results:
        title = str(r.get("title") or r.get("file_name") or r.get("path") or "")
        snippet = str(r.get("snippet") or r.get("content") or "").strip()[:512]
        score = round(float(r.get("score") or 0), 3)
        source = str(r.get("vaultId") or r.get("dataset_id") or "")

        # Format: [Source | Score 0.823] Title
        header = f"[{source}" + (f" | 相关度 {score}" if score else "") + "]"
        if title:
            header += f" — {title}"
        entry = f"{header}\n{snippet}"

        if used_chars + len(entry) > max_chars:
            break
        buf.append(entry)
        kept.append(r)
        used_chars += len(entry)

    if not buf:
        return "", []

    logger.info(
        "KbInjection: assembled context vaults=%d results=%d chars=%d query=%r",
        len(vault_ids), len(buf), sum(len(s) for s in buf), query[:80],
    )

    context = (
        "<knowledge_context>\n"
        + "\n\n---\n\n".join(buf)
        + "\n\n以上是你可参考的知识库内容(已按相关度排序),请在回答中引用其中相关内容。\n"
        + "</knowledge_context>"
    )
    return context, kept


def _build_kb_injection_message(
    context: str,
    vault_ids: list[str],
    config: KbInjectionConfig,
) -> HumanMessage:
    return HumanMessage(content=context, name=_KB_INJECTION_MESSAGE_NAME)


class KbInjectionMiddleware(AgentMiddleware[AgentState]):
    """Inject KB search results before the LLM call (auto-injection mode).

    Skip conditions:
    - ``mode == "off"`` for the agent
    - No bound vault IDs
    - Empty user query
    - Unattended proactive duty loop (``triggered_by=proactive_engine`` or
      ``proactive_process=True``). User chat into ``proactive:{agent_code}``
      sessions is *not* skipped — operators open those explicitly to test KB.

    On failure (timeout / error): log + continue without KB context (never block the agent).
    """

    state_schema = AgentState

    def _should_inject(self, request: ModelRequest) -> tuple[bool, str, KbInjectionConfig, list[str], str]:
        """Return ``(should_inject, query, config, vault_ids, thread_id)``.

        ``thread_id`` is the live run's thread id — used to push citations to the
        SSE channel via ``kb_citations_publisher``. Empty when there's no live
        stream (e.g. background worker); the publisher handles that gracefully.

        Side effect: emits a single structured service-log line per call so the
        operator can grep ``KbInjection:`` to see why a turn did or did not
        inject context.
        """
        try:
            agent_code = _agent_code_from_runtime(request)
            config = get_agent_kb_injection_config(agent_code)
            ctx = merge_model_request_runtime_context(request)
            thread_id = str(ctx.get("thread_id") or "").strip()
            session_key = str(ctx.get("session_key") or "").strip()

            if config.mode == "off":
                _log_summary(
                    agent_code=agent_code,
                    thread_id=thread_id,
                    query="",
                    config=config,
                    vault_ids=[],
                    decision="skip_mode_off",
                )
                return False, "", config, [], thread_id

            messages = messages_from_model_request(request)
            query = _latest_human_preview(messages)
            if not query:
                _log_summary(
                    agent_code=agent_code,
                    thread_id=thread_id,
                    query="",
                    config=config,
                    vault_ids=[],
                    decision="skip_empty_query",
                )
                return False, "", config, [], thread_id

            # Skip unattended duty / engine loops only — user-driven chat into
            # ``proactive:{agent_code}`` still gets KB so the operator can see
            # what the employee would otherwise consult on its own patrol.
            try:
                from evoflow.agents.middlewares.proactive_tool_middleware import (
                    is_proactive_duty_run,
                )

                if is_proactive_duty_run(request):
                    _log_summary(
                        agent_code=agent_code,
                        thread_id=thread_id,
                        query=query,
                        config=config,
                        vault_ids=[],
                        decision="skip_proactive_duty",
                    )
                    return False, "", config, [], thread_id
            except Exception:
                # Detection helper failure must not block KB; fall through.
                pass

            vault_ids = get_agent_kb_vault_ids(agent_code)
            if not vault_ids:
                # Agent has no KB configured — silently fall through. Don't
                # log here: a missing vault list is the default for agents
                # that haven't opted into KB injection, not an operational
                # signal. The ``awrap_model_call`` wrapper still short-circuits
                # before any search work runs.
                return False, "", config, [], thread_id

            return True, query, config, vault_ids, thread_id
        except Exception as exc:
            logger.warning("KbInjection: skip due to unexpected error: %s", exc, exc_info=True)
            return False, "", KbInjectionConfig(), [], ""

    def _patch_request(
        self,
        request: ModelRequest,
        context: str,
    ) -> ModelRequest:
        messages = _strip_kb_injection_messages(messages_from_model_request(request))
        if context:
            messages = [*messages, _build_kb_injection_message(context, [], KbInjectionConfig())]
        return request.override(messages=messages)

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        """Sync path — delegates to ``awrap_model_call`` via the running event loop.

        ``asyncio.run()`` is NOT used here because it creates a nested event loop,
        which deadlocks when ``_do_kb_search`` calls ``ensure_owned_kb_worker_started()``
        (which is async and needs the outer loop to make forward progress).

        Instead, ``asyncio.get_event_loop().run_until_complete()`` re-enters the
        existing loop that LangGraph / uvicorn is already running.
        """
        should, query, config, vault_ids, thread_id = self._should_inject(request)
        if not should or not query:
            return handler(request)

        context = ""
        results: list[dict[str, Any]] = []
        search_err: BaseException | None = None
        t0 = time.perf_counter()

        try:
            try:
                # Preferred: get the running loop (never raises RuntimeError for main-thread loops)
                loop = asyncio.get_running_loop()
                loop_is_running = True
            except RuntimeError:
                # No running loop on this thread (e.g. stand-alone invocation).
                loop = asyncio.get_event_loop()
                loop_is_running = False
            if loop_is_running:
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                    def _call() -> tuple[str, list[dict[str, Any]]]:
                        async def _inner() -> tuple[str, list[dict[str, Any]]]:
                            return await _do_kb_search(query, vault_ids, config)
                        # re-enter the running loop from the worker thread
                        return loop.run_until_complete(_inner())
                    future = ex.submit(_call)
                    context, results = future.result(timeout=config.timeout_sec + 1)
            else:
                context, results = loop.run_until_complete(
                    _do_kb_search(query, vault_ids, config)
                )
        except asyncio.TimeoutError:
            search_err = TimeoutError(f"kb search wall-clock exceeded {config.timeout_sec}s")
            context, results = "", []
        except concurrent.futures.TimeoutError:
            search_err = TimeoutError(f"sync kb search wall-clock exceeded {config.timeout_sec + 1}s")
            context, results = "", []
        except Exception as exc:
            search_err = exc
            context, results = "", []

        elapsed_ms = (time.perf_counter() - t0) * 1000
        agent_code = _agent_code_from_runtime(request)

        if search_err is not None:
            _log_summary(
                agent_code=agent_code,
                thread_id=thread_id,
                query=query,
                config=config,
                vault_ids=vault_ids,
                decision="search_error",
                duration_ms=elapsed_ms,
                err=search_err,
            )
        elif context and results:
            _log_summary(
                agent_code=agent_code,
                thread_id=thread_id,
                query=query,
                config=config,
                vault_ids=vault_ids,
                decision="ok",
                duration_ms=elapsed_ms,
                results=results,
                context_chars=len(context),
            )
        else:
            _log_summary(
                agent_code=agent_code,
                thread_id=thread_id,
                query=query,
                config=config,
                vault_ids=vault_ids,
                decision="no_hits",
                duration_ms=elapsed_ms,
            )

        # Activity trace
        if thread_id:
            from evoflow.observability.agent_activity_stream import emit_agent_activity
            if context and results:
                emit_agent_activity(
                    thread_id,
                    kind="middleware",
                    detail=f"kb_injection 检索到 {len(results)} 条 ({len(context)} chars)",
                    force=True,
                )
            else:
                emit_agent_activity(
                    thread_id,
                    kind="middleware",
                    detail="kb_injection 未命中（检索失败或 0 结果）",
                    force=True,
                )

        # Citations
        if thread_id:
            try:
                from evoflow.runtime.ports import publish_kb_citations as _port_publish_kb_citations
                _port_publish_kb_citations(
                    thread_id=thread_id,
                    query=query,
                    agent_code=agent_code,
                    results=results,
                )
            except Exception as exc:
                logger.debug("KbInjection: failed to publish citations thread=%s err=%s", thread_id, exc)

        req2 = self._patch_request(request, context) if context else request
        result = handler(req2)

        if context:
            try:
                prev = get_injected_sections()
                merged = dict(prev) if prev else {}
                merged["kb_injection"] = context
                tok = set_injected_sections(merged)
                try:
                    _ = result
                finally:
                    reset_injected_sections(tok)
            except Exception:
                pass

        return result

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        should, query, config, vault_ids, thread_id = self._should_inject(request)
        if not should or not query:
            return await handler(request)

        context = ""
        results: list[dict[str, Any]] = []
        search_err: BaseException | None = None
        t0 = time.perf_counter()

        try:
            context, results = await _do_kb_search(query, vault_ids, config)
        except asyncio.TimeoutError:
            search_err = TimeoutError(f"kb search wall-clock exceeded {config.timeout_sec}s")
            context, results = "", []
        except Exception as exc:
            search_err = exc
            context, results = "", []

        elapsed_ms = (time.perf_counter() - t0) * 1000
        agent_code = _agent_code_from_runtime(request)

        if search_err is not None:
            _log_summary(
                agent_code=agent_code,
                thread_id=thread_id,
                query=query,
                config=config,
                vault_ids=vault_ids,
                decision="search_error",
                duration_ms=elapsed_ms,
                err=search_err,
            )
        elif context and results:
            _log_summary(
                agent_code=agent_code,
                thread_id=thread_id,
                query=query,
                config=config,
                vault_ids=vault_ids,
                decision="ok",
                duration_ms=elapsed_ms,
                results=results,
                context_chars=len(context),
            )
        else:
            _log_summary(
                agent_code=agent_code,
                thread_id=thread_id,
                query=query,
                config=config,
                vault_ids=vault_ids,
                decision="no_hits",
                duration_ms=elapsed_ms,
            )

        # Always emit activity so the UI gets a KB status update on every turn.
        if thread_id:
            from evoflow.observability.agent_activity_stream import emit_agent_activity

            if context and results:
                emit_agent_activity(
                    thread_id,
                    kind="middleware",
                    detail=f"kb_injection 检索到 {len(results)} 条 ({len(context)} chars)",
                    force=True,
                )
            else:
                emit_agent_activity(
                    thread_id,
                    kind="middleware",
                    detail="kb_injection 未命中（检索失败或 0 结果）",
                    force=True,
                )

        # Publish citations to live SSE channel (both hits and errors; UI shows citation on ok).
        if thread_id:
            try:
                from evoflow.runtime.ports import publish_kb_citations as _port_publish_kb_citations

                _port_publish_kb_citations(
                    thread_id=thread_id,
                    query=query,
                    agent_code=agent_code,
                    results=results,
                )
            except Exception as exc:
                logger.debug("KbInjection: failed to publish citations thread=%s err=%s", thread_id, exc)

        # Patch request and call the next handler in the chain.
        # ``context`` is only non-empty when search succeeded with hits.
        req2 = self._patch_request(request, context) if context else request
        result = await handler(req2)

        # Update injected_sections ContextVar so downstream code can read the KB context.
        if context:
            try:
                prev = get_injected_sections()
                merged = dict(prev) if prev else {}
                merged["kb_injection"] = context
                tok = set_injected_sections(merged)
                try:
                    _ = result
                finally:
                    reset_injected_sections(tok)
            except Exception:
                pass

        return result
