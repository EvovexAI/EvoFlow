"""Session search with FTS5 full-text search support.

This module provides full-text search over conversation history stored in
the SQLite checkpointer. It creates and maintains an FTS5 virtual table
for efficient text search across all sessions.

Usage::

    from evoflow.agents.checkpointer.session_search import SessionSearch

    search = SessionSearch()
    results = search.search("用户偏好", limit=10)
"""

from __future__ import annotations

import logging
import os
import sqlite3
import sys
import threading
from datetime import datetime
from typing import Any

from evoflow.config.app_config import get_app_config

logger = logging.getLogger(__name__)

# Thread-local storage for database connections
_local = threading.local()


def _get_sqlite_db_path() -> str | None:
    """Get the SQLite database path from checkpointer config."""
    try:
        config = get_app_config()
        if config.checkpointer and config.checkpointer.type == "sqlite":
            conn_str = config.checkpointer.connection_string or "store.db"
            # Resolve relative paths
            if not conn_str.startswith(":memory:") and not conn_str.startswith("file:"):
                from evoflow.config.paths import resolve_path

                conn_str = str(resolve_path(conn_str))
            # One-time-ish diagnostic: helps confirm which DB is being used after workspace switch.
            home = (os.getenv("EVOFLOW_HOME") or "").strip() or "<unset>"
            msg = f"SessionSearch: resolved sqlite checkpointer path={conn_str} (EVOFLOW_HOME={home})"
            logger.info(msg)
            print(msg, file=sys.stderr, flush=True)
            return conn_str
    except Exception as e:
        logger.warning(f"Failed to get checkpointer config: {e}")
    return None


def _get_connection() -> sqlite3.Connection | None:
    """Get a thread-local SQLite connection."""
    db_path = _get_sqlite_db_path()
    if not db_path:
        return None

    if not hasattr(_local, "connection") or _local.connection is None:
        try:
            conn = sqlite3.connect(db_path, timeout=30)
            conn.row_factory = sqlite3.Row
            # Enable WAL mode for better concurrency
            conn.execute("PRAGMA journal_mode=WAL")
            _local.connection = conn
            logger.info(f"SessionSearch: connected to {db_path}")
        except Exception as e:
            logger.error(f"Failed to connect to SQLite: {e}")
            return None

    return _local.connection


class SessionSearch:
    """Full-text search over conversation sessions."""

    def __init__(self):
        self._initialized = False
        self._init_lock = threading.Lock()

    def _ensure_initialized(self):
        """Initialize FTS5 tables if they don't exist."""
        if self._initialized:
            return

        with self._init_lock:
            if self._initialized:
                return

            conn = _get_connection()
            if not conn:
                logger.warning("SessionSearch: no database connection available")
                return

            try:
                # Create sessions metadata table
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS session_search_index (
                        thread_id TEXT PRIMARY KEY,
                        assistant_id TEXT,
                        created_at TEXT,
                        updated_at TEXT,
                        message_count INTEGER DEFAULT 0,
                        user_content TEXT,
                        assistant_content TEXT,
                        all_content TEXT
                    )
                """)

                # Create FTS5 virtual table for full-text search
                conn.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
                        thread_id,
                        user_content,
                        assistant_content,
                        all_content,
                        content='session_search_index',
                        tokenize='unicode61'
                    )
                """)

                # Create triggers to keep FTS5 index in sync
                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS session_search_index_ai AFTER INSERT ON session_search_index BEGIN
                        INSERT INTO session_fts(rowid, thread_id, user_content, assistant_content, all_content)
                        VALUES (new.rowid, new.thread_id, new.user_content, new.assistant_content, new.all_content);
                    END
                """)

                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS session_search_index_ad AFTER DELETE ON session_search_index BEGIN
                        INSERT INTO session_fts(session_fts, rowid, thread_id, user_content, assistant_content, all_content)
                        VALUES('delete', old.rowid, old.thread_id, old.user_content, old.assistant_content, old.all_content);
                    END
                """)

                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS session_search_index_au AFTER UPDATE ON session_search_index BEGIN
                        INSERT INTO session_fts(session_fts, rowid, thread_id, user_content, assistant_content, all_content)
                        VALUES('delete', old.rowid, old.thread_id, old.user_content, old.assistant_content, old.all_content);
                        INSERT INTO session_fts(rowid, thread_id, user_content, assistant_content, all_content)
                        VALUES (new.rowid, new.thread_id, new.user_content, new.assistant_content, new.all_content);
                    END
                """)

                # Create indexes for filtering
                conn.execute("CREATE INDEX IF NOT EXISTS idx_session_created ON session_search_index(created_at)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_session_updated ON session_search_index(updated_at)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_session_assistant ON session_search_index(assistant_id)")

                conn.commit()
                self._initialized = True
                logger.info("SessionSearch: FTS5 index initialized successfully")

            except Exception as e:
                logger.error(f"Failed to initialize FTS5 index: {e}", exc_info=True)
                conn.rollback()

    def index_session(self, thread_id: str, messages: list[dict], assistant_id: str | None = None) -> bool:
        """Index a session's messages for search.

        Args:
            thread_id: The thread/session ID
            messages: List of message dicts with 'type' and 'content' keys
            assistant_id: Optional assistant ID

        Returns:
            True if indexing succeeded, False otherwise
        """
        self._ensure_initialized()

        conn = _get_connection()
        if not conn:
            return False

        try:
            # Extract user and assistant content
            user_parts = []
            assistant_parts = []

            for msg in messages:
                msg_type = msg.get("type", "")
                content = msg.get("content", "")

                if isinstance(content, list):
                    # Handle multipart content
                    text_parts = []
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            text_parts.append(part.get("text", ""))
                    content = " ".join(text_parts)

                if not content or not isinstance(content, str):
                    continue

                if msg_type == "human" or msg_type == "user":
                    user_parts.append(content)
                elif msg_type == "ai" or msg_type == "assistant":
                    assistant_parts.append(content)

            user_content = " ".join(user_parts)
            assistant_content = " ".join(assistant_parts)
            all_content = user_content + " " + assistant_content

            # Get timestamps
            now = datetime.now().isoformat()

            # Upsert into search index
            conn.execute(
                """
                INSERT OR REPLACE INTO session_search_index 
                (thread_id, assistant_id, created_at, updated_at, message_count, user_content, assistant_content, all_content)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (thread_id, assistant_id, now, now, len(messages), user_content, assistant_content, all_content),
            )

            conn.commit()
            return True

        except Exception as e:
            logger.error(f"Failed to index session {thread_id}: {e}", exc_info=True)
            conn.rollback()
            return False

    def search(self, query: str, limit: int = 10, offset: int = 0, assistant_id: str | None = None, date_from: str | None = None, date_to: str | None = None, search_in: str = "all") -> list[dict[str, Any]]:
        """Search sessions using full-text search.

        Args:
            query: Search query string
            limit: Maximum number of results
            offset: Offset for pagination
            assistant_id: Filter by assistant ID
            date_from: Filter by date range (ISO format, start)
            date_to: Filter by date range (ISO format, end)
            search_in: Where to search - 'user', 'assistant', or 'all'

        Returns:
            List of search result dicts with metadata
        """
        self._ensure_initialized()

        conn = _get_connection()
        if not conn:
            return []

        try:
            # Build FTS5 query
            if search_in == "user":
                pass
            elif search_in == "assistant":
                pass
            else:
                pass

            # FTS5 query syntax
            fts_query = query.replace(" ", " OR ")

            # Build base query with FTS5 ranking
            sql = """
                SELECT 
                    s.thread_id,
                    s.assistant_id,
                    s.created_at,
                    s.updated_at,
                    s.message_count,
                    s.user_content,
                    s.assistant_content,
                    bm25(session_fts) as rank
                FROM session_search_index s
                JOIN session_fts ON s.thread_id = session_fts.thread_id
                WHERE session_fts MATCH ?
            """
            params = [fts_query]

            # Add filters
            if assistant_id:
                sql += " AND s.assistant_id = ?"
                params.append(assistant_id)

            if date_from:
                sql += " AND s.updated_at >= ?"
                params.append(date_from)

            if date_to:
                sql += " AND s.updated_at <= ?"
                params.append(date_to)

            # Order by rank (lower is better for BM25)
            sql += " ORDER BY rank ASC"
            sql += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])

            cursor = conn.execute(sql, params)
            rows = cursor.fetchall()

            results = []
            for row in rows:
                # Extract snippet with highlighted matches
                try:
                    snippet_sql = """
                        SELECT snippet(session_fts, 2, '<mark>', '</mark>', '...', 50) as snippet
                        FROM session_fts
                        WHERE session_fts MATCH ?
                        AND thread_id = ?
                    """
                    snippet_row = conn.execute(snippet_sql, [fts_query, row["thread_id"]]).fetchone()
                    snippet = snippet_row["snippet"] if snippet_row else None
                except Exception:
                    snippet = None

                results.append(
                    {
                        "thread_id": row["thread_id"],
                        "assistant_id": row["assistant_id"],
                        "created_at": row["created_at"],
                        "updated_at": row["updated_at"],
                        "message_count": row["message_count"],
                        "rank": row["rank"],
                        "snippet": snippet,
                        "user_content_preview": row["user_content"][:200] if row["user_content"] else None,
                        "assistant_content_preview": row["assistant_content"][:200] if row["assistant_content"] else None,
                    }
                )

            return results

        except Exception as e:
            logger.error(f"Failed to search sessions: {e}", exc_info=True)
            return []

    def get_session_count(self, assistant_id: str | None = None, date_from: str | None = None, date_to: str | None = None) -> int:
        """Get total count of indexed sessions.

        Args:
            assistant_id: Filter by assistant ID
            date_from: Filter by date range (start)
            date_to: Filter by date range (end)

        Returns:
            Total count of sessions
        """
        self._ensure_initialized()

        conn = _get_connection()
        if not conn:
            return 0

        try:
            sql = "SELECT COUNT(*) as count FROM session_search_index WHERE 1=1"
            params = []

            if assistant_id:
                sql += " AND assistant_id = ?"
                params.append(assistant_id)

            if date_from:
                sql += " AND updated_at >= ?"
                params.append(date_from)

            if date_to:
                sql += " AND updated_at <= ?"
                params.append(date_to)

            cursor = conn.execute(sql, params)
            row = cursor.fetchone()
            return row["count"] if row else 0

        except Exception as e:
            logger.error(f"Failed to get session count: {e}")
            return 0

    def rebuild_index(self) -> int:
        """Rebuild the FTS5 index from scratch.

        Returns:
            Number of sessions reindexed
        """
        conn = _get_connection()
        if not conn:
            return 0

        try:
            # Clear existing index
            conn.execute("DELETE FROM session_fts")
            conn.execute("DELETE FROM session_search_index")
            conn.commit()

            self._initialized = False
            self._ensure_initialized()

            logger.info("SessionSearch: FTS5 index rebuilt successfully")
            return self.get_session_count()

        except Exception as e:
            logger.error(f"Failed to rebuild index: {e}", exc_info=True)
            conn.rollback()
            return 0


# Singleton instance
_session_search = None
_session_search_lock = threading.Lock()


def get_session_search() -> SessionSearch:
    """Get the global SessionSearch singleton."""
    global _session_search

    if _session_search is None:
        with _session_search_lock:
            if _session_search is None:
                _session_search = SessionSearch()

    return _session_search
