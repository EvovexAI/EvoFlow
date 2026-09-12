"""ChannelStore — persists IM chat-to-EvoFlow thread mappings (SQLite)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from evoflow.persistence import repositories as repo
from evoflow.persistence.timestamps import iso_z_to_unix, now_iso_z

logger = logging.getLogger(__name__)


class ChannelStore:
    """Maps IM conversations to EvoFlow threads in ``evoflow_channel_bindings``."""

    def __init__(self, path: str | None = None) -> None:
        del path  # legacy JSON path; unused
        self._data: dict[str, dict[str, Any]] = repo.load_all_channel_bindings()
        self._lock = asyncio.Lock()

    @staticmethod
    def _key(channel_name: str, chat_id: str, topic_id: str | None = None) -> str:
        if topic_id:
            return f"{channel_name}:{chat_id}:{topic_id}"
        return f"{channel_name}:{chat_id}"

    def get_thread_id(self, channel_name: str, chat_id: str, topic_id: str | None = None) -> str | None:
        entry = self._data.get(self._key(channel_name, chat_id, topic_id))
        return entry["thread_id"] if entry else None

    def get_entry(self, channel_name: str, chat_id: str, topic_id: str | None = None) -> dict[str, Any] | None:
        key = self._key(channel_name, chat_id, topic_id)
        row = self._data.get(key)
        return dict(row) if isinstance(row, dict) else None

    async def merge_thread_meta(
        self,
        channel_name: str,
        chat_id: str,
        meta: dict[str, Any],
        *,
        topic_id: str | None = None,
    ) -> None:
        if not meta:
            return
        async with self._lock:
            key = self._key(channel_name, chat_id, topic_id)
            existing = self._data.get(key)
            if not isinstance(existing, dict):
                return
            row = dict(existing)
            row.update(meta)
            row["updated_at"] = iso_z_to_unix(now_iso_z())
            self._data[key] = row
            await asyncio.to_thread(repo.save_channel_binding, key, row)

    async def set_thread_id(
        self,
        channel_name: str,
        chat_id: str,
        thread_id: str,
        *,
        topic_id: str | None = None,
        user_id: str = "",
    ) -> None:
        async with self._lock:
            key = self._key(channel_name, chat_id, topic_id)
            now = iso_z_to_unix(now_iso_z())
            existing = self._data.get(key)
            row = {
                "thread_id": thread_id,
                "user_id": user_id,
                "created_at": existing["created_at"] if existing else now,
                "updated_at": now,
            }
            self._data[key] = row
            await asyncio.to_thread(repo.save_channel_binding, key, row)

    async def remove(self, channel_name: str, chat_id: str, topic_id: str | None = None) -> bool:
        async with self._lock:
            if topic_id is not None:
                key = self._key(channel_name, chat_id, topic_id)
                if key in self._data:
                    del self._data[key]
                    return await asyncio.to_thread(repo.delete_channel_binding, key)
                return False
            prefix = self._key(channel_name, chat_id)
            keys_to_delete = [k for k in self._data if k == prefix or k.startswith(prefix + ":")]
            if not keys_to_delete:
                return False
            for k in keys_to_delete:
                del self._data[k]
            return await asyncio.to_thread(repo.delete_channel_bindings_by_prefix, prefix) > 0

    def list_entries(self, channel_name: str | None = None) -> list[dict[str, Any]]:
        results = []
        for key, entry in self._data.items():
            parts = key.split(":", 2)
            ch = parts[0]
            chat = parts[1] if len(parts) > 1 else ""
            topic = parts[2] if len(parts) > 2 else None
            if channel_name and ch != channel_name:
                continue
            item: dict[str, Any] = {"channel_name": ch, "chat_id": chat, **entry}
            if topic is not None:
                item["topic_id"] = topic
            results.append(item)
        return results
