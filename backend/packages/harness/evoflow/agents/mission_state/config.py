from __future__ import annotations

import os


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, lo: int = 1, hi: int = 10_000) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except Exception:
        return default
    return max(lo, min(hi, v))


def _env_float(name: str, default: float, *, lo: float = 0.0, hi: float = 1.0) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except Exception:
        return default
    return max(lo, min(hi, v))


# 默认开启：用户每发一条消息后，在模型第一轮回复完成时异步分析主问题/子问题（不推断场景，见 updater）。
# 关闭：EVOFLOW_MISSION_STATE_ENABLED=0
MISSION_STATE_ENABLED = _env_bool("EVOFLOW_MISSION_STATE_ENABLED", True)
# 是否在分析器中让模型输出 intent_hint（场景）。默认关闭，场景仅由 scenario() 工具显式激活。
MISSION_STATE_ANALYZE_SCENARIOS = _env_bool("EVOFLOW_MISSION_STATE_ANALYZE_SCENARIOS", False)
MISSION_STATE_DEBOUNCE_SEC = _env_int("EVOFLOW_MISSION_STATE_DEBOUNCE_SEC", 3, lo=0, hi=120)
# 传给分析器的最近 user/assistant 对数上限（不再区分 bootstrap/incremental 窗口）。
MISSION_STATE_ANALYSIS_PAIRS = _env_int("EVOFLOW_MISSION_STATE_ANALYSIS_PAIRS", 5, lo=1, hi=12)
# Deprecated aliases — all map to MISSION_STATE_ANALYSIS_PAIRS when unset.
MISSION_STATE_BOOTSTRAP_PAIRS = _env_int(
    "EVOFLOW_MISSION_STATE_BOOTSTRAP_PAIRS",
    MISSION_STATE_ANALYSIS_PAIRS,
    lo=1,
    hi=12,
)
MISSION_STATE_INCREMENTAL_PAIRS = _env_int(
    "EVOFLOW_MISSION_STATE_INCREMENTAL_PAIRS",
    MISSION_STATE_ANALYSIS_PAIRS,
    lo=1,
    hi=12,
)
MISSION_STATE_REBOOTSTRAP_PAIRS = _env_int(
    "EVOFLOW_MISSION_STATE_REBOOTSTRAP_PAIRS",
    MISSION_STATE_ANALYSIS_PAIRS,
    lo=1,
    hi=12,
)
MISSION_STATE_MIN_OBJECTIVE_CONFIDENCE = _env_float("EVOFLOW_MISSION_STATE_MIN_CONFIDENCE", 0.6)
MISSION_STATE_DRIFT_CONSECUTIVE_THRESHOLD = _env_int("EVOFLOW_MISSION_STATE_DRIFT_THRESHOLD", 2, lo=1, hi=10)
MISSION_STATE_INCLUDE_READ_REGISTRY = _env_bool("EVOFLOW_MISSION_STATE_INCLUDE_READ_REGISTRY", True)
# Inject ``<mission_state>`` / ``<files_already_read>`` into the system prompt. Default off.
MISSION_STATE_PROMPT_INJECTION_ENABLED = _env_bool("EVOFLOW_MISSION_STATE_PROMPT_INJECTION", False)

# Durable retry/backoff (persist failed updates to disk and retry later)
MISSION_STATE_RETRY_ENABLED = _env_bool("EVOFLOW_MISSION_STATE_RETRY_ENABLED", True)
MISSION_STATE_RETRY_MAX_ATTEMPTS = _env_int("EVOFLOW_MISSION_STATE_RETRY_MAX_ATTEMPTS", 5, lo=0, hi=50)
MISSION_STATE_RETRY_BASE_DELAY_SEC = _env_int("EVOFLOW_MISSION_STATE_RETRY_BASE_DELAY_SEC", 3, lo=1, hi=600)
MISSION_STATE_RETRY_MAX_DELAY_SEC = _env_int("EVOFLOW_MISSION_STATE_RETRY_MAX_DELAY_SEC", 60, lo=1, hi=3600)
# Background retry scanner interval when no due items (seconds).
MISSION_STATE_RETRY_IDLE_POLL_SEC = _env_int("EVOFLOW_MISSION_STATE_RETRY_IDLE_POLL_SEC", 15, lo=5, hi=300)
