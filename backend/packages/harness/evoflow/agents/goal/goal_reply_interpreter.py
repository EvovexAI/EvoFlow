"""Model-based verdict when hosted goal agent returns text-only (no goal_report tool)."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Literal

from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model, invoke_internal_chat_model
from evoflow.models import create_chat_model

logger = logging.getLogger(__name__)

GoalReplyVerdictKind = Literal["continue", "complete"]

# 兼容旧判定器/模型仍输出 wait_user 的情况（对外统一映射为 continue）
_LEGACY_VERDICT_RE = re.compile(
    r'\{\s*"verdict"\s*:\s*"(continue|complete|wait_user)"[^}]*\}',
    re.DOTALL | re.IGNORECASE,
)


@dataclass(frozen=True)
class GoalReplyVerdict:
    verdict: GoalReplyVerdictKind
    summary: str = ""
    question: str = ""
    reason: str = ""
    raw: str = ""


def _resolve_interpreter_model_name(configurable: dict[str, Any] | None) -> str | None:
    cfg = configurable if isinstance(configurable, dict) else {}
    name = str(cfg.get("planner_model_name") or cfg.get("model_name") or cfg.get("model") or "").strip()
    return name or None


def _clip(text: str, max_len: int) -> str:
    body = str(text or "").strip()
    if len(body) <= max_len:
        return body
    return body[: max_len - 1] + "…"


def _build_interpreter_messages(
    *,
    goal_text: str,
    assistant_reply: str,
    turn_no: int,
    max_steps: int,
) -> list[dict[str, str]]:
    system = (
        "你是目标模式的状态判定器。根据用户目标与助手最新回复，判断 Goal 应如何推进。\n"
        "只输出 JSON，不要 markdown 或其它文字：\n"
        '{"verdict":"continue|complete","summary":"完成或进展摘要","reason":"一句判定理由"}\n\n'
        "判定标准：\n"
        "- complete：用户目标已全部达成，或助手已明确宣告任务结束、无可执行后续步骤。\n"
        "- continue：目标尚未完成，助手只是阶段性汇报、仍在执行中、或应继续自动推进。\n\n"
        "注意：即使助手在等用户回答，只要目标尚未完成，也判 continue（目标模式会自动续跑）。"
    )
    user = "\n\n".join(
        [
            f"[Goal] {_clip(goal_text, 4000)}",
            f"[Turn] {turn_no} / {max_steps}",
            f"[Assistant reply]\n{_clip(assistant_reply, 12000)}",
        ]
    ).strip()
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _parse_verdict_json(text: str) -> GoalReplyVerdict | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    candidate = raw
    match = _LEGACY_VERDICT_RE.search(raw)
    if match:
        candidate = match.group(0)
    else:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            candidate = raw[start : end + 1]
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    verdict_raw = str(data.get("verdict") or "").strip().lower()
    if verdict_raw not in {"continue", "complete", "wait_user"}:
        return None
    return _normalize_verdict(
        GoalReplyVerdict(
            verdict=verdict_raw if verdict_raw != "wait_user" else "continue",  # type: ignore[arg-type]
            summary=str(data.get("summary") or "").strip(),
            question=str(data.get("question") or "").strip(),
            reason=str(data.get("reason") or "").strip(),
            raw=raw,
        ),
        legacy_wait_user=verdict_raw == "wait_user",
    )


def _normalize_verdict(
    verdict: GoalReplyVerdict,
    *,
    legacy_wait_user: bool = False,
) -> GoalReplyVerdict:
    """目标模式对用户仅暴露「继续 / 完成」；旧 wait_user 一律视为继续推进。"""
    if not legacy_wait_user:
        return verdict
    summary = (verdict.question or verdict.summary or "").strip()
    reason = verdict.reason or "legacy_wait_user_mapped_to_continue"
    return GoalReplyVerdict(
        verdict="continue",
        summary=summary,
        question="",
        reason=reason,
        raw=verdict.raw,
    )


## 连续 fallback 上限：超过后仍默认 continue，由 max_steps 兜底结束
_FALLBACK_MAX_STREAK = 3


def _fallback_verdict(*, reason: str, fallback_streak: int = 0) -> GoalReplyVerdict:
    """连续 fallback 仍默认 continue，避免目标模式进入「等待用户」终态。"""
    if fallback_streak >= _FALLBACK_MAX_STREAK:
        return GoalReplyVerdict(
            verdict="continue",
            reason=f"{reason}（连续 {fallback_streak} 次失败，仍继续自动推进）",
            summary="判定器连续失败，系统将按进展继续自动推进。",
        )
    return GoalReplyVerdict(verdict="continue", reason=reason)


def _read_fallback_streak(configurable: dict[str, Any] | None) -> int:
    """从 configurable 读取连续 fallback 次数（由 middleware 通过 SQLite 维护）。"""
    cfg = configurable if isinstance(configurable, dict) else {}
    try:
        return int(cfg.get("interpreter_fallback_streak") or 0)
    except (TypeError, ValueError):
        return 0


def interpret_goal_reply_sync(
    *,
    goal_text: str,
    assistant_reply: str,
    turn_no: int,
    max_steps: int,
    configurable: dict[str, Any] | None = None,
) -> GoalReplyVerdict:
    """Blocking model verdict for sync middleware hooks."""
    messages = _build_interpreter_messages(
        goal_text=goal_text,
        assistant_reply=assistant_reply,
        turn_no=turn_no,
        max_steps=max_steps,
    )
    model_name = _resolve_interpreter_model_name(configurable)
    streak = _read_fallback_streak(configurable)
    try:
        model = create_chat_model(
            name=model_name,
            thinking_enabled=False,
            invocation_kind="hosted_goal_interpreter",
        )
        response = invoke_internal_chat_model(model, messages)
        content = getattr(response, "content", "") or ""
        if not isinstance(content, str):
            content = str(content)
        parsed = _parse_verdict_json(content.strip())
        if parsed is not None:
            return parsed
        logger.warning("goal_reply_interpreter: unparseable output: %s", content[:240])
    except Exception:
        logger.warning("goal_reply_interpreter sync failed", exc_info=True)
    return _fallback_verdict(reason="interpreter_failed_default_continue", fallback_streak=streak + 1)


async def interpret_goal_reply_async(
    *,
    goal_text: str,
    assistant_reply: str,
    turn_no: int,
    max_steps: int,
    configurable: dict[str, Any] | None = None,
) -> GoalReplyVerdict:
    """Async model verdict for aafter_model hooks."""
    messages = _build_interpreter_messages(
        goal_text=goal_text,
        assistant_reply=assistant_reply,
        turn_no=turn_no,
        max_steps=max_steps,
    )
    model_name = _resolve_interpreter_model_name(configurable)
    streak = _read_fallback_streak(configurable)
    try:
        model = create_chat_model(
            name=model_name,
            thinking_enabled=False,
            invocation_kind="hosted_goal_interpreter",
        )
        response = await ainvoke_internal_chat_model(model, messages)
        content = getattr(response, "content", "") or ""
        if not isinstance(content, str):
            content = str(content)
        parsed = _parse_verdict_json(content.strip())
        if parsed is not None:
            return parsed
        logger.warning("goal_reply_interpreter: unparseable output: %s", content[:240])
    except Exception:
        logger.warning("goal_reply_interpreter async failed", exc_info=True)
    return _fallback_verdict(reason="interpreter_failed_default_continue", fallback_streak=streak + 1)
