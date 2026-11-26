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
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_MIRROR_DISABLED = os.getenv("EVOFLOW_V4_MIRROR", "1").strip().lower() in {"0", "false", "off", "no"}

# ── 镜像链路独立诊断日志 ────────────────────────────────────────────────
# 根 logger 的文件 handler 会被 langgraph mount 时的 logging 重配置干掉
# （2026-11-21 实测：gateway-*.log 在启动 20s 后停写，镜像里所有 logger.exception
# 全部不可见）。这里给镜像链路挂一个自带 FileHandler 的专用 logger
# （propagate=False），诊断信息落 ``{logs}/v4-mirror-diag-YYYYMMDD.log``，
# 不受 root 重配置影响。排除故障后可整体摘除。
_diag = logging.getLogger("evoflow.v4.mirror.diag")
_diag.propagate = False
_diag.setLevel(logging.INFO)
_diag_file_ready = False


def _diag_log(event: str, **fields: Any) -> None:
    global _diag_file_ready
    try:
        if not _diag_file_ready:
            from evoflow.runtime.log_policy import resolve_product_logs_dir

            log_dir = Path(resolve_product_logs_dir())
            log_dir.mkdir(parents=True, exist_ok=True)
            handler = logging.FileHandler(
                log_dir / f"v4-mirror-diag-{time.strftime('%Y%m%d')}.log",
                encoding="utf-8",
            )
            handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
            _diag.addHandler(handler)
            _diag_file_ready = True
        _diag.info(
            json.dumps({"event": event, **fields}, ensure_ascii=False, default=str)
        )
    except Exception:
        pass

# 空流 / 过早 RUN_FINISHED / 历史仅 user 轮：与 hydration 共用文案，避免 live 与 remint 口径分裂。
EMPTY_RUN_NOTICE_TEXT = (
    "本轮未产出可见回复（空流或过早收尾）。"
    "若随后仍有模型输出，会继续挂在本轮；也可再发一条重试。"
)

# 直播过早 FINISHED 后常有迟到 TEXT：立刻落占位会先闪「未产出」再被真回复顶掉。
# 延后写入；期内来了正文/工具则取消。单测可 monkeypatch 为 0 变同步。
_EMPTY_RUN_DEFER_SEC = float(os.getenv("EVOFLOW_V4_EMPTY_RUN_DEFER_SEC", "2.5") or "2.5")

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


def _is_hidden_duty_brief_user_text(text: object) -> bool:
    """Proactive duty full brief must not become a visible userInput bubble.

    The human-facing opener is the separate ``proactive_duty_beat`` transcript row
    (dispatch/patrol one-liner, or「开始执行 · …」). Noting the long brief here
    caused a second / wrong opener in the employee process pane after live
    mirror + hydrate.
    """
    head = str(text or "").lstrip()[:240]
    if not head:
        return False
    if head.startswith("# 值班"):
        return True
    if "## 本轮行动" in head and ("对照职责" in head or "不要空建单" in head):
        return True
    if "<proactive_duty_brief" in head:
        return True
    return False


def _is_hidden_task_notification_user_text(text: object) -> bool:
    """Background task wakeups are provider-context only — not chat bubbles.

    Aligns with panel ``isTaskNotificationUserText`` / projection policy
    ``task_notification`` → providerContextOnly. Live + cold hydrate must both
    skip, or refresh resurfaces raw ``<task-notification>`` XML in the timeline.
    """
    head = str(text or "").lstrip()
    if not head:
        return False
    return head.startswith("<task-notification>") or head.startswith(
        "<subagent-notification>"
    )


def _is_hidden_context_compaction_user_text(text: object) -> bool:
    """Compaction / tool-history injects must not become visible userInput."""
    head = str(text or "").lstrip()
    if not head:
        return False
    lower = head.lower()
    if lower.startswith("[context compaction"):
        return True
    if lower.startswith("here is a summary of the conversation to date"):
        return True
    if lower.startswith("here's a summary of the conversation to date"):
        return True
    return head.startswith(
        (
            "[上下文摘要",
            "[深度压缩摘要",
            "[tool:history]",
            "[tool:summary]",
        )
    )


def _is_hidden_task_notification_message_id(message_id: object) -> bool:
    mid = str(message_id or "").strip()
    if not mid:
        return False
    return mid.startswith("bash-task-notification:") or mid.startswith(
        "subagent-task-notification:"
    )

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

# toolCall 行 output.text 预览上限（字符）：对齐旧链路 chat-normalize._UI_TOOL_OUTPUT_MAX。
# 巨型工具结果（视频生成 base64 等）不进投影行——快照字节预算收缩与 renderer OOM 的根因；
# 全文走 /tool-results 按需拉取（hydration 同阈值）。
_TOOL_OUTPUT_ROW_PREVIEW_MAX = 12_000


def _preview_tool_output_text(content: str) -> str:
    text = str(content or "")
    if len(text) <= _TOOL_OUTPUT_ROW_PREVIEW_MAX:
        return text
    return (
        text[:_TOOL_OUTPUT_ROW_PREVIEW_MAX]
        + "\n…（已截断，完整内容点开工具卡查看）"
    )


def _tool_content_is_pending_approval(content: object) -> bool:
    """True when tool body is the approval-gate envelope (not a real result)."""
    raw = str(content or "").strip()
    if not raw:
        return False
    if "[pending_approval]" in raw:
        return True
    if not raw.startswith("{"):
        return False
    try:
        blob = json.loads(raw)
    except (TypeError, ValueError):
        return False
    if not isinstance(blob, dict):
        return False
    meta = blob.get("_evoflow_tool")
    if not isinstance(meta, dict):
        return False
    st = str(meta.get("status") or "").strip().lower().replace("-", "").replace("_", "")
    return st == "pendingapproval"


def _transcript_tool_result_text(
    thread_id: str, tool_call_id: str
) -> tuple[str, str] | None:
    """从 ``evoflow_chat_messages`` 取已落库的 tool 正文。

    TranscriptMiddleware 在工具返回前就会 await 落库；AG-UI ``TOOL_CALL_RESULT``
    却可能晚于 ``RUN_FINISHED`` 或在 SSE 层被丢掉。seal 时回填，避免 V4 卡永久
    ``cancelled`` / ``inputStreaming``、展开无结果。

    查找顺序：
    1) 直接按 ``tool_call_id``（不依赖 session 绑定——proactive 会话 thread 偶发解不出）
    2) 回退 ``thread_id → session_key → get_tool_result_for_display``
    """
    tid = str(thread_id or "").strip()
    tcid = str(tool_call_id or "").strip()
    if not tcid:
        return None
    try:
        from evoflow.persistence.chat_message_content import loads_payload, tool_body_text
        from evoflow.persistence.db import get_db

        row = (
            get_db()
            .execute(
                """
                SELECT tool_name, content_json, thread_id
                FROM evoflow_chat_messages
                WHERE role = 'tool' AND tool_call_id = ?
                ORDER BY seq DESC
                LIMIT 1
                """,
                (tcid,),
            )
            .fetchone()
        )
        if row is not None:
            # 有 thread 时优先同 thread，避免跨会话撞 id（极少见）。
            if tid:
                row_tid = str(row[2] or "").strip()
                if row_tid and row_tid != tid:
                    row2 = (
                        get_db()
                        .execute(
                            """
                            SELECT tool_name, content_json, thread_id
                            FROM evoflow_chat_messages
                            WHERE role = 'tool' AND tool_call_id = ? AND thread_id = ?
                            ORDER BY seq DESC
                            LIMIT 1
                            """,
                            (tcid, tid),
                        )
                        .fetchone()
                    )
                    if row2 is not None:
                        row = row2
                    else:
                        # 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
                        # 跨 thread 的 tool_call_id 相同只是巧合，绝不能当命中原样采用。
                        # 原逻辑在「同 thread 无行」时保留了跨 thread 行 → 别的会话的
                        # 工具名/正文被写进本轮工具卡。现网实测：库里 13 条 tc* 探针残留，
                        # 其中 tc1 属 thread=probe-thread-perf / tool_name=assets；
                        # 本轮 END 回填把 write 卡改名成 assets（展开面板因此错成另一个
                        # 工具），test_tool_name_preserved_on_result_without_name 直接红。
                        # 判据：工具名决定卡面展开成哪个面板，错名 = 用户点开是错的工具。
                        # 宁可留空等 RESULT 真事件，不许跨会话串数据。
                        row = None
            body = (
                tool_body_text(loads_payload(str(row[1] or "")))
                if row is not None
                else ""
            )
            if str(body or "").strip():
                name = str(row[0] or "").strip() or "tool"
                return name, str(body)
    except Exception:
        logger.debug(
            "[v4-mirror] direct transcript lookup failed tcid=%s",
            tcid,
            exc_info=True,
        )

    if not tid:
        return None
    try:
        from evoflow.persistence.chat_message_repositories import get_tool_result_for_display
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        sk = find_session_key_by_thread_id(tid)
        if not sk:
            return None
        payload = get_tool_result_for_display(sk, tcid)
    except Exception:
        logger.debug(
            "[v4-mirror] transcript tool lookup failed thread=%s tcid=%s",
            tid,
            tcid,
            exc_info=True,
        )
        return None
    if not isinstance(payload, dict):
        return None
    body = str(payload.get("content") or "")
    if not body.strip():
        return None
    name = str(payload.get("toolName") or "").strip() or "tool"
    return name, body


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
        # 【self-evolution-bot · 2026-11-19 · 第74轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：生成器变量 l → line（ruff E741 ambiguous variable name）。
        # 为什么：小写 l 与数字 1 视觉难分，是这批改动新引入的唯一一条阻断门禁项。
        cleaned = "\n".join(
            line for line in content.splitlines() if line.strip() != stripped
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
    content_ui: dict[str, Any] | None = None
    content_blob: dict[str, Any] | None = None
    if content.lstrip().startswith("{"):
        try:
            parsed = json.loads(content)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict) and parsed.get("ok") is not False:
            content_blob = parsed
            # pending_confirm 仍抬顶层 title 作卡头；嵌套 ui（右栏 toast）仅成功态吃
            if not parsed.get("pending_confirm"):
                nested = parsed.get("ui")
                if isinstance(nested, dict) and nested:
                    content_ui = nested

    if isinstance(payload, dict) and payload:
        ui = dict(payload)
        # wire 上的 platform_ui 偶发只有 title/二维码，缺 actions：用正文 ui 补 CTA
        if content_ui:
            if not isinstance(ui.get("actions"), list) or not ui.get("actions"):
                if isinstance(content_ui.get("actions"), list) and content_ui.get("actions"):
                    ui["actions"] = content_ui["actions"]
            for key in ("action", "domain", "entityId", "entityLabel", "title", "agentCode"):
                if not str(ui.get(key) or "").strip() and str(content_ui.get(key) or "").strip():
                    ui[key] = content_ui[key]
    elif content_ui is not None:
        ui = content_ui
    elif content_blob is not None:
        blob = content_blob
        if str(blob.get("action") or "").strip() == "employees.bind_channel_begin":
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
        else:
            # media.* 结果：无 ui 时仍可从 absolute_path / preview 抽出预览区
            action_name = str(blob.get("action") or "").strip()
            preview = blob.get("preview") if isinstance(blob.get("preview"), dict) else {}
            abs_path = str(
                preview.get("src")
                or blob.get("absolute_path")
                or blob.get("local_path")
                or blob.get("url")
                or ""
            ).strip()
            if action_name.startswith("media.") and abs_path:
                kind = str(preview.get("kind") or blob.get("media_kind") or "image").strip().lower()
                if kind not in {"image", "video"}:
                    kind = "video" if abs_path.lower().endswith((".mp4", ".webm", ".mov", ".mkv", ".m4v")) else "image"
                ui = {
                    "action": action_name,
                    "title": str(blob.get("message") or blob.get("title") or "媒体已生成").strip()
                    or "媒体已生成",
                    "media": [
                        {
                            "kind": kind,
                            "mimeType": str(preview.get("mimeType") or ("video/mp4" if kind == "video" else "image/png")),
                            "artifactUri": abs_path,
                            "absolutePath": str(blob.get("absolute_path") or blob.get("local_path") or "").strip() or None,
                            "url": str(blob.get("url") or "").strip() or None,
                        }
                    ],
                }
            else:
                # 仅抬作者中文 title（与 action 同级）；不用 action_summary 冒充卡头
                # （长摘要会盖掉前端中文短标签；无 title 时前端自己兜底）
                card_title = str(blob.get("title") or "").strip()
                if card_title and action_name:
                    domain = str(blob.get("domain") or "").strip()
                    if not domain and "." in action_name:
                        domain = action_name.split(".", 1)[0]
                    ui = {
                        "action": action_name,
                        "title": card_title,
                        "domain": domain,
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
            open_data = (
                open_stage.get("data")
                if isinstance(open_stage.get("data"), dict)
                else {}
            )
            open_entry: dict[str, Any] = {
                "kind": kind[:64],
                "data": open_data,
            }
            # 标签标题：必须上浮，否则前端会回落到 path（看起来像链接地址）
            stage_title = str(open_stage.get("title") or "").strip()
            if stage_title:
                open_entry["title"] = stage_title[:256]
            stage_layout = str(open_stage.get("layout") or "").strip()
            if stage_layout:
                open_entry["layout"] = stage_layout[:64]
            entry: dict[str, Any] = {
                "label": label[:64],
                "openStage": open_entry,
            }
            if row.get("autoOpen") is True:
                entry["autoOpen"] = True
            route = str(row.get("route") or "").strip()
            if route:
                entry["route"] = route[:256]
            progress_actions.append(entry)
            if len(progress_actions) >= 4:
                break
    media_items: list[dict[str, Any]] = []
    raw_media = ui.get("media")
    if isinstance(raw_media, list):
        for row in raw_media[:4]:
            if not isinstance(row, dict):
                continue
            uri = str(
                row.get("artifactUri")
                or row.get("artifact_uri")
                or row.get("src")
                or row.get("absolutePath")
                or row.get("absolute_path")
                or row.get("url")
                or ""
            ).strip()
            if not uri:
                continue
            kind = str(row.get("kind") or "").strip().lower()
            mime = str(row.get("mimeType") or row.get("mime_type") or "").strip()
            if not kind:
                kind = "video" if ("video" in mime or uri.lower().endswith((".mp4", ".webm", ".mov", ".mkv", ".m4v"))) else "image"
            if not mime:
                mime = "video/mp4" if kind == "video" else "image/png"
            entry: dict[str, Any] = {
                "kind": kind,
                "mimeType": mime[:128],
                "artifactUri": uri[:4096],
            }
            abs_path = str(row.get("absolutePath") or row.get("absolute_path") or "").strip()
            if abs_path:
                entry["absolutePath"] = abs_path[:1024]
            media_items.append(entry)

    title = str(ui.get("title") or "").strip()
    # 有 title 也出 display（卡头）；无绑码 / CTA / 媒体 / 标题则跳过
    if (
        not qr
        and not session_id
        and not progress_actions
        and not media_items
        and action != "employees.bind_channel_begin"
        and not title
    ):
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
    if media_items:
        block["media"] = media_items
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


def _is_user_interrupt_event(ev: dict[str, Any] | None) -> bool:
    """True when RUN_ERROR is user stop (AG-UI maps EVF ``aborted`` → USER_INTERRUPT)."""
    if not isinstance(ev, dict):
        return False
    code = str(ev.get("code") or "").strip().lower().replace("-", "_")
    msg = str(ev.get("message") or ev.get("error") or "").strip().lower()
    if code in {"user_interrupt", "userinterrupt", "aborted", "cancelled", "canceled"}:
        return True
    if "user_interrupt" in code or code.replace("_", "") == "userinterrupt":
        return True
    if "user_interrupt" in msg or "userinterrupt" in msg.replace("_", "").replace(" ", "").replace("-", ""):
        return True
    # "User interrupted" / "user interrupt"
    compact = "".join(ch for ch in msg if ch.isalnum())
    return compact.startswith("userinterrupt") or "userinterrupted" in compact


def _is_generic_upstream_error(low: str) -> bool:
    """上游只回了一句通用英文错误 —— 没有可归因信息。

    【self-evolution-bot · 2026-11-21 · 第115轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增这个判据，把「供应商通用错误」从最后那条纯兜底分支里拉出来。
    为什么（本轮现网实证）：23:26:49 文档撰写师第二轮，上游回
      ``An internal error occurred``（全仓库搜不到这句，是供应商侧通用错误）。
      它不含 timeout / 限流 / 断连等任何特征，于是掉到「本轮生成失败（可点详情/复制…）」，
      用户既不知道是不是自己操作错了，也不知道能不能重发。实测同一句重发即成功。
    边界：只认「短、纯英文、含 internal error 或 generic 语义」的整句，
      不吞掉带具体原因的原文（如 ``internal error: tool schema invalid`` 仍需保留细节）。
    """
    if not low or len(low) > 120:
        return False
    if any("\u4e00" <= ch <= "\u9fff" for ch in low):
        return False
    # 带冒号/句号后还有细节的，说明上游给了可归因信息，不归入本档。
    if ":" in low and len(low.split(":", 1)[1].strip()) > 8:
        return False
    return any(
        marker in low
        for marker in (
            "an internal error occurred",
            "internal error occurred",
            "internal server error occurred",
            "something went wrong",
            "an unexpected error occurred",
        )
    )


def _run_error_info(ev: dict[str, Any], *, now_ms: int) -> dict[str, Any]:
    """Build V4 ``control.lastError`` from a RUN_ERROR event.

    ``message`` is short Chinese for the banner; ``detail`` keeps the raw cause
    so users can copy / feedback without opening system logs.

    User stops are not errors — callers must skip this helper via
    :func:`_is_user_interrupt_event` and project ``completedInterrupted`` instead.
    """
    code = str(ev.get("code") or "run_error").strip() or "run_error"
    raw = str(ev.get("message") or ev.get("error") or "").strip()
    if not raw:
        raw = code
    # Keep detail bounded for wire size but long enough for Pydantic / vendor text.
    detail = raw[:4000]
    low = raw.lower()
    code_low = code.lower().replace("-", "_")
    bare = low in {"run_error", "error", "unknown", "failed", "failure"} or (
        code_low in {"run_error", "error"} and len(raw) <= 40 and not any("\u4e00" <= ch <= "\u9fff" for ch in raw)
    )
    if "pydanticinvalidforjsonschema" in low or "cannot generate a jsonschema" in low:
        facing = "本轮生成失败：工具参数 schema 异常（可点「详情/复制」反馈）"
        if "knowledge" in low:
            facing = "本轮生成失败：knowledge 工具 schema 异常（可点「详情/复制」反馈）"
    elif (
        "invalid_concurrent_graph_update" in low
        or "can receive only one value per step" in low
        or ("viewed_images" in low and "annotated key" in low)
    ):
        # 2026-11-26：并行 platform 生图多路写 viewed_images；FE toUserFacingError
        # 曾收成「操作失败，请稍后重试」，诊断抓不到真因。
        facing = "本轮生成失败：并行生图状态冲突（可再发一次；批量出图请稍等或分批）"
    elif "rate limit" in low or "429" in low:
        facing = "本轮生成失败：模型限流，请稍后重试"
    elif (
        "remoteprotocolerror" in low
        or "server disconnected" in low
        or "connection reset" in low
        or "connection aborted" in low
        or "broken pipe" in low
    ):
        facing = "本轮生成失败：模型连接中断，请稍后重试；超长对话建议开新会话"
    elif "timeout" in low or "timed out" in low:
        facing = "本轮生成失败：请求超时，请稍后重试"
    elif _is_generic_upstream_error(low):
        # 【self-evolution-bot · 2026-11-21 · 第115轮 · 模型:deepseek-v4.1-flash-1017】
        # 详情里补一句「本轮没生成内容」——这是用户唯一的硬事实，他据此判断要不要重发。
        # 改了什么：新增「上游只给了一句通用英文错误」这一档，之前它掉到最后那条
        #   既不说原因也不说下一步的兜底文案。
        # 为什么（本轮现网实证）：23:26:49 三个员工面板并发两轮对话，文档撰写师第二轮
        #   上游回 "An internal error occurred"（仓库里搜不到这句，属供应商通用错误）。
        #   用户看到的是「本轮生成失败（可点「详情/复制」把原文发给协助排查的人）」
        #   —— 既看不出是模型侧还是我的操作有问题，也不知道该不该重发。
        #   实测同一句重发一次就成功（DA14C 正常回），所以这是**可直接重发**的偶发故障，
        #   文案必须把「再发一次」写成默认动作。
        # 注（2026-11-23）：LangGraph ``serde`` 也会把 ``sqlite3.OperationalError``
        #   （含 db_process_lock_timeout）红acted 成同一句英文——那时根因是本机 DB 锁，
        #   不是模型。Hydration / TranscriptMiddleware 已 soft-fail；若仍漏到 wire，
        #   文案仍提示重发（middleware 硬失败没有 model_fallback 重试路径）。
        facing = "本轮生成失败：模型服务临时内部错误，直接再发一次通常就能过"
    elif bare:
        # Upstream often emits only ``run_error`` with no vendor text — say what to do.
        facing = "本轮生成失败：模型服务中断或本机负载过高，请稍后重试；超长对话建议开新会话"
        if low in {"run_error", "error", "unknown"}:
            detail = (
                f"{raw}（上游未返回具体原因；常见：模型断连、Gateway 过载、上下文过长。"
                "可查 ~/.evoflow/logs/frontend-*.log / gateway-*.log）"
            )[:4000]
    elif len(raw) <= 160 and any("\u4e00" <= ch <= "\u9fff" for ch in raw):
        facing = raw
    else:
        facing = "本轮生成失败（可点「详情/复制」把原文发给协助排查的人）"
    generic_upstream = _is_generic_upstream_error(low)
    return {
        "code": code[:120],
        "message": facing[:500],
        "detail": detail,
        # 临时内部错误 / 断连：前端可提示重发；与「再发一次通常就能过」文案对齐
        "recoverable": bool(
            bare
            or generic_upstream
            or "remoteprotocol" in low
            or "disconnected" in low
            or "timeout" in low
            or "timed out" in low
        ),
        "at": now_ms,
        "source": "runtime",
    }


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
    user_attachments: list[dict[str, Any]] = field(default_factory=list)
    user_message_id: str = ""
    """Stable transcript message id for the pending userInput row (editUserQuery target)."""
    user_origin: str = "realUser"
    """Pending userInput 行的 origin（vendored userInputRowSchema.origin 枚举值）。
    goal 引擎发起的续跑 run（body context.source=goal-continuation）标 goalContinuation，
    时间线上以「目标推送」徽标区分真实用户输入。"""
    user_epilogue_start: int = 0
    """引擎尾注起始下标（续跑轮把 completion-audit 指令折进披露，气泡正文只显示目标）。"""
    last_turn_id: str = ""
    """最近一个开过的 turnId（RUN_STARTED 时记录，轮尾不清）。task_* 事件晚到时
    subagent 行仍能挂回宿主轮，配对（parentToolCallId + turnId）不因轮已结算而断。"""
    sticky_run_error: dict[str, Any] | None = None
    """最近一次 RUN_ERROR 的 lastError。空流 auto-retry 的 RUN_FINISHED 不得清掉，
    否则输入框上方错误横幅一闪而过，用户无法复制详情反馈。"""
    subagent_rows: dict[str, int] = field(default_factory=dict)
    """task_id → subagent rowId（task_started 分配；终态 upsert 后保留，
    防乱序迟到帧重建出重复行）。跨轮保留——task 终态可能晚于 RUN_FINISHED。"""
    subagent_turn: dict[str, str] = field(default_factory=dict)
    """task_id → 分配行时的 turnId（跨轮终态 upsert 时保持与宿主 toolCall 行同轮）。"""
    subagent_meta: dict[str, dict[str, str]] = field(default_factory=dict)
    """task_id → {subagentType, description}（task_started 记账）。

    终态帧通常不带这些字段，而 v4 upsert 是整行替换——不记账会把 Agent 卡上的
    类型徽标清成 general、摘要清空。"""
    turn_usage: dict[str, int] | None = None
    """最近一轮的累计 token usage（CUSTOM name="usage" 的六字段 wire 三元组）。

    跨轮保留——早封路径（thread_state/usage 先于 run_end）里 RUN_FINISHED 先到、
    usage 事件同批后到，reset 后仍要盖到轮尾正文行上；RUN_STARTED 开新轮时清零。"""
    last_text_row_id: int = 0
    """最近一条 assistantText 行 rowId（TEXT_MESSAGE_START 记录，跨轮保留）。
    usage 盖章目标：轮累计只盖轮尾正文行（V4 面板在轮尾动作行显示）。"""
    last_turn_success: bool = False
    """最近一轮是否成功收尾（RUN_FINISHED=True / RUN_ERROR=False）。failed 轮不盖 usage。"""
    usage_bumped: bool = False
    """本轮累计 usage 是否已并入会话级 usage_state。usage 事件是轮累计（非增量），
    RUN_FINISHED 与迟到事件只允许并入一次，防双计。"""
    empty_run_timer: threading.Timer | None = field(default=None, repr=False)
    """延后写入 empty-run 占位的 timer；正文/工具到达或新轮开始时取消。"""


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
        # 经 hub 唯一入口写 control：override 落会话态，快照重建（刷新重订阅 /
        # recovery / 订阅者溢出转 snapshot）与在线 delta 同源——不再被
        # _minimal_control(sess.phase) 重算覆盖（主聊 sess.phase 停在 draft，
        # 刷新后 control 永远 draft+canStop:false 的根因）。
        self._hub.set_control_override(tid, control)

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
        self._persist_notice_assistant_text(tid, st, body, mid=mid, now_ms=now_ms)

    def _persist_notice_assistant_text(
        self, tid: str, st: _MirrorState, body: str, *, mid: str, now_ms: int
    ) -> None:
        """把「本轮为什么没有正文」的说明落进 DB transcript —— 否则刷新/重开会话后整轮凭空消失。

        【self-evolution-bot · 2026-11-22 · 第116轮 · 模型:deepseek-v4.1-flash-1017】
        改了什么：新增本方法，在 ``_upsert_error_assistant_text`` 末尾调用，把失败
          文案以 assistant 行写进 ``evoflow_chat_messages``。
        【self-evolution-bot · 2026-11-22 · 第118轮 · 模型:deepseek-v4.1-flash-1017】
          改名 ``_persist_error_assistant_text`` → ``_persist_notice_assistant_text``，
          并把 ``_upsert_empty_run_notice_now``（空跑占位）也接上；两个调用点同形，
          区别只在 ``mid`` 前缀（``model-error-`` / ``empty-run-``）。
          为什么扩到空跑：本轮全量复算 ``message_id LIKE 'empty-run-%'`` = **0 条**，
          ``content_json`` 里含空跑文案的 assistant 行（严格匹配 `"content":"本轮没有…`）
          也 **0 条** —— 空跑说明一直只活在 hub 内存（``author_append_row``）与前端
          ``EMPTY_TURN_NOTICE`` 里。``hydration.py`` 从 DB 重建时能补一条合成行兜住
          显示，但**库里没有任何实体**记录「这一轮为什么没回复」。
        为什么（第116轮原按）：``_upsert_error_assistant_text`` 只写 hub 内存行
          （``author_append_row``），而 DB 落库归 ``TranscriptMiddleware.after_model``，
          它**只在模型成功返回后**才跑；模型抛 RUN_ERROR 时 after_model 根本不执行。
          后果实测：2026-11-21 23:26:49 文档撰写师 DA14B 那一轮，DB 里只有 user 行、
          **一条 assistant 行都没有**，连错误文案也没落盘 —— 用户刷新页面或重开会话，
          这一整轮凭空消失，只剩一句没人回的提问，无从判断当时发生了什么。
          全量复算（排除本岗位自身会话）：包含「本轮生成失败／详情（可复制反馈）」
          的 assistant 行 **0 条** —— 说明这条路径从未真正落过库，不是偶发。
        边界：message_id 用确定性 ``{mid}``（``model-error-{turn_id}`` /
          ``empty-run-{turn_id}``），配合 ``append_messages_batch_and_touch_session`` 的
          ``skip_if_seq_exists``，同一轮重试 N 次也只落 1 条；任何异常都只记 warning，
          绝不打断错误横幅/占位渲染。
        """
        try:
            from evoflow.persistence.chat_message_repositories import resolve_parent_thread_id
            from evoflow.persistence.chat_session_service import (
                append_messages_batch_and_touch_session,
            )
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            sk = find_session_key_by_thread_id(tid)
            if not sk:
                logger.debug("[v4-mirror] notice persist skipped: no session for tid=%s", tid)
                return
            append_messages_batch_and_touch_session(
                sk,
                [
                    {
                        "role": "assistant",
                        "message_id": mid,
                        "content": {"content": body},
                    }
                ],
                thread_id=tid,
                parent_thread_id=resolve_parent_thread_id(tid),
                skip_if_seq_exists=True,
            )
        except Exception:
            logger.warning(
                "[v4-mirror] notice persist failed tid=%s mid=%s", tid, mid, exc_info=True
            )

    def _turn_has_assistant_work(self, tid: str, turn_id: str) -> bool:
        """Hub 上该轮是否已有可见助手产物（正文/思考/工具），不只看 text_acc。"""
        want = str(turn_id or "").strip()
        if not want:
            return False
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return False
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            if str(row.get("turnId") or "").strip() != want:
                continue
            kind = str(row.get("kind") or "")
            if kind in ("assistantText", "reasoning", "toolCall", "subagent"):
                # 空跑占位本身不算「有产出」
                eid = str(row.get("entityId") or "")
                if eid.startswith("empty-run-"):
                    continue
                if kind == "assistantText" and not str(row.get("text") or "").strip():
                    continue
                return True
        return False

    def _turn_has_visible_user_input(self, tid: str, turn_id: str) -> bool:
        """该轮是否还有可见 realUser / goalContinuation 气泡（不含隐藏通知文案）。"""
        want = str(turn_id or "").strip()
        if not want:
            return False
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return False
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            if str(row.get("turnId") or "").strip() != want:
                continue
            if str(row.get("kind") or "") != "userInput":
                continue
            origin = str(row.get("origin") or "").strip()
            if origin not in ("", "realUser", "goalContinuation"):
                continue
            text = str(row.get("text") or "").strip()
            atts = row.get("attachments")
            if not text and not atts:
                continue
            if text and (
                _is_hidden_tool_approval_user_text(text)
                or _is_hidden_duty_brief_user_text(text)
                or _is_hidden_task_notification_user_text(text)
                or _is_hidden_context_compaction_user_text(text)
            ):
                continue
            return True
        return False

    def _demote_orphan_user_input_header(
        self, tid: str, turn_id: str, *, now_ms: int
    ) -> None:
        """userInput 被挂走后，旧头若仍自称 origin=userInput → 浮层 !NO_USER / 左栏劈开。

        现场：RUN_STARTED 新建轮头并把 reusable 用户气泡 turnId 改到新轮，旧头
        completedSuccess + origin=userInput 却无用户行（诊断 #1 !NO_USER；新轮
        user.rowId < header.rowId）。
        """
        want = str(turn_id or "").strip()
        if not want:
            return
        if self._turn_has_visible_user_input(tid, want):
            return
        hdr_rid, started_at, origin = self._lookup_turn_header(tid, want)
        if hdr_rid <= 0:
            return
        if str(origin or "").strip() != "userInput":
            return
        sess = self._hub.get_session(tid)
        existing = sess.rows.get(int(hdr_rid)) if sess is not None else None
        state = (
            str(existing.get("state") or "").strip()
            if isinstance(existing, dict)
            else "completedSuccess"
        )
        ended_at = (
            int(existing.get("endedAt") or 0)
            if isinstance(existing, dict)
            else 0
        )
        payload: dict[str, Any] = {
            "rowId": hdr_rid,
            "turnId": want,
            "entityId": want,
            "kind": "turnHeader",
            "origin": "goalContinuation",
            "state": state or "completedSuccess",
            "startedAt": int(started_at or now_ms),
            "createdAt": int(started_at or now_ms),
            "createdAtSeq": self._seq_now(tid),
        }
        if ended_at > 0:
            payload["endedAt"] = ended_at
        elif state.startswith("completed") or state in ("failed", "completedInterrupted"):
            payload["endedAt"] = now_ms
        if isinstance(existing, dict) and existing.get("fileChanges"):
            payload["fileChanges"] = existing["fileChanges"]
        self._hub.author_upsert_row(tid, payload)
        logger.info(
            "[v4-mirror] demote orphan userInput header thread=%s turn=%s → goalContinuation",
            tid,
            want,
        )

    def _cancel_pending_empty_run(self, st: _MirrorState) -> None:
        timer = st.empty_run_timer
        if timer is None:
            return
        try:
            timer.cancel()
        except Exception:
            pass
        st.empty_run_timer = None

    def _upsert_empty_run_notice_now(
        self, tid: str, st: _MirrorState, *, turn_id: str, now_ms: int
    ) -> None:
        """立刻写入空跑占位（延时到点 / 单测 defer=0）。"""
        want = str(turn_id or "").strip()
        if not want:
            return
        if self._turn_has_assistant_work(tid, want):
            return
        mid = f"empty-run-{want}"
        sess = self._hub.get_session(tid)
        if sess is not None:
            for row in sess.rows.values():
                if (
                    isinstance(row, dict)
                    and str(row.get("entityId") or "") == mid
                    and str(row.get("turnId") or "").strip() == want
                ):
                    return
        # 要求该 turn 仍有可见用户气泡，避免给已被挂走用户的孤儿头贴空跑。
        if not self._turn_has_visible_user_input(tid, want):
            return
        rid = self._next_row_id(tid)
        st.text_row_ids[mid] = rid
        st.text_acc[mid] = EMPTY_RUN_NOTICE_TEXT
        self._hub.author_append_row(
            tid,
            {
                "rowId": rid,
                "turnId": want,
                "kind": "assistantText",
                "text": st.text_acc[mid],
                "state": "complete",
                "createdAt": now_ms,
                "createdAtSeq": self._seq_now(tid),
                "entityId": mid,
            },
        )
        # 【self-evolution-bot · 2026-11-22 · 第118轮 · 模型:deepseek-v4.1-flash-1017】
        # 空跑占位也落 DB：全量复算 `message_id LIKE 'empty-run-%'` = 0 条，
        # 说明这条说明文字一直只活在 hub 内存与前端 EMPTY_TURN_NOTICE 里，
        # 刷新后靠 hydration.py 合成才勉强可见，库里无从查证「这轮为何没回复」。
        self._persist_notice_assistant_text(
            tid, st, str(st.text_acc.get(mid) or EMPTY_RUN_NOTICE_TEXT), mid=mid, now_ms=now_ms
        )

    def _upsert_empty_run_notice(self, tid: str, st: _MirrorState, *, now_ms: int) -> None:
        """空流 / 过早 RUN_FINISHED：延后写占位，避免「先闪未产出再出真回复」。"""
        turn_id = str(st.turn_id or "").strip()
        if not turn_id:
            return
        if self._turn_has_assistant_work(tid, turn_id):
            return
        self._cancel_pending_empty_run(st)
        defer = float(_EMPTY_RUN_DEFER_SEC)
        if defer <= 0:
            self._upsert_empty_run_notice_now(tid, st, turn_id=turn_id, now_ms=now_ms)
            return

        def _fire() -> None:
            try:
                self._upsert_empty_run_notice_now(
                    tid, st, turn_id=turn_id, now_ms=_now_ms()
                )
            except Exception:
                logger.debug(
                    "[v4-mirror] deferred empty-run upsert failed thread=%s turn=%s",
                    tid,
                    turn_id,
                    exc_info=True,
                )
            finally:
                if st.empty_run_timer is timer:
                    st.empty_run_timer = None

        timer = threading.Timer(defer, _fire)
        timer.daemon = True
        st.empty_run_timer = timer
        timer.start()

    def _delete_notice_row_from_db(self, tid: str, mid: str) -> None:
        """撤占位时同步删 DB 那一行（``empty-run-*``）。

        【self-evolution-bot · 2026-11-22 · 第118轮 · 模型:deepseek-v4.1-flash-1017】
        改了什么：新增本方法，在 ``_clear_empty_run_notices`` 里按 entityId 调用。
        为什么：第118轮把空跑占位接上了 DB 落库（``_persist_notice_assistant_text``），
          而「迟到正文到达 → 撤占位」原来只删 hub 内存行。若不同步删库，刷新后同一轮
          会同时出现真回复与「本轮未产出可见回复」—— 比不落库更误导。
        边界：只按精确 message_id 删；任何异常只记 debug，绝不阻断正文渲染。
        """
        if not str(mid or "").startswith("empty-run-"):
            return
        try:
            from evoflow.persistence.chat_message_repositories import delete_message_by_message_id
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            sk = find_session_key_by_thread_id(tid)
            if not sk:
                return
            delete_message_by_message_id(sk, mid)
        except Exception:
            logger.debug("[v4-mirror] delete notice row failed tid=%s mid=%s", tid, mid, exc_info=True)

    def _clear_empty_run_notices(self, tid: str, st: _MirrorState) -> None:
        """真实正文/工具开始后，撤掉空跑占位，避免和真回复叠两条。

        重启后过早 FINISHED 常先落 empty-run，续跑挂到新 turn——只清当前 turn
        会让上一轮空跑提示永远挂着。凡 entityId 以 empty-run- 开头的占位一并清。
        """
        self._cancel_pending_empty_run(st)
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return
        drop: list[tuple[int, str]] = []
        drop_mids: list[str] = []
        for rid, row in list(sess.rows.items()):
            if not isinstance(row, dict):
                continue
            eid = str(row.get("entityId") or "")
            if not eid.startswith("empty-run-") or eid.startswith("empty-run-cleared-"):
                continue
            drop.append((int(rid), str(row.get("turnId") or "").strip()))
            # 【self-evolution-bot · 2026-11-22 · 第118轮 · 模型:deepseek-v4.1-flash-1017】
            # 占位现在会真的落库，撤占位必须同时删 DB 那条 —— 否则刷新后同一轮里
            # 既有真回复、又有「本轮未产出可见回复」。
            drop_mids.append(eid)
            st.text_row_ids.pop(eid, None)
            st.text_acc.pop(eid, None)
        if not drop:
            return
        for mid in drop_mids:
            self._delete_notice_row_from_db(tid, mid)
        remove = getattr(self._hub, "author_remove_rows", None) or getattr(
            self._hub, "remove_rows", None
        )
        if callable(remove):
            try:
                remove(tid, [rid for rid, _ in drop])
                return
            except Exception:
                logger.debug(
                    "[v4-mirror] clear empty-run notice via remove failed thread=%s",
                    tid,
                    exc_info=True,
                )
        # hub 无删行 API 时：把占位文案清空并标 interrupted，前端折叠健康会弱化空壳。
        now_ms = _now_ms()
        for rid, row_turn in drop:
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": row_turn or str(st.turn_id or "").strip(),
                    "kind": "assistantText",
                    "text": "",
                    "state": "interrupted",
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    "entityId": f"empty-run-cleared-{rid}",
                },
            )

    def _mark_assistant_text_interrupted(self, tid: str, st: _MirrorState, *, now_ms: int) -> None:
        """Seal in-flight assistantText rows as interrupted after user stop."""
        if not st.text_row_ids:
            return
        for mid, rid in list(st.text_row_ids.items()):
            sess = self._hub.get_session(tid)
            existing = sess.rows.get(int(rid)) if sess is not None else None
            # 保留 TEXT_MESSAGE_START 写入的 createdAt——勿盖成 turn_started，
            # 否则同轮多段正文共用一个时间戳，前端 created_at_regression。
            created_at = (
                int(existing.get("createdAt") or 0)
                if isinstance(existing, dict)
                else 0
            ) or now_ms
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "assistantText",
                    "text": str(st.text_acc.get(mid) or ""),
                    "state": "interrupted",
                    "createdAt": created_at,
                    "createdAtSeq": self._seq_now(tid),
                    "entityId": mid,
                    "endedAt": now_ms,
                },
            )

    def _seal_streaming_reasoning(
        self, tid: str, st: _MirrorState, *, now_ms: int, state: str = "interrupted"
    ) -> None:
        """停/顶轮时封掉仍 streaming 的思考行，否则 timelineBusy 钉死、画面像卡住。"""
        seal = str(state or "interrupted").strip() or "interrupted"
        sealed_ids: set[int] = set()
        for mid, rid in list(st.reasoning_row_ids.items()):
            sess = self._hub.get_session(tid)
            existing = sess.rows.get(int(rid)) if sess is not None else None
            cur_state = (
                str(existing.get("state") or "").strip()
                if isinstance(existing, dict)
                else ""
            )
            if cur_state and cur_state != "streaming":
                continue
            created_at, started_at = self._preserve_tool_timestamps(
                existing if isinstance(existing, dict) else None, now_ms=now_ms
            )
            duration_ms = self._reasoning_duration_ms(
                existing if isinstance(existing, dict) else None, now_ms=now_ms
            )
            text = str(st.reasoning_acc.get(mid) or "")
            if not text and isinstance(existing, dict):
                text = str(existing.get("text") or "")
            seal_row: dict[str, Any] = {
                "rowId": rid,
                "turnId": self._preserve_tool_turn_id(existing if isinstance(existing, dict) else None, st)
                or st.turn_id,
                "kind": "reasoning",
                "state": seal,
                "text": text,
                "createdAt": created_at,
                "createdAtSeq": self._seq_now(tid),
                "assistantResponseId": mid,
                "startedAt": started_at,
                "endedAt": now_ms,
            }
            if duration_ms is not None:
                seal_row["durationMs"] = duration_ms
            self._hub.author_upsert_row(tid, seal_row)
            try:
                sealed_ids.add(int(rid))
            except (TypeError, ValueError):
                pass
        # map 已清 / remint 后仍可能留下 streaming 孤儿（现场：phase=idle 但
        # 「正在思考」钉死；诊断 inFlight=3）。扫本轮 hub 行补封。
        self._seal_orphan_streaming_reasoning(
            tid, st, now_ms=now_ms, state=seal, skip_row_ids=sealed_ids
        )

    def _seal_orphan_streaming_reasoning(
        self,
        tid: str,
        st: _MirrorState,
        *,
        now_ms: int,
        state: str,
        skip_row_ids: set[int] | None = None,
        any_terminal_turn: bool = False,
    ) -> int:
        """封掉 map 外仍 streaming 的思考行。

        ``any_terminal_turn``：扫描所有已终态轮头下的 streaming（snapshot heal），
        不只看当前 ``st.turn_id``。
        """
        seal = str(state or "interrupted").strip() or "interrupted"
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return 0
        skip = skip_row_ids or set()
        turn_id = str(st.turn_id or "").strip()
        terminal_turns: set[str] = set()
        if any_terminal_turn:
            for row in sess.rows.values():
                if not isinstance(row, dict) or str(row.get("kind") or "") != "turnHeader":
                    continue
                hdr_state = str(row.get("state") or "").strip()
                if hdr_state in {
                    "completedSuccess",
                    "failed",
                    "completedInterrupted",
                    "error",
                }:
                    tid_s = str(row.get("turnId") or "").strip()
                    if tid_s:
                        terminal_turns.add(tid_s)
        sealed = 0
        for row in list(sess.rows.values()):
            if not isinstance(row, dict):
                continue
            if str(row.get("kind") or "") != "reasoning":
                continue
            if str(row.get("state") or "").strip() != "streaming":
                continue
            try:
                row_id = int(row.get("rowId") or 0)
            except (TypeError, ValueError):
                continue
            if row_id <= 0 or row_id in skip:
                continue
            row_turn = str(row.get("turnId") or "").strip()
            if any_terminal_turn:
                if row_turn and row_turn not in terminal_turns:
                    continue
            elif turn_id and row_turn and row_turn != turn_id:
                continue
            created_at, started_at = self._preserve_tool_timestamps(row, now_ms=now_ms)
            duration_ms = self._reasoning_duration_ms(row, now_ms=now_ms)
            seal_row: dict[str, Any] = {
                "rowId": row_id,
                "turnId": row_turn or turn_id,
                "kind": "reasoning",
                "state": seal if seal != "complete" else "complete",
                "text": str(row.get("text") or ""),
                "createdAt": created_at,
                "createdAtSeq": self._seq_now(tid),
                "assistantResponseId": str(row.get("assistantResponseId") or ""),
                "startedAt": started_at,
                "endedAt": now_ms,
            }
            if duration_ms is not None:
                seal_row["durationMs"] = duration_ms
            self._hub.author_upsert_row(tid, seal_row)
            sealed += 1
        return sealed

    _OPEN_TOOL_STATUSES = frozenset(
        {"", "inputStreaming", "pendingApproval", "running", "in_progress"}
    )

    def _tool_row_is_pending_approval(self, existing: dict[str, Any] | None) -> bool:
        if not isinstance(existing, dict):
            return False
        if str(existing.get("status") or "").strip() == "pendingApproval":
            return True
        out = existing.get("output")
        text = ""
        if isinstance(out, dict):
            text = str(out.get("text") or "")
        elif out is not None:
            text = str(out)
        return _tool_content_is_pending_approval(text)

    def _turn_has_pending_approval_tools(self, tid: str, st: _MirrorState) -> bool:
        """本轮是否仍有待授权工具卡（含信封误标 success 的滞后态）。"""
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return False
        turn = str(st.turn_id or "").strip()
        for row in sess.rows.values():
            if not isinstance(row, dict) or row.get("kind") != "toolCall":
                continue
            if turn and str(row.get("turnId") or "").strip() not in ("", turn):
                continue
            if self._tool_row_is_pending_approval(row):
                return True
        return False

    def _seal_open_tool_calls(
        self,
        tid: str,
        st: _MirrorState,
        *,
        now_ms: int,
        status: str,
        preserve_pending_approval: bool = False,
    ) -> None:
        """RUN 收尾时封掉未 RESULT 的工具卡。

        TOOL_CALL_END 会把 status 写成 running；若随后 RUN_FINISHED 而 RESULT 迟到，
        ``_reset_turn_ephemeral`` 已清 ``tool_row_ids``，迟到 RESULT 再也写不进行 →
        工具卡永久 running，前端 timelineBusy 与侧栏 idle 打架（切回话一直转圈）。

        正常 FINISHED 且 wire RESULT 丢失时：Transcript 往往已有 ToolMessage
        （middleware 先落库）。此时不要硬盖 cancelled——回填 success+output。
        但 pending_approval 信封不是真结果：回填必须保持 pendingApproval，
        否则授权闸门轮会被误标成功、页面像「自己停了」。
        """
        seal = str(status or "cancelled").strip() or "cancelled"
        # 即使 tool_row_ids 已空，仍要扫 HUB 孤儿行（map 中途 clear → 永久「等待中」）。
        for tcid, rid in list(st.tool_row_ids.items()):
            try:
                row_id = int(rid)
            except (TypeError, ValueError):
                continue
            sess = self._hub.get_session(tid)
            existing = sess.rows.get(row_id) if sess is not None else None
            cur = (
                str(existing.get("status") or "").strip()
                if isinstance(existing, dict)
                else ""
            )
            if preserve_pending_approval and self._tool_row_is_pending_approval(
                existing if isinstance(existing, dict) else None
            ):
                continue
            if cur and cur not in self._OPEN_TOOL_STATUSES:
                continue
            # map 回填到上一轮工具行时：禁止用本轮 seal 改它的 turnId/status。
            if isinstance(existing, dict):
                row_turn = str(existing.get("turnId") or "").strip()
                cur_turn = str(st.turn_id or "").strip()
                if row_turn and cur_turn and row_turn != cur_turn:
                    continue
            created_at, started_at = self._preserve_tool_timestamps(
                existing if isinstance(existing, dict) else None, now_ms=now_ms
            )
            input_text = st.tool_acc.get(tcid, "") or (
                str(existing.get("inputText") or "") if isinstance(existing, dict) else ""
            )
            tool_name = self._tool_name(st, tcid, {})
            row_out: dict[str, Any] = {
                "rowId": row_id,
                "turnId": st.turn_id,
                "kind": "toolCall",
                "toolCallId": tcid,
                "toolName": tool_name,
                "status": seal,
                "inputText": input_text,
                "createdAt": created_at,
                "createdAtSeq": self._seq_now(tid),
                "startedAt": started_at,
                "endedAt": now_ms,
            }
            # 仅「正常收尾却缺 RESULT」走回填；用户停止 / RUN_ERROR 仍按 seal 语义。
            if seal == "cancelled":
                self._apply_transcript_backfill_to_tool_row(
                    tid, st, tcid=tcid, row_out=row_out
                )
            self._hub.author_upsert_row(tid, row_out)

        # map 被中途 clear 时，仍可能留下本轮 inputStreaming/running 孤儿行。
        # 再扫一遍 HUB，把同 turn 未收口工具补 seal（search_code_index「等待中」现场）。
        self._seal_orphan_open_tool_rows(
            tid, st, now_ms=now_ms, status=seal, preserve_pending_approval=preserve_pending_approval
        )
        # 最后兜底：任意 turn 上仍 open 的工具，只要 transcript 已有正文就升级。
        # 覆盖 turn_id 错位 / reuse 清 map / SSE 丢 RESULT 叠在一起的现场。
        if seal == "cancelled":
            self._heal_open_tools_from_transcript(
                tid, st, now_ms=now_ms, preserve_pending_approval=preserve_pending_approval
            )

    def _apply_transcript_backfill_to_tool_row(
        self,
        thread_id: str,
        st: _MirrorState,
        *,
        tcid: str,
        row_out: dict[str, Any],
    ) -> bool:
        backfill = _transcript_tool_result_text(thread_id, tcid)
        if backfill is None:
            return False
        bf_name, bf_body = backfill
        if bf_name and bf_name != "tool":
            row_out["toolName"] = bf_name
            if tcid not in st.tool_names:
                st.tool_names[tcid] = bf_name
        if _tool_content_is_pending_approval(bf_body):
            row_out["status"] = "pendingApproval"
            row_out["output"] = {"text": _preview_tool_output_text(bf_body)}
            row_out.pop("endedAt", None)
        else:
            row_out["status"] = "success"
            row_out["output"] = {"text": _preview_tool_output_text(bf_body)}
        return True

    def _seal_orphan_open_tool_rows(
        self,
        tid: str,
        st: _MirrorState,
        *,
        now_ms: int,
        status: str,
        preserve_pending_approval: bool = False,
    ) -> None:
        """Seal open toolCall rows for this turn that are no longer in ``tool_row_ids``."""
        seal = str(status or "cancelled").strip() or "cancelled"
        turn_id = str(st.turn_id or "").strip()
        if not turn_id:
            return
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return
        mapped = {str(k) for k in st.tool_row_ids.keys()}
        for row in list(sess.rows.values()):
            if not isinstance(row, dict):
                continue
            if str(row.get("kind") or "") != "toolCall":
                continue
            if str(row.get("turnId") or "").strip() != turn_id:
                continue
            tcid = str(row.get("toolCallId") or "").strip()
            if not tcid or tcid in mapped:
                continue
            cur = str(row.get("status") or "").strip()
            if cur and cur not in self._OPEN_TOOL_STATUSES:
                continue
            if preserve_pending_approval and self._tool_row_is_pending_approval(row):
                continue
            try:
                row_id = int(row.get("rowId") or 0)
            except (TypeError, ValueError):
                continue
            if row_id <= 0:
                continue
            created_at, started_at = self._preserve_tool_timestamps(row, now_ms=now_ms)
            row_out: dict[str, Any] = {
                "rowId": row_id,
                "turnId": turn_id,
                "kind": "toolCall",
                "toolCallId": tcid,
                "toolName": str(row.get("toolName") or self._tool_name(st, tcid, {}) or "tool"),
                "status": seal,
                "inputText": str(row.get("inputText") or ""),
                "createdAt": created_at,
                "createdAtSeq": self._seq_now(tid),
                "startedAt": started_at,
                "endedAt": now_ms,
            }
            if seal == "cancelled":
                self._apply_transcript_backfill_to_tool_row(
                    tid, st, tcid=tcid, row_out=row_out
                )
            self._hub.author_upsert_row(tid, row_out)

    def _heal_open_tools_from_transcript(
        self,
        tid: str,
        st: _MirrorState,
        *,
        now_ms: int,
        preserve_pending_approval: bool = False,
    ) -> int:
        """Upgrade any open toolCall rows that already have transcript bodies.

        Does not depend on ``tool_row_ids`` or matching ``turn_id`` — those are
        exactly what go missing when reuse clears maps / RESULT is dropped.
        """
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return 0
        healed = 0
        for row in list(sess.rows.values()):
            if not isinstance(row, dict):
                continue
            if str(row.get("kind") or "") != "toolCall":
                continue
            tcid = str(row.get("toolCallId") or "").strip()
            if not tcid:
                continue
            cur = str(row.get("status") or "").strip()
            if cur and cur not in self._OPEN_TOOL_STATUSES:
                continue
            if preserve_pending_approval and self._tool_row_is_pending_approval(row):
                continue
            try:
                row_id = int(row.get("rowId") or 0)
            except (TypeError, ValueError):
                continue
            if row_id <= 0:
                continue
            created_at, started_at = self._preserve_tool_timestamps(row, now_ms=now_ms)
            row_out: dict[str, Any] = {
                "rowId": row_id,
                "turnId": str(row.get("turnId") or st.turn_id or "").strip(),
                "kind": "toolCall",
                "toolCallId": tcid,
                "toolName": str(row.get("toolName") or self._tool_name(st, tcid, {}) or "tool"),
                "status": "cancelled",
                "inputText": str(row.get("inputText") or ""),
                "createdAt": created_at,
                "createdAtSeq": self._seq_now(tid),
                "startedAt": started_at,
                "endedAt": now_ms,
            }
            if not self._apply_transcript_backfill_to_tool_row(
                tid, st, tcid=tcid, row_out=row_out
            ):
                continue
            self._hub.author_upsert_row(tid, row_out)
            healed += 1
        return healed

    def _seal_streaming_assistant_text(
        self, tid: str, st: _MirrorState, *, now_ms: int, state: str = "complete"
    ) -> None:
        """RUN_FINISHED 时把仍 streaming 的正文收成 complete，避免终态后 timelineBusy。"""
        if not st.text_row_ids:
            return
        for mid, rid in list(st.text_row_ids.items()):
            sess = self._hub.get_session(tid)
            existing = sess.rows.get(int(rid)) if sess is not None else None
            cur_state = (
                str(existing.get("state") or "").strip()
                if isinstance(existing, dict)
                else ""
            )
            if cur_state and cur_state != "streaming":
                continue
            created_at = (
                int(existing.get("createdAt") or 0)
                if isinstance(existing, dict)
                else 0
            ) or now_ms
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": st.turn_id,
                    "kind": "assistantText",
                    "text": str(st.text_acc.get(mid) or ""),
                    "state": state,
                    "createdAt": created_at,
                    "createdAtSeq": self._seq_now(tid),
                    "entityId": mid,
                    "endedAt": now_ms,
                },
            )

    def _bump_session_usage_state(self, tid: str, st: _MirrorState) -> None:
        """把本轮累计 usage 并入会话级 usage_state，并发 usage state 增量。

        基线 = 快照路径（``_build_session_usage``）写的 ``sess.usage_state``（DB
        rollup 真值）；本进程还没建过快照就跳过，下个快照自带真值。usage 事件是
        轮累计（非逐次增量），RUN_FINISHED 与迟到事件靠 ``usage_bumped`` 只并一次。
        DB 累计由 transcript 落库路径（add_session_token_usage）另行维护，不在这里读库。
        """
        usage = st.turn_usage
        if not usage or st.usage_bumped:
            return
        sess = self._hub.get_session(tid)
        base = getattr(sess, "usage_state", None) if sess is not None else None
        if not isinstance(base, dict) or not isinstance(base.get("cumulative"), dict):
            return
        cum = dict(base["cumulative"])

        def _add(key: str, raw: str) -> None:
            cum[key] = int(cum.get(key) or 0) + int(usage.get(raw) or 0)

        _add("inputTokens", "input_tokens")
        _add("outputTokens", "output_tokens")
        _add("cacheReadTokens", "cache_read_tokens")
        _add("cacheWriteTokens", "cache_creation_tokens")
        _add("totalTokens", "total_tokens")
        _add("cacheMissTokens", "cache_miss_tokens")
        patched = {**base, "cumulative": cum}
        sess.usage_state = patched
        st.usage_bumped = True
        self._hub.author_state_patch(tid, {"usage": patched})

    def _stamp_turn_usage(self, tid: str, st: _MirrorState) -> None:
        """把轮累计 usage 盖到最近一条 assistantText 行上（V4 轮尾动作行显示）。

        author_upsert_row 是整行替换：必须从 sess.rows 取现值带全量字段，只追加
        usage 键。行仍在 streaming / 已被换 kind 时不盖（终态帧会再盖）。
        """
        usage = st.turn_usage
        rid = int(st.last_text_row_id or 0)
        if not usage or rid <= 0:
            return
        sess = self._hub.get_session(tid)
        existing = sess.rows.get(rid) if sess is not None else None
        if not isinstance(existing, dict) or str(existing.get("kind") or "") != "assistantText":
            return
        # 只盖**本轮**的轮尾正文行：跨轮保留的 last_text_row_id 在续跑挂回时有效，
        # 但新轮（last_turn_success 后开假新轮 / reset 重放）不得把用量串到上一轮行上。
        # st.turn_id 为空 = 轮已 reset 的迟到帧兜底路径（早封 usage），此时上一轮
        # 刚封口、不存在"更新的一轮"，允许按 last_turn_success 盖上一轮轮尾行。
        cur_turn = str(st.turn_id or "").strip()
        row_turn = str(existing.get("turnId") or "").strip()
        if cur_turn and row_turn != cur_turn:
            return
        if str(existing.get("state") or "") != "complete":
            return
        row_usage: dict[str, int] = {
            "inputTokens": int(usage.get("input_tokens") or 0),
            "outputTokens": int(usage.get("output_tokens") or 0),
            "totalTokens": int(usage.get("total_tokens") or 0),
        }
        cache_read = int(usage.get("cache_read_tokens") or 0)
        cache_write = int(usage.get("cache_creation_tokens") or 0)
        if cache_read > 0:
            row_usage["cacheReadTokens"] = cache_read
        if cache_write > 0:
            row_usage["cacheWriteTokens"] = cache_write
        if not any(row_usage.values()):
            return
        self._hub.author_upsert_row(tid, {**existing, "usage": row_usage})

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

    def note_user_input(
        self,
        thread_id: str,
        text: str,
        *,
        attachments: list[dict[str, Any]] | None = None,
        message_id: str | None = None,
        origin: str = "realUser",
        epilogue_start: int = 0,
    ) -> None:
        """POST / channel 路径解析到用户输入后先记下（RUN_STARTED 时落 userInput 行）。

        ``attachments`` 为 V4 ``AttachmentRef`` 列表（飞书等 IM 入站媒体），可与
        空文本并存（纯图/纯文件回合）。
        ``message_id`` 写入行 ``entityId``，供行内编辑（editUserQuery / truncate）定位。
        """
        tid = str(thread_id or "").strip()
        raw = str(text or "").strip()
        atts = [a for a in (attachments or []) if isinstance(a, dict) and str(a.get("ref") or "").strip()]
        if not tid or (not raw and not atts):
            return
        # 工具审批内部标记（批准/续流）在旧面板不展示；镜像也不落 userInput。
        if raw and _is_hidden_tool_approval_user_text(raw) and not atts:
            return
        # 值班 full brief：可见开场靠 transcript 里的 proactive_duty_beat，勿双写。
        if raw and _is_hidden_duty_brief_user_text(raw) and not atts:
            return
        # 后台任务续跑通知：给模型看，不进用户气泡。
        if not atts and (
            (raw and _is_hidden_task_notification_user_text(raw))
            or _is_hidden_task_notification_message_id(message_id)
        ):
            return
        # 上下文压缩摘要：同理，勿落可见气泡。
        if raw and _is_hidden_context_compaction_user_text(raw) and not atts:
            return
        st = self._state(tid)
        st.user_text = raw
        st.user_attachments = atts[:16]
        st.user_message_id = str(message_id or "").strip()
        st.user_origin = origin if origin in ("realUser", "goalContinuation") else "realUser"
        st.user_epilogue_start = max(0, int(epilogue_start or 0))
        _diag_log(
            "note_user_input",
            tid=tid[:24],
            text_len=len(raw),
            atts=len(atts),
            origin=st.user_origin,
            message_id=str(message_id or "")[:24],
        )
        # 用户新发一条 → 上一轮 sticky 报错退场（新横幅由本轮 RUN_ERROR 再写）。
        st.sticky_run_error = None

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

    def _clear_stream_row_maps(self, st: _MirrorState) -> None:
        """只清正文/思考/工具流式映射；保留 turnHeader / turnId / fileChanges。"""
        st.text_row_ids.clear()
        st.text_acc.clear()
        st.reasoning_row_ids.clear()
        st.reasoning_acc.clear()
        st.tool_row_ids.clear()
        st.tool_acc.clear()
        st.tool_names.clear()

    def _reset_turn_ephemeral(self, st: _MirrorState) -> None:
        """清掉本轮翻译缓存，保留 ``user_text``（下一轮 note_user_input 可能已写入）。

        必须在 RUN_FINISHED / RUN_ERROR 后调用，否则下一轮 RUN_STARTED 会被
        ``run_started`` 闩锁吞掉——历史 turnHeader 会一直停在 completedSuccess，
        新正文/工具却仍挂在旧 turnId 下，ZCode 按历史轮渲染 → 无流式、与上文糊成一团。

        勿在此取消 empty_run_timer：FINISHED 先 schedule 再 reset，cancel 会让
        真·空跑永远落不下占位；正文到达由 ``_clear_empty_run_notices`` 取消。
        """
        st.run_started = False
        st.turn_header_row_id = 0
        st.turn_id = ""
        st.turn_started_at_ms = 0
        self._clear_stream_row_maps(st)
        st.turn_file_changes.clear()

    def _tool_name(self, st: _MirrorState, tcid: str, ev: dict[str, Any]) -> str:
        """优先用 START 记下的真实工具名；事件字段常在 END/RESULT 缺失。"""
        return (
            st.tool_names.get(tcid)
            or str(ev.get("toolCallName") or "").strip()
            or str(ev.get("toolName") or "").strip()
            or "tool"
        )

    def _lookup_tool_row(
        self, tid: str, tcid: str
    ) -> tuple[int, dict[str, Any]] | tuple[None, None]:
        """按 toolCallId 找回已落盘的工具行（不依赖 ephemeral ``tool_row_ids``）。

        RUN_FINISHED 会 seal 未 RESULT 的工具并 ``_reset_turn_ephemeral`` 清 map；
        迟到的 TOOL_CALL_RESULT 若仍只查 map，会直接丢弃 → 卡面永久 cancelled、无 output
       （V4 上 search_code_index 展开空白、索引时效性行也看不见的现场）。
        """
        want = str(tcid or "").strip()
        if not want:
            return None, None
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return None, None
        best: tuple[int, dict[str, Any]] | None = None
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            if str(row.get("kind") or "") != "toolCall":
                continue
            if str(row.get("toolCallId") or "").strip() != want:
                continue
            try:
                rid = int(row.get("rowId") or 0)
            except (TypeError, ValueError):
                continue
            if rid <= 0:
                continue
            if best is None or rid > best[0]:
                best = (rid, row)
        return best if best is not None else (None, None)

    def _resolve_tool_row_id(
        self, tid: str, st: _MirrorState, tcid: str
    ) -> tuple[int | None, dict[str, Any] | None]:
        """先查本轮 map，miss 再扫会话行并回填 map，供 ARGS/END/RESULT 共用。"""
        want = str(tcid or "").strip()
        if not want:
            return None, None
        rid = st.tool_row_ids.get(want)
        if rid is not None:
            sess = self._hub.get_session(tid)
            existing = (
                sess.rows.get(int(rid))
                if sess is not None and isinstance(sess.rows.get(int(rid)), dict)
                else None
            )
            return int(rid), existing if isinstance(existing, dict) else None
        found_rid, found_row = self._lookup_tool_row(tid, want)
        if found_rid is None or found_row is None:
            return None, None
        st.tool_row_ids[want] = int(found_rid)
        name = str(found_row.get("toolName") or "").strip()
        if name and want not in st.tool_names:
            st.tool_names[want] = name
        if want not in st.tool_acc:
            st.tool_acc[want] = str(found_row.get("inputText") or "")
        return int(found_rid), found_row

    @staticmethod
    def _preserve_tool_timestamps(
        existing: dict[str, Any] | None, *, now_ms: int
    ) -> tuple[int, int]:
        """Retain original createdAt/startedAt so duration survives END/RESULT upserts."""
        created_at = now_ms
        started_at = now_ms
        if isinstance(existing, dict):
            try:
                created_at = int(existing.get("createdAt") or 0) or now_ms
            except (TypeError, ValueError):
                created_at = now_ms
            try:
                started_at = int(existing.get("startedAt") or 0) or created_at
            except (TypeError, ValueError):
                started_at = created_at
        return created_at, started_at

    @staticmethod
    def _preserve_tool_turn_id(
        existing: dict[str, Any] | None, st: _MirrorState
    ) -> str:
        """已落盘工具行保留原 turnId，禁止 END/RESULT 把历史工具偷进当前轮。

        ``_lookup_tool_row`` 按 toolCallId 扫全会话；迟到 RESULT / catchup 重放时
        ``st.turn_id`` 已是新轮，若仍写 st.turn_id 会出现：新用户气泡下突然刷出
        上一轮 bash（rowId 远小于用户行）。与 ``_seal_open_tool_calls`` 的跨轮跳过同语义。
        """
        if isinstance(existing, dict):
            old = str(existing.get("turnId") or "").strip()
            if old:
                return old
        return str(st.turn_id or "").strip()

    @staticmethod
    def _should_skip_replayed_success_tool(
        existing: dict[str, Any] | None, _st: _MirrorState
    ) -> bool:
        """已 success 的工具卡：丢弃 ARGS/END/RESULT 重放，避免堵直播增量。

        冷水合后新 run 常把历史 TOOL_CALL_* 再喂一遍（messages-tuple / values）。
        START 已按 toolCallId 回填 map 并 return；若 END/RESULT 仍 ``author_upsert_row``，
        会把上百条旧工具以「最新墙钟」刷进 online delta（现场 8e4715ba：
        11:10:05 发问 → 192 条 rowId<2500 的 upsert 堵到 11:10:30 才出本轮 reasoning）。

        cancelled/error 仍放行：迟到 RESULT / seal 后回填要写正文。
        """
        if not isinstance(existing, dict):
            return False
        if str(existing.get("status") or "").strip() != "success":
            return False
        # 已有 success：无论同轮重放还是跨轮历史 dump，再 upsert 都是噪声。
        # （跨轮时 _preserve_tool_turn_id 虽保住 turnId，增量洪水照样拖死 tip。）
        return True

    @staticmethod
    def _reasoning_duration_ms(
        existing: dict[str, Any] | None, *, now_ms: int
    ) -> int | None:
        if not isinstance(existing, dict):
            return None
        try:
            started = int(existing.get("startedAt") or existing.get("createdAt") or 0)
        except (TypeError, ValueError):
            return None
        if started <= 0:
            return None
        return max(0, int(now_ms) - started)

    def _fail_open_turn_header(
        self, tid: str, st: _MirrorState, *, now_ms: int, reason: str
    ) -> None:
        """上一轮未收到 FINISHED 就被新 RUN 顶掉时，先把旧 turnHeader 收成 failed。"""
        header_rid = int(st.turn_header_row_id or 0)
        turn_id = str(st.turn_id or "").strip()
        if header_rid <= 0 or not turn_id:
            return
        header_origin = "userInput"
        sess = self._hub.get_session(tid)
        existing = sess.rows.get(header_rid) if sess is not None else None
        if isinstance(existing, dict):
            prev_origin = str(existing.get("origin") or "").strip()
            if prev_origin:
                header_origin = prev_origin
        self._hub.author_upsert_row(
            tid,
            {
                "rowId": header_rid,
                "turnId": turn_id,
                "entityId": turn_id,
                "kind": "turnHeader",
                "origin": header_origin,
                "state": "failed",
                "startedAt": st.turn_started_at_ms or now_ms,
                "endedAt": now_ms,
                "createdAt": st.turn_started_at_ms or now_ms,
                "createdAtSeq": self._seq_now(tid),
                "error": {
                    "code": "superseded_by_new_run",
                    "message": reason[:500],
                },
            },
        )

    def _lookup_turn_header(
        self, tid: str, turn_id: str
    ) -> tuple[int, int, str]:
        """Return (header_row_id, started_at_ms, origin) for a product turn."""
        want = str(turn_id or "").strip()
        if not want:
            return 0, 0, "userInput"
        sess = self._hub.get_session(tid)
        if sess is None:
            return 0, 0, "userInput"
        best: dict[str, Any] | None = None
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            if str(row.get("kind") or "") != "turnHeader":
                continue
            if str(row.get("turnId") or "").strip() != want:
                continue
            if best is None or int(row.get("rowId") or 0) >= int(best.get("rowId") or 0):
                best = row
        if best is None:
            return 0, 0, "userInput"
        origin = str(best.get("origin") or "").strip() or "userInput"
        return (
            int(best.get("rowId") or 0),
            int(best.get("startedAt") or 0),
            origin,
        )

    def _latest_product_turn_id(self, tid: str) -> str:
        """Hub 投影里最近一条 turnHeader 的 turnId（mirror_reset 后 last_turn_id 会丢）。"""
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return ""
        best: dict[str, Any] | None = None
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            if str(row.get("kind") or "") != "turnHeader":
                continue
            if best is None or int(row.get("rowId") or 0) >= int(best.get("rowId") or 0):
                best = row
        if best is None:
            return ""
        return str(best.get("turnId") or "").strip()

    def _reuse_product_turn(
        self,
        tid: str,
        st: _MirrorState,
        *,
        turn_id: str,
        header_rid: int,
        started_at: int,
        header_origin: str,
        next_run_id: str,
        now_ms: int,
        reason: str = "RUN_STARTED continuation without userInput",
        clear_stream_maps: bool = True,
    ) -> None:
        """无新用户输入的内部续跑：挂回上一 product turn，避免左栏 AI 回复被劈成两截。"""
        logger.warning(
            "[v4-mirror] %s; reuse turn thread=%s turn=%s next_run=%s",
            reason,
            tid,
            turn_id,
            next_run_id,
        )
        if clear_stream_maps:
            # 先封未收口工具再清 map——否则 search_code_index 等慢工具会永久
            # inputStreaming（「等待中」），而 RESULT 若再被 SSE 丢掉就再也收不了口。
            self._seal_open_tool_calls(tid, st, now_ms=now_ms, status="cancelled")
            self._clear_stream_row_maps(st)
        st.run_started = True
        st.turn_id = turn_id
        st.last_turn_id = turn_id
        st.turn_header_row_id = header_rid
        st.turn_started_at_ms = started_at or now_ms
        # 续跑挂回上一 product turn：last_text_row_id / last_turn_success 必须保留——
        # usage CUSTOM 与 RUN_FINISHED 同批但后到（agui_stream_normalizer 先 seal 再 append），
        # 若在此清掉，迟到 usage 的兜底盖章门控 ``not run_started and last_turn_success``
        # 永远不成立 → 轮尾正文行丢用量（test_next_turn_resets_usage_context 回归）。
        # 串轮风险由 _stamp_turn_usage 的 turnId 守卫挡住。
        st.turn_usage = None
        st.usage_bumped = False
        origin = str(header_origin or "").strip() or "userInput"
        self._hub.author_upsert_row(
            tid,
            {
                "rowId": header_rid,
                "turnId": turn_id,
                "entityId": turn_id,
                "kind": "turnHeader",
                "origin": origin,
                "state": "running",
                "startedAt": started_at or now_ms,
                "createdAt": started_at or now_ms,
                "createdAtSeq": self._seq_now(tid),
            },
        )
        self._patch_control(
            tid,
            _running_control(now_ms=now_ms, last_error=st.sticky_run_error),
        )

    def _ensure_active_turn_for_stream(
        self, tid: str, st: _MirrorState, *, now_ms: int, via: str
    ) -> bool:
        """保证流式正文/工具有可挂的 product turn。

        工具循环中间的 RUN_FINISHED 会 ``_reset_turn_ephemeral`` 清掉 ``turn_id``；
        若随后 TEXT_*/TOOL_* 仍按空 turnId 落行，助手气泡会成孤儿——用户轮只剩
        turnHeader(completedSuccess)+userInput，浮层/页面都看不到 AI 回复。
        """
        if st.run_started and str(st.turn_id or "").strip() and int(st.turn_header_row_id or 0) > 0:
            return True
        cont_tid = str(st.last_turn_id or "").strip() or self._latest_product_turn_id(tid)
        if not cont_tid:
            return False
        cont_rid, cont_started, cont_origin = self._lookup_turn_header(tid, cont_tid)
        if cont_rid <= 0:
            return False
        self._reuse_product_turn(
            tid,
            st,
            turn_id=cont_tid,
            header_rid=cont_rid,
            started_at=cont_started,
            header_origin=cont_origin,
            next_run_id=f"late-stream:{via}",
            now_ms=now_ms,
            reason=f"late {via} after turn sealed",
            # 迟到 START 时 map 本就空；勿清掉同帧已写入的 mid（防御性）。
            clear_stream_maps=False,
        )
        return bool(str(st.turn_id or "").strip())

    def _find_reusable_user_input_row(
        self,
        tid: str,
        *,
        user_mid: str,
        user_text: str,
        prev_turn_id: str,
    ) -> dict[str, Any] | None:
        """空流自动重试会再 note + RUN_STARTED；复用已落盘的同 message_id / 同轮 userInput。"""
        sess = self._hub.get_session(tid)
        if sess is None or not sess.rows:
            return None
        rows = sorted(
            (r for r in sess.rows.values() if isinstance(r, dict)),
            key=lambda r: int(r.get("rowId") or 0),
            reverse=True,
        )
        mid = str(user_mid or "").strip()
        text = str(user_text or "").strip()
        prev = str(prev_turn_id or "").strip()
        if mid:
            for row in rows:
                if str(row.get("kind") or "") != "userInput":
                    continue
                if str(row.get("origin") or "") != "realUser":
                    continue
                if str(row.get("entityId") or "").strip() == mid:
                    return row
        if prev and text:
            for row in rows:
                if str(row.get("kind") or "") != "userInput":
                    continue
                if str(row.get("origin") or "") != "realUser":
                    continue
                if str(row.get("turnId") or "").strip() != prev:
                    continue
                if str(row.get("text") or "").strip() == text:
                    return row
        return None

    def _feed_one(self, tid: str, st: _MirrorState, ev: dict[str, Any]) -> None:
        et = str(ev.get("type") or "").strip()
        now_ms = _now_ms()

        if et == "RUN_STARTED":
            _diag_log(
                "run_started",
                tid=tid[:24],
                run_id=str(ev.get("runId") or "")[:40],
                user_text_len=len(str(st.user_text or "")),
                user_atts=len(st.user_attachments or []),
                prev_run_started=st.run_started,
            )
            new_turn_id = (
                str(ev.get("runId") or ev.get("threadId") or "").strip() or f"run-{now_ms}"
            )
            prior_reset = False
            prev_turn_id = ""
            prev_header_rid = 0
            prev_started_at = 0
            pending_user = bool(str(st.user_text or "").strip() or st.user_attachments)
            if st.run_started:
                # 同 runId 重复 START：去重。不同 runId：上一轮 FINISHED 漏清闩锁。
                if new_turn_id == st.turn_id:
                    return
                prior_reset = True
                prev_turn_id = str(st.turn_id or "").strip()
                prev_header_rid = int(st.turn_header_row_id or 0)
                prev_started_at = int(st.turn_started_at_ms or 0)
                logger.warning(
                    "[v4-mirror] RUN_STARTED while prior turn open; reset thread=%s prev=%s next=%s",
                    tid,
                    prev_turn_id,
                    new_turn_id,
                )
                # 先封未收口工具/流式正文/思考——否则行永久 running/streaming。
                self._seal_open_tool_calls(tid, st, now_ms=now_ms, status="cancelled")
                self._mark_assistant_text_interrupted(tid, st, now_ms=now_ms)
                self._seal_streaming_reasoning(tid, st, now_ms=now_ms, state="interrupted")

                prev_had_text = int(st.last_text_row_id or 0) > 0
                if prev_turn_id and prev_header_rid > 0 and not pending_user and not prev_had_text:
                    # 无新用户输入、且上一轮**尚无正文**的「假新轮」（空流重试等）：
                    # 续挂上一 product turn。已有正文的轮被新 runId 顶掉 = 真·新一轮
                    # （RUN_FINISHED 漏发），必须开新 turn——否则迟到 usage 会串盖到
                    # 上一轮轮尾行（test_next_turn_resets_usage_context）。
                    _, _, prev_origin = self._lookup_turn_header(tid, prev_turn_id)
                    self._reuse_product_turn(
                        tid,
                        st,
                        turn_id=prev_turn_id,
                        header_rid=prev_header_rid,
                        started_at=prev_started_at,
                        header_origin=prev_origin,
                        next_run_id=new_turn_id,
                        now_ms=now_ms,
                    )
                    return

                # 有新用户输入：旧头收成 failed，再开真正的新轮。
                self._fail_open_turn_header(
                    tid,
                    st,
                    now_ms=now_ms,
                    reason=f"superseded by {new_turn_id}",
                )
                self._reset_turn_ephemeral(st)

            # FINISHED 已清闩锁 / mirror_reset 后的内部续跑：没有 note_user_input →
            # 仍挂回上一轮。否则右栏会出现 goalContinuation 假新轮，左栏 AI 回复劈成两截
            # （浮层 #N userInput + #N+1 无气泡，正是用户贴的那种）。
            # 例外：上一轮**成功收尾且已有正文**时又来不同 runId 的 START —— 这是真·
            # 新一轮（漏发 RUN_FINISHED 等），不得续挂旧轮：否则迟到 usage 会串盖到
            # 上一轮轮尾行（test_next_turn_resets_usage_context）。goalContinuation
            # 续跑形态靠同 runId / 空流重试覆盖；工具循环中间 FINISHED 后正文尚未封口
            # （last_text_row_id==0）的续跑仍走挂回路径（test_finished_then_run…）。
            cont_success_with_text = st.last_turn_success and int(st.last_text_row_id or 0) > 0
            if not pending_user and not (prior_reset and cont_success_with_text):
                cont_tid = str(st.last_turn_id or "").strip() or self._latest_product_turn_id(
                    tid
                )
                if cont_tid:
                    cont_rid, cont_started, cont_origin = self._lookup_turn_header(
                        tid, cont_tid
                    )
                    if cont_rid > 0:
                        self._reuse_product_turn(
                            tid,
                            st,
                            turn_id=cont_tid,
                            header_rid=cont_rid,
                            started_at=cont_started,
                            header_origin=cont_origin,
                            next_run_id=new_turn_id,
                            now_ms=now_ms,
                        )
                        return

            user_text = st.user_text
            user_atts = list(st.user_attachments or [])
            user_mid = str(st.user_message_id or "").strip()
            user_origin = st.user_origin
            user_epilogue = int(st.user_epilogue_start or 0)
            st.user_text = ""
            st.user_attachments = []
            st.user_message_id = ""
            st.user_origin = "realUser"
            st.user_epilogue_start = 0
            has_visible_user = bool(user_text or user_atts) and not (
                not user_atts
                and (
                    (
                        user_text
                        and (
                            _is_hidden_tool_approval_user_text(user_text)
                            or _is_hidden_duty_brief_user_text(user_text)
                            or _is_hidden_task_notification_user_text(user_text)
                            or _is_hidden_context_compaction_user_text(user_text)
                        )
                    )
                    or _is_hidden_task_notification_message_id(user_mid)
                )
            )
            # 无可见 userInput 时不要谎称 origin=userInput（否则浮层右栏有头无气泡、左栏像劈开的回复）。
            header_origin = "userInput" if has_visible_user else "goalContinuation"

            reusable = (
                self._find_reusable_user_input_row(
                    tid,
                    user_mid=user_mid,
                    user_text=user_text,
                    prev_turn_id=prev_turn_id if prior_reset else "",
                )
                if has_visible_user
                else None
            )
            # ensure_transcript 已落 provisional turnHeader(running)+userInput：复用该头，
            # 勿再 append 新头（否则 user.rowId < header.rowId，尾窗对齐会裁掉用户气泡）。
            if reusable is not None:
                old_turn = str(reusable.get("turnId") or "").strip()
                old_hdr_rid, old_started, old_origin = (
                    self._lookup_turn_header(tid, old_turn) if old_turn else (0, 0, "")
                )
                sess = self._hub.get_session(tid)
                old_hdr = (
                    sess.rows.get(int(old_hdr_rid))
                    if sess is not None and old_hdr_rid > 0
                    else None
                )
                old_hdr_state = (
                    str(old_hdr.get("state") or "").strip()
                    if isinstance(old_hdr, dict)
                    else ""
                )
                user_rid = int(reusable.get("rowId") or 0)
                if (
                    old_hdr_rid > 0
                    and user_rid > old_hdr_rid
                    and old_hdr_state == "running"
                    and (
                        old_turn.startswith("transcript-")
                        or old_origin in ("", "userInput")
                    )
                ):
                    st.run_started = True
                    st.turn_id = new_turn_id
                    st.last_turn_id = new_turn_id
                    st.turn_started_at_ms = int(old_started or now_ms)
                    st.turn_file_changes = {}
                    st.turn_usage = None
                    st.last_text_row_id = 0
                    st.last_turn_success = False
                    st.usage_bumped = False
                    st.turn_header_row_id = old_hdr_rid
                    self._hub.author_upsert_row(
                        tid,
                        {
                            "rowId": old_hdr_rid,
                            "turnId": new_turn_id,
                            "entityId": new_turn_id,
                            "kind": "turnHeader",
                            "origin": header_origin,
                            "state": "running",
                            "startedAt": int(old_started or now_ms),
                            "createdAt": int(old_started or now_ms),
                            "createdAtSeq": self._seq_now(tid),
                        },
                    )
                    reused = dict(reusable)
                    reused["turnId"] = new_turn_id
                    reused["createdAtSeq"] = self._seq_now(tid)
                    if user_mid:
                        reused["entityId"] = user_mid
                    if user_atts:
                        reused["attachments"] = user_atts
                    self._hub.author_upsert_row(tid, reused)
                    self._patch_control(
                        tid,
                        _running_control(now_ms=now_ms, last_error=st.sticky_run_error),
                    )
                    return

            st.run_started = True
            st.turn_id = new_turn_id
            st.last_turn_id = new_turn_id
            st.turn_started_at_ms = now_ms
            st.turn_file_changes = {}
            # 新一轮：上一轮的 usage 盖章上下文作废（上一轮若已盖完就定格在原行）。
            st.turn_usage = None
            st.last_text_row_id = 0
            st.last_turn_success = False
            st.usage_bumped = False
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
                    "origin": header_origin,
                    "state": "running",
                    "startedAt": now_ms,
                    "createdAt": now_ms,
                    "createdAtSeq": self._seq_now(tid),
                },
            )
            if has_visible_user:
                if reusable is not None:
                    # 空流 auto-retry / remint：同一条用户消息只保留一颗气泡，挂到新 turn。
                    old_user_turn = str(reusable.get("turnId") or "").strip()
                    reused = dict(reusable)
                    reused["turnId"] = st.turn_id
                    reused["createdAtSeq"] = self._seq_now(tid)
                    if user_mid:
                        reused["entityId"] = user_mid
                    if user_atts:
                        reused["attachments"] = user_atts
                    elif "attachments" in reused and not user_atts:
                        # 保留原附件；重试 body 常再次带上同一批
                        pass
                    self._hub.author_upsert_row(tid, reused)
                    # 旧头仍自称 userInput 但气泡已走 → 降成 goalContinuation，消 !NO_USER。
                    if old_user_turn and old_user_turn != str(st.turn_id or "").strip():
                        self._demote_orphan_user_input_header(
                            tid, old_user_turn, now_ms=now_ms
                        )
                else:
                    user_row: dict[str, Any] = {
                        "rowId": self._next_row_id(tid),
                        "turnId": st.turn_id,
                        "kind": "userInput",
                        "text": user_text or "",
                        "origin": user_origin,
                        "createdAt": now_ms,
                        "createdAtSeq": self._seq_now(tid),
                        "actions": {"canEdit": True},
                    }
                    if user_epilogue and 0 < user_epilogue <= len(user_row["text"]):
                        user_row["epilogueStart"] = user_epilogue
                    if user_mid:
                        user_row["entityId"] = user_mid
                    if user_atts:
                        user_row["attachments"] = user_atts
                    self._hub.author_append_row(tid, user_row)
            # 空流 auto-retry 再开 RUN 时保留 sticky lastError，横幅别被清掉。
            self._patch_control(
                tid,
                _running_control(now_ms=now_ms, last_error=st.sticky_run_error),
            )
            return

        if et == "ACTIVITY_SNAPSHOT":
            self._on_activity_snapshot(tid, st, ev, now_ms=now_ms)
            return

        if et == "TEXT_MESSAGE_START":
            mid = str(ev.get("messageId") or "").strip()
            if not mid or mid in st.text_row_ids:
                return
            if not self._ensure_active_turn_for_stream(
                tid, st, now_ms=now_ms, via="TEXT_MESSAGE_START"
            ):
                _diag_log(
                    "text_start_dropped",
                    tid=tid[:24],
                    mid=mid[:24],
                    run_started=st.run_started,
                    turn_id=str(st.turn_id or "")[:20],
                    last_turn_id=str(st.last_turn_id or "")[:20],
                )
                return
            self._clear_empty_run_notices(tid, st)
            # Successful model output starting → clear retry banner + sticky error.
            st.sticky_run_error = None
            self._clear_api_retry(tid, st, now_ms=now_ms)
            rid = self._next_row_id(tid)
            st.text_row_ids[mid] = rid
            st.text_acc[mid] = ""
            # 轮尾正文行记账：usage 盖章目标（同轮多次模型调用时自然是最后一条）。
            st.last_text_row_id = rid
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
            sess = self._hub.get_session(tid)
            existing = sess.rows.get(int(rid)) if sess is not None else None
            # 保留 START 时的 createdAt（每段正文独立时钟）；END 只收 state/text。
            created_at = (
                int(existing.get("createdAt") or 0)
                if isinstance(existing, dict)
                else 0
            ) or now_ms
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": rid,
                    "turnId": str(st.turn_id or st.last_turn_id or "").strip(),
                    "kind": "assistantText",
                    "state": "complete",
                    "text": st.text_acc.get(mid, ""),
                    "createdAt": created_at,
                    "createdAtSeq": self._seq_now(tid),
                    "assistantResponseId": mid,
                },
            )
            return

        if et == "REASONING_MESSAGE_START":
            mid = str(ev.get("messageId") or "").strip()
            if not mid:
                return
            if mid in st.reasoning_row_ids:
                # 同 messageId 仍在 streaming → 忽略重复 START。
                # 若上一张已 complete（工具轮后再开思考 / 复用 block id），必须新开行，
                # 否则内容会继续灌进轮头那张卡，中间工具区看不到思考。
                try:
                    prev_rid = int(st.reasoning_row_ids[mid])
                except (TypeError, ValueError):
                    prev_rid = 0
                sess = self._hub.get_session(tid)
                prev_row = (
                    sess.rows.get(prev_rid)
                    if sess is not None and prev_rid > 0
                    else None
                )
                prev_state = (
                    str(prev_row.get("state") or "").strip()
                    if isinstance(prev_row, dict)
                    else ""
                )
                if prev_state == "streaming":
                    return
                st.reasoning_row_ids.pop(mid, None)
                st.reasoning_acc.pop(mid, None)
            if not self._ensure_active_turn_for_stream(
                tid, st, now_ms=now_ms, via="REASONING_MESSAGE_START"
            ):
                return
            self._clear_empty_run_notices(tid, st)
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
                    "startedAt": now_ms,
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
            sess = self._hub.get_session(tid)
            existing = (
                sess.rows.get(int(rid))
                if sess is not None and isinstance(sess.rows.get(int(rid)), dict)
                else None
            )
            created_at, started_at = self._preserve_tool_timestamps(existing, now_ms=now_ms)
            duration_ms = self._reasoning_duration_ms(existing, now_ms=now_ms)
            row_out: dict[str, Any] = {
                "rowId": rid,
                "turnId": str(st.turn_id or st.last_turn_id or "").strip(),
                "kind": "reasoning",
                "state": "complete",
                "text": st.reasoning_acc.get(mid, ""),
                "createdAt": created_at,
                "createdAtSeq": self._seq_now(tid),
                "assistantResponseId": mid,
                "startedAt": started_at,
                "endedAt": now_ms,
            }
            if duration_ms is not None:
                row_out["durationMs"] = duration_ms
            self._hub.author_upsert_row(tid, row_out)
            return

        if et == "TOOL_CALL_START":
            tcid = str(ev.get("toolCallId") or "").strip()
            name = str(ev.get("toolCallName") or ev.get("name") or "tool").strip() or "tool"
            if not tcid or tcid in st.tool_row_ids:
                return
            # remint / catchup / 失败轮回放常会重放上一轮的 toolCallId。
            # 若会话里已有该 id 的工具行，只回填 map，禁止再开一张空红卡
            # （现场：短问失败轮挂出上一轮同 id 的 error 工具）。
            found_rid, found_row = self._lookup_tool_row(tid, tcid)
            if found_rid is not None and found_row is not None:
                st.tool_row_ids[tcid] = int(found_rid)
                if name and name != "tool":
                    st.tool_names[tcid] = name
                elif tcid not in st.tool_names:
                    prev_name = str(found_row.get("toolName") or "").strip()
                    if prev_name:
                        st.tool_names[tcid] = prev_name
                if tcid not in st.tool_acc:
                    st.tool_acc[tcid] = str(found_row.get("inputText") or "")
                return
            if not self._ensure_active_turn_for_stream(
                tid, st, now_ms=now_ms, via="TOOL_CALL_START"
            ):
                return
            self._clear_empty_run_notices(tid, st)
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
            rid, existing = self._resolve_tool_row_id(tid, st, tcid)
            if rid is None or not delta:
                return
            if self._should_skip_replayed_success_tool(existing, st):
                return
            st.tool_acc[tcid] = st.tool_acc.get(tcid, "") + delta
            self._hub.author_row_delta(tid, rid, "inputText", delta)
            return

        if et == "TOOL_CALL_END":
            tcid = str(ev.get("toolCallId") or "").strip()
            rid, existing = self._resolve_tool_row_id(tid, st, tcid)
            if rid is None:
                return
            if self._should_skip_replayed_success_tool(existing, st):
                return
            created_at, started_at = self._preserve_tool_timestamps(existing, now_ms=now_ms)
            input_text = st.tool_acc.get(tcid, "") or (
                str(existing.get("inputText") or "") if isinstance(existing, dict) else ""
            )
            row_out: dict[str, Any] = {
                "rowId": rid,
                "turnId": self._preserve_tool_turn_id(existing, st),
                "kind": "toolCall",
                "toolCallId": tcid,
                "toolName": self._tool_name(st, tcid, ev),
                "status": "running",
                "inputText": input_text,
                "createdAt": created_at,
                "createdAtSeq": self._seq_now(tid),
                "startedAt": started_at,
            }
            # TranscriptMiddleware 在工具返回前就落库；SSE RESULT 常丢。
            # END 时若库里已有正文，直接升 success，避免卡永久「等待中/执行中」。
            self._apply_transcript_backfill_to_tool_row(
                tid, st, tcid=tcid, row_out=row_out
            )
            if row_out.get("status") == "success":
                row_out["endedAt"] = now_ms
            self._hub.author_upsert_row(tid, row_out)
            return

        if et == "TOOL_CALL_RESULT":
            tcid = str(ev.get("toolCallId") or "").strip()
            rid, existing = self._resolve_tool_row_id(tid, st, tcid)
            if rid is None:
                # map 已清且会话里也没有该 toolCallId：无法挂载，丢弃。
                return
            if self._should_skip_replayed_success_tool(existing, st):
                return
            # 轮已 seal 时把 product turn 拉回，避免 RESULT 写到空 turnId。
            if not str(st.turn_id or "").strip():
                self._ensure_active_turn_for_stream(
                    tid, st, now_ms=now_ms, via="TOOL_CALL_RESULT"
                )
            content = str(ev.get("content") or "")
            tool_name = self._tool_name(st, tcid, ev)
            # SSE slim 对 lazy 工具会把 content 置空（旧面板靠 /tool-results 弹窗）。
            # V4 卡内联展开且未接 onLoadFullToolCallFields → 空 content 会写成
            # success + 空 output（「已执行 / 暂无检索结果」），尽管 transcript 已有全文。
            if not content.strip():
                backfill = _transcript_tool_result_text(tid, tcid)
                if backfill is not None:
                    bf_name, bf_body = backfill
                    content = bf_body
                    if bf_name and bf_name != "tool" and (
                        not tool_name or tool_name == "tool"
                    ):
                        tool_name = bf_name
                        st.tool_names[tcid] = bf_name
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
            # 行内 output.text 只留预览（对齐旧链路 _UI_TOOL_OUTPUT_MAX=12000）：
            # 视频生成等工具结果曾单条 10MB 进投影行，快照字节预算被压到 20 行
            # （「前面轮次/最新用户消息看不到」实锤），也是 WebView2 OOM 主因。
            # 全文不丢——工具卡展开走 /tool-results 按需拉取。
            tool_output: dict[str, Any] = {"text": _preview_tool_output_text(content)}
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
            created_at, started_at = self._preserve_tool_timestamps(existing, now_ms=now_ms)
            input_text = st.tool_acc.get(tcid, "") or (
                str(existing.get("inputText") or "") if isinstance(existing, dict) else ""
            )
            turn_id = self._preserve_tool_turn_id(existing, st)
            result_row: dict[str, Any] = {
                "rowId": rid,
                "turnId": turn_id,
                "kind": "toolCall",
                "toolCallId": tcid,
                "toolName": tool_name,
                "status": v4_status,
                "inputText": input_text,
                "createdAt": created_at,
                "createdAtSeq": self._seq_now(tid),
                "startedAt": started_at,
                "endedAt": now_ms,
                "output": tool_output,
            }
            if v4_status == "error":
                result_row["error"] = {"code": "tool_error", "message": content[:2000]}
            self._hub.author_upsert_row(tid, result_row)
            # platform workflow.run 族 → workflowRuns 投影（对齐 ZCode digest / join）
            if tool_name_l.lower() == "platform" and v4_status == "success":
                try:
                    action = ""
                    args_text = st.tool_acc.get(tcid, "") or ""
                    if '"action"' in args_text:
                        import re as _re

                        m = _re.search(r'"action"\s*:\s*"([^"]+)"', args_text)
                        if m:
                            action = m.group(1).strip()
                    if not action and content.lstrip().startswith("{"):
                        try:
                            blob = json.loads(content)
                            if isinstance(blob, dict):
                                action = str(blob.get("action") or "").strip()
                        except (TypeError, ValueError):
                            pass
                    display_block = (
                        tool_output.get("display")
                        if isinstance(tool_output.get("display"), dict)
                        else None
                    )
                    self._hub.upsert_workflow_run_from_platform(
                        tid,
                        tool_call_id=tcid,
                        action=action,
                        content=content,
                        display=display_block,
                    )
                except Exception:
                    logger.debug(
                        "workflowRuns upsert from platform failed session=%s tcid=%s",
                        tid,
                        tcid,
                        exc_info=True,
                    )
            return

        if et in ("RUN_FINISHED", "RUN_ERROR"):
            if not st.run_started or st.turn_header_row_id == 0:
                return
            user_stopped = et == "RUN_ERROR" and _is_user_interrupt_event(ev)
            # 排队续发 / send_prep 误杀：RUN_FINISHED 已落成成功后迟到的 USER_INTERRUPT
            # 不得把 turnHeader 从 completedSuccess 降成「用户停止」。
            if user_stopped:
                sess = self._hub.get_session(tid)
                existing = (
                    sess.rows.get(int(st.turn_header_row_id))
                    if sess is not None and st.turn_header_row_id
                    else None
                )
                if (
                    isinstance(existing, dict)
                    and str(existing.get("state") or "") == "completedSuccess"
                ):
                    return
            # 工具授权闸：上游常在 pending_approval 后仍发 RUN_FINISHED（interrupt 当结束）。
            # 若此时把轮次封成 completedSuccess，页面像「自己停了」，授权卡也难点。
            # 软暂停：保留 running + pendingApproval，等用户批/拒后再真正收尾。
            if (
                et == "RUN_FINISHED"
                and not user_stopped
                and self._turn_has_pending_approval_tools(tid, st)
            ):
                from app.gateway.v4.conversation import _PHASE_RUNNING, _minimal_control

                self._seal_streaming_assistant_text(tid, st, now_ms=now_ms, state="complete")
                self._seal_streaming_reasoning(tid, st, now_ms=now_ms, state="complete")
                self._seal_open_tool_calls(
                    tid,
                    st,
                    now_ms=now_ms,
                    status="cancelled",
                    preserve_pending_approval=True,
                )
                sess_for_origin = self._hub.get_session(tid)
                existing_header = (
                    sess_for_origin.rows.get(int(st.turn_header_row_id))
                    if sess_for_origin is not None and st.turn_header_row_id
                    else None
                )
                header_origin = "userInput"
                if isinstance(existing_header, dict):
                    prev_origin = str(existing_header.get("origin") or "").strip()
                    if prev_origin:
                        header_origin = prev_origin
                self._hub.author_upsert_row(
                    tid,
                    {
                        "rowId": st.turn_header_row_id,
                        "turnId": st.turn_id,
                        "entityId": st.turn_id,
                        "kind": "turnHeader",
                        "origin": header_origin,
                        "state": "running",
                        "startedAt": st.turn_started_at_ms or now_ms,
                        "createdAt": st.turn_started_at_ms or now_ms,
                        "createdAtSeq": self._seq_now(tid),
                    },
                )
                ctrl = _minimal_control(
                    _PHASE_RUNNING, run_started_at=st.turn_started_at_ms or now_ms
                )
                ctrl["lastError"] = None
                ctrl["apiRetry"] = None
                self._patch_control(tid, ctrl)
                logger.info(
                    "[v4-mirror] soft-pause for pendingApproval thread=%s turn=%s",
                    tid,
                    st.turn_id,
                )
                # 不清 ephemeral：批准续跑仍挂同一 turn；真 FINISHED / 停止再 reset。
                return
            if et == "RUN_FINISHED":
                v4_state = "completedSuccess"
            elif user_stopped:
                # 用户点停止：轮次 interrupted，不是 failed；UI 显示「用户停止/已停止」。
                v4_state = "completedInterrupted"
            else:
                v4_state = "failed"
            # 轮尾文件变更摘要（ZCode「N 个文件已更改 +A/-D」卡片 = turnHeader.fileChanges）。
            file_changes: dict[str, Any] | None = None
            if st.turn_file_changes:
                file_changes = {
                    "additions": sum(v["additions"] for v in st.turn_file_changes.values()),
                    "deletions": sum(v["deletions"] for v in st.turn_file_changes.values()),
                    "files": len(st.turn_file_changes),
                }
            turn_finished_at = now_ms
            sess_for_origin = self._hub.get_session(tid)
            existing_header = (
                sess_for_origin.rows.get(int(st.turn_header_row_id))
                if sess_for_origin is not None and st.turn_header_row_id
                else None
            )
            # 以窗内真实用户行为准：勿沿用已被挂走气泡的旧 origin=userInput。
            header_origin = (
                "userInput"
                if self._turn_has_visible_user_input(tid, str(st.turn_id or ""))
                else "goalContinuation"
            )
            if isinstance(existing_header, dict):
                prev_origin = str(existing_header.get("origin") or "").strip()
                # 仅允许从 userInput 降到 goalContinuation，不把 continuation 抬回 userInput。
                if prev_origin == "goalContinuation":
                    header_origin = "goalContinuation"
                elif prev_origin and prev_origin not in ("userInput", "goalContinuation"):
                    header_origin = prev_origin
            self._hub.author_upsert_row(
                tid,
                {
                    "rowId": st.turn_header_row_id,
                    "turnId": st.turn_id,
                    "entityId": st.turn_id,
                    "kind": "turnHeader",
                    "origin": header_origin,
                    "state": v4_state,
                    "startedAt": st.turn_started_at_ms or now_ms,
                    "endedAt": turn_finished_at,
                    "createdAt": st.turn_started_at_ms or now_ms,
                    "createdAtSeq": self._seq_now(tid),
                    **({"fileChanges": file_changes} if file_changes else {}),
                },
            )
            produced_text = any(str(t or "").strip() for t in st.text_acc.values())
            has_assistant_work = produced_text or self._turn_has_assistant_work(
                tid, str(st.turn_id or "")
            )
            if et == "RUN_ERROR":
                if user_stopped:
                    # 停止 ≠ 报错：清 sticky / lastError，勿写「详情（可复制反馈）」气泡。
                    last_error = None
                    st.sticky_run_error = None
                    self._mark_assistant_text_interrupted(tid, st, now_ms=now_ms)
                    self._seal_streaming_reasoning(tid, st, now_ms=now_ms, state="interrupted")
                else:
                    last_error = _run_error_info(ev, now_ms=now_ms)
                    st.sticky_run_error = dict(last_error)
                    # 无正文时把详情落到助手气泡，用户不必翻系统日志也能看见/复制。
                    detail = str(last_error.get("detail") or "").strip()
                    if detail and not has_assistant_work:
                        banner = str(last_error.get("message") or "本轮生成失败").strip()
                        self._upsert_error_assistant_text(
                            tid,
                            st,
                            f"{banner}\n\n详情（可复制反馈）：\n{detail}",
                            now_ms=now_ms,
                        )
            elif has_assistant_work:
                # 真正产出正文/工具的成功收尾 → 清 sticky。
                st.sticky_run_error = None
                last_error = None
            else:
                # 空流 FINISHED（常见于 auto-retry 夹缝）：保留上次 RUN_ERROR，横幅别丢。
                last_error = dict(st.sticky_run_error) if st.sticky_run_error else None
                # 有用户气泡却无任何助手产物：写可见占位，避免 !EMPTY_ASSISTANT 静默成功。
                if et == "RUN_FINISHED" and not user_stopped:
                    self._upsert_empty_run_notice(tid, st, now_ms=now_ms)
            from app.gateway.v4.conversation import _minimal_control

            if user_stopped:
                phase = "completedInterrupted"
            elif et == "RUN_ERROR" or last_error:
                phase = "error"
            else:
                phase = "completedSuccess"
            if et == "RUN_FINISHED" and has_assistant_work:
                phase = "completedSuccess"
            ctrl = _minimal_control(phase)
            # sessionEnded 由 _minimal_control 按终态派生（成功/中断=True；
            # error 可重试=False，对齐 ZCode onTurnError 语义），不再无条件 True。
            ctrl["canStop"] = False
            ctrl["stopState"] = "idle"
            ctrl["activeWorks"] = []
            ctrl["lastError"] = last_error
            ctrl["apiRetry"] = None
            self._patch_control(tid, ctrl)
            # 先封未收口工具/流式正文，再清 ephemeral——否则迟到 RESULT 丢写，
            # 工具卡永久 running，切回话画布齿轮与侧栏 idle 不一致。
            if user_stopped:
                self._seal_open_tool_calls(tid, st, now_ms=now_ms, status="cancelled")
            elif et == "RUN_ERROR":
                self._seal_open_tool_calls(tid, st, now_ms=now_ms, status="error")
                self._seal_streaming_reasoning(tid, st, now_ms=now_ms, state="interrupted")
            else:
                self._seal_open_tool_calls(tid, st, now_ms=now_ms, status="cancelled")
                self._seal_streaming_assistant_text(tid, st, now_ms=now_ms, state="complete")
                self._seal_streaming_reasoning(tid, st, now_ms=now_ms, state="complete")
            # 轮累计 usage 盖轮尾正文行：必须在 seal 之后（行已 complete，否则被整行替换清掉）。
            # failed / 用户停止轮不盖（V4 动作行只渲染 complete 正文，轮尾也不展示失败用量）。
            st.last_turn_success = et == "RUN_FINISHED"
            if et == "RUN_FINISHED" and has_assistant_work and produced_text:
                self._stamp_turn_usage(tid, st)
            # 会话总计：成功轮的用量并入 sess.usage_state 并发 usage 增量（面板总计条）。
            if et == "RUN_FINISHED":
                self._bump_session_usage_state(tid, st)
            # 重置：允许下一轮 RUN_STARTED 再开 running turnHeader。
            self._reset_turn_ephemeral(st)
            return

        if et == "CUSTOM":
            self._on_custom(tid, st, ev, now_ms=now_ms)
            return

        # 其余事件不投影——ACTIVITY_SNAPSHOT / CUSTOM 已在上方处理。

    def _on_usage_custom(self, tid: str, st: _MirrorState, value: Any) -> None:
        """CUSTOM(name="usage") → 轮累计 token usage 并盖到轮尾正文行。

        事件形态（两种同构）：sse_ui_normalize 的 ``{"type":"usage","usage":六字段}``
        与 _seal_agui_run 的终态包层。早封路径里它跟 RUN_FINISHED 同批但排在其后
        （agui_stream_normalizer 先 seal 再 append usage）——轮已 reset，靠跨轮保留的
        last_text_row_id / last_turn_success 兜住这次迟到盖章；轮进行中只记账不盖章
        （正文行还是 streaming，盖了也会被 TEXT_MESSAGE_END 整行替换清掉）。
        """
        payload = value if isinstance(value, dict) else {}
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else payload
        triplet = {
            key: int(usage.get(key) or 0)
            for key in (
                "input_tokens",
                "output_tokens",
                "total_tokens",
                "cache_read_tokens",
                "cache_creation_tokens",
                "cache_miss_tokens",
            )
        }
        if not any(triplet.values()):
            return
        st.turn_usage = triplet
        if not st.run_started:
            # 轮已 reset 的迟到帧：上一轮成功收尾才补盖（failed 轮不盖）。
            if st.last_turn_success:
                self._stamp_turn_usage(tid, st)
                # 早封路径：RUN_FINISHED 先到（当时 turn_usage 还是 None，没并入过）
                # → 迟到的这份累计就是本轮终值，在此补并入会话总计（usage_bumped 防双计）。
                self._bump_session_usage_state(tid, st)
            return
        # 轮进行中（含续跑挂回后新正文尚未 START 的窗口）：若轮尾行已封口且属于本轮
        # （TEXT_MESSAGE_END 先于 usage 到达），当场补盖——否则后续 RUN_FINISHED /
        # 下一批事件会把 turn_usage 清掉导致用量永久丢失。
        rid = int(st.last_text_row_id or 0)
        sess = self._hub.get_session(tid) if rid > 0 else None
        existing = sess.rows.get(rid) if sess is not None else None
        if (
            isinstance(existing, dict)
            and str(existing.get("kind") or "") == "assistantText"
            and str(existing.get("state") or "") == "complete"
        ):
            self._stamp_turn_usage(tid, st)

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
        if name == "usage":
            self._on_usage_custom(tid, st, value)
            return
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
        meta = st.subagent_meta.get(task_id, {})
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
                "subagentType": str(chunk.get("subagent_type") or "").strip()
                or meta.get("subagentType")
                or "general",
                "status": status,
                "summaryText": (summary[:512] if summary else meta.get("description", "")),
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


def mirror_note_user_input(
    thread_id: str,
    text: str,
    *,
    attachments: list[dict[str, Any]] | None = None,
    message_id: str | None = None,
    origin: str = "realUser",
    epilogue_start: int = 0,
) -> None:
    """生产路径入口：记录本轮用户输入文本（及可选附件）。"""
    if _MIRROR_DISABLED:
        return
    _diag_log(
        "note_entry",
        tid=str(thread_id or "")[:24],
        text_len=len(str(text or "")),
        origin=origin,
        message_id=str(message_id or "")[:24],
    )
    try:
        _get_mirror().note_user_input(
            thread_id,
            text,
            attachments=attachments,
            message_id=message_id,
            origin=origin,
            epilogue_start=epilogue_start,
        )
    except Exception as exc:
        logger.exception("[v4-mirror] note_user_input failed thread=%s", thread_id)
        _diag_log("note_error", tid=str(thread_id or "")[:24], error=f"{type(exc).__name__}: {exc}")


def mirror_ensure_transcript_user_input(
    thread_id: str,
    text: str,
    *,
    message_id: str | None = None,
    origin: str = "realUser",
) -> bool:
    """Transcript POST 已落库时，立刻在 V4 投影补一条可见 userInput。

    正常流式会由 ``note_user_input`` + RUN_STARTED 落行；若 POST /runs/stream
    在 RUN_STARTED 前 503（LG unreachable），投影永远没有气泡，前端再清乐观
    行就会「消息消失」。本函数在 append 成功后兜底，按 message_id / 尾部同文
    去重，避免与随后 RUN_STARTED 双写。
    """
    if _MIRROR_DISABLED:
        return False
    tid = str(thread_id or "").strip()
    raw = str(text or "").strip()
    mid = str(message_id or "").strip()
    if not tid or not raw:
        return False
    if _is_hidden_tool_approval_user_text(raw):
        return False
    if _is_hidden_duty_brief_user_text(raw):
        return False
    if _is_hidden_task_notification_user_text(raw) or _is_hidden_task_notification_message_id(mid):
        return False
    if _is_hidden_context_compaction_user_text(raw):
        return False
    try:
        mirror = _get_mirror()
        # Seed pending so a later RUN_STARTED can reuse (message_id) instead of double-append.
        mirror.note_user_input(tid, raw, message_id=mid or None, origin=origin)
        reusable = mirror._find_reusable_user_input_row(  # noqa: SLF001 — same-module helper
            tid,
            user_mid=mid,
            user_text=raw,
            prev_turn_id="",
        )
        if reusable is None:
            # Tail same-text check (prev_turn_id empty skips text match in reusable helper).
            sess = mirror._hub.get_session(tid)  # noqa: SLF001
            if sess is not None and sess.rows:
                for row in sorted(
                    (r for r in sess.rows.values() if isinstance(r, dict)),
                    key=lambda r: int(r.get("rowId") or 0),
                    reverse=True,
                ):
                    if str(row.get("kind") or "") != "userInput":
                        continue
                    if str(row.get("origin") or "") not in ("", "realUser", "goalContinuation"):
                        continue
                    if mid and str(row.get("entityId") or "").strip() == mid:
                        reusable = row
                        break
                    if str(row.get("text") or "").strip() == raw:
                        reusable = row
                        break
                    # Only scan recent tail userInputs.
                    break
        if reusable is not None:
            return False
        now_ms = int(time.time() * 1000)
        user_origin = origin if origin in ("realUser", "goalContinuation") else "realUser"
        # 上一轮仍 running 时用户又发了新问：先封旧头，避免旧轮工具继续 append
        # 把更高 rowId 写到新 provisional 之后 → 跟底只看见旧轮、新问「页面上没有」。
        try:
            sess = mirror._hub.get_session(tid)  # noqa: SLF001
            if sess is not None and sess.rows:
                for row in list(sess.rows.values()):
                    if not isinstance(row, dict):
                        continue
                    if str(row.get("kind") or "") != "turnHeader":
                        continue
                    state = str(row.get("state") or "")
                    if state != "running" and not state.startswith("running"):
                        continue
                    rid = int(row.get("rowId") or 0)
                    if rid <= 0:
                        continue
                    sealed = dict(row)
                    sealed["state"] = "failed"
                    sealed["failedAt"] = now_ms
                    sealed["errorMessage"] = "superseded by newer user input"
                    mirror._hub.author_upsert_row(tid, sealed)  # noqa: SLF001
        except Exception:
            logger.exception(
                "[v4-mirror] seal prior running headers before transcript failed thread=%s",
                tid,
            )
        # 协议序：turnHeader → userInput。只落 user 会导致后续 RUN_STARTED 新头
        # rowId 更大，尾窗对齐到 header 时裁掉紧前气泡（浮层孤用户轮错位）。
        provisional_turn = f"transcript-{now_ms}"
        header_rid = mirror._next_row_id(tid)  # noqa: SLF001
        mirror._hub.author_append_row(  # noqa: SLF001
            tid,
            {
                "rowId": header_rid,
                "turnId": provisional_turn,
                "entityId": provisional_turn,
                "kind": "turnHeader",
                "origin": "userInput",
                "state": "running",
                "startedAt": now_ms,
                "createdAt": now_ms,
                "createdAtSeq": mirror._seq_now(tid),  # noqa: SLF001
            },
        )
        user_row: dict[str, Any] = {
            "rowId": mirror._next_row_id(tid),  # noqa: SLF001
            "turnId": provisional_turn,
            "kind": "userInput",
            "text": raw,
            "origin": user_origin,
            "createdAt": now_ms,
            "createdAtSeq": mirror._seq_now(tid),  # noqa: SLF001
            "actions": {"canEdit": True},
        }
        if mid:
            user_row["entityId"] = mid
        mirror._hub.author_append_row(tid, user_row)  # noqa: SLF001
        _diag_log(
            "ensure_transcript_appended",
            tid=tid[:24],
            header_rid=header_rid,
            user_rid=int(user_row.get("rowId") or 0),
            text_len=len(raw),
        )
        return True
    except Exception as exc:
        logger.exception("[v4-mirror] ensure_transcript_user_input failed thread=%s", tid)
        _diag_log(
            "ensure_transcript_failed",
            tid=tid[:24],
            error=f"{type(exc).__name__}: {exc}",
        )
        return False


def mirror_feed_agui_wire(thread_id: str, frames: list[bytes] | list[str]) -> int:
    """生产路径入口：AG-UI wire 帧批量喂镜像。失败只记日志，绝不抛出。"""
    if _MIRROR_DISABLED or not frames:
        return 0
    try:
        n = _get_mirror().feed_wire(thread_id, frames)
        _diag_log("feed", tid=str(thread_id or "")[:24], frames=len(frames), events=n)
        return n
    except Exception as exc:
        logger.exception("[v4-mirror] feed_wire failed thread=%s", thread_id)
        _diag_log("feed_error", tid=str(thread_id or "")[:24], error=f"{type(exc).__name__}: {exc}")
        return 0


def mirror_feed_agui_events(thread_id: str, events: list[dict[str, Any]]) -> int:
    """v4 直连入口：AG-UI 事件字典直喂镜像（对齐 ZCode，不经 wire 编码/解码）。

    失败只记诊断日志，绝不抛出——与 wire 入口同约定。
    """
    if _MIRROR_DISABLED or not events:
        return 0
    try:
        tid = str(thread_id or "").strip()
        if not tid:
            return 0
        _get_mirror().feed_events(thread_id, events)
        _diag_log(
            "feed_events",
            tid=tid[:24],
            events=len(events),
            kinds=[str(e.get("type") or "") for e in events[:8]],
        )
        return len(events)
    except Exception as exc:
        logger.exception("[v4-mirror] feed_events failed thread=%s", thread_id)
        _diag_log("feed_events_error", tid=str(thread_id or "")[:24], error=f"{type(exc).__name__}: {exc}")
        return 0


def mirror_reset_thread(thread_id: str) -> None:
    """Force-rehydrate / catchup 前清掉 per-thread 镜像状态，避免 rowId 指向已清空投影。"""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        mirror = _get_mirror()
        mirror._states.pop(tid, None)  # noqa: SLF001 — 同模块协作
    except Exception:
        logger.debug("[v4-mirror] reset_thread skipped thread=%s", tid, exc_info=True)


def mirror_thread_is_live(thread_id: str) -> bool:
    """IM/频道本轮仍在往 hub 写（RUN_STARTED 未结算）——catchup 不得 wipe。"""
    tid = str(thread_id or "").strip()
    if not tid or _MIRROR_DISABLED:
        return False
    try:
        st = _get_mirror()._states.get(tid)  # noqa: SLF001
        return bool(st and st.run_started)
    except Exception:
        return False


def _lg_message_type(msg: Any) -> str:
    if not isinstance(msg, dict):
        return ""
    t = str(msg.get("type") or msg.get("role") or "").strip().lower()
    return t


def _lg_tool_calls(msg: dict[str, Any]) -> list[dict[str, Any]]:
    raw = msg.get("tool_calls")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for tc in raw:
        if not isinstance(tc, dict):
            continue
        tcid = str(tc.get("id") or tc.get("tool_call_id") or "").strip()
        if not tcid:
            continue
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
        name = str(tc.get("name") or fn.get("name") or "tool").strip() or "tool"
        args = tc.get("args")
        if args is None and isinstance(tc.get("function"), dict):
            args = tc["function"].get("arguments")
        if isinstance(args, dict):
            try:
                args_s = json.dumps(args, ensure_ascii=False)
            except (TypeError, ValueError):
                args_s = str(args)
        else:
            args_s = str(args or "")
        out.append({"id": tcid, "name": name, "args": args_s})
    return out


def mirror_channel_run_started(thread_id: str, run_id: str) -> None:
    """IM ``runs.stream`` 不开 AG-UI：合成 RUN_STARTED 让面板旁观看到本轮。"""
    if _MIRROR_DISABLED:
        return
    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip() or f"channel-{int(time.time() * 1000)}"
    if not tid:
        return
    try:
        mirror = _get_mirror()
        st = mirror._state(tid)  # noqa: SLF001
        if st.run_started and st.turn_id == rid:
            return
        mirror.feed_events(
            tid,
            [{"type": "RUN_STARTED", "runId": rid, "threadId": tid}],
        )
    except Exception:
        logger.debug("[v4-mirror] channel_run_started skipped thread=%s", tid, exc_info=True)


def mirror_channel_assistant_text(
    thread_id: str,
    text: str,
    *,
    run_id: str | None = None,
    message_id: str | None = None,
    final: bool = False,
) -> None:
    """把 IM 侧累计的 assistant 正文增量喂进 V4（TEXT_MESSAGE_*）。"""
    if _MIRROR_DISABLED:
        return
    tid = str(thread_id or "").strip()
    body = str(text or "")
    if not tid:
        return
    mid = str(message_id or "").strip() or "channel-assistant"
    try:
        if run_id:
            mirror_channel_run_started(tid, str(run_id))
        mirror = _get_mirror()
        st = mirror._state(tid)  # noqa: SLF001
        if not st.run_started:
            mirror_channel_run_started(tid, str(run_id or st.last_turn_id or mid))
            st = mirror._state(tid)  # noqa: SLF001
        events: list[dict[str, Any]] = []
        prev = st.text_acc.get(mid, "")
        if mid not in st.text_row_ids:
            events.append({"type": "TEXT_MESSAGE_START", "messageId": mid, "role": "assistant"})
            prev = ""
        if body.startswith(prev):
            delta = body[len(prev) :]
            if delta:
                events.append(
                    {"type": "TEXT_MESSAGE_CONTENT", "messageId": mid, "delta": delta}
                )
        elif prev.startswith(body):
            # IM 回归短文本：跳过，等追平
            pass
        else:
            # 新段落（工具后换 buffer）：换 messageId
            if mid in st.text_row_ids and prev:
                events.append({"type": "TEXT_MESSAGE_END", "messageId": mid})
            mid2 = f"{mid}-{len(st.text_row_ids) + 1}"
            events.append({"type": "TEXT_MESSAGE_START", "messageId": mid2, "role": "assistant"})
            if body:
                events.append(
                    {"type": "TEXT_MESSAGE_CONTENT", "messageId": mid2, "delta": body}
                )
            mid = mid2
        if final and (mid in st.text_row_ids or any(e.get("messageId") == mid for e in events)):
            events.append({"type": "TEXT_MESSAGE_END", "messageId": mid})
        if events:
            mirror.feed_events(tid, events)
    except Exception:
        logger.debug("[v4-mirror] channel_assistant_text skipped thread=%s", tid, exc_info=True)


def mirror_channel_sync_lg_messages(
    thread_id: str,
    messages: list[Any] | None,
    *,
    run_id: str | None = None,
) -> None:
    """从 LangGraph ``values.messages`` 补工具行（IM 无 AG-UI TOOL_CALL_*）。"""
    if _MIRROR_DISABLED or not messages:
        return
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        if run_id:
            mirror_channel_run_started(tid, str(run_id))
        mirror = _get_mirror()
        st = mirror._state(tid)  # noqa: SLF001
        if not st.run_started:
            return
        events: list[dict[str, Any]] = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            mtype = _lg_message_type(msg)
            if mtype in {"ai", "assistant", "aimessage", "aimessagechunk"}:
                for tc in _lg_tool_calls(msg):
                    tcid = tc["id"]
                    if tcid in st.tool_row_ids:
                        # args 可能后到：若仍空则补 ARGS
                        if not st.tool_acc.get(tcid) and tc["args"]:
                            events.append(
                                {
                                    "type": "TOOL_CALL_ARGS",
                                    "toolCallId": tcid,
                                    "delta": tc["args"],
                                }
                            )
                            events.append({"type": "TOOL_CALL_END", "toolCallId": tcid})
                        continue
                    events.append(
                        {
                            "type": "TOOL_CALL_START",
                            "toolCallId": tcid,
                            "toolCallName": tc["name"],
                        }
                    )
                    if tc["args"]:
                        events.append(
                            {
                                "type": "TOOL_CALL_ARGS",
                                "toolCallId": tcid,
                                "delta": tc["args"],
                            }
                        )
                    events.append({"type": "TOOL_CALL_END", "toolCallId": tcid})
            elif mtype in {"tool", "toolmessage"}:
                tcid = str(
                    msg.get("tool_call_id") or msg.get("toolCallId") or msg.get("id") or ""
                ).strip()
                if not tcid or tcid not in st.tool_row_ids:
                    # 结果先到：先补 START
                    if tcid and tcid not in st.tool_row_ids:
                        name = str(msg.get("name") or "tool").strip() or "tool"
                        events.append(
                            {
                                "type": "TOOL_CALL_START",
                                "toolCallId": tcid,
                                "toolCallName": name,
                            }
                        )
                        events.append({"type": "TOOL_CALL_END", "toolCallId": tcid})
                    else:
                        continue
                content = msg.get("content")
                if isinstance(content, list):
                    try:
                        content_s = json.dumps(content, ensure_ascii=False)
                    except (TypeError, ValueError):
                        content_s = str(content)
                else:
                    content_s = str(content or "")
                events.append(
                    {
                        "type": "TOOL_CALL_RESULT",
                        "toolCallId": tcid,
                        "content": content_s,
                        "status": "success",
                    }
                )
        if events:
            mirror.feed_events(tid, events)
    except Exception:
        logger.debug("[v4-mirror] channel_sync_lg_messages skipped thread=%s", tid, exc_info=True)


def mirror_seal_user_stop(thread_id: str) -> None:
    """用户点停：在掐断 stream proxy 之前立刻封 V4 投影。

    ``stop_session_execution`` 会先 ``unregister_active_stream_proxy``，若只靠
    在途 AG-UI 的 RUN_ERROR 收口，事件常已断流 → 工具卡/思考永久 streaming，
    下一轮糊糊在旧 turn 上（停后再发「显示错乱」）。
    """
    if _MIRROR_DISABLED:
        return
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        mirror = _get_mirror()
        st = mirror._states.get(tid)  # noqa: SLF001
        if not st or not st.run_started:
            return
        mirror.feed_events(
            tid,
            [
                {
                    "type": "RUN_ERROR",
                    "code": "USER_INTERRUPT",
                    "message": "user_interrupt",
                    "threadId": tid,
                }
            ],
        )
    except Exception:
        logger.debug("[v4-mirror] seal_user_stop failed thread=%s", tid, exc_info=True)


def mirror_channel_run_finished(thread_id: str, *, error: bool = False) -> None:
    """IM 流结束：结算 turnHeader。"""
    if _MIRROR_DISABLED:
        return
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        mirror = _get_mirror()
        st = mirror._state(tid)  # noqa: SLF001
        if not st.run_started:
            return
        # 收尾未 END 的正文
        for mid in list(st.text_row_ids.keys()):
            mirror.feed_events(tid, [{"type": "TEXT_MESSAGE_END", "messageId": mid}])
        et = "RUN_ERROR" if error else "RUN_FINISHED"
        mirror.feed_events(tid, [{"type": et}])
    except Exception:
        logger.debug("[v4-mirror] channel_run_finished skipped thread=%s", tid, exc_info=True)


def mirror_heal_orphan_user_input_headers(thread_id: str) -> int:
    """扫描 hub：origin=userInput 却无可见用户气泡的轮头 → goalContinuation。

    供 snapshot / catchup 治愈 warm 会话上已落盘的 !NO_USER 孤儿，不必等下次挂走气泡。
    """
    if _MIRROR_DISABLED:
        return 0
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    try:
        mirror = _get_mirror()
        sess = mirror._hub.get_session(tid)  # noqa: SLF001
        if sess is None or not sess.rows:
            return 0
        turn_ids: list[str] = []
        seen: set[str] = set()
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            if str(row.get("kind") or "") != "turnHeader":
                continue
            if str(row.get("origin") or "").strip() != "userInput":
                continue
            turn_id = str(row.get("turnId") or "").strip()
            if not turn_id or turn_id in seen:
                continue
            seen.add(turn_id)
            turn_ids.append(turn_id)
        if not turn_ids:
            return 0
        now_ms = _now_ms()
        healed = 0
        for turn_id in turn_ids:
            before = mirror._lookup_turn_header(tid, turn_id)[2]  # noqa: SLF001
            mirror._demote_orphan_user_input_header(tid, turn_id, now_ms=now_ms)  # noqa: SLF001
            after = mirror._lookup_turn_header(tid, turn_id)[2]  # noqa: SLF001
            if before == "userInput" and after == "goalContinuation":
                healed += 1
        return healed
    except Exception:
        logger.exception("[v4-mirror] heal_orphan_user_input_headers failed thread=%s", tid)
        return 0


_TERMINAL_HEADER_STATES_HEAL = frozenset(
    {"completedSuccess", "failed", "completedInterrupted", "error"}
)
_OPEN_TOOL_STATUSES_HEAL = frozenset(
    {"", "inputStreaming", "pendingApproval", "running", "in_progress"}
)


def mirror_heal_stale_inflight_rows(thread_id: str) -> int:
    """phase 已 idle 但仍「正在思考/正在执行」：封掉终态轮上的 streaming/running 孤儿。

    现场（f2fdc69c）：control settled + turnHeader=failed，窗内仍 inFlight=3，
    思考卡永远 ``正在思考``。map 已清时 RUN_* seal 扫不到 → 出快照时补封。
    镜像仍活写时不动（避免与 live END/RESULT 打架）。

    DB run_status 已终态时：连仍标 ``running`` 的 tip turnHeader 一并收口
    （压缩后 draft+streaming：无终态头 → 旧逻辑直接 return 0，计时钉死数小时）。
    """
    if _MIRROR_DISABLED:
        return 0
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    try:
        if mirror_thread_is_live(tid):
            return 0
    except Exception:
        pass
    try:
        mirror = _get_mirror()
        sess = mirror._hub.get_session(tid)  # noqa: SLF001
        if sess is None or not sess.rows:
            return 0

        db_phase = ""
        try:
            from app.gateway.v4.conversation import _phase_for_run_status
            from app.gateway.v4.hydration import read_run_status_row

            db_status = str(
                (read_run_status_row(tid) or {}).get("status") or ""
            ).strip().lower()
            db_phase = _phase_for_run_status(db_status)
        except Exception:
            logger.debug(
                "[v4-mirror] heal db status read failed thread=%s", tid, exc_info=True
            )

        header_seal_state = "completedSuccess"
        if db_phase == "error":
            header_seal_state = "failed"
        elif db_phase == "completedInterrupted":
            header_seal_state = "completedInterrupted"

        terminal_turns: set[str] = set()
        for row in sess.rows.values():
            if not isinstance(row, dict) or str(row.get("kind") or "") != "turnHeader":
                continue
            if str(row.get("state") or "").strip() not in _TERMINAL_HEADER_STATES_HEAL:
                continue
            turn_id = str(row.get("turnId") or "").strip()
            if turn_id:
                terminal_turns.add(turn_id)

        now_ms = _now_ms()
        healed = 0

        # DB 已终态：把仍 running 的轮头先封成终态，再扫其下孤儿行。
        if db_phase:
            for row in list(sess.rows.values()):
                if not isinstance(row, dict) or str(row.get("kind") or "") != "turnHeader":
                    continue
                hdr_state = str(row.get("state") or "").strip()
                if hdr_state != "running" and not hdr_state.startswith("running"):
                    continue
                turn_id = str(row.get("turnId") or "").strip()
                try:
                    row_id = int(row.get("rowId") or 0)
                except (TypeError, ValueError):
                    continue
                if row_id <= 0:
                    continue
                started_at = int(row.get("startedAt") or row.get("createdAt") or now_ms)
                active_ms = max(0, now_ms - started_at)
                mirror._hub.author_upsert_row(  # noqa: SLF001
                    tid,
                    {
                        **row,
                        "rowId": row_id,
                        "state": header_seal_state,
                        "endedAt": now_ms,
                        "activeMs": int(row.get("activeMs") or active_ms),
                        "createdAtSeq": mirror._seq_now(tid),  # noqa: SLF001
                    },
                )
                healed += 1
                if turn_id:
                    terminal_turns.add(turn_id)

        # DB 终态：全量扫 inflight（含无 turnHeader 的孤儿 tip）。
        # 仅有终态头、无 DB 证据：仍按 turn 收口（旧路径）。
        seal_all = bool(db_phase)
        if not seal_all and not terminal_turns:
            return healed

        st = mirror._state(tid)  # noqa: SLF001 — get-or-create
        if seal_all:
            # 无头孤儿也要封：any_terminal_turn 会跳过 turnId 不在集合里的行。
            for row in list(sess.rows.values()):
                if not isinstance(row, dict):
                    continue
                if str(row.get("kind") or "") != "reasoning":
                    continue
                if str(row.get("state") or "").strip() != "streaming":
                    continue
                try:
                    row_id = int(row.get("rowId") or 0)
                except (TypeError, ValueError):
                    continue
                if row_id <= 0:
                    continue
                created_at, started_at = V4Mirror._preserve_tool_timestamps(row, now_ms=now_ms)
                duration_ms = mirror._reasoning_duration_ms(row, now_ms=now_ms)  # noqa: SLF001
                seal_row: dict[str, Any] = {
                    **row,
                    "rowId": row_id,
                    "state": "complete",
                    "createdAt": created_at,
                    "startedAt": started_at,
                    "endedAt": now_ms,
                    "createdAtSeq": mirror._seq_now(tid),  # noqa: SLF001
                }
                if duration_ms is not None:
                    seal_row["durationMs"] = duration_ms
                mirror._hub.author_upsert_row(tid, seal_row)  # noqa: SLF001
                healed += 1
        else:
            healed += mirror._seal_orphan_streaming_reasoning(  # noqa: SLF001
                tid,
                st,
                now_ms=now_ms,
                state="complete",
                any_terminal_turn=True,
            )
        for row in list(sess.rows.values()):
            if not isinstance(row, dict):
                continue
            kind = str(row.get("kind") or "")
            row_turn = str(row.get("turnId") or "").strip()
            if not seal_all and row_turn and row_turn not in terminal_turns:
                continue
            try:
                row_id = int(row.get("rowId") or 0)
            except (TypeError, ValueError):
                continue
            if row_id <= 0:
                continue
            if kind == "assistantText" and str(row.get("state") or "").strip() == "streaming":
                mirror._hub.author_upsert_row(  # noqa: SLF001
                    tid,
                    {
                        **row,
                        "rowId": row_id,
                        "state": "complete",
                        "endedAt": now_ms,
                        "createdAtSeq": mirror._seq_now(tid),  # noqa: SLF001
                    },
                )
                healed += 1
                continue
            if kind != "toolCall":
                continue
            status = str(row.get("status") or "").strip()
            if status not in _OPEN_TOOL_STATUSES_HEAL:
                continue
            if status == "pendingApproval":
                continue
            created_at, started_at = V4Mirror._preserve_tool_timestamps(row, now_ms=now_ms)
            mirror._hub.author_upsert_row(  # noqa: SLF001
                tid,
                {
                    **row,
                    "rowId": row_id,
                    "status": "cancelled",
                    "createdAt": created_at,
                    "startedAt": started_at,
                    "endedAt": now_ms,
                    "createdAtSeq": mirror._seq_now(tid),  # noqa: SLF001
                },
            )
            healed += 1
        if healed:
            logger.info(
                "[v4-mirror] heal_stale_inflight rows=%s session=%s terminal_turns=%s db_phase=%s",
                healed,
                tid,
                len(terminal_turns),
                db_phase or "-",
            )
        return healed
    except Exception:
        logger.exception("[v4-mirror] heal_stale_inflight_rows failed thread=%s", tid)
        return 0


__all__ = [
    "V4Mirror",
    "mirror_note_user_input",
    "mirror_ensure_transcript_user_input",
    "mirror_feed_agui_wire",
    "mirror_feed_agui_events",
    "mirror_reset_thread",
    "mirror_thread_is_live",
    "mirror_heal_orphan_user_input_headers",
    "mirror_heal_stale_inflight_rows",
    "mirror_seal_user_stop",
    "mirror_channel_run_started",
    "mirror_channel_assistant_text",
    "mirror_channel_sync_lg_messages",
    "mirror_channel_run_finished",
    "_split_evoflow_cua_display",
    "_cua_display_block",
    "_platform_ui_display_block",
    "_media_image_cua_display",
    "build_file_diff_display",
]
