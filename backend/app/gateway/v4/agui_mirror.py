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
    # AG-UI / sse_ui_normalize 发的是 pending_approval（带下划线）；
    # 去下划线后的 pendingapproval 一并收录，避免落成 success 导致面板不弹授权。
    "pending_approval": "pendingApproval",
    "pendingapproval": "pendingApproval",
    "running": "running",
    "success": "success",
    "ok": "success",
    "error": "error",
    "cancelled": "cancelled",
}


def _normalize_agui_tool_status(raw: object) -> str:
    """AG-UI tool status → ZCode v4 toolCall.status。"""
    key = str(raw or "success").strip().lower()
    if key in _AGUI_TO_TOOL_STATUS:
        return _AGUI_TO_TOOL_STATUS[key]
    compact = key.replace("-", "").replace("_", "")
    return _AGUI_TO_TOOL_STATUS.get(compact, "success")


# 对齐面板 tool-approval.js ``isHiddenToolApprovalUserMessage``：
# 批准/拒绝/续流内部标记不得落成可见 userInput 气泡。
_TOOL_APPROVAL_MARKER = "__evf_tool_approval_v1__:"
_TOOL_APPROVAL_REPLAY_MARKER = "__evf_tool_approval_replay_v1__:"


def _is_hidden_tool_approval_user_text(text: object) -> bool:
    s = str(text or "").strip()
    if not s:
        return False
    lower = s.lower()
    if lower.startswith(_TOOL_APPROVAL_MARKER):
        return True
    if lower.startswith(_TOOL_APPROVAL_REPLAY_MARKER):
        return True
    if s.startswith("用户工具授权操作："):
        return True
    return False

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

# 微信工具 → 简洁摘要（对齐旧链路 formatToolOutputForUserDisplay 的微信分支）。
_WECHAT_TOOL_NAMES = {"wechat_chat", "wechat_send", "send_wechat_message"}


def _wechat_summary(content: str) -> str | None:
    try:
        blob = json.loads(content) if content else None
    except ValueError:
        blob = None
    if not isinstance(blob, dict):
        return None
    contact = str(blob.get("contact") or "").strip()
    msg = str(blob.get("message") or "").strip()
    if blob.get("ok") is True and contact:
        brief = msg[:40] + "…" if len(msg) > 40 else msg
        return f"消息已发送给 {contact}：{brief}" if brief else f"消息已发送给 {contact}"
    if blob.get("ok") is not True and blob.get("error"):
        return f"微信发送失败：{str(blob.get('error')).strip()}"
    return None

# 媒体工具（图片产物）→ CUA display 内联图片。视频/音频无内联渲染位，暂缓。
_MEDIA_IMAGE_TOOL_NAMES = {"media_image_generate", "media_task_wait"}

# 浏览器工具（截图内联显示：结果 JSON 有 image_url 指向 browser-snapshots API）
_BROWSER_TOOL_NAMES = {
    "browser", "browser_navigate", "browser_click", "browser_type",
    "browser_screenshot", "browser_scroll", "browser_snapshot",
}


def _media_artifact_uri(thread_id: str, abs_path: str) -> str:
    """构造工作区文件的 inline 预览 URL（serve-file 支持绝对 path，root 由 thread 解析）。"""
    try:
        from urllib.parse import quote

        from app.gateway.routers.workspaces import _resolve_workspace_root

        root = _resolve_workspace_root(None, thread_id)
        return f"/api/workspaces/serve-file?root={quote(root)}&path={quote(abs_path)}"
    except Exception:
        return ""


def _media_image_cua_display(thread_id: str, content: str, tool_name: str) -> dict[str, Any] | None:
    """media_* 工具结果 → CUA display（media[].artifactUri 指向 serve-file）。

    ZCode 工具卡原生内联渲染 CUA media 截图/图片——media 工具对齐就落到这个结构。
    """
    try:
        blob = json.loads(content) if content else None
    except ValueError:
        blob = None
    if not isinstance(blob, dict) or blob.get("ok") is False:
        return None
    candidates = []
    for key in ("absolute_path", "local_path", "url"):
        value = str(blob.get(key) or "").strip()
        if value:
            candidates.append(value)
    for value in blob.get("urls") or []:
        if isinstance(value, str) and value.strip():
            candidates.append(value.strip())
    primary = next((c for c in candidates if c), "")
    if not primary or primary.lower().endswith((".mp4", ".webm", ".mov", ".mkv", ".m4v")):
        return None
    uri = _media_artifact_uri(thread_id, primary) or primary
    return {
        "kind": "cua",
        "schemaVersion": 1,
        "toolName": tool_name,
        "status": "success",
        "media": [{"mimeType": "image/png", "artifactUri": uri}],
    }


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


def _platform_ui_display_block(
    payload: dict[str, Any] | None,
    content: str,
) -> dict[str, Any] | None:
    """Build V4 ``output.display.kind:"platform_ui"`` for the product chat timeline.

    【产品默认 · V4】绑渠道二维码 + workflow.run 等进度 CTA（actions/autoOpen/openStage）。
    ConversationTurnGroup 读此 display 拉开右栏；旧 AG-UI publish-platform-* 是旁路。

    Prefers the AG-UI wire ``platform_ui`` sibling (same idea as ``cua_display``);
    falls back to parsing tool JSON ``ui`` / top-level ``qr_url``.
    """
    ui: dict[str, Any] | None = None
    if isinstance(payload, dict) and payload:
        ui = payload
    elif content.lstrip().startswith("{"):
        try:
            blob = json.loads(content)
        except (TypeError, ValueError):
            blob = None
        if isinstance(blob, dict) and blob.get("ok") is not False and not blob.get("pending_confirm"):
            nested = blob.get("ui")
            if isinstance(nested, dict) and nested:
                ui = nested
            elif str(blob.get("action") or "").strip() == "employees.bind_channel_begin":
                ui = {
                    "action": "employees.bind_channel_begin",
                    "title": "扫码绑定本岗 AI 员工",
                    "qrUrl": blob.get("qr_url") or blob.get("qrUrl"),
                    "sessionId": blob.get("session_id") or blob.get("sessionId"),
                    "channel": blob.get("channel") or "feishu",
                    "agentCode": blob.get("agent_code") or blob.get("agentCode"),
                    "entityLabel": blob.get("role_name") or blob.get("roleName"),
                    "bindStatus": "pending",
                }
    if not isinstance(ui, dict):
        return None
    qr = str(ui.get("qrUrl") or ui.get("qr_url") or "").strip()
    session_id = str(ui.get("sessionId") or ui.get("session_id") or "").strip()
    action = str(ui.get("action") or "").strip()
    # 进度侧栏 CTA（workflow.run autoOpen 等）：与绑渠道二维码并列，供 V4 时间线打开右栏
    progress_actions: list[dict[str, Any]] = []
    raw_actions = ui.get("actions")
    if isinstance(raw_actions, list):
        for row in raw_actions:
            if not isinstance(row, dict):
                continue
            label = str(row.get("label") or "").strip()
            open_stage = row.get("openStage") if isinstance(row.get("openStage"), dict) else None
            if not label or not open_stage:
                continue
            kind = str(open_stage.get("kind") or "").strip()
            if not kind:
                continue
            entry: dict[str, Any] = {
                "label": label[:64],
                "openStage": {
                    "kind": kind[:64],
                    "data": open_stage.get("data")
                    if isinstance(open_stage.get("data"), dict)
                    else {},
                },
            }
            if row.get("autoOpen") is True:
                entry["autoOpen"] = True
            route = str(row.get("route") or "").strip()
            if route:
                entry["route"] = route[:256]
            progress_actions.append(entry)
            if len(progress_actions) >= 4:
                break
    if not qr and not session_id and not progress_actions and action != "employees.bind_channel_begin":
        # 既无绑码也无进度 CTA → 不需要特殊 display
        return None
    if not qr and not session_id and not progress_actions:
        return None
    bind_raw = str(ui.get("bindStatus") or ui.get("bind_status") or "").strip().lower()
    bind_status = (
        bind_raw
        if bind_raw in {"pending", "scanning", "bound", "failed", "expired"}
        else ("pending" if (qr or session_id) else None)
    )
    block: dict[str, Any] = {
        "kind": "platform_ui",
        "schemaVersion": 1,
    }
    if action:
        block["action"] = action[:128]
    title = str(ui.get("title") or "").strip()
    if title:
        block["title"] = title[:512]
    if qr:
        block["qrUrl"] = qr[:4096]
    if session_id:
        block["sessionId"] = session_id[:256]
    channel = str(ui.get("channel") or "").strip().lower()
    if channel:
        block["channel"] = channel[:64]
    agent = str(ui.get("agentCode") or ui.get("agent_code") or ui.get("entityId") or "").strip()
    if agent:
        block["agentCode"] = agent[:128]
    label = str(ui.get("entityLabel") or ui.get("entity_label") or "").strip()
    if label:
        block["entityLabel"] = label[:256]
    if bind_status:
        block["bindStatus"] = bind_status
    if progress_actions:
        block["actions"] = progress_actions
    return block


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
    last_turn_id: str = ""
    """最近一个开过的 turnId（RUN_STARTED 时记录，轮尾不清）。task_* 事件晚到时
    subagent 行仍能挂回宿主轮，配对（parentToolCallId + turnId）不因轮已结算而断。"""
    subagent_rows: dict[str, int] = field(default_factory=dict)
    """task_id → subagent rowId（task_started 分配；终态 upsert 后保留，
    防乱序迟到帧重建出重复行）。跨轮保留——task 终态可能晚于 RUN_FINISHED。"""
    subagent_turn: dict[str, str] = field(default_factory=dict)
    """task_id → 分配行时的 turnId（跨轮终态 upsert 时保持与宿主 toolCall 行同轮）。"""
    subagent_meta: dict[str, dict[str, str]] = field(default_factory=dict)
    """task_id → {subagentType, description}（task_started 记账）。

    终态帧通常不带这些字段，而 v4 upsert 是整行替换——不记账会把 Agent 卡上的
    类型徽标清成 general、摘要清空。"""


def _running_control(
    *,
    now_ms: int,
    api_retry: dict[str, Any] | None = None,
    last_error: dict[str, Any] | None = None,
    can_stop: bool = True,
) -> dict[str, Any]:
    """Full control object (key-level replace). Always include apiRetry/lastError/stopTargetKind."""
    from app.gateway.v4.conversation import _minimal_control

    ctrl = _minimal_control("running")
    ctrl["canStop"] = bool(can_stop)
    ctrl["stopState"] = "stoppable" if can_stop else "idle"
    ctrl["activeWorks"] = [{"kind": "primaryTurn", "startedAt": now_ms}] if can_stop else []
    ctrl["apiRetry"] = api_retry
    ctrl["lastError"] = last_error
    return ctrl


def _activity_content(ev: dict[str, Any]) -> dict[str, Any]:
    raw = ev.get("content")
    return raw if isinstance(raw, dict) else {}


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

    def _patch_control(self, tid: str, control: dict[str, Any]) -> None:
        self._hub.author_state_patch(tid, {"control": control})

    def _clear_api_retry(self, tid: str, st: _MirrorState, *, now_ms: int) -> None:
        """Drop retry banner while keeping the turn running (e.g. model resumed)."""
        if not st.run_started:
            return
        self._patch_control(tid, _running_control(now_ms=now_ms, api_retry=None, last_error=None))

    def _upsert_error_assistant_text(self, tid: str, st: _MirrorState, text: str, *, now_ms: int) -> None:
        """Ensure vendor error is visible as assistantText when no body was streamed yet."""
        body = str(text or "").strip()
        if not body or not st.run_started:
            return
        # Prefer existing streaming text rows (model_error TEXT_MESSAGE path already filled them).
        if st.text_row_ids:
            return
        mid = f"model-error-{st.turn_id or now_ms}"
        rid = self._next_row_id(tid)
        st.text_row_ids[mid] = rid
        st.text_acc[mid] = body
        self._hub.author_append_row(
            tid,
            {
                "rowId": rid,
                "turnId": st.turn_id,
                "kind": "assistantText",
                "text": body,
                "state": "complete",
                "createdAt": now_ms,
                "createdAtSeq": self._seq_now(tid),
                "entityId": mid,
            },
        )

    def _on_activity_snapshot(self, tid: str, st: _MirrorState, ev: dict[str, Any], *, now_ms: int) -> None:
        """Project ACTIVITY_SNAPSHOT retrying/model_error into V4 control + optional text."""
        if not st.run_started:
            return
        content = _activity_content(ev)
        kind = str(content.get("kind") or "").strip()
        detail = str(content.get("detail") or "").strip()
        if kind == "retrying":
            try:
                attempt = int(content.get("attempt") or 1)
            except (TypeError, ValueError):
                attempt = 1
            try:
                max_attempts = int(content.get("max_attempts") or attempt)
            except (TypeError, ValueError):
                max_attempts = attempt
            try:
                wait_s = float(content.get("wait_s") or 0.0)
            except (TypeError, ValueError):
                wait_s = 0.0
            reason_code = str(content.get("reason") or "").strip() or "rate_limit"
            # reasonCode carries vendor detail so the dock/title can show the real error.
            # Schema is a string; keep it informative (truncate for wire size).
            display_reason = detail[:500] if detail else reason_code
            next_retry_at = now_ms + int(max(0.0, wait_s) * 1000)
            api_retry = {
                "attempt": max(1, attempt),
                # V4 schema: maxAttempts includes the first try; our middleware counts retries only.
                "maxAttempts": max(1, max_attempts) + 1,
                "nextRetryAt": next_retry_at,
                "reasonCode": display_reason,
            }
            self._patch_control(
                tid,
                _running_control(now_ms=st.turn_started_at_ms or now_ms, api_retry=api_retry),
            )
            return
        if kind == "model_error":
            last_error = {
                "code": str(content.get("reason") or "model_error").strip() or "model_error",
                "message": detail[:2000] if detail else "model_error",
                "recoverable": False,
                "at": now_ms,
                "source": "provider",
            }
            self._patch_control(
                tid,
                _running_control(
                    now_ms=st.turn_started_at_ms or now_ms,
                    api_retry=None,
                    last_error=last_error,
                    can_stop=True,
                ),
            )
            self._upsert_error_assistant_text(tid, st, detail, now_ms=now_ms)
            return

    # -- 入口 ---------------------------------------------------------------

    def note_user_input(self, thread_id: str, text: str) -> None:
        """POST 路径解析到用户文本后先记下（RUN_STARTED 时落 userInput 行）。"""
        tid = str(thread_id or "").strip()
        raw = str(text or "").strip()
        if not tid or not raw:
            return
        # 工具审批内部标记（批准/续流）在旧面板不展示；镜像也不落 userInput。
        if _is_hidden_tool_approval_user_text(raw):
            return
        st = self._state(tid)
        st.user_text = raw

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
            st.last_turn_id = new_turn_id
            st.turn_started_at_ms = now_ms
            st.turn_file_changes = {}
            rid = self._next_row_id(tid)
            st.turn_header_row_id = rid
            self._hub.author_append_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    # 面板「N 个文件已更改」展开依赖 ConversationRowTarget.entityId
                    "entityId": st.turn_id,
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
            if user_text and not _is_hidden_tool_approval_user_text(user_text):
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
            self._patch_control(tid, _running_control(now_ms=now_ms))
            return

        if et == "ACTIVITY_SNAPSHOT":
            self._on_activity_snapshot(tid, st, ev, now_ms=now_ms)
            return

        if et == "TEXT_MESSAGE_START":
            mid = str(ev.get("messageId") or "").strip()
            if not mid or mid in st.text_row_ids:
                return
            # Successful model output starting → clear retry banner.
            self._clear_api_retry(tid, st, now_ms=now_ms)
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
            content = str(ev.get("content") or "")
            v4_status = _normalize_agui_tool_status(ev.get("status") or "success")
            # 内容信封里的 _evoflow_tool.status 优先（有时 wire status 仍是 ok）
            if v4_status != "pendingApproval" and content.lstrip().startswith("{"):
                try:
                    envelope = json.loads(content)
                    meta = envelope.get("_evoflow_tool") if isinstance(envelope, dict) else None
                    if isinstance(meta, dict) and str(meta.get("status") or "").strip().lower() in {
                        "pending_approval",
                        "pendingapproval",
                    }:
                        v4_status = "pendingApproval"
                except (TypeError, ValueError):
                    pass
            tool_name = self._tool_name(st, tcid, ev)
            # CUA 展示：sse_ui_normalize / agui_stream_normalizer 已把
            # ``{evoflow-cua-display:...}`` 从 content 剥成 TOOL_CALL_RESULT.cua_display。
            # 只扫正文会永远 miss → V4 NodeRepl 卡无飞书图标、无截图画廊。
            cua_display: dict[str, Any] | None = None
            raw_cua = ev.get("cua_display")
            if isinstance(raw_cua, dict):
                cua_display = raw_cua
            elif "node_repl" in tool_name:
                content, cua_display = _split_evoflow_cua_display(content)
            # 协议形状（toolDisplay.ts toolOutputSchema）：output = {text, display?}，
            # 错误在 row 顶层 error 字段（status=error 时必带）——不能包 kind:"text"/"error"。
            tool_name_l = str(ev.get("toolName") or "").strip() or st.tool_names.get(tcid, "")
            if tool_name_l.lower() in _WECHAT_TOOL_NAMES:
                # 微信工具卡摘要对齐旧链路（简洁一句，而非原始 JSON）。
                wechat_brief = _wechat_summary(content)
                if wechat_brief:
                    content = wechat_brief
            tool_output: dict[str, Any] = {"text": content}
            # platform_ui（绑渠道二维码等）：与 cua_display 同级上浮，供 V4 PlatformToolCallBlock 出码。
            platform_ui_block: dict[str, Any] | None = None
            raw_platform_ui = ev.get("platform_ui")
            if isinstance(raw_platform_ui, dict) or tool_name_l.lower() == "platform":
                platform_ui_block = _platform_ui_display_block(
                    raw_platform_ui if isinstance(raw_platform_ui, dict) else None,
                    content,
                )
            if platform_ui_block is not None:
                tool_output["display"] = platform_ui_block
            elif cua_display is not None:
                block = _cua_display_block(cua_display, content)
                if block is not None:
                    tool_output["display"] = block
            elif tool_name_l.lower() in _BROWSER_TOOL_NAMES and v4_status == "success":
                # 浏览器截图：结果 JSON 有 image_url（同源 API 路径）→ CUA display
                # media 内联渲染。浏览器截图走 ZCode 工具卡的 CUA media 通道。
                try:
                    blob = json.loads(content) if content.strip().startswith("{") else None
                except ValueError:
                    blob = None
                if isinstance(blob, dict) and blob.get("type") == "browser_screenshot":
                    image_url = str(blob.get("image_url") or "").strip()
                    if image_url:
                        tool_output["display"] = {
                            "kind": "cua",
                            "schemaVersion": 1,
                            "toolName": tool_name_l,
                            "status": "success",
                            "media": [{"mimeType": "image/png", "artifactUri": image_url}],
                        }
            elif tool_name_l.lower() in _MEDIA_IMAGE_TOOL_NAMES and v4_status == "success":
                # 媒体工具产物图片 → CUA display 内联渲染（对齐 ZCode 工具卡图片能力）。
                media_block = _media_image_cua_display(tid, content, tool_name_l)
                if media_block is not None:
                    tool_output["display"] = media_block
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
                    "entityId": st.turn_id,
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
            from app.gateway.v4.conversation import _minimal_control

            ctrl = _minimal_control("completedSuccess" if et == "RUN_FINISHED" else "error")
            ctrl["sessionEnded"] = True
            ctrl["canStop"] = False
            ctrl["stopState"] = "idle"
            ctrl["activeWorks"] = []
            ctrl["lastError"] = last_error
            ctrl["apiRetry"] = None
            self._patch_control(tid, ctrl)
            # 关键：允许下一轮 RUN_STARTED 再开 running turnHeader。
            self._reset_turn_ephemeral(st)
            return

        if et == "CUSTOM":
            self._on_custom(tid, st, ev, now_ms=now_ms)
            return

        # 其余事件不投影——ACTIVITY_SNAPSHOT / CUSTOM 已在上方处理。

    # -- task_*（subagent）事件 → subagent 行 ---------------------------------
    #
    # ZCode 契约：subagent 镜像事件必须进事件日志——task_tool 的 task_started /
    # task_completed / task_failed / task_timed_out / task_cancelled（CUSTOM
    # name="custom" 捎带）在这里镜像成 kind:"subagent" 行。task_id ≡ tool_call_id
    # （task_tool.py execute_async(task_id=tool_call_id)），即 subagentRow 的
    # parentToolCallId；前端 pairSubagentRows 据此把行配进 Agent 工具卡。

    _TASK_TERMINAL_STATUS: dict[str, str] = {
        "task_completed": "success",
        "task_failed": "failed",
        "task_timed_out": "failed",
        "task_cancelled": "cancelled",
    }

    def _on_custom(self, tid: str, st: _MirrorState, ev: dict[str, Any], *, now_ms: int) -> None:
        name = str(ev.get("name") or "").strip()
        value = ev.get("value")
        if name != "custom" or not isinstance(value, dict):
            return
        chunk = value.get("chunk") if isinstance(value.get("chunk"), dict) else value
        chunk_type = str(chunk.get("type") or "").strip()
        if chunk_type == "task_started":
            self._on_task_started(tid, st, chunk, now_ms=now_ms)
        elif chunk_type in self._TASK_TERMINAL_STATUS:
            self._on_task_terminal(tid, st, chunk_type, chunk, now_ms=now_ms)
        # task_running：右栏实时输出由既有旁路（subagentTasks 注册表）承载，
        # 摘要行不随每条心跳重绘——保持 running 状态即可。

    def _on_task_started(self, tid: str, st: _MirrorState, chunk: dict[str, Any], *, now_ms: int) -> None:
        task_id = str(chunk.get("task_id") or "").strip()
        if not task_id:
            return
        rid = self._next_row_id(tid)
        turn_id = st.turn_id or st.last_turn_id
        subagent_type = str(chunk.get("subagent_type") or "").strip() or "general"
        summary = str(chunk.get("description") or "").strip() or "子任务运行中"
        st.subagent_rows[task_id] = rid
        st.subagent_turn[task_id] = turn_id
        st.subagent_meta[task_id] = {"subagentType": subagent_type, "description": summary[:512]}
        self._hub.author_append_row(
            tid,
            {
                "rowId": rid,
                "turnId": turn_id,
                "kind": "subagent",
                "parentToolCallId": task_id,
                "subagentType": subagent_type,
                "status": "running",
                "summaryText": summary[:512],
                "createdAt": now_ms,
                "createdAtSeq": self._seq_now(tid),
                "startedAt": now_ms,
            },
        )

    def _on_task_terminal(
        self,
        tid: str,
        st: _MirrorState,
        chunk_type: str,
        chunk: dict[str, Any],
        *,
        now_ms: int,
    ) -> None:
        task_id = str(chunk.get("task_id") or "").strip()
        if not task_id:
            return
        rid = st.subagent_rows.get(task_id)
        if rid is None:
            # task_started 漏收（进程重启/乱序丢帧）：终态直接落行，宁可状态跳变
            # 也不让 Agent 工具卡永远停在 running。
            rid = self._next_row_id(tid)
            turn_id = st.turn_id or st.last_turn_id
            st.subagent_rows[task_id] = rid
            st.subagent_turn[task_id] = turn_id
        else:
            turn_id = st.subagent_turn.get(task_id) or st.turn_id or st.last_turn_id
        status = self._TASK_TERMINAL_STATUS[chunk_type]
        if status == "success":
            summary = str(chunk.get("result") or "").strip()
        else:
            summary = str(chunk.get("error") or "").strip()
        self._hub.author_upsert_row(
            tid,
            {
                "rowId": rid,
                "turnId": turn_id,
                "kind": "subagent",
                "parentToolCallId": task_id,
                "subagentType": str(chunk.get("subagent_type") or "").strip() or "general",
                "status": status,
                "summaryText": (summary[:512] if summary else ""),
                "createdAt": now_ms,
                "createdAtSeq": self._seq_now(tid),
                "endedAt": now_ms,
            },
        )


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
    "_cua_display_block",
    "_platform_ui_display_block",
    "_media_image_cua_display",
    "build_file_diff_display",
]
