"""Shared low-level token utilities for context compaction.

This module owns ONLY pure, type-agnostic helpers used by both the main agent
compaction engine (``evoflow.agents.context_compaction_core``) and the hosted
planner compressor (``app.channels.services.hosted_context_compressor``).

Domain-specific logic — message serialization, summary prompts, fold
algorithms — stays in each compressor because their data types differ
(LangChain ``BaseMessage`` vs ``HostedHistoryItem``).

Design notes (fix history, see internal design docs (not published in this repository)/):

* **Model-aware encoder selection** — ``tiktoken`` ships only a few BPE tables;
  ``cl100k_base`` covers GPT-3.5 / GPT-4-turbo; ``o200k_base`` covers
  GPT-4o / o1 / o3. Claude / Qwen / Gemini have their own tokenizers but no
  Python BPE in stdlib; we pick the closest tiktoken table by model name and
  fall back to ``cl100k_base``. Estimates stay within ~15% of provider truth,
  which is good enough for compaction gating.
* **CJK-aware fallback** — when tiktoken cannot be loaded at all (minimal
  containers), the legacy heuristic of ``len(text)//4`` undercounts Chinese
  by ~8x (one Han char ≈ 1.5 tokens, not 0.25). We split on CJK code points
  and apply a separate per-char weight.
* **Per-call model hint** — callers wrap their request in
  ``with token_model_scope(model_name):`` so deep helpers (
  ``message_token_estimate`` in the compaction core) see the right tokenizer
  without threading ``model_name`` through every signature.
* **Non-blocking tokenizer I/O** — ``tiktoken.get_encoding`` may download BPE
  tables via synchronous ``requests.get`` with no timeout. Doing that on the
  asyncio event loop stalls the whole Gateway (health checks fail → guardian
  restart). Hot-path loads never download; startup / a daemon thread warms
  encodings, and downloads use explicit connect/read timeouts.
"""

from __future__ import annotations

import contextvars
import hashlib
import logging
import os
import re
import tempfile
import threading
from functools import lru_cache
from typing import Iterable

try:
    import tiktoken
except Exception:  # pragma: no cover - tiktoken optional in minimal builds
    tiktoken = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Public constants (re-exported by context_compaction_core)                   #
# --------------------------------------------------------------------------- #

# Approximate characters-per-token used when tiktoken is unavailable.
# Applies only to non-CJK runs; CJK is counted separately at 1 token/char.
_CHARS_PER_TOKEN = 4

# CJK character class shared by language detection in both compressors.
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")

# How long to skip the summary LLM after a failure (seconds).
SUMMARY_FAILURE_COOLDOWN_SECONDS = 300

# LRU cache for token counts. ``tiktoken.encode`` is O(n) over the input and
# ``message_token_estimate`` is called many times per fold (boundary scan,
# gate logging, plan_compaction). Caching by exact text avoids redundant
# tokenization for messages that repeat across passes (system prompt, frozen
# tool_history blocks, conversation_summary).
#
# Bumped from 16k to 64k chars in the 2026-06 fix: large tool results
# (read_file / search_code_index payloads) routinely exceed 16k and were
# previously re-tokenized on every gate check, which was both slow and
# defeated the cache for the workloads that need it most.
_TOKEN_CACHE_MAX_LEN = 64_000
_TOKEN_CACHE_SIZE = 2048

# --------------------------------------------------------------------------- #
# Encoder resolution                                                          #
# --------------------------------------------------------------------------- #

# Public blob URLs used by ``tiktoken_ext.openai_public`` for the two tables we
# select. Kept here so we can probe the on-disk cache *without* triggering a
# network download on the event-loop hot path.
_ENCODING_BLOB_URLS: dict[str, str] = {
    "cl100k_base": (
        "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken"
    ),
    "o200k_base": (
        "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"
    ),
}

_DEFAULT_ENCODINGS_TO_WARM: tuple[str, ...] = ("cl100k_base", "o200k_base")

# Per-encoding cached encoder instances. ``tiktoken.get_encoding`` is cheap on
# second call but we still memoize so the hot path does no dict lookups in
# tiktoken's registry. Only successful loads are stored (failures go to
# ``_ENCODER_FAILED`` so a later warm can retry after a transient network blip).
_ENCODER_CACHE: dict[str, object] = {}
_ENCODER_FAILED: set[str] = set()
_ENCODER_LOADING: set[str] = set()
_ENCODER_LOCK = threading.Lock()
_READ_FILE_PATCHED = False


def _tiktoken_connect_timeout() -> float:
    raw = os.environ.get("EVOFLOW_TIKTOKEN_CONNECT_TIMEOUT", "5").strip()
    try:
        return max(0.5, float(raw))
    except ValueError:
        return 5.0


def _tiktoken_read_timeout() -> float:
    raw = os.environ.get("EVOFLOW_TIKTOKEN_READ_TIMEOUT", "30").strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 30.0


def _tiktoken_cache_dir() -> str:
    if "TIKTOKEN_CACHE_DIR" in os.environ:
        return os.environ["TIKTOKEN_CACHE_DIR"]
    if "DATA_GYM_CACHE_DIR" in os.environ:
        return os.environ["DATA_GYM_CACHE_DIR"]
    return os.path.join(tempfile.gettempdir(), "data-gym-cache")


def _blob_cache_path(blob_url: str) -> str:
    cache_key = hashlib.sha1(blob_url.encode()).hexdigest()
    return os.path.join(_tiktoken_cache_dir(), cache_key)


def encoding_blob_cached_on_disk(name: str) -> bool:
    """True when tiktoken's on-disk BPE cache already has ``name``'s blob."""
    url = _ENCODING_BLOB_URLS.get(name)
    if not url:
        return False
    try:
        return os.path.exists(_blob_cache_path(url))
    except OSError:
        return False


def _install_tiktoken_read_timeout_patch() -> None:
    """Make ``tiktoken.load.read_file`` use connect/read timeouts (idempotent)."""
    global _READ_FILE_PATCHED
    if _READ_FILE_PATCHED or tiktoken is None:
        return
    try:
        import tiktoken.load as tiktoken_load
    except Exception:  # pragma: no cover
        return

    original_read_file = tiktoken_load.read_file

    def read_file_with_timeout(blobpath: str) -> bytes:
        if "://" not in blobpath:
            return original_read_file(blobpath)
        if blobpath.startswith(("http://", "https://")):
            import requests

            resp = requests.get(
                blobpath,
                timeout=(_tiktoken_connect_timeout(), _tiktoken_read_timeout()),
            )
            resp.raise_for_status()
            return resp.content
        return original_read_file(blobpath)

    tiktoken_load.read_file = read_file_with_timeout  # type: ignore[assignment]
    _READ_FILE_PATCHED = True


def _store_encoding_success(name: str, enc: object) -> None:
    with _ENCODER_LOCK:
        _ENCODER_CACHE[name] = enc
        _ENCODER_FAILED.discard(name)
        _ENCODER_LOADING.discard(name)
    # Intentionally do not clear ``_count_cached``: entries counted with the
    # heuristic while warming stay approximate, and flushing mid-request can
    # make concurrent estimate ratios flaky. New misses use the real encoder.


def _store_encoding_failure(name: str) -> None:
    with _ENCODER_LOCK:
        _ENCODER_FAILED.add(name)
        _ENCODER_LOADING.discard(name)


def _load_encoding_blocking(name: str) -> object | None:
    """Load ``name`` on the current thread (may download). Never call on the loop."""
    if tiktoken is None:
        return None
    _install_tiktoken_read_timeout_patch()
    with _ENCODER_LOCK:
        cached = _ENCODER_CACHE.get(name)
        if cached is not None:
            return cached
    try:
        enc = tiktoken.get_encoding(name)
    except Exception:
        logger.warning(
            "tiktoken encoding %s failed to load (token counts will use heuristic)",
            name,
            exc_info=True,
        )
        _store_encoding_failure(name)
        return None
    _store_encoding_success(name, enc)
    return enc


def _schedule_encoding_warm(name: str) -> None:
    """Daemon-thread download/load so the event loop never waits on SSL I/O."""
    if tiktoken is None:
        return
    with _ENCODER_LOCK:
        if name in _ENCODER_CACHE or name in _ENCODER_LOADING:
            return
        if name in _ENCODER_FAILED and not encoding_blob_cached_on_disk(name):
            # Permanent failure with nothing on disk — don't spin forever.
            # Callers can still force via ``warm_token_encodings(force=True)``.
            return
        _ENCODER_LOADING.add(name)

    def _run() -> None:
        try:
            _load_encoding_blocking(name)
        finally:
            with _ENCODER_LOCK:
                _ENCODER_LOADING.discard(name)

    threading.Thread(
        target=_run,
        name=f"evoflow-tiktoken-warm-{name}",
        daemon=True,
    ).start()


def _load_encoding(name: str) -> object | None:
    """Best-effort encoder for the hot path — never sync I/O or downloads.

    Only returns an encoder already warmed into ``_ENCODER_CACHE``. Otherwise
    schedules a daemon warm (disk read and/or timed network download) and
    returns ``None`` so callers degrade to the CJK heuristic instead of
    stalling the Gateway event loop.
    """
    if tiktoken is None:
        return None
    with _ENCODER_LOCK:
        cached = _ENCODER_CACHE.get(name)
        if cached is not None:
            return cached
        if name in _ENCODER_FAILED:
            return None
        loading = name in _ENCODER_LOADING

    if not loading:
        _schedule_encoding_warm(name)
    return None


def token_encoding_status(name: str | None = None) -> dict[str, str]:
    """Return readiness map for one or all known encodings.

    Values: ``ready`` | ``loading`` | ``cached_on_disk`` | ``missing`` | ``failed`` |
    ``unavailable``.
    """
    names = (name,) if name else _DEFAULT_ENCODINGS_TO_WARM
    out: dict[str, str] = {}
    if tiktoken is None:
        for n in names:
            out[n] = "unavailable"
        return out
    with _ENCODER_LOCK:
        for n in names:
            if n in _ENCODER_CACHE:
                out[n] = "ready"
            elif n in _ENCODER_LOADING:
                out[n] = "loading"
            elif n in _ENCODER_FAILED:
                out[n] = "failed"
            elif encoding_blob_cached_on_disk(n):
                out[n] = "cached_on_disk"
            else:
                out[n] = "missing"
    return out


def warm_token_encodings(
    names: Iterable[str] | None = None,
    *,
    force: bool = False,
) -> dict[str, bool]:
    """Synchronously warm encodings (run via ``asyncio.to_thread`` from async).

    Downloads missing BPE blobs with connect/read timeouts. Failures are
    non-fatal: token math falls back to the heuristic.

    Returns ``{encoding_name: loaded_ok}``.
    """
    targets = tuple(names) if names is not None else _DEFAULT_ENCODINGS_TO_WARM
    results: dict[str, bool] = {}
    if tiktoken is None:
        return {n: False for n in targets}

    for n in targets:
        with _ENCODER_LOCK:
            if not force and n in _ENCODER_CACHE:
                results[n] = True
                continue
            if force:
                _ENCODER_FAILED.discard(n)
        enc = _load_encoding_blocking(n)
        results[n] = enc is not None
    return results


# Install download timeouts as early as possible so *any* tiktoken caller
# (chunker import, memory prompt, etc.) cannot hang forever on SSL reads.
if tiktoken is not None:  # pragma: no branch
    try:
        _install_tiktoken_read_timeout_patch()
    except Exception:
        pass


def ensure_token_encodings_warming(
    names: Iterable[str] | None = None,
) -> dict[str, str]:
    """Kick background warm for encodings that are not ready; return status map."""
    targets = tuple(names) if names is not None else _DEFAULT_ENCODINGS_TO_WARM
    for n in targets:
        with _ENCODER_LOCK:
            if n in _ENCODER_CACHE:
                continue
        _schedule_encoding_warm(n)
    return token_encoding_status()


def token_encodings_ready(names: Iterable[str] | None = None) -> bool:
    """True when every requested encoding is loaded in memory."""
    targets = tuple(names) if names is not None else _DEFAULT_ENCODINGS_TO_WARM
    status = token_encoding_status()
    return all(status.get(n) == "ready" for n in targets)


def _encoding_name_for_model(model_name: str | None) -> str:
    """Pick the closest tiktoken BPE table for ``model_name``.

    Provider-specific notes:

    * **OpenAI** GPT-4o / o1 / o3 / GPT-5 family use ``o200k_base``; everything
      else (GPT-3.5, GPT-4, GPT-4-turbo) is ``cl100k_base``.
    * **Anthropic** Claude has no tiktoken table. ``cl100k_base`` is the
      closest public approximation — English is within ~5%, Chinese within
      ~10–15%, both close enough for gating.
    * **Qwen / DeepSeek / GLM / Yi** use bespoke BPEs. Empirically
      ``cl100k_base`` is again the best public proxy; ``o200k_base`` tends to
      **over** estimate Chinese for these.
    * **Gemini** uses SentencePiece. We default to ``cl100k_base``; this is
      the largest residual error (±20% on long Chinese).
    """
    if not model_name:
        return "cl100k_base"
    name = model_name.lower()
    # OpenAI o200k_base family: 4o, o1, o3, gpt-5, omni-*, chatgpt-4o-*
    if (
        "gpt-4o" in name
        or "gpt-5" in name
        or name.startswith("o1")
        or name.startswith("o3")
        or name.startswith("o4")
        or "omni" in name
        or "chatgpt-4o" in name
    ):
        return "o200k_base"
    return "cl100k_base"


# --------------------------------------------------------------------------- #
# Per-call model scope (contextvar)                                           #
# --------------------------------------------------------------------------- #

# Set by middleware (``ContextCompactionMiddleware``) at the start of a model
# call so all downstream token math uses the right tokenizer without having
# to thread ``model_name`` through every signature.
_CURRENT_MODEL: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "evoflow_token_model", default=None
)


def set_token_model(model_name: str | None) -> contextvars.Token:
    """Set the active model hint. Returns a token usable with ``reset_token_model``."""
    return _CURRENT_MODEL.set(model_name)


def reset_token_model(token: contextvars.Token) -> None:
    _CURRENT_MODEL.reset(token)


def current_token_model() -> str | None:
    return _CURRENT_MODEL.get()


class token_model_scope:
    """Context manager: temporarily set the active model for token counting.

        with token_model_scope("gpt-4o"):
            count_text_tokens(some_text)   # uses o200k_base
    """

    __slots__ = ("_model", "_tok")

    def __init__(self, model_name: str | None) -> None:
        self._model = model_name
        self._tok: contextvars.Token | None = None

    def __enter__(self) -> token_model_scope:
        self._tok = set_token_model(self._model)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._tok is not None:
            reset_token_model(self._tok)
            self._tok = None


# --------------------------------------------------------------------------- #
# Heuristic fallback                                                          #
# --------------------------------------------------------------------------- #


def _heuristic_token_count(text: str) -> int:
    """tiktoken-free estimate that handles CJK correctly.

    CJK code points are weighted at 1.3 tokens/char (real tokenizers emit
    1.0–1.7 tokens per Han char; 1.3 is a better midpoint than 1.0).
    Code-heavy content (high density of special chars) gets a small bonus
    since code tokenizes at higher density than natural language.
    Everything else falls back to ``chars / _CHARS_PER_TOKEN``.
    """
    if not text:
        return 0
    cjk_chars = sum(1 for ch in text if _CJK_RE.match(ch))
    other_chars = len(text) - cjk_chars
    base = int(cjk_chars * 1.3) + other_chars // _CHARS_PER_TOKEN
    # Code content (braces, brackets, semicolons) tokenizes denser than prose.
    code_chars = sum(1 for ch in text if ch in "{}[]();=<>")
    if code_chars > len(text) * 0.03:
        base = int(base * 1.15)
    return max(1, base)


# --------------------------------------------------------------------------- #
# Public API                                                                  #
# --------------------------------------------------------------------------- #


@lru_cache(maxsize=_TOKEN_CACHE_SIZE)
def _count_cached(text: str, encoding_name: str) -> int:
    enc = _load_encoding(encoding_name)
    if enc is not None:
        try:
            return len(enc.encode(text))
        except Exception:
            pass
    return _heuristic_token_count(text)


def count_text_tokens(text: str, *, model: str | None = None) -> int:
    """Estimate token count for ``text``.

    Args:
        text: Text to count.
        model: Optional explicit model name. When omitted, falls back to the
            active ``token_model_scope`` (set by the compaction middleware).

    Selection rules:
        * GPT-4o / o1 / o3 / GPT-5 → ``o200k_base``
        * Everything else (including Claude / Qwen / Gemini approximations)
          → ``cl100k_base``
        * tiktoken unavailable → CJK-aware heuristic (1 token per Han char,
          else ``chars / 4``).

    Cached for short-to-medium inputs (<= ``_TOKEN_CACHE_MAX_LEN`` chars).
    Very long strings bypass the cache so a single huge tool output doesn't
    evict everything else; they tokenize directly each call.
    """
    if not text:
        return 0
    effective_model = model if model is not None else _CURRENT_MODEL.get()
    encoding_name = _encoding_name_for_model(effective_model)

    if len(text) <= _TOKEN_CACHE_MAX_LEN:
        return _count_cached(text, encoding_name)
    enc = _load_encoding(encoding_name)
    if enc is not None:
        try:
            return len(enc.encode(text))
        except Exception:
            pass
    return _heuristic_token_count(text)
