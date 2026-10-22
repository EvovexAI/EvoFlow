"""生产链路 AG-UI → V4 镜像：把主聊天流（LangGraph → AG-UI wire）翻译成
ZCode v4 协议 delta，写入 ``V4ConversationHub``。

替代 H3-B 时代的 ``agui_to_v4_projector.py``（那个走旧 demo writer、payload kind
与 ZCode schema 不符、每个 content delta 全行 upsert）。本模块：

- **流式 delta 用协议正道**：文本/推理走 ``row.delta(path:"text")``、工具参数走
  ``row.delta(path:"inputText")``——coalesce 在 flush 窗内合并，不再有 O(N²) 全行重发；
- **结构变化才 upsert**：状态迁移（complete/running/tool result）用 ``row.upserted``；
- **补齐 userInput 行**：POST 路径解析到的用户文本经 ``note_user_input`` 进镜像，
  RUN_STARTED 时随 turnHeader 一起落行（对齐 ZCode 的 turnHeader+userInput 结构）；
- **CUA display 块**：node_repl 结果尾部的 ``{evoflow-cua-display:...}`` 标记剥出为
  ``output.display``（kind:"cua"），面板 ToolCallBlock 渲染 ZCode 同款卡片。

开关：``EVOFLOW_V4_MIRROR``（默认开；置 0/false/off 关闭回退旧链路观测）。
会话映射：v4 session id = LangGraph thread_id（1:1，客户端按
``conversation/{threadId}`` 订阅）。
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_MIRROR_DISABLED = os.getenv("EVOFLOW_V4_MIRROR", "1").strip().lower() in {"0", "false", "off", "no"}

_AGUI_TO_TOOL_STATUS: dict[str, str] = {
    "inputstreaming": "inputStreaming",
    "pendingapproval": "pendingApproval",
    "running": "running",
    "success": "success",
    "error": "error",
    "cancelled": "cancelled",
}

# node_repl js 工具结果尾部的展示标记（见 plugins/node_repl_tool.py）。
_CUA_DISPLAY_MARKER_PREFIX = "{evoflow-cua-display:"
# ZCode appKey scheme → 面板 ApplicationIconLocator kind。
_CUA_APP_KEY_LOCATOR_KINDS = {
    "darwin": "darwin-bundle-id",
    "windows-aumid": "windows-aumid",
    "windows-exe": "windows-executable-path",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


# 写类工具名（小写匹配）——与客户端 file-write 语义一致，用于生成 file_diff display。
_WRITE_TOOL_NAMES = {
    "write", "write_file", "write_to_file", "edit", "edit_file",
    "replace", "str_replace", "replace_in_file", "multi_edit", "apply_patch",
}

_DIFF_MAX_LINES = 800


def build_file_diff_display(path: str, old_text: str, new_text: str) -> dict[str, Any] | None:
    """按 ZCode file_diff display 契约（toolDisplay.ts）构造结构化 diff。

    lines 为 unified 风格（" 上下文"/"-旧"/"+新"）；这里给纯 -/+ 块（无上下文行），
    EditInlineDiffContent 渲染为上下两段代码。行数超限截断并标 truncated。
    """
    old_lines = old_text.splitlines() if old_text else []
    new_lines = new_text.splitlines() if new_text else []
    if not old_lines and not new_lines:
        return None
    lines = [f"-{ln}" for ln in old_lines] + [f"+{ln}" for ln in new_lines]
    truncated = len(lines) > _DIFF_MAX_LINES
    if truncated:
        lines = lines[:_DIFF_MAX_LINES]
    display: dict[str, Any] = {
        "kind": "file_diff",
        "filePath": path or "(unknown file)",
        "additions": len(new_lines),
        "deletions": len(old_lines),
        "structuredPatch": [
            {
                "oldStart": 1,
                "oldLines": len(old_lines),
                "newStart": 1,
                "newLines": len(new_lines),
                "lines": lines,
            }
        ],
    }
    if truncated:
        display["truncated"] = True
    return display


def _extract_diff_texts_from_args_dict(args: dict[str, Any]) -> tuple[str, str, str] | None:
    """从 args dict 提取 (path, old_text, new_text)：Edit 类 old_string/new_string，
    Write 类 content/text。无可用文本返回 None。"""
    path = ""
    for key in ("path", "file_path", "target_file", "filepath", "filePath"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            path = value
            break
    old_text = ""
    for key in ("old_string", "old_str", "old_text"):
        value = args.get(key)
        if isinstance(value, str):
            old_text = value
            break
    new_text = ""
    for key in ("new_string", "new_str", "content", "contents", "text"):
        value = args.get(key)
        if isinstance(value, str):
            new_text = value
            break
    if not path and not old_text and not new_text:
        return None
    return path, old_text, new_text


def _extract_diff_texts_from_args(args_text: str) -> tuple[str, str, str] | None:
    """从（应已完整的）args JSON 提取 (path, old_text, new_text)。

    解析失败返回 None（调用方跳过 diff，正文 output 不受影响）。
    """
    try:
        # strict=False：容忍模型流式参数里偶发的字符串内控制字符。
        args = json.loads(args_text, strict=False) if args_text else None
    except ValueError:
        args = None
    if not isinstance(args, dict):
        return None
    return _extract_diff_texts_from_args_dict(args)


def _split_evoflow_cua_display(content: str) -> tuple[str, dict[str, Any] | None]:
    """Strip the trailing ``{evoflow-cua-display:...}`` marker line from a js result."""
    for line in reversed(content.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        if not stripped.startswith(_CUA_DISPLAY_MARKER_PREFIX):
            return content, None
        payload_text = stripped[len(_CUA_DISPLAY_MARKER_PREFIX) : -1]
        try:
            payload = json.loads(payload_text)
        except ValueError:
            return content, None
        if not isinstance(payload, dict):
            return content, None
        cleaned = "\n".join(
            l for l in content.splitlines() if l.strip() != stripped
        ).rstrip()
        return cleaned, payload
    return content, None


def _cua_display_block(payload: dict[str, Any], body_text: str) -> dict[str, Any] | None:
    """Build a panel-compatible ``kind:"cua"`` tool result display block."""
    status = "failed" if payload.get("status") == "failed" else "success"
    block: dict[str, Any] = {
        "kind": "cua",
        "schemaVersion": 1,
        "toolName": "computer_use",
        "status": status,
    }
    text = (body_text or "").strip()
    if text:
        block["text"] = text[:32_000]
    media: list[dict[str, str]] = []
    for image in (payload.get("images") or [])[:4]:
        if not isinstance(image, dict):
            continue
        url = str(image.get("url") or "").strip()
        if not url:
            continue
        media.append({"mimeType": "image/png", "artifactUri": url})
    if media:
        block["media"] = media
    target = payload.get("target_app")
    if isinstance(target, dict):
        app_key = str(target.get("app_key") or "").strip()
        display_name = str(target.get("display_name") or "").strip()
        locators: list[dict[str, str]] = []
        if app_key:
            scheme, _, value = app_key.partition(":")
            kind = _CUA_APP_KEY_LOCATOR_KINDS.get(scheme.strip().lower())
            value = value.strip()
            if kind and value:
                locators.append(
                    {
                        "kind": kind,
                        # windows-executable-path 允许 32K，其余 512。
                        "value": value[:32_768] if kind == "windows-executable-path" else value[:512],
                    }
                )
        if display_name or locators:
            target_app: dict[str, Any] = {
                "schemaVersion": 1,
                "iconLocators": locators,
            }
            if display_name:
                target_app["displayName"] = display_name[:512]
            block["targetApp"] = target_app
    return block


@dataclass
class _MirrorState:
    """Per-thread translator state（AG-UI 稳定 id → v4 rowId + 文本累计）。"""

    turn_id: str = ""
    turn_header_row_id: int = 0
    run_started: bool = False
    text_row_ids: dict[str, int] = field(default_factory=dict)
    text_acc: dict[str, str] = field(default_factory=dict)
    reasoning_row_ids: dict[str, int] = field(default_factory=dict)
    reasoning_acc: dict[str, str] = field(default_factory=dict)
    tool_row_ids: dict[str, int] = field(default_factory=dict)
    tool_acc: dict[str, str] = field(default_factory=dict)
    tool_names: dict[str, str] = field(default_factory=dict)
    """toolCallId → 工具名（TOOL_CALL_START 记录；RESULT 事件可能不带名字）。"""
    turn_started_at_ms: int = 0
    """本轮真实开始时间（RUN_STARTED 时记录；FINISHED 时还原给 turnHeader 算真实工时）。"""
    turn_file_changes: dict[str, dict[str, int]] = field(default_factory=dict)
    """本轮文件变更聚合 path → {additions, deletions}（写类工具 RESULT 时累计，
    RUN_FINISHED 时写入 turnHeader.fileChanges——ZCode 轮尾「N 个文件已更改」卡片）。"""
    user_text: str = ""


class V4Mirror:
    """进程内单例：thread_id → 镜像状态，AG-UI 事件流 → hub authoring。"""

    def __init__(self, hub: Any) -> None:
        self._hub = hub
        self._states: dict[str, _MirrorState] = {}

    def _state(self, thread_id: str) -> _MirrorState:
        st = self._states.get(thread_id)
        if st is None:
            st = _MirrorState()
            self._states[thread_id] = st
        return st

    # -- 入口 ---------------------------------------------------------------

    def note_user_input(self, thread_id: str, text: str) -> None:
        """POST 路径解析到用户文本后先记下（RUN_STARTED 时落 userInput 行）。"""
        tid = str(thread_id or "").strip()
        if not tid or not str(text or "").strip():
            return
        st = self._state(tid)
        st.user_text = str(text)

    def feed_wire(self, thread_id: str, frames: list[bytes] | list[str]) -> int:
        """解析 AG-UI SSE wire 帧 → feed_events。返回消费的事件数。"""
        if _MIRROR_DISABLED or not frames:
            return 0
        from app.gateway.agui_stream_encode import decode_agui_payload

        events: list[dict[str, Any]] = []
        for frame in frames:
            raw = frame if isinstance(frame, bytes) else str(frame).encode("utf-8", errors="ignore")
            parsed = decode_agui_payload(raw)
            if isinstance(parsed, dict):
                events.append(parsed)
        if events:
            self.feed_events(thread_id, events)
        return len(events)

    def feed_events(self, thread_id: str, events: list[dict[str, Any]]) -> None:
        tid = str(thread_id or "").strip()
        if not tid or not events:
            return
        st = self._state(tid)
        for ev in events:
            try:
                self._feed_one(tid, st, ev)
            except Exception:
                # 镜像失败绝不打断生产流式链路；错误带事件类型便于对齐日志排查。
                logger.exception(
                    "[v4-mirror] feed failed thread=%s type=%s", tid, ev.get("type")
                )

    # -- 事件翻译 ---------------------------------------------------------------

    def _next_row_id(self, tid: str) -> int:
        sess = self._hub.get_session(tid)
        if sess is None:
            sess = self._hub._get_or_create_session(tid)  # noqa: SLF001 — 同包内协作单例
        rid = sess.next_row_id
        sess.next_row_id += 1
        return rid

    def _seq_now(self, tid: str) -> int:
        sess = self._hub.get_session(tid)
        return int(sess.seq) if sess is not None else 0

    def _reset_turn_ephemeral(self, st: _MirrorState) -> None:
        """清掉本轮翻译缓存，保留 ``user_text``（下一轮 note_user_input 可能已写入）。

        必须在 RUN_FINISHED / RUN_ERROR 后调用，否则下一轮 RUN_STARTED 会被
        ``run_started`` 闩锁吞掉——历史 turnHeader 会一直停在 completedSuccess，
        新正文/工具却仍挂在旧 turnId 下，ZCode 按历史轮渲染 → 无流式、与上文糊成一团。
        """
        st.run_started = False
        st.turn_header_row_id = 0
        st.turn_id = ""
        st.turn_started_at_ms = 0
        st.text_row_ids.clear()
        st.text_acc.clear()
        st.reasoning_row_ids.clear()
        st.reasoning_acc.clear()
        st.tool_row_ids.clear()
        st.tool_acc.clear()
        st.tool_names.clear()
        st.turn_file_changes.clear()

    def _tool_name(self, st: _MirrorState, tcid: str, ev: dict[str, Any]) -> str:
        """优先用 START 记下的真实工具名；事件字段常在 END/RESULT 缺失。"""
        return (
            st.tool_names.get(tcid)
            or str(ev.get("toolCallName") or "").strip()
            or str(ev.get("toolName") or "").strip()
            or "tool"
        )

    def _feed_one(self, tid: str, st: _MirrorState, ev: dict[str, Any]) -> None:
        et = str(ev.get("type") or "").strip()
        now_ms = _now_ms()

        if et == "RUN_STARTED":
            new_turn_id = (
                str(ev.get("runId") or ev.get("threadId") or "").strip() or f"run-{now_ms}"
            )
            if st.run_started:
                # 同 runId 重复 START：去重。不同 runId：上一轮 FINISHED 漏清闩锁，强制开新轮。
                if new_turn_id == st.turn_id:
                    return
                logger.warning(
                    "[v4-mirror] RUN_STARTED while prior turn open; reset thread=%s prev=%s next=%s",
                    tid,
                    st.turn_id,
                    new_turn_id,
                )
                self._reset_turn_ephemeral(st)
            st.run_started = True
            st.turn_id = new_turn_id
            st.turn_started_at_ms = now_ms
            st.turn_file_changes = {}
            rid = self._next_row_id(tid)
            st.turn_header_row_id = rid
            self._hub.author_append_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "turnHeader",
                    "origin": "userInput",
                    "state": "running",
                    "startedAt": now_ms,
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                },
            )
            user_text = st.user_text
            st.user_text = ""
            if user_text:
                self._hub.author_append_row(
                    tid,
                    {
                        "rowId": self._next_row_id(tid),
                        "turnId": st.turn_id,
                        "kind": "userInput",
                        "text": user_text,
                        "origin": "realUser",
                        "createdAt": now_ms,
                        "createdAtSeq": self._seq_now(tid),
                    },
                )
            self._hub.author_state_patch(
                tid,
                {
                    "control": {
                        "phase": "running",
                        "sessionEnded": False,
                        "canStop": True,
                        "stopState": "stoppable",
                        "activeWorks": [{"kind": "primaryTurn", "startedAt": now_ms}],
                        "lastError": None,
                    }
                },
            )
            return

        if et == "TEXT_MESSAGE_START":
            mid = str(ev.get("messageId") or "").strip()
            if not mid or mid in st.text_row_ids:
                return
            rid = self._next_row_id(tid)
            st.text_row_ids[mid] = rid
            st.text_acc[mid] = ""
            self._hub.author_append_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "assistantText",
                    "state": "streaming",
                    "text": "",
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    "assistantResponseId": mid,
                },
            )
            return

        if et == "TEXT_MESSAGE_CONTENT":
            mid = str(ev.get("messageId") or "").strip()
            delta = str(ev.get("delta") or "")
            rid = st.text_row_ids.get(mid)
            if rid is None or not delta:
                return
            st.text_acc[mid] = st.text_acc.get(mid, "") + delta
            self._hub.author_row_delta(tid, rid, "text", delta)
            return

        if et == "TEXT_MESSAGE_END":
            mid = str(ev.get("messageId") or "").strip()
            rid = st.text_row_ids.get(mid)
            if rid is None:
                return
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "assistantText",
                    "state": "complete",
                    "text": st.text_acc.get(mid, ""),
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    "assistantResponseId": mid,
                },
            )
            return

        if et == "REASONING_MESSAGE_START":
            mid = str(ev.get("messageId") or "").strip()
            if not mid or mid in st.reasoning_row_ids:
                return
            rid = self._next_row_id(tid)
            st.reasoning_row_ids[mid] = rid
            st.reasoning_acc[mid] = ""
            self._hub.author_append_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "reasoning",
                    "state": "streaming",
                    "text": "",
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    "assistantResponseId": mid,
                },
            )
            return

        if et == "REASONING_MESSAGE_CONTENT":
            mid = str(ev.get("messageId") or "").strip()
            delta = str(ev.get("delta") or "")
            rid = st.reasoning_row_ids.get(mid)
            if rid is None or not delta:
                return
            st.reasoning_acc[mid] = st.reasoning_acc.get(mid, "") + delta
            self._hub.author_row_delta(tid, rid, "text", delta)
            return

        if et == "REASONING_MESSAGE_END":
            mid = str(ev.get("messageId") or "").strip()
            rid = st.reasoning_row_ids.get(mid)
            if rid is None:
                return
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "reasoning",
                    "state": "complete",
                    "text": st.reasoning_acc.get(mid, ""),
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    "assistantResponseId": mid,
                },
            )
            return

        if et == "TOOL_CALL_START":
            tcid = str(ev.get("toolCallId") or "").strip()
            name = str(ev.get("toolCallName") or ev.get("name") or "tool").strip() or "tool"
            if not tcid or tcid in st.tool_row_ids:
                return
            rid = self._next_row_id(tid)
            st.tool_row_ids[tcid] = rid
            st.tool_acc[tcid] = ""
            st.tool_names[tcid] = name
            self._hub.author_append_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "toolCall",
                    "toolCallId": tcid,
                    "toolName": name,
                    "status": "inputStreaming",
                    "inputText": "",
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    "startedAt": now_ms,
                },
            )
            return

        if et == "TOOL_CALL_ARGS":
            tcid = str(ev.get("toolCallId") or "").strip()
            delta = str(ev.get("delta") or "")
            rid = st.tool_row_ids.get(tcid)
            if rid is None or not delta:
                return
            st.tool_acc[tcid] = st.tool_acc.get(tcid, "") + delta
            self._hub.author_row_delta(tid, rid, "inputText", delta)
            return

        if et == "TOOL_CALL_END":
            tcid = str(ev.get("toolCallId") or "").strip()
            rid = st.tool_row_ids.get(tcid)
            if rid is None:
                return
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "toolCall",
                    "toolCallId": tcid,
                    "toolName": self._tool_name(st, tcid, ev),
                    "status": "running",
                    "inputText": st.tool_acc.get(tcid, ""),
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    "startedAt": now_ms,
                },
            )
            return

        if et == "TOOL_CALL_RESULT":
            tcid = str(ev.get("toolCallId") or "").strip()
            rid = st.tool_row_ids.get(tcid)
            if rid is None:
                return
            agui_status = str(ev.get("status") or "success").strip().lower()
            v4_status = _AGUI_TO_TOOL_STATUS.get(agui_status, "success")
            content = str(ev.get("content") or "")
            tool_name = self._tool_name(st, tcid, ev)
            cua_display = None
            if "node_repl" in tool_name:
                content, cua_display = _split_evoflow_cua_display(content)
            # 协议形状（toolDisplay.ts toolOutputSchema）：output = {text, display?}，
            # 错误在 row 顶层 error 字段（status=error 时必带）——不能包 kind:"text"/"error"。
            tool_output: dict[str, Any] = {"text": content}
            if cua_display is not None:
                block = _cua_display_block(cua_display, content)
                if block is not None:
                    tool_output["display"] = block
            else:
                if tool_name.lower() in _WRITE_TOOL_NAMES:
                    # ZCode 契约：Edit/Write 的可点击 diff 由 CLI 算好放进 output.display
                    # （kind:"file_diff" + structuredPatch），客户端 EditInlineDiffContent
                    # 渲染上下两段代码。args 在 TOOL_CALL_RESULT 时已完整，从镜像累计的
                    # inputText 解析 old/new；解析失败跳过（不影响正文）。
                    args_text = st.tool_acc.get(tcid, "")
                    extracted = _extract_diff_texts_from_args(args_text)
                    if extracted is not None:
                        diff_path, old_text, new_text = extracted
                        diff = build_file_diff_display(diff_path, old_text, new_text)
                        if diff is not None:
                            tool_output["display"] = diff
                            # 轮级文件变更聚合（RUN_FINISHED 时写 turnHeader.fileChanges，
                            # ZCode 轮尾「N 个文件已更改 +A/-D」卡片的数据源）。
                            agg = st.turn_file_changes.setdefault(
                                diff["filePath"], {"additions": 0, "deletions": 0}
                            )
                            agg["additions"] += int(diff["additions"])
                            agg["deletions"] += int(diff["deletions"])
            result_row: dict[str, Any] = {
                "rowId": rid,
                "turnId": st.turn_id,
                "kind": "toolCall",
                "toolCallId": tcid,
                "toolName": tool_name,
                "status": v4_status,
                "inputText": st.tool_acc.get(tcid, ""),
                "createdAt": now_ms,
                "createdAtSeq": self._seq_now(tid),
                "startedAt": now_ms,
                "endedAt": now_ms,
                "output": tool_output,
            }
            if v4_status == "error":
                result_row["error"] = {"code": "tool_error", "message": content[:2000]}
            self._hub.author_upsert_row(tid, result_row)
            return

        if et in ("RUN_FINISHED", "RUN_ERROR"):
            if not st.run_started or st.turn_header_row_id == 0:
                return
            v4_state = "completedSuccess" if et == "RUN_FINISHED" else "failed"
            # 轮尾文件变更摘要（ZCode「N 个文件已更改 +A/-D」卡片 = turnHeader.fileChanges）。
            file_changes: dict[str, Any] | None = None
            if st.turn_file_changes:
                file_changes = {
                    "additions": sum(v["additions"] for v in st.turn_file_changes.values()),
                    "deletions": sum(v["deletions"] for v in st.turn_file_changes.values()),
                    "files": len(st.turn_file_changes),
                }
            turn_finished_at = now_ms
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": st.turn_header_row_id,
                    "turnId": st.turn_id,
                    "kind": "turnHeader",
                    "origin": "userInput",
                    "state": v4_state,
                    "startedAt": st.turn_started_at_ms or now_ms,
                    "endedAt": turn_finished_at,
                    "createdAt": st.turn_started_at_ms or now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    **({"fileChanges": file_changes} if file_changes else {}),
                },
            )
            last_error = (
                {
                    "code": "run_error",
                    "message": str(ev.get("message") or ""),
                    "recoverable": False,
                    "at": now_ms,
                    "source": "runtime",
                }
                if et == "RUN_ERROR"
                else None
            )
            self._hub.author_state_patch(
                tid,
                {
                    "control": {
                        "phase": "completedSuccess" if et == "RUN_FINISHED" else "error",
                        "sessionEnded": True,
                        "canStop": False,
                        "stopState": "idle",
                        "activeWorks": [],
                        "lastError": last_error,
                    }
                },
            )
            # 关键：允许下一轮 RUN_STARTED 再开 running turnHeader。
            self._reset_turn_ephemeral(st)
            return

        # 其余事件（CUSTOM/ACTIVITY_*/...）v1 不投影——协议面只收对话事实。


def _get_mirror() -> V4Mirror:
    global _MIRROR
    if _MIRROR is None:
        from app.gateway.v4.conversation import HUB

        _MIRROR = V4Mirror(HUB)
    return _MIRROR


_MIRROR: V4Mirror | None = None


def mirror_note_user_input(thread_id: str, text: str) -> None:
    """生产路径入口：记录本轮用户输入文本。"""
    if _MIRROR_DISABLED:
        return
    try:
        _get_mirror().note_user_input(thread_id, text)
    except Exception:
        logger.exception("[v4-mirror] note_user_input failed thread=%s", thread_id)


def mirror_feed_agui_wire(thread_id: str, frames: list[bytes] | list[str]) -> int:
    """生产路径入口：AG-UI wire 帧批量喂镜像。失败只记日志，绝不抛出。"""
    if _MIRROR_DISABLED or not frames:
        return 0
    try:
        return _get_mirror().feed_wire(thread_id, frames)
    except Exception:
        logger.exception("[v4-mirror] feed_wire failed thread=%s", thread_id)
        return 0


__all__ = [
    "V4Mirror",
    "mirror_note_user_input",
    "mirror_feed_agui_wire",
    "_split_evoflow_cua_display",
]
