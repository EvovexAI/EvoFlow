"""Phase 1 Asset Hub extract — runtime-aligned single-rollout → _inbox + episodic.

Triggered from the existing memory debounce queue after a turn settles.
Uses ``stage_one_system`` / ``stage_one_input`` templates; empty JSON = no-op.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from evoflow.assets.guidance import resolve_session_entity
from evoflow.assets.pipeline_config import asset_phase1_enabled, min_rollout_chars
from evoflow.assets.hub import ensure_entity_tree, write_episode, write_text_file
from evoflow.assets.paths import EntityRef
from evoflow.assets.prompt_templates import load_memory_prompt, render_memory_prompt

logger = logging.getLogger(__name__)

_THREAD_SAFE = re.compile(r"[^a-zA-Z0-9_-]+")


def _extract_text(content: Any) -> str | None:
    if content is None:
        return None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            else:
                text = getattr(block, "text", None)
                if text:
                    parts.append(str(text))
        joined = "".join(parts).strip()
        return joined or None
    text = getattr(content, "text", None)
    if isinstance(text, str) and text.strip():
        return text
    if not isinstance(content, str):
        return None
    stripped = content.strip()
    return stripped or None


def format_messages_as_rollout(messages: list[Any], *, max_chars: int = 48_000) -> str:
    """Render conversation messages as plain text for Phase1 input."""
    lines: list[str] = []
    for msg in messages or []:
        role = str(getattr(msg, "type", None) or getattr(msg, "role", None) or "").lower()
        if not role and isinstance(msg, dict):
            role = str(msg.get("type") or msg.get("role") or "").lower()
        content = getattr(msg, "content", None)
        if content is None and isinstance(msg, dict):
            content = msg.get("content")
        text = _extract_text(content)
        if not text:
            continue
        if role in {"human", "user"}:
            label = "user"
        elif role in {"ai", "assistant"}:
            label = "assistant"
        elif role in {"tool", "function"}:
            label = "tool"
        elif role in {"system"}:
            continue
        else:
            label = role or "message"
        # Cap individual tool dumps
        if label == "tool" and len(text) > 1200:
            text = text[:1199] + "…"
        lines.append(f"[{label}]\n{text}\n")
    out = "\n".join(lines).strip()
    if len(out) > max_chars:
        out = out[-max_chars:]
    return out


def _parse_phase1_json(raw: str) -> dict[str, str]:
    text = str(raw or "").strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    # Find outermost JSON object
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise json.JSONDecodeError("no json object", text, 0)
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("phase1 response must be a JSON object")
    return {
        "rollout_summary": str(data.get("rollout_summary") or "").strip(),
        "rollout_slug": str(data.get("rollout_slug") or "").strip(),
        "raw_memory": str(data.get("raw_memory") or "").strip(),
    }


def _thread_token(thread_id: str) -> str:
    s = _THREAD_SAFE.sub("-", str(thread_id or "").strip())[:64].strip("-")
    return s or "thread"


def run_phase1_extract(
    *,
    messages: list[Any],
    thread_id: str | None = None,
    agent_name: str | None = None,
    workspace_path: str | None = None,
    model_name: str | None = None,
    entity: EntityRef | None = None,
) -> dict[str, Any]:
    """Run runtime Phase1 extract for one conversation; write asset files.

    Returns a result dict: ``{ok, skipped?, paths?, error?}``.
    """
    if not asset_phase1_enabled():
        return {"ok": False, "skipped": "disabled"}

    try:
        from evoflow.config.memory_config import get_memory_config

        if not get_memory_config().enabled:
            return {"ok": False, "skipped": "memory_disabled"}
    except Exception:
        pass

    rollout = format_messages_as_rollout(messages)
    if len(rollout) < min_rollout_chars():
        return {"ok": False, "skipped": "conversation_too_short"}

    try:
        ent = entity or resolve_session_entity(agent_name=agent_name)
        ensure_entity_tree(ent)
    except Exception as exc:
        logger.debug("phase1: entity resolve failed: %s", exc)
        return {"ok": False, "error": f"entity:{exc}"}

    system = load_memory_prompt("stage_one_system")
    user = render_memory_prompt(
        "stage_one_input",
        rollout_path=f"thread:{thread_id or 'unknown'}",
        rollout_cwd=str(workspace_path or ""),
        rollout_contents=rollout,
    )

    try:
        from evoflow.config.memory_config import get_memory_config
        from evoflow.models import create_chat_model

        config = get_memory_config()
        name = config.model_name or model_name or None
        model = create_chat_model(name=name, thinking_enabled=False, invocation_kind="memory")
        logger.info(
            "[资产Phase1] 抽取 thread=%s entity=%s:%s chars=%d",
            thread_id or "?",
            ent.entity_type,
            ent.entity_id,
            len(rollout),
        )
        try:
            from langchain_core.messages import HumanMessage, SystemMessage

            response = model.invoke(
                [SystemMessage(content=system), HumanMessage(content=user)]
            )
        except Exception:
            response = model.invoke(f"{system}\n\n---\n\n{user}")
        response_text = (_extract_text(getattr(response, "content", response)) or "").strip()
        parsed = _parse_phase1_json(response_text)
    except json.JSONDecodeError as exc:
        logger.warning("[资产Phase1] JSON 解析失败 thread=%s: %s", thread_id or "?", exc)
        return {"ok": False, "error": "json_parse"}
    except Exception as exc:
        logger.exception("[资产Phase1] LLM 失败 thread=%s: %s", thread_id or "?", exc)
        return {"ok": False, "error": str(exc)}

    summary = parsed["rollout_summary"]
    raw = parsed["raw_memory"]
    slug = parsed["rollout_slug"] or "session"
    if not summary and not raw:
        logger.info("[资产Phase1] no-op（无高信号） thread=%s", thread_id or "?")
        return {"ok": True, "skipped": "no_signal"}

    paths: list[str] = []
    tid = _thread_token(thread_id or "")
    try:
        if raw:
            inbox_rel = f"memory/_inbox/raw_{tid}.md"
            write_text_file(
                ent,
                inbox_rel,
                f"---\nthread_id: {thread_id or ''}\nslug: {slug}\nsource: phase1\n---\n\n{raw}\n",
            )
            paths.append(inbox_rel)
        if summary:
            title = slug.replace("-", " ").replace("_", " ").strip()[:60] or "会话回顾"
            one = (summary.split("\n", 1)[0].lstrip("# ").strip() or title)[:30]
            ep = write_episode(ent, summary, title=title, summary=one)
            paths.append(str(ep.get("path") or ""))
    except Exception as exc:
        logger.exception("[资产Phase1] 写文件失败 thread=%s: %s", thread_id or "?", exc)
        return {"ok": False, "error": f"write:{exc}", "paths": paths}

    logger.info(
        "[资产Phase1] 已写入 thread=%s entity=%s:%s paths=%s",
        thread_id or "?",
        ent.entity_type,
        ent.entity_id,
        paths,
    )
    return {
        "ok": True,
        "entityType": ent.entity_type,
        "entityId": ent.entity_id,
        "slug": slug,
        "paths": [p for p in paths if p],
    }
