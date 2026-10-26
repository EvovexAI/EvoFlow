"""小V语音播报专用日志。

落盘目录：``{logs_dir}/语音播报/``
  - ``前端-YYYY-MM-DD.log``
  - ``后端-YYYY-MM-DD.log``

每行带 ``[TRACE=vt-…]``：一轮用户提问→助手播报共用同一 TRACE，前后端文件可交叉 grep。

核对多播 / 实时播 / 时效时重点看这四类阶段：
  - 流式正文：模型返回了什么字
  - 语音合成：何时开始/完成 TTS，合成的是哪句
  - 语音播放：前端何时真正 play，播的是哪句
  - 播放结束：何时播完（或失败）
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import Any

from app.gateway.logging_setup import prune_old_daily_logs, resolve_gateway_logs_dir

_LOCK = threading.RLock()
_DIR_NAME = "语音播报"
_streams: dict[str, Any] = {}  # "前端"|"后端" → file handle
_dates: dict[str, str] = {}
# 同文去重
_last_line_key: str | None = None
_last_line_at: float = 0.0
_dup_count = 0

# 当前协程/任务绑定的 TRACE（一轮问答）
_trace_var: ContextVar[str] = ContextVar("voice_playback_trace", default="")


def new_voice_trace(prefix: str = "vt") -> str:
    """生成短 TRACE：vt-时间戳36进制-4位随机，便于人眼扫日志。"""
    p = (prefix or "vt").strip() or "vt"
    ts = int(time.time())
    # base36 time + random
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    n = ts
    enc = ""
    while n:
        n, r = divmod(n, 36)
        enc = alphabet[r] + enc
    return f"{p}-{enc or '0'}-{secrets.token_hex(2)}"


def set_voice_trace(trace_id: str | None) -> str:
    tid = str(trace_id or "").strip()
    _trace_var.set(tid)
    return tid


def get_voice_trace() -> str:
    return str(_trace_var.get() or "").strip()


def clear_voice_trace() -> None:
    _trace_var.set("")


def voice_playback_dir() -> Path:
    d = resolve_gateway_logs_dir() / _DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def voice_log_path_today(source: str = "后端") -> Path:
    src = "前端" if "前" in str(source or "") else "后端"
    return voice_playback_dir() / f"{src}-{datetime.now().strftime('%Y-%m-%d')}.log"


def voice_log_paths_today() -> dict[str, str]:
    d = voice_playback_dir()
    day = datetime.now().strftime("%Y-%m-%d")
    return {
        "dir": str(d),
        "frontend": str(d / f"前端-{day}.log"),
        "backend": str(d / f"后端-{day}.log"),
    }


def _ensure_stream(source: str):
    src = "前端" if "前" in str(source or "") else "后端"
    today = datetime.now().strftime("%Y-%m-%d")
    if _dates.get(src) == today and _streams.get(src) is not None:
        return src
    with _LOCK:
        if _dates.get(src) == today and _streams.get(src) is not None:
            return src
        old = _streams.pop(src, None)
        if old is not None:
            try:
                old.close()
            except OSError:
                pass
        log_dir = voice_playback_dir()
        prune_old_daily_logs(log_dir, "前端")
        prune_old_daily_logs(log_dir, "后端")
        path = log_dir / f"{src}-{today}.log"
        fh = path.open("a", encoding="utf-8", newline="\n")
        _streams[src] = fh
        _dates[src] = today
        if path.stat().st_size == 0:
            fh.write(
                f"# 小V语音播报日志（{src}） path={path}\n"
                f"# 目录：{log_dir}\n"
                f"# 列：时间 [来源] [阶段] [TRACE=…] 说明\n"
                f"# TRACE：一轮提问→播报共用；grep TRACE=vt-xxx 可串起前后端\n"
                f"# 阶段：流式正文 | 语音合成 | 语音播放 | 播放结束 | 其它\n"
            )
            fh.flush()
        return src


def _clip(text: Any, limit: int = 800) -> str:
    s = str(text or "").replace("\r", " ").replace("\n", " ").strip()
    if len(s) <= limit:
        return s
    return s[: max(0, limit - 1)] + "…"


def voice_log(
    stage: str,
    message: str,
    *,
    source: str = "后端",
    detail: str | None = None,
    trace: str | None = None,
    at: str | None = None,
) -> None:
    """Append one Chinese-readable line into 前端/后端 分文件（每行带 TRACE）。"""
    global _last_line_key, _last_line_at, _dup_count
    try:
        ts = (at or "").strip() or datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        src_label = "前端" if "前" in str(source or "") else "后端"
        st = _clip(stage, 24) or "过程"
        msg = _clip(message, 1200)
        if detail:
            msg = f"{msg} | {_clip(detail, 600)}"
        tid = _clip(trace if trace is not None else get_voice_trace(), 48)
        trace_part = f"[TRACE={tid}] " if tid else "[TRACE=-] "
        key = f"{src_label}|{st}|{tid}|{msg}"
        now = time.monotonic()
        with _LOCK:
            if key == _last_line_key and now - _last_line_at < 0.4:
                _dup_count += 1
                return
            src = _ensure_stream(src_label)
            fh = _streams.get(src)
            if fh is None:
                return
            if _dup_count > 0 and _last_line_key:
                fh.write(
                    f"{ts} [{src_label}] [过程] {trace_part}（上条重复 ×{_dup_count}，已合并）\n"
                )
                _dup_count = 0
            fh.write(f"{ts} [{src_label}] [{st}] {trace_part}{msg}\n")
            fh.flush()
            _last_line_key = key
            _last_line_at = now
    except Exception as e:
        # 绝不能把异常抛回 session.run（会掐 WS）；打到标准日志便于查「后端语音日志空文件」
        try:
            logging.getLogger("evoflow.speech.voice_file_log").warning(
                "voice_log write failed: %s", e
            )
        except Exception:
            pass


def voice_playback_event(
    kind: str,
    content: str = "",
    *,
    source: str = "后端",
    extra: str = "",
    trace: str | None = None,
) -> None:
    """结构化四类打点：流式正文 / 语音合成 / 语音播放 / 播放结束。"""
    body = _clip(content, 400)
    quoted = f"「{body}」" if body else ""
    mid = (extra or "").strip()
    if body and mid:
        voice_log(kind, f"{mid} {quoted}", source=source, trace=trace)
    elif body:
        voice_log(kind, quoted, source=source, trace=trace)
    else:
        voice_log(kind, mid or kind, source=source, trace=trace)


def _format_entry_ts(raw: Any) -> str | None:
    """Prefer frontend event time so batch flush 不会把多行挤成同一秒。"""
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        # ISO：2026-10-26T03:32:41.460Z
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        # 日志统一本地墙钟（与后端 voice_log 一致）
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return dt.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    except Exception:
        return None


def voice_log_batch(entries: list[dict[str, Any]], *, default_source: str = "前端") -> int:
    """Append many frontend entries. Each: {stage, message, source?, detail?, ts?, trace?}."""
    n = 0
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        voice_log(
            str(e.get("stage") or "过程"),
            str(e.get("message") or e.get("msg") or ""),
            source=str(e.get("source") or default_source),
            detail=str(e["detail"]) if e.get("detail") is not None else None,
            trace=str(e["trace"]) if e.get("trace") is not None else None,
            at=_format_entry_ts(e.get("ts")),
        )
        n += 1
    return n
