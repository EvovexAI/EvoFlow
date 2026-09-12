"""Prompt blocks for peer wake rounds."""

from __future__ import annotations

from typing import Any

from evoflow.collab.peer.thread_key import LEAD_PARTY, parse_thread_key
from evoflow.collab.storage import find_subtask_by_ids
from evoflow.persistence import peer_repositories as peer_repo


def _party_display(storage: Any, main_task_id: str, party: str) -> str:
    if party == LEAD_PARTY:
        return "Lead"
    st = find_subtask_by_ids(storage, main_task_id, party)
    if not st:
        return party
    name = str(st.get("name") or "").strip()
    ref = str(st.get("ref") or "").strip()
    if name and ref:
        return f"{name} (ref={ref})"
    return name or party


def format_peer_thread_block(
    storage: Any,
    main_task_id: str,
    thread_key: str,
    *,
    limit: int = 20,
) -> str:
    messages = peer_repo.list_peer_messages(main_task_id, thread_key=thread_key, limit=limit)
    if not messages:
        return "(no messages in this thread yet)"
    lines: list[str] = []
    from_party, _to = parse_thread_key(thread_key)
    from_label = _party_display(storage, main_task_id, from_party)
    for msg in messages:
        direction = str(msg.get("direction") or "question")
        body = str(msg.get("body") or "").strip()
        if not body:
            continue
        if direction == "reply":
            lines.append(f"- You (reply): {body[:2000]}")
        else:
            lines.append(f"- {from_label}: {body[:2000]}")
    return "\n".join(lines) if lines else "(empty thread)"


def format_peer_wake_prompt_block(
    storage: Any,
    main_task_id: str,
    *,
    thread_key: str,
    mode: str,
) -> str:
    from_party, _to = parse_thread_key(thread_key)
    from_label = _party_display(storage, main_task_id, from_party)
    thread_body = format_peer_thread_block(storage, main_task_id, thread_key)
    if mode == "consultation":
        mode_block = (
            "**咨询模式**：你本 subtask 已正式完成。仅根据既有 `task_report`、工作区与问题作答；\n"
            "**不要**修改代码、不要再次调用 `subtask_outcome_report`、不要发起 `collab_peer_send`。\n"
            "若对方需要实质性改动，在回复中说明需 Lead 对责任 subtask 执行 `retry_subtask`。"
        )
    else:
        mode_block = (
            "**协作模式**：对方也在执行中。请用 `collab_peer_reply` 回答；可继续本 subtask 工作。\n"
            "不要替对方 subtask 调用 `subtask_outcome_report`。"
        )
    return (
        "## 私线协作（本轮触发）\n\n"
        f"线程 `{thread_key}`，来自 **{from_label}**。\n"
        f"{mode_block}\n\n"
        "### 本线程消息（仅此私线）\n"
        f"{thread_body}"
    )
