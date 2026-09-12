"""A2A Adapter: translates A2A protocol <-> EvoFlow dispatch_task.

This is the bridge layer. A2A ``tasks/send`` becomes ``dispatch_task``;
LangGraph messages become A2A SSE events. The underlying proactive engine
is **not modified** — only wrapped.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import re
from typing import Any

from evoflow.error_classifier import FailoverReason, classify
from evoflow.persistence.chat_message_content import loads_payload, model_body_text
from evoflow.persistence.chat_message_repositories import list_messages
from evoflow.persistence.db import get_db
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.proactive.runner import get_proactive_runner
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Meeting speaks share one API account; serialize + retry so multi-speaker rounds
# do not stampede into SetLimitExceeded / 429.
_MEETING_SPEAK_CONCURRENCY = max(
    1, int(os.getenv("EVOFLOW_MEETING_SPEAK_CONCURRENCY", "1") or 1)
)
_MEETING_SPEAK_MAX_RETRIES = max(
    0, int(os.getenv("EVOFLOW_MEETING_SPEAK_RATE_LIMIT_RETRIES", "4") or 4)
)
_MEETING_SPEAK_MAX_BACKOFF_S = max(
    2.0, float(os.getenv("EVOFLOW_MEETING_SPEAK_MAX_BACKOFF_SECONDS", "20") or 20)
)
_meeting_speak_sem = asyncio.Semaphore(_MEETING_SPEAK_CONCURRENCY)


def _meeting_speak_backoff_seconds(attempt: int, error: Exception) -> float:
    """Exponential backoff with jitter; honors Retry-After when present. *attempt* is 1-based."""
    backoff_s = 2.0 * (2 ** (attempt - 1))
    jitter_s = random.uniform(0, backoff_s * 0.2)
    total_s = backoff_s + jitter_s
    resp = getattr(error, "response", None)
    if resp is not None and hasattr(resp, "headers"):
        retry_after = resp.headers.get("Retry-After")
        if retry_after:
            try:
                total_s = max(total_s, float(retry_after))
            except (ValueError, TypeError):
                pass
    return min(total_s, _MEETING_SPEAK_MAX_BACKOFF_S)


def _meeting_speak_user_error(exc: BaseException) -> str:
    """Short UI-facing line for meeting bubble failures (no raw provider dump)."""
    classification = classify(exc)
    if classification.reason == FailoverReason.RATE_LIMIT:
        return "模型限流（多人发言过快），请稍候再试或换模型"
    if classification.reason == FailoverReason.BILLING:
        return "模型额度已用尽，请换模型或稍后再试"
    if classification.reason == FailoverReason.OVERLOADED:
        return "模型服务过载，请稍候再试"
    msg = str(exc).strip()
    if len(msg) > 160:
        msg = msg[:159] + "…"
    return msg or "发言失败"


# ── A2A Task DB helpers ─────────────────────────────────────


def _create_a2a_task_record(
    task_id: str,
    agent_code: str,
    meeting_id: str,
    session_id: str,
    goal: str,
    context_summary: str,
    *,
    state: str = "working",
    result_text: str = "",
) -> None:
    """Insert a row into evoflow_a2a_tasks."""
    now = utc_now_iso_z()
    completed_at = now if state in ("completed", "failed", "canceled") else ""
    get_db().execute(
        """
        INSERT INTO evoflow_a2a_tasks
            (task_id, agent_code, meeting_id, session_id, state,
             goal, context_summary, result_text, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            agent_code,
            meeting_id,
            session_id,
            state,
            goal,
            context_summary,
            result_text,
            now,
            now,
            completed_at,
        ),
    )
    get_db().commit()


def _update_a2a_task_state(
    task_id: str,
    state: str,
    result_text: str | None = None,
) -> None:
    """Update an A2A task's state; only overwrite result_text when explicitly passed."""
    now = utc_now_iso_z()
    completed_at = now if state in ("completed", "failed", "canceled") else ""
    if result_text is None:
        get_db().execute(
            """
            UPDATE evoflow_a2a_tasks
            SET state = ?, updated_at = ?,
                completed_at = CASE WHEN ? = '' THEN completed_at ELSE ? END
            WHERE task_id = ?
            """,
            (state, now, completed_at, completed_at, task_id),
        )
    else:
        get_db().execute(
            """
            UPDATE evoflow_a2a_tasks
            SET state = ?, result_text = ?, updated_at = ?,
                completed_at = CASE WHEN ? = '' THEN completed_at ELSE ? END
            WHERE task_id = ?
            """,
            (state, result_text, now, completed_at, completed_at, task_id),
        )
    get_db().commit()


def record_terminal_a2a_task(
    *,
    agent_code: str,
    meeting_id: str,
    session_id: str,
    goal: str,
    state: str,
    result_text: str,
    context_summary: str = "",
) -> str:
    """Create a terminal A2A task row (busy / skip / error) so the UI can finish polling."""
    import uuid

    task_id = f"a2a_{uuid.uuid4().hex[:12]}"
    _create_a2a_task_record(
        task_id=task_id,
        agent_code=agent_code,
        meeting_id=meeting_id,
        session_id=session_id,
        goal=goal[:2000],
        context_summary=context_summary[:4000],
        state=state,
        result_text=result_text[:8000],
    )
    return task_id


def _get_a2a_task(task_id: str) -> dict[str, Any] | None:
    """Fetch an A2A task record by ID."""
    row = get_db().execute(
        """
        SELECT * FROM evoflow_a2a_tasks WHERE task_id = ?
        """,
        (task_id,),
    ).fetchone()
    return dict(row) if row else None


# ── Message extraction ──────────────────────────────────────


def extract_text_from_message(row: dict[str, Any]) -> str:
    """Extract plain text from a chat_message row's content_json."""
    try:
        payload = loads_payload(str(row.get("content_json") or "{}"))
        return model_body_text(payload)
    except Exception:
        return ""


def _is_tool_message(row: dict[str, Any]) -> bool:
    return bool(str(row.get("tool_name") or "").strip())


# ── Completion detection ───────────────────────────────────


def is_agent_busy(agent_code: str) -> bool:
    """Check if an agent is currently running a task."""
    runner = get_proactive_runner()
    busy = {b["agent_code"] for b in runner.busy_roles()}
    return agent_code in busy


def meeting_speak_mode(topic: str) -> str:
    """Classify meeting turn: proposal debate vs work sync."""
    t = str(topic or "").strip()
    if "【第二轮" in t or "碰撞" in t[:80]:
        return "rebuttal"
    sync_keys = ("汇报", "进度", "同步", "本周干了", "任务量", "完成几", "值班近况", "手头")
    proposal_keys = (
        "方案",
        "需求",
        "MVP",
        "mvp",
        "评审",
        "辩论",
        "怎么做",
        "要不要",
        "上线",
        "产品",
        "取舍",
        "风险",
        "设计",
        "讨论",
        "能力",
        "功能",
    )
    sync_hits = sum(1 for k in sync_keys if k in t)
    proposal_hits = sum(1 for k in proposal_keys if k in t)
    if sync_hits > proposal_hits and sync_hits > 0:
        return "sync"
    if proposal_hits > 0 or len(t) >= 36:
        return "proposal"
    return "sync"


def meeting_speak_max_chars(mode: str) -> int:
    if mode == "rebuttal":
        return 140
    if mode == "proposal":
        return 280
    return 160


def build_meeting_speak_goal(message_text: str, context_summary: str = "") -> str:
    """Prompt for a short round-table oral turn (sync and/or proposal review)."""
    topic = message_text.strip()
    mode = meeting_speak_mode(topic)
    max_chars = meeting_speak_max_chars(mode)
    parts = [
        "【AI员工聊天室 · 圆桌发言】",
        "你在会议室轮到说话了：像真人开会，直接说，别念稿、别套【立场】【风险】标签。",
    ]
    if mode == "rebuttal":
        parts.extend(
            [
                f"字数：优先 40～100 个汉字，最多 {max_chars}（含标点）。只谈分歧与拍板。",
                "点名同意/反对谁的哪一点，给出你拍板的一条；禁止复述全文，禁止汇报自己任务清单。",
            ]
        )
    elif mode == "proposal":
        parts.extend(
            [
                f"字数：优先 120～220 个汉字，最多 {max_chars}（含标点）。说 3～5 句口语即可。",
                "本场是方案/需求讨论：先亮本职观点，再回应前面同事（同意、补洞或反对），最后给一条可落地建议。",
                "可以争论；有分歧就说清楚为什么。禁止汇报值班/巡检/任务完成数。",
            ]
        )
    else:
        parts.extend(
            [
                f"字数：优先 60～120 个汉字，最多 {max_chars}（含标点）。可说 2～3 句口语。",
                "本场是工作同步：覆盖近期任务量、完成/未结，点 1～2 件具体事项；能提时间就提。",
            ]
        )
    parts.extend(
        [
            "禁止套话：「没卡点」「随时能接新活」「挺顺的」「随时待命」「手头都稳」「整体挺顺」。",
            "禁止：专业术语堆砌、条目式长列表、值班交班/工作汇报摘要/巡检摘要、飞书、JSON、新建任务。",
            "",
            f"话题：{topic}",
        ]
    )
    if context_summary.strip():
        # Proposal/rebuttal need fuller transcript; sync can stay shorter.
        cap = 2800 if mode in ("proposal", "rebuttal") else 600
        parts.extend(
            [
                "",
                "--- 会上已有发言（请接话；禁止抄句尾/同义复读）---",
                context_summary.strip()[:cap],
            ]
        )
    return "\n".join(parts)


def _message_content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                parts.append(str(block.get("text") or ""))
            else:
                parts.append(str(block))
        return "".join(parts).strip()
    return str(content).strip()


def sanitize_meeting_reply(text: str, *, max_chars: int | None = None) -> str:
    """Drop duty/feishu wrap-up noise so the meeting UI only shows oral report."""
    raw = str(text or "").strip()
    if not raw:
        return ""
    # Reject known duty-summary headers / templates (keep legacy 交班 markers)
    bad_markers = (
        "[feishu·值班交班摘要]",
        "[feishu·工作汇报]",
        "值班交班摘要",
        "工作汇报摘要",
        "员工工作摘要",
        "【值班",
        "巡检完成",
        "刚巡检",
        "wrap_up",
    )
    lower = raw.lower()
    if any(m.lower() in lower or m in raw for m in bad_markers):
        # Keep only lines that look like spoken report; else clear for regenerator
        lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        kept = [
            ln
            for ln in lines
            if not any(b in ln for b in bad_markers)
            and not ln.startswith("[feishu")
            and "交班" not in ln
            and "工作汇报摘要" not in ln
            and "巡检" not in ln
        ]
        raw = "\n".join(kept).strip()
    # Strip rigid label scaffolds that make speeches sound like forms
    raw = re.sub(r"【\s*(立场|风险|建议|收敛|结论)\s*】", "", raw)
    # 聊天室发言：压成连贯口语（允许多句；空白压掉，超出则截断）
    one_line = re.sub(r"\s+", "", raw)
    limit = int(max_chars) if max_chars and max_chars > 0 else 280
    if len(one_line) > limit:
        one_line = one_line[: max(0, limit - 1)] + "…"
    return one_line


async def _llm_meeting_speak(
    *,
    role: Any,
    topic: str,
    context_summary: str,
    allow_tools: bool = False,
) -> str:
    """One-shot LLM oral report — no duty cycle, no role busy lock.

    When ``allow_tools`` is True, a short read-only tool loop may run before the
    final oral line (lookup tasks / search assets / read asset).
    """
    from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
    from evoflow.models import create_chat_model

    role_name = getattr(role, "role_name", None) or getattr(role, "agent_code", "员工")
    agent_code = str(getattr(role, "agent_code", "") or "").strip().lower()
    cfg = getattr(role, "config", None)
    responsibilities = list(getattr(cfg, "responsibilities", None) or [])[:8]
    resp_line = "、".join(str(x) for x in responsibilities if str(x).strip()) or "本职工作"
    mode = meeting_speak_mode(topic)
    max_chars = meeting_speak_max_chars(mode)
    # Proposal debate must not bleed duty task lists into the room.
    use_task_memory = mode == "sync" or allow_tools

    task_memory = ""
    if use_task_memory:
        try:
            from evoflow.proactive.work_items import (
                format_meeting_task_memory_for_prompt,
                list_role_recent_tasks,
            )

            task_memory = format_meeting_task_memory_for_prompt(
                list_role_recent_tasks(role, limit=20)
            )[:2000]
        except Exception:
            task_memory = ""

    if mode == "rebuttal":
        system = (
            f"你是「{role_name}」，职责：{resp_line}。\n"
            "第二轮碰撞：只回应会上分歧，点名同意/反对谁，给出你拍板的一点。\n"
            f"硬性上限：整段不超过 {max_chars} 个汉字；理想 40～100。只输出这段话。\n"
            "禁止复述全文；禁止汇报值班/巡检/任务完成数；禁止【立场】【风险】标签。\n"
            "禁止套话：「没卡点」「随时能接新活」「挺顺的」「随时待命」「手头都稳」。\n"
        )
    elif mode == "proposal":
        system = (
            f"你是「{role_name}」，职责：{resp_line}。\n"
            "你在会议室讨论方案：像真人开会接话，先表态，再回应前面同事，最后给可落地建议。\n"
            f"硬性上限：整段不超过 {max_chars} 个汉字；理想 120～220。可说 3～5 句，只输出这段话。\n"
            "结合本职职责；有分歧就明说；可以点名反驳。\n"
            "禁止汇报自己的值班、巡检、任务完成数；本场不是工作同步。\n"
            "禁止套话与标签式发言（不要写【立场】【风险】【建议】）。\n"
            "禁止：专业术语堆砌、条目式长列表、飞书模板、JSON、工具说明、新建任务。\n"
        )
    else:
        system = (
            f"你是「{role_name}」，职责：{resp_line}。\n"
            "你在聊天室里用真人语气发言：轻松、具体；工作同步时带数字和事项。\n"
            f"硬性上限：整段不超过 {max_chars} 个汉字；理想 60～120。可说 2～3 句，只输出这段话。\n"
            "被问工作/进度时：先说近期任务总量与完成/未结数量（用下方概况），再点 1～2 件具体事与大致时间。\n"
            "禁止套话：「没卡点」「随时能接新活」「挺顺的」「随时待命」「手头都稳」。\n"
            "禁止：专业术语、条目式长列表、长分析、值班交班/工作汇报摘要、飞书模板、JSON、工具说明、新建任务。\n"
        )
    if allow_tools:
        system += (
            "本轮允许查证：需要证据时可调用 lookup_my_tasks / search_my_assets / read_my_asset（只读）。"
            "查完后必须给出最终口头发言；不要把工具原文贴给用户；最多查 2～3 次。\n"
        )
    elif mode == "sync":
        system += (
            "系统已自动加载你近 20 条任务记忆（含未结与已完成/失败状态、更新时间）。"
            "据此直接回答，不要说还要去查；没有记忆就如实说这周暂无登记任务。\n"
        )
    if task_memory and mode == "sync" and not allow_tools:
        system += f"\n{task_memory}"
    elif task_memory and allow_tools:
        system += f"\n（任务概况预览，可再查）\n{task_memory[:800]}"

    user = build_meeting_speak_goal(topic, context_summary)
    if allow_tools:
        user += "\n\n如需查证再发言；最终只输出口语表态。"

    model_name = str(getattr(cfg, "model_name", None) or "").strip() or None
    try:
        model = create_chat_model(
            name=model_name,
            thinking_enabled=False,
            temperature=0.75 if mode in ("proposal", "rebuttal") else 0.7,
            invocation_kind="a2a_meeting",
        )
    except Exception:
        logger.warning("meeting.speak create_chat_model failed, fallback default", exc_info=True)
        model = create_chat_model(thinking_enabled=False, temperature=0.7, invocation_kind="a2a_meeting")

    timeout_s = 150.0 if allow_tools else 90.0
    last_exc: BaseException | None = None
    async with _meeting_speak_sem:
        for attempt in range(_MEETING_SPEAK_MAX_RETRIES + 1):
            try:
                if allow_tools and agent_code:
                    from evoflow.a2a.meeting_tool_speak import (
                        ainvoke_meeting_speak_with_tools,
                        build_meeting_verify_tools,
                    )

                    tools = build_meeting_verify_tools(agent_code=agent_code, role=role)
                    raw_text = await asyncio.wait_for(
                        ainvoke_meeting_speak_with_tools(
                            model=model,
                            system=system,
                            user=user,
                            tools=tools,
                        ),
                        timeout=timeout_s,
                    )
                    text = sanitize_meeting_reply(raw_text, max_chars=max_chars)
                else:
                    messages = [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ]
                    response = await asyncio.wait_for(
                        ainvoke_internal_chat_model(model, messages),
                        timeout=timeout_s,
                    )
                    text = sanitize_meeting_reply(
                        _message_content_to_text(getattr(response, "content", response)),
                        max_chars=max_chars,
                    )
                if not text:
                    text = (
                        f"关于「{topic[:40]}」，我这边暂无更多细节可补充，"
                        "建议会后再对齐具体阻塞点。"
                    )
                return text
            except Exception as exc:
                last_exc = exc
                reason = classify(exc).reason
                retryable = reason in (
                    FailoverReason.RATE_LIMIT,
                    FailoverReason.OVERLOADED,
                    FailoverReason.SERVER_ERROR,
                    FailoverReason.CONNECTION_ERROR,
                )
                if not retryable or attempt >= _MEETING_SPEAK_MAX_RETRIES:
                    raise
                wait_s = _meeting_speak_backoff_seconds(attempt + 1, exc)
                logger.warning(
                    "meeting.speak rate-limited/retryable agent=%s attempt=%d/%d wait=%.1fs: %s",
                    getattr(role, "agent_code", "?"),
                    attempt + 1,
                    _MEETING_SPEAK_MAX_RETRIES,
                    wait_s,
                    exc,
                )
                await asyncio.sleep(wait_s)
    if last_exc:
        raise last_exc
    raise RuntimeError("meeting.speak failed without response")


async def speak_in_meeting(
    agent_code: str,
    session_id: str,
    message_text: str,
    *,
    context_summary: str = "",
    meeting_id: str = "",
    allow_tools: bool = False,
) -> dict[str, Any]:
    """Meeting oral report: one-shot LLM, persist to evoflow_a2a_tasks.

    Does **not** call ``dispatch_task`` / duty cycle / ``create_role_work_item``,
    so it won't collide with patrol busy locks, won't scrape stale wrap_up
    summaries, and won't flood the task center with identical oral-report titles.

    ``allow_tools`` enables a short read-only verify loop (tasks/assets) before speaking.
    """
    import uuid

    role = ProactiveRepository.get_role(agent_code)
    if not role:
        return {"error": f"agent '{agent_code}' not found"}

    topic = str(message_text or "").strip()
    if not topic:
        return {"error": "topic is required"}

    goal = build_meeting_speak_goal(topic, context_summary)
    if allow_tools:
        goal = "【查证模式】\n" + goal
    task_id = f"a2a_{uuid.uuid4().hex[:12]}"
    _create_a2a_task_record(
        task_id=task_id,
        agent_code=agent_code,
        meeting_id=meeting_id,
        session_id=session_id,
        goal=goal[:2000],
        context_summary=context_summary[:4000],
        state="working",
    )

    try:
        reply = await _llm_meeting_speak(
            role=role,
            topic=topic,
            context_summary=context_summary,
            allow_tools=bool(allow_tools),
        )
        _update_a2a_task_state(task_id, "completed", result_text=reply)
        return {
            "task": {
                "id": task_id,
                "sessionId": session_id,
                "status": {"state": "completed", "timestamp": utc_now_iso_z()},
                "agent_code": agent_code,
                "role_name": role.role_name,
                "result_text": reply,
            },
            "reply": reply,
        }
    except Exception as e:
        logger.exception("meeting.speak failed agent=%s", agent_code)
        friendly = _meeting_speak_user_error(e)
        err = f"（发言失败）{friendly}"
        _update_a2a_task_state(task_id, "failed", result_text=err[:2000])
        return {
            "error": friendly,
            "task": {
                "id": task_id,
                "sessionId": session_id,
                "status": {"state": "failed", "timestamp": utc_now_iso_z()},
                "agent_code": agent_code,
                "role_name": role.role_name,
                "result_text": err[:2000],
            },
        }


# ── A2A tasks/send ─────────────────────────────────────────


async def send_task(
    agent_code: str,
    session_id: str,
    message_text: str,
    *,
    context_summary: str = "",
    from_agent: str = "meeting_orchestrator",
    meeting_id: str = "",
    allow_tools: bool = False,
) -> dict[str, Any]:
    """Meeting / A2A send: prefer lightweight ``speak_in_meeting``.

    Legacy full ``dispatch_task`` duty path is intentionally not used for
    round-table speaking — it is slow, busy-locked, and scrapes wrong summaries.
    """
    _ = from_agent  # retained for API compatibility
    return await speak_in_meeting(
        agent_code=agent_code,
        session_id=session_id,
        message_text=message_text,
        context_summary=context_summary,
        meeting_id=meeting_id,
        allow_tools=bool(allow_tools),
    )


# ── A2A tasks/get ──────────────────────────────────────────


def get_task(agent_code: str, task_id: str) -> dict[str, Any]:
    """A2A ``tasks/get`` -> query task status and messages."""
    session_key = f"proactive:{agent_code}"

    # Fetch messages from the proactive session
    messages = list_messages(
        session_key=session_key,
        limit=200,
    )

    # Determine task state
    task_record = _get_a2a_task(task_id)
    if task_record:
        state = task_record.get("state", "working")
        # If still working, check if agent is done
        if state == "working" and not is_agent_busy(agent_code):
            state = "completed"
            _update_a2a_task_state(task_id, "completed")
    else:
        state = "completed" if not is_agent_busy(agent_code) else "working"

    # Convert messages to A2A format (assistant -> agent)
    a2a_messages = []
    for msg in messages:
        role = msg.get("role", "")
        text = extract_text_from_message(msg)
        if not text and not _is_tool_message(msg):
            continue
        a2a_msg = {
            "role": "agent" if role == "assistant" else "user",
            "parts": [{"type": "text", "text": text or "[tool call]"}],
            "taskId": task_id,
            "messageId": f"msg_{msg.get('seq', 0)}",
        }
        if _is_tool_message(msg):
            a2a_msg["parts"] = [
                {"type": "text", "text": f"[工具: {msg['tool_name']}] {text[:200]}"}
            ]
        a2a_messages.append(a2a_msg)

    return {
        "task": {
            "id": task_id,
            "sessionId": session_key,
            "status": {"state": state, "timestamp": utc_now_iso_z()},
            "messages": a2a_messages,
            "agent_code": agent_code,
        }
    }


# ── A2A tasks/cancel ──────────────────────────────────────


async def cancel_task(agent_code: str, task_id: str) -> dict[str, Any]:
    """A2A ``tasks/cancel`` -> mark task as canceled."""
    _update_a2a_task_state(task_id, "canceled")
    return {
        "task": {
            "id": task_id,
            "status": {"state": "canceled", "timestamp": utc_now_iso_z()},
        }
    }


# ── SSE polling helpers ────────────────────────────────────


def poll_new_messages(
    agent_code: str,
    last_seq: int,
) -> list[dict[str, Any]]:
    """Poll for new messages from the proactive session since last_seq.

    Returns a list of A2A-formatted message dicts with ``event_type``
    field (``task:message`` or ``task:artifact``).
    """
    session_key = f"proactive:{agent_code}"
    messages = list_messages(
        session_key=session_key,
        limit=50,
        min_seq=last_seq + 1 if last_seq > 0 else None,
    )

    events = []
    for msg in messages:
        seq = int(msg.get("seq", 0))
        if seq <= last_seq:
            continue

        role = msg.get("role", "")
        text = extract_text_from_message(msg)

        if _is_tool_message(msg):
            tool_name = str(msg.get("tool_name", ""))
            events.append(
                {
                    "event": "task:artifact",
                    "seq": seq,
                    "data": {
                        "taskId": "",
                        "agentCode": agent_code,
                        "artifact": {
                            "name": tool_name,
                            "parts": [{"type": "text", "text": text[:500]}],
                        },
                    },
                }
            )
        elif role == "assistant" and text:
            events.append(
                {
                    "event": "task:message",
                    "seq": seq,
                    "data": {
                        "taskId": "",
                        "agentCode": agent_code,
                        "message": {
                            "role": "agent",
                            "parts": [{"type": "text", "text": text}],
                        },
                    },
                }
            )

    return events
