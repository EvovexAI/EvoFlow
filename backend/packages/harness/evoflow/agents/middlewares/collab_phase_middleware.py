"""Inject collaboration phase rules into the model context (multi-agent collab design §6.1)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.timeutil import utc_now_iso_z

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.collab.id_format import make_formatted_id
from evoflow.collab.models import CollabPhase
from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.collab.thread_collab import load_thread_collab_state, merge_thread_collab_state, save_thread_collab_state
from evoflow.config.paths import get_paths

# Per-task forced-monitor throttle (cooldown only). Do not cap total injections while
# subtasks stay in the same non-terminal status — long runs legitimately keep the same
# signature for minutes; a small "max forced" budget would stop monitoring entirely.
_FORCED_MONITOR_GUARD: dict[str, dict[str, Any]] = {}
_FORCED_MONITOR_COOLDOWN_SECONDS = 8.0
_FORCED_MONITOR_MAX_CONSECUTIVE = 5

# supervisor 动作：必须带 task_id 且与当前绑定主任务 id 一致，才算「触达协作主任务」（读/写均可）。
_SUPERVISOR_ACTIONS_TOUCHING_BOUND_TASK = frozenset(
    {
        "monitor_execution_step",
        "get_status",
        "get_subtask_conversation",
        "interrupt_subtask",
        "steer_subtask",
        "get_task_memory",
        "start_execution",
        "update_progress",
        "complete_subtask",
        "create_subtask",
        "create_subtasks",
        "list_subtasks",
        "set_task_planned",
    }
)


def _forced_monitor_guard_key(task_id: str, thread_id: str) -> str:
    tid = str(task_id or "").strip()
    th = str(thread_id or "").strip()
    return f"{tid}:{th}" if tid and th else tid or th


def _subtasks_have_recent_retry_activity(subtasks: list[dict[str, Any]], *, window_seconds: float = 45.0) -> bool:
    """True when a subtask was recently requeued/retrying (async dispatch may not show in_progress yet)."""
    import time

    from evoflow.timeutil import parse_iso_to_unix

    now = time.time()
    for st in subtasks:
        if not isinstance(st, dict):
            continue
        status = str(st.get("status") or "").strip().lower()
        if status not in {"pending", "planned", "waiting_dispatch", "executing", "running", "in_progress"}:
            continue
        for key in ("last_auto_retry_at", "last_retry_at", "updated_at"):
            ts = parse_iso_to_unix(str(st.get(key) or ""))
            if ts > 0 and (now - ts) < window_seconds:
                if int(st.get("retry_count") or st.get("auto_retry_count") or 0) > 0:
                    return True
                if key in {"last_auto_retry_at", "last_retry_at"}:
                    return True
    return False


def _tool_calls_include_monitor_for_bound_task(tool_calls: list[Any] | None, bound_task_id: str) -> bool:
    bid = str(bound_task_id or "").strip()
    if not bid:
        return False
    for tc in tool_calls or []:
        d = _tool_call_as_dict(tc)
        if str(d.get("name", "")).strip() != "supervisor":
            continue
        args = _normalize_tool_call_args(d)
        if str(args.get("task_id", "")).strip() != bid:
            continue
        act = str(args.get("action", "")).strip()
        if act == "monitor_execution_step":
            return True
    return False


def _tool_calls_include_status_read_for_bound_task(tool_calls: list[Any] | None, bound_task_id: str) -> bool:
    """Whether this turn already reads latest status for the bound task."""
    bid = str(bound_task_id or "").strip()
    if not bid:
        return False
    for tc in tool_calls or []:
        d = _tool_call_as_dict(tc)
        if str(d.get("name", "")).strip() != "supervisor":
            continue
        args = _normalize_tool_call_args(d)
        if str(args.get("task_id", "")).strip() != bid:
            continue
        act = str(args.get("action", "")).strip()
        if act in {"get_status", "list_subtasks", "monitor_execution_step"}:
            return True
    return False


def _tool_call_as_dict(tc: Any) -> dict[str, Any]:
    if isinstance(tc, dict):
        return tc
    name = getattr(tc, "name", None)
    args = getattr(tc, "args", None)
    tid = getattr(tc, "id", None)
    return {"name": name, "args": args if args is not None else {}, "id": tid}


def _normalize_tool_call_args(tc: dict[str, Any]) -> dict[str, Any]:
    args = tc.get("args")
    if args is None:
        args = tc.get("arguments")
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return args if isinstance(args, dict) else {}


def _tool_calls_touch_bound_collab_task(tool_calls: list[Any] | None, bound_task_id: str) -> bool:
    """本轮是否已通过 supervisor 读写过当前绑定的协作主任务（防止只调 web_search 等就结束一轮）。"""
    bid = str(bound_task_id or "").strip()
    if not bid:
        return False
    for tc in tool_calls or []:
        d = _tool_call_as_dict(tc)
        if str(d.get("name", "")).strip() != "supervisor":
            continue
        args = _normalize_tool_call_args(d)
        action = str(args.get("action", "")).strip()
        if action not in _SUPERVISOR_ACTIONS_TOUCHING_BOUND_TASK:
            continue
        tid = str(args.get("task_id", "")).strip()
        if tid == bid:
            return True
    return False


def _planning_like_phases_covered_by_main_prompt_guard() -> frozenset[str]:
    """Matches ``prompt._build_collab_phase_guard_section`` planning-like branch."""
    return frozenset(
        {
            CollabPhase.PLANNING.value,
            CollabPhase.PLAN_READY.value,
            CollabPhase.AWAITING_EXEC.value,
        }
    )


def _effective_collab_for_hints(ctx: dict[str, Any]) -> tuple[str | None, str | None]:
    """Resolve phase + bound ids for hints.

    Run context is fixed for the whole LangGraph stream, but ``supervisor(start_execution)``
    and HTTP authorize update ``collab_state.json`` on disk. Re-read per model step so the lead
    model sees ``executing`` and ``bound_task_id`` immediately after authorization.
    """
    ctx_phase_raw = ctx.get("collab_phase")
    ctx_phase = str(ctx_phase_raw).strip() if ctx_phase_raw not in (None, "") else None
    ctx_ct = str(ctx.get("collab_task_id") or "").strip() or None
    tid = str(ctx.get("thread_id") or "").strip() or None

    eff_phase = ctx_phase
    eff_ct = ctx_ct

    if tid:
        try:
            disk = load_thread_collab_state(get_paths(), tid)
            d_phase = disk.collab_phase
            d_phase_str = d_phase.value if isinstance(d_phase, CollabPhase) else str(d_phase)
            d_bt = str(disk.bound_task_id or "").strip() or None
            if d_phase != CollabPhase.IDLE:
                eff_phase = d_phase_str
            # 流式 run 的 context 整轮固定；start_execution 只写磁盘。executing 阶段必须以磁盘绑定为准，
            # 否则 ctx 里旧的 collab_task_id 会盖住 bound_task_id，模型一直拿不到正确主任务 id。
            if d_phase == CollabPhase.EXECUTING:
                eff_ct = d_bt or ctx_ct
            else:
                eff_ct = ctx_ct or d_bt
        except Exception:
            pass

    if not eff_phase or eff_phase == CollabPhase.IDLE.value:
        return None, None
    return eff_phase, eff_ct


def _live_task_snapshot_for_hint(main_task_id: str) -> str:
    """从项目存储重读主/子任务状态，注入到每轮模型调用前。

    解决：长监控链路里若开启摘要或上下文截断，较早的 ``ToolMessage`` 可能丢失，
    模型仍能看到当前子任务进度（与上一轮调度说明互补，减少「重复同一句话」）。
    """
    tid = str(main_task_id or "").strip()
    if not tid:
        return ""
    try:
        storage = get_project_storage()
        row = find_main_task(storage, tid)
        if not row:
            return ""
        _proj, task = row
        title = str(task.get("name") or task.get("id") or "")[:100]
        ms = str(task.get("status") or "")
        try:
            mp = int(task.get("progress") or 0)
        except (TypeError, ValueError):
            mp = 0
        lines: list[str] = [
            f"- 主任务：{title}",
            f"  状态 {ms} · 进度 {mp}%",
        ]
        subs = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
        for st in subs[:20]:
            sid = str(st.get("id") or "")[:12]
            nm = str(st.get("name") or "")[:56]
            ss = str(st.get("status") or "")
            try:
                pr = int(st.get("progress") or 0)
            except (TypeError, ValueError):
                pr = 0
            lines.append(f"  - 子任务 {sid}… {nm} → {ss} ({pr}%)")
        out = "\n".join(lines)
        return out if len(out) <= 1400 else out[:1397] + "..."
    except Exception:
        return ""


def _collab_hint_text(
    phase: str,
    *,
    collab_task_id: str | None,
    subagent_enabled: bool,
    live_snapshot: str | None = None,
) -> str:
    """Build a single system-reminder block for the current collaboration phase."""
    tid = (collab_task_id or "").strip() or None
    ctx_lines = []
    if tid:
        ctx_lines.append(f"- Bound collaborative main task id (`collab_task_id`): `{tid}`")
    ctx_block = "\n".join(ctx_lines) if ctx_lines else "- No explicit `collab_task_id` in this run context yet."

    sub = "Subagent (`task`) tooling is enabled for this run — still respect the phase gates below." if subagent_enabled else "Subagent (`task`) tooling is off for this run."

    common = f"<collab_phase_context>\n**Collaboration phase:** `{phase}`\n{sub}\n{ctx_block}\n"

    if phase == CollabPhase.REQ_CONFIRM.value:
        return (
            common + "**Gate (phase 1 — requirements):** Prefer `ask_clarification` when requirements are missing, "
            "ambiguous, or risky. Do not launch collaborative workers via `task` with `collab_task_id` until "
            "execution is authorized and the phase allows execution.\n" + "</collab_phase_context>"
        )

    if phase == CollabPhase.PLANNING.value:
        return common + "**Planning:** Use `supervisor` to structure work if needed. Do not call `task` with `collab_task_id` to spawn workers for the bound collaborative task until execution is authorized.\n" + "</collab_phase_context>"

    if phase == CollabPhase.PLAN_READY.value:
        return common + "**Plan ready:** Summarize the plan for the user and confirm before execution. Do not start collaborative `task` workers until execution is authorized.\n" + "</collab_phase_context>"

    if phase == CollabPhase.AWAITING_EXEC.value:
        auth_block = ""
        if tid:
            try:
                from evoflow.collab.authorize_execution import is_task_execution_authorized
                from evoflow.collab.storage import get_project_storage

                if is_task_execution_authorized(get_project_storage(), tid):
                    auth_block = (
                        "**Already authorized:** `executionAuthorized=true` (user clicked「开始执行」). "
                        "Gateway should have auto-dispatched wave 1; if phase is still `awaiting_exec`, "
                        "call `supervisor(start_execution, task_id=...)` once as fallback — do **not** ask the user to authorize again. "
                        "Otherwise prefer `monitor_execution_step` / `get_status`. "
                        "`blockedSubtasks` / `waiting_on_dependencies` means DAG order, not missing auth.\n"
                    )
            except Exception:
                pass
        return (
            common
            + "**Awaiting execution:** User authorized「开始执行」. "
            "Prefer monitoring if workers already started; only call `supervisor(start_execution)` if nothing was dispatched. "
            "Then `monitor_execution_step` / `get_status` each turn. Do not ask again whether to start.\n"
            + auth_block
            + "Until phase is `executing`, do not spawn collaborative `task` workers except via supervisor dispatch.\n"
            + "</collab_phase_context>"
        )

    if phase == CollabPhase.PAUSED.value:
        return (
            common + "**Paused:** Task execution is temporarily paused. While paused:\n"
            "- Do NOT call `task` with `collab_task_id` to spawn new collaborative workers\n"
            "- Running subtasks will continue to completion\n"
            "- Wait for the phase to advance back to `executing` before resuming task delegation\n" + "</collab_phase_context>"
        )

    if phase == CollabPhase.EXECUTING.value:
        snap_block = ""
        if live_snapshot and live_snapshot.strip():
            snap_block = "\n**Live snapshot (storage, refreshed every model step):**\n" + live_snapshot.strip() + "\n"
        return (
            common + "**Executing:** Delegate collaborative work with `collab_task_id` from context (and "
            "`collab_subtask_id` when scoped to one subtask).\n"
            + "**Hard rules (executing):**\n"
            + "- Do NOT output or re-output `# Plan` (no plan updates, no plan restatement).\n"
            + "- Do NOT ask for execution authorization again. Authorization already happened to enter `executing`.\n"
            + "- **Capability before dispatch:** Match each Step to a worker via `list_agents`; set `worker_profile.tools` "
            + "from `list_assignable_tools` when the Step needs files/`terminal`/etc. Workers only get collab lifecycle "
            + "tools appended automatically—not a full execution toolkit.\n"
            + "- **Orchestration stays on `supervisor`:** Subtask completion, `blockedSubtasks`, and DAG fields are "
            + "authoritative in `supervisor` tool JSON — keep driving work through `supervisor` (`get_status`, "
            + "`list_subtasks`, `start_execution` (only if a wave still needs dispatch), `monitor_execution_step`, …). "
            + "When launching work, follow "
            + 'numeric `depends_on` refs (`"1"`, `"2"`, … — auto-assigned per create batch) and the latest tool returns rather than guessing order.\n'
            + "- **Main task (overall) `progress` / `status`:** main-task progress auto-syncs from subtasks after each "
            + "`monitor_execution_step` / `get_status` (average, **main cap 99%**). Subtasks may still reach 100% + "
            + "`completed` via worker tools. **Main-task `completed` + 100% are lead-only** — after Plan validation call "
            + "`update_progress(..., progress=100, status=completed)` or `set_task_state(status=completed)`.\n"
            + "- **Subtask progress:** workers must call `subtask_progress_report` (and/or `subtask_work_checklist`) "
            + "during execution; if subtasks sit at 0% while running, use `continue_subtask_session` with a nudge.\n"
            + "- Each assistant turn should include the necessary `supervisor` tool call(s) to make progress "
            + "(start/monitor/get_status/update_progress/etc). Prose-only turns are allowed only for final results.\n"
            + "**Active control (you stay in charge):** While subtasks run, each model turn should combine "
            "short reasoning in `content` with one or more `supervisor` tool calls. Examples: "
            "`monitor_execution_step` or `get_status` / `get_subtask_conversation` for worker transcripts; "
            "stuck `project-*` steps: `steer_subtask` (or `interrupt_subtask` then `steer_subtask`); "
            '`update_progress` with `status="cancelled"` or `failed` on a `subtask_id` (or on the main task '
            "without `subtask_id`) to stop work in storage; `create_subtask` / `create_subtasks` then "
            "`start_execution` to add and launch more work. Prose alone does not cancel or create tasks—"
            "emit the matching tools in the same assistant message when possible.\n" + snap_block + "</collab_phase_context>"
        )

    if phase == CollabPhase.DONE.value:
        return (
            common
            + "**Done（已完成）**：主任务已进入终态（completed/failed/cancelled）。"
            + "请给用户简短交付总结（交付物、证据、剩余风险）。"
            + "无需手动 deactivate plan 场景，系统会自动切 agent。"
            + "若用户想换模式做新事但协作尚未 done：说明须**先取消或置失败**当前主任务，不可半途切换。"
            + "若用户想开始新 Plan，直接响应即可。\n"
            + "</collab_phase_context>"
        )

    return common + "</collab_phase_context>"


class CollabPhaseMiddleware(AgentMiddleware[AgentState]):
    """On each model call that starts from a user HumanMessage, inject phase guidance."""

    state_schema = AgentState

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._inject(state, runtime)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._inject(state, runtime)

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._enforce_monitoring(state, runtime)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._enforce_monitoring(state, runtime)

    def _inject(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        ctx = runtime.context or {}
        phase, collab_task_id = _effective_collab_for_hints(ctx)
        if not phase:
            return None

        messages = state.get("messages") or []

        # planning-like：主系统提示已有 ``<phase_execution_guard>``（见 ``prompt._build_collab_phase_guard_section``），
        # 再注入 ``<collab_phase_context>`` 与其中条大量重复；跳过（方案 A）。
        if str(phase).strip().lower() in _planning_like_phases_covered_by_main_prompt_guard():
            return None

        if not messages:
            return None

        last = messages[-1]
        phase_l = str(phase).strip().lower()
        # Human turn: always eligible (dedup below).
        # Tool turn (e.g. right after ``monitor_execution_step`` / ``get_status``): in executing/paused
        # we must re-inject phase + live snapshot; otherwise the model only sees tool JSON and may
        # answer as if it were not monitoring / had no task progress.
        if isinstance(last, HumanMessage):
            hint_name = getattr(last, "name", None)
            if hint_name in {"collab_phase_hint", "goal", "goal_controller", "hosted_autofollow"}:
                return None
        elif phase_l in {CollabPhase.EXECUTING.value, CollabPhase.PAUSED.value} and isinstance(last, ToolMessage):
            pass
        else:
            return None

        snap: str | None = None
        if str(phase).strip().lower() == CollabPhase.EXECUTING.value and (collab_task_id or "").strip():
            snap = _live_task_snapshot_for_hint(str(collab_task_id).strip()) or None
        text = _collab_hint_text(
            phase,
            collab_task_id=collab_task_id,
            subagent_enabled=bool(ctx.get("subagent_enabled", False)),
            live_snapshot=snap,
        )
        # 每轮用户消息都会触发注入；若正文与上一条 collab_phase_hint 相同则跳过，避免 state/API
        # 里堆叠多份相同 <collab_phase_context>（调试页合并 system 时看起来像「无限追加」）。
        for m in reversed(messages):
            if isinstance(m, SystemMessage) and getattr(m, "name", None) == "collab_phase_hint":
                prev = getattr(m, "content", None)
                if isinstance(prev, str) and prev == text:
                    return None
                break

        hint = SystemMessage(
            name="collab_phase_hint",
            content=text,
        )
        return {"messages": [hint]}

    def _enforce_monitoring(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        """Hard guard while collab is executing and the bound main task is not terminal.

        1) Prose-only → inject `monitor_execution_step` (unchanged).
        2) Has tool_calls but **none** target the bound `task_id` via `supervisor` (e.g. only `web_search`) →
           **append** `monitor_execution_step` so every graph step still refreshes collaborative task state
           without relying on the model remembering to poll.
        """
        ctx = runtime.context or {}
        if str(ctx.get("prompt_source") or "").strip() in {"goal", "goal_controller", "hosted_autofollow"}:
            return None
        tid = str(ctx.get("thread_id") or "").strip()
        if not tid:
            return None
        try:
            collab = load_thread_collab_state(get_paths(), tid)
        except Exception:
            return None
        phase = collab.collab_phase
        phase_val = phase.value if isinstance(phase, CollabPhase) else str(phase or "")
        if str(phase_val).strip().lower() != CollabPhase.EXECUTING.value:
            return None

        # Executing phase must not output / re-output a plan. Even before a bound task id exists,
        # sanitize plan-like assistant replies to avoid user-visible "updating plan" noise.
        messages = state.get("messages") or []
        if messages and isinstance(messages[-1], AIMessage):
            last_ai: AIMessage = messages[-1]
            try:
                if isinstance(getattr(last_ai, "content", None), str) and str(last_ai.content).lstrip().startswith("# Plan"):
                    sanitized = last_ai.model_copy(update={"content": "收到，开始执行。"})
                    return {"messages": [sanitized]}
            except Exception:
                pass

        task_id = str(collab.bound_task_id or "").strip()
        if not task_id:
            return None
        try:
            storage = get_project_storage()
            row = find_main_task(storage, task_id)
            if row is None:
                return None
            _proj, task = row
            status = str(task.get("status") or "").strip().lower()
            subtasks = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
            has_failed_like = any(str(st.get("status") or "").strip().lower() in {"failed", "timed_out"} for st in subtasks)
            processing_count = sum(1 for st in subtasks if str(st.get("status") or "").strip().lower() in {"executing", "running", "in_progress", "waiting_dispatch"})
            main_terminal = status in {"completed", "failed", "cancelled"}
            sub_terminal = bool(subtasks) and all(str(st.get("status") or "").strip().lower() in {"completed", "failed", "cancelled", "timed_out"} for st in subtasks)
            # Only the **main** task terminal state ends collaboration here. All subtasks finishing
            # while the main task stays `in_progress` / etc. is for the lead orchestrator to validate,
            # update main status, or add follow-up work — do not auto-flip collab to done.
            if main_terminal:
                try:
                    cur = load_thread_collab_state(get_paths(), tid)
                    merged = merge_thread_collab_state(cur, {"collab_phase": CollabPhase.DONE.value})
                    save_thread_collab_state(get_paths(), tid, merged)
                except Exception:
                    pass
                return None
            # Failure convergence guard:
            # If there are failed/timed_out subtasks and nothing is actively processing,
            # do not keep forcing monitor tool calls every turn. Let the model conclude
            # or explicitly choose retry/reassign actions, avoiding repetitive replies.
            if has_failed_like and processing_count == 0:
                if _subtasks_have_recent_retry_activity(subtasks):
                    return None
                try:
                    if status == "in_progress":
                        task["status"] = "waiting_dispatch"
                        task["updated_at"] = utc_now_iso_z()
                        storage.save_project(_proj)
                except Exception:
                    pass
                return None

            # All subtasks finished but main is still open: stop hammering forced monitor; lead decides next.
            if processing_count == 0 and sub_terminal and not main_terminal:
                from langchain_core.messages import SystemMessage
                hint = SystemMessage(
                    name="collab_finalization_hint",
                    content=(
                        "<collab_finalization_hint>\n"
                        "所有子任务已完成，但主任务尚未关闭。请立即：\n"
                        "1. 按 Plan validation 项执行验收（read_file / terminal 只读检查）\n"
                        "2. 验收通过后调用 supervisor(update_progress, progress=100, status=completed) 关闭主任务\n"
                        "3. 验收不通过则用 continue_subtask_session / retry_subtask 修正后重新验收\n"
                        "</collab_finalization_hint>"
                    ),
                )
                return {"messages": [hint]}

            # No active processing means no reason to force monitor loops.
            if processing_count == 0 and not (main_terminal or sub_terminal):
                return None
        except Exception:
            return None

        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None

        raw_c = getattr(last, "content", None)
        preserved = ""
        if isinstance(raw_c, str) and raw_c.strip():
            preserved = raw_c.strip()
            if len(preserved) > 6000:
                preserved = preserved[:5997] + "..."
        final_content = preserved if preserved else (raw_c if isinstance(raw_c, str) else "") or ""

        extra_monitor = {
            "id": make_formatted_id("ForcedMonitor"),
            "name": "supervisor",
            "args": {
                "action": "monitor_execution_step",
                "task_id": task_id,
                "monitor_step_seconds": 2,
            },
        }

        existing_calls = list(getattr(last, "tool_calls", None) or [])
        # Throttle forced monitor cadence to avoid "one reply per model loop" spam.
        guard_key = _forced_monitor_guard_key(task_id, tid)
        try:
            gs_now = _FORCED_MONITOR_GUARD.get(guard_key) or {}
            now_ts = __import__("time").time()
            if (now_ts - float(gs_now.get("last_forced_ts") or 0.0)) < _FORCED_MONITOR_COOLDOWN_SECONDS:
                return None
            if int(gs_now.get("consecutive_forced") or 0) >= _FORCED_MONITOR_MAX_CONSECUTIVE:
                return None
        except Exception:
            pass
        if existing_calls:
            # 执行阶段强约束：只要本轮没有“针对当前主任务”的 monitor 调用，就追加一次 monitor。
            # 这样即便本轮只做了 start_execution/create_subtask/update_progress，也会继续有监控数据回流。
            if _tool_calls_include_monitor_for_bound_task(existing_calls, task_id):
                try:
                    gs_reset = _FORCED_MONITOR_GUARD.get(guard_key) or {}
                    gs_reset["consecutive_forced"] = 0
                    _FORCED_MONITOR_GUARD[guard_key] = gs_reset
                except Exception:
                    pass
                return None
            try:
                gs_upd = _FORCED_MONITOR_GUARD.get(guard_key) or {}
                gs_upd["last_forced_ts"] = __import__("time").time()
                gs_upd["consecutive_forced"] = int(gs_upd.get("consecutive_forced") or 0) + 1
                _FORCED_MONITOR_GUARD[guard_key] = gs_upd
            except Exception:
                pass
            forced = last.model_copy(
                update={
                    "content": final_content,
                    "tool_calls": existing_calls + [extra_monitor],
                }
            )
            return {"messages": [forced]}

        try:
            gs_upd = _FORCED_MONITOR_GUARD.get(guard_key) or {}
            gs_upd["last_forced_ts"] = __import__("time").time()
            gs_upd["consecutive_forced"] = int(gs_upd.get("consecutive_forced") or 0) + 1
            _FORCED_MONITOR_GUARD[guard_key] = gs_upd
        except Exception:
            pass
        forced = last.model_copy(
            update={
                "content": final_content,
                "tool_calls": [extra_monitor],
            }
        )
        return {"messages": [forced]}
