"""Dedicated feishu-inbound-trace.log survives restarts for media coalesce debug."""

from __future__ import annotations

import logging
from pathlib import Path


def test_feishu_inbound_trace_writes_file(tmp_path, monkeypatch):
    # 【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    # 2026-11-03 `298d4d0a` 把 trace 改成**默认关闭**
    # （`_disabled()` 用 `env_flag(..., default=False)`），只在
    # `EVOFLOW_FEISHU_INBOUND_TRACE_LOG` 显式开启时才落盘。
    # 本用例没跟着改 → `log_feishu_inbound_trace` 直接早退，文件不存在，必红。
    # 被测语义是「开启后写文件」，所以显式开启而不是放宽断言。
    monkeypatch.setenv("EVOFLOW_FEISHU_INBOUND_TRACE_LOG", "1")
    monkeypatch.setenv("EVOFLOW_FEISHU_INBOUND_TRACE_LOG_DIR", str(tmp_path))
    monkeypatch.delenv("EVOFLOW_FEISHU_INBOUND_TRACE_LOG_FILE", raising=False)

    # Reset module singleton so FileHandler attaches to tmp dir.
    import app.channels.feishu_inbound_trace_log as mod

    mod._CONFIGURED = False
    lg = logging.getLogger(mod._LOGGER_NAME)
    for h in list(lg.handlers):
        lg.removeHandler(h)

    from app.channels.feishu_inbound_trace_log import (
        feishu_inbound_trace_log_path,
        log_feishu_inbound_trace,
    )

    path = feishu_inbound_trace_log_path()
    assert path.parent == Path(tmp_path).resolve()
    log_feishu_inbound_trace(
        "收包解析",
        account_id="analyst",
        chat_id="oc_test",
        msg_id="om_1",
        feishu_type="file",
        refs=1,
        ref_names=["report.docx"],
    )
    assert path.is_file()
    body = path.read_text(encoding="utf-8")
    assert "飞书入站" in body
    assert "收包解析" in body
    assert "report.docx" in body
