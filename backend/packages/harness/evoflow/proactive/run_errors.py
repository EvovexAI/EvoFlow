"""Human-readable LangGraph / execution failure messages for proactive runs."""

from __future__ import annotations

from typing import Any


def extract_langgraph_run_error(run: dict[str, Any] | None) -> str:
    """Pull the best available error detail from a LangGraph run payload.

    Newer LangGraph API versions often leave ``error`` empty even when the
    worker logged a real exception (e.g. GraphRecursionError).
    """
    if not isinstance(run, dict):
        return ""
    candidates: list[Any] = [
        run.get("error"),
        run.get("exception"),
        run.get("status_message"),
        run.get("detail"),
        run.get("message"),
    ]
    kwargs = run.get("kwargs")
    if isinstance(kwargs, dict):
        candidates.extend(
            [
                kwargs.get("error"),
                kwargs.get("exception"),
                kwargs.get("message"),
            ]
        )
    meta = run.get("metadata")
    if isinstance(meta, dict):
        candidates.extend(
            [
                meta.get("error"),
                meta.get("exception"),
                meta.get("error_message"),
            ]
        )
    for c in candidates:
        s = str(c or "").strip()
        if s and s.lower() not in {"none", "null"}:
            return s[:2000]
    return ""


def format_langgraph_run_failure(status: str, run: dict[str, Any] | None = None) -> str:
    """Return a Chinese-first failure string for storage + UI."""
    st = str(status or "error").strip().lower() or "error"
    detail = extract_langgraph_run_error(run)
    low = detail.lower()

    if "recursion limit" in low or "graphrecursionerror" in low:
        return "执行失败：本轮工具步数用尽（引擎递归上限），任务中断。请打开「工作轨迹」看停在哪一步；可缩小范围后重试。" + (f"\n技术细节：{detail[:500]}" if detail else "")

    if "timed out" in low or "timeout" in low:
        return "执行失败：等待超时。请打开「工作轨迹」查看进度，或稍后重试。" + (f"\n技术细节：{detail[:500]}" if detail else "")

    if detail:
        return f"执行失败：{detail[:800]}"

    # Empty error field — common with LangGraph API; still give actionable copy.
    if st in {"cancelled", "canceled"}:
        return "执行失败：运行已被取消。请打开「工作轨迹」确认，或重新派发。"
    return "执行失败：引擎中断，但未返回具体原因。常见于步数用尽或运行崩溃；请打开「工作轨迹」查看最后几步，或稍后重试。"


def classify_run_exception(exc: BaseException) -> tuple[str, str]:
    """Split a LangGraph run exception into ``(machine_code, detail)``.

    The detail keeps the original exception message so a failure stays
    diagnosable after it leaves the log and lands on a Task result. Returning a
    bare code (``run_error``) tells nobody what actually broke.
    """
    msg = str(exc).strip()
    name = type(exc).__name__
    if name == "GraphRecursionError" or "Recursion limit" in msg or "GraphRecursionError" in msg:
        return "recursion_limit", msg
    status_code = getattr(getattr(exc, "response", None), "status_code", None)
    if status_code == 422:
        return "graph_build_error", msg
    if status_code is not None:
        return f"http_{status_code}", msg
    return "run_error", msg


def format_run_error_detail(code: str, detail: str = "", *, limit: int = 500) -> str:
    """Return ``"<code>: <detail>"`` so the root cause survives the error code."""
    text = " ".join(str(detail or "").split())
    if not text:
        return str(code or "run_error")
    return f"{code}: {text[:limit]}"


def humanize_execution_result(raw: str | None) -> str:
    """Normalize legacy English bridge strings into readable Chinese."""
    s = str(raw or "").strip()
    if not s:
        return ""
    low = s.lower()
    if "recursion limit" in low or "graphrecursionerror" in low:
        return format_langgraph_run_failure("error", {"error": s})
    if low.rstrip().endswith("langgraph run error:") or low.rstrip() == "execution failed: langgraph run error:":
        return format_langgraph_run_failure("error", {})
    if s.startswith("Execution failed:"):
        rest = s[len("Execution failed:") :].strip()
        if not rest or rest.lower().startswith("langgraph run error"):
            return format_langgraph_run_failure("error", {"error": rest})
        return f"执行失败：{rest}"
    if s.startswith("Execution error:"):
        return f"执行失败：{s[len('Execution error:') :].strip()}"
    if s.startswith("Execution timed out"):
        return "执行失败：等待超时。请打开「工作轨迹」或稍后重试。"
    return s
