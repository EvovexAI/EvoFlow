"""Deprecated: assistant partial salvage from stream mirror.

Assistant/tool transcript rows are owned exclusively by ``TranscriptMiddleware``
(``after_model`` + stream accumulator on cancel). Mirror frames remain for
stream-resume only; they must not write ``evoflow_chat_messages``.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def persist_partial_assistant_from_mirror(
    session_key: str,
    *,
    run_id: str | None = None,
    reason: str = "",
) -> None:
    """No-op — kept for import stability; do not persist assistant from mirror."""
    del run_id
    if str(reason or "").strip():
        logger.debug(
            "mirror partial persist disabled (TranscriptMiddleware owns assistant) session=%s reason=%s",
            session_key,
            reason,
        )
