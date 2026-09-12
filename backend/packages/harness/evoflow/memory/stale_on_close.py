"""Mark related memories stale when work is closed (minimal TTL substitute)."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _namespaces_for_close(*, agent_code: str = "") -> list[str]:
    from evoflow.memory.namespaces import agent_ns, person_ns, user_ns

    ns = [user_ns("default")]
    code = str(agent_code or "").strip()
    if code:
        try:
            ns.append(agent_ns(code))
        except Exception:
            pass
        try:
            ns.append(person_ns(code))
        except Exception:
            pass
    # Dedupe preserve order
    out: list[str] = []
    seen: set[str] = set()
    for n in ns:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def stale_memories_on_close(
    *,
    title: str,
    notes: str = "",
    agent_code: str = "",
    source_ref: str = "",
    reason: str = "",
) -> dict[str, Any]:
    """Best-effort: keyword-mark memories matching the closed work title."""
    q = " ".join(f"{title} {notes}".split()).strip()
    if len(q) < 8:
        # Prefer title alone if notes empty/short
        q = str(title or "").strip()
    if len(q) < 4:
        return {"ok": True, "marked": 0, "skipped": "query_too_short"}
    try:
        from evoflow.memory.facade import mark_related_memories_stale

        return mark_related_memories_stale(
            query=q[:240],
            namespaces=_namespaces_for_close(agent_code=agent_code),
            reason=reason or f"work closed: {title[:80]}",
            source_ref=source_ref,
            top_k=12,
        )
    except Exception as exc:
        logger.debug("stale_memories_on_close failed: %s", exc)
        return {"ok": False, "marked": 0, "error": str(exc)}
