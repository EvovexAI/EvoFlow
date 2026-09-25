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
    set_injected_sections,
)
from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

logger = logging.getLogger(__name__)

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


def _agent_code_from_runtime(request: ModelRequest) -> str | None:
    """Resolve agent_code from LangGraph runtime context."""
    ctx = merge_model_request_runtime_context(request)
    # agent_id is set in make_lead_agent from cfg["agent_id"]
    return str(ctx.get("agent_id") or ctx.get("agent_name") or "").strip() or None


async def _do_kb_search(
    query: str,
    vault_ids: list[str],
    config: KbInjectionConfig,
) -> str:
    """Run parallel KB searches across all bound vaults and return assembled context."""
    if not query or not vault_ids:
        return ""
    if config.mode in ("off",):
        return ""

    import asyncio

    from evoflow.knowledge.vault.provider import get_knowledge_provider

    provider = get_knowledge_provider()
    mode = config.retrieval if config.mode in ("auto", "both") else "hybrid"
    rerank = config.reranker != "none"

    async def search_one(vault_id: str) -> list[dict[str, Any]]:
        try:
            results = await asyncio.wait_for(
                provider.search(
                    vault_id,
                    query,
                    mode=mode,
                    top_k=config.top_k,
                    threshold=config.score_threshold if config.score_threshold > 0 else None,
                    rerank=rerank,
                ),
                timeout=config.timeout_sec,
            )
            return [r.model_dump(by_alias=True, mode="json") for r in results]
        except asyncio.TimeoutError:
            logger.warning("KB search timed out vault=%s query=%r", vault_id, query[:80])
            return []
        except Exception as exc:
            logger.warning("KB search failed vault=%s query=%r: %s", vault_id, query[:80], exc)
            return []

    # Parallel search across all vaults
    all_results: list[dict[str, Any]] = []
    for res_list in await asyncio.gather(*[search_one(vid) for vid in vault_ids]):
        all_results.extend(res_list)

    if not all_results:
        return ""

    # Sort by score descending
    all_results.sort(key=lambda r: float(r.get("score") or 0), reverse=True)

    # Assemble context string
    buf: list[str] = []
    used_chars = 0
    max_chars = int(config.max_inject_tokens * _CHARS_PER_TOKEN)

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
        used_chars += len(entry)

    if not buf:
        return ""

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
    return context


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
    - Proactive / system-initiated runs (session_key starts with "proactive:")

    On failure (timeout / error): log + continue without KB context (never block the agent).
    """

    state_schema = AgentState

    def _should_inject(self, request: ModelRequest) -> tuple[bool, str, KbInjectionConfig, list[str]]:
        """Return (should_inject, query, config, vault_ids). Log and return False on any error."""
        try:
            agent_code = _agent_code_from_runtime(request)
            config = get_agent_kb_injection_config(agent_code)

            if config.mode == "off":
                return False, "", config, []

            messages = messages_from_model_request(request)
            query = _latest_human_preview(messages)
            if not query:
                return False, "", config, []

            # Skip proactive runs
            ctx = merge_model_request_runtime_context(request)
            session_key = str(ctx.get("session_key") or "")
            if session_key.startswith("proactive:"):
                return False, "", config, []

            vault_ids = get_agent_kb_vault_ids(agent_code)
            if not vault_ids:
                return False, "", config, []

            return True, query, config, vault_ids
        except Exception as exc:
            logger.debug("KbInjection: skip due to error: %s", exc)
            return False, "", KbInjectionConfig(), []

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
        should, query, config, vault_ids = self._should_inject(request)
        if not should or not query:
            return handler(request)

        import asyncio
        import concurrent.futures

        context = ""

        def _sync_search() -> str:
            return asyncio.run(_do_kb_search(query, vault_ids, config))

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                future = ex.submit(_sync_search)
                context = future.result(timeout=config.timeout_sec + 1)
        except Exception as exc:
            logger.warning("KbInjection: sync KB search failed: %s", exc)
            context = ""

        patched = self._patch_request(request, context)
        result = handler(patched)

        # Update injected_sections ContextVar for UI detail display
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
        should, query, config, vault_ids = self._should_inject(request)
        if not should or not query:
            return await handler(request)

        context = ""
        try:
            context = await _do_kb_search(query, vault_ids, config)
        except Exception as exc:
            logger.warning("KbInjection: async KB search failed: %s", exc)
            context = ""

        patched = self._patch_request(request, context)
        result = await handler(patched)

        # Update injected_sections ContextVar for UI detail display
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


def reset_injected_sections(tok):
    """Forward the reset call from dynamic_system_prompt_middleware."""
    from evoflow.agents.middlewares.dynamic_system_prompt_middleware import reset_injected_sections as _reset

    _reset(tok)
