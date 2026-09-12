"""Write L2 episodic memory when tasks / goals complete."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.memory.document_codec import namespace_for_agent_key
from evoflow.memory.facade import remember
from evoflow.memory.namespaces import agent_ns, workspace_ns

logger = logging.getLogger(__name__)


def _clip(text: str, n: int = 600) -> str:
    t = " ".join(str(text or "").strip().split())
    if len(t) <= n:
        return t
    return t[: n - 1].rstrip() + "…"


def record_task_episode(
    task: dict[str, Any] | None,
    *,
    agent_name: str | None = None,
    workspace_key: str | None = None,
    outcome: str = "completed",
    extra_summary: str = "",
) -> str | None:
    """Persist a short episodic atom for a finished main task."""
    if not isinstance(task, dict):
        return None
    task_id = str(task.get("id") or "").strip()
    if not task_id:
        return None
    title = str(task.get("title") or task.get("name") or task_id).strip()
    result = (
        str(task.get("result") or "").strip()
        or str(task.get("summary") or "").strip()
        or str(task.get("result_text") or "").strip()
        or str(extra_summary or "").strip()
    )
    goal = str(task.get("goal") or task.get("description") or "").strip()
    parts = [
        f"任务「{title}」已{('完成' if outcome == 'completed' else outcome)}",
    ]
    if goal:
        parts.append(f"目标：{_clip(goal, 200)}")
    if result:
        parts.append(f"结论：{_clip(result, 320)}")
    content = "；".join(parts)
    evidence = {
        "task_id": task_id,
        "outcome": outcome,
        "thread_id": str(task.get("thread_id") or task.get("session_id") or ""),
        "project_id": str(task.get("project_id") or ""),
    }
    namespaces = [namespace_for_agent_key(agent_name)]
    ws = (workspace_key or "").strip()
    if ws:
        try:
            namespaces.append(workspace_ns(ws if ws.startswith("ws-") else f"ws-{ws}"))
        except Exception:
            pass

    last_id: str | None = None
    for ns in namespaces:
        try:
            last_id = remember(
                ns,
                content,
                layer="episodic",
                kind="episode",
                summary=_clip(title, 80),
                importance=0.82 if outcome == "completed" else 0.65,
                confidence=0.88,
                subject_key=f"task.episode:{task_id}",
                source="task_complete",
                evidence=evidence,
                tags=["task", outcome],
            )
        except Exception:
            logger.debug("record_task_episode failed ns=%s", ns, exc_info=True)
    return last_id


def record_goal_episode(
    *,
    session_key: str,
    goal_text: str,
    summary: str,
    agent_name: str | None = None,
    outcome: str = "completed",
) -> str | None:
    """Persist episodic atom for a finished Goal run."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    g = _clip(goal_text, 200)
    s = _clip(summary, 360)
    content = f"Goal「{g or '未命名'}」已完成"
    if s:
        content = f"{content}；结论：{s}"
    ns = namespace_for_agent_key(agent_name) if agent_name else agent_ns(None)
    try:
        return remember(
            ns,
            content,
            layer="episodic",
            kind="episode",
            summary=_clip(g or "goal", 80),
            importance=0.8,
            confidence=0.85,
            subject_key=f"goal.episode:{sk}",
            source="goal_complete",
            evidence={"session_key": sk, "outcome": outcome},
            tags=["goal", outcome],
        )
    except Exception:
        logger.debug("record_goal_episode failed", exc_info=True)
        return None
