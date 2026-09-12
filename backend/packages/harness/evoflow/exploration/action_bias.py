"""Task-type action hints: move from exploration loops to the correct deliverable."""

from __future__ import annotations

from evoflow.exploration.task_router import (
    TASK_DATA_BUG,
    TASK_GENERAL,
    TASK_IMPLEMENT,
    TASK_LOCATE_FILE,
    TASK_RUNTIME,
    TASK_UNDERSTAND_CODE,
    classify_task_type_heuristic,
)

# Minimum distinct reads before nudging "explore → act" (per task class).
_READ_THRESHOLDS: dict[str, int] = {
    TASK_IMPLEMENT: 2,
    TASK_DATA_BUG: 2,
    TASK_UNDERSTAND_CODE: 2,
    TASK_LOCATE_FILE: 1,
    TASK_RUNTIME: 1,
    TASK_GENERAL: 3,
}

# Task types where open exploration_gaps often cause read loops after enough context.
_SUPPRESS_GAPS_TYPES = frozenset(
    {TASK_IMPLEMENT, TASK_UNDERSTAND_CODE, TASK_LOCATE_FILE},
)


def looks_like_edit_task(text: str) -> bool:
    return classify_task_type_heuristic(str(text or "")) in {TASK_IMPLEMENT, TASK_DATA_BUG}


def resolve_task_type(
    thread_id: str = "",
    *,
    task_type: str = "",
    user_text: str = "",
) -> str:
    tt = str(task_type or "").strip().lower()
    if tt:
        return tt
    tid = str(thread_id or "").strip()
    if tid:
        try:
            from evoflow.agents.mission_state.storage import load_mission_state

            ms = load_mission_state(tid)
            if ms and str(ms.task_type or "").strip():
                return str(ms.task_type).strip().lower()
        except Exception:
            pass
    if user_text.strip():
        return classify_task_type_heuristic(user_text)
    return TASK_GENERAL


def _read_count(thread_id: str) -> int:
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    try:
        from evoflow.context.working_memory import turn_read_count

        return turn_read_count(tid)
    except Exception:
        return 0


def read_threshold_for_task(task_type: str) -> int:
    return _READ_THRESHOLDS.get(str(task_type or "").strip().lower(), 2)


def is_ready_to_act(
    thread_id: str,
    *,
    task_type: str = "",
    user_text: str = "",
    read_count: int | None = None,
) -> bool:
    tt = resolve_task_type(thread_id, task_type=task_type, user_text=user_text)
    count = read_count if read_count is not None else _read_count(thread_id)
    return count >= read_threshold_for_task(tt)


def should_suppress_exploration_gaps(
    thread_id: str,
    *,
    task_type: str = "",
    user_text: str = "",
    read_count: int | None = None,
) -> bool:
    tt = resolve_task_type(thread_id, task_type=task_type, user_text=user_text)
    if tt not in _SUPPRESS_GAPS_TYPES:
        return False
    return is_ready_to_act(
        thread_id,
        task_type=tt,
        user_text=user_text,
        read_count=read_count,
    )


def _hint_body(task_type: str, read_count: int) -> str:
    tt = str(task_type or "").strip().lower()
    if tt == TASK_IMPLEMENT:
        return (
            "Phase: **explore → act (edit) → verify**.\n"
            f"Context is sufficient ({read_count} paths in <files_already_read>).\n"
            "- Do NOT add another research/status report or read/rg/search pass.\n"
            "- If fixing a bug with multiple possible causes, **probe first** (temp logs, targeted reads) to confirm root cause before editing.\n"
            "- **Next act**: worker(tasks=[{{'action':'edit|replace', 'path':'...', 'instruction':'...'}}]) "
            "or one-shot replace/write when the patch is obvious.\n"
            "- Then verify (read_lints / quick check) and reply briefly."
        )
    if tt == TASK_DATA_BUG:
        return (
            "Phase: **explore → verify data source → act (single-layer fix) → verify**.\n"
            f"You already inspected {read_count} path(s)—avoid another codebase tour.\n"
            "- **Next act**: compare **API/DB/log output vs UI** (terminal curl or targeted log read).\n"
            "- When multiple causes are plausible, **probe to eliminate** (add temp logs, read the critical function, curl the endpoint) before fixing — do NOT act on the first plausible hypothesis.\n"
            "- Only after one verified fork (data vs presentation), apply a **single-layer** fix via worker/replace.\n"
            "- Close with root cause + evidence—not another layout/file inventory summary."
        )
    if tt == TASK_UNDERSTAND_CODE:
        return (
            "Phase: **explore → explain** (no code change unless the user asked for one).\n"
            f"Enough context ({read_count} reads)—stop broad read/rg/search.\n"
            "- **Next act**: answer in prose with references to symbols/paths already seen.\n"
            "- Do NOT worker-edit or deliver a「当前代码结构总结」instead of answering the question."
        )
    if tt == TASK_RUNTIME:
        return (
            "Phase: **explore → diagnose → act (runtime) → verify**.\n"
            "- **Next act**: logs, health checks, process/port status—not search_code_index or file paging.\n"
            "- Apply one fix (config/restart/command) then confirm recovery."
        )
    if tt == TASK_LOCATE_FILE:
        return (
            "Phase: **locate → answer**.\n"
            f"Paths are likely identified ({read_count} read(s)).\n"
            "- **Next act**: tell the user the path(s) and stop repeating find/search."
        )
    return (
        "Phase: **explore → synthesize → (clarify if needed)**.\n"
        f"Gathered {read_count} reads—avoid endless exploration.\n"
        "- **Next act**: concise answer or ask_clarification with concrete options.\n"
        "- Do not substitute a long「现状总结」for resolving the user's ask."
    )


def format_action_hint(
    thread_id: str,
    *,
    task_type: str = "",
    user_text: str = "",
    read_count: int | None = None,
) -> str:
    """Inject when exploration is likely sufficient for this task type."""
    tt = resolve_task_type(thread_id, task_type=task_type, user_text=user_text)
    count = read_count if read_count is not None else _read_count(thread_id)
    if count < read_threshold_for_task(tt):
        return ""
    body = _hint_body(tt, count)
    return f"<action_bias>\n{body}\n</action_bias>"


def format_implement_action_hint(
    thread_id: str,
    *,
    task_type: str = "",
    user_text: str = "",
    read_count: int | None = None,
) -> str:
    """Backward-compatible alias."""
    return format_action_hint(
        thread_id,
        task_type=task_type,
        user_text=user_text,
        read_count=read_count,
    )


def format_read_followup_action_hint(
    thread_id: str,
    *,
    path: str = "",
    task_type: str = "",
    user_text: str = "",
) -> str:
    """Short suffix after read results when explore→act threshold is met."""
    tt = resolve_task_type(thread_id, task_type=task_type, user_text=user_text)
    count = _read_count(thread_id)
    if count < read_threshold_for_task(tt):
        return ""
    p = str(path or "").strip()
    path_line = f" Last read: {p}." if p else ""
    next_acts = {
        TASK_IMPLEMENT: "worker edit/replace",
        TASK_DATA_BUG: "curl/compare data source, then one-layer fix",
        TASK_UNDERSTAND_CODE: "answer in prose (no edit)",
        TASK_RUNTIME: "logs/health/process",
        TASK_LOCATE_FILE: "reply with paths",
    }
    act = next_acts.get(tt, "synthesize or clarify")
    return (
        f"\n\n<read_next_step> Ready to act ({tt}, {count} reads).{path_line} "
        f"Next: {act} — avoid broad re-exploration; targeted reads for verification are fine.</read_next_step>"
    )
