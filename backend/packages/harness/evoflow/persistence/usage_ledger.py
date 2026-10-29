"""Unified usage / cost ledger (main app DB).

Append-only events + UTC-day rollup for settings「使用统计」.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Categories reserved for product metering (extend freely).
CATEGORY_LLM = "llm"
CATEGORY_MEDIA = "media"
CATEGORY_TOOL = "tool"
CATEGORY_EMBEDDING = "embedding"
CATEGORY_STORAGE = "storage"
CATEGORY_OTHER = "other"

UNIT_TOKEN = "token"
UNIT_REQUEST = "request"
UNIT_SECOND = "second"
UNIT_BYTE = "byte"
UNIT_CREDIT = "credit"

SUBCATEGORY_CHAT = "chat"
SUBCATEGORY_IMAGE = "image"
SUBCATEGORY_VIDEO = "video"
SUBCATEGORY_EMBED_INDEX = "index"
SUBCATEGORY_EMBED_QUERY = "query"
SUBCATEGORY_EMBED_OTHER = "other"

# Fallback USD estimates when the vendor does not return a billable amount.
# Tune via env later; keep conservative placeholders so calls are never silent.
_MEDIA_RATE_CARD_USD: dict[str, float] = {
    "image:jimeng": 0.02,
    "image:openai": 0.04,
    "image:wan": 0.03,
    "image:*": 0.03,
    "video:minimax": 0.12,  # ~5s baseline
    "video:jimeng": 0.15,
    "video:*": 0.15,
}

# Embedding USD per million input tokens (OpenAI-published ballparks + conservative *).
_EMBEDDING_RATE_USD_PER_MTOK: dict[str, float] = {
    "text-embedding-3-small": 0.02,
    "text-embedding-3-large": 0.13,
    "text-embedding-ada-002": 0.10,
    "*": 0.02,
}


def _day_utc(occurred_at: str) -> str:
    s = str(occurred_at or "").strip()
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return utc_now_iso_z()[:10]


def _f(v: Any, default: float = 0.0) -> float:
    try:
        return float(v if v is not None else default)
    except (TypeError, ValueError):
        return default


def _s(v: Any, default: str = "") -> str:
    return str(v if v is not None else default).strip() or default


def record_usage_event_in_txn(
    db: Any,
    *,
    event_id: str,
    category: str,
    unit: str,
    quantity: float = 0,
    quantity_in: float = 0,
    quantity_out: float = 0,
    subcategory: str = "",
    currency: str = "USD",
    amount: float = 0,
    pricing_source: str = "",
    provider: str = "",
    sku: str = "",
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    message_id: str | None = None,
    app_id: str | None = None,
    agent_code: str | None = None,
    workspace_id: str | None = None,
    subject_type: str = "install",
    subject_id: str = "",
    principal_id: str | None = None,
    occurred_at: str | None = None,
    meta: dict[str, Any] | None = None,
) -> bool:
    """Insert one event + upsert daily rollup. Returns False if event_id already exists."""
    eid = _s(event_id)
    cat = _s(category)
    un = _s(unit)
    if not eid or not cat or not un:
        return False

    qty = _f(quantity)
    qty_in = _f(quantity_in)
    qty_out = _f(quantity_out)
    if qty <= 0 and (qty_in or qty_out):
        qty = qty_in + qty_out
    if qty <= 0 and _f(amount) <= 0:
        return False

    now = utc_now_iso_z()
    occurred = _s(occurred_at) or now
    day = _day_utc(occurred)
    sub = _s(subcategory)
    sk = _s(sku)
    st = _s(subject_type, "install") or "install"
    sid = _s(subject_id)
    uid = _s(principal_id)
    amt = _f(amount)
    meta_json = json.dumps(meta if isinstance(meta, dict) else {}, ensure_ascii=False)

    existing = db.execute(
        "SELECT 1 FROM evoflow_usage_events WHERE event_id = ?",
        (eid,),
    ).fetchone()
    if existing:
        return False

    db.execute(
        """
        INSERT INTO evoflow_usage_events (
            event_id, occurred_at, category, subcategory, unit,
            quantity, quantity_in, quantity_out,
            currency, amount, pricing_source, provider, sku,
            session_key, thread_id, run_id, message_id, app_id, agent_code, workspace_id,
            subject_type, subject_id, principal_id, meta_json, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            eid,
            occurred,
            cat,
            sub,
            un,
            qty,
            qty_in,
            qty_out,
            _s(currency, "USD") or "USD",
            amt,
            _s(pricing_source),
            _s(provider),
            sk,
            _s(session_key) or None,
            _s(thread_id) or None,
            _s(run_id) or None,
            _s(message_id) or None,
            _s(app_id) or None,
            _s(agent_code) or None,
            _s(workspace_id) or None,
            st,
            sid,
            uid or None,
            meta_json,
            now,
        ),
    )

    db.execute(
        """
        INSERT INTO evoflow_usage_daily (
            day, category, subcategory, sku, subject_type, subject_id, principal_id,
            quantity_sum, quantity_in_sum, quantity_out_sum, amount_sum, event_count
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(day, category, subcategory, sku, subject_type, subject_id, principal_id) DO UPDATE SET
            quantity_sum = quantity_sum + excluded.quantity_sum,
            quantity_in_sum = quantity_in_sum + excluded.quantity_in_sum,
            quantity_out_sum = quantity_out_sum + excluded.quantity_out_sum,
            amount_sum = amount_sum + excluded.amount_sum,
            event_count = event_count + 1
        """,
        (day, cat, sub, sk, st, sid, uid, qty, qty_in, qty_out, amt),
    )
    return True


def record_usage_event(**kwargs: Any) -> bool:
    """Commit a single usage event (idempotent on event_id)."""

    def _write(db: Any) -> bool:
        return record_usage_event_in_txn(db, **kwargs)

    try:
        return run_db_transaction(_write)
    except Exception:
        logger.exception("record_usage_event failed event_id=%s", kwargs.get("event_id"))
        return False


def _resolve_model_sku(
    db: Any,
    *,
    model_name: str | None = None,
    session_key: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Prefer explicit model_name; fall back to session / thread flat columns."""
    name = _s(model_name)
    if name:
        return name
    sk = _s(session_key)
    if sk:
        row = db.execute(
            """
            SELECT COALESCE(NULLIF(model_name, ''), NULLIF(primary_model_name, ''))
            FROM evoflow_chat_sessions
            WHERE session_key = ? AND is_deleted = 0
            LIMIT 1
            """,
            (sk,),
        ).fetchone()
        if row and row[0]:
            return str(row[0]).strip()
    tid = _s(thread_id)
    if tid:
        row = db.execute(
            """
            SELECT COALESCE(NULLIF(model_name, ''), NULLIF(primary_model_name, ''))
            FROM evoflow_chat_sessions
            WHERE thread_id = ? AND is_deleted = 0
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (tid,),
        ).fetchone()
        if row and row[0]:
            return str(row[0]).strip()
    return ""


def record_llm_chat_usage_in_txn(
    db: Any,
    *,
    session_key: str,
    run_id: str | None = None,
    thread_id: str | None = None,
    message_id: str | None = None,
    model_name: str | None = None,
    provider: str | None = None,
    input_tokens: int | float = 0,
    output_tokens: int | float = 0,
    total_tokens: int | float = 0,
    app_id: str | None = None,
    agent_code: str | None = None,
    workspace_id: str | None = None,
    principal_id: str | None = None,
    occurred_at: str | None = None,
    meta: dict[str, Any] | None = None,
) -> bool:
    """Record one LLM chat turn.

    Idempotency is keyed on the real message id (``llm:msg:{message_id}``) so the
    same assistant message is never double-counted regardless of which write path
    (single append / batch append / rebuild) recorded it.
    """
    sk = _s(session_key)
    rid = _s(run_id)
    mid = _s(message_id)
    if mid:
        event_id = f"llm:msg:{mid}"
    elif rid:
        event_id = f"llm:{rid}:turn"
    elif sk:
        # Last resort — still unique per call if caller adds seq in meta; prefer message_id.
        event_id = f"llm:{sk}:{utc_now_iso_z()}"
    else:
        return False

    tot = _f(total_tokens)
    inp = _f(input_tokens)
    out = _f(output_tokens)
    if tot <= 0:
        tot = inp + out
    if tot <= 0:
        return False

    sku = _resolve_model_sku(
        db,
        model_name=model_name,
        session_key=sk,
        thread_id=thread_id,
    )

    price = _resolve_llm_price(sku)
    amt = (inp / 1_000_000.0) * price.get("input", 0.0) + (out / 1_000_000.0) * price.get("output", 0.0)

    return record_usage_event_in_txn(
        db,
        event_id=event_id,
        category=CATEGORY_LLM,
        subcategory=SUBCATEGORY_CHAT,
        unit=UNIT_TOKEN,
        quantity=tot,
        quantity_in=inp,
        quantity_out=out,
        sku=sku,
        provider=_s(provider),
        session_key=sk or None,
        thread_id=_s(thread_id) or None,
        run_id=rid or None,
        message_id=mid or None,
        app_id=_s(app_id) or None,
        agent_code=_s(agent_code) or None,
        workspace_id=_s(workspace_id) or None,
        principal_id=_s(principal_id) or None,
        occurred_at=occurred_at,
        amount=amt,
        pricing_source="config:token_usage.pricing" if amt > 0 else "",
        meta=meta,
    )


def _media_rate_usd(*, media_kind: str, provider: str, duration_seconds: float = 0) -> tuple[float, str]:
    """Return (amount_usd, pricing_source) from the built-in media rate card."""
    kind = _s(media_kind, "image") or "image"
    prov = _s(provider).lower() or "*"
    key = f"{kind}:{prov}"
    base = _MEDIA_RATE_CARD_USD.get(key)
    if base is None:
        base = _MEDIA_RATE_CARD_USD.get(f"{kind}:*", 0.0)
    amt = float(base or 0.0)
    if kind == "video" and duration_seconds and duration_seconds > 0:
        # Scale around a 5s baseline clip.
        amt = amt * (float(duration_seconds) / 5.0)
    if amt <= 0:
        return 0.0, ""
    return amt, "estimate:media_rate_card"


def record_media_generation_usage(
    *,
    media_kind: str,
    provider: str = "",
    model: str | None = None,
    mode: str | None = None,
    task_id: str | None = None,
    status: str = "succeeded",
    thread_id: str | None = None,
    session_key: str | None = None,
    run_id: str | None = None,
    app_id: str | None = None,
    agent_code: str | None = None,
    workspace_id: str | None = None,
    principal_id: str | None = None,
    aspect_ratio: str | None = None,
    duration_seconds: float | int | None = None,
    resolution: str | None = None,
    reference_count: int | None = None,
    prompt: str | None = None,
    remote_url: str | None = None,
    local_path: str | None = None,
    vendor_cost: float | None = None,
    vendor_currency: str | None = None,
    tool_name: str | None = None,
    occurred_at: str | None = None,
    meta: dict[str, Any] | None = None,
) -> bool:
    """Append one media (image/video) generation event to the product usage ledger.

    Shown in Settings → 使用统计 (category=media). Idempotent on ``task_id`` when present.
    Prefer vendor_cost when the provider returns a bill; otherwise estimate from rate card
    so successful calls are never silent zero-rows.
    """

    def _write(db: Any) -> bool:
        return record_media_generation_usage_in_txn(
            db,
            media_kind=media_kind,
            provider=provider,
            model=model,
            mode=mode,
            task_id=task_id,
            status=status,
            thread_id=thread_id,
            session_key=session_key,
            run_id=run_id,
            app_id=app_id,
            agent_code=agent_code,
            workspace_id=workspace_id,
            principal_id=principal_id,
            aspect_ratio=aspect_ratio,
            duration_seconds=duration_seconds,
            resolution=resolution,
            reference_count=reference_count,
            prompt=prompt,
            remote_url=remote_url,
            local_path=local_path,
            vendor_cost=vendor_cost,
            vendor_currency=vendor_currency,
            tool_name=tool_name,
            occurred_at=occurred_at,
            meta=meta,
        )

    try:
        return bool(run_db_transaction(_write))
    except Exception:
        logger.debug("record_media_generation_usage failed", exc_info=True)
        return False


def record_media_generation_usage_in_txn(
    db: Any,
    *,
    media_kind: str,
    provider: str = "",
    model: str | None = None,
    mode: str | None = None,
    task_id: str | None = None,
    status: str = "succeeded",
    thread_id: str | None = None,
    session_key: str | None = None,
    run_id: str | None = None,
    app_id: str | None = None,
    agent_code: str | None = None,
    workspace_id: str | None = None,
    principal_id: str | None = None,
    aspect_ratio: str | None = None,
    duration_seconds: float | int | None = None,
    resolution: str | None = None,
    reference_count: int | None = None,
    prompt: str | None = None,
    remote_url: str | None = None,
    local_path: str | None = None,
    vendor_cost: float | None = None,
    vendor_currency: str | None = None,
    tool_name: str | None = None,
    occurred_at: str | None = None,
    meta: dict[str, Any] | None = None,
) -> bool:
    kind = _s(media_kind).lower()
    if kind not in (SUBCATEGORY_IMAGE, SUBCATEGORY_VIDEO):
        kind = SUBCATEGORY_IMAGE if "image" in kind else (SUBCATEGORY_VIDEO if "video" in kind else "")
    if not kind:
        return False

    st = _s(status, "succeeded").lower() or "succeeded"
    tid = _s(task_id)
    sku = _s(model) or _s(provider) or kind
    prov = _s(provider)
    dur = _f(duration_seconds)
    refs = int(reference_count) if reference_count is not None else None

    if tid:
        event_id = f"media:{kind}:{tid}"
    else:
        # Sync / immediate paths without a stable vendor task id.
        stamp = _s(occurred_at) or utc_now_iso_z()
        event_id = f"media:{kind}:{sku}:{stamp}:{_s(thread_id) or 'local'}"

    vendor_amt = _f(vendor_cost) if vendor_cost is not None else 0.0
    currency = _s(vendor_currency, "USD") or "USD"
    pricing_source = ""
    amount = 0.0
    if vendor_amt > 0:
        amount = vendor_amt
        pricing_source = "vendor"
    elif st in ("succeeded", "success", "completed", "done"):
        amount, pricing_source = _media_rate_usd(media_kind=kind, provider=prov, duration_seconds=dur)

    # Always count the call (audit); amount may be 0 for failed/unpriced.
    quantity = 1.0
    unit = UNIT_REQUEST
    quantity_out = dur if kind == SUBCATEGORY_VIDEO and dur > 0 else 0.0

    remote = _s(remote_url) or None
    local = _s(local_path) or None
    result = None
    if remote and (remote.lower().startswith("http://") or remote.lower().startswith("https://")):
        result = remote
    elif local:
        result = local
    elif remote:
        result = remote
    detail: dict[str, Any] = {
        "media_kind": kind,
        "mode": _s(mode) or None,
        "model": _s(model) or None,
        "aspect_ratio": _s(aspect_ratio) or None,
        "duration_seconds": dur if dur > 0 else None,
        "resolution": _s(resolution) or None,
        "reference_count": refs,
        "prompt_chars": len(prompt) if isinstance(prompt, str) else None,
        "task_id": tid or None,
        "status": st,
        # Dedicated address fields (same semantics as evoflow_media_assets).
        "result_url": result,
        "remote_url": remote,
        "local_path": local,
        "tool_name": _s(tool_name) or None,
        "vendor_cost": vendor_amt if vendor_amt > 0 else None,
        "vendor_currency": currency if vendor_amt > 0 else None,
        "pricing_source": pricing_source or None,
        "asset_table": "evoflow_media_assets",
    }
    if isinstance(meta, dict) and meta:
        # Caller extras win only for keys we did not already set.
        for k, v in meta.items():
            if k not in detail or detail[k] is None:
                detail[k] = v
    # Drop nulls for compact meta_json
    detail = {k: v for k, v in detail.items() if v is not None}

    return record_usage_event_in_txn(
        db,
        event_id=event_id,
        category=CATEGORY_MEDIA,
        subcategory=kind,
        unit=unit,
        quantity=quantity,
        quantity_out=quantity_out,
        currency=currency if amount > 0 else "USD",
        amount=amount,
        pricing_source=pricing_source,
        provider=prov,
        sku=sku,
        session_key=_s(session_key) or None,
        thread_id=_s(thread_id) or None,
        run_id=_s(run_id) or None,
        app_id=_s(app_id) or None,
        agent_code=_s(agent_code) or None,
        workspace_id=_s(workspace_id) or None,
        principal_id=_s(principal_id) or None,
        occurred_at=occurred_at,
        meta=detail,
    )


def _embedding_rate_usd_per_token(sku: str) -> tuple[float, str]:
    """Return (usd_per_token, pricing_source) for an embedding model sku."""
    name = _s(sku)
    # Prefer app token_usage.pricing (same as chat) when the embedding model is listed.
    priced = _resolve_llm_price(name)
    if priced.get("input", 0.0) > 0:
        return float(priced["input"]), "config:token_usage.pricing"
    # Rate-card fallback so cloud embedding calls are never silent zero-cost.
    lower = name.lower()
    best_len = -1
    rate = 0.0
    for pattern, mtok in _EMBEDDING_RATE_USD_PER_MTOK.items():
        try:
            import fnmatch

            if pattern == "*" or fnmatch.fnmatch(lower, pattern.lower()) or pattern.lower() in lower:
                if len(pattern) >= best_len:
                    best_len = len(pattern)
                    rate = float(mtok)
        except Exception:
            continue
    if rate <= 0:
        rate = float(_EMBEDDING_RATE_USD_PER_MTOK.get("*", 0.02))
    return rate / 1_000_000.0, "estimate:embedding_rate_card"


def record_embedding_usage(
    *,
    model: str = "",
    provider: str = "",
    purpose: str = "",
    prompt_tokens: float | int = 0,
    input_count: int = 0,
    is_local: bool = False,
    kb_id: str | None = None,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    app_id: str | None = None,
    agent_code: str | None = None,
    workspace_id: str | None = None,
    principal_id: str | None = None,
    occurred_at: str | None = None,
    meta: dict[str, Any] | None = None,
) -> bool:
    """Append one embedding (vector) API / local encode event to the usage ledger.

    Shown in Settings → 使用统计 (category=embedding). Covers KB index + retrieval
    query embeds and any other caller that goes through the embedding providers.
    Local encodes are audited (tokens estimated) with amount=0.
    """

    def _write(db: Any) -> bool:
        return record_embedding_usage_in_txn(
            db,
            model=model,
            provider=provider,
            purpose=purpose,
            prompt_tokens=prompt_tokens,
            input_count=input_count,
            is_local=is_local,
            kb_id=kb_id,
            session_key=session_key,
            thread_id=thread_id,
            run_id=run_id,
            app_id=app_id,
            agent_code=agent_code,
            workspace_id=workspace_id,
            principal_id=principal_id,
            occurred_at=occurred_at,
            meta=meta,
        )

    try:
        return bool(run_db_transaction(_write))
    except Exception:
        logger.debug("record_embedding_usage failed", exc_info=True)
        return False


def record_embedding_usage_in_txn(
    db: Any,
    *,
    model: str = "",
    provider: str = "",
    purpose: str = "",
    prompt_tokens: float | int = 0,
    input_count: int = 0,
    is_local: bool = False,
    kb_id: str | None = None,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    app_id: str | None = None,
    agent_code: str | None = None,
    workspace_id: str | None = None,
    principal_id: str | None = None,
    occurred_at: str | None = None,
    meta: dict[str, Any] | None = None,
) -> bool:
    import uuid

    purpose_raw = _s(purpose).lower() or SUBCATEGORY_EMBED_OTHER
    if purpose_raw in ("index", "embed_index", "indexing"):
        sub = SUBCATEGORY_EMBED_INDEX
    elif purpose_raw in ("query", "retrieve", "retrieval", "search"):
        sub = SUBCATEGORY_EMBED_QUERY
    elif purpose_raw in ("probe", "detect", "warmup"):
        # Health / dimension probes — do not pollute the fee ledger.
        return False
    else:
        sub = SUBCATEGORY_EMBED_OTHER

    sku = _s(model) or _s(provider) or "embedding"
    prov = _s(provider) or ("local" if is_local else "")
    tokens = _f(prompt_tokens)
    n_in = int(input_count or 0)
    if tokens <= 0 and n_in > 0:
        # No vendor usage field — keep a positive quantity so the call is visible.
        tokens = float(max(1, n_in))
    if tokens <= 0:
        return False

    stamp = _s(occurred_at) or utc_now_iso_z()
    event_id = f"embedding:{sub}:{uuid.uuid4().hex}"

    amount = 0.0
    pricing_source = ""
    if not is_local:
        per_tok, pricing_source = _embedding_rate_usd_per_token(sku)
        amount = tokens * per_tok

    detail: dict[str, Any] = {
        "purpose": sub,
        "model": _s(model) or None,
        "provider": prov or None,
        "prompt_tokens": tokens,
        "input_count": n_in if n_in > 0 else None,
        "is_local": bool(is_local),
        "kb_id": _s(kb_id) or None,
        "pricing_source": pricing_source or None,
    }
    if isinstance(meta, dict) and meta:
        for k, v in meta.items():
            if k not in detail or detail[k] is None:
                detail[k] = v
    detail = {k: v for k, v in detail.items() if v is not None}

    return record_usage_event_in_txn(
        db,
        event_id=event_id,
        category=CATEGORY_EMBEDDING,
        subcategory=sub,
        unit=UNIT_TOKEN,
        quantity=tokens,
        quantity_in=tokens,
        currency="USD",
        amount=amount,
        pricing_source=pricing_source,
        provider=prov,
        sku=sku,
        session_key=_s(session_key) or None,
        thread_id=_s(thread_id) or None,
        run_id=_s(run_id) or None,
        app_id=_s(app_id) or None,
        agent_code=_s(agent_code) or None,
        workspace_id=_s(workspace_id) or None,
        subject_type="kb" if _s(kb_id) else "install",
        subject_id=_s(kb_id),
        principal_id=_s(principal_id) or None,
        occurred_at=stamp,
        meta=detail,
    )


_PRICE_CACHE: dict[str, Any] = {"stamp": None, "map": None}


def _resolve_llm_price(sku: str | None) -> dict[str, float]:
    """Resolve {input, output} USD-per-token price for a model sku from app config.

    Returns {} entries as 0.0 when unpriced. Cached per config object identity.
    """
    try:
        from evoflow.config.app_config import get_app_config

        cfg = get_app_config()
        tu = getattr(cfg, "token_usage", None)
        pricing = getattr(tu, "pricing", None) if tu else None
    except Exception:
        return {"input": 0.0, "output": 0.0}
    if not pricing:
        return {"input": 0.0, "output": 0.0}
    key = str(id(pricing))
    if _PRICE_CACHE["stamp"] != key:
        # snapshot to plain globs → (in, out) per MTok
        snap: list[tuple[str, float, float]] = []
        try:
            for pattern, p in dict(pricing).items():
                snap.append(
                    (
                        str(pattern),
                        float(getattr(p, "input_per_mtok", 0.0) or 0.0),
                        float(getattr(p, "output_per_mtok", 0.0) or 0.0),
                    )
                )
        except Exception:
            snap = []
        _PRICE_CACHE["stamp"] = key
        _PRICE_CACHE["map"] = snap
    name = _s(sku)
    best_len = -1
    in_mtok = out_mtok = 0.0
    for pattern, pin, pout in _PRICE_CACHE["map"] or []:
        try:
            import fnmatch

            if not pattern or not (pattern == name or fnmatch.fnmatch(name.lower(), pattern.lower())):
                continue
        except Exception:
            continue
        if len(pattern) >= best_len:
            best_len = len(pattern)
            in_mtok, out_mtok = pin, pout
    return {"input": in_mtok / 1_000_000.0, "output": out_mtok / 1_000_000.0}


def _parse_range(from_day: str | None, to_day: str | None, *, default_days: int = 30) -> tuple[str, str]:
    today = utc_now_iso_z()[:10]
    end = _s(to_day) or today
    if len(end) < 10:
        end = today
    end = end[:10]
    start = _s(from_day)
    if len(start) >= 10:
        start = start[:10]
    else:
        # default_days inclusive window ending at ``end``
        from datetime import date, timedelta

        try:
            end_d = date.fromisoformat(end)
        except ValueError:
            end_d = date.fromisoformat(today)
            end = today
        start = (end_d - timedelta(days=max(0, int(default_days) - 1))).isoformat()
    return start, end


def fetch_usage_summary(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = None,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    """Usage summary. ``principal_id=None`` + ``include_orphan=True`` = all rows (legacy).
    ``principal_id=<pid>`` + ``include_orphan=False`` = that principal's rows only.
    """
    start, end = _parse_range(from_day, to_day)
    cat = _s(category)
    uid = _s(principal_id)
    ensure_llm_ledger_rebuilt()
    db = get_db()
    where = "day >= ? AND day <= ?"
    params: list[Any] = [start, end]
    if cat:
        where += " AND category = ?"
        params.append(cat)
    if uid:
        where += " AND principal_id = ?"
        params.append(uid)
    elif not include_orphan:
        where += " AND principal_id IS NOT NULL AND principal_id != ''"
    else:
        # include_orphan with no uid = all rows (nothing extra to filter)
        pass

    row = db.execute(
        f"""
        SELECT
            COALESCE(SUM(quantity_sum), 0),
            COALESCE(SUM(quantity_in_sum), 0),
            COALESCE(SUM(quantity_out_sum), 0),
            COALESCE(SUM(amount_sum), 0),
            COALESCE(SUM(event_count), 0)
        FROM evoflow_usage_daily
        WHERE {where}
        """,
        params,
    ).fetchone()

    llm_where = "day >= ? AND day <= ? AND category = ?"
    llm_params: list[Any] = [start, end, CATEGORY_LLM]
    if uid:
        llm_where += " AND principal_id = ?"
        llm_params.append(uid)
    elif not include_orphan:
        llm_where += " AND principal_id IS NOT NULL AND principal_id != ''"

    # Peak day tracks the "Token 总量" metric (llm only) — mixing tool/media
    # request counts into a token figure is meaningless.
    peak = db.execute(
        f"""
        SELECT day, SUM(quantity_sum) AS q
        FROM evoflow_usage_daily
        WHERE {llm_where}
        GROUP BY day
        ORDER BY q DESC
        LIMIT 1
        """,
        llm_params,
    ).fetchone()

    llm_row = db.execute(
        f"""
        SELECT COALESCE(SUM(quantity_sum), 0), COALESCE(SUM(event_count), 0)
        FROM evoflow_usage_daily
        WHERE {llm_where}
        """,
        llm_params,
    ).fetchone()

    return {
        "from": start,
        "to": end,
        "day_basis": "utc",
        "quantity_sum": _f(row[0] if row else 0),
        "quantity_in_sum": _f(row[1] if row else 0),
        "quantity_out_sum": _f(row[2] if row else 0),
        "amount_sum": _f(row[3] if row else 0),
        "event_count": int(row[4] or 0) if row else 0,
        "llm_token_sum": _f(llm_row[0] if llm_row else 0),
        "llm_event_count": int(llm_row[1] or 0) if llm_row else 0,
        "peak_day": str(peak[0]) if peak and peak[0] else None,
        "peak_quantity": _f(peak[1] if peak else 0),
    }


_LLM_LEDGER_REBUILD_MARKER = "llm_ledger_rebuild_v2_msgkey"
_rebuild_checked = False


def ensure_llm_ledger_rebuilt() -> None:
    """One-time (per install) rebuild of the llm ledger from chat messages.

    The legacy write path keyed batch rollups on ``llm:{run_id}:batch:{count}``,
    which collided across model steps in one run and silently dropped usage.
    Events are now keyed ``llm:msg:{message_id}``; this backfills history from
    ``evoflow_chat_messages`` (the source of truth) exactly once, guarded by a
    marker row so it never re-runs or double-counts.
    """
    global _rebuild_checked
    if _rebuild_checked:
        return
    _rebuild_checked = True

    def _check(db: Any) -> None:
        db.execute(
            "CREATE TABLE IF NOT EXISTS evoflow_usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        row = db.execute(
            "SELECT value FROM evoflow_usage_meta WHERE key = ?",
            (_LLM_LEDGER_REBUILD_MARKER,),
        ).fetchone()
        if row:
            return
        result = rebuild_llm_usage_ledger(db)
        db.execute(
            "INSERT OR REPLACE INTO evoflow_usage_meta (key, value) VALUES (?, ?)",
            (_LLM_LEDGER_REBUILD_MARKER, utc_now_iso_z()),
        )
        logger.info("usage ledger rebuilt from chat messages: %s", result)

    try:
        run_db_transaction(_check)
    except Exception:
        logger.exception("ensure_llm_ledger_rebuilt failed")


def rebuild_llm_usage_ledger(db: Any | None = None) -> dict[str, Any]:
    """Rebuild all llm usage events + daily rollup from ``evoflow_chat_messages``.

    One event per assistant message that carries tokens, keyed ``llm:msg:{message_id}``
    (or ``llm:row:{session_key}:{seq}`` when the message id is missing). Amount is
    priced from ``token_usage.pricing`` config.
    """

    def _rebuild(conn: Any) -> dict[str, Any]:
        if not conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_usage_events'"
        ).fetchone():
            return {"ok": False, "reason": "no_table"}

        events_before = conn.execute(
            "SELECT COUNT(*) FROM evoflow_usage_events WHERE category = ?", (CATEGORY_LLM,)
        ).fetchone()
        conn.execute("DELETE FROM evoflow_usage_events WHERE category = ?", (CATEGORY_LLM,))
        conn.execute("DELETE FROM evoflow_usage_daily WHERE category = ?", (CATEGORY_LLM,))

        has_created_by = bool(
            conn.execute(
                "SELECT 1 FROM pragma_table_info('evoflow_chat_sessions') WHERE name='created_by'"
            ).fetchone()
        )
        owner_select = "s.created_by" if has_created_by else "NULL"
        rows = conn.execute(
            f"""
            SELECT m.session_key, m.seq, m.message_id, m.run_id, m.thread_id,
                   m.model_name, m.input_tokens, m.output_tokens, m.total_tokens,
                   m.created_at, {owner_select}
            FROM evoflow_chat_messages m
            LEFT JOIN evoflow_chat_sessions s ON s.session_key = m.session_key
            WHERE m.role = 'assistant'
              AND COALESCE(m.total_tokens, 0) > 0
            """
        ).fetchall()

        price_cache: dict[str, tuple[float, float]] = {}
        now = utc_now_iso_z()
        batch: list[tuple[Any, ...]] = []
        for r in rows:
            sk, seq, mid, rid, tid, model, inp, outp, tot, created, owner = r
            inp = _f(inp)
            outp = _f(outp)
            tot = _f(tot) or (inp + outp)
            if tot <= 0:
                continue
            sku = _s(model)
            if not sku:
                sku = _resolve_model_sku(conn, session_key=sk, thread_id=tid)
            if sku not in price_cache:
                price = _resolve_llm_price(sku)
                price_cache[sku] = (price.get("input", 0.0), price.get("output", 0.0))
            pin, pout = price_cache[sku]
            amt = (inp / 1_000_000.0) * pin + (outp / 1_000_000.0) * pout
            eid = f"llm:msg:{_s(mid)}" if _s(mid) else f"llm:row:{sk}:{int(seq or 0)}"
            batch.append(
                (
                    eid,
                    _s(created) or now,
                    CATEGORY_LLM,
                    SUBCATEGORY_CHAT,
                    UNIT_TOKEN,
                    tot,
                    inp,
                    outp,
                    "USD",
                    amt,
                    "config:token_usage.pricing" if amt > 0 else "",
                    "",
                    sku,
                    sk,
                    tid,
                    rid,
                    mid,
                    None,
                    None,
                    None,
                    "install",
                    "",
                    _s(owner) or None,
                    "{}",
                    now,
                )
            )

        conn.executemany(
            """
            INSERT OR IGNORE INTO evoflow_usage_events (
                event_id, occurred_at, category, subcategory, unit,
                quantity, quantity_in, quantity_out,
                currency, amount, pricing_source, provider, sku,
                session_key, thread_id, run_id, message_id, app_id, agent_code, workspace_id,
                subject_type, subject_id, principal_id, meta_json, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            batch,
        )

        conn.execute(
            """
            INSERT INTO evoflow_usage_daily (
                day, category, subcategory, sku, subject_type, subject_id, principal_id,
                quantity_sum, quantity_in_sum, quantity_out_sum, amount_sum, event_count
            )
            SELECT
                substr(occurred_at, 1, 10) AS day,
                category,
                COALESCE(subcategory, ''),
                COALESCE(sku, ''),
                'install',
                '',
                COALESCE(principal_id, ''),
                SUM(quantity), SUM(quantity_in), SUM(quantity_out), SUM(amount), COUNT(*)
            FROM evoflow_usage_events
            WHERE category = ?
            GROUP BY day, category, COALESCE(subcategory, ''), COALESCE(sku, ''),
                     principal_id
            """,
            (CATEGORY_LLM,),
        )

        return {"ok": True, "events": len(batch), "events_before": int(events_before[0] or 0)}

    if db is not None:
        return _rebuild(db)
    return run_db_transaction(_rebuild)


def _usage_where(
    base_where: str,
    base_params: list[Any],
    *,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> tuple[str, list[Any]]:
    """Append principal_id scoping to a usage query.

    ``principal_id=<pid>`` restricts to that principal. With ``include_orphan=True`` and no
    uid, all rows pass (legacy). ``include_orphan=False`` with no uid keeps only
    attributed rows (admin full view handled by passing no uid + True).
    """
    uid = _s(principal_id)
    params = list(base_params)
    where = base_where
    if uid:
        where += " AND principal_id = ?"
        params.append(uid)
    elif not include_orphan:
        where += " AND principal_id IS NOT NULL AND principal_id != ''"
    return where, params


def fetch_usage_daily(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = None,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    start, end = _parse_range(from_day, to_day)
    cat = _s(category)
    db = get_db()
    where = "day >= ? AND day <= ?"
    params: list[Any] = [start, end]
    if cat:
        where += " AND category = ?"
        params.append(cat)
    where, params = _usage_where(where, params, principal_id=principal_id, include_orphan=include_orphan)

    rows = db.execute(
        f"""
        SELECT day,
               SUM(quantity_sum) AS quantity_sum,
               SUM(quantity_in_sum) AS quantity_in_sum,
               SUM(quantity_out_sum) AS quantity_out_sum,
               SUM(amount_sum) AS amount_sum,
               SUM(event_count) AS event_count
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY day
        ORDER BY day ASC
        """,
        params,
    ).fetchall()

    days = [
        {
            "day": str(r[0]),
            "quantity_sum": _f(r[1]),
            "quantity_in_sum": _f(r[2]),
            "quantity_out_sum": _f(r[3]),
            "amount_sum": _f(r[4]),
            "event_count": int(r[5] or 0),
        }
        for r in rows
    ]
    return {"from": start, "to": end, "day_basis": "utc", "category": cat or None, "days": days}


def fetch_usage_daily_by_sku(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = CATEGORY_LLM,
    top_n: int = 8,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    """Multi-series daily trend for top SKUs (settings dashboard line chart)."""
    start, end = _parse_range(from_day, to_day)
    cat = _s(category) or CATEGORY_LLM
    lim = max(1, min(int(top_n or 8), 20))
    db = get_db()

    top_where, top_params = _usage_where(
        "day >= ? AND day <= ? AND category = ?",
        [start, end, cat],
        principal_id=principal_id,
        include_orphan=include_orphan,
    )
    top_rows = db.execute(
        f"""
        SELECT sku, SUM(quantity_sum) AS q
        FROM evoflow_usage_daily
        WHERE {top_where}
        GROUP BY sku
        ORDER BY q DESC
        LIMIT ?
        """,
        (*top_params, lim),
    ).fetchall()
    skus = [str(r[0] or "") or "(unknown)" for r in top_rows]
    if not skus:
        return {
            "from": start,
            "to": end,
            "day_basis": "utc",
            "category": cat,
            "skus": [],
            "days": [],
            "series": [],
        }

    placeholders = ",".join("?" for _ in skus)
    # Map empty sku in DB to "(unknown)" for consistency with by-sku
    rows_where, rows_params = _usage_where(
        "day >= ? AND day <= ? AND category = ?",
        [start, end, cat],
        principal_id=principal_id,
        include_orphan=include_orphan,
    )
    rows = db.execute(
        f"""
        SELECT day,
               CASE WHEN sku IS NULL OR sku = '' THEN '(unknown)' ELSE sku END AS sku_key,
               SUM(quantity_sum) AS quantity_sum
        FROM evoflow_usage_daily
        WHERE {rows_where}
          AND (CASE WHEN sku IS NULL OR sku = '' THEN '(unknown)' ELSE sku END) IN ({placeholders})
        GROUP BY day, sku_key
        ORDER BY day ASC
        """,
        (*rows_params, *skus),
    ).fetchall()

    from datetime import date, timedelta

    try:
        start_d = date.fromisoformat(start)
        end_d = date.fromisoformat(end)
    except ValueError:
        start_d = date.fromisoformat(utc_now_iso_z()[:10])
        end_d = start_d

    day_list: list[str] = []
    cur = start_d
    while cur <= end_d:
        day_list.append(cur.isoformat())
        cur += timedelta(days=1)

    grid: dict[str, dict[str, float]] = {d: {s: 0.0 for s in skus} for d in day_list}
    for day, sku_key, qty in rows:
        d = str(day)
        s = str(sku_key or "") or "(unknown)"
        if d in grid and s in grid[d]:
            grid[d][s] = _f(qty)

    series = [
        {
            "sku": sku,
            "points": [{"day": d, "quantity_sum": grid[d][sku]} for d in day_list],
        }
        for sku in skus
    ]
    return {
        "from": start,
        "to": end,
        "day_basis": "utc",
        "category": cat,
        "skus": skus,
        "days": day_list,
        "series": series,
    }


def fetch_usage_by_category(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    start, end = _parse_range(from_day, to_day)
    db = get_db()
    where, params = _usage_where(
        "day >= ? AND day <= ?",
        [start, end],
        principal_id=principal_id,
        include_orphan=include_orphan,
    )
    rows = db.execute(
        f"""
        SELECT category,
               SUM(quantity_sum), SUM(amount_sum), SUM(event_count)
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY category
        ORDER BY SUM(quantity_sum) DESC
        """,
        params,
    ).fetchall()
    items = [
        {
            "category": str(r[0]),
            "quantity_sum": _f(r[1]),
            "amount_sum": _f(r[2]),
            "event_count": int(r[3] or 0),
        }
        for r in rows
    ]
    return {"from": start, "to": end, "day_basis": "utc", "items": items}


def fetch_usage_daily_breakdown(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    """Per-UTC-day pivot for Settings → 使用统计 daily table.

    Columns: chat tokens/calls, image/video call counts, embedding tokens/calls, cost.
    Empty days in the inclusive range are filled with zeros (newest day first).
    """
    from datetime import date, timedelta

    start, end = _parse_range(from_day, to_day)
    db = get_db()
    where, params = _usage_where(
        "day >= ? AND day <= ?",
        [start, end],
        principal_id=principal_id,
        include_orphan=include_orphan,
    )
    rows = db.execute(
        f"""
        SELECT day, category, subcategory,
               SUM(quantity_sum), SUM(amount_sum), SUM(event_count)
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY day, category, subcategory
        ORDER BY day ASC
        """,
        params,
    ).fetchall()

    by_day: dict[str, dict[str, Any]] = {}

    def _slot(day: str) -> dict[str, Any]:
        slot = by_day.get(day)
        if slot is None:
            slot = {
                "day": day,
                "llm_tokens": 0.0,
                "llm_calls": 0,
                "llm_amount": 0.0,
                "image_calls": 0,
                "image_amount": 0.0,
                "video_calls": 0,
                "video_amount": 0.0,
                "embed_tokens": 0.0,
                "embed_calls": 0,
                "embed_amount": 0.0,
                "amount_sum": 0.0,
                "event_count": 0,
            }
            by_day[day] = slot
        return slot

    for r in rows:
        day = str(r[0] or "")[:10]
        if not day:
            continue
        cat = _s(r[1]).lower()
        sub = _s(r[2]).lower()
        qty = _f(r[3])
        amt = _f(r[4])
        ev = int(r[5] or 0)
        slot = _slot(day)
        slot["amount_sum"] = _f(slot["amount_sum"]) + amt
        slot["event_count"] = int(slot["event_count"] or 0) + ev
        if cat == CATEGORY_LLM:
            slot["llm_tokens"] = _f(slot["llm_tokens"]) + qty
            slot["llm_calls"] = int(slot["llm_calls"] or 0) + ev
            slot["llm_amount"] = _f(slot["llm_amount"]) + amt
        elif cat == CATEGORY_MEDIA:
            if sub == SUBCATEGORY_VIDEO or "video" in sub:
                slot["video_calls"] = int(slot["video_calls"] or 0) + ev
                slot["video_amount"] = _f(slot["video_amount"]) + amt
            else:
                slot["image_calls"] = int(slot["image_calls"] or 0) + ev
                slot["image_amount"] = _f(slot["image_amount"]) + amt
        elif cat == CATEGORY_EMBEDDING:
            slot["embed_tokens"] = _f(slot["embed_tokens"]) + qty
            slot["embed_calls"] = int(slot["embed_calls"] or 0) + ev
            slot["embed_amount"] = _f(slot["embed_amount"]) + amt

    try:
        start_d = date.fromisoformat(start)
        end_d = date.fromisoformat(end)
    except ValueError:
        start_d = end_d = date.fromisoformat(utc_now_iso_z()[:10])

    days_out: list[dict[str, Any]] = []
    cur = end_d
    # Cap fill to 93 days to avoid pathological ranges.
    filled = 0
    while cur >= start_d and filled < 93:
        key = cur.isoformat()
        days_out.append(_slot(key))
        cur -= timedelta(days=1)
        filled += 1

    return {"from": start, "to": end, "day_basis": "utc", "days": days_out}


def fetch_usage_by_sku(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = CATEGORY_LLM,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    start, end = _parse_range(from_day, to_day)
    cat = _s(category)
    db = get_db()
    where = "day >= ? AND day <= ?"
    params: list[Any] = [start, end]
    if cat:
        where += " AND category = ?"
        params.append(cat)
    where, params = _usage_where(where, params, principal_id=principal_id, include_orphan=include_orphan)

    rows = db.execute(
        f"""
        SELECT sku,
               SUM(quantity_sum), SUM(quantity_in_sum), SUM(quantity_out_sum),
               SUM(amount_sum), SUM(event_count)
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY sku
        ORDER BY SUM(quantity_sum) DESC
        LIMIT 50
        """,
        params,
    ).fetchall()
    items = [
        {
            "sku": str(r[0] or "") or "(unknown)",
            "quantity_sum": _f(r[1]),
            "quantity_in_sum": _f(r[2]),
            "quantity_out_sum": _f(r[3]),
            "amount_sum": _f(r[4]),
            "event_count": int(r[5] or 0),
        }
        for r in rows
    ]
    return {"from": start, "to": end, "day_basis": "utc", "category": cat or None, "items": items}


def fetch_usage_by_principal(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """Admin rollup: usage grouped by ``principal_id`` (displayName preferred).

    Orphan / unattributed rows appear as ``principal_id=null`` with label 「未归属」.
    """
    start, end = _parse_range(from_day, to_day)
    cat = _s(category)
    lim = max(1, min(int(limit or 100), 500))
    db = get_db()
    where = "day >= ? AND day <= ?"
    params: list[Any] = [start, end]
    if cat:
        where += " AND category = ?"
        params.append(cat)

    has_pid = bool(db.execute("SELECT 1 FROM pragma_table_info('evoflow_usage_daily') WHERE name='principal_id'").fetchone())
    if not has_pid:
        return {
            "from": start,
            "to": end,
            "day_basis": "utc",
            "category": cat or None,
            "items": [],
        }

    rows = db.execute(
        f"""
        SELECT COALESCE(NULLIF(TRIM(principal_id), ''), '') AS pid,
               SUM(quantity_sum), SUM(quantity_in_sum), SUM(quantity_out_sum),
               SUM(amount_sum), SUM(event_count)
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY COALESCE(NULLIF(TRIM(principal_id), ''), '')
        ORDER BY SUM(amount_sum) DESC, SUM(quantity_sum) DESC
        LIMIT ?
        """,
        (*params, lim),
    ).fetchall()

    names: dict[str, str] = {}
    try:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_principals'").fetchone():
            for pr in db.execute("SELECT principal_id, display_name FROM evoflow_principals").fetchall():
                pid = str(pr[0] or "").strip()
                dn = str(pr[1] or "").strip()
                if pid and dn:
                    names[pid] = dn
    except Exception:
        names = {}

    proactive_by_pid: dict[str, float] = {}
    try:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_proactive_cost_log'").fetchone() and db.execute("SELECT 1 FROM pragma_table_info('evoflow_proactive_cost_log') WHERE name='principal_id'").fetchone():
            prow = db.execute(
                """
                SELECT COALESCE(NULLIF(TRIM(principal_id), ''), '') AS pid,
                       COALESCE(SUM(cost_usd), 0)
                FROM evoflow_proactive_cost_log
                WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
                GROUP BY COALESCE(NULLIF(TRIM(principal_id), ''), '')
                """,
                (start, end),
            ).fetchall()
            for r in prow:
                proactive_by_pid[str(r[0] or "")] = _f(r[1])
    except Exception:
        proactive_by_pid = {}

    items: list[dict[str, Any]] = []
    for r in rows:
        pid = str(r[0] or "").strip()
        amount = _f(r[4])
        proactive = proactive_by_pid.pop(pid, 0.0) if proactive_by_pid else 0.0
        label = names.get(pid) if pid else "未归属"
        if pid and not label:
            label = pid
        items.append(
            {
                "principal_id": pid or None,
                "display_name": names.get(pid) if pid else None,
                "label": label,
                "quantity_sum": _f(r[1]),
                "quantity_in_sum": _f(r[2]),
                "quantity_out_sum": _f(r[3]),
                "amount_sum": amount,
                "event_count": int(r[5] or 0),
                "proactive_cost_usd": proactive,
                "total_amount_sum": round(amount + proactive, 6),
            }
        )
    for pid, proactive in sorted(proactive_by_pid.items(), key=lambda x: -x[1]):
        if proactive <= 0:
            continue
        label = names.get(pid) if pid else "未归属"
        if pid and not label:
            label = pid
        items.append(
            {
                "principal_id": pid or None,
                "display_name": names.get(pid) if pid else None,
                "label": label,
                "quantity_sum": 0.0,
                "quantity_in_sum": 0.0,
                "quantity_out_sum": 0.0,
                "amount_sum": 0.0,
                "event_count": 0,
                "proactive_cost_usd": proactive,
                "total_amount_sum": proactive,
            }
        )
    items.sort(key=lambda x: (-float(x.get("total_amount_sum") or 0), -float(x.get("quantity_sum") or 0)))

    return {
        "from": start,
        "to": end,
        "day_basis": "utc",
        "category": cat or None,
        "items": items,
    }


def heal_empty_llm_skus(db: Any | None = None) -> dict[str, Any]:
    """Backfill empty llm event sku from session model columns; rebuild llm daily rollup."""

    def _heal(conn: Any) -> dict[str, Any]:
        if not conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_usage_events'").fetchone():
            return {"ok": False, "reason": "no_table", "updated_events": 0}

        before = conn.execute(
            """
            SELECT COUNT(*) FROM evoflow_usage_events
            WHERE category = 'llm' AND (sku IS NULL OR sku = '')
            """
        ).fetchone()
        empty_n = int(before[0] or 0) if before else 0
        if empty_n <= 0:
            return {"ok": True, "updated_events": 0, "rebuilt_daily": False}

        conn.execute(
            """
            UPDATE evoflow_usage_events
            SET sku = COALESCE((
                SELECT COALESCE(NULLIF(s.model_name, ''), NULLIF(s.primary_model_name, ''))
                FROM evoflow_chat_sessions s
                WHERE s.session_key = evoflow_usage_events.session_key
                  AND s.is_deleted = 0
                LIMIT 1
            ), '')
            WHERE category = 'llm'
              AND (sku IS NULL OR sku = '')
              AND session_key IS NOT NULL
              AND session_key != ''
            """
        )
        conn.execute(
            """
            UPDATE evoflow_usage_events
            SET sku = COALESCE((
                SELECT COALESCE(NULLIF(s.model_name, ''), NULLIF(s.primary_model_name, ''))
                FROM evoflow_chat_sessions s
                WHERE s.thread_id = evoflow_usage_events.thread_id
                  AND s.is_deleted = 0
                ORDER BY s.updated_at DESC
                LIMIT 1
            ), sku)
            WHERE category = 'llm'
              AND (sku IS NULL OR sku = '')
              AND thread_id IS NOT NULL
              AND thread_id != ''
            """
        )

        after = conn.execute(
            """
            SELECT COUNT(*) FROM evoflow_usage_events
            WHERE category = 'llm' AND (sku IS NULL OR sku = '')
            """
        ).fetchone()
        still_empty = int(after[0] or 0) if after else 0
        updated = max(0, empty_n - still_empty)

        # Rebuild llm daily from events so empty-sku buckets move to real model names.
        conn.execute("DELETE FROM evoflow_usage_daily WHERE category = ?", (CATEGORY_LLM,))
        conn.execute(
            """
            INSERT INTO evoflow_usage_daily (
                day, category, subcategory, sku, subject_type, subject_id,
                quantity_sum, quantity_in_sum, quantity_out_sum, amount_sum, event_count
            )
            SELECT
                substr(occurred_at, 1, 10) AS day,
                category,
                COALESCE(subcategory, ''),
                COALESCE(sku, ''),
                COALESCE(subject_type, 'install'),
                COALESCE(subject_id, ''),
                SUM(quantity),
                SUM(quantity_in),
                SUM(quantity_out),
                SUM(amount),
                COUNT(*)
            FROM evoflow_usage_events
            WHERE category = ?
            GROUP BY day, category, COALESCE(subcategory, ''), COALESCE(sku, ''),
                     COALESCE(subject_type, 'install'), COALESCE(subject_id, '')
            """,
            (CATEGORY_LLM,),
        )
        return {
            "ok": True,
            "updated_events": updated,
            "still_empty": still_empty,
            "rebuilt_daily": True,
        }

    if db is not None:
        return _heal(db)
    return run_db_transaction(_heal)
