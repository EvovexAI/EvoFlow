"""Memory updater for reading, writing, and updating memory data."""

import json
import logging
import re
from typing import Any

from evoflow.agents.memory.conversation_filter import extract_last_user_assistant_texts
from evoflow.agents.memory.prompt import (
    MEMORY_UPDATE_PROMPT,
    format_conversation_for_update,
)
from evoflow.agents.memory.storage import create_empty_memory, get_memory_storage
from evoflow.collab.id_format import make_fact_id
from evoflow.config.memory_config import get_memory_config
from evoflow.models import create_chat_model
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def _create_empty_memory() -> dict[str, Any]:
    """Backward-compatible wrapper around the storage-layer empty-memory factory."""
    return create_empty_memory()


def _save_memory_to_file(memory_data: dict[str, Any], agent_name: str | None = None) -> bool:
    """Backward-compatible wrapper around the configured memory storage save path."""
    return get_memory_storage().save(memory_data, agent_name)


def get_memory_data(agent_name: str | None = None) -> dict[str, Any]:
    """Get the current memory data via storage provider."""
    return get_memory_storage().load(agent_name)


def list_memory_agent_slots() -> list[dict[str, Any]]:
    """List memory scopes for UI: global + each SQLite agent (+ orphan memory keys).

    ``has_memory_file`` means the agent has non-empty chat memory in
    ``evoflow_memory`` (facts or section summaries), not a legacy disk JSON.
    """
    from evoflow.config.agents_config import AGENT_NAME_PATTERN, list_all_agents, load_agent_config
    from evoflow.persistence.memory_repositories import agent_keys_with_memory_content

    try:
        content_keys = agent_keys_with_memory_content()
    except Exception:
        logger.debug("list_memory_agent_slots: content keys failed", exc_info=True)
        content_keys = set()

    rows: list[dict[str, Any]] = [
        {
            "id": None,
            "display_name": "全局",
            "description": "未指定自定义 Agent 时的默认记忆",
            "has_memory_file": "" in content_keys,
        }
    ]

    seen: set[str] = set()
    try:
        agents = list_all_agents()
    except Exception:
        logger.debug("list_memory_agent_slots: list_all_agents failed", exc_info=True)
        agents = []

    # Ensure main appears even when missing from the agents table.
    try:
        from evoflow.persistence import config_repositories as cfg_repo

        if not any(str(a.agent_code or "").strip().lower() == "main" for a in agents):
            if cfg_repo.agent_exists("main") or "main" in content_keys:
                try:
                    agents = [load_agent_config("main"), *agents]
                except Exception:
                    pass
    except Exception:
        pass

    for cfg in agents:
        name = str(getattr(cfg, "agent_code", "") or "").strip()
        if not name or not AGENT_NAME_PATTERN.match(name):
            continue
        key = name  # memory agent_key is case-sensitive as stored; codes are lowercased on save
        low = name.lower()
        if low in seen:
            continue
        seen.add(low)
        disp = (getattr(cfg, "agent_name", None) or "").strip() or name
        desc = (getattr(cfg, "description", None) or "")[:240]
        rows.append(
            {
                "id": name,
                "display_name": disp,
                "description": desc,
                "has_memory_file": name in content_keys or low in content_keys,
            }
        )

    # Orphan agent-scoped memory rows (not workspace ws-*), if agent row was deleted.
    for key in sorted(content_keys):
        if not key or key.startswith("ws-"):
            continue
        if not AGENT_NAME_PATTERN.match(key):
            continue
        if key.lower() in seen:
            continue
        seen.add(key.lower())
        rows.append(
            {
                "id": key,
                "display_name": key,
                "description": "",
                "has_memory_file": True,
            }
        )

    return rows


def reload_memory_data(agent_name: str | None = None) -> dict[str, Any]:
    """Reload memory data via storage provider."""
    return get_memory_storage().reload(agent_name)


def clear_memory_data(agent_name: str | None = None) -> dict[str, Any]:
    """Clear all stored memory data and persist an empty structure."""
    try:
        from evoflow.memory.document_codec import namespace_for_agent_key
        from evoflow.memory.store import clear_namespace

        clear_namespace(namespace_for_agent_key(agent_name))
    except Exception:
        logger.debug("clear_namespace failed; falling back to empty save", exc_info=True)
    cleared_memory = _create_empty_memory()
    # Refresh storage cache
    get_memory_storage().reload(agent_name)
    get_memory_storage().save(cleared_memory, agent_name)
    return cleared_memory


def delete_memory_fact(fact_id: str, agent_name: str | None = None) -> dict[str, Any]:
    """Delete a fact by its id and persist the updated memory data."""
    from evoflow.memory.facade import forget

    memory_data = get_memory_data(agent_name)
    facts = memory_data.get("facts", [])
    if not any(fact.get("id") == fact_id for fact in facts):
        raise KeyError(fact_id)
    forget(str(fact_id))
    return get_memory_storage().reload(agent_name)


def _extract_text(content: Any) -> str:
    """Extract plain text from LLM response content (str or list of content blocks).

    Modern LLMs may return structured content as a list of blocks instead of a
    plain string, e.g. [{"type": "text", "text": "..."}]. Using str() on such
    content produces Python repr instead of the actual text, breaking JSON
    parsing downstream.

    String chunks are concatenated without separators to avoid corrupting
    chunked JSON/text payloads. Dict-based text blocks are treated as full text
    blocks and joined with newlines for readability.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces: list[str] = []
        pending_str_parts: list[str] = []

        def flush_pending_str_parts() -> None:
            if pending_str_parts:
                pieces.append("".join(pending_str_parts))
                pending_str_parts.clear()

        for block in content:
            if isinstance(block, str):
                pending_str_parts.append(block)
            elif isinstance(block, dict):
                flush_pending_str_parts()
                text_val = block.get("text")
                if isinstance(text_val, str):
                    pieces.append(text_val)

        flush_pending_str_parts()
        return "\n".join(pieces)
    return str(content)


# Matches sentences that describe a file-upload *event* rather than general
# file-related work.  Deliberately narrow to avoid removing legitimate facts
# such as "User works with CSV files" or "prefers PDF export".
_UPLOAD_SENTENCE_RE = re.compile(
    r"[^.!?]*\b(?:"
    r"upload(?:ed|ing)?(?:\s+\w+){0,3}\s+(?:file|files?|document|documents?|attachment|attachments?)"
    r"|file\s+upload"
    r"|/mnt/user-data/uploads/"
    r"|<uploaded_files>"
    r")[^.!?]*[.!?]?\s*",
    re.IGNORECASE,
)


def _strip_upload_mentions_from_memory(memory_data: dict[str, Any]) -> dict[str, Any]:
    """Remove sentences about file uploads from all memory summaries and facts.

    Uploaded files are session-scoped; persisting upload events in long-term
    memory causes the agent to search for non-existent files in future sessions.
    """
    # Scrub summaries in user/history sections
    for section in ("user", "history"):
        section_data = memory_data.get(section, {})
        for _key, val in section_data.items():
            if isinstance(val, dict) and "summary" in val:
                cleaned = _UPLOAD_SENTENCE_RE.sub("", val["summary"]).strip()
                cleaned = re.sub(r"  +", " ", cleaned)
                val["summary"] = cleaned

    # Also remove any facts that describe upload events
    facts = memory_data.get("facts", [])
    if facts:
        memory_data["facts"] = [f for f in facts if not _UPLOAD_SENTENCE_RE.search(f.get("content", ""))]

    return memory_data


def _fact_content_key(content: Any) -> str | None:
    if not isinstance(content, str):
        return None
    stripped = content.strip()
    if not stripped:
        return None
    return stripped


class MemoryUpdater:
    """Updates memory using LLM based on conversation context."""

    def __init__(self, model_name: str | None = None):
        """Initialize the memory updater.

        Args:
            model_name: Optional model name to use. If None, uses config or default.
        """
        self._model_name = model_name

    def _get_model(self):
        """Get the model for memory updates."""
        config = get_memory_config()
        model_name = config.model_name or self._model_name
        return create_chat_model(name=model_name, thinking_enabled=False, invocation_kind="memory")

    def update_memory(self, messages: list[Any], thread_id: str | None = None, agent_name: str | None = None) -> bool:
        """Update memory based on conversation messages.

        Args:
            messages: List of conversation messages.
            thread_id: Optional thread ID for tracking source.
            agent_name: If provided, updates per-agent memory. If None, updates global memory.

        Returns:
            True if update was successful, False otherwise.
        """
        config = get_memory_config()
        if not config.enabled:
            return False

        if not messages:
            return False

        try:
            # Get current memory
            current_memory = get_memory_data(agent_name)

            # Format conversation for prompt
            conversation_text = format_conversation_for_update(messages)

            if not conversation_text.strip():
                logger.info("[记忆] 用户记忆：对话文本为空，跳过 LLM thread=%s", thread_id or "?")
                return False

            # Build prompt
            prompt = MEMORY_UPDATE_PROMPT.format(
                current_memory=json.dumps(current_memory, indent=2),
                conversation=conversation_text,
            )

            # Call LLM
            model = self._get_model()
            logger.info(
                "[记忆] 用户记忆：调用 LLM 整理 agent=%s thread=%s 对话字符数=%d",
                agent_name or "全局",
                thread_id or "?",
                len(conversation_text),
            )
            response = model.invoke(prompt)
            response_text = _extract_text(response.content).strip()

            # Parse response
            # Remove markdown code blocks if present
            if response_text.startswith("```"):
                lines = response_text.split("\n")
                response_text = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])

            update_data = json.loads(response_text)

            # Apply updates
            updated_memory = self._apply_updates(current_memory, update_data, thread_id)

            # Strip file-upload mentions from all summaries before saving.
            # Uploaded files are session-scoped and won't exist in future sessions,
            # so recording upload events in long-term memory causes the agent to
            # try (and fail) to locate those files in subsequent conversations.
            updated_memory = _strip_upload_mentions_from_memory(updated_memory)

            # Save
            ok = get_memory_storage().save(updated_memory, agent_name)
            if ok and config.external_sync_enabled and (config.external_provider or "").strip():
                try:
                    from evoflow.agents.memory_plugins.manager import get_external_memory_plugin_manager

                    mgr = get_external_memory_plugin_manager()
                    if mgr is not None:
                        pair = extract_last_user_assistant_texts(messages)
                        if pair:
                            from evoflow.agents.memory_plugins.plugin_memory_audit import pm_event

                            pm_event(
                                "builtin_memory_update_external_sync",
                                thread_id=thread_id or "",
                                provider=(config.external_provider or "").strip(),
                                user_chars=len(pair[0] or ""),
                                assistant_chars=len(pair[1] or ""),
                            )
                            mgr.sync_turn(pair[0], pair[1], thread_id=thread_id or "")
                            mgr.queue_prefetch(pair[0], thread_id=thread_id or "")
                except Exception as sync_exc:
                    logger.debug("External memory sync after update skipped: %s", sync_exc)
            return ok

        except json.JSONDecodeError as e:
            logger.warning("[记忆] 用户记忆：LLM 返回 JSON 解析失败 thread=%s: %s", thread_id or "?", e)
            return False
        except Exception as e:
            logger.exception("[记忆] 用户记忆：整理失败 thread=%s: %s", thread_id or "?", e)
            return False

    def _apply_updates(
        self,
        current_memory: dict[str, Any],
        update_data: dict[str, Any],
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """Apply LLM-generated updates to memory.

        Args:
            current_memory: Current memory data.
            update_data: Updates from LLM.
            thread_id: Optional thread ID for tracking.

        Returns:
            Updated memory data.
        """
        config = get_memory_config()
        now = utc_now_iso_z()

        # Update user sections
        user_updates = update_data.get("user", {})
        for section in ["workContext", "personalContext", "topOfMind"]:
            section_data = user_updates.get(section, {})
            if section_data.get("shouldUpdate") and section_data.get("summary"):
                current_memory["user"][section] = {
                    "summary": section_data["summary"],
                    "updatedAt": now,
                }

        # Update history sections
        history_updates = update_data.get("history", {})
        for section in ["recentMonths", "earlierContext", "longTermBackground"]:
            section_data = history_updates.get(section, {})
            if section_data.get("shouldUpdate") and section_data.get("summary"):
                current_memory["history"][section] = {
                    "summary": section_data["summary"],
                    "updatedAt": now,
                }

        # Remove facts
        facts_to_remove = set(update_data.get("factsToRemove", []))
        if facts_to_remove:
            current_memory["facts"] = [f for f in current_memory.get("facts", []) if f.get("id") not in facts_to_remove]

        # Add new facts
        existing_fact_keys = {fact_key for fact_key in (_fact_content_key(fact.get("content")) for fact in current_memory.get("facts", [])) if fact_key is not None}
        new_facts = update_data.get("newFacts", [])
        for fact in new_facts:
            confidence = fact.get("confidence", 0.5)
            if confidence >= config.fact_confidence_threshold:
                raw_content = fact.get("content", "")
                normalized_content = raw_content.strip()
                fact_key = _fact_content_key(normalized_content)
                if fact_key is not None and fact_key in existing_fact_keys:
                    continue

                fact_entry = {
                    "id": make_fact_id(),
                    "content": normalized_content,
                    "category": fact.get("category", "context"),
                    "confidence": confidence,
                    "createdAt": now,
                    "source": thread_id or "unknown",
                }
                current_memory["facts"].append(fact_entry)
                if fact_key is not None:
                    existing_fact_keys.add(fact_key)

        # Enforce max facts limit
        if len(current_memory["facts"]) > config.max_facts:
            # Sort by confidence and keep top ones
            current_memory["facts"] = sorted(
                current_memory["facts"],
                key=lambda f: f.get("confidence", 0),
                reverse=True,
            )[: config.max_facts]

        return current_memory


def update_memory_from_conversation(messages: list[Any], thread_id: str | None = None, agent_name: str | None = None) -> bool:
    """Convenience function to update memory from a conversation.

    Args:
        messages: List of conversation messages.
        thread_id: Optional thread ID.
        agent_name: If provided, updates per-agent memory. If None, updates global memory.

    Returns:
        True if successful, False otherwise.
    """
    updater = MemoryUpdater()
    return updater.update_memory(messages, thread_id, agent_name)
