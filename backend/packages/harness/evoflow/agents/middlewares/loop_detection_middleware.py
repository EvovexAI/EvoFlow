"""Middleware to detect and break repetitive tool call loops.

When repetition exceeds thresholds, duplicate tool executions are blocked
(synthetic ToolMessage) and a HumanMessage hint is injected — the run keeps
going so the model can change strategy. We do not strip all tool_calls to END
the graph.
"""

import hashlib
import json
import logging
import re  # 【fullstack-dev · 2026-11-15 · 第12轮】新增：_strip_env_assignments 要识别 VAR= 前缀
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


_WARNING_MSG = "[LOOP DETECTED] You are repeating the same tool calls. Change strategy or summarize with results collected so far; do not repeat identical calls."

_BLOCK_MSG = "[重复调用·已拦截] 同一工具调用已达安全上限，本次未执行。请根据已有工具结果换做法，不要重复相同调用。"

_EXPLORE_WARNING_MSG = "[重复探索] 同一 read/rg/search 目标调用过多。请停止重复探索；若用户要求改代码/修 bug/加功能，立即 replace/write（勿再 read 同一文件近邻偏移）；若仅调研/解释则收口总结。近邻 offset（同 bucket）视为重复。"

_EXPLORE_BLOCK_MSG = "[重复探索·已拦截] 同一探索工具目标已达上限，本次调用未执行。请根据已有工具结果换策略：replace/write 落地修改，或换文件/换 pattern；不要再次 read/rg/list_dir 同一目标。"

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
        "platform",  # includes ui.show / ui.hide (ex panel_set)
    }
)
_EXPLORE_STREAK_WARN_MSG = "[探索过久] 本轮已连续多次只读探索且未落地修改。若用户要求改代码/修 UI/修 bug：立即 replace/write 或 ask_clarification；禁止再为记账调用 mind_map。若仅调研则收口总结。"
_EXPLORE_STREAK_BLOCK_MSG = "[探索过久·已拦截] 连续探索未改代码已达上限，本次探索工具未执行。请立即 replace/write，或 ask_clarification，或根据已有结果总结。"

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
    "timed out",
)
_ERROR_WARN_THRESHOLD = 2
_ERROR_HARD_THRESHOLD = 3
_ERROR_BLOCK_MSG = "[重复失败·已拦截] 同一路径的读/列目录已连续失败，本次未执行。请换 search_code_index、核对工作区路径，或根据已有错误信息换策略。"

_SAFE_GIT_SUBCOMMANDS = frozenset(
    {
        "status",
        "log",
        "diff",
        "show",
        "branch",
        "remote",
        "rev-parse",
        "check-ignore",
        "describe",
        "reflog",
    }
)


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
    if n == "bash":
        return "terminal"
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


def _strip_env_assignments(tokens: list[str]) -> list[str]:
    """Drop leading ``VAR=value`` shells so the interpreter becomes ``parts[0]``.

    【fullstack-dev · 2026-11-15 · 第12轮】新建。
    只剥**行首连续**的赋值（``FOO=1 BAR=2 python -m pytest`` → ``python -m pytest``）；
    命令中途的 ``K=V``（``pytest -k "foo"`` 之类）原样保留，避免误吞参数。
    """
    out = list(tokens)
    while out and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", out[0]):
        out.pop(0)
    return out


def _terminal_focus_segment(cmd: str) -> str:
    """Prefer the last substantive segment so ``cd X; python -m pytest tests/y.py`` fingerprints the test.

    【fullstack-dev · 2026-11-15 · 第12轮】改：从"最后一段非 cd"改为"最后一段既非 cd、也非纯 cd+&& 前缀"，
    并把 ``VAR=value`` 前缀视作噪音 —— 取**最后一段真正跑东西的**命令。
    为什么：本岗门禁一律是 ``cd /d/repo/backend && PYTHONPATH=packages/harness:. python -m pytest tests/x.py``；
    旧写法只看末段，而带 ``; echo`` / 管道尾巴的写法会把焦点段带到 ``echo`` 上，同一门禁的不同次跑
    反而指纹不同（拦与不拦变成随机），与上一条缺陷一样都会让我白绕一步。
    """
    segments = _split_shell_segments(cmd)
    if not segments:
        return cmd.strip()
    for seg in reversed(segments):
        low = seg.strip().lower()
        if not low or low == "cd" or low.startswith("cd ") or low.startswith("chdir "):
            continue
        # 【fullstack-dev · 2026-11-15 · 第12轮】补：尾巴上的 echo/printf 不算"跑的东西"。
        # 为什么：我常在门禁后接 ``&& echo SH_OK`` 确认成功，旧写法把焦点落在 echo 上 ——
        # 同一条 ``bash -n x.sh`` 加不加尾巴就是两个指纹，拦与不拦变随机。
        # 【fullstack-dev · 2026-11-15 · 第17轮】扩：date/true/: 同属"纯打点"尾巴。
        # 为什么：本岗习惯在门禁尾巴接 ``echo "===NOW $(date +%H:%M:%S)==="`` 记时间。引号里的
        #   ``$(date…)`` 让该段以 echo 起头→被跳过；一旦写成 ``; date +%H:%M:%S``（不套 echo），
        #   末段焦点就落到 date 上，指纹变 ``terminal:date +%h:%m:%s`` —— obs 近 2 天 701 次拦截里
        #   这一桶占 **111 次（最大桶，16%）**，pytest / obs_query / ruff 等完全不同的真目标全被
        #   并进同一个键（9 条不同命令 → 焦点段只剩 1 个），第 3 次不同调用即被误拦。
        #   判据与 echo 一致：只含格式化/打点、不产生工作副作用的段，不配当"跑的东西"。
        # 边界：跳过的是**末段打点**；若整条命令就只有 date（真在查时间），兜底仍返回末段，检测不丢。
        stripped = _strip_env_assignments(low.split())
        if stripped and stripped[0] in {"echo", "printf", "date", "true", ":"}:
            continue
        if _strip_env_assignments(seg.strip().split()):
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


def _terminal_positional_token(token: str) -> str | None:
    """Positional arg of an interpreter command worth fingerprinting (test file / dir / expr).

    与 ``_terminal_subcommand_token`` 的区别：这里**允许带路径**，但只取 basename，
    这样 ``pytest tests/a.py`` 与 ``pytest tests/b.py`` 不同指纹（真在跑不同的东西），
    而 ``cd`` 到别的目录再跑同一文件仍算同一目标。flags（``-q``/``--tb=short``）一律忽略。
    """
    raw = str(token or "").strip().strip("'\"")
    if not raw or raw.startswith("-"):
        return None
    if raw.startswith("{") or raw.startswith("["):
        return None
    base = _script_basename(raw).rstrip("/")
    # 解释器的 ``-c "…`` 内联代码不配当指纹后缀（整段代码进 tokens 会让每次改写都算"不同目标"）。
    return base[:48] if base and base not in {"-c"} else None


# 【fullstack-dev · 2026-11-15 · 第17轮】新建。
# 哪些 flag 的**值本身就是「这次到底在算什么」**：把紧跟该 flag 的那**一个** token 做短摘要进指纹
# （不是"取到段尾"—— 段尾会混进 ``--limit`` 这类选择器，同型于第12轮"随机拦与不拦"那个坑）。
# 真实现场（本轮我自己被撞）：``python .../obs_query.py --db obs --sql "SELECT a FROM t"``
# 与 ``… --sql "SELECT b FROM u"`` 两条不同查询都归一成 ``terminal:python:obs_query.py``，
# 第 3 次起被判「重复探索」拦掉 —— obs_query.py 是第13轮为「别每轮现写 python -c 探针」
# 固化的只读查询入口，结果它的**每一个新查询**都被当成重复探索，等于固化了个用不了的工具。
# 近 2 天该拦截共 701 次（obs 直查）：release-engineer 486 / 本岗 113 / xiaomi 87 / 总监 14 / main 2。
# 边界：只列「值即工作对象」的 flag；``--db``/``--limit``/``-q``/``--tb=short`` 这类选择器、
# 以及 ``python -c "…"`` 内联代码一律**不**进指纹（第12轮刻意排除 -c，让改写探针仍算同一目标）。
_PAYLOAD_VALUE_FLAGS = ("--sql", "--query", "--expr", "--schema")


def _split_shell_tokens(cmd: str) -> list[str]:
    """引号感知的切分：``--sql "SELECT a, b" --limit 80`` → 3 个 token。

    【fullstack-dev · 2026-11-15 · 第17轮】新建。
    为什么不用 ``shlex.split``：它在引号不闭合时抛 ``ValueError``，而本函数跑在**每次工具调用
    前的指纹路径**上，一条写坏的命令行不该把整轮炸挂；这里只取「引号内不切分」这一条语义，
    反斜杠按普通字符处理（Windows 路径居多），且永不抛。
    """
    out: list[str] = []
    buf: list[str] = []
    quote = ""
    seen = False  # 区分「空引号 token」与「什么都没有」
    for ch in str(cmd or ""):
        if quote:
            if ch == quote:
                quote = ""
            else:
                buf.append(ch)
            continue
        if ch in {"'", '"'}:
            quote = ch
            seen = True
            continue
        if ch.isspace():
            if seen or buf:
                out.append("".join(buf))
                buf = []
                seen = False
            continue
        buf.append(ch)
    if seen or buf:
        out.append("".join(buf))
    return out


def _fingerprint_payload_tag(focus: str) -> str:
    """值即目标的 flag → 追加其**那一个 token** 的短摘要；无则空串（不改原指纹）。

    【fullstack-dev · 2026-11-15 · 第17轮】新建（同日二次修正）。
    第一版取「flag 到行尾」整段做摘要，被我自己新加的回归测出一半错：
    ``--sql "SELECT 1" --limit 80`` 与 ``…--limit 20`` 只是换个行数上限、**查的是同一样东西**，
    却因为尾巴上的 ``--limit`` 进了摘要而算成两个目标 —— 那等于把检测削空（同型于第12轮
    「随机拦与不拦」那个坑）。故改为**只取该 flag 紧跟的一个 token**，选择器类尾巴天然排除。
    """
    tokens = _split_shell_tokens(focus)
    lowered = [t.lower() for t in tokens]
    for i, tok in enumerate(lowered):
        if tok in _PAYLOAD_VALUE_FLAGS and i + 1 < len(tokens):
            val = tokens[i + 1].strip()
            if not val:
                return ""
            return "|h:" + hashlib.md5(val.encode()).hexdigest()[:8]
        # ``--sql=VALUE`` 等号写法
        for flag in _PAYLOAD_VALUE_FLAGS:
            if tok.startswith(flag + "="):
                val = tokens[i][len(flag) + 1 :].strip()
                if val:
                    return "|h:" + hashlib.md5(val.encode()).hexdigest()[:8]
    return ""


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
    # 【fullstack-dev · 2026-11-15 · 第12轮】改：先剥掉行首 ``VAR=value``，再看是不是解释器。
    # 为什么：本岗门禁一律写成 ``PYTHONPATH=packages/harness:. python -m pytest tests/x.py``，
    # 旧逻辑取「前 2 个 token」当兜底指纹，而这 2 个 token 恰好是 ``PYTHONPATH=… python`` ——
    # 被测文件根本不进指纹，于是"跑 A 测试""跑 B 测试""跑 A+B"三个不同调用撞成同一指纹，
    # 第 3 次起被判重复探索直接拦截（本轮实拦 3 次，每次都要我换写法绕，白烧一轮）。
    # 【fullstack-dev · 2026-11-15 · 第17轮】改：切 token 改用引号感知的 _split_shell_tokens。
    # 为什么：``focus.split()`` 把 ``grep -n "def | return" file`` 炸成 ``"def`` / ``|`` / ``return"``，
    #   而 _terminal_positional_token 又会 strip 引号 → 指纹只剩 ``terminal:grep -n def``，
    #   于是"查 def""查 visible""查 -e def"这些**不同检索目标**各自塌成 20/10/10 条不同命令同指纹
    #   （obs 近 2 天 701 次拦截里 grep 族占约 40 条），第 3 次不同检索就被误拦。
    #   同一条命令换引号写法还会指纹漂移（拦与不拦变随机），与第12轮那个坑同型。
    # 边界：只换切分方式，各分支语义不变；env 前缀、解释器、PowerShell 分支行为已由 36 条回归护栏覆盖。
    parts = _strip_env_assignments(_split_shell_tokens(focus))
    if not parts:
        return None
    first = parts[0].lower()
    # 【fullstack-dev · 2026-11-15 · 第17轮】新增：``uv run`` 这类 runner 前缀先剥掉。
    # 为什么：``uv run python scripts/a.py`` 与 ``… b.py`` 原都被兜底分支截成
    # ``terminal:uv run python`` —— 真正被跑的东西（脚本/测试文件）完全不进指纹。
    # 近 2 天该桶塌了 24 条不同命令；release-engineer 被拦 486 次（其门禁惯例正是
    # ``PYTHONPATH=. uv run pytest …``），第 3 次不同调用起被判「重复探索」误拦。
    # 边界：只剥 ``uv run``（npx/pip 已在解释器表内）；剥完后按内层命令原语义走。
    if first == "uv" and len(parts) >= 3 and parts[1].lower() == "run":
        parts = parts[2:]
        first = parts[0].lower()
    # PowerShell cmdlets: use cmdlet name only (ignores paths/filters)
    if any(first.startswith(pfx) for pfx in ("get-", "set-", "new-", "copy-", "remove-", "test-", "select-")):
        return f"terminal:{first}"
    # Interpreters: program + script basename + optional subcommand
    if first in {"npx", "node", "npm", "python", "python3", "pip", "pip3"}:
        tokens = [first]
        rest = parts[1:]
        # 【fullstack-dev · 2026-11-15 · 第12轮】改：``-m 模块`` 也当作"被跑的东西"，并把后续位置参数
        # （测试文件/目录）取前 3 个进指纹；旧写法只看前 3 个 token，于是
        # ``python -m pytest tests/a.py`` 与 ``python -m pytest tests/b.py`` 指纹相同 ——
        # 换个文件再跑照样被判"重复探索"，这是本轮拦 3 次的直接原因。
        if rest and rest[0] == "-m" and len(rest) >= 2:
            tokens.append(f"m:{_script_basename(rest[1])}")
            for tok in rest[2:]:
                pos = _terminal_positional_token(tok)
                if pos:
                    tokens.append(pos)
                if len(tokens) >= 5:
                    break
        else:
            if rest:
                script = _script_basename(rest[0])
                if script:
                    tokens.append(script)
            if len(rest) >= 2:
                sub = _terminal_subcommand_token(rest[1])
                if sub:
                    tokens.append(sub)
        # 【fullstack-dev · 2026-11-15 · 第17轮】改：解释器分支追加 payload 摘要。
        # 为什么：``obs_query.py --sql "A"`` 与 ``--sql "B"`` 原都归一成
        # ``terminal:python:obs_query.py``，两条不同查询撞指纹、第 3 次起被拦。
        return f"terminal:{':'.join(tokens)}{_fingerprint_payload_tag(focus)}"
    if first in {"cd", "chdir"}:
        # Bare cd (no useful following segment) — weak fingerprint on target only
        target = parts[1].lower() if len(parts) >= 2 else ""
        return f"terminal:cd:{target}" if target else "terminal:cd"
    # Default: first 2 tokens + positional target.
    # 【fullstack-dev · 2026-11-15 · 第12轮】改：追加位置参数（取 basename）。
    # 为什么：旧写法只取前 2 token，``bash -n scripts/a.sh`` 与 ``bash -n scripts/b.sh`` 同为
    # ``terminal:bash -n`` —— 与被拦的 pytest 那条是**同一个缺陷的另一半**：校验对象不同却被判成重复调用。
    # 边界：flags 一律忽略，位置参数最多 2 个，避免长命令行把指纹撑得谁都不撞（那会削弱检测）。
    # 【fullstack-dev · 2026-11-15 · 第17轮】改：预算改为"位置参数 2 个 / flags 至多 2 个"分开计。
    # 为什么：上面注释写着"flags 一律忽略"，但代码把非位置 token（含 flags）**也塞进同一个
    #   ``len(tokens) >= 3`` 预算**，于是 flags 能把真正被操作的对象挤出去 ——
    #   ``ls -l --time-style=+%H:%M:%S round6-xxx.md`` 指纹停在 ``ls -l --time-style``（目标文件没了），
    #   obs 近 2 天该桶塌了 **137 次 / 全部不同文件**（改 date 尾巴前是 111 次 date 桶，
    #   同一个 bug 的两个面具）。注释与实现相反 = 第12轮"flags 一律忽略"其实从未生效。
    # 边界：flags 仍保留 2 个（``bash -n x.sh`` 的 ``-n`` 是有意义的模式位，第12轮已固化为契约）；
    #   总 token 数上界从 3 提到 5，仍远小于"整行进指纹"，检测力不空。
    tokens = [first]
    n_pos = 0
    n_flag = 0
    for tok in parts[1:]:
        pos = _terminal_positional_token(tok)
        if pos:
            tokens.append(pos)
            n_pos += 1
        elif n_flag < 2:
            tokens.append(tok.lower().rstrip("&|;"))
            n_flag += 1
        if n_pos >= 2:
            break
    return f"terminal:{' '.join(tokens)}"


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


def _count_fingerprint(history: list[tuple[str, float]], fingerprint: str) -> int:
    """Count fingerprint hits in a timestamped ``(fp, ts)`` history list."""
    return sum(1 for h, _ in history if h == fingerprint)


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
            self._explore_streak.pop(evicted_id, None)
            self._explore_streak_warned.pop(evicted_id, None)
            self._block_explore_streak_msg.pop(evicted_id, None)
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
        """Block the Nth identical read/list_dir/terminal attempt that keeps failing the same way.

        Failures are recorded by :meth:`_track_tool_result_errors` (real tool errors only);
        once one error fingerprint has accumulated ``_ERROR_HARD_THRESHOLD`` results inside
        the decay window, the next identical call is rejected with ``_ERROR_BLOCK_MSG``.
        The error results themselves are already visible to the model, so no extra warn
        injection is needed before the block.
        """
        tc = request.tool_call if isinstance(request.tool_call, dict) else {}
        fps = self._error_call_fingerprints(tc)
        if not fps:
            return None
        thread_id = self._thread_id_from_tool_request(request)
        now = time.monotonic()
        cutoff = now - _EXPLORE_DECAY_SECONDS
        hit = False
        with self._lock:
            history = self._error_history.get(thread_id)
            if history:
                recent = [(h, ts) for h, ts in history if ts >= cutoff]
                self._error_history[thread_id] = recent
                for fp in fps:
                    if _count_fingerprint(recent, fp) >= _ERROR_HARD_THRESHOLD:
                        hit = True
                        break
        if not hit:
            return None
        tool_call_id = _tool_call_id(tc)
        if not tool_call_id:
            return None
        with self._lock:
            self._block_tool_call_ids[thread_id].add(tool_call_id)
            self._block_error_msg[thread_id] = True
        logger.error(
            "Repeat identical error — blocking tool call (run continues)",
            extra={
                "thread_id": thread_id,
                "tool": str(tc.get("name") or "?"),
                "fingerprints": fps,
            },
        )
        # Reuse the generic pop path so block-message selection stays in one place.
        return self._maybe_block_tool(request)

    def _track_tool_result_errors(self, request: ToolCallRequest, result: ToolMessage | Command) -> None:
        """Record an error-result fingerprint after execution (read/list_dir/terminal only)."""
        if isinstance(result, Command) or not isinstance(result, ToolMessage):
            return
        content = str(getattr(result, "content", "") or "")
        low = content.strip().lower()
        if getattr(result, "status", None) != "error" and not low.startswith("error"):
            return
        tc = request.tool_call if isinstance(request.tool_call, dict) else {}
        name = str(tc.get("name") or "")
        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
        fp = self._error_result_fingerprint(name, content, args)
        if not fp:
            return
        thread_id = self._thread_id_from_tool_request(request)
        now = time.monotonic()
        with self._lock:
            if thread_id in self._error_history:
                self._error_history.move_to_end(thread_id)
            else:
                self._error_history[thread_id] = []
                self._evict_if_needed()
            history = self._error_history[thread_id]
            history.append((fp, now))
            if len(history) > self.window_size:
                history[:] = history[-self.window_size :]

    def _check_explore_loops(
        self,
        thread_id: str,
        tool_calls: list[dict],
    ) -> str | None:
        """Same-target explore thrash: warn at N, hard-block read/list_dir/terminal repeats.

        Each call gets a target fingerprint (``_explore_loop_fingerprint``: path+offset
        bucket / pattern / normalized command). Search/discovery tools (rg, find,
        search_code_index) are tracked for warnings but never hard-blocked — legitimate
        research repeats queries with small tweaks. Blocking registers only the offending
        tool call ids, so mixed batches keep executing their healthy calls.
        """
        if not tool_calls:
            return None
        now = time.monotonic()
        cutoff = now - _EXPLORE_DECAY_SECONDS
        decision: str | None = None
        block_ids: list[str] = []
        with self._lock:
            if thread_id in self._explore_history:
                self._explore_history.move_to_end(thread_id)
            else:
                self._explore_history[thread_id] = []
                self._evict_if_needed()
            history = self._explore_history[thread_id]
            history[:] = [(h, ts) for h, ts in history if ts >= cutoff]
            for tc in tool_calls:
                fp = _explore_loop_fingerprint(tc)
                if not fp:
                    continue
                history.append((fp, now))
                count = _count_fingerprint(history, fp)
                if count >= _EXPLORE_HARD_THRESHOLD and not _is_search_discovery_tool(
                    str(tc.get("name") or "")
                ):
                    tid = _tool_call_id(tc)
                    if tid:
                        block_ids.append(tid)
                    decision = _EXPLORE_BLOCK_MSG
                elif count >= _EXPLORE_WARN_THRESHOLD:
                    warned = self._explore_warned[thread_id]
                    if fp not in warned:
                        warned.add(fp)
                        logger.warning(
                            "Explore target repeated — injecting warning",
                            extra={
                                "thread_id": thread_id,
                                "fingerprint": fp,
                                "count": count,
                            },
                        )
                        decision = decision or _EXPLORE_WARNING_MSG
            if len(history) > self.window_size:
                history[:] = history[-self.window_size :]
            if block_ids:
                self._block_tool_call_ids[thread_id].update(block_ids)
                self._block_explore_msg[thread_id] = True
        if block_ids:
            logger.error(
                "Explore loop hard limit — blocking same-target calls (run continues)",
                extra={
                    "thread_id": thread_id,
                    "blocked": len(block_ids),
                },
            )
        return decision

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
        """Consecutive read/list_dir/terminal batches with no act/progress — warn (block off).

        Streak batches increment the counter; any batch containing an act/progress tool
        resets it. Search-only batches (rg/find/web_search …) neither increment nor reset
        so legitimate multi-step research doesn't trip the warn. ``_EXPLORE_STREAK_HARD=0``
        keeps the block disabled: same-target thrash is already covered by
        :meth:`_check_explore_loops`, and research pacing should warn, not intercept.
        """
        if not _is_explore_streak_batch(tool_calls):
            if _batch_has_act_or_progress(tool_calls):
                with self._lock:
                    self._explore_streak[thread_id] = 0
            return None
        with self._lock:
            self._explore_streak[thread_id] += 1
            count = self._explore_streak[thread_id]
            if count < _EXPLORE_STREAK_WARN:
                return None
            if self._explore_streak_warned[thread_id]:
                return None
            self._explore_streak_warned[thread_id] = True
        logger.warning(
            "Explore streak — no act/progress for consecutive batches",
            extra={"thread_id": thread_id, "streak": count},
        )
        if _EXPLORE_STREAK_HARD > 0 and count >= _EXPLORE_STREAK_HARD:
            with self._lock:
                self._block_explore_streak_msg[thread_id] = True
                for tc in tool_calls:
                    tid = _tool_call_id(tc)
                    if tid:
                        self._block_tool_call_ids[thread_id].add(tid)
            return _EXPLORE_STREAK_BLOCK_MSG
        return _EXPLORE_STREAK_WARN_MSG

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
        blocked = self._maybe_block_error_repeat(request)
        if blocked is not None:
            return blocked
        result = handler(request)
        self._track_tool_result_errors(request, result)
        return result

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        blocked = self._maybe_block_tool(request)
        if blocked is not None:
            return blocked
        blocked = self._maybe_block_error_repeat(request)
        if blocked is not None:
            return blocked
        result = await handler(request)
        self._track_tool_result_errors(request, result)
        return result

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
