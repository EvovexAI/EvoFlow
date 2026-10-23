"""LangGraph API process environment: durable local DB under ``EVOFLOW_HOME``."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_GRAPHS: dict[str, str] = {
    "lead_agent": "evoflow.agents.lead_agent.agent:make_lead_agent",
}


def resolve_evoflow_home() -> Path:
    raw = (os.getenv("EVOFLOW_HOME") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".evoflow").resolve()


def langgraph_api_data_dir(home: Path | None = None) -> Path:
    base = home or resolve_evoflow_home()
    d = base / ".langgraph_api"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve_n_jobs_per_worker() -> int:
    """Match in-process Gateway mount (``lazy_langgraph`` default 10).

    ``langgraph_api.cli.run_server`` forces ``N_JOBS_PER_WORKER=1`` when the
    ``n_jobs_per_worker`` kwarg is omitted — that serializes *all* agent runs
    on packaged/split desktop (second chat waits until the first finishes).
    """
    raw = (os.environ.get("N_JOBS_PER_WORKER") or "").strip()
    if raw:
        try:
            n = int(raw)
            if n > 0:
                return n
        except ValueError:
            logger.warning("invalid N_JOBS_PER_WORKER=%r; using 10", raw)
    return 10


def _apply_multi_session_concurrency_env() -> None:
    """Parity with ``app.gateway.lazy_langgraph`` for split ``--mode langgraph``."""
    import sys

    # Multi-session: isolate each LG job loop so chat A does not starve chat B
    # on a shared asyncio loop. Opt out with EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS=0.
    _force_iso = (os.environ.get("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS") or "1").strip().lower()
    if _force_iso in ("0", "false", "no", "off"):
        os.environ["EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS"] = "0"
        if sys.platform == "win32":
            os.environ["BG_JOB_ISOLATED_LOOPS"] = "false"
        else:
            os.environ.setdefault("BG_JOB_ISOLATED_LOOPS", "true")
    else:
        os.environ["EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS"] = "1"
        os.environ["BG_JOB_ISOLATED_LOOPS"] = "true"

    n_jobs = _resolve_n_jobs_per_worker()
    os.environ["N_JOBS_PER_WORKER"] = str(n_jobs)
    try:
        from evoflow.collab.subtask_stream_trace import log_multi_session_runtime_banner

        log_multi_session_runtime_banner(source="langgraph_split_runtime")
    except Exception:
        logger.debug("multi-session runtime banner skipped", exc_info=True)


def apply_langgraph_server_env(*, home: Path | None = None) -> dict[str, str]:
    """Point LangGraph API at a sqlite file under ``EVOFLOW_HOME`` (not ``:memory:``).

    Tauri / ``gateway_entry --mode langgraph`` call this before ``run_server`` so
    thread registry survives process restarts when paired with EvoFlow checkpointer config.
    """
    from evoflow.desktop_stdio import apply_windows_stdio_fixes

    apply_windows_stdio_fixes()
    # Register pydantic ToolRuntime.context warning filter before graph workers import tools.
    import evoflow.agents.lead_agent.runtime_context  # noqa: F401

    _apply_multi_session_concurrency_env()

    data_dir = langgraph_api_data_dir(home)
    db_file = data_dir / "langgraph.db"
    db_uri = f"sqlite:///{db_file.as_posix()}"
    env_patch = {
        "DATABASE_URI": db_uri,
        "REDIS_URI": "fake",
        "LANGGRAPH_DISABLE_FILE_PERSISTENCE": "false",
        "N_JOBS_PER_WORKER": os.environ["N_JOBS_PER_WORKER"],
    }
    for k, v in env_patch.items():
        os.environ.setdefault(k, v)
    logger.info(
        "LangGraph runtime env: DATABASE_URI=%s data_dir=%s N_JOBS_PER_WORKER=%s",
        db_uri,
        data_dir,
        os.environ.get("N_JOBS_PER_WORKER"),
    )
    # NOTE: apply_langgraph_command_patch() is NOT called here.
    # It must run AFTER ``import langgraph_api.server`` (below) so that
    # ``import langgraph_api.command`` inside the patch hits sys.modules
    # instead of triggering the sentence_transformers -> torch -> sklearn
    # import chain that hangs on Windows.
    try:
        from evoflow.langchain_agenerate_cancel_patch import apply_langchain_agenerate_cancel_patch

        apply_langchain_agenerate_cancel_patch()
    except Exception:
        logger.debug("langchain agenerate cancel patch skipped", exc_info=True)
    return env_patch


def find_langgraph_json() -> Path | None:
    override = (os.getenv("EVOFLOW_LANGGRAPH_JSON") or "").strip()
    if override:
        p = Path(override).expanduser()
        if p.is_file():
            return p.resolve()
    # packaging/windows/gateway_entry.py -> backend/langgraph.json
    here = Path(__file__).resolve()
    for base in (here.parents[3], here.parents[2], Path.cwd()):
        candidate = base / "langgraph.json"
        if candidate.is_file():
            return candidate.resolve()
    return None


def load_langgraph_server_config() -> dict[str, Any]:
    path = find_langgraph_json()
    if not path:
        logger.warning("langgraph.json not found; using default graphs only")
        return {"graphs": dict(_DEFAULT_GRAPHS)}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"graphs": dict(_DEFAULT_GRAPHS)}
        graphs = data.get("graphs")
        if not isinstance(graphs, dict) or not graphs:
            data["graphs"] = dict(_DEFAULT_GRAPHS)
        return data
    except Exception:
        logger.exception("Failed to read %s", path)
        return {"graphs": dict(_DEFAULT_GRAPHS)}


def run_server_kwargs() -> dict[str, Any]:
    """Keyword args for ``langgraph_api.cli.run_server`` (embedded / desktop LangGraph).

    Always pass ``n_jobs_per_worker``: upstream defaults the kwarg to ``1`` and
    overwrites ``N_JOBS_PER_WORKER`` env, which breaks concurrent chats on
    packaged split-process desktop.
    """
    apply_langgraph_server_env()
    cfg = load_langgraph_server_config()
    graphs = cfg.get("graphs") if isinstance(cfg.get("graphs"), dict) else dict(_DEFAULT_GRAPHS)
    checkpointer = cfg.get("checkpointer")
    n_jobs = _resolve_n_jobs_per_worker()
    out: dict[str, Any] = {
        "graphs": graphs,
        "reload": False,
        "open_browser": False,
        "allow_blocking": True,
        "server_level": "INFO",
        "n_jobs_per_worker": n_jobs,
        "__database_uri__": os.environ.get("DATABASE_URI"),
        "__redis_uri__": os.environ.get("REDIS_URI", "fake"),
    }
    if checkpointer:
        out["checkpointer"] = checkpointer
    return out
