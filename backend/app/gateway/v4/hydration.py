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
- tool 结果：与 live ``agui_mirror`` 对齐，从正文尾部
  ``{evoflow-cua-display:...}``（或 payload.cua_display）重建
  ``output.display``（kind:"cua" + media），否则冷恢复后截图轮尾为空；
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


def _attachments_from_user_payload(payload: Any) -> list[dict[str, Any]]:
    """Project transcript ``contextFiles`` / ``image_url`` blocks → V4 AttachmentRef.

    Channel IM inbound stores durable local paths in ``contextFiles`` (same shape
    as desktop ``chatSend``). Desktop may also embed ``image_url`` content blocks.
    """
    import mimetypes
    from pathlib import Path

    if not isinstance(payload, dict):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _push(*, ref: str, file_name: str = "", mime: str = "", size: int = 0) -> None:
        path = str(ref or "").strip()
        if not path or path in seen:
            return
        seen.add(path)
        name = str(file_name or "").strip() or Path(path).name or "attachment"
        mt = str(mime or "").strip()
        if not mt:
            guessed, _ = mimetypes.guess_type(name)
            mt = (guessed or "").split(";", 1)[0].strip() or "application/octet-stream"
        bytes_n = int(size) if isinstance(size, (int, float)) and size > 0 else 0
        if bytes_n <= 0:
            try:
                bytes_n = max(0, int(Path(path).stat().st_size))
            except OSError:
                bytes_n = 0
        out.append({"ref": path, "fileName": name, "mime": mt, "bytes": bytes_n})

    for entry in payload.get("contextFiles") or payload.get("context_files") or []:
        if isinstance(entry, str) and entry.strip():
            _push(ref=entry.strip())
            continue
        if not isinstance(entry, dict):
            continue
        _push(
            ref=str(entry.get("path") or entry.get("ref") or "").strip(),
            file_name=str(entry.get("name") or entry.get("fileName") or entry.get("filename") or ""),
            mime=str(entry.get("mime") or ""),
            size=int(entry["size"]) if isinstance(entry.get("size"), (int, float)) else 0,
        )

    body = payload.get("content")
    blocks = body if isinstance(body, list) else []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if str(block.get("type") or "").strip() != "image_url":
            continue
        image = block.get("image_url")
        url = ""
        if isinstance(image, dict):
            url = str(image.get("url") or "").strip()
        elif isinstance(image, str):
            url = image.strip()
        # Only durable / serve-able local paths — skip data: URLs (too large for ref).
        if url and not url.lower().startswith("data:"):
            _push(ref=url, mime="image/jpeg")

    return out[:16]


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


def _build_hydrated_tool_output(
    *,
    tool_name: str,
    out_text: str,
    status: str,
    payload: dict[str, Any] | None = None,
    msg: dict[str, Any] | None = None,
    input_text: str = "",
    thread_id: str = "",
) -> dict[str, Any]:
    """Build ``output = {text, display?}`` for a hydrated tool row.

    Live 路径由 ``agui_mirror`` 把 CUA 标记剥成 ``output.display``；冷恢复必须
    用同一逻辑，否则刷新后轮尾截图/应用徽标消失（正文仍在，面板无图）。
    """
    from app.gateway.v4.agui_mirror import (
        _cua_display_block,
        _extract_diff_texts_from_args_dict,
        _media_image_cua_display,
        _platform_ui_display_block,
        _split_evoflow_cua_display,
        build_file_diff_display,
    )

    text = out_text or ""
    name_l = str(tool_name or "").strip().lower()
    output: dict[str, Any] = {"text": text}

    # platform 绑渠道：冷恢复也要出码（与 live agui_mirror 同形）。
    if name_l == "platform":
        wire_ui: dict[str, Any] | None = None
        for bag in (msg, payload):
            if not isinstance(bag, dict):
                continue
            raw_ui = bag.get("platform_ui")
            if isinstance(raw_ui, dict):
                wire_ui = raw_ui
                break
        platform_block = _platform_ui_display_block(wire_ui, text)
        if platform_block is not None:
            output["display"] = platform_block
            return output

    cua_display: dict[str, Any] | None = None
    for bag in (msg, payload):
        if not isinstance(bag, dict):
            continue
        raw = bag.get("cua_display")
        if isinstance(raw, dict):
            cua_display = raw
            break
    if cua_display is None:
        # node_repl / 任意仍带标记的历史正文（瘦身预览若保留尾部也能命中）。
        text, cua_display = _split_evoflow_cua_display(text)
        output["text"] = text

    if cua_display is not None:
        block = _cua_display_block(cua_display, text)
        if block is not None:
            output["display"] = block
            return output

    if status == "error":
        return output

    # 浏览器截图 JSON（image_url → browser-snapshots API）。
    if name_l in {
        "browser",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_screenshot",
        "browser_scroll",
        "browser_snapshot",
    }:
        try:
            blob = json.loads(text) if text.strip().startswith("{") else None
        except ValueError:
            blob = None
        if isinstance(blob, dict) and blob.get("type") == "browser_screenshot":
            image_url = str(blob.get("image_url") or "").strip()
            if image_url:
                output["display"] = {
                    "kind": "cua",
                    "schemaVersion": 1,
                    "toolName": tool_name,
                    "status": "success",
                    "media": [{"mimeType": "image/png", "artifactUri": image_url}],
                }
                return output

    if name_l in {"media_image_generate", "media_task_wait"}:
        media_block = _media_image_cua_display(thread_id, text, tool_name)
        if media_block is not None:
            output["display"] = media_block
            return output

    if name_l in _WRITE_TOOL_NAMES:
        try:
            args = json.loads(input_text or "{}")
        except ValueError:
            args = None
        if isinstance(args, dict):
            extracted = _extract_diff_texts_from_args_dict(args)
            if extracted is not None:
                diff = build_file_diff_display(*extracted)
                if diff is not None:
                    output["display"] = diff

    return output


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
    """display 仓优先；为空时按 thread 直读 transcript 原始行。

    协作节点 executor thread（``{lead}__sub__{sid}`` / ``SubThread_*``）必须只按
    ``thread_id`` 取行。``find_session_key_by_thread_id`` 在无专用会话时会回退到
    **lead 主会话**；若再 ``list_messages_for_display_all``，会把主对话整段 hydrate
    进节点面板（侧栏点节点「串台」）。
    """
    from evoflow.collab.thread_ids import is_collab_executor_thread
    from evoflow.persistence import chat_message_repositories as msg_repo
    from evoflow.persistence import session_repositories as sess_repo

    tid = str(thread_id or "").strip()
    if is_collab_executor_thread(tid):
        scoped = list(
            msg_repo.list_messages_for_thread_id(tid, limit=_HYDRATION_MAX_MESSAGES) or []
        )
        if scoped:
            return scoped
        archived = list(
            msg_repo.conversation_archive_from_thread_id(tid, limit=_HYDRATION_MAX_MESSAGES)
            or []
        )
        if archived:
            return archived
        return _load_raw_messages_by_thread(tid)

    sk = str(sess_repo.find_session_key_by_thread_id(tid) or "").strip()
    if sk and not sess_repo.is_session_deleted(sk):
        page = msg_repo.list_messages_for_display_all(sk, max_rows=_HYDRATION_MAX_MESSAGES)
        messages = list(page.get("messages") or [])
        if messages:
            return messages
    archived = list(
        msg_repo.conversation_archive_from_thread_id(tid, limit=_HYDRATION_MAX_MESSAGES) or []
    )
    if archived:
        return archived
    return _load_raw_messages_by_thread(tid)


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
    # Only skip when the session already carries *content*. A session that was
    # created by a bare subscribe (rows=0, seq=0) but whose transcript landed
    # afterwards must still be hydratable — otherwise the panel stays empty
    # forever. This is the common collab-subtask ordering: the right-stage pane
    # opens while the step is still running, subscribes an empty session, and
    # the worker's messages are persisted seconds later.
    if sess.rows:
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
        # subagent 工具（task_id ≡ tool_call_id）→ 从 args 解析出的元数据。
        # tool 结果到达时据此合成 kind:"subagent" 行（ZCode 契约：subagent 镜像
        # 事件进事件日志；冷恢复没有镜像事件，用 transcript 工具行重建）。
        subagent_meta_by_call_id: dict[str, dict[str, str]] = {}
        for msg in turn["messages"]:
            role = str(msg.get("role") or "")
            msg_id = str(msg.get("id") or msg.get("message_id") or "")
            payload = parse_content(msg)

            if role == "user":
                text = _text_from_message_content(payload)
                attachments = _attachments_from_user_payload(payload)
                if not text and not attachments:
                    continue
                # 工具审批内部标记不进可见 userInput（对齐旧面板 isHiddenToolApprovalUserMessage）
                from app.gateway.v4.agui_mirror import _is_hidden_tool_approval_user_text

                if text and _is_hidden_tool_approval_user_text(text) and not attachments:
                    continue
                row: dict[str, Any] = {
                    "rowId": next_row_id(),
                    "turnId": turn_id,
                    "kind": "userInput",
                    "text": text or "",
                    "origin": "realUser",
                    "createdAt": created_at,
                    "createdAtSeq": 0,
                    # ZCode 行内「编辑」入口：canEdit + entityId（message_id）同时成立才展示。
                    "actions": {"canEdit": True},
                }
                if attachments:
                    row["attachments"] = attachments
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
                        if str(tc.get("name") or "").strip().lower() == "subagent":
                            try:
                                args_obj = json.loads(args_text) if args_text else None
                            except ValueError:
                                args_obj = None
                            desc = ""
                            sa_type = ""
                            if isinstance(args_obj, dict):
                                desc = str(args_obj.get("description") or "").strip()
                                sa_type = str(args_obj.get("subagent_type") or "").strip()
                            subagent_meta_by_call_id[tcid] = {
                                "subagentType": sa_type or "general",
                                "summary": desc or "子任务",
                            }
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
                    target["output"] = _build_hydrated_tool_output(
                        tool_name=str(target.get("toolName") or "tool"),
                        out_text=out_text,
                        status=status,
                        payload=payload_d,
                        msg=msg,
                        input_text=str(target.get("inputText") or ""),
                        thread_id=tid,
                    )
                    if status == "error":
                        err_text = str((target["output"] or {}).get("text") or out_text)
                        target["error"] = {"code": "tool_error", "message": err_text[:2000]}
                    # subagent 工具行 → 合成 kind:"subagent" 镜像行（状态映射对齐
                    # live 镜像：completed→success，error→failed）。summaryText 优先
                    # 用任务描述，缺失时回退结果正文前 160 字。
                    meta = subagent_meta_by_call_id.pop(tcid, None)
                    if meta is not None:
                        fallback_summary = out_text.strip()[:160]
                        rows.append(
                            {
                                "rowId": next_row_id(),
                                "turnId": turn_id,
                                "kind": "subagent",
                                "parentToolCallId": tcid,
                                "subagentType": meta["subagentType"],
                                "status": "failed" if status == "error" else "success",
                                "summaryText": meta["summary"]
                                if meta["summary"] != "子任务"
                                else (fallback_summary or "子任务"),
                                "createdAt": created_at,
                                "createdAtSeq": 0,
                                "startedAt": created_at,
                                "endedAt": created_at,
                            }
                        )
                    continue
                # 孤儿 tool 行（call 不在本轮 assistant 里）：独立成行。
                tname = str(msg.get("tool_name") or msg.get("name") or "tool").strip() or "tool"
                orphan_output = _build_hydrated_tool_output(
                    tool_name=tname,
                    out_text=out_text,
                    status=status,
                    payload=payload_d,
                    msg=msg,
                    thread_id=tid,
                )
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
                    "output": orphan_output,
                }
                if status == "error":
                    err_text = str((orphan_output or {}).get("text") or out_text)
                    row["error"] = {"code": "tool_error", "message": err_text[:2000]}
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
            "entityId": turn_id,
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
