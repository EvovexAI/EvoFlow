"""Format agent payloads for Feishu IM (avoid raw JSON blobs for ask_clarification)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")


def _as_str(v: Any) -> str:
    return str(v).strip() if v is not None else ""


def strip_markdown_images(text: str) -> str:
    """Drop ``![...](...)`` from IM body — same rule as Feishu card/plain send."""
    t = _MD_IMAGE_RE.sub("", text or "")
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def _attachment_kind_label(*, is_image: bool, filename: str, mime: str) -> str:
    mime_l = (mime or "").lower()
    name_l = (filename or "").lower()
    if is_image or mime_l.startswith("image/") or name_l.endswith(
        (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico")
    ):
        return "图片"
    if mime_l.startswith("audio/") or name_l.endswith((".mp3", ".wav", ".ogg", ".opus", ".m4a")):
        return "语音"
    if mime_l.startswith("video/") or name_l.endswith((".mp4", ".mov", ".mkv", ".webm")):
        return "视频"
    return "文件"


def build_outbound_ops_delivery(
    text: str,
    *,
    attachments: list[Any] | None = None,
    proactive_markdown: bool = False,
    wire_msg_type: str = "",
    attachments_failed: list[str] | None = None,
) -> dict[str, Any]:
    """Build ops audit fields that mirror what the user likely saw on IM.

    Bus text can differ from Feishu wire (ask_clarification rewrite, markdown
    images stripped, files sent as separate messages). Ops should summarize the
    delivered shape, not only the raw agent blob.
    """
    wire = feishu_outbound_text(text or "")
    body = strip_markdown_images(wire)
    md_images = [(m.group(1) or "", m.group(2) or "") for m in _MD_IMAGE_RE.finditer(wire or "")]

    att_items: list[dict[str, str]] = []
    for raw in list(attachments or [])[:16]:
        if isinstance(raw, str) and raw.strip():
            s = raw.strip()
            name = s.replace("\\", "/").rsplit("/", 1)[-1]
            kind = _attachment_kind_label(is_image=False, filename=name, mime="")
            att_items.append({"filename": name[:160], "path": s[:500], "mime": "", "kind": kind})
            continue
        filename = _as_str(getattr(raw, "filename", None) or (raw.get("filename") if isinstance(raw, dict) else "") or "")
        path = _as_str(
            getattr(raw, "actual_path", None)
            or getattr(raw, "virtual_path", None)
            or (raw.get("path") if isinstance(raw, dict) else "")
            or (raw.get("virtual_path") if isinstance(raw, dict) else "")
            or ""
        )
        if isinstance(path, Path):
            path = str(path)
        mime = _as_str(
            getattr(raw, "mime_type", None)
            or getattr(raw, "mime", None)
            or (raw.get("mime") if isinstance(raw, dict) else "")
            or (raw.get("mime_type") if isinstance(raw, dict) else "")
            or ""
        )
        is_image = bool(getattr(raw, "is_image", False))
        if not filename and path:
            filename = path.replace("\\", "/").rsplit("/", 1)[-1]
        if not filename and not path:
            continue
        kind = _attachment_kind_label(is_image=is_image, filename=filename, mime=mime)
        att_items.append(
            {
                "filename": (filename or "attachment")[:160],
                "path": (path or filename)[:500],
                "mime": mime[:80],
                "kind": kind,
            }
        )

    failed = [str(x).strip() for x in (attachments_failed or []) if str(x).strip()]
    parts: list[str] = []
    if body:
        parts.append(body)
    if att_items:
        labels = [f"{it['kind']}：{it['filename']}" for it in att_items]
        parts.append("【实发附件】" + "；".join(labels))
    elif md_images:
        # Markdown images were stripped from the bubble and never attached.
        dangling = []
        for alt, url in md_images[:6]:
            tip = (alt or url.replace("\\", "/").rsplit("/", 1)[-1] or "image").strip()
            dangling.append(tip[:80])
        parts.append("【正文 markdown 图已剥离、未作为附件发出】" + "；".join(dangling))
    if failed:
        parts.append("【附件发送失败】" + "；".join(failed[:8]))

    summary = "\n".join(parts).strip()
    if not summary:
        summary = "(空消息)"

    image_n = sum(1 for it in att_items if it.get("kind") == "图片")
    file_n = len(att_items) - image_n
    # Channel may stamp wire_msg_type=text/interactive before attachments upload;
    # upgrade to composite types when files actually went out.
    base_type = str(wire_msg_type or "").strip().lower()
    if proactive_markdown and not base_type:
        base_type = "interactive"
    if image_n and body:
        inferred = "text+image"
    elif file_n and body:
        inferred = "text+file"
    elif image_n and not body:
        inferred = "image"
    elif file_n and not body:
        inferred = "file"
    elif base_type in {"text", "interactive", "post"}:
        inferred = base_type
    elif base_type:
        inferred = base_type
    else:
        inferred = "text"

    return {
        "content_summary": summary[:800],
        "wire_text": body[:4000],
        "wire_msg_type": inferred,
        "attachments": att_items,
        "attachments_failed": failed[:8],
        "markdown_images_stripped": [
            {"alt": (a or "")[:80], "url": (u or "")[:240]} for a, u in md_images[:8]
        ],
    }


def _option_label(item: Any) -> str:
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        lab = item.get("label") or item.get("text") or item.get("title")
        return _as_str(lab)
    return ""


def format_ask_clarification_payload_for_feishu(payload: Any) -> str | None:
    """Build short Markdown for Feishu from ask_clarification tool args / JSON body."""
    obj: dict[str, Any] | None = None
    if isinstance(payload, dict):
        obj = payload
    elif isinstance(payload, str):
        s = payload.strip()
        if not s:
            return None
        if not s.startswith("{"):
            return None
        try:
            parsed = json.loads(s)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            obj = parsed
        else:
            return None
    else:
        return None

    if not obj:
        return None

    # Heuristic: only rewrite when it looks like clarification schema
    hint_keys = frozenset(obj.keys()) & frozenset({"question", "questions", "options", "clarification_type", "title", "context"})
    if not hint_keys:
        return None

    lines: list[str] = ["❔ **需要您确认 / 选择**", ""]

    title = _as_str(obj.get("title"))
    if title:
        lines.append(f"**{title}**")
        lines.append("")

    ctype = _as_str(obj.get("clarification_type"))
    if ctype:
        lines.append(f"_类型：{ctype}_")
        lines.append("")

    questions = obj.get("questions")
    if isinstance(questions, list) and questions:
        for i, q in enumerate(questions, start=1):
            if not isinstance(q, dict):
                continue
            prompt = _as_str(q.get("prompt"))
            ctx = _as_str(q.get("context"))
            if ctx:
                lines.append(ctx)
            if prompt:
                lines.append(f"**{i}.** {prompt}")
            opts = q.get("options")
            if isinstance(opts, list) and opts:
                lines.append("")
                for j, opt in enumerate(opts, start=1):
                    lab = _option_label(opt)
                    if lab:
                        lines.append(f"- {j}. {lab}")
            lines.append("")
    else:
        ctx = _as_str(obj.get("context"))
        q = _as_str(obj.get("question"))
        if ctx:
            lines.append(ctx)
            lines.append("")
        if q:
            lines.append(f"**{q}**")
            lines.append("")
        opts = obj.get("options")
        if isinstance(opts, list) and opts:
            for j, opt in enumerate(opts, start=1):
                lab = _option_label(opt)
                if lab:
                    lines.append(f"- {j}. {lab}")
            lines.append("")

    while lines and lines[-1] == "":
        lines.pop()

    lines.append("")
    lines.append("---")
    lines.append("在 **EvoPanel 桌面端** 该对话侧栏点选即可继续；也可在本群直接回复你的选择（助手会尽量理解）。")

    body = "\n".join(lines).strip()
    return body or None


def feishu_outbound_text(text: str) -> str:
    """If outbound text is a raw ask_clarification JSON string, replace with Markdown."""
    raw = text or ""
    s = raw.strip()
    if len(s) < 2 or s[0] != "{":
        return raw
    # Fast reject: huge blobs stay as-is (avoid slow parse)
    if len(s) > 120_000:
        return raw
    formatted = format_ask_clarification_payload_for_feishu(s)
    return formatted if formatted else raw


def maybe_format_tool_message_content_for_im(name: str | None, content: Any) -> str | None:
    """For LangGraph tool messages: return formatted text, or None to keep default handling."""
    if str(name or "").strip().lower() != "ask_clarification":
        return None
    if isinstance(content, (dict, list)):
        try:
            dumped = json.dumps(content, ensure_ascii=False)
        except (TypeError, ValueError):
            return None
        return format_ask_clarification_payload_for_feishu(dumped)
    if isinstance(content, str):
        return format_ask_clarification_payload_for_feishu(content)
    return None
