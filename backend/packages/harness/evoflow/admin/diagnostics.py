"""System diagnostics over known EvoFlow log sources.

Catalog + anomaly scan + shareable timeline. Used by ``platform diagnostics.*``
and ``evoflow logs …``. Path resolution mirrors desktop Gateway
(``EVOFLOW_LOGS_DIR`` → ``~/.evoflow/logs``).
"""

from __future__ import annotations

import os
import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

# ── known sources (SSOT for agents / CLI / panel alignment) ─────────────────


@dataclass(frozen=True)
class LogSource:
    id: str
    title: str
    """File name prefixes to match (daily ``{prefix}-YYYY-MM-DD.log`` or fixed)."""
    prefixes: tuple[str, ...]
    """Exact filenames (no date suffix), e.g. startup."""
    exact_names: tuple[str, ...] = ()
    when: str = ""


LOG_SOURCES: tuple[LogSource, ...] = (
    LogSource(
        id="gateway",
        title="Gateway",
        prefixes=("gateway", "gateway-stderr", "evoflow-gateway"),
        when="启动失败、后端连不上、任务/模型调用报错",
    ),
    LogSource(
        id="langgraph",
        title="LangGraph",
        prefixes=("langgraph-stderr", "langgraph", "evoflow-langgraph"),
        when="图执行 / Agent 运行时（sidecar stderr）",
    ),
    LogSource(
        id="frontend",
        title="Frontend",
        prefixes=("frontend",),
        when="界面白屏、前端 console 异常",
    ),
    LogSource(
        id="startup",
        title="Panel startup",
        prefixes=("evopanel-startup",),
        exact_names=("evopanel-startup.log",),
        when="桌面端拉起 sidecar / 端口探测失败",
    ),
    LogSource(
        id="plugin-control",
        title="Plugin / Browser",
        prefixes=("plugin-control",),
        exact_names=("plugin-control.log",),
        when="嵌入浏览器 / CDP / 插件控制",
    ),
    LogSource(
        id="boot-cycle",
        title="Boot cycle",
        prefixes=("boot-cycle",),
        exact_names=("boot-cycle.log",),
        when="打开应用 → sidecar → Gateway → UI 就绪时间线",
    ),
    LogSource(
        id="gateway-slow",
        title="Gateway slow",
        prefixes=("gateway-slow",),
        when="慢请求 / 事件循环卡顿",
    ),
    LogSource(
        id="right-stage",
        title="Right stage",
        prefixes=("right-stage",),
        when="右栏 / 工作流侧栏",
    ),
    LogSource(
        id="chat-runtime",
        title="Chat runtime",
        prefixes=("chat-runtime",),
        when="对话起停 / 点发点停 / 左右 busy 分叉（保留 7 天）",
    ),
    LogSource(
        id="chat-turn-lifecycle",
        title="Turn lifecycle",
        prefixes=("chat-turn-lifecycle",),
        when="点发送→首帧→流结束；首字超时 first_token_stall/dead 记死（保留 7 天）",
    ),
    LogSource(
        id="assistant-audit",
        title="Assistant audit",
        prefixes=("assistant-audit",),
        exact_names=("assistant-audit.log",),
        when="助手敏感操作审计",
    ),
    LogSource(
        id="guardian",
        title="Guardian",
        prefixes=("guardian", "guardian-backup"),
        when="守护进程",
    ),
    LogSource(
        id="config-audit",
        title="Config audit",
        prefixes=(),
        exact_names=("config-audit.jsonl",),
        when="配置变更审计轨迹",
    ),
    LogSource(
        id="voice-frontend",
        title="Voice frontend",
        prefixes=("voice-frontend", "前端"),
        when="语音播报前端",
    ),
    LogSource(
        id="voice-backend",
        title="Voice backend",
        prefixes=("voice-backend", "后端"),
        when="语音播报后端",
    ),
)

_SOURCE_BY_ID = {s.id: s for s in LOG_SOURCES}

# Match logging levels and common failure markers (keep precision over recall).
# HTTP statuses only after ``HTTP/1.x"`` — bare ``\b504\b`` false-hits ``.504`` ms stamps.
_ANOMALY_RE = re.compile(
    r"(?i)(?:"
    r"\b(?:ERROR|CRITICAL|FATAL|WARN(?:ING)?)\b|"
    r"traceback(?:\s*\(most recent call last\))?|"
    r"exception\b|"
    r"\bpanic\b|"
    r"econnrefused|"
    r"\btimed?\s*out\b|"
    r"\bfailed\b|"
    r'HTTP/1\.[01]"\s+(?:401|403|500|502|503|504)\b'
    r")"
)

# Explicit logger level tokens (stdlib `` - INFO - `` / uvicorn ``INFO:`` / ``[ERROR]``).
_LEVEL_TOKEN_RE = re.compile(
    r"(?:"
    r"(?:^|\s)-\s*(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s*-|"
    r"\[(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\]|"
    r"^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL):\s"
    r")",
    re.IGNORECASE,
)

# Soft diagnostic lines that match ANOMALY_RE but are not actionable failures.
_NOISE_LINE_RE = re.compile(
    r"(?i)(?:"
    r"\[ui_stream\]\s*run_end\s*正文为空|"
    r"ASR近失|"
    r"未匹配词表|"
    r"['\"]error['\"]\s*:"  # event-count dumps: {'error': 0, ...}
    r")"
)

_UVICORN_ACCESS_RE = re.compile(
    r'(?i)^INFO:\s+\S+\s+-\s+"[A-Z]+\s+.+\s+HTTP/1\.[01]"\s+(\d{3})\b'
)

_TS_RE = re.compile(r"(?P<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)")

_DATE_FILE_RE = re.compile(r"^(?P<prefix>.+)-(?P<date>\d{4}-\d{2}-\d{2})\.log$")


def resolve_logs_dir() -> Path:
    """Resolve the active logs directory (desktop-first)."""
    raw = (os.getenv("EVOFLOW_LOGS_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()

    home_logs = (Path(os.getenv("EVOFLOW_HOME", str(Path.home() / ".evoflow"))) / "logs").resolve()
    if home_logs.is_dir():
        return home_logs

    try:
        from evoflow.runtime.ports import resolve_gateway_logs_dir

        return resolve_gateway_logs_dir()
    except Exception:
        pass

    evoflow_home = (os.getenv("EVOFLOW_HOME") or "").strip()
    if evoflow_home:
        try:
            from evoflow.config.data_paths import logs_dir, normalize_evoflow_base_dir

            return logs_dir(normalize_evoflow_base_dir(Path(evoflow_home))).resolve()
        except Exception:
            p = Path(evoflow_home).expanduser().resolve()
            # Desktop often sets EVOFLOW_HOME to …/data
            if p.name.lower() == "data":
                candidate = p.parent / "logs"
                if candidate.is_dir() or not (p / "logs").is_dir():
                    return candidate.resolve()
            return (p / "logs").resolve()

    return home_logs


def _match_dated_or_exact(entry: Path, source: LogSource, *, cutoff_date) -> bool:
    name = entry.name
    if name in source.exact_names:
        return True
    m = _DATE_FILE_RE.match(name)
    if m:
        if m.group("prefix") not in source.prefixes:
            return False
        try:
            file_day = datetime.strptime(m.group("date"), "%Y-%m-%d").date()
        except ValueError:
            return False
        return file_day >= cutoff_date
    for prefix in source.prefixes:
        if name == f"{prefix}.log" or name.startswith(f"{prefix}."):
            return True
    return False


def _iter_source_files(logs_dir: Path, source: LogSource, *, hours: int) -> list[Path]:
    if not logs_dir.is_dir():
        return []
    cutoff = datetime.now() - timedelta(hours=max(1, hours))
    cutoff_date = cutoff.date()
    out: list[Path] = []

    for name in source.exact_names:
        path = logs_dir / name
        if path.is_file():
            out.append(path)

    scan_dirs = [logs_dir]
    # One-level subdirs used by voice / legacy Chinese voice folder
    for sub in ("voice", "语音播报", "debug"):
        p = logs_dir / sub
        if p.is_dir():
            scan_dirs.append(p)

    for folder in scan_dirs:
        try:
            entries = list(folder.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_file():
                continue
            if _match_dated_or_exact(entry, source, cutoff_date=cutoff_date):
                if entry not in out:
                    out.append(entry)

    out.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    return out


def _file_meta(path: Path) -> dict[str, Any]:
    try:
        st = path.stat()
        return {
            "path": str(path),
            "name": path.name,
            "size": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        }
    except OSError:
        return {"path": str(path), "name": path.name, "size": 0, "mtime": None}


def _explicit_level(line: str) -> str | None:
    m = _LEVEL_TOKEN_RE.search(line or "")
    if not m:
        return None
    raw = next((g for g in m.groups() if g), None)
    if not raw:
        return None
    u = str(raw).upper()
    if u == "WARNING":
        return "WARN"
    if u == "FATAL":
        return "CRITICAL"
    return u


def _hard_failure_marker(line: str) -> bool:
    return bool(
        re.search(
            r"(?i)traceback|exception\b|\bpanic\b|econnrefused|\btimed?\s*out\b|\bfailed\b",
            line or "",
        )
    )


def _is_noise_anomaly(line: str) -> bool:
    """Drop false positives that would otherwise flood the system-logs panel."""
    s = str(line or "")
    if not s.strip():
        return True
    if _NOISE_LINE_RE.search(s):
        # Still keep if the same line also has a real traceback / panic etc.
        return not _hard_failure_marker(s)

    access = _UVICORN_ACCESS_RE.match(s.strip())
    if access:
        code = int(access.group(1))
        # Overload shed / startup gate / client 4xx — not "fix this ERROR" noise.
        if code in {401, 403, 404, 502, 503, 504}:
            return True
        # Bare access-log 500 stays (possible server bug), classified as WARN below.

    explicit = _explicit_level(s)
    if explicit in ("INFO", "DEBUG") and not _hard_failure_marker(s):
        # e.g. INFO line that only matched because dict key ``error`` / word ERROR in prose
        return True
    return False


def _guess_level(line: str) -> str:
    explicit = _explicit_level(line)
    if explicit in ("CRITICAL", "ERROR", "WARN"):
        return explicit
    if explicit in ("INFO", "DEBUG"):
        access = _UVICORN_ACCESS_RE.match(str(line or "").strip())
        if access and int(access.group(1)) >= 500:
            return "WARN"
        if _hard_failure_marker(line):
            return "ERROR"
        return "WARN"

    u = (line or "").upper()
    if "CRITICAL" in u or "FATAL" in u:
        return "CRITICAL"
    if re.search(r"(?i)\bERROR\b", line or "") and not re.search(
        r"(?i)['\"]error['\"]\s*:", line or ""
    ):
        return "ERROR"
    if re.search(r"(?i)traceback|exception\b", line or ""):
        return "ERROR"
    if re.search(r"\bWARN(?:ING)?\b", u):
        return "WARN"
    return "ERROR"


def _parse_ts(line: str, fallback: datetime | None) -> datetime | None:
    m = _TS_RE.search(line)
    if not m:
        return fallback
    raw = m.group("ts").replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw[:26] if "%f" in fmt else raw[:19], fmt)
        except ValueError:
            continue
    return fallback


def _read_anomaly_lines(
    path: Path,
    *,
    hours: int,
    max_bytes: int = 2 * 1024 * 1024,
) -> list[dict[str, Any]]:
    try:
        size = path.stat().st_size
        mtime = datetime.fromtimestamp(path.stat().st_mtime)
    except OSError:
        return []

    cutoff = datetime.now() - timedelta(hours=max(1, hours))
    try:
        with path.open("rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                raw = f.read()
                # Drop partial first line
                nl = raw.find(b"\n")
                if nl >= 0:
                    raw = raw[nl + 1 :]
            else:
                raw = f.read()
    except OSError:
        return []

    text = raw.decode("utf-8", errors="replace")
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if not _ANOMALY_RE.search(line):
            continue
        if _is_noise_anomaly(line):
            continue
        ts = _parse_ts(line, mtime if mtime >= cutoff else None)
        if ts is not None and ts < cutoff:
            continue
        summary = re.sub(r"\s+", " ", line).strip()
        if len(summary) > 180:
            summary = summary[:177] + "…"
        events.append(
            {
                "ts": ts.isoformat(timespec="seconds") if ts else None,
                "level": _guess_level(line),
                "summary": summary,
                "file": path.name,
            }
        )
    return events


def _dedupe_burst(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse identical summaries within a short window; keep first + count."""
    if not events:
        return []
    out: list[dict[str, Any]] = []
    # key -> index in out
    open_keys: dict[str, int] = {}
    for ev in events:
        key = f"{ev.get('source')}|{ev.get('summary')}"
        idx = open_keys.get(key)
        if idx is None:
            item = {**ev, "count": 1}
            out.append(item)
            open_keys[key] = len(out) - 1
            continue
        prev = out[idx]
        prev["count"] = int(prev.get("count") or 1) + 1
        prev["last_ts"] = ev.get("ts") or prev.get("last_ts")
    return out


def list_sources(*, hours: int = 72) -> dict[str, Any]:
    """Known log catalog + which sources currently show anomalies."""
    logs_dir = resolve_logs_dir()
    hours = max(1, min(int(hours or 72), 24 * 14))
    sources_out: list[dict[str, Any]] = []
    with_errors: list[str] = []

    for src in LOG_SOURCES:
        files = _iter_source_files(logs_dir, src, hours=hours)
        error_count = 0
        latest_error_at: str | None = None
        sample: str | None = None
        for path in files:
            for ev in _read_anomaly_lines(path, hours=hours):
                error_count += 1
                latest_error_at = ev.get("ts") or latest_error_at
                if sample is None:
                    sample = ev.get("summary")
        entry = {
            "id": src.id,
            "title": src.title,
            "when": src.when,
            "prefixes": list(src.prefixes),
            "exact_names": list(src.exact_names),
            "exists": bool(files),
            "files": [_file_meta(p) for p in files[:8]],
            "has_errors": error_count > 0,
            "error_count": error_count,
            "latest_error_at": latest_error_at,
            "sample": sample,
        }
        sources_out.append(entry)
        if error_count > 0:
            with_errors.append(src.id)

    return {
        "logs_dir": str(logs_dir),
        "hours": hours,
        "sources": sources_out,
        "sources_with_errors": with_errors,
        "error_source_count": len(with_errors),
    }


def read_source_tail(
    source_id: str,
    *,
    lines: int = 400,
    hours: int = 72,
) -> dict[str, Any]:
    """Return raw text tail for one known source (for panel「选哪个看哪个」)."""
    sid = str(source_id or "").strip().lower()
    src = _SOURCE_BY_ID.get(sid)
    logs_dir = resolve_logs_dir()
    if src is None:
        return {
            "ok": False,
            "error": f"unknown source: {sid}",
            "log_name": sid,
            "path": "",
            "exists": False,
            "content": "",
            "line_count": 0,
            "logs_dir": str(logs_dir),
        }
    files = _iter_source_files(logs_dir, src, hours=max(1, hours))
    fallback_hint = ""
    if not files and sid == "langgraph":
        # In-process LG: no langgraph-stderr; show gateway file so UI is not blank.
        gw = _SOURCE_BY_ID.get("gateway")
        if gw is not None:
            files = _iter_source_files(logs_dir, gw, hours=max(1, hours))
            if files:
                fallback_hint = (
                    "未找到独立 LangGraph 文件；当前为进程内/外部 Gateway，"
                    "以下回退显示 gateway 日志（重启 Gateway 后会写 langgraph-日期.log）。"
                )
    if not files:
        return {
            "ok": True,
            "log_name": sid,
            "title": src.title,
            "path": "",
            "exists": False,
            "content": "",
            "line_count": 0,
            "logs_dir": str(logs_dir),
            "hint": f"未找到 {src.title} 日志文件（前缀 {', '.join(src.prefixes) or 'exact'}）",
        }
    path = files[0]
    max_lines = max(50, min(int(lines or 400), 5000))
    max_bytes = 2 * 1024 * 1024
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                raw = f.read()
                nl = raw.find(b"\n")
                if nl >= 0:
                    raw = raw[nl + 1 :]
            else:
                raw = f.read()
        text = raw.decode("utf-8", errors="replace")
        if text.startswith("\ufeff"):
            text = text.lstrip("\ufeff")
        all_lines = text.splitlines()
        if len(all_lines) > max_lines:
            all_lines = all_lines[-max_lines:]
        content = "\n".join(all_lines)
        out = {
            "ok": True,
            "log_name": sid,
            "title": src.title,
            "path": str(path),
            "exists": True,
            "size": size,
            "content": content,
            "line_count": len([l for l in all_lines if l.strip()]),
            "logs_dir": str(logs_dir),
            "files": [_file_meta(p) for p in files[:5]],
        }
        if fallback_hint:
            out["hint"] = fallback_hint
        return out
    except OSError as exc:
        return {
            "ok": False,
            "error": str(exc),
            "log_name": sid,
            "path": str(path),
            "exists": True,
            "content": "",
            "line_count": 0,
            "logs_dir": str(logs_dir),
        }


def scan_errors(
    *,
    hours: int = 24,
    sources: Iterable[str] | None = None,
    max_events: int = 200,
) -> dict[str, Any]:
    """Scan recent anomaly lines from selected (or all) known sources."""
    logs_dir = resolve_logs_dir()
    hours = max(1, min(int(hours or 24), 24 * 14))
    max_events = max(1, min(int(max_events or 200), 1000))

    wanted: list[LogSource]
    if sources:
        ids = [str(s).strip().lower() for s in sources if str(s).strip()]
        wanted = []
        unknown: list[str] = []
        for i in ids:
            src = _SOURCE_BY_ID.get(i)
            if src:
                wanted.append(src)
            else:
                unknown.append(i)
        if unknown and not wanted:
            return {
                "ok": False,
                "error": f"unknown sources: {', '.join(unknown)}",
                "known": list(_SOURCE_BY_ID),
            }
    else:
        wanted = list(LOG_SOURCES)
        unknown = []

    events: list[dict[str, Any]] = []
    per_source: dict[str, int] = defaultdict(int)

    for src in wanted:
        for path in _iter_source_files(logs_dir, src, hours=hours):
            for ev in _read_anomaly_lines(path, hours=hours):
                item = {**ev, "source": src.id, "source_title": src.title}
                events.append(item)
                per_source[src.id] += 1

    def _sort_key(e: dict[str, Any]) -> tuple:
        ts = e.get("ts") or ""
        return (ts, e.get("source") or "")

    events.sort(key=_sort_key, reverse=True)
    events = _dedupe_burst(events)
    truncated = len(events) > max_events
    events = events[:max_events]

    return {
        "ok": True,
        "logs_dir": str(logs_dir),
        "hours": hours,
        "sources_scanned": [s.id for s in wanted],
        "unknown_sources": unknown,
        "counts_by_source": dict(per_source),
        "sources_with_errors": [s for s, n in per_source.items() if n > 0],
        "event_count": len(events),
        "truncated": truncated,
        "events": events,
    }


def anomaly_timeline(
    *,
    hours: int = 24,
    sources: Iterable[str] | None = None,
    max_events: int = 80,
    format: str = "both",
) -> dict[str, Any]:
    """Build a shareable anomaly timeline (markdown + structured events)."""
    scan = scan_errors(hours=hours, sources=sources, max_events=max_events)
    if scan.get("ok") is False:
        return scan

    fmt = (format or "both").strip().lower()
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    logs_dir = scan["logs_dir"]
    with_err = scan.get("sources_with_errors") or []
    events = scan.get("events") or []

    lines = [
        "### EvoFlow 异常时间线",
        f"- 范围：最近 {scan['hours']} 小时",
        f"- 日志目录：`{logs_dir}`",
        f"- 生成时间：{now}",
        f"- 有报错的源：{', '.join(with_err) if with_err else '无'}",
        "",
        "| 时间 | 来源 | 级别 | 次数 | 摘要 |",
        "|---|---|---|---|---|",
    ]
    for ev in events:
        ts = ev.get("ts") or "—"
        count = ev.get("count") or 1
        last = ev.get("last_ts")
        if last and last != ts and count > 1:
            ts = f"{ts} ~ {last}"
        summary = str(ev.get("summary") or "").replace("|", "\\|")
        lines.append(f"| {ts} | {ev.get('source')} | {ev.get('level')} | {count} | {summary} |")

    if not events:
        lines.append("| — | — | — | — | 窗口内未匹配到异常行 |")

    # Short conclusion for share
    if not with_err:
        conclusion = "最近窗口内未发现匹配的 ERROR/异常行。若仍有问题，说明现象与大概时间以便扩大检索。"
        suggestions = [
            "确认 EvoFlow 已启动并写过日志（目录存在且有当日文件）",
            "用 diagnostics.scan 指定 source=gateway 并加大 hours",
        ]
    else:
        top = with_err[0]
        conclusion = f"异常主要出现在 **{top}**" + (f" 等 {len(with_err)} 个源" if len(with_err) > 1 else "") + "。请优先把该源末尾日志与本时间线一起转发。"
        suggestions = [
            f'优先查看 platform diagnostics.scan sources=["{top}"] 或 evoflow logs scan --source {top}',
            "把本 markdown 时间线原样转发给协助排查的人",
            "敏感字段（API Key / token）转发前请打码",
        ]

    lines.extend(
        [
            "",
            "**结论**",
            conclusion,
            "",
            "**建议**",
            *[f"{i}. {s}" for i, s in enumerate(suggestions, 1)],
        ]
    )
    markdown = "\n".join(lines)

    out: dict[str, Any] = {
        "ok": True,
        "logs_dir": logs_dir,
        "hours": scan["hours"],
        "sources_with_errors": with_err,
        "counts_by_source": scan.get("counts_by_source") or {},
        "event_count": scan.get("event_count") or 0,
        "conclusion": conclusion,
        "suggestions": suggestions,
        "generated_at": now,
    }
    if fmt in ("both", "json", "events"):
        out["events"] = events
    if fmt in ("both", "markdown", "md"):
        out["markdown"] = markdown
    return out
