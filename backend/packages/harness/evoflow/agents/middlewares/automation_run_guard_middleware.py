"""Guardrails for unattended automation / proactive runs: cap tool rounds and force a final answer."""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.agents.automation_runtime import is_unattended_automation, triggered_by_proactive

logger = logging.getLogger(__name__)

_DEFAULT_MAX_TOOL_ROUNDS = 24
# Duty default: no tool-round soft/hard wrap (0 = disabled). Cron/automation still capped.
# Restore old 80-step behaviour with EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS=80.
_DEFAULT_PROACTIVE_MAX_TOOL_ROUNDS = 0
_HARD_STOP_MSG = (
    "[自动化步数保护] 本轮工具调用次数已达上限。"
    "请立即停止调用工具，根据已收集的信息输出最终结论（可标注不确定项），"
    "不要再发起 web_search、read 或 execute。"
)
_PROACTIVE_HARD_STOP_MSG = (
    "[值班步数保护] 本轮工具调用已达上限。"
    "请用文字收尾（本轮结论 / 阻塞 / 下一步），**禁止再调用任何工具**；"
    "空 tool_calls 结束本轮。"
)
_PROACTIVE_SOFT_STOP_MSG = (
    "[值班步数保护·预留收尾] 探测工具额度将尽。"
    "有未结 Task 时下一轮只允许结案类调用："
    "优先 ``tasks`` 工具（action=progress|state|create），"
    "或 terminal：``evoflow tasks progress <task_id> --progress N`` / "
    "``evoflow tasks state … --status completed --summary \"…\"`` / "
    "``employees wake`` / ``approvals request``；"
    "进度成功后本窗口探测额度重置并继续干活。"
    "无未结 Task 时请直接文字收尾。禁止再 read/rg/find/write。"
)
_PROACTIVE_SOFT_WRAP_MARKER = "[值班步数保护·预留收尾]"
_PROACTIVE_SOFT_WRAP_HUMAN = (
    f"{_PROACTIVE_SOFT_WRAP_MARKER}\n"
    "本窗口探测额度已尽，系统已取消探测类 tool_calls。\n"
    "1. 立刻用 ``tasks``（action=progress / state=completed，outputs 用数组）"
    "或 terminal：``evoflow tasks progress <task_id> --progress N`` / "
    "``evoflow tasks state <id> --status completed --summary \"…\"``"
    "（需要协作则 wake / approvals；进度无 ``--note``）。\n"
    "2. **进度/结案成功后本窗口探测额度会重置**——那不是下班信号，"
    "重置后应继续取证/改码；勿再说「额度用完」或提前结束本轮。\n"
    "本轮总工具次数仍有硬上限。禁止再 read / rg / find / write / web_* / mind_map"
    "（直到进度成功、额度重置）。"
)
_PROACTIVE_SOFT_WRAP_EMPTY_BOARD_HUMAN = (
    f"{_PROACTIVE_SOFT_WRAP_MARKER}\n"
    "探测额度已尽，且当前**无未结 Task**。系统已取消探测类 tool_calls。\n"
    "请**只输出文字结论**（本轮巡检所见 / 无待办 / 建议下一步），"
    "**禁止再调用任何工具**；空 tool_calls 结束本轮。勿空建单。"
)
_PROACTIVE_HARD_WRAP_MARKER = "[值班步数保护·强制收尾]"
_PROACTIVE_HARD_WRAP_HUMAN = (
    f"{_PROACTIVE_HARD_WRAP_MARKER}\n"
    "工具步数已达硬上限。请**只输出文字结论**（做了什么 / 卡在哪 / 建议下一步），"
    "禁止再调用任何工具；空 tool_calls 结束。"
)
_PROACTIVE_DIG_RESUME_MARKER = "[值班步数保护·探测恢复]"
_PROACTIVE_DIG_RESUME_HUMAN = (
    f"{_PROACTIVE_DIG_RESUME_MARKER}\n"
    "进度/结案类调用已成功，**本窗口探测额度已重置**。"
    "请继续取证或改码；不要再说「额度用完」或提前收尾。"
    "本轮总工具次数仍有硬上限。"
)
_MAX_SOFT_WRAP_NUDGES = 2
_MAX_HARD_WRAP_NUDGES = 1

# Dig / explore tools — stripped at soft limit so reserved slots stay for Task CLI.
_DIG_TOOL_NAMES = frozenset(
    {
        "read",
        "read_file",
        "write",
        "write_file",
        "replace",
        "edit_file",
        "delete",
        "find",
        "glob",
        "rg",
        "grep",
        "web_search",
        "web_fetch",
        "fetch_url",
        "todo",
        "todo_write",
        "search_file",
        "list_dir",
        # mind_map is optional on duty; still dig-like at soft limit
        "mind_map",
    }
)

# Out-of-band wrap counters survive SessionTranscriptHydration (which wipes
# non-persisted HumanMessages every before_model). Keyed by thread|round.
_WRAP_STATE_LOCK = threading.Lock()
_WRAP_STATE: dict[str, dict[str, Any]] = {}
_WRAP_STATE_MAX_KEYS = 256


def _max_tool_rounds(*, proactive: bool) -> int:
    """Tool-round budget. Proactive: ``0`` disables soft/hard wrap (default)."""
    env_key = "EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS" if proactive else "EVOFLOW_AUTOMATION_MAX_TOOL_ROUNDS"
    default = _DEFAULT_PROACTIVE_MAX_TOOL_ROUNDS if proactive else _DEFAULT_MAX_TOOL_ROUNDS
    raw = (os.getenv(env_key) or "").strip()
    if raw:
        try:
            n = int(raw)
        except ValueError:
            return default
        if proactive:
            # 0 = off; positive capped for safety when explicitly re-enabled.
            return max(0, min(n, 2000))
        return max(1, min(n, 200))
    return default


def _soft_tool_rounds(limit: int) -> int:
    """Fire stop pressure before hard cap so recursion budget is not burned first.

    Prefer dig: only a thin wrap-up band is reserved for Task CLI / text.
    Tight budgets (≤12, used in tests / env overrides) keep the old ~1/3 reserve
    so unit tests stay stable. Tiny budgets (≤2) skip soft and only hard-cap.
    ``limit <= 0`` means disabled (caller should skip wrap).
    """
    if limit <= 0:
        return 0
    if limit <= 2:
        return limit
    if limit <= 12:
        reserved = max(4, min(10, limit // 3))
    else:
        # e.g. 80 → reserve 8, soft at 72 (was ~26 when default was 36).
        reserved = max(4, min(8, limit // 10))
    return max(1, limit - reserved)


def _tool_call_id(tc: Any) -> str:
    if isinstance(tc, dict):
        return str(tc.get("id") or "").strip()
    return str(getattr(tc, "id", "") or "").strip()


def _is_budget_reset_cli_command(cmd: str) -> bool:
    """Task progress / state / create / wake / approvals = checkpoint, reset dig budget."""
    c = str(cmd or "").lower()
    return (
        "evoflow tasks progress" in c
        or "evoflow tasks state" in c
        or "evoflow tasks create" in c
        or "evoflow employees wake" in c
        or "evoflow approvals request" in c
    )


def _is_task_cli_terminal(tc: Any) -> bool:
    """Allow ``terminal`` only when command looks like Task / employees / approvals CLI."""
    if _tool_call_name(tc) != "terminal":
        return False
    cmd = str(_tool_call_args(tc).get("command") or "").lower()
    return (
        "evoflow tasks" in cmd
        or "evoflow employees" in cmd
        or "evoflow approvals" in cmd
        or "evoflow task " in cmd
    )


def _is_budget_reset_terminal(tc: Any) -> bool:
    if _tool_call_name(tc) != "terminal":
        return False
    return _is_budget_reset_cli_command(str(_tool_call_args(tc).get("command") or ""))


_BUDGET_RESET_TASKS_ACTIONS = frozenset({"progress", "state", "create"})


def _is_budget_reset_tasks_tool(tc: Any) -> bool:
    """Native ``tasks`` tool progress/state/create resets dig window (same as Task CLI)."""
    if _tool_call_name(tc) != "tasks":
        return False
    action = str(_tool_call_args(tc).get("action") or "").strip().lower()
    return action in _BUDGET_RESET_TASKS_ACTIONS


def _is_soft_keep_tool_call(tc: Any) -> bool:
    """Soft limit may keep Task board write path (native tool or CLI)."""
    return _is_task_cli_terminal(tc) or _is_budget_reset_tasks_tool(tc)


def _duty_human_index(messages: list[Any]) -> int:
    """Latest real duty briefing HumanMessage (skip soft/hard wrap nudges)."""
    last = -1
    for i, m in enumerate(messages):
        if not isinstance(m, HumanMessage):
            continue
        body = _content_str(getattr(m, "content", ""))
        if (
            _PROACTIVE_SOFT_WRAP_MARKER in body
            or _PROACTIVE_HARD_WRAP_MARKER in body
            or _PROACTIVE_DIG_RESUME_MARKER in body
        ):
            continue
        last = i
    return last


def _budget_checkpoint_index(messages: list[Any]) -> int:
    """Index after which tool budget is counted.

    Starts after the duty HumanMessage. If the employee later lands a successful
    Task CLI or native ``tasks`` (progress/state/create) ToolMessage, counting
    restarts after that checkpoint (dig budget resets).
    """
    duty = _duty_human_index(messages)
    start = duty + 1 if duty >= 0 else 0

    # Map tool_call_id → whether that call is a budget-reset CLI / tasks tool.
    reset_ids: set[str] = set()
    for m in messages[start:]:
        if not isinstance(m, AIMessage):
            continue
        for tc in list(getattr(m, "tool_calls", None) or []):
            if _is_budget_reset_terminal(tc) or _is_budget_reset_tasks_tool(tc):
                tid = _tool_call_id(tc)
                if tid:
                    reset_ids.add(tid)

    if not reset_ids:
        return start

    last_cp = -1
    for i, m in enumerate(messages):
        if i < start or not isinstance(m, ToolMessage):
            continue
        tcid = str(getattr(m, "tool_call_id", "") or "").strip()
        if tcid not in reset_ids:
            continue
        body = _content_str(getattr(m, "content", "")).lower()
        # Skip obvious hard failures so a broken CLI doesn't unlock more dig budget.
        if "traceback" in body and "error" in body:
            continue
        if "command not found" in body or "not recognized" in body:
            continue
        # argparse / bad flags (e.g. invented --note on tasks progress)
        if "unrecognized arguments" in body or "invalid choice" in body:
            continue
        if "usage:" in body and ("error:" in body or "the following arguments are required" in body):
            continue
        # Native tasks tool validation / soft failures
        if "error invoking tool" in body:
            continue
        if '"ok": false' in body or '"ok":false' in body:
            continue
        if "input should be a valid list" in body:
            continue
        last_cp = i

    if last_cp >= 0:
        return last_cp + 1
    return start


def _count_tool_messages_this_turn(messages: list[Any]) -> int:
    """Count ToolMessages in the current dig window (after duty human or last checkpoint).

    Soft/hard wrap HumanMessages must **not** reset the counter by themselves —
    only Task CLI progress/report checkpoints do.
    """
    start = _budget_checkpoint_index(messages)
    return sum(1 for m in messages[start:] if isinstance(m, ToolMessage))


def _content_str(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    return str(content)


def _count_marker_humans(
    messages: list[Any],
    marker: str,
    *,
    after_index: int = 0,
) -> int:
    """Count wrap nudges only inside the current dig window (after checkpoint)."""
    n = 0
    for i, m in enumerate(messages):
        if i < after_index:
            continue
        if isinstance(m, HumanMessage) and marker in _content_str(getattr(m, "content", "")):
            n += 1
    return n


def _window_has_soft_banner(messages: list[Any], *, after_index: int = 0) -> bool:
    """True if soft-stop banner already shown in this dig window (avoid UI spam)."""
    for i, m in enumerate(messages):
        if i < after_index:
            continue
        if _PROACTIVE_SOFT_WRAP_MARKER in _content_str(getattr(m, "content", "")):
            return True
    return False


def _append_soft_banner(content: Any, *, already: bool) -> str:
    """Append soft-stop banner at most once per dig window."""
    body = _content_str(content).rstrip()
    if already or _PROACTIVE_SOFT_WRAP_MARKER in body:
        return body
    if not body:
        return _PROACTIVE_SOFT_STOP_MSG
    return f"{body}\n\n{_PROACTIVE_SOFT_STOP_MSG}"


def _tool_call_name(tc: Any) -> str:
    if isinstance(tc, dict):
        return str(tc.get("name") or "").strip()
    return str(getattr(tc, "name", "") or "").strip()


def _tool_call_args(tc: Any) -> dict[str, Any]:
    if isinstance(tc, dict):
        args = tc.get("args")
    else:
        args = getattr(tc, "args", None)
    return args if isinstance(args, dict) else {}


def _partition_soft_tool_calls(tool_calls: list[Any]) -> tuple[list[Any], list[Any]]:
    """Split into (keep Task board writes / CLI, strip dig/other)."""
    keep: list[Any] = []
    strip: list[Any] = []
    for tc in tool_calls:
        name = _tool_call_name(tc)
        if _is_soft_keep_tool_call(tc):
            keep.append(tc)
        elif name in _DIG_TOOL_NAMES or name == "terminal":
            strip.append(tc)
        else:
            # Unknown tools: strip at soft limit (safer than burning reserve).
            strip.append(tc)
    return keep, strip


def _duty_board_empty(messages: list[Any]) -> bool:
    """True when live Task footer / briefing says there are no open tasks."""
    markers = ("暂无未结", "本岗看板暂无未结", "各岗暂无未结")
    for m in reversed(messages):
        if not isinstance(m, HumanMessage):
            continue
        body = _content_str(getattr(m, "content", ""))
        if "<proactive_live_tasks>" in body or "当前未结 Task" in body or "本岗**当前未结" in body:
            return any(x in body for x in markers)
        if body.startswith("# 值班") and any(x in body for x in markers):
            return True
    # Also scan recent tool/AI chatter that echoes empty board
    for m in reversed(messages[-12:]):
        body = _content_str(getattr(m, "content", ""))
        if "暂无未结" in body and ("Task" in body or "task" in body.lower()):
            return True
    return False


def _thread_id_from_runtime(runtime: Runtime | None) -> str:
    try:
        from evoflow.agents.automation_runtime import runtime_context_dict

        ctx = runtime_context_dict(runtime)
        tid = str(ctx.get("thread_id") or "").strip()
        if tid:
            return tid
    except Exception:
        pass
    try:
        from langgraph.config import get_config

        return str(get_config().get("configurable", {}).get("thread_id") or "").strip()
    except Exception:
        return ""


def _round_id_from_runtime(runtime: Runtime | None) -> str:
    try:
        from evoflow.agents.automation_runtime import runtime_context_dict

        ctx = runtime_context_dict(runtime)
        return str(ctx.get("round_id") or ctx.get("proactive_round_id") or "").strip()
    except Exception:
        return ""


def _wrap_state_key(runtime: Runtime | None, messages: list[Any]) -> str:
    tid = _thread_id_from_runtime(runtime) or "nothread"
    rid = _round_id_from_runtime(runtime)
    if not rid:
        duty = _duty_human_index(messages)
        if duty >= 0:
            body = _content_str(getattr(messages[duty], "content", ""))[:120]
            rid = f"duty:{hash(body) & 0xFFFFFFFF:x}"
        else:
            rid = "noround"
    return f"{tid}|{rid}"


def _get_wrap_state(key: str) -> dict[str, Any]:
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.get(key)
        if st is None:
            st = {"soft": 0, "hard": 0, "pending_human": None, "empty_board": False}
            _WRAP_STATE[key] = st
            while len(_WRAP_STATE) > _WRAP_STATE_MAX_KEYS:
                _WRAP_STATE.pop(next(iter(_WRAP_STATE)), None)
        return st


def _clear_wrap_state(key: str) -> None:
    with _WRAP_STATE_LOCK:
        _WRAP_STATE.pop(key, None)


def _reset_wrap_state_for_tests() -> None:
    """Test helper — clear process-local wrap counters."""
    with _WRAP_STATE_LOCK:
        _WRAP_STATE.clear()


def _effective_soft_nudges(messages: list[Any], *, window_start: int, key: str) -> int:
    msg_n = _count_marker_humans(messages, _PROACTIVE_SOFT_WRAP_MARKER, after_index=window_start)
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.get(key) or {}
        mem_n = int(st.get("soft") or 0)
    return max(msg_n, mem_n)


def _effective_hard_nudges(messages: list[Any], *, window_start: int, key: str) -> int:
    msg_n = _count_marker_humans(messages, _PROACTIVE_HARD_WRAP_MARKER, after_index=window_start)
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.get(key) or {}
        mem_n = int(st.get("hard") or 0)
    return max(msg_n, mem_n)


def _record_soft_nudge(key: str, *, human: str, empty_board: bool) -> int:
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.setdefault(
            key, {"soft": 0, "hard": 0, "pending_human": None, "empty_board": False}
        )
        st["soft"] = int(st.get("soft") or 0) + 1
        st["pending_human"] = human
        st["empty_board"] = empty_board
        return int(st["soft"])


def _record_hard_nudge(key: str, *, human: str) -> int:
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.setdefault(
            key, {"soft": 0, "hard": 0, "pending_human": None, "empty_board": False}
        )
        st["hard"] = int(st.get("hard") or 0) + 1
        st["pending_human"] = human
        return int(st["hard"])


def _peek_pending_human(key: str) -> str | None:
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.get(key)
        if not st:
            return None
        text = st.get("pending_human")
        return str(text) if text else None


def _soft_pressure_active(key: str) -> bool:
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.get(key) or {}
        if int(st.get("soft") or 0) > 0:
            return True
        pending = str(st.get("pending_human") or "")
        return _PROACTIVE_SOFT_WRAP_MARKER in pending and _PROACTIVE_HARD_WRAP_MARKER not in pending


def _clear_pending_human(key: str) -> None:
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.get(key)
        if st is not None:
            st["pending_human"] = None


def _reset_soft_wrap_window(key: str) -> None:
    """Task CLI checkpoint reopened dig budget — drop soft pressure only (hard stays)."""
    with _WRAP_STATE_LOCK:
        st = _WRAP_STATE.get(key)
        if not st:
            return
        st["soft"] = 0
        # Drop soft wrap pending; keep hard wrap pending if any.
        pending = str(st.get("pending_human") or "")
        if _PROACTIVE_HARD_WRAP_MARKER not in pending:
            st["pending_human"] = None
        st["empty_board"] = False


def _window_has_marker(messages: list[Any], marker: str, *, after_index: int = 0) -> bool:
    for i, m in enumerate(messages):
        if i < after_index:
            continue
        if marker in _content_str(getattr(m, "content", "")):
            return True
    return False


class AutomationRunGuardMiddleware(AgentMiddleware[AgentState]):
    """After model: for cron/proactive runs, stop endless tool loops and recursion burn-through.

    Proactive **soft** limit: counted in the current dig *window* (resets after
    successful Task CLI progress/state/create/wake/approvals). Strips dig tools
    and nudges Task CLI wrap-up (or text wrap-up when the Task board is empty).

    After a successful progress/state checkpoint the dig window reopens: soft
    pressure and pending soft wrap Humans must **not** be re-injected, or the
    model keeps saying「探测额度已用完」and wrapping up.

    Proactive **hard** limit: counted over the **whole duty turn** (never reset by
    progress). Prevents ``tasks progress`` from unlocking infinite dig until
    LangGraph ``recursion_limit`` dies first.

    Wrap nudge counts are kept **out-of-band** (thread|round) so
    ``SessionTranscriptHydrationMiddleware`` cannot wipe them by replacing
    runtime messages from DB every ``before_model``.

    Cron/automation: single hard cap on the current window (no soft reserve).
    """

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        """Re-inject wrap Human after hydration — but never after dig budget recovered."""
        if not is_unattended_automation(runtime):
            return None
        from evoflow.agents.automation_runtime import runtime_context_dict

        if not triggered_by_proactive(runtime_context_dict(runtime)):
            return None

        messages = list(state.get("messages") or [])
        if not messages:
            return None
        limit = _max_tool_rounds(proactive=True)
        if limit <= 0:
            return None
        key = _wrap_state_key(runtime, messages)
        soft = _soft_tool_rounds(limit)
        duty = _duty_human_index(messages)
        duty_start = duty + 1 if duty >= 0 else 0
        window_start = _budget_checkpoint_index(messages)
        window_tools = sum(1 for m in messages[window_start:] if isinstance(m, ToolMessage))
        total_tools = sum(1 for m in messages[duty_start:] if isinstance(m, ToolMessage))

        # Progress/state checkpoint reopened the dig window — clear soft pressure and
        # do NOT re-inject stale「探测额度已尽」Humans (that was the wrap-up loop bug).
        if window_tools < soft and total_tools < limit:
            had_soft = _soft_pressure_active(key) or _window_has_marker(
                messages, _PROACTIVE_SOFT_WRAP_MARKER
            )
            _reset_soft_wrap_window(key)
            checkpointed = window_start > duty_start
            if (
                had_soft
                and checkpointed
                and not _window_has_marker(
                    messages, _PROACTIVE_DIG_RESUME_MARKER, after_index=window_start
                )
            ):
                logger.info(
                    "AutomationRunGuard(proactive): dig budget restored after checkpoint "
                    "key=%s window_tools=%d soft=%d — resume dig (no soft wrap re-inject)",
                    key,
                    window_tools,
                    soft,
                )
                return {"messages": [HumanMessage(content=_PROACTIVE_DIG_RESUME_HUMAN)]}
            return None

        pending = _peek_pending_human(key)
        if not pending:
            return None
        # Already present (e.g. tests that keep Human in the list)
        if any(
            isinstance(m, HumanMessage)
            and (
                _PROACTIVE_SOFT_WRAP_MARKER in _content_str(getattr(m, "content", ""))
                or _PROACTIVE_HARD_WRAP_MARKER in _content_str(getattr(m, "content", ""))
            )
            for m in messages[-4:]
        ):
            return None
        logger.info(
            "AutomationRunGuard(proactive): re-inject wrap Human after hydration key=%s",
            key,
        )
        return {"messages": [HumanMessage(content=pending)]}

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)

    @override
    @hook_config(can_jump_to=["model", "end"])
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._apply(state, runtime)

    @override
    @hook_config(can_jump_to=["model", "end"])
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._apply(state, runtime)

    def _apply(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        if not is_unattended_automation(runtime):
            return None

        messages = state.get("messages") or []
        if not messages:
            return None

        from evoflow.agents.automation_runtime import runtime_context_dict

        proactive = triggered_by_proactive(runtime_context_dict(runtime))
        limit = _max_tool_rounds(proactive=proactive)
        if proactive and limit <= 0:
            return None
        duty = _duty_human_index(messages)
        duty_start = duty + 1 if duty >= 0 else 0
        window_start = _budget_checkpoint_index(messages)
        window_tools = sum(1 for m in messages[window_start:] if isinstance(m, ToolMessage))
        total_tools = sum(1 for m in messages[duty_start:] if isinstance(m, ToolMessage))
        soft = _soft_tool_rounds(limit) if proactive else limit
        key = _wrap_state_key(runtime, messages)

        # Soft pressure uses the dig window; hard uses lifetime this duty turn.
        if proactive:
            if window_tools < soft and total_tools < limit:
                # Dig window recovered (e.g. successful Task CLI) — clear soft nudge memory
                # so a later soft hit can nudge again; hard lifetime counter stays.
                _reset_soft_wrap_window(key)
                return None
        elif window_tools < soft:
            return None

        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None

        tool_calls = list(getattr(last, "tool_calls", None) or [])
        if not tool_calls:
            # Text-only response — clear pending wrap so next duty starts clean.
            if proactive:
                _clear_pending_human(key)
            return None

        at_hard = (total_tools if proactive else window_tools) >= limit

        if proactive:
            return self._apply_proactive(
                last,
                tool_calls,
                messages=messages,
                tool_rounds=total_tools if at_hard else window_tools,
                soft=soft,
                limit=limit,
                at_hard=at_hard,
                window_start=window_start if not at_hard else duty_start,
                key=key,
            )

        if not at_hard:
            return None

        logger.warning(
            "AutomationRunGuard: tool_rounds=%d limit=%d — stripping tool_calls",
            window_tools,
            limit,
        )
        stripped = last.model_copy(
            update={
                "tool_calls": [],
                "content": (last.content or "") + f"\n\n{_HARD_STOP_MSG}",
            }
        )
        return {"messages": [stripped]}

    def _apply_proactive(
        self,
        last: AIMessage,
        tool_calls: list[Any],
        *,
        messages: list[Any],
        tool_rounds: int,
        soft: int,
        limit: int,
        at_hard: bool,
        window_start: int,
        key: str,
    ) -> dict[str, Any] | None:
        empty_board = _duty_board_empty(messages)

        if at_hard:
            hard_nudges = _effective_hard_nudges(messages, window_start=window_start, key=key)
            if hard_nudges >= _MAX_HARD_WRAP_NUDGES:
                logger.warning(
                    "AutomationRunGuard(proactive): hard limit tool_rounds=%d — strip & end "
                    "(already nudged %d)",
                    tool_rounds,
                    hard_nudges,
                )
                _clear_wrap_state(key)
                stripped = last.model_copy(
                    update={
                        "tool_calls": [],
                        "content": (last.content or "") + f"\n\n{_PROACTIVE_HARD_STOP_MSG}",
                    }
                )
                return {"messages": [stripped], "jump_to": "end"}

            n = _record_hard_nudge(key, human=_PROACTIVE_HARD_WRAP_HUMAN)
            logger.warning(
                "AutomationRunGuard(proactive): hard limit tool_rounds=%d — "
                "strip tools, jump_to=model for text wrap-up (nudge %d)",
                tool_rounds,
                n,
            )
            stripped = last.model_copy(
                update={
                    "tool_calls": [],
                    "content": (last.content or "") + f"\n\n{_PROACTIVE_HARD_STOP_MSG}",
                }
            )
            return {
                "messages": [
                    stripped,
                    HumanMessage(content=_PROACTIVE_HARD_WRAP_HUMAN),
                ],
                "jump_to": "model",
            }

        # Soft: keep Task CLI terminals; strip dig tools; continue model for wrap-up.
        keep, strip = _partition_soft_tool_calls(tool_calls)
        if keep and not strip:
            return None  # already on Task CLI path — let tools run

        soft_nudges = _effective_soft_nudges(messages, window_start=window_start, key=key)
        banner_already = _window_has_soft_banner(messages, after_index=window_start) or soft_nudges > 0

        # Empty board: no Task CLI to run — do not loop on "please tasks progress".
        if empty_board and not keep:
            if soft_nudges >= 1:
                logger.warning(
                    "AutomationRunGuard(proactive): soft tool_rounds=%d empty_board — strip & end "
                    "(already text-nudged %d)",
                    tool_rounds,
                    soft_nudges,
                )
                _clear_wrap_state(key)
                stripped = last.model_copy(
                    update={
                        "tool_calls": [],
                        "content": _append_soft_banner(last.content, already=banner_already),
                    }
                )
                return {"messages": [stripped], "jump_to": "end"}

            human = _PROACTIVE_SOFT_WRAP_EMPTY_BOARD_HUMAN
            n = _record_soft_nudge(key, human=human, empty_board=True)
            logger.warning(
                "AutomationRunGuard(proactive): soft tool_rounds=%d empty_board — "
                "strip dig, jump_to=model for text wrap-up (nudge %d)",
                tool_rounds,
                n,
            )
            stripped = last.model_copy(
                update={
                    "tool_calls": [],
                    "content": _append_soft_banner(last.content, already=banner_already),
                }
            )
            return {
                "messages": [stripped, HumanMessage(content=human)],
                "jump_to": "model",
            }

        if keep:
            logger.warning(
                "AutomationRunGuard(proactive): soft tool_rounds=%d soft=%d limit=%d — "
                "keeping %d Task-CLI call(s), stripping %d dig call(s)",
                tool_rounds,
                soft,
                limit,
                len(keep),
                len(strip),
            )
            narrowed = last.model_copy(
                update={
                    "tool_calls": keep,
                    "content": _append_soft_banner(last.content, already=banner_already),
                }
            )
            return {"messages": [narrowed]}

        if soft_nudges >= _MAX_SOFT_WRAP_NUDGES:
            logger.warning(
                "AutomationRunGuard(proactive): soft tool_rounds=%d — strip & end "
                "(soft wrap nudges exhausted %d)",
                tool_rounds,
                soft_nudges,
            )
            _clear_wrap_state(key)
            stripped = last.model_copy(
                update={
                    "tool_calls": [],
                    "content": _append_soft_banner(last.content, already=banner_already),
                }
            )
            return {"messages": [stripped], "jump_to": "end"}

        human = _PROACTIVE_SOFT_WRAP_HUMAN
        n = _record_soft_nudge(key, human=human, empty_board=False)
        logger.warning(
            "AutomationRunGuard(proactive): soft tool_rounds=%d soft=%d limit=%d — "
            "strip dig tools, jump_to=model for Task CLI wrap-up (nudge %d/%d)",
            tool_rounds,
            soft,
            limit,
            n,
            _MAX_SOFT_WRAP_NUDGES,
        )
        stripped = last.model_copy(
            update={
                "tool_calls": [],
                "content": _append_soft_banner(last.content, already=banner_already),
            }
        )
        return {
            "messages": [
                stripped,
                HumanMessage(content=human),
            ],
            "jump_to": "model",
        }
