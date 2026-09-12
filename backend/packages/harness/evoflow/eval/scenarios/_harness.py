"""Isolated temp-DB harness for scenario eval cases.

Scenario handlers must not mutate the production ``evoflow.db``.
Each scenario runs inside a temporary ``EVOFLOW_HOME`` / ``EVOFLOW_DB_PATH``.
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
import traceback
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

Assertion = dict[str, Any]
ScenarioFn = Callable[[Path], dict[str, Any]]

# Serialize isolation: scenarios mutate process-global EVOFLOW_* + shared DB conn.
_ISOLATION_LOCK = threading.RLock()


def resolve_eval_config_yaml() -> Path | None:
    """Locate repo ``config.yaml`` so tool catalog works outside EvoFlow cwd.

    Smoke subprocesses use ``cwd=harness``; without ``EVOFLOW_CONFIG_PATH``,
    ``get_app_config()`` fails and ``resolve_agent_tool_names_for_agent`` returns [].
    """
    env = (os.environ.get("EVOFLOW_CONFIG_PATH") or "").strip()
    if env:
        p = Path(env)
        if p.is_file():
            return p.resolve()
    here = Path(__file__).resolve()
    # .../backend/packages/harness/evoflow/eval/scenarios/_harness.py → EvoFlow/
    candidates = [
        here.parents[6] / "config.yaml",
        here.parents[3] / "config.yaml",
        Path.cwd() / "config.yaml",
        Path.cwd().parent / "config.yaml",
    ]
    for c in candidates:
        try:
            if c.is_file():
                return c.resolve()
        except OSError:
            continue
    return None


def _invalidate_tool_caches() -> None:
    try:
        from evoflow.tools.tools import invalidate_available_tools_cache

        invalidate_available_tools_cache()
    except Exception:  # noqa: BLE001
        pass
    try:
        from evoflow.session_tool_binding.agent_tools import invalidate_agent_tool_names_cache

        invalidate_agent_tool_names_cache()
    except Exception:  # noqa: BLE001
        pass


def _now_ms() -> int:
    return int(time.time() * 1000)


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return str(value)


def check(
    name: str,
    ok: bool,
    detail: str = "",
    *,
    expected: Any = None,
    actual: Any = None,
    inputs: Any = None,
    api: str = "",
    evidence: Any = None,
    plane: str = "",
) -> Assertion:
    """Build one auditable assertion with expected vs actual evidence."""
    row: Assertion = {
        "name": name,
        "ok": bool(ok),
        "detail": detail or ("pass" if ok else "fail"),
        "mock": False,
    }
    if expected is not None:
        row["expected"] = _jsonable(expected)
    if actual is not None:
        row["actual"] = _jsonable(actual)
    if inputs is not None:
        row["inputs"] = _jsonable(inputs)
    if api:
        row["api"] = api
    if evidence is not None:
        row["evidence"] = _jsonable(evidence)
    if plane:
        row["plane"] = plane
        ev = row.get("evidence")
        if isinstance(ev, dict):
            row["evidence"] = {**ev, "plane": plane}
        else:
            row["evidence"] = {"plane": plane}
    # Convenience: if only detail was given as legacy 3rd arg and no actual, mirror it
    if "actual" not in row and detail and detail not in ("pass", "fail"):
        row["actual"] = detail
    return row


def finalize(
    assertions: list[Assertion],
    *,
    metrics: dict[str, Any] | None = None,
    duration_ms: int = 0,
    steps: list[dict[str, Any]] | None = None,
    apis: list[str] | None = None,
    require_persist: bool = True,
    min_persist: int = 1,
) -> dict[str, Any]:
    """Build a standard scenario result from assertion list.

    When ``require_persist`` is True (default), at least ``min_persist`` assertions
    must declare ``plane`` of ``sqlite`` or ``json_store`` (durable state reconcile).
    """
    assertions = list(assertions)
    _persist_planes = ("sqlite", "json_store", "api")
    persist_n = sum(1 for a in assertions if a.get("plane") in _persist_planes)
    if require_persist and persist_n < int(min_persist):
        assertions.append(
            check(
                "persist_reconcile_required",
                False,
                inputs={"min_persist": min_persist, "found": persist_n},
                expected=f">={min_persist} sqlite|json_store|api assertions",
                actual=persist_n,
                api="eval.finalize",
                plane="sqlite",
                evidence={
                    "hint": "Use evoflow.eval.scenarios._persist helpers or plane=api for live Gateway",
                },
            )
        )
        # plane set but ok=False — still counts as attempted reconcile that failed gate
        persist_n = sum(1 for a in assertions if a.get("plane") in _persist_planes)

    total = len(assertions)
    passed = sum(1 for a in assertions if a.get("ok"))
    failed = [a for a in assertions if not a.get("ok")]
    ok = total > 0 and not failed
    score = round((passed / total) * 100.0, 1) if total else 0.0
    detail_parts = [
        f"{a['name']}: {a.get('detail') or ('ok' if a['ok'] else 'fail')}" for a in failed
    ]
    api_list = list(apis or [])
    if not api_list:
        for a in assertions:
            if a.get("api") and a["api"] not in api_list:
                api_list.append(str(a["api"]))
    return {
        "ok": ok,
        "score": score,
        "assertions": assertions,
        "metrics": {
            **(metrics or {}),
            "assertion_total": total,
            "assertion_passed": passed,
            "assertion_failed": len(failed),
            "persist_assertion_total": persist_n,
        },
        "steps": steps or [],
        "detail": "; ".join(detail_parts) if detail_parts else "all assertions passed",
        "duration_ms": duration_ms,
        "status": "passed" if ok else "failed",
        "provenance": {
            "mock": False,
            "isolation": "temp_EVOFLOW_HOME",
            "data_plane": "real_admin_harness_apis+sqlite_json_reconcile",
            "apis_called": api_list,
            "persist_checks": persist_n,
        },
    }


@contextmanager
def isolated_home() -> Iterator[Path]:
    """Yield a temp home with env + DB connection isolated; restore afterwards."""
    with _ISOLATION_LOCK:
        saved = {
            "EVOFLOW_HOME": os.environ.get("EVOFLOW_HOME"),
            "EVOFLOW_DB_PATH": os.environ.get("EVOFLOW_DB_PATH"),
            "EVOFLOW_DATA_DIR": os.environ.get("EVOFLOW_DATA_DIR"),
            "EVOFLOW_CONFIG_PATH": os.environ.get("EVOFLOW_CONFIG_PATH"),
        }
        from evoflow.persistence.db import get_db, reset_db_for_tests

        try:
            from evoflow.items.store import reset_store_for_tests
        except Exception:  # noqa: BLE001
            reset_store_for_tests = None  # type: ignore[assignment]

        try:
            from evoflow.config.paths import reset_paths_cache
        except Exception:  # noqa: BLE001
            reset_paths_cache = None  # type: ignore[assignment]

        try:
            from evoflow.config.app_config import reset_app_config
        except Exception:  # noqa: BLE001
            reset_app_config = None  # type: ignore[assignment]

        try:
            from evoflow.admin.platform_actions import reset_registry_cache
        except Exception:  # noqa: BLE001
            reset_registry_cache = None  # type: ignore[assignment]

        # mkdtemp + ignore_errors: Windows often locks sqlite until GC; don't fail scenarios.
        import gc
        import shutil

        tmp = tempfile.mkdtemp(prefix="evoflow_eval_scene_")
        root = Path(tmp)
        try:
            db_path = root / "data" / "app" / "evoflow.db"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            os.environ["EVOFLOW_HOME"] = str(root)
            os.environ["EVOFLOW_DB_PATH"] = str(db_path)
            os.environ.pop("EVOFLOW_DATA_DIR", None)
            cfg = resolve_eval_config_yaml()
            if cfg is not None:
                os.environ["EVOFLOW_CONFIG_PATH"] = str(cfg)

            reset_db_for_tests()
            if reset_store_for_tests:
                reset_store_for_tests()
            if reset_paths_cache:
                reset_paths_cache()
            if reset_app_config:
                reset_app_config()
            if reset_registry_cache:
                reset_registry_cache()
            _invalidate_tool_caches()
            get_db()  # migrate schema into temp DB
            yield root
        finally:
            reset_db_for_tests()
            if reset_store_for_tests:
                reset_store_for_tests()
            if reset_paths_cache:
                reset_paths_cache()
            if reset_app_config:
                reset_app_config()
            if reset_registry_cache:
                reset_registry_cache()
            _invalidate_tool_caches()

            for key, val in saved.items():
                if val is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = val

            reset_db_for_tests()
            if reset_paths_cache:
                reset_paths_cache()
            if reset_app_config:
                reset_app_config()
            _invalidate_tool_caches()
            try:
                get_db()
            except Exception:  # noqa: BLE001
                pass
            gc.collect()
            shutil.rmtree(tmp, ignore_errors=True)


def run_scenario(fn: ScenarioFn) -> dict[str, Any]:
    """Execute a scenario function inside an isolated home and normalize result."""
    t0 = _now_ms()
    try:
        with isolated_home() as home:
            raw = fn(home) or {}
            if isinstance(raw, dict):
                prov = dict(raw.get("provenance") or {})
                prov.setdefault("mock", False)
                prov.setdefault("isolation", "temp_EVOFLOW_HOME")
                prov["temp_home"] = str(home)
                prov["temp_db"] = str(home / "data" / "app" / "evoflow.db")
                raw["provenance"] = prov
        duration = int(raw.get("duration_ms") or (_now_ms() - t0))
        if "assertions" in raw and "ok" in raw:
            raw.setdefault("duration_ms", duration)
            raw.setdefault(
                "status",
                "passed" if raw.get("ok") else "failed",
            )
            return raw
        # Allow bare assertion list
        if isinstance(raw, dict) and "assertions" in raw:
            return finalize(
                list(raw["assertions"]),
                metrics=raw.get("metrics"),
                duration_ms=duration,
                steps=raw.get("steps"),
                apis=raw.get("apis"),
            )
        return {
            "ok": False,
            "score": 0,
            "assertions": [],
            "metrics": {},
            "detail": "scenario returned unexpected shape",
            "duration_ms": duration,
            "status": "error",
            "provenance": {"mock": False},
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "score": 0,
            "assertions": [],
            "metrics": {},
            "detail": f"{exc}\n{traceback.format_exc()[-800:]}",
            "duration_ms": _now_ms() - t0,
            "status": "error",
            "provenance": {"mock": False},
        }
