"""Cloud embedding provider — OpenAI-compatible embeddings HTTP endpoint.

This is the default backend when ``vendor`` is not ``"local"``. It calls a
remote HTTP endpoint (OpenAI, Azure OpenAI, DeepSeek, Qwen DashScope, Volcengine
Ark ``…/api/v3|/api/plan/v3|/api/coding/v3``, or any OpenAI-compatible gateway)
to convert text into dense float vectors.

Connection settings (``base_url`` / ``api_key``) are sourced from the
embedding model's own :class:`ModelConfig`; if those are empty, it falls back
to the primary chat model's connection (same provider, same key — a common
setup where users only configure a chat model).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from evoflow.config.app_config import get_app_config
from evoflow.config.model_config import ModelConfig
from evoflow.knowledge.embedding.base import (
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_TIMEOUT,
    MAX_BATCH_SIZE,
    EmbeddingError,
    EmbeddingProvider,
    openai_compat_embeddings_url,
)

logger = logging.getLogger(__name__)


def _is_multimodal_embedding_model(model_name: str, base_url: str = "") -> bool:
    """True when the model expects Ark ``/embeddings/multimodal`` (typed input).

    Agent Plan documents ``doubao-embedding-vision`` via
    ``…/api/plan/v3/embeddings/multimodal``. Coding Plan often uses OpenAI-compat
    ``…/api/coding/v3/embeddings`` for the same model id — keep that path unless
    the base is Agent Plan.
    """
    mid = (model_name or "").strip().lower()
    if not mid:
        return False
    if "multimodal" in mid or mid.endswith("-mm") or "/multimodal" in mid:
        return True
    base = (base_url or "").strip().lower()
    if "embedding-vision" in mid and "/api/plan/" in base:
        return True
    return False


def _resolve_connection(model_config: ModelConfig) -> tuple[str, str, str, float]:
    """Extract (base_url, api_key, model_name, timeout) from a ModelConfig.

    Resolves ``$ENV`` placeholders in ``api_key`` and strips whitespace.
    Falls back to the primary chat model's connection settings when the
    embedding model itself has no ``base_url``/``api_key``.
    """
    from evoflow.models.credential_sanitize import resolve_and_sanitize_api_key

    base_url = (getattr(model_config, "base_url", "") or "").strip().rstrip("/")
    api_key_raw = getattr(model_config, "api_key", "") or ""
    model_name = (
        getattr(model_config, "model", "") or ""
    ).strip() or DEFAULT_EMBEDDING_MODEL
    timeout = float(
        getattr(model_config, "request_timeout", None) or DEFAULT_TIMEOUT
    )

    api_key = resolve_and_sanitize_api_key(api_key_raw) or ""

    # Fallback: if the embedding config has no base_url/api_key, try the
    # primary chat model's connection settings (same provider, same key).
    if not base_url or not api_key:
        try:
            cfg = get_app_config()
            primary_name = getattr(cfg, "primary_model", "") or ""
            if primary_name:
                primary = cfg.get_model_config(primary_name)
                if primary:
                    if not base_url:
                        base_url = (
                            getattr(primary, "base_url", "") or ""
                        ).strip().rstrip("/")
                    if not api_key:
                        api_key = (
                            resolve_and_sanitize_api_key(
                                getattr(primary, "api_key", "") or ""
                            )
                            or ""
                        )
                    if timeout == DEFAULT_TIMEOUT:
                        timeout = float(
                            getattr(primary, "request_timeout", None)
                            or DEFAULT_TIMEOUT
                        )
        except Exception:
            pass  # best-effort fallback

    return base_url, api_key, model_name, timeout


class CloudEmbeddingProvider(EmbeddingProvider):
    """Embedding via an OpenAI-compatible embeddings HTTP endpoint.

    Created per-call (no shared client) to avoid shared-state issues in
    thread-pool contexts. For high-throughput batch pipelines, prefer
    :meth:`embed_batch` (one request for many texts).
    """

    async def embed(self, text: str) -> list[float]:
        results = await self.embed_batch([text])
        return results[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        base_url, api_key, model_name, timeout = _resolve_connection(
            self.model_config
        )

        if not base_url:
            raise EmbeddingError(
                "No base_url configured for embedding model. "
                "Set base_url in Settings → Models for the embedding model, "
                "or ensure a primary chat model with base_url is configured."
            )
        if not api_key:
            raise EmbeddingError(
                "No api_key configured for embedding model. "
                "Set api_key in Settings → Models for the embedding model, "
                "or ensure a primary chat model with api_key is configured."
            )

        multimodal = _is_multimodal_embedding_model(model_name, base_url)
        all_embeddings: list[list[float]] = []
        bs = MAX_BATCH_SIZE
        for i in range(0, len(texts), bs):
            batch = texts[i : i + bs]
            batch_embeddings = await _call_embeddings_api(
                base_url,
                api_key,
                model_name,
                batch,
                timeout,
                multimodal=multimodal,
            )
            all_embeddings.extend(batch_embeddings)

        return all_embeddings


def _normalize_embedding_vector(raw: Any) -> list[float]:
    """Flatten nested Ark multimodal vectors to a 1-D float list."""
    if not isinstance(raw, list) or not raw:
        raise TypeError("embedding is empty or not a list")
    if isinstance(raw[0], (int, float)):
        return [float(x) for x in raw]
    if isinstance(raw[0], list):
        # Some multimodal responses wrap a single vector as [[...]]
        if len(raw) == 1 and raw[0] and isinstance(raw[0][0], (int, float)):
            return [float(x) for x in raw[0]]
        raise TypeError("embedding has unexpected nested shape")
    raise TypeError("embedding items are not numeric")


def _parse_embeddings_response(body: dict[str, Any], *, n_inputs: int) -> list[list[float]]:
    data = body.get("data")
    # OpenAI / Ark text: data = [{index, embedding}, ...]
    if isinstance(data, list) and data:
        data_sorted = sorted(
            data,
            key=lambda d: d.get("index", 0) if isinstance(d, dict) else 0,
        )
        embeddings = [
            _normalize_embedding_vector(item["embedding"])
            for item in data_sorted
            if isinstance(item, dict)
        ]
        if len(embeddings) == n_inputs:
            return embeddings
        # Multimodal sometimes returns one combined vector for multi-part input
        if len(embeddings) == 1 and n_inputs >= 1:
            return embeddings * n_inputs if n_inputs > 1 else embeddings
        raise EmbeddingError(
            f"Embedding API returned {len(embeddings)} embeddings for {n_inputs} inputs"
        )
    # Ark multimodal alternate: data = {embedding: [...]}
    if isinstance(data, dict) and "embedding" in data:
        vec = _normalize_embedding_vector(data["embedding"])
        return [vec] * n_inputs if n_inputs > 1 else [vec]
    raise EmbeddingError(
        f"Embedding API response missing 'data' embeddings: {str(body)[:200]}"
    )


async def _call_embeddings_api(
    base_url: str,
    api_key: str,
    model_name: str,
    inputs: list[str],
    timeout: float,
    *,
    multimodal: bool = False,
) -> list[list[float]]:
    """Make a single POST to the embeddings endpoint and parse the response.

    Returns:
        List of embedding vectors in the same order as ``inputs``.

    Raises:
        EmbeddingError: On any API error (network, auth, rate-limit, malformed response).
    """
    url = openai_compat_embeddings_url(base_url, multimodal=multimodal)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if multimodal:
        # One request per text; Ark multimodal input is typed parts, not a string list.
        out: list[list[float]] = []
        for text in inputs:
            payload: dict[str, Any] = {
                "model": model_name,
                "input": [{"type": "text", "text": text}],
            }
            out.append(
                (
                    await _post_embeddings(url, headers, payload, timeout, n_inputs=1)
                )[0]
            )
        return out

    payload: dict[str, Any] = {"model": model_name, "input": inputs}
    return await _post_embeddings(url, headers, payload, timeout, n_inputs=len(inputs))


async def _post_embeddings(
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout: float,
    *,
    n_inputs: int,
) -> list[list[float]]:
    import asyncio

    last_timeout: Exception | None = None
    for attempt in range(4):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except httpx.TimeoutException as exc:
            last_timeout = exc
            if attempt >= 3:
                raise EmbeddingError(
                    f"Embedding API request timed out after {timeout}s: {exc}"
                ) from exc
            await asyncio.sleep(min(30.0, 2.0**attempt))
            continue
        except httpx.ConnectError as exc:
            raise EmbeddingError(
                f"Cannot connect to embedding API at {url}: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise EmbeddingError(f"Embedding API HTTP error: {exc}") from exc

        if resp.status_code == 200:
            try:
                body = resp.json()
                return _parse_embeddings_response(body, n_inputs=n_inputs)
            except EmbeddingError:
                raise
            except (KeyError, TypeError, ValueError) as exc:
                raise EmbeddingError(
                    f"Failed to parse embedding API response: {exc}"
                ) from exc

        error_detail = ""
        try:
            body = resp.json()
            error_detail = str(body.get("error", {}).get("message", "") or body)
        except Exception:
            error_detail = resp.text[:500]

        if resp.status_code == 429 and attempt < 3:
            await asyncio.sleep(min(60.0, 3.0 * (2**attempt)))
            continue
        if resp.status_code == 429:
            raise EmbeddingError(
                f"Embedding API rate limit (429): {error_detail}. "
                "Consider reducing batch size or adding retries."
            ) from None
        if resp.status_code == 401:
            raise EmbeddingError(
                f"Embedding API auth error (401): check api_key. {error_detail}"
            ) from None
        raise EmbeddingError(
            f"Embedding API returned HTTP {resp.status_code}: {error_detail}"
        ) from None

    if last_timeout is not None:
        raise EmbeddingError(
            f"Embedding API request timed out after {timeout}s: {last_timeout}"
        ) from last_timeout
    raise EmbeddingError("Embedding API request failed after retries")
