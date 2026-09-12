"""Prompt-cache rollup and estimated savings for observability dashboards."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from evoflow.observability.cache_pricing import (
    detect_platform,
    estimate_row_cache_savings_cny,
    estimate_row_request_cost_cny,
    pricing_platform_label,
    resolve_cache_price,
    savings_cny_per_mtok,
)
from evoflow.observability.queries import ObservabilityTable, cache_tokens_from_usage_payload


def compute_cache_hit_rate(
    cache_read_tokens: int,
    cache_miss_tokens: int,
    cache_creation_tokens: int = 0,
) -> float | None:
    """Share of prompt-cache-eligible tokens served from cache (0–1)."""
    read = max(0, int(cache_read_tokens or 0))
    miss = max(0, int(cache_miss_tokens or 0))
    create = max(0, int(cache_creation_tokens or 0))
    if read <= 0:
        return None
    denom = read + miss
    if denom <= 0:
        denom = read + create
    if denom <= 0:
        return None
    return round(min(1.0, read / denom), 4)


def _row_cache_triplet(
    *,
    cache_read: int | None,
    cache_create: int | None,
    cache_miss: int | None,
    usage_json: Any,
) -> tuple[int, int, int]:
    read = max(0, int(cache_read or 0))
    create = max(0, int(cache_create or 0))
    miss = max(0, int(cache_miss or 0))
    if read or create or miss:
        return read, create, miss
    if not usage_json:
        return 0, 0, 0
    try:
        u = json.loads(usage_json) if isinstance(usage_json, str) else usage_json
        cache = cache_tokens_from_usage_payload(u)
    except (json.JSONDecodeError, TypeError, ValueError):
        return 0, 0, 0
    return (
        int(cache.get("cache_read_tokens") or 0),
        int(cache.get("cache_creation_tokens") or 0),
        int(cache.get("cache_miss_tokens") or 0),
    )


def cache_triplet_from_row(
    *,
    cache_read: int | None,
    cache_create: int | None,
    cache_miss: int | None,
    usage_json: Any,
) -> tuple[int, int, int]:
    return _row_cache_triplet(
        cache_read=cache_read,
        cache_create=cache_create,
        cache_miss=cache_miss,
        usage_json=usage_json,
    )


def enrich_model_row_cost(row: dict[str, Any]) -> None:
    """Attach ``estimated_cost_cny`` for observability list/detail rows."""
    prompt = int(row.get("usage_input_tokens") or row.get("prompt_tokens") or 0)
    completion = int(row.get("usage_output_tokens") or row.get("completion_tokens") or 0)
    read = int(row.get("usage_cache_read_tokens") or row.get("cache_read_tokens") or 0)
    miss = int(row.get("usage_cache_miss_tokens") or row.get("cache_miss_tokens") or 0)
    create = int(row.get("usage_cache_creation_tokens") or row.get("cache_creation_tokens") or 0)

    if prompt <= 0 and completion <= 0:
        raw = row.get("usage_json")
        if raw:
            try:
                from evoflow.observability.queries import (
                    cache_tokens_from_usage_payload,
                    token_triplet_from_usage_payload,
                )

                u = json.loads(raw) if isinstance(raw, str) else raw
                inp, out_t, _tot = token_triplet_from_usage_payload(u)
                prompt = int(inp or 0)
                completion = int(out_t or 0)
                cache = cache_tokens_from_usage_payload(u)
                if not read:
                    read = int(cache.get("cache_read_tokens") or 0)
                if not miss:
                    miss = int(cache.get("cache_miss_tokens") or 0)
                if not create:
                    create = int(cache.get("cache_creation_tokens") or 0)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

    if prompt <= 0 and completion <= 0:
        row["estimated_cost_cny"] = None
        return

    cost = estimate_row_request_cost_cny(
        prompt,
        completion,
        cache_read_tokens=read,
        cache_miss_tokens=miss,
        cache_creation_tokens=create,
        provider=str(row.get("provider") or ""),
        model=str(row.get("model") or ""),
    )
    row["estimated_cost_cny"] = cost if cost > 0 else None


def aggregate_cache_metrics(
    conn: sqlite3.Connection,
    *,
    where_sql: str,
    params: tuple[Any, ...],
) -> dict[str, Any]:
    """Sum cache tokens and estimate CNY savings using Aliyun / Volcengine list prices."""
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT model, provider, cache_read_tokens, cache_creation_tokens, cache_miss_tokens, usage_json
        FROM {T.MODEL_INVOCATIONS}{where_sql}
        """,
        params,
    ).fetchall()

    read = create = miss = 0
    savings_cny = 0.0
    total_cost_cny = 0.0
    priced_rows = 0
    platform_counts: dict[str, int] = {"aliyun": 0, "volcengine": 0}

    for row in rows:
        model = str(row[0] or "").strip()
        provider = str(row[1] or "").strip()
        r, c, m = _row_cache_triplet(
            cache_read=row[2],
            cache_create=row[3],
            cache_miss=row[4],
            usage_json=row[5],
        )
        read += r
        create += c
        miss += m
        prompt = completion = 0
        raw_usage = row[5]
        if raw_usage:
            try:
                from evoflow.observability.queries import token_triplet_from_usage_payload

                u = json.loads(raw_usage) if isinstance(raw_usage, str) else raw_usage
                inp, out_t, _tot = token_triplet_from_usage_payload(u)
                prompt = int(inp or 0)
                completion = int(out_t or 0)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        if prompt > 0 or completion > 0:
            total_cost_cny += estimate_row_request_cost_cny(
                prompt,
                completion,
                cache_read_tokens=r,
                cache_miss_tokens=m,
                cache_creation_tokens=c,
                provider=provider,
                model=model,
            )
        if r > 0:
            savings_cny += estimate_row_cache_savings_cny(r, provider=provider, model=model)
            priced_rows += 1
            platform_counts[detect_platform(provider, model)] += 1

    hit_rate = compute_cache_hit_rate(read, miss, create)
    dominant_platform = max(platform_counts, key=platform_counts.get) if priced_rows else "aliyun"
    sample_model = ""
    sample_provider = ""
    for row in rows:
        r, _, _ = _row_cache_triplet(
            cache_read=row[2], cache_create=row[3], cache_miss=row[4], usage_json=row[5]
        )
        if r > 0:
            sample_model = str(row[0] or "")
            sample_provider = str(row[1] or "")
            break

    pricing_note = pricing_platform_label(sample_provider, sample_model) if read > 0 else ""
    if priced_rows > 1 and platform_counts.get("aliyun", 0) and platform_counts.get("volcengine", 0):
        pricing_note = "阿里云百炼 + 火山方舟官网价（按模型加权）"

    ref_rule = resolve_cache_price(sample_provider, sample_model) if read > 0 else None
    ref_savings_per_mtok = savings_cny_per_mtok(ref_rule) if ref_rule else None
    cost_after_cache = round(total_cost_cny, 4) if total_cost_cny > 0 else None
    savings_rounded = round(savings_cny, 4) if savings_cny > 0 else None
    full_price = (
        round(total_cost_cny + savings_cny, 4)
        if (total_cost_cny > 0 or savings_cny > 0)
        else None
    )

    return {
        "cache_read_tokens": read,
        "cache_creation_tokens": create,
        "cache_miss_tokens": miss,
        "cache_hit_rate": hit_rate,
        "cache_hit_rate_pct": round(hit_rate * 100, 1) if hit_rate is not None else None,
        "estimated_total_cost_cny": cost_after_cache,
        "estimated_full_price_cny": full_price,
        "estimated_savings_cny": savings_rounded,
        "estimated_savings_usd": None,
        "pricing_note": pricing_note,
        "pricing_platform": dominant_platform if read > 0 else None,
        "reference_savings_cny_per_mtok": ref_savings_per_mtok,
    }
