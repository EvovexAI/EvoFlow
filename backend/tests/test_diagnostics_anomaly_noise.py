"""System-logs anomaly scan: drop known false positives."""

from __future__ import annotations

from evoflow.admin.diagnostics import (
    _ANOMALY_RE,
    _guess_level,
    _is_noise_anomaly,
)


def test_ms_timestamp_not_http_status() -> None:
    line = (
        "2026-11-05 12:44:12.504 [前端] [唤醒] [TRACE=-] "
        "ASR近失 final 「小微对话」（未匹配词表）"
    )
    assert not _ANOMALY_RE.search(line)


def test_uvicorn_shed_503_is_noise() -> None:
    line = 'INFO: 127.0.0.1:55359 - "GET /api/proactive/roles/xiaomi HTTP/1.1" 503'
    assert _ANOMALY_RE.search(line)
    assert _is_noise_anomaly(line)


def test_ui_stream_empty_body_info_is_noise() -> None:
    line = (
        "2026-11-05 12:45:50 - app.gateway.sse_ui_normalize - INFO - "
        "[ui_stream] run_end 正文为空 已锚定=True 流式正文长度=0 "
        "上游事件={'metadata': 1, 'error': 0}"
    )
    assert _is_noise_anomaly(line)


def test_real_error_still_counts() -> None:
    line = (
        "2026-11-05 12:45:49 - app.gateway.foo - ERROR - "
        "database connection failed"
    )
    assert _ANOMALY_RE.search(line)
    assert not _is_noise_anomaly(line)
    assert _guess_level(line) == "ERROR"


def test_frontend_stream_stop_abnormal_counts() -> None:
    line = (
        '[2026-11-05 12:45:49.957] [ERROR] [stream-stop] abnormal '
        'trigger=stream_error hasEndMarker=false '
        '{"kind":"abnormal","trigger":"stream_error"}'
    )
    assert _ANOMALY_RE.search(line)
    assert not _is_noise_anomaly(line)
    assert _guess_level(line) == "ERROR"
