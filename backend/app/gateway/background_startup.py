"""Gateway background startup — runs after early lifespan yield."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI

from app.gateway.config import get_gateway_config
from evoflow.config.app_config import get_app_config

logger = logging.getLogger(__name__)

StLogFn = Callable[[str], None]


def init_startup_state(app: FastAPI) -> None:
    app.state.startup_ready = False
    app.state.routers_registered = False
    app.state.extended_routers_registered = False
    app.state.startup_phase = "booting"
    app.state.startup_error = None
    app.state.startup_ready_event = asyncio.Event()
    app.state.startup_background_tasks: list[asyncio.Task] = []
    app.state.startup_schedulers = {
        "retention": {"stop": None, "task": None},
        "automation": {"stop": None, "task": None},
        "task_queue": {"stop": None, "task": None},
        "zombie_sweeper": {"stop": None, "task": None},
    }


def is_startup_ready(app: FastAPI) -> bool:
    return bool(getattr(app.state, "startup_ready", False))


def resolve_local_embedding_warmup_target() -> tuple[str | None, str | None]:
    """Return ``(skip_reason, model_id)``. When *skip_reason* is set, do not warmup.

    **Order matters**: check DB for local model *before* importing
    ``sentence_transformers`` (which pulls in torch/datasets/scipy and can
    stall the event loop for 30-75 s). If no local model is configured we
    skip the heavy import entirely.
    """
    from evoflow.knowledge.embedding.base import DEFAULT_LOCAL_MODEL
    from evoflow.knowledge.embedding.local_provider import probe_local_embedding_deps
    from evoflow.knowledge.owned.embedding_bind import list_embedding_model_rows

    # 1) Quick DB check — avoids heavy import when no local model is configured.
    local_rows = [
        r
        for r in list_embedding_model_rows()
        if str(r.get("vendor") or "").strip().lower() == "local"
    ]
    if not local_rows:
        return ("no local model configured", None)

    # 2) Only now probe deps (may trigger sentence_transformers import).
    deps_err = probe_local_embedding_deps()
    if deps_err is not None:
        return ("runtime deps missing", None)

    model_id = str(local_rows[0].get("model") or "").strip() or DEFAULT_LOCAL_MODEL
    return (None, model_id)


def _lg_selftest_enabled() -> bool:
    return os.environ.get("EVOFLOW_STARTUP_LG_SELFTEST", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _safe_str(v: object) -> str:
    try:
        return str(v)
    except Exception:
        return "<unprintable>"


async def _run_langgraph_selftest(app: FastAPI) -> None:
    try:
        _lg_status = None
        _lg_headers = []

        async def _lg_send(msg: dict) -> None:
            nonlocal _lg_status, _lg_headers
            if msg["type"] == "http.response.start":
                _lg_status = msg.get("status")
                _lg_headers = msg.get("headers", [])

        async def _lg_recv() -> dict:
            return {"type": "http.request", "body": b"", "more_body": False}

        try:
            _lg = app.state._lg_app
            await _lg(
                scope={
                    "type": "http",
                    "method": "GET",
                    "path": "/ok",
                    "query_string": b"",
                    "headers": [],
                },
                receive=_lg_recv,
                send=_lg_send,
            )
            _lg_ct = dict((k.decode(), v.decode()) for k, v in _lg_headers).get("content-type", "?")
            print(
                f"[LG-SELFTEST] lg_app GET /ok -> status={_lg_status} content-type={_lg_ct}",
                file=sys.stderr,
                flush=True,
            )
        except Exception as e:
            print(f"[LG-SELFTEST] lg_app GET /ok FAILED: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

        try:
            from langgraph_api.graph import GRAPHS

            print(f"[LG-SELFTEST] LangGraph GRAPHS: {sorted(GRAPHS.keys())}", file=sys.stderr, flush=True)
        except Exception:
            print("[LG-SELFTEST] Could not import langgraph_api.graph.GRAPHS", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[LG-SELFTEST] Self-test failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        logger.debug("LangGraph mount self-test failed", exc_info=True)


async def run_background_startup(app: FastAPI, st_log: StLogFn, _st: Any) -> None:
    """Heavy gateway init (phase1/LangGraph/graphs). Does not block liveness."""
    # ---- Phase 1: Parallel independent initialization ----
    # Skills install (file I/O) and config/DB init (SQLite) run concurrently
    # to reduce cold-start latency. Both are wrapped in asyncio.to_thread to
    # avoid blocking the event loop.
    st_log("phase1 start")

    async def _startup_skills_install() -> None:
        _t_skills = _st.perf_counter()
        try:
            from evoflow.skills.user_install import bootstrap_user_skills_path

            skills_install = await asyncio.to_thread(bootstrap_user_skills_path)
            logger.info(
                "User skills path ready: %s (full public sync deferred post-ready)",
                skills_install,
            )
        except Exception:
            logger.warning("bootstrap_user_skills_path at startup failed", exc_info=True)
        finally:
            st_log(f"phase1.skills ({(_st.perf_counter() - _t_skills) * 1000:.0f}ms)")

    async def _startup_db_init() -> None:
        # data layout migration
        try:
            from evoflow.config.paths import get_paths
            from evoflow.persistence.data_layout import ensure_data_layout

            _t_layout = _st.perf_counter()
            layout = await asyncio.to_thread(ensure_data_layout, get_paths().base_dir)
            st_log(f"phase1.db.layout ({(_st.perf_counter() - _t_layout) * 1000:.0f}ms)")
            if layout.moved:
                logger.info("Migrated SQLite files into data/ layout: %s", layout.moved)
        except Exception:
            logger.warning("data/ layout migration at startup failed", exc_info=True)
        # DB schema init
        try:
            from evoflow.persistence.db import get_db, resolve_evolflow_db_path

            _t_schema = _st.perf_counter()
            await asyncio.to_thread(get_db)
            st_log(f"phase1.db.schema ({(_st.perf_counter() - _t_schema) * 1000:.0f}ms)")
            logger.info("SQLite schema ready at %s", resolve_evolflow_db_path())
        except Exception:
            logger.warning("SQLite schema init at startup failed", exc_info=True)
        # Finish leftover v136 orphan stamps off the ensure_app_schema hot path.
        try:

            def _stamp_v136_leftovers() -> None:
                from evoflow.persistence.db import get_db
                from evoflow.persistence.orphan_ownership_heal import (
                    heal_orphan_ownership_to_admin,
                )

                heal_orphan_ownership_to_admin(get_db())

            _t_v136 = _st.perf_counter()
            await asyncio.to_thread(_stamp_v136_leftovers)
            st_log(f"phase1.db.orphan_ownership_heal ({(_st.perf_counter() - _t_v136) * 1000:.0f}ms)")
        except Exception:
            logger.warning("orphan ownership heal failed (non-fatal)", exc_info=True)
        # ---- Database preflight: fast quick_check only (full integrity_check deferred) ----
        try:
            from evoflow.config.data_paths import (
                checkpoints_db_path,
                observability_db_path,
            )
            from evoflow.config.paths import get_paths as _get_paths
            from evoflow.persistence.db import (
                preflight_database_startup,
                resolve_evolflow_db_path as _resolve_app_db,
            )

            _base = _get_paths().base_dir
            _db_paths: list[tuple[str, Path]] = []
            try:
                _db_paths.append(("evoflow.db", _resolve_app_db()))
            except Exception:
                pass
            try:
                from evoflow.debug.trace_sink import observability_enabled as _obs_on

                if _obs_on():
                    _db_paths.append(("observability.db", observability_db_path(_base)))
            except Exception:
                pass
            try:
                _db_paths.append(("checkpoints.db", checkpoints_db_path(_base)))
            except Exception:
                pass
            _t_preflight = _st.perf_counter()

            async def _preflight_one(label: str, db_path: Path) -> None:
                _t_one = _st.perf_counter()
                await asyncio.to_thread(preflight_database_startup, db_path, label=label)
                st_log(
                    f"phase1.db.preflight.{label} ({(_st.perf_counter() - _t_one) * 1000:.0f}ms)"
                )

            await asyncio.gather(
                *(_preflight_one(_l, _p) for _l, _p in _db_paths),
                return_exceptions=True,
            )
            st_log(
                f"phase1.db.preflight total ({(_st.perf_counter() - _t_preflight) * 1000:.0f}ms)"
            )
        except Exception:
            logger.warning("Database preflight stage failed at startup", exc_info=True)

    await asyncio.gather(_startup_skills_install(), _startup_db_init())
    st_log("phase1 done")

    # ---- Background warmup: tiktoken BPE tables (never on the event loop) ----
    # First model invoke / observability token stats may select o200k_base.
    # tiktoken downloads that blob via synchronous requests.get with no timeout;
    # doing it on the main loop caused event_loop_stall → guardian restart.
    async def _warmup_tiktoken_encodings() -> None:
        if os.environ.get("EVOFLOW_SKIP_TIKTOKEN_WARMUP", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }:
            st_log("tiktoken warmup skipped (EVOFLOW_SKIP_TIKTOKEN_WARMUP)")
            logger.info("tiktoken encoding warmup skipped (EVOFLOW_SKIP_TIKTOKEN_WARMUP)")
            return
        try:
            from evoflow.context.compaction_token_utils import warm_token_encodings

            st_log("tiktoken warmup start")
            _t_tok = _st.perf_counter()
            result = await asyncio.to_thread(warm_token_encodings)
            _tok_ms = (_st.perf_counter() - _t_tok) * 1000.0
            ready = ",".join(k for k, ok in result.items() if ok) or "none"
            st_log(f"tiktoken warmup done ({_tok_ms:.0f}ms; ready={ready})")
            logger.info(
                "tiktoken encoding warmup completed in %.0fms: %s",
                _tok_ms,
                result,
            )
        except Exception:
            st_log("tiktoken warmup failed (non-fatal)")
            logger.warning("tiktoken encoding warmup failed (non-fatal)", exc_info=True)

    asyncio.create_task(_warmup_tiktoken_encodings())
    logger.info("tiktoken encoding warmup scheduled in background")

    # ---- Background warmup: local embedding only when already configured ----
    # Lean desktop omits torch; cloud embedding is default. Warmup only when a
    # vendor=local model exists (or EVOFLOW_SEED_LOCAL_EMBEDDING seeded one).
    # Probe deps/model BEFORE optional delay — never sleep 30s just to skip.
    async def _warmup_embedding_model() -> None:
        if os.environ.get("EVOFLOW_SKIP_EMBEDDING_WARMUP", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }:
            st_log("embedding warmup skipped (EVOFLOW_SKIP_EMBEDDING_WARMUP)")
            logger.info("Local embedding model warmup skipped (EVOFLOW_SKIP_EMBEDDING_WARMUP)")
            return
        try:
            skip_reason, model_id = await asyncio.to_thread(resolve_local_embedding_warmup_target)
            if skip_reason is not None:
                st_log(f"embedding warmup skipped ({skip_reason})")
                logger.info("Local embedding model warmup skipped: %s", skip_reason)
                return
            delay_raw = os.environ.get("EVOFLOW_EMBEDDING_WARMUP_DELAY_SEC", "30").strip()
            try:
                delay_sec = max(0.0, float(delay_raw))
            except ValueError:
                delay_sec = 30.0
            if delay_sec > 0:
                st_log(f"embedding warmup scheduled in {delay_sec:.0f}s")
                await asyncio.sleep(delay_sec)
            from evoflow.knowledge.embedding.hf_env import ensure_hf_hub_env
            from evoflow.knowledge.embedding.local_provider import warmup_local_model

            hub = ensure_hf_hub_env()
            st_log(f"embedding warmup start ({model_id})")
            logger.info("Local embedding model warmup starting (hub=%s, model=%s)", hub, model_id)
            _t_embed = _st.perf_counter()
            await asyncio.to_thread(warmup_local_model, model_id)
            _embed_ms = (_st.perf_counter() - _t_embed) * 1000.0
            st_log(f"embedding warmup done ({_embed_ms:.0f}ms)")
            logger.info("Local embedding model warmup completed: %s (%.0fms)", model_id, _embed_ms)
        except Exception:
            st_log("embedding warmup failed (non-fatal)")
            logger.debug("Local embedding model warmup failed (non-fatal)", exc_info=True)

    asyncio.create_task(_warmup_embedding_model())
    logger.info("Local embedding model warmup scheduled in background (deferred)")

    # ---- Phase 2: minimal config for serving (heavy agent/vault work deferred) ----
    st_log("phase2 start")
    try:
        cfg = get_app_config()
        try:
            from evoflow.persistence.runtime_env import apply_runtime_env_to_environ

            apply_runtime_env_to_environ()
        except Exception:
            logger.warning("Runtime env apply at startup failed", exc_info=True)
        logger.info("Configuration loaded successfully")
    except Exception as e:
        error_msg = f"Failed to load configuration during gateway startup: {e}"
        logger.exception(error_msg)
        raise RuntimeError(error_msg) from e

    # ---- Register built-in capabilities into the open-capability registry ----
    # Runs after Phase 2 (agents materialized + DB ready) so capability handlers
    # can lazily import the now-initialized services. Idempotent: safe to call
    # even if capabilities were already registered (e.g. by an earlier import).
    try:
        from evoflow.capability.builtin import register_builtin_capabilities

        _registered = register_builtin_capabilities()
        logger.info("Built-in capabilities registered: %s", _registered)
    except Exception:
        logger.exception("Failed to register built-in capabilities at startup")

    st_log("phase2 done")

    config = get_gateway_config()
    logger.info(f"Starting API Gateway on {config.host}:{config.port}")

    # ---- Runtime data root diagnostics (critical for debugging workspace switching) ----
    try:
        from evoflow.config.paths import get_paths, resolve_path

        evoflow_home = (os.getenv("EVOFLOW_HOME") or "").strip()
        base_dir = get_paths().base_dir
        cfg_cp = getattr(cfg, "checkpointer", None)
        cp_type = getattr(cfg_cp, "type", None) if cfg_cp else None
        cp_raw = getattr(cfg_cp, "connection_string", None) if cfg_cp else None
        cp_resolved = None
        if cp_type == "sqlite":
            raw = (cp_raw or "store.db").strip()
            cp_resolved = raw if raw in (":memory:",) or raw.startswith("file:") else _safe_str(resolve_path(raw))

        msg = (
            "Runtime paths: "
            f"cwd={_safe_str(Path.cwd())} "
            f"EVOFLOW_HOME={(evoflow_home or '<unset>')} "
            f"base_dir={_safe_str(base_dir)} "
            f"checkpointer.type={_safe_str(cp_type)} "
            f"checkpointer.conn={_safe_str(cp_raw)} "
            f"checkpointer.sqlite_path={_safe_str(cp_resolved) if cp_resolved else '<n/a>'}"
        )
        logger.info(msg)
        # Ensure visibility in interactive console even if logging handlers are redirected.
        print(msg, file=sys.stderr, flush=True)
    except Exception as e:
        logger.exception("Failed to emit runtime path diagnostics: %s", e)
        print(f"[gateway] Failed to emit runtime path diagnostics: {e}", file=sys.stderr, flush=True)

    from evoflow.langgraph_deployment import is_external_langgraph_mode

    if is_external_langgraph_mode():
        from evoflow.langgraph_run_config import resolve_langgraph_base_url

        st_log("langgraph external (skip in-process mount)")
        logger.info(
            "LangGraph external mode — skipping in-process mount/lifespan (upstream=%s)",
            resolve_langgraph_base_url(),
        )
    else:
        from app.gateway.lazy_langgraph import ensure_langgraph_mounted

        # Fat LangGraph imports run in a worker thread but still hold the CPython GIL,
        # so uvicorn + app-server HTTP starve for tens of seconds. Session history /
        # model catalog only need core routers — delay mount so first paint can finish.
        delay_raw = (os.environ.get("EVOFLOW_LG_MOUNT_DELAY_SEC") or "25").strip()
        try:
            lg_delay_sec = max(0.0, float(delay_raw))
        except ValueError:
            lg_delay_sec = 25.0
        if lg_delay_sec > 0:
            st_log(f"langgraph mount delayed {lg_delay_sec:.0f}s (first-paint APIs)")
            logger.info(
                "Deferring LangGraph mount by %.0fs so /messages + /models stay responsive",
                lg_delay_sec,
            )
            await asyncio.sleep(lg_delay_sec)

        st_log("langgraph mount start")
        _t_lg_mount = _st.perf_counter()
        await ensure_langgraph_mounted(app)
        # Yield so queued HTTP/RPC can run before the next sync import block.
        await asyncio.sleep(0)
        st_log(f"langgraph mount done ({(_st.perf_counter() - _t_lg_mount) * 1000:.0f}ms)")

        if _lg_selftest_enabled():
            await _run_langgraph_selftest(app)

        # NOTE: MCP tools are lazily initialized by LangGraph when first needed (in-process).

        # ---- Manually run LangGraph lifespan init (mounted app lifespan is NOT executed) ----
        # Order mirrors langgraph_runtime_inmem.lifespan: pool/store must be ready BEFORE
        # graph registration, because start_pool() clears stale system assistants from
        # GLOBAL_STORE. If we register graphs first, start_pool() will immediately delete them.
        try:
            from langgraph_api import _checkpointer as _lg_cp
            from langgraph_api import store as _lg_store
            from langgraph_api.http import start_http_client
            from langgraph_api.js.ui import start_ui_bundler
            from langgraph_runtime_inmem.database import start_pool

            # Parallelize independent LG lifespan steps to reduce cold-start latency.
            # http_client / checkpointer are independent; UI bundler is optional on
            # desktop (stdio app-server) and often blocks the event loop (Node spawn).
            print("[LG-LIFESPAN] Starting HTTP client + checkpointer (+ optional UI bundler)...", file=sys.stderr, flush=True)
            _skip_ui = (os.environ.get("EVOFLOW_SKIP_LG_UI_BUNDLER") or "").strip().lower() in (
                "1",
                "true",
                "yes",
                "on",
            )
            if not _skip_ui:
                # Desktop Tauri owns stdio — LangGraph Studio UI bundler is unused.
                _skip_ui = (os.environ.get("EVOFLOW_APP_SERVER_STDIO") or "").strip().lower() in (
                    "1",
                    "true",
                    "yes",
                    "on",
                )
            _lg_boot = [start_http_client(), _lg_cp.start_checkpointer()]
            if _skip_ui:
                print("[LG-LIFESPAN] Skipping UI bundler (desktop/stdio or EVOFLOW_SKIP_LG_UI_BUNDLER)", file=sys.stderr, flush=True)
            else:
                _lg_boot.append(start_ui_bundler())
            await asyncio.gather(*_lg_boot)
            await asyncio.sleep(0)
            print("[LG-LIFESPAN] Starting DB pool...", file=sys.stderr, flush=True)
            await start_pool()
            await asyncio.sleep(0)
            print("[LG-LIFESPAN] Initializing store...", file=sys.stderr, flush=True)
            await _lg_store.collect_store_from_env()
            store_instance = await _lg_store.get_store()
            await asyncio.sleep(0)

            # Set the runnable config with store (replicates what lifespan does)
            try:
                from langchain_core.runnables.config import var_child_runnable_config
                from langgraph._internal._constants import CONFIG_KEY_RUNTIME
                from langgraph.constants import CONF
                from langgraph.runtime import Runtime

                langgraph_config = {CONF: {CONFIG_KEY_RUNTIME: Runtime(store=store_instance)}}
                var_child_runnable_config.set(langgraph_config)
                print("[LG-LIFESPAN] Runtime config set with store", file=sys.stderr, flush=True)
            except Exception:
                # Fallback: older CONFIG_KEY_STORE approach
                try:
                    from langchain_core.runnables.config import var_child_runnable_config
                    from langgraph.constants import CONF, CONFIG_KEY_STORE
                    langgraph_config = {CONF: {CONFIG_KEY_STORE: store_instance}}
                    var_child_runnable_config.set(langgraph_config)
                    print("[LG-LIFESPAN] Fallback config set with store", file=sys.stderr, flush=True)
                except Exception as e2:
                    print(f"[LG-LIFESPAN] WARNING: Could not set runnable config: {e2}", file=sys.stderr, flush=True)

            # Start the queue worker (needed for graph execution)
            try:
                import langgraph_api.config as _lg_cfg
                from langgraph_runtime_inmem import queue as _lg_queue

                # inmem Runs.next() hardcodes await asyncio.sleep(0.5) when idle —
                # that alone explains most of POST→make_lead_agent (~600–800ms).
                # Patch: claim immediately if pending work exists; only sleep when idle
                # (env EVOFLOW_LG_QUEUE_POLL_MS). Default 50ms — claim-first keeps
                # POST→run latency low when work is already queued.
                try:
                    from langgraph_runtime_inmem import ops as _lg_ops

                    _poll_ms_raw = (os.environ.get("EVOFLOW_LG_QUEUE_POLL_MS") or "50").strip()
                    try:
                        _poll_ms = max(0, int(_poll_ms_raw))
                    except ValueError:
                        _poll_ms = 50
                    # In-process handoff: keep idle poll short so POST→claim
                    # stays sub-second when a run lands during the idle wait window.
                    _orig_next = _lg_ops.Runs.next

                    @staticmethod
                    async def _patched_runs_next(wait: bool, limit: int = 1):
                        import time as _t
                        from datetime import datetime, timedelta, timezone

                        _t0 = _t.perf_counter()

                        def _prefer_interactive_pending() -> None:
                            """Reorder pending created_at so interactive claims first (no cancel)."""
                            try:
                                from langgraph_runtime_inmem.database import GLOBAL_STORE
                                from evoflow.session_concurrency_policy import claim_priority_key

                                runs = GLOBAL_STORE.get("runs") or []
                                pending = [
                                    r
                                    for r in runs
                                    if isinstance(r, dict) and r.get("status") == "pending"
                                ]
                                if len(pending) < 2:
                                    return
                                ordered = sorted(pending, key=claim_priority_key)
                                base = datetime.now(timezone.utc) - timedelta(days=365)
                                for i, run in enumerate(ordered):
                                    if "_evf_claim_created_backup" not in run:
                                        run["_evf_claim_created_backup"] = run.get("created_at")
                                    run["created_at"] = base + timedelta(milliseconds=i)
                            except Exception:
                                pass

                        def _emit_claim(run, attempt, *, slept: bool) -> None:
                            try:
                                from evoflow.observability.run_latency_trace import write_run_latency_event

                                _cfg = (run.get("kwargs") or {}).get("config") or {}
                                _c = _cfg.get("configurable") if isinstance(_cfg, dict) else {}
                                _ctx = (run.get("kwargs") or {}).get("context") or {}
                                if not isinstance(_ctx, dict):
                                    _ctx = {}
                                _tid = str(
                                    (_c or {}).get("thread_id")
                                    or _ctx.get("thread_id")
                                    or run.get("thread_id")
                                    or ""
                                ).strip()
                                _tr = (
                                    str((_c or {}).get("evf_trace_id") or _ctx.get("evf_trace_id") or "").strip()
                                    or None
                                )
                                _rid = str(run.get("run_id") or "").strip()
                                _sk = str(
                                    (_c or {}).get("session_key") or _ctx.get("session_key") or ""
                                ).strip()
                                _claim_poll_ms = round((_t.perf_counter() - _t0) * 1000.0, 2)
                                _pending_age_ms = None
                                _created = run.get("_evf_claim_created_backup") or run.get("created_at")
                                if _created:
                                    try:
                                        from datetime import datetime as _dt

                                        if isinstance(_created, str):
                                            _created_dt = _dt.fromisoformat(
                                                _created.replace("Z", "+00:00")
                                            )
                                        else:
                                            _created_dt = _created
                                        if getattr(_created_dt, "tzinfo", None) is None:
                                            _created_dt = _created_dt.replace(tzinfo=timezone.utc)
                                        _pending_age_ms = round(
                                            (
                                                datetime.now(timezone.utc) - _created_dt
                                            ).total_seconds()
                                            * 1000.0,
                                            1,
                                        )
                                    except Exception:
                                        _pending_age_ms = None
                                if _tid:
                                    write_run_latency_event(
                                        _tid,
                                        "lg_queue_claim",
                                        {
                                            "queue_wait_flag": bool(wait),
                                            "queue_poll_ms_config": _poll_ms,
                                            "queue_slept": bool(slept),
                                            "queue_claim_after_poll_ms": _claim_poll_ms,
                                            "pending_age_ms": _pending_age_ms,
                                            "attempt": attempt,
                                            "run_id": _rid or None,
                                            "interactive_prefer": True,
                                        },
                                        trace_id=_tr,
                                    )
                                try:
                                    from evoflow.observability.thread_run_queue_log import (
                                        log_slow_queue_claim_if_needed,
                                    )

                                    log_slow_queue_claim_if_needed(
                                        pending_age_ms=_pending_age_ms,
                                        thread_id=_tid,
                                        session_key=_sk,
                                        run_id=_rid,
                                        queue_slept=bool(slept),
                                        queue_claim_after_poll_ms=_claim_poll_ms,
                                        attempt=attempt,
                                        multitask_strategy=str(
                                            run.get("multitask_strategy") or ""
                                        )
                                        or None,
                                    )
                                except Exception:
                                    pass
                            except Exception:
                                pass

                        # Fast path: claim immediately if work is already pending.
                        claimed = False
                        _prefer_interactive_pending()
                        async for item in _orig_next(wait=False, limit=limit):
                            claimed = True
                            run, attempt = item
                            _emit_claim(run, attempt, slept=False)
                            yield item
                        if claimed:
                            return
                        if not wait:
                            # Match upstream: always yield the loop (never busy-spin).
                            await asyncio.sleep(0)
                            return

                        # Idle: short poll, then claim (original slept 500ms unconditionally).
                        await asyncio.sleep(_poll_ms / 1000.0)
                        _prefer_interactive_pending()
                        async for item in _orig_next(wait=False, limit=limit):
                            run, attempt = item
                            _emit_claim(run, attempt, slept=True)
                            yield item

                    _lg_ops.Runs.next = _patched_runs_next  # type: ignore[method-assign]
                    print(
                        f"[LG-LIFESPAN] Patched inmem Runs.next: claim-first + interactive prefer, "
                        f"idle poll {_poll_ms}ms (was hardcoded 500ms; set EVOFLOW_LG_QUEUE_POLL_MS to tune)",
                        file=sys.stderr,
                        flush=True,
                    )
                except Exception as _poll_exc:
                    print(
                        f"[LG-LIFESPAN] WARNING: queue poll patch failed: {_poll_exc}",
                        file=sys.stderr,
                        flush=True,
                    )

                # Blind-span breadcrumbs: get_graph / astream_state enter→ready→first data.
                try:
                    from evoflow.observability.lg_blind_span_patch import apply_lg_blind_span_patches

                    if apply_lg_blind_span_patches():
                        print(
                            "[LG-LIFESPAN] Patched get_graph + astream_state for blind-span timing",
                            file=sys.stderr,
                            flush=True,
                        )
                except Exception as _blind_exc:
                    print(
                        f"[LG-LIFESPAN] WARNING: blind-span patch failed: {_blind_exc}",
                        file=sys.stderr,
                        flush=True,
                    )

                # Register graphs BEFORE starting the queue. create_task(queue) + any
                # subsequent await yields to the loop; workers can claim pending runs
                # while GRAPHS is still {} → 404 "Graph 'lead_agent' not found. Expected one of: []".
                from langgraph_api import graph as _lg_graph

                await _lg_graph.collect_graphs_from_env(register=True)
                registered = sorted(_lg_graph.GRAPHS.keys())
                logger.info("LangGraph graphs registered in-process: %s", registered)
                print(f"[LG-LIFESPAN] Graphs registered: {registered}", file=sys.stderr, flush=True)
                if "lead_agent" not in _lg_graph.GRAPHS:
                    raise RuntimeError(
                        f"lead_agent missing after collect_graphs_from_env; got {registered!r}. "
                        "Check LANGSERVE_GRAPHS / backend/langgraph.json."
                    )

                if _lg_cfg.N_JOBS_PER_WORKER > 0:
                    print("[LG-LIFESPAN] Starting queue worker...", file=sys.stderr, flush=True)
                    asyncio.create_task(_lg_queue.queue())
            except Exception as e:
                logger.exception("LangGraph queue/graph registration failed")
                print(
                    f"[LG-LIFESPAN] ERROR: queue/graph init failed: {e}",
                    file=sys.stderr,
                    flush=True,
                )
                raise

            print("[LG-LIFESPAN] Core components initialized", file=sys.stderr, flush=True)
            st_log("LG lifespan done")
        except Exception:
            logger.exception("Failed to initialize LangGraph lifespan components")
            print("[LG-LIFESPAN] FAILED — graph execution will likely hang!", file=sys.stderr, flush=True)

        try:
            from langgraph_api import graph as _lg_graph

            if not _lg_graph.GRAPHS:
                logger.error(
                    "LangGraph GRAPHS still empty after lifespan init — runs will 404"
                )
                print(
                    "[LG-LIFESPAN] ERROR: GRAPHS={} after init",
                    file=sys.stderr,
                    flush=True,
                )
        except Exception:
            logger.exception("Failed to inspect LangGraph GRAPHS after lifespan")

    # Collab bridge deferred to post-ready (workflow dispatch not needed for liveness).

    # MCP tools: register loop + warm cache in background (never block HTTP handlers).
    try:
        from evoflow.mcp.cache import register_mcp_init_loop, schedule_mcp_tools_warmup

        register_mcp_init_loop(asyncio.get_running_loop())
        schedule_mcp_tools_warmup()
        logger.info("MCP tools warmup scheduled in background")
    except Exception:
        logger.warning("MCP tools warmup scheduling failed", exc_info=True)

    try:
        from app.gateway.run_status_reconcile import wait_and_reconcile_on_startup

        asyncio.create_task(wait_and_reconcile_on_startup())
        logger.info("Scheduled run_status reconciliation against LangGraph on startup")
    except Exception:
        logger.exception("Failed to schedule run_status reconciliation")

    # Asset Hub Phase2: consolidate pending inbox drafts shortly after boot
    async def _startup_asset_phase2_scan() -> None:
        try:
            await asyncio.sleep(8)
            from evoflow.assets.startup import (
                asset_startup_phase2_enabled,
                scan_and_run_phase2_on_startup,
            )

            if not asset_startup_phase2_enabled():
                logger.info("Asset Phase2 startup scan OFF (EVOFLOW_ASSET_STARTUP_PHASE2=0)")
                return
            result = await asyncio.to_thread(scan_and_run_phase2_on_startup)
            logger.info(
                "Asset Phase2 startup scan done: scanned=%s ran=%s skipped=%s",
                result.get("scanned"),
                result.get("ran"),
                result.get("skipped"),
            )
        except Exception:
            logger.debug("Asset Phase2 startup scan failed (non-fatal)", exc_info=True)

    asyncio.create_task(_startup_asset_phase2_scan())


def _lead_agent_startup_warmup_enabled() -> bool:
    raw = os.environ.get("EVOFLOW_SKIP_LEAD_AGENT_STARTUP_WARMUP", "").strip().lower()
    return raw not in ("1", "true", "yes", "on")


async def _warmup_lead_agent_graph(st_log: StLogFn, _st: Any) -> None:
    """Optional post-ready graph pre-compile (first chat latency, not startup gate).

    Warms common Panel shapes (agent / auto, thinking on/off) and waits for MCP
    so the cache is not wiped by the post-MCP ``clear_lead_agent_graph_cache``.
    """
    if not _lead_agent_startup_warmup_enabled():
        st_log("graph warmup skipped (EVOFLOW_SKIP_LEAD_AGENT_STARTUP_WARMUP)")
        logger.info("Lead agent graph warmup skipped (EVOFLOW_SKIP_LEAD_AGENT_STARTUP_WARMUP)")
        return
    try:
        from evoflow.agents import make_lead_agent
        from evoflow.mcp.cache import mcp_cache_initialized

        app_cfg = get_app_config()
        if not app_cfg.models:
            logger.debug("Graph warmup skipped: no models configured")
            return
        default_model = app_cfg.primary_model or app_cfg.models[0].name

        # MCP init clears the graph cache when it finishes; wait briefly so warmup sticks.
        for _ in range(60):
            if mcp_cache_initialized():
                break
            await asyncio.sleep(0.5)

        # Match default Panel chat: session_mode=agent, is_plan_mode=false, plus auto/thinking variants.
        warmup_variants: list[dict[str, Any]] = [
            {"thinking_enabled": False, "is_plan_mode": False, "session_mode": "agent"},
            {"thinking_enabled": True, "is_plan_mode": False, "session_mode": "agent"},
            {"thinking_enabled": False, "is_plan_mode": False, "session_mode": "auto"},
            {"thinking_enabled": True, "is_plan_mode": True, "session_mode": "agent"},
        ]
        _t_warmup = _st.perf_counter()
        for variant in warmup_variants:
            warmup_config: dict = {
                "configurable": {
                    "model_name": default_model,
                    "agent_name": "main",
                    "is_bootstrap": False,
                    "include_search": True,
                    "use_virtual_paths": False,
                    **variant,
                }
            }
            try:
                await asyncio.to_thread(make_lead_agent, warmup_config)
            except Exception:
                logger.debug(
                    "Lead agent graph warmup variant failed (non-fatal) variant=%s",
                    variant,
                    exc_info=True,
                )
        _warmup_ms = (_st.perf_counter() - _t_warmup) * 1000.0
        logger.info(
            "Lead agent graph warmup completed in %.0fms (model=%s variants=%d mcp_ready=%s)",
            _warmup_ms,
            default_model,
            len(warmup_variants),
            mcp_cache_initialized(),
        )
        st_log(f"graph warmup done ({_warmup_ms:.0f}ms)")
    except Exception:
        logger.debug("Lead agent graph warmup failed (non-fatal)", exc_info=True)


def _schedule_lead_agent_graph_rewarm(st_log: StLogFn, _st: Any) -> None:
    """After MCP (or config) clears the graph cache, rebuild common shapes in the background."""
    if not _lead_agent_startup_warmup_enabled():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    state: dict[str, Any] = {"pending": None}

    def _on_cleared() -> None:
        def _kick() -> None:
            if state["pending"] is not None and not state["pending"].done():
                return

            async def _debounced() -> None:
                await asyncio.sleep(0.75)
                await _warmup_lead_agent_graph(st_log, _st)

            state["pending"] = asyncio.create_task(_debounced())

        try:
            loop.call_soon_threadsafe(_kick)
        except Exception:
            logger.debug("schedule graph re-warmup failed", exc_info=True)

    try:
        from evoflow.agents.lead_agent.graph_cache import register_lead_agent_graph_cache_cleared

        register_lead_agent_graph_cache_cleared(_on_cleared)
    except Exception:
        logger.debug("register graph cache cleared callback failed", exc_info=True)


async def run_post_ready_warmups(app: FastAPI, st_log: StLogFn, _st: Any) -> None:
    """Heavy work after LangGraph ready — channels, schedulers, vault warmups."""
    schedulers = app.state.startup_schedulers
    _retention = schedulers["retention"]
    _automation = schedulers["automation"]
    _task_queue = schedulers["task_queue"]
    _zombie_sweeper = schedulers["zombie_sweeper"]

    delay_raw = os.environ.get("EVOFLOW_STARTUP_DEFER_KB_WARMUP_SEC", "5").strip()
    try:
        delay_sec = max(0.0, float(delay_raw))
    except ValueError:
        delay_sec = 5.0
    if delay_sec > 0:
        await asyncio.sleep(delay_sec)
    st_log("post-ready warmups begin")

    try:
        from evoflow.skills.user_install import ensure_user_skills_install

        await asyncio.to_thread(ensure_user_skills_install)
        st_log("post-ready skills sync done")
    except Exception:
        logger.warning("Deferred skills sync failed (non-fatal)", exc_info=True)

    try:
        from evoflow.config.agents_config import ensure_builtin_agents_materialized

        await asyncio.to_thread(ensure_builtin_agents_materialized)
        st_log("post-ready agents materialized")
    except Exception:
        logger.warning("Deferred agents materialize failed (non-fatal)", exc_info=True)

    try:
        from evoflow.collab.subtask_stream_trace import stream_info, subtask_stream_trace_path

        stream_info("trace_ready path=%s", subtask_stream_trace_path())
    except Exception:
        pass

    deferred_vault_reindex_ids: list[str] = []
    try:
        from evoflow.knowledge.vault.builtin import (
            ensure_builtin_knowledge_vaults,
            schedule_builtin_vault_reindex,
        )

        vault_result = await asyncio.to_thread(ensure_builtin_knowledge_vaults)
        logger.info("Builtin knowledge vaults (post-ready): %s", vault_result)
        deferred_vault_reindex_ids.extend(
            str(x).strip()
            for x in (vault_result.get("needsReindex") or [])
            if str(x).strip()
        )
        if deferred_vault_reindex_ids:
            reindex_started = await schedule_builtin_vault_reindex(deferred_vault_reindex_ids)
            st_log(f"post-ready vault reindex scheduled ({len(reindex_started)} jobs)")
            logger.info("Builtin vault reindex scheduled (post-ready): %s", reindex_started)
    except Exception:
        logger.warning("Post-ready builtin vault ensure failed (non-fatal)", exc_info=True)

    try:
        from evoflow.tools.builtins.collab_bridge import ensure_collab_bridge_ready

        task_ok, follow_ok = ensure_collab_bridge_ready()
        logger.info(
            "Collab bridge ready (post-ready): task_tool=%s followup=%s",
            task_ok,
            follow_ok,
        )
    except Exception:
        logger.warning("Collab bridge ensure failed (non-fatal)", exc_info=True)

    try:
        from app.channels.service import start_channel_service

        channel_service = await start_channel_service()
        logger.info("Channel service started (post-ready): %s", channel_service.get_status())
    except Exception:
        logger.exception("Channel service failed to start (non-fatal)")

    try:
        from app.gateway.events import event_queue, register_event_handlers

        register_event_handlers(event_queue)
        event_queue.start()
        logger.info("Event queue started (post-ready)")
    except Exception:
        logger.exception("Event queue failed to start (non-fatal)")

    try:
        from app.gateway.data_retention_runner import data_retention_enabled, run_data_retention_scheduler

        if data_retention_enabled():
            _retention["stop"] = asyncio.Event()
            _retention["task"] = asyncio.create_task(
                run_data_retention_scheduler(_retention["stop"])  # type: ignore[arg-type]
            )
            logger.info("Data retention scheduler started (post-ready)")
    except Exception:
        logger.exception("Data retention scheduler failed (non-fatal)")

    try:
        from app.gateway.automation_runner import (
            AUTOMATIONS_DIR,
            automation_scheduler_enabled,
            run_automation_scheduler,
        )

        if automation_scheduler_enabled():
            _automation["stop"] = asyncio.Event()
            _automation["task"] = asyncio.create_task(
                run_automation_scheduler(_automation["stop"])  # type: ignore[arg-type]
            )
            logger.info(
                "Automation scheduler spawned (post-ready); automations_dir=%s",
                AUTOMATIONS_DIR,
            )
    except Exception:
        logger.exception("Automation scheduler failed (non-fatal)")

    try:
        from evoflow.license import is_premium_active
        from evoflow.proactive.runner import start_proactive_runner

        if is_premium_active():
            start_proactive_runner()
            logger.info("Proactive AI runner started (post-ready)")
    except Exception:
        logger.warning("Proactive AI runner failed (non-fatal)", exc_info=True)

    try:
        from app.gateway.task_queue_runner import run_task_queue_scheduler, task_queue_enabled

        if task_queue_enabled():
            _task_queue["stop"] = asyncio.Event()
            _task_queue["task"] = asyncio.create_task(
                run_task_queue_scheduler(_task_queue["stop"])  # type: ignore[arg-type]
            )
            logger.info("Task queue scheduler spawned (post-ready)")
    except Exception:
        logger.exception("Task queue scheduler failed (non-fatal)")

    try:
        from app.gateway.zombie_run_sweeper import run_zombie_sweeper_scheduler, zombie_sweeper_enabled

        if zombie_sweeper_enabled():
            _zombie_sweeper["stop"] = asyncio.Event()
            _zombie_sweeper["task"] = asyncio.create_task(
                run_zombie_sweeper_scheduler(_zombie_sweeper["stop"])  # type: ignore[arg-type]
            )
            logger.info("Zombie run sweeper spawned (post-ready)")
    except Exception:
        logger.exception("Zombie run sweeper failed (non-fatal)")

    try:
        from evoflow.config.paths import get_paths
        from evoflow.persistence.db import run_deferred_full_preflight

        _t_full = _st.perf_counter()
        results = await asyncio.to_thread(run_deferred_full_preflight, base_dir=get_paths().base_dir)
        st_log(
            f"post-ready full db preflight ({(_st.perf_counter() - _t_full) * 1000:.0f}ms) {results}"
        )
        logger.info("Deferred full DB preflight done: %s", results)
    except Exception:
        logger.warning("Deferred full DB preflight failed (non-fatal)", exc_info=True)

    try:
        from evoflow.knowledge.embedding.local_provider import (
            ensure_default_local_embedding_model,
            reconcile_local_embedding_models_for_runtime,
        )

        seeded = await asyncio.to_thread(ensure_default_local_embedding_model)
        if seeded:
            logger.info("Default local embedding model seeded (bge-small-zh-v1.5)")
        recon = await asyncio.to_thread(reconcile_local_embedding_models_for_runtime)
        if recon.get("deleted") or recon.get("marked") or recon.get("cleared_default"):
            logger.info("Local embedding reconcile (post-ready): %s", recon)
    except Exception:
        logger.warning("Embedding config reconcile failed (non-fatal)", exc_info=True)

    try:
        from evoflow.knowledge.owned.builtin_seed import ensure_builtin_owned_knowledge

        async def _owned_kb_seed_task() -> None:
            try:
                seed_result = await asyncio.to_thread(ensure_builtin_owned_knowledge)
                st_log("post-ready owned KB seed done")
                logger.info("Builtin owned knowledge seed (post-ready): %s", seed_result)
            except Exception:
                logger.warning("Builtin owned knowledge seed failed (non-fatal)", exc_info=True)

        asyncio.create_task(_owned_kb_seed_task())
        st_log("post-ready owned KB seed scheduled")
        logger.info("Builtin owned knowledge seed scheduled (background, non-blocking)")
    except Exception:
        logger.warning("Failed to schedule owned KB seed (non-fatal)", exc_info=True)

    try:
        from evoflow.knowledge.vault.mcp_runtime import warmup_enabled_vaults

        # Vault MCP spawns Node children and can stall the event loop for 30s+.
        # First chat only needs /api/models + LG; defer vault warm until after UI settles.
        async def _vault_mcp_warmup_deferred() -> None:
            delay_raw = os.environ.get("EVOFLOW_VAULT_MCP_WARMUP_DELAY_SEC", "45").strip()
            try:
                delay_sec = max(0.0, float(delay_raw))
            except ValueError:
                delay_sec = 45.0
            if delay_sec > 0:
                await asyncio.sleep(delay_sec)
            try:
                result = await warmup_enabled_vaults()
                st_log(f"post-ready vault MCP warmup done (ok={len(result.get('ok') or [])})")
                logger.info("Knowledge vault MCP warmup done (post-ready): %s", result)
            except Exception:
                logger.warning("Knowledge vault MCP warmup failed (non-fatal)", exc_info=True)

        asyncio.create_task(_vault_mcp_warmup_deferred())
        st_log("post-ready vault MCP warmup scheduled (deferred)")
        logger.info("Knowledge vault MCP warmup deferred (non-blocking for first chat)")
    except Exception:
        logger.warning("Knowledge vault MCP warmup failed (non-fatal)", exc_info=True)

    # Owned KB worker last: after seed + embedding reconcile to avoid 100+ failed index jobs.
    try:
        worker_delay_raw = os.environ.get("EVOFLOW_OWNED_KB_WORKER_STARTUP_DELAY_SEC", "10").strip()
        try:
            worker_delay_sec = max(0.0, float(worker_delay_raw))
        except ValueError:
            worker_delay_sec = 10.0
        if worker_delay_sec > 0:
            await asyncio.sleep(worker_delay_sec)
        from evoflow.knowledge.owned.embedding_bind import default_embedding_ref
        from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started

        emb_ref = default_embedding_ref()
        if not emb_ref:
            st_log("post-ready owned KB worker skipped (no embedding model configured)")
            logger.warning(
                "Owned KB worker not started: no embedding model in registry "
                "(configure a cloud embedding model in Settings → 向量模型)"
            )
        else:
            ensure_owned_kb_worker_started()
            st_log("post-ready owned KB worker started")
            logger.info(
                "Owned knowledge worker started (post-ready, delayed %.0fs, embedding=%s)",
                worker_delay_sec,
                emb_ref,
            )
    except Exception:
        logger.warning("Owned knowledge worker failed to start (non-fatal)", exc_info=True)

    asyncio.create_task(_warmup_lead_agent_graph(st_log, _st))
    _schedule_lead_agent_graph_rewarm(st_log, _st)
    logger.info("Lead agent graph warmup scheduled (post-ready, non-blocking)")

    st_log("post-ready warmups done")


async def _cancel_scheduler_slot(slot: dict[str, Any], label: str) -> None:
    task = slot.get("task")
    stop_evt = slot.get("stop")
    if task and stop_evt and isinstance(stop_evt, asyncio.Event) and isinstance(task, asyncio.Task):
        stop_evt.set()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logger.info("%s stopped", label)


async def shutdown_gateway_background(
    app: FastAPI,
    bg_task: asyncio.Task | None,
    stop_hang_diagnostics: Callable[[], None] | None,
) -> None:
    extra_tasks = list(getattr(app.state, "startup_background_tasks", []) or [])
    for task in extra_tasks:
        if task and not task.done():
            task.cancel()
    for task in extra_tasks:
        if not task:
            continue
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug("Background startup task shutdown error", exc_info=True)

    if bg_task and not bg_task.done():
        bg_task.cancel()
        try:
            await bg_task
        except asyncio.CancelledError:
            pass

    schedulers = getattr(app.state, "startup_schedulers", {}) or {}
    await _cancel_scheduler_slot(schedulers.get("retention") or {}, "Data retention scheduler")
    await _cancel_scheduler_slot(schedulers.get("automation") or {}, "Automation scheduler")
    await _cancel_scheduler_slot(schedulers.get("task_queue") or {}, "Task queue scheduler")
    await _cancel_scheduler_slot(schedulers.get("zombie_sweeper") or {}, "Zombie run sweeper")

    try:
        from app.channels.service import stop_channel_service

        await stop_channel_service()
    except Exception:
        logger.exception("Failed to stop channel service")

    try:
        from evoflow.langgraph_deployment import is_external_langgraph_mode

        if not is_external_langgraph_mode():
            from langgraph_api import _checkpointer as _lg_cp
            from langgraph_api import store as _lg_store
            from langgraph_api.graph import stop_remote_graphs
            from langgraph_api.http import stop_http_client
            from langgraph_api.js.ui import stop_ui_bundler
            from langgraph_runtime_inmem.database import stop_pool

            await stop_remote_graphs()
            await _lg_cp.exit_checkpointer()
            await _lg_store.exit_store()
            await stop_ui_bundler()
            await stop_http_client()
            await stop_pool()
            print("[LG-LIFESPAN] Shutdown completed", file=sys.stderr, flush=True)
    except Exception:
        logger.debug("LangGraph lifespan shutdown failed", exc_info=True)

    lg_app = getattr(app.state, "_lg_app", None)
    if getattr(app.state, "_lg_external", False) and lg_app is not None:
        try:
            await lg_app.aclose()
        except Exception:
            logger.debug("External LangGraph proxy shutdown failed", exc_info=True)

    if stop_hang_diagnostics:
        stop_hang_diagnostics()
    logger.info("Shutting down API Gateway")

