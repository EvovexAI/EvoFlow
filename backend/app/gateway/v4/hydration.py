"""V4 会话历史 hydration：首次订阅时把持久 transcript 建成 ZCode v4 行。

动机：v4 投影此前只有 live 镜像（agui_mirror）的数据——打开历史会话时面板为空。
订阅面的正确做法（对齐 ZCode「冷恢复走同一投影」）：hub 首次为某 thread 建
session 时，把旧链路的 transcript（``evoflow_chat_messages``，与
``GET /api/chat/sessions/by-thread/{thread_id}/messages`` 同源）映射成 v4 行
写入权威日志，之后的 live 镜像在其上继续 append。

载荷形状（LangGraph message payload，display dict 的 ``content_json``）：
- user: ``{"content": str | [{"text": …} | {"type":"text","text":…}]}``
- assistant: ``{"content": …, "reasoning": str, "tool_calls": [{id,name,args}]}``
  —— 工具参数就在 tool_calls 里，随行 hydrate（inputText = args JSON）；
- tool: ``{"content": str, "result": "success"|"error", "data": …}``
  （display 仓已瘦身，全文在 tool-result store，ToolCallList 展开时自取）。

映射规则（v1）：
- 按 ``run_id`` 分组 = turn（缺 run_id 的消息归入前一连续段）；每组先落
  turnHeader（历史轮一律 completedSuccess，无运行中的轮）；
- assistant.tool_calls 先建 toolCall 行（running），随后同 turn 的 tool 行按
  tool_call_id 回填 status/output；
- assistant.reasoning → reasoning 行；content 文本 → assistantText 行。

幂等：仅当 session 全新（rows 空且 seq==0）才 hydrate；live 镜像先到则跳过。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

_HYDRATION_MAX_MESSAGES = 2000

# 写类工具名（与 agui_mirror._WRITE_TOOL_NAMES 一致；历史行补 file_diff display 用）。
_WRITE_TOOL_NAMES = {
    "write", "write_file", "write_to_file", "edit", "edit_file",
    "replace", "str_replace", "replace_in_file", "multi_edit", "apply_patch",
}


def _text_from_message_content(content: Any) -> str:
    """message content 的文本提取：字符串 / 块数组（有无 type 均收）/ 嵌套 payload。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            text = block.get("text")
            if isinstance(text, str) and text and btype in (None, "text"):
                parts.append(text)
        return "\n".join(p for p in parts if p)
    if isinstance(content, dict):
        if isinstance(content.get("content"), (str, list)):
            return _text_from_message_content(content.get("content"))
        text = content.get("text")
        return str(text) if isinstance(text, str) else ""
    return ""


def _tool_status_from_payload(payload: Any) -> str:
    if isinstance(payload, dict):
        result = str(payload.get("result") or payload.get("status") or "success").strip().lower()
        if result in {"error", "failed", "failure"}:
            return "error"
    return "success"


def _tool_output_text_from_payload(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    if isinstance(payload.get("content"), str):
        return payload["content"]
    data = payload.get("data")
    if isinstance(data, str):
        return data
    if data is not None:
        try:
            return json.dumps(data, ensure_ascii=False)[:4000]
        except Exception:
            return ""
    return ""


def _load_raw_messages_by_thread(thread_id: str) -> list[dict[str, Any]]:
    """直接读 transcript 原始行（display 仓为空时的回退），输出与 display dict 同键形状。

    ``get_db()`` 返回自带锁的包装连接，调用方无需额外加锁。
    """
    from evoflow.persistence.db import get_db

    con = get_db()
    cursor = con.execute(
        """
        SELECT id, role, message_id, content_json, tool_call_id, tool_name,
               run_id, thread_id, created_at
        FROM evoflow_chat_messages
        WHERE thread_id = ?
        ORDER BY seq ASC
        LIMIT ?
        """,
        (thread_id, _HYDRATION_MAX_MESSAGES),
    )
    rows: list[dict[str, Any]] = []
    for row in cursor.fetchall():
        item = dict(row)
        if not item.get("id") and item.get("message_id"):
            item["id"] = item["message_id"]
        rows.append(item)
    return rows


def _load_messages(thread_id: str) -> list[dict[str, Any]]:
    """display 仓优先；为空时按 thread 直读 transcript 原始行。"""
    from evoflow.persistence import chat_message_repositories as msg_repo
    from evoflow.persistence import session_repositories as sess_repo

    sk = str(sess_repo.find_session_key_by_thread_id(thread_id) or "").strip()
    if sk and not sess_repo.is_session_deleted(sk):
        page = msg_repo.list_messages_for_display_all(sk, max_rows=_HYDRATION_MAX_MESSAGES)
        messages = list(page.get("messages") or [])
        if messages:
            return messages
    archived = list(
        msg_repo.conversation_archive_from_thread_id(thread_id, limit=_HYDRATION_MAX_MESSAGES) or []
    )
    if archived:
        return archived
    return _load_raw_messages_by_thread(thread_id)


def hydrate_session_from_transcript(hub: Any, thread_id: str) -> int:
    """把 thread 的持久 transcript hydrate 成 v4 行。返回写入的行数（0=跳过/无历史）。

    调用时机：hub ``subscribe`` 建会话后、构建首帧快照前；仅全新 session 生效。
    失败只记日志返回 0——hydration 缺席只影响历史显示，绝不阻断订阅。
    """
    tid = str(thread_id or "").strip()
    if not tid or tid.startswith("v4-"):
        return 0
    # 全新会话可能尚未在 hub 建 session（独立调用/subscribe 前置）；get_or_create。
    sess = hub._get_or_create_session(tid)  # noqa: SLF001 — 同包协作单例
    if sess.rows or sess.seq:
        return 0
    try:
        from evoflow.persistence import session_repositories as sess_repo

        sk = str(sess_repo.find_session_key_by_thread_id(tid) or "").strip()
        if sk and sess_repo.is_session_deleted(sk):
            return 0
        messages = _load_messages(tid)
    except Exception:
        logger.exception("[v4.hydration] transcript load failed thread=%s", tid)
        return 0
    if not messages:
        return 0

    now_ms = int(time.time() * 1000)

    def next_row_id() -> int:
        s = hub.get_session(tid)
        if s is None:
            s = hub._get_or_create_session(tid)  # noqa: SLF001 — 同包协作单例
        rid = int(s.next_row_id)
        s.next_row_id += 1
        return rid

    def parse_content(msg: dict[str, Any]) -> Any:
        content = msg.get("content_json")
        if isinstance(content, str):
            try:
                return json.loads(content)
            except Exception:
                return None
        return content

    # 1) 分组成轮：连续段按 run_id；缺 run_id 的消息归入前一段。
    turns: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for msg in messages:
        run = str(msg.get("run_id") or "").strip()
        if current is None or (run and run != current["run_id"]):
            current = {"run_id": run or f"turn-seq-{len(turns) + 1}", "messages": []}
            turns.append(current)
        current["messages"].append(msg)

    def _msg_timestamp_ms(msg: dict[str, Any]) -> int | None:
        """消息时间戳（ms）：display 路径 turn_started_at；raw 路径 created_at（ISO）。"""
        for key in ("turn_started_at", "created_at"):
            value = msg.get(key)
            if value is None:
                continue
            if isinstance(value, (int, float)) and value > 0:
                return int(value)
            if isinstance(value, str) and value.strip():
                try:
                    return int(value)
                except ValueError:
                    try:
                        from evoflow.persistence.timestamps import iso_z_to_ms

                        ms = iso_z_to_ms(value.strip())
                        return int(ms) if ms else None
                    except Exception:
                        return None
        return None

    # 2) 逐轮构建行（先本地成行、tool 结果回填 tool 行 + file_diff，再按序 author）。
    #    turnHeader 最后 author（携带真实起止 + fileChanges 聚合），rowId 先分配保排序。
    row_count = 0
    for turn in turns:
        turn_id = str(turn["run_id"])
        created_at = now_ms
        header_row_id = next_row_id()
        rows: list[dict[str, Any]] = []
        tool_row_by_call_id: dict[str, dict[str, Any]] = {}
        for msg in turn["messages"]:
            role = str(msg.get("role") or "")
            msg_id = str(msg.get("id") or msg.get("message_id") or "")
            payload = parse_content(msg)

            if role == "user":
                text = _text_from_message_content(payload)
                if not text:
                    continue
                row: dict[str, Any] = {
                    "rowId": next_row_id(),
                    "turnId": turn_id,
                    "kind": "userInput",
                    "text": text,
                    "origin": "realUser",
                    "createdAt": created_at,
                    "createdAtSeq": 0,
                }
                if msg_id:
                    row["entityId"] = msg_id
                rows.append(row)
            elif role == "assistant":
                reasoning = str((payload or {}).get("reasoning") or "") if isinstance(payload, dict) else ""
                if reasoning:
                    rows.append(
                        {
                            "rowId": next_row_id(),
                            "turnId": turn_id,
                            "kind": "reasoning",
                            "text": reasoning,
                            "state": "complete",
                            "createdAt": created_at,
                            "createdAtSeq": 0,
                        }
                    )
                for tc in (payload or {}).get("tool_calls") or []:
                    if not isinstance(tc, dict):
                        continue
                    tcid = str(tc.get("id") or "").strip()
                    args = tc.get("args")
                    try:
                        args_text = (
                            args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
                        )
                    except Exception:
                        args_text = "{}"
                    row = {
                        "rowId": next_row_id(),
                        "turnId": turn_id,
                        "kind": "toolCall",
                        "toolCallId": tcid or f"hist-{len(rows)}",
                        "toolName": str(tc.get("name") or "tool"),
                        "status": "running",
                        "inputText": args_text or "{}",
                        "createdAt": created_at,
                        "createdAtSeq": 0,
                        "startedAt": created_at,
                    }
                    rows.append(row)
                    if tcid:
                        tool_row_by_call_id[tcid] = row
                text = _text_from_message_content(payload.get("content") if isinstance(payload, dict) else None)
                if text:
                    row = {
                        "rowId": next_row_id(),
                        "turnId": turn_id,
                        "kind": "assistantText",
                        "text": text,
                        "state": "complete",
                        "createdAt": created_at,
                        "createdAtSeq": 0,
                    }
                    if msg_id:
                        row["entityId"] = msg_id
                    rows.append(row)
            elif role == "tool":
                tcid = str(msg.get("tool_call_id") or "").strip()
                target = tool_row_by_call_id.get(tcid)
                payload_d = payload if isinstance(payload, dict) else {}
                status = _tool_status_from_payload(payload_d)
                out_text = _tool_output_text_from_payload(payload_d)
                if target is not None:
                    target["status"] = status
                    target["endedAt"] = created_at
                    target["output"] = {"text": out_text}
                    if status == "error":
                        target["error"] = {"code": "tool_error", "message": out_text[:2000]}
                    # 历史写类工具同样补 file_diff display（ZCode 契约：diff 由服务端
                    # 算好放进 output.display，客户端点开渲染上下两段代码）。
                    if status != "error" and target["toolName"].lower() in _WRITE_TOOL_NAMES:
                        try:
                            args = json.loads(target.get("inputText") or "{}")
                        except ValueError:
                            args = None
                        if isinstance(args, dict):
                            from app.gateway.v4.agui_mirror import (
                                _extract_diff_texts_from_args_dict,
                                build_file_diff_display,
                            )

                            extracted = _extract_diff_texts_from_args_dict(args)
                            if extracted is not None:
                                diff = build_file_diff_display(*extracted)
                                if diff is not None:
                                    target["output"]["display"] = diff
                    continue
                # 孤儿 tool 行（call 不在本轮 assistant 里）：独立成行。
                tname = str(msg.get("tool_name") or msg.get("name") or "tool").strip() or "tool"
                row = {
                    "rowId": next_row_id(),
                    "turnId": turn_id,
                    "kind": "toolCall",
                    "toolCallId": tcid or f"hist-{len(rows)}",
                    "toolName": tname,
                    "status": status,
                    "inputText": "",
                    "createdAt": created_at,
                    "createdAtSeq": 0,
                    "startedAt": created_at,
                    "endedAt": created_at,
                    "output": {"text": out_text},
                }
                if status == "error":
                    row["error"] = {"code": "tool_error", "message": out_text[:2000]}
                rows.append(row)

        # 真实轮起止：display 路径用 turn_started_at/turn_duration_ms，raw 路径用
        # created_at（ISO）；都没有则退化为同一时刻（工时 0）。
        starts = [t for t in (_msg_timestamp_ms(m) for m in turn["messages"]) if t]
        turn_start = min(starts) if starts else created_at
        turn_end = max(starts) if starts else created_at
        for msg in turn["messages"]:
            started = _msg_timestamp_ms(msg)
            dur = msg.get("turn_duration_ms")
            if started and isinstance(dur, (int, float)) and dur > 0:
                turn_end = max(turn_end, int(started + dur))

        # 轮级文件变更聚合（ZCode「N 个文件已更改 +A/-D」卡片 = turnHeader.fileChanges）。
        file_agg: dict[str, dict[str, int]] = {}
        for row in rows:
            display = (row.get("output") or {}).get("display") or {}
            if row.get("kind") == "toolCall" and display.get("kind") == "file_diff":
                agg = file_agg.setdefault(str(display.get("filePath")), {"additions": 0, "deletions": 0})
                agg["additions"] += int(display.get("additions") or 0)
                agg["deletions"] += int(display.get("deletions") or 0)

        header_row: dict[str, Any] = {
            "rowId": header_row_id,
            "turnId": turn_id,
            "kind": "turnHeader",
            "origin": "userInput",
            "state": "completedSuccess",
            "startedAt": turn_start,
            "endedAt": turn_end,
            "createdAt": turn_start,
            "createdAtSeq": 0,
        }
        if file_agg:
            header_row["fileChanges"] = {
                "additions": sum(v["additions"] for v in file_agg.values()),
                "deletions": sum(v["deletions"] for v in file_agg.values()),
                "files": len(file_agg),
            }

        hub.author_append_row(tid, header_row)
        row_count += 1
        for row in rows:
            hub.author_append_row(tid, row)
            row_count += 1

    sess_final = hub.get_session(tid)
    logger.info(
        "[v4.hydration] thread=%s rows=%d messages=%d seq=%s",
        tid,
        row_count,
        len(messages),
        sess_final.seq if sess_final else -1,
    )
    return row_count


__all__ = ["hydrate_session_from_transcript"]
