"""Meter embedding API / local encode calls into the product usage ledger.

Call sites (KB index, retrieval, code_index, memory, …) should wrap work in
:func:`embedding_usage_scope` so purpose (index vs query) is attributed.
Providers call :func:`note_embedding_call` after each successful backend batch.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator

logger = logging.getLogger(__name__)

_purpose: ContextVar[str] = ContextVar("ef_embed_purpose", default="")
_kb_id: ContextVar[str] = ContextVar("ef_embed_kb_id", default="")
_skip: ContextVar[bool] = ContextVar("ef_embed_skip_meter", default=False)


@contextmanager
def embedding_usage_scope(
    *,
    purpose: str = "",
    kb_id: str | None = None,
    skip: bool = False,
) -> Iterator[None]:
    """Attribute embedding calls in this context to a purpose / knowledge base.

    ``purpose`` values: ``index`` (chunk embed / reindex), ``query`` (retrieval),
    ``probe`` (health / dim detect — not billed), ``other`` (default).
    """
    t_purpose = _purpose.set(str(purpose or "").strip())
    t_kb = _kb_id.set(str(kb_id or "").strip())
    t_skip = _skip.set(bool(skip))
    try:
        yield
    finally:
        _purpose.reset(t_purpose)
        _kb_id.reset(t_kb)
        _skip.reset(t_skip)


def current_embedding_purpose() -> str:
    return str(_purpose.get() or "").strip()


def current_embedding_kb_id() -> str:
    return str(_kb_id.get() or "").strip()


def estimate_prompt_tokens(texts: list[str]) -> int:
    """Rough token estimate when the vendor omits ``usage`` (≈ chars/4)."""
    chars = sum(len(t or "") for t in texts)
    return max(1, chars // 4) if texts else 0


def note_embedding_call(
    *,
    model: str = "",
    provider: str = "",
    prompt_tokens: int | float = 0,
    texts: list[str] | None = None,
    input_count: int | None = None,
    is_local: bool = False,
    meta: dict[str, Any] | None = None,
) -> bool:
    """Best-effort ledger write for one successful embedding backend batch."""
    if _skip.get():
        return False
    purpose = current_embedding_purpose() or "other"
    if purpose.lower() in ("probe", "detect", "warmup"):
        return False

    texts = texts or []
    n_in = int(input_count if input_count is not None else len(texts))
    tokens = int(prompt_tokens or 0)
    if tokens <= 0:
        tokens = estimate_prompt_tokens(texts) if texts else max(1, n_in)

    try:
        from evoflow.persistence.usage_ledger import record_embedding_usage

        return bool(
            record_embedding_usage(
                model=model,
                provider=provider,
                purpose=purpose,
                prompt_tokens=tokens,
                input_count=n_in,
                is_local=is_local,
                kb_id=current_embedding_kb_id() or None,
                meta=meta,
            )
        )
    except Exception:
        logger.debug("note_embedding_call failed", exc_info=True)
        return False
