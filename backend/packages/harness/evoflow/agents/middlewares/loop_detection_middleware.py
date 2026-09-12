"""Middleware to detect and break repetitive tool call loops.

When repetition exceeds thresholds, duplicate tool executions are blocked
(synthetic ToolMessage) and a HumanMessage hint is injected — the run keeps
going so the model can change strategy. We do not strip all tool_calls to END
the graph.
"""

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict, defaultdict
from collections.abc import Awaitable, Callable

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

logger = logging.getLogger(__name__)

# Defaults — can be overridden via constructor
_DEFAULT_WARN_THRESHOLD = 3
_DEFAULT_HARD_LIMIT = 5
_DEFAULT_WINDOW_SIZE = 20
_DEFAULT_MAX_TRACKED_THREADS = 100


def _hash_tool_calls(tool_calls: list[dict]) -> str:
    """Deterministic hash of a set of tool calls (name + args), order-independent."""
    normalized: list[dict] = []
    for tc in tool_calls:
        normalized.append(
            {
                "name": tc.get("name", ""),
                "args": tc.get("args", {}),
            }
        )
    normalized.sort(
        key=lambda tc: (
            tc["name"],
            json.dumps(tc["args"], sort_keys=True, default=str),
        )
    )
    blob = json.dumps(normalized, sort_keys=True, default=str)
    return hashlib.md5(blob.encode()).hexdigest()[:12]


def _is_supervisor_safe_repeat_callset(tool_calls: list[dict]) -> bool:
    """Supervisor poll/start/status retries are intentional — skip loop detection."""
    if not tool_calls:
        return False
    task_ids: set[str] = set()
    for tc in tool_calls:
        name = str(tc.get("name", "")).strip()
        if name != "supervisor":
            return False
        args = tc.get("args", {})
        if not isinstance(args, dict):
            return False
        action = str(args.get("action", "")).strip()
        if action not in {
            "monitor_execution_step",
            "start_execution",
            "get_status",
            "list_subtasks",
            "update_progress",
        }:
            return False
        tid = str(args.get("task_id") or "").strip()
        if tid:
            task_ids.add(tid)
    if len(task_ids) > 1:
        return False
    return True


def _is_explore_only_callset(tool_calls: list[dict]) -> bool:
    """True when every call is an explore tool (read/rg/search/list_dir/terminal/find).

    Explore-only batches skip the *global identical-batch* hash (slight arg jitter
    would never match anyway). Path-level explore fingerprints still apply via
    ``_check_explore_loops``.
    """
    if not tool_calls:
        return False
    for tc in tool_calls:
        name = _normalize_explore_tool_name(str(tc.get("name") or ""))
        if name not in _EXPLORE_CANONICAL:
            return False
    return True


def _is_explore_streak_batch(tool_calls: list[dict]) -> bool:
    """Read/list_dir/terminal (± mind_map) with no act/progress — counts toward explore streak.

    Search/discovery tools (rg, search_code_index, find, web_search, web_fetch, …) are
  excluded: legitimate multi-step research should not trip "探索过久" hard blocks.
    """
    if not tool_calls:
        return False
    saw_streak_tool = False
    for tc in tool_calls:
        raw = str(tc.get("name") or "").strip().lower()
        if raw in _ACT_OR_PROGRESS_TOOLS:
            return False
        if raw in _SEARCH_DISCOVERY_TOOLS:
            continue
        name = _normalize_explore_tool_name(raw)
        if name in _EXPLORE_STREAK_TOOLS:
            saw_streak_tool = True
            continue
        if raw == "mind_map":
            continue
        return False
    return saw_streak_tool


def _batch_has_act_or_progress(tool_calls: list[dict]) -> bool:
    for tc in tool_calls:
        raw = str(tc.get("name") or "").strip().lower()
        if raw in _ACT_OR_PROGRESS_TOOLS:
            return True
    return False


_WARNING_MSG = (
    "[LOOP DETECTED] You are repeating the same tool calls. Change strategy or summarize "
    "with results collected so far; do not repeat identical calls."
)

_BLOCK_MSG = (
    "[重复调用·已拦截] 同一工具调用已达安全上限，本次未执行。"
    "请根据已有工具结果换做法，不要重复相同调用。"
)

_EXPLORE_WARNING_MSG = (
    "[重复探索] 同一 read/rg/search 目标调用过多。请停止重复探索；"
    "若用户要求改代码/修 bug/加功能，立即 replace/write（勿再 read 同一文件近邻偏移）；"
    "若仅调研/解释则收口总结。近邻 offset（同 bucket）视为重复。"
)

_EXPLORE_BLOCK_MSG = (
    "[重复探索·已拦截] 同一探索工具目标已达上限，本次调用未执行。"
    "请根据已有工具结果换策略：replace/write 落地修改，或换文件/换 pattern；"
    "不要再次 read/rg/list_dir 同一目标。"
)

# Consecutive read/list_dir/terminal steps (± mind_map) with no write/act — warn only.
_EXPLORE_STREAK_WARN = 8
_EXPLORE_STREAK_HARD = 0  # disabled: path fingerprints already block same-target thrash
_ACT_OR_PROGRESS_TOOLS = frozenset(
    {
        "replace",
        "str_replace",
        "replace_in_file",
        "write",
        "delete",
        "ask_clarification",
        "edit_notebook",
        "panel_set",
    }
)
_EXPLORE_STREAK_WARN_MSG = (
    "[探索过久] 本轮已连续多次只读探索且未落地修改。"
    "若用户要求改代码/修 UI/修 bug：立即 replace/write 或 ask_clarification；"
    "禁止再为记账调用 mind_map。若仅调研则收口总结。"
)
_EXPLORE_STREAK_BLOCK_MSG = (
    "[探索过久·已拦截] 连续探索未改代码已达上限，本次探索工具未执行。"
    "请立即 replace/write，或 ask_clarification，或根据已有结果总结。"
)

# Search / discovery — never hard-blocked by explore streak or explore-loop limits.
_SEARCH_DISCOVERY_TOOLS = frozenset(
    {
        "rg",
        "grep",
        "search_code_index",
        "search_content",
        "find",
        "find_file",
        "web_search",
        "web_fetch",
        "web_fetch_enhanced",
        "web_fetch_enhanced_tool",
        "preview_url",
    }
)
# Only these increment the consecutive explore-streak counter (warn-only).
_EXPLORE_STREAK_TOOLS = frozenset({"read_file", "list_dir", "terminal"})

_EXPLORE_TOOLS = frozenset(
    {
        "read_file",
        "read",
        "rg",
        "search_code_index",
        "list_dir",
        "ls",
        "terminal",
        "find",
        "find_file",
    }
)
_EXPLORE_CANONICAL = frozenset(
    {
        "read_file",
        "rg",
        "search_code_index",
        "list_dir",
        "terminal",
        "find",
    }
)
_LIST_DIR_DEFAULT_DEPTH = 2
# Offset micro-nudges (e.g. 130 vs 132) must share a fingerprint.
_READ_OFFSET_BUCKET = 50
_EXPLORE_WARN_THRESHOLD = 3
_EXPLORE_HARD_THRESHOLD = 5
_EXPLORE_DECAY_SECONDS = 120

_ERROR_EXPLORE_TOOLS = frozenset({"read_file", "list_dir", "terminal"})
_ERROR_FAIL_MARKERS = (
    "permission denied",
    "path not found",
    "not a file",
    "not a directory",
    "file not found",
    "not recognized as",
    "no composition found",
    "exit code: 1",
)
_ERROR_WARN_THRESHOLD = 2
_ERROR_HARD_THRESHOLD = 3
_ERROR_BLOCK_MSG = (
    "[重复失败·已拦截] 同一路径的读/列目录已连续失败，本次未执行。"
    "请换 search_code_index、核对工作区路径，或根据已有错误信息换策略。"
)

_SAFE_GIT_SUBCOMMANDS = frozenset({
    "status", "log", "diff", "show", "branch", "remote",
    "rev-parse", "check-ignore", "describe", "reflog",
})


def _is_safe_terminal_command(args: dict) -> bool:
    """Read-only / idempotent terminal commands exempt from loop detection."""
    cmd = str(args.get("command") or "").strip()
    if not cmd:
        return False
    parts = cmd.split()
    if len(parts) >= 2 and parts[0].lower() == "git":
        if parts[1].lower() in _SAFE_GIT_SUBCOMMANDS:
            return True
    if parts and parts[0].lower() == "curl.exe":
        return True
    return False


def _is_search_discovery_tool(name: str) -> bool:
    raw = str(name or "").strip().lower()
    if raw in _SEARCH_DISCOVERY_TOOLS:
        return True
    return _normalize_explore_tool_name(raw) in _SEARCH_DISCOVERY_TOOLS


def _normalize_explore_tool_name(name: str) -> str:
    n = str(name or "").strip().lower()
    if n in {"ls", "read"}:
        return "list_dir" if n == "ls" else "read_file"
    if n == "find_file":
        return "find"
    return n


def _normalize_path_key(path: str) -> str:
    return str(path or "").replace("\\", "/").rstrip("/").casefold()


def _read_offset_bucket(args: dict) -> str:
    """Bucket read offsets so tiny nudges (130 vs 132) share one fingerprint."""
    offset = args.get("offset")
    if offset is None or str(offset).strip() == "":
        return "full"
    try:
        off = int(offset)
    except (TypeError, ValueError):
        return str(offset).strip()
    return str(off // _READ_OFFSET_BUCKET)


def _explore_loop_fingerprint(tool_call: dict) -> str | None:
    """Stable explore thrash fingerprint (ignores context_/max_results jitter)."""
    name = _normalize_explore_tool_name(str(tool_call.get("name") or ""))
    args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}
    if name == "read_file":
        key = str(args.get("path") or args.get("file_path") or "").strip()
        if not key:
            return None
        return f"read_file:{_normalize_path_key(key)}@b{_read_offset_bucket(args)}"
    if name == "rg":
        pattern = str(args.get("pattern") or args.get("query") or "").strip()
        if not pattern:
            return None
        path = _normalize_path_key(str(args.get("path") or "").strip())
        return f"rg:{path}:{pattern.casefold()}"
    if name == "search_code_index":
        q = str(args.get("query") or args.get("pattern") or "").strip()
        return f"search_code_index:{q.casefold()}" if q else None
    if name == "list_dir":
        p = str(args.get("path") or "").strip()
        if not p:
            return None
        fmt = str(args.get("format") or "tree").strip().lower() or "tree"
        return f"list_dir:{_normalize_path_key(p)}@d{_list_dir_depth_suffix(args)}:{fmt}"
    if name == "find":
        pattern = str(args.get("pattern") or args.get("query") or "").strip()
        if not pattern:
            return None
        root = _normalize_path_key(str(args.get("root") or args.get("path") or ".").strip() or ".")
        return f"find:{root}:{pattern.casefold()}"
    if name == "terminal":
        return _terminal_command_fingerprint(args)
    return None


def _read_path_fingerprint(tool_call: dict) -> str | None:
    """Explore-loop fingerprint for read (path + offset bucket)."""
    name = _normalize_explore_tool_name(str(tool_call.get("name") or ""))
    if name != "read_file":
        return None
    return _explore_loop_fingerprint(tool_call)


def _list_dir_depth_suffix(args: dict) -> str:
    """Match ``list_dir`` / ``ls`` tools: default depth 2 when omitted."""
    depth = args.get("depth")
    if depth is None:
        return str(_LIST_DIR_DEFAULT_DEPTH)
    try:
        return str(int(depth))
    except (TypeError, ValueError):
        return str(depth).strip() or str(_LIST_DIR_DEFAULT_DEPTH)


def _split_shell_segments(cmd: str) -> list[str]:
    """Split compound shell commands on ``;`` / ``&&`` / ``||`` (not inside quotes)."""
    segments: list[str] = []
    buf: list[str] = []
    quote = ""
    i = 0
    while i < len(cmd):
        ch = cmd[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = ""
            i += 1
            continue
        if ch in {"'", '"'}:
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == ";":
            segments.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        if ch == "&" and i + 1 < len(cmd) and cmd[i + 1] == "&":
            segments.append("".join(buf).strip())
            buf = []
            i += 2
            continue
        if ch == "|" and i + 1 < len(cmd) and cmd[i + 1] == "|":
            segments.append("".join(buf).strip())
            buf = []
            i += 2
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        segments.append(tail)
    return [s for s in segments if s]


def _terminal_focus_segment(cmd: str) -> str:
    """Prefer the last non-``cd`` segment so ``cd X; node script …`` fingerprints the script."""
    segments = _split_shell_segments(cmd)
    if not segments:
        return cmd.strip()
    for seg in reversed(segments):
        low = seg.strip().lower()
        if low == "cd" or low.startswith("cd ") or low.startswith("chdir "):
            continue
        return seg.strip()
    return segments[-1].strip()


def _script_basename(token: str) -> str:
    t = token.strip().strip("'\"")
    t = t.replace("\\", "/")
    return t.rsplit("/", 1)[-1].lower() if t else ""


def _terminal_subcommand_token(token: str) -> str | None:
    """Keep stable verb-like args (topic_list); drop JSON / flags / paths."""
    raw = token.strip().strip("'\"")
    if not raw:
        return None
    if raw.startswith("{") or raw.startswith("[") or raw.startswith("-"):
        return None
    if "/" in raw or "\\" in raw:
        return None
    if len(raw) > 48:
        return None
    return raw.lower()


def _terminal_command_fingerprint(args: dict) -> str | None:
    """Normalize terminal command for loop detection (verb/script, not cwd-only).

    ``cd D:/repo; node skills/.../mcp-call.js topic_list '{}'`` must not share a
    fingerprint with ``cd D:/repo; node skills/.../search.js '...'`` — otherwise
    mixed batches (write/knowledge + terminal) false-trigger explore hard limits.
    """
    if _is_safe_terminal_command(args):
        return None
    cmd = str(args.get("command") or "").strip()
    if not cmd:
        return None
    focus = _terminal_focus_segment(cmd)
    parts = focus.split()
    if not parts:
        return None
    first = parts[0].lower()
    # PowerShell cmdlets: use cmdlet name only (ignores paths/filters)
    if any(first.startswith(pfx) for pfx in ("get-", "set-", "new-", "copy-", "remove-", "test-", "select-")):
        return f"terminal:{first}"
    # Interpreters: program + script basename + optional subcommand
    if first in {"npx", "node", "npm", "python", "python3", "pip", "pip3"}:
        tokens = [first]
        if len(parts) >= 2:
            script = _script_basename(parts[1])
            if script:
                tokens.append(script)
        if len(parts) >= 3:
            sub = _terminal_subcommand_token(parts[2])
            if sub:
                tokens.append(sub)
        return f"terminal:{':'.join(tokens)}"
    if first in {"cd", "chdir"}:
        # Bare cd (no useful following segment) — weak fingerprint on target only
        target = parts[1].lower() if len(parts) >= 2 else ""
        return f"terminal:cd:{target}" if target else "terminal:cd"
    # Default: first 2 tokens
    return f"terminal:{' '.join(parts[:2]).lower()}"


def _terminal_tool_fingerprint(tool_call: dict) -> str | None:
    name = _normalize_explore_tool_name(str(tool_call.get("name") or ""))
    if name != "terminal":
        return None
    args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}
    return _terminal_command_fingerprint(args)


def _read_file_offset_limit_suffix(args: dict) -> str:
    offset = args.get("offset")
    limit = args.get("limit")
    if offset is None and limit is None:
        return ""
    off_s = "0"
    if offset is not None and str(offset).strip() != "":
        try:
            off_s = str(int(offset))
        except (TypeError, ValueError):
            off_s = str(offset).strip()
    lim_s = ""
    if limit is not None and str(limit).strip() != "":
        try:
            lim_s = str(int(limit))
        except (TypeError, ValueError):
            lim_s = str(limit).strip()
    return f"@{off_s}:{lim_s}"


def _single_tool_fingerprint(tool_call: dict) -> str | None:
    """Per-tool fingerprint (explore tools get readable keys; others use args hash)."""
    name = _normalize_explore_tool_name(str(tool_call.get("name") or ""))
    args = tool_call.get("args")
    if not isinstance(args, dict):
        args = {}
    if name == "read_file":
        key = str(args.get("path") or args.get("file_path") or "").strip()
        if not key:
            return None
        return f"read_file:{key}{_read_file_offset_limit_suffix(args)}"
    if name == "search_code_index":
        q = str(args.get("query") or args.get("pattern") or "").strip()
        return f"search_code_index:{q}" if q else None
    if name == "list_dir":
        p = str(args.get("path") or "").strip()
        if not p:
            return None
        fmt = str(args.get("format") or "tree").strip().lower() or "tree"
        return f"list_dir:{p}@d{_list_dir_depth_suffix(args)}:{fmt}"
    if not name:
        return None
    blob = json.dumps(args, sort_keys=True, default=str)
    return f"{name}:{hashlib.md5(blob.encode()).hexdigest()[:12]}"


def _tool_call_id(tool_call: dict) -> str:
    return str(tool_call.get("id") or "").strip()


def _explore_repeat_count(thread_history: list[str], fingerprint: str) -> int:
    return sum(1 for fp in thread_history if fp == fingerprint)


class LoopDetectionMiddleware(AgentMiddleware[AgentState]):
    """Detect repetitive tool calls; block duplicates but keep the run alive."""

    def __init__(
        self,
        warn_threshold: int = _DEFAULT_WARN_THRESHOLD,
        hard_limit: int = _DEFAULT_HARD_LIMIT,
        window_size: int = _DEFAULT_WINDOW_SIZE,
        max_tracked_threads: int = _DEFAULT_MAX_TRACKED_THREADS,
    ):
        super().__init__()
        self.warn_threshold = warn_threshold
        self.hard_limit = hard_limit
        self.window_size = window_size
        self.max_tracked_threads = max_tracked_threads
        self._lock = threading.Lock()
        self._history: OrderedDict[str, list[tuple[str, float]]] = OrderedDict()
        self._explore_history: OrderedDict[str, list[tuple[str, float]]] = OrderedDict()
        self._warned: dict[str, set[str]] = defaultdict(set)
        self._explore_warned: dict[str, set[str]] = defaultdict(set)
        self._block_tool_call_ids: dict[str, set[str]] = defaultdict(set)
        self._block_explore_msg: dict[str, bool] = defaultdict(bool)
        self._error_history: OrderedDict[str, list[tuple[str, float]]] = OrderedDict()
        self._block_error_msg: dict[str, bool] = defaultdict(bool)
        self._explore_streak: dict[str, int] = defaultdict(int)
        self._explore_streak_warned: dict[str, bool] = defaultdict(bool)
        self._block_explore_streak_msg: dict[str, bool] = defaultdict(bool)

    def _thread_id_from_tool_request(self, request: ToolCallRequest) -> str:
        rt = getattr(request, "runtime", None)
        if rt is not None:
            ctx = getattr(rt, "context", None)
            if isinstance(ctx, dict):
                tid = str(ctx.get("thread_id") or "").strip()
                if tid:
                    return tid
            try:
                from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

                tid = str(runtime_context_mapping(rt).get("thread_id") or "").strip()
                if tid:
                    return tid
            except Exception:
                pass
        return "default"

    def _register_block_ids(self, thread_id: str, tool_calls: list[dict]) -> None:
        for tc in tool_calls:
            tid = _tool_call_id(tc)
            if tid:
                self._block_tool_call_ids[thread_id].add(tid)

    def _maybe_block_tool(self, request: ToolCallRequest) -> ToolMessage | None:
        tc = request.tool_call if isinstance(request.tool_call, dict) else {}
        tool_call_id = _tool_call_id(tc)
        if not tool_call_id:
            return None
        thread_id = self._thread_id_from_tool_request(request)
        with self._lock:
            blocked = self._block_tool_call_ids.get(thread_id) or set()
            if tool_call_id not in blocked:
                return None
            blocked.discard(tool_call_id)
            if not blocked:
                self._block_tool_call_ids.pop(thread_id, None)
            use_explore_msg = self._block_explore_msg.pop(thread_id, False)
            use_error_msg = self._block_error_msg.pop(thread_id, False)
            use_streak_msg = self._block_explore_streak_msg.pop(thread_id, False)
        name = str(tc.get("name") or "tool").strip()
        if use_error_msg:
            content = _ERROR_BLOCK_MSG
        elif use_streak_msg:
            content = _EXPLORE_STREAK_BLOCK_MSG
        elif use_explore_msg:
            content = _EXPLORE_BLOCK_MSG
        else:
            content = _BLOCK_MSG
        return ToolMessage(
            content=content,
            tool_call_id=tool_call_id,
            name=name,
            status="error",
        )

    def _get_thread_id(self, runtime: Runtime) -> str:
        thread_id = runtime.context.get("thread_id") if runtime.context else None
        if thread_id:
            return thread_id
        return "default"

    def _evict_if_needed(self) -> None:
        while len(self._history) > self.max_tracked_threads:
            evicted_id, _ = self._history.popitem(last=False)
            self._warned.pop(evicted_id, None)
            self._explore_history.pop(evicted_id, None)
            self._explore_warned.pop(evicted_id, None)
            self._block_tool_call_ids.pop(evicted_id, None)
            self._block_explore_msg.pop(evicted_id, None)
            self._error_history.pop(evicted_id, None)
            self._block_error_msg.pop(evicted_id, None)
            logger.debug("Evicted loop tracking for thread %s (LRU)", evicted_id)

    def _error_result_fingerprint(self, tool_name: str, content: str, args: dict) -> str | None:
        name = _normalize_explore_tool_name(tool_name)
        if name not in _ERROR_EXPLORE_TOOLS:
            return None
        low = str(content or "").strip().lower()
        if not low.startswith("error:") and "permission denied" not in low and "exit code: 1" not in low:
            return None
        if not any(marker in low for marker in _ERROR_FAIL_MARKERS):
            return None
        err_kind = "perm" if "permission denied" in low else "missing"
        if name == "terminal":
            fp = _terminal_command_fingerprint(args)
            if not fp:
                return None
            return f"{fp}:{err_kind}"
        p = str(args.get("path") or args.get("file_path") or "").strip()
        if not p:
            return None
        return f"{name}_err:{p}:{err_kind}"

    def _error_call_fingerprints(self, tool_call: dict) -> list[str]:
        name = _normalize_explore_tool_name(str(tool_call.get("name") or ""))
        if name not in _ERROR_EXPLORE_TOOLS:
            return []
        args = tool_call.get("args")
        if not isinstance(args, dict):
            args = {}
        if name == "terminal":
            fp = _terminal_command_fingerprint(args)
            if not fp:
                return []
            return [f"{fp}:perm", f"{fp}:missing"]
        p = str(args.get("path") or args.get("file_path") or "").strip()
        if not p:
            return []
        return [f"{name}_err:{p}:perm", f"{name}_err:{p}:missing"]

    def _maybe_block_error_repeat(self, request: ToolCallRequest) -> ToolMessage | None:
        # Path read/list_dir failure streaks are no longer intercepted — let the
        # model retry or change strategy from real tool errors.
        return None

    def _track_tool_result_errors(self, request: ToolCallRequest, result: ToolMessage | Command) -> None:
        return

    def _check_explore_loops(
        self,
        thread_id: str,
        tool_calls: list[dict],
    ) -> str | None:
        """Repeat explore interception disabled — read/rg/search may run freely."""
        return None

    def _track_and_check(self, state: AgentState, runtime: Runtime) -> str | None:
        messages = state.get("messages", [])
        if not messages:
            return None

        last_msg = messages[-1]
        if getattr(last_msg, "type", None) != "ai":
            return None

        tool_calls = getattr(last_msg, "tool_calls", None)
        if not tool_calls:
            return None
        if _is_supervisor_safe_repeat_callset(tool_calls):
            return None

        thread_id = self._get_thread_id(runtime)

        # Update explore-streak counters first; path-fingerprint blocks still win
        # when both fire (preserves existing same-target thrash behavior).
        streak_msg = self._check_explore_streak(thread_id, tool_calls)
        explore_msg = self._check_explore_loops(thread_id, tool_calls)
        if explore_msg == _EXPLORE_BLOCK_MSG:
            return explore_msg
        if streak_msg == _EXPLORE_STREAK_BLOCK_MSG:
            return streak_msg

        # Path fingerprints already cover explore thrash; skip exact-batch hash
        # for explore-only turns (arg jitter would never hit hard_limit anyway).
        if _is_explore_only_callset(tool_calls):
            return explore_msg or streak_msg

        call_hash = _hash_tool_calls(tool_calls)
        global_msg: str | None = None

        now = time.monotonic()
        cutoff = now - _EXPLORE_DECAY_SECONDS
        with self._lock:
            if thread_id in self._history:
                self._history.move_to_end(thread_id)
            else:
                self._history[thread_id] = []
                self._evict_if_needed()

            history = self._history[thread_id]
            history[:] = [(h, ts) for h, ts in history if ts >= cutoff]
            history.append((call_hash, now))
            if len(history) > self.window_size:
                history[:] = history[-self.window_size :]

            count = sum(1 for h, _ in history if h == call_hash)
            tool_names = [tc.get("name", "?") for tc in tool_calls]

            if count >= self.hard_limit:
                self._register_block_ids(thread_id, tool_calls)
                logger.error(
                    "Loop hard limit — blocking duplicate tool batch (run continues)",
                    extra={
                        "thread_id": thread_id,
                        "call_hash": call_hash,
                        "count": count,
                        "tools": tool_names,
                    },
                )
                global_msg = _BLOCK_MSG
            elif count >= self.warn_threshold:
                warned = self._warned[thread_id]
                if call_hash not in warned:
                    warned.add(call_hash)
                    logger.warning(
                        "Repetitive tool calls detected — injecting warning",
                        extra={
                            "thread_id": thread_id,
                            "call_hash": call_hash,
                            "count": count,
                            "tools": tool_names,
                        },
                    )
                    global_msg = _WARNING_MSG

        return explore_msg or streak_msg or global_msg

    def _check_explore_streak(self, thread_id: str, tool_calls: list[dict]) -> str | None:
        """Explore-streak warn/block disabled — consecutive read/list_dir may run freely."""
        return None

    def _apply(self, state: AgentState, runtime: Runtime) -> dict | None:
        warning = self._track_and_check(state, runtime)
        if warning:
            return {"messages": [HumanMessage(content=warning)]}
        return None

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._apply(state, runtime)

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        blocked = self._maybe_block_tool(request)
        if blocked is not None:
            return blocked
        return handler(request)

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        blocked = self._maybe_block_tool(request)
        if blocked is not None:
            return blocked
        return await handler(request)

    def reset(self, thread_id: str | None = None) -> None:
        with self._lock:
            if thread_id:
                self._history.pop(thread_id, None)
                self._warned.pop(thread_id, None)
                self._explore_history.pop(thread_id, None)
                self._explore_warned.pop(thread_id, None)
                self._block_tool_call_ids.pop(thread_id, None)
                self._block_explore_msg.pop(thread_id, None)
                self._error_history.pop(thread_id, None)
                self._block_error_msg.pop(thread_id, None)
                self._explore_streak.pop(thread_id, None)
                self._explore_streak_warned.pop(thread_id, None)
                self._block_explore_streak_msg.pop(thread_id, None)
            else:
                self._history.clear()
                self._warned.clear()
                self._explore_history.clear()
                self._explore_warned.clear()
                self._block_tool_call_ids.clear()
                self._block_explore_msg.clear()
                self._error_history.clear()
                self._block_error_msg.clear()
                self._explore_streak.clear()
                self._explore_streak_warned.clear()
                self._block_explore_streak_msg.clear()
