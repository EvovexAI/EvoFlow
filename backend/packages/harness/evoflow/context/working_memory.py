"""Per-thread read registry (sync); rendered inside ``<mission_state>`` — no separate LLM digest."""

from __future__ import annotations

import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

from evoflow.config.working_memory_config import get_working_memory_config

_lock = threading.Lock()
_store: dict[str, _ThreadMemory] = {}

_SUMMARY_PATH_RE = re.compile(r"^\s*path:\s*(.+?)\s*$", re.MULTILINE)
_POST_SEARCH_BLOCK_RE = re.compile(r"<post_search_reads\b[\s\S]*?</post_search_reads>", re.IGNORECASE)
_WORKER_READS_BLOCK_RE = re.compile(r"<worker_code_reads>[\s\S]*?</worker_code_reads>", re.IGNORECASE)


@dataclass
class ReadEntry:
    path: str
    offset: int | None = None
    limit: int | None = None
    tool_name: str = "read_file"
    note: str = ""
    read_at: float = field(default_factory=time.time)


@dataclass
class WriteEntry:
    path: str
    tool_name: str = "write"
    written_at: float = field(default_factory=time.time)


@dataclass
class _ThreadMemory:
    entries: OrderedDict[str, ReadEntry] = field(default_factory=OrderedDict)
    writes: OrderedDict[str, WriteEntry] = field(default_factory=OrderedDict)
    turn_started_at: float = 0.0


def _normalize_path_key(path: str) -> str:
    p = str(path or "").strip().replace("\\", "/")
    if p.startswith("skill:"):
        return p.lower()
    if ":" in p and not p.startswith("/") and re.match(r"^[A-Za-z]:", p) is None:
        p = p.split(":", 1)[0]
    return p.lower()


def _entry_key(path: str, offset: int | None, limit: int | None) -> str:
    base = _normalize_path_key(path)
    if offset is not None or limit is not None:
        return f"{base}@{offset or 0}:{limit or 0}"
    return base


def _line_hint(offset: int | None, limit: int | None) -> str:
    if offset is None and limit is None:
        return "full"
    if offset is not None and limit is not None:
        return f"{offset}-{offset + limit - 1}"
    if offset is not None:
        return f"from {offset}"
    return f"first {limit} lines"


def _rule_note_from_read_output(output: str, *, max_chars: int) -> str:
    text = str(output or "").strip()
    if not text or text.startswith("Error:"):
        return ""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("```")]
    sample = " ".join(lines[:6])
    sample = re.sub(r"\s+", " ", sample).strip()
    if len(sample) > max_chars:
        sample = sample[: max_chars - 1] + "…"
    return sample


def _paths_from_batch_read_output(output: str) -> list[tuple[str, int | None, int | None]]:
    """Paths from post_search_reads / worker_code_reads bodies (actual reads, not catalog)."""
    found: list[tuple[str, int | None, int | None]] = []
    seen: set[str] = set()

    def add(raw: str, offset: int | None = None, limit: int | None = None) -> None:
        rel = str(raw or "").strip()
        if not rel:
            return
        if ":" in rel and not rel.startswith("/") and re.match(r"^[A-Za-z]:[/\\]", rel) is None:
            path_part, maybe_line = rel.rsplit(":", 1)
            if maybe_line.isdigit():
                rel = path_part
                offset = int(maybe_line)
        key = _entry_key(rel, offset, limit)
        if key in seen:
            return
        seen.add(key)
        found.append((rel, offset, limit))

    for block in _POST_SEARCH_BLOCK_RE.findall(output) + _WORKER_READS_BLOCK_RE.findall(output):
        for pm in _SUMMARY_PATH_RE.finditer(block):
            add(pm.group(1))

    return found


def register_read(
    thread_id: str,
    *,
    path: str,
    tool_name: str = "read_file",
    offset: int | None = None,
    limit: int | None = None,
    note: str = "",
) -> None:
    cfg = get_working_memory_config()
    if not cfg.enabled:
        return
    tid = str(thread_id or "").strip()
    p = str(path or "").strip()
    if not tid or not p:
        return

    key = _entry_key(p, offset, limit)
    entry = ReadEntry(
        path=p.replace("\\", "/"),
        offset=offset,
        limit=limit,
        tool_name=str(tool_name or "read_file").strip().lower(),
        note=str(note or "").strip(),
        read_at=time.time(),
    )

    with _lock:
        mem = _store.setdefault(tid, _ThreadMemory())
        if key in mem.entries:
            mem.entries.move_to_end(key)
            old = mem.entries[key]
            if note and not old.note:
                old.note = note
        else:
            mem.entries[key] = entry
        while len(mem.entries) > cfg.max_entries:
            mem.entries.popitem(last=False)

    try:
        from evoflow.agents.mission_state.refresh import maybe_refresh_mission_on_read

        maybe_refresh_mission_on_read(tid)
    except Exception:
        pass


def register_tool_result(
    thread_id: str,
    *,
    tool_name: str,
    tool_input: dict | None,
    output_text: str,
) -> None:
    """Record reads from read_file / search_code_index / worker search deliverables."""
    cfg = get_working_memory_config()
    if not cfg.enabled:
        return
    text = str(output_text or "")
    name = str(tool_name or "").strip().lower()
    args = tool_input if isinstance(tool_input, dict) else {}

    try:
        from evoflow.exploration.exploration_budget import record_tool_attempt

        record_tool_attempt(
            thread_id,
            tool_name=name,
            tool_input=args,
            output_text=text,
        )
    except Exception:
        pass

    if not text.strip() or text.strip().startswith("Error:"):
        return

    # Track file modifications for mission_state sync (优化1)
    if name in ("write", "replace", "delete"):
        _wpath = str(args.get("path") or "").strip()
        if _wpath:
            register_write(thread_id, path=_wpath, tool_name=name)
        return

    if name in ("read_file", "read"):
        path = str(args.get("path") or "").strip()
        if not path:
            return
        offset = args.get("offset")
        limit = args.get("limit")
        try:
            off = int(offset) if offset is not None else None
        except (TypeError, ValueError):
            off = None
        try:
            lim = int(limit) if limit is not None else None
        except (TypeError, ValueError):
            lim = None
        note = _rule_note_from_read_output(text, max_chars=cfg.rule_note_max_chars)
        register_read(thread_id, path=path, tool_name=name, offset=off, limit=lim, note=note)
        return

    if name in ("search_code_index", "worker"):
        for path, off, lim in _paths_from_batch_read_output(text):
            register_read(thread_id, path=path, tool_name=name, offset=off, limit=lim, note="batch read snippet")


def register_write(
    thread_id: str,
    *,
    path: str,
    tool_name: str = "write",
) -> None:
    """Record a file modification (write/replace/delete) for mission_state sync (优化1)."""
    cfg = get_working_memory_config()
    if not cfg.enabled:
        return
    tid = str(thread_id or "").strip()
    p = str(path or "").strip()
    if not tid or not p:
        return
    key = _normalize_path_key(p)
    entry = WriteEntry(path=p.replace("\\", "/"), tool_name=str(tool_name or "write").strip().lower(), written_at=time.time())
    with _lock:
        mem = _store.setdefault(tid, _ThreadMemory())
        mem.writes[key] = entry  # dedup by path; keep latest
        while len(mem.writes) > cfg.max_entries:
            mem.writes.popitem(last=False)


def list_write_entries(thread_id: str) -> list[WriteEntry]:
    """Return recently modified file paths (优化1 + 优化3)."""
    tid = str(thread_id or "").strip()
    with _lock:
        mem = _store.get(tid)
        if not mem:
            return []
        return list(mem.writes.values())


def format_files_modified_section(thread_id: str) -> str:
    """Sync modified-files list for injection under ``<mission_state>`` (优化1)."""
    entries = list_write_entries(thread_id)
    if not entries:
        return ""
    lines = [
        "<files_modified>",
        "Files modified this session — corresponding subproblems may be done; verify before re-working.",
        "",
    ]
    for e in entries:
        lines.append(f"- {e.path} (via {e.tool_name})")
    lines.append("</files_modified>")
    return "\n".join(lines)


def clear_registry(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _lock:
        _store.pop(tid, None)


def list_entries(thread_id: str) -> list[ReadEntry]:
    tid = str(thread_id or "").strip()
    with _lock:
        mem = _store.get(tid)
        if not mem:
            return []
        return list(mem.entries.values())


def mark_turn_start(thread_id: str) -> None:
    """Mark the start of a new user turn — turn_read_count only counts reads from this point."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _lock:
        mem = _store.setdefault(tid, _ThreadMemory())
        mem.turn_started_at = time.time()


def turn_read_count(thread_id: str) -> int:
    """Count reads registered since the current turn started (falls back to total if no turn marked)."""
    tid = str(thread_id or "").strip()
    with _lock:
        mem = _store.get(tid)
        if not mem:
            return 0
        if mem.turn_started_at == 0.0:
            return len(mem.entries)
        return sum(1 for e in mem.entries.values() if e.read_at >= mem.turn_started_at)


def format_write_registry_for_analyzer(thread_id: str) -> str:
    """Compact modified-files list for mission_state background analyzer (优化1)."""
    entries = list_write_entries(thread_id)
    if not entries:
        return ""
    lines: list[str] = []
    for e in entries:
        lines.append(f"- {e.path} (via {e.tool_name})")
    return "\n".join(lines)


def format_files_already_read_section(thread_id: str) -> str:
    """Sync path list for injection under ``<mission_state>`` (no LLM)."""
    cfg = get_working_memory_config()
    if not cfg.enabled:
        return ""
    entries = list_entries(thread_id)
    if not entries:
        return ""

    lines = [
        "<files_already_read>",
        "Do not re-read these paths unless editing or prior snippet was insufficient.",
        "",
    ]
    show = entries[-cfg.footer_max_entries :]
    for e in show:
        hint = _line_hint(e.offset, e.limit)
        suffix = f" — {e.note}" if e.note else ""
        lines.append(f"- {e.path} ({hint}, via {e.tool_name}){suffix}")
    if len(entries) > len(show):
        lines.append(f"- … (+{len(entries) - len(show)} more in registry)")
    lines.append("</files_already_read>")
    return "\n".join(lines)


def format_read_registry_for_analyzer(thread_id: str, *, max_entries: int = 16) -> str:
    """Compact read list for mission_state background analyzer (paths + short notes)."""
    cfg = get_working_memory_config()
    if not cfg.enabled:
        return ""
    entries = list_entries(thread_id)
    if not entries:
        return ""
    lines: list[str] = []
    for e in entries[-max_entries:]:
        hint = _line_hint(e.offset, e.limit)
        note = f" — {e.note}" if e.note else ""
        lines.append(f"- {e.path} ({hint}, {e.tool_name}){note}")
    if len(entries) > max_entries:
        lines.append(f"- … (+{len(entries) - max_entries} more)")
    return "\n".join(lines)
