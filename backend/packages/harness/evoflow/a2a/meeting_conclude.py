"""Synthesize an optimal plan from meeting oral turns and deposit as a document."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_CONCLUDE_SYSTEM = """\
你是会议室主持人。根据多位智能体员工的圆桌发言（可能含第一轮表态与第二轮碰撞），综合出一份「最优方案」。
只输出一个 JSON 对象，不要 Markdown 围栏外的散文。

schema:
{
  "summary": "一句话结论（≤80字）",
  "plan": "可执行最优方案正文（中文，分点，≤600字）",
  "steps": ["步骤1", "步骤2"],
  "risks": ["风险或待确认"],
  "owners": [{"role":"岗位或员工名","action":"建议负责事项"}]
}

规则：
- 只依据发言内容综合，禁止编造未提及的事实；
- 有分歧时优先采纳第二轮碰撞里拍板的方向，并写明取舍理由；
- 忽略明显跑题的值班/巡检汇报；
- 步骤要可执行。
"""


def list_meeting_speak_turns(meeting_id: str) -> list[dict[str, Any]]:
    """Completed A2A speak rows for a meeting (chronological)."""
    from evoflow.persistence.db import get_db

    mid = str(meeting_id or "").strip()
    if not mid:
        return []
    rows = get_db().execute(
        """
        SELECT agent_code, goal, result_text, state, created_at
        FROM evoflow_a2a_tasks
        WHERE meeting_id = ?
          AND COALESCE(result_text, '') != ''
        ORDER BY created_at
        """,
        (mid,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        d = dict(row)
        out.append(
            {
                "agent_code": str(d.get("agent_code") or ""),
                "topic": str(d.get("goal") or ""),
                "text": str(d.get("result_text") or "").strip(),
                "state": str(d.get("state") or ""),
                "created_at": str(d.get("created_at") or ""),
            }
        )
    return [x for x in out if x["text"]]


def _parse_conclude_json(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {
        "summary": "已综合会议室发言",
        "plan": text[:600] or "（模型未返回结构化方案）",
        "steps": [],
        "risks": [],
        "owners": [],
    }


def _normalize_conclusion(parsed: dict[str, Any], *, topic: str) -> dict[str, Any]:
    steps = parsed.get("steps") if isinstance(parsed.get("steps"), list) else []
    risks = parsed.get("risks") if isinstance(parsed.get("risks"), list) else []
    owners_raw = parsed.get("owners") if isinstance(parsed.get("owners"), list) else []
    owners: list[dict[str, str]] = []
    for o in owners_raw:
        if not isinstance(o, dict):
            continue
        role = str(o.get("role") or "").strip()
        action = str(o.get("action") or "").strip()
        if role or action:
            owners.append({"role": role, "action": action})
    plan = str(parsed.get("plan") or "").strip()
    summary = str(parsed.get("summary") or "").strip() or (plan.split("\n", 1)[0][:80] if plan else "")
    return {
        "topic": str(topic or "").strip(),
        "summary": summary[:120],
        "plan": plan[:2000],
        "steps": [str(s).strip() for s in steps if str(s).strip()][:12],
        "risks": [str(r).strip() for r in risks if str(r).strip()][:8],
        "owners": owners[:8],
    }


def format_conclusion_document(
    conclusion: dict[str, Any],
    *,
    meeting_id: str = "",
    turns: list[dict[str, Any]] | None = None,
) -> str:
    """Markdown body for Asset Hub deposit (human-readable meeting plan doc)."""
    topic = str(conclusion.get("topic") or "").strip()
    summary = str(conclusion.get("summary") or "").strip()
    plan = str(conclusion.get("plan") or "").strip()
    steps = conclusion.get("steps") if isinstance(conclusion.get("steps"), list) else []
    risks = conclusion.get("risks") if isinstance(conclusion.get("risks"), list) else []
    owners = conclusion.get("owners") if isinstance(conclusion.get("owners"), list) else []
    title = summary or (topic[:40] if topic else "会议室方案")
    lines = [f"# 会议室方案 · {title}", ""]
    if meeting_id:
        lines.append(f"_meeting: `{meeting_id}`_")
        lines.append("")
    if topic:
        lines.append("## 议题")
        lines.append(topic)
        lines.append("")
    if summary:
        lines.append("## 结论")
        lines.append(summary)
        lines.append("")
    if plan:
        lines.append("## 最优方案")
        lines.append(plan)
        lines.append("")
    if steps:
        lines.append("## 步骤")
        for i, s in enumerate(steps, 1):
            lines.append(f"{i}. {s}")
        lines.append("")
    if owners:
        lines.append("## 建议分工")
        for o in owners:
            if isinstance(o, dict):
                lines.append(f"- **{o.get('role') or '—'}**：{o.get('action') or '—'}")
        lines.append("")
    if risks:
        lines.append("## 风险")
        for r in risks:
            lines.append(f"- {r}")
        lines.append("")
    if turns:
        lines.append("## 发言摘录")
        for i, t in enumerate(turns[:24], 1):
            code = str(t.get("agent_code") or "?").strip()
            text = str(t.get("text") or "").strip()
            if text:
                lines.append(f"{i}. **{code}**：{text}")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


# Backward-compatible alias (old Plan handoff wording removed from product).
def format_conclusion_for_plan(conclusion: dict[str, Any]) -> str:
    return format_conclusion_document(conclusion)


def deposit_meeting_conclusion_document(
    meeting_id: str,
    conclusion: dict[str, Any],
    *,
    turns: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Write conclusion markdown into user Asset Hub ``memory/episodic/``."""
    from datetime import datetime, timezone

    from evoflow.assets.hub import ensure_entity_tree, write_text_file
    from evoflow.assets.paths import EntityRef

    mid = str(meeting_id or "").strip()
    if not mid:
        return {"ok": False, "error": "missing meeting_id"}

    entity = EntityRef("user", "user")
    ensure_entity_tree(entity)

    summary = str(conclusion.get("summary") or "").strip()
    topic = str(conclusion.get("topic") or "").strip()
    title = summary or (topic[:48] if topic else "会议室方案")
    one_liner = (summary or title)[:30]
    body = format_conclusion_document(conclusion, meeting_id=mid, turns=turns)

    now = datetime.now(timezone.utc).astimezone()
    day = now.date().isoformat()
    mid_slug = re.sub(r"[^a-zA-Z0-9]+", "", mid)[-10:] or "meet"
    stamp = now.strftime("%H%M%S")
    rel = f"memory/episodic/{day}-meeting-{mid_slug}-{stamp}.md"
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Escape YAML-ish quotes in title/summary
    title_y = title.replace('"', "'")[:80]
    sum_y = one_liner.replace('"', "'")
    md = (
        f"---\n"
        f'title: "{title_y}"\n'
        f'summary: "{sum_y}"\n'
        f"kind: meeting-plan\n"
        f"meeting_id: {mid}\n"
        f"date: {day}\n"
        f"entity: user\n"
        f"entity_id: user\n"
        f"created_at: {created}\n"
        f"---\n\n"
        f"{body}"
    )
    written = write_text_file(entity, rel, md)
    return {
        "ok": True,
        "path": rel,
        "entity_type": "user",
        "entity_id": "user",
        "title": title,
        "written": written,
    }


def save_meeting_conclusion(meeting_id: str, conclusion: dict[str, Any], *, topic: str = "") -> None:
    from evoflow.persistence.db import get_db
    from evoflow.timeutil import utc_now_iso_z

    mid = str(meeting_id or "").strip()
    if not mid:
        return
    payload = json.dumps(conclusion, ensure_ascii=False)
    topic_s = str(topic or conclusion.get("topic") or "").strip()
    get_db().execute(
        """
        UPDATE evoflow_meetings
        SET conclusion_json = ?, topic = CASE WHEN ? != '' THEN ? ELSE topic END,
            updated_at = ?
        WHERE meeting_id = ?
        """,
        (payload, topic_s, topic_s, utc_now_iso_z(), mid),
    )
    get_db().commit()


async def conclude_meeting(meeting_id: str, *, topic: str = "") -> dict[str, Any]:
    """LLM-synthesize optimal plan, persist on meeting, deposit Asset Hub document."""
    from evoflow.a2a.orchestrator import get_meeting
    from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
    from evoflow.models import create_chat_model

    mid = str(meeting_id or "").strip()
    meeting = get_meeting(mid)
    if not meeting:
        return {"ok": False, "error": "meeting not found"}

    turns = list_meeting_speak_turns(mid)
    if not turns:
        return {"ok": False, "error": "尚无员工发言，无法汇总"}

    topic_s = str(topic or "").strip()
    if not topic_s:
        topic_s = str(meeting.get("topic") or "").strip()
    if not topic_s:
        topic_s = str(turns[-1].get("topic") or turns[0].get("topic") or "").strip()

    lines = [f"议题：{topic_s or '（未命名）'}", "", "发言记录："]
    for i, t in enumerate(turns[:24], 1):
        code = t.get("agent_code") or "?"
        lines.append(f"{i}. [{code}] {t.get('text')}")
    user = "\n".join(lines)

    try:
        model = create_chat_model(
            thinking_enabled=False,
            temperature=0.3,
            invocation_kind="meeting_conclude",
        )
        response = await ainvoke_internal_chat_model(
            model,
            [
                {"role": "system", "content": _CONCLUDE_SYSTEM},
                {"role": "user", "content": user},
            ],
        )
        raw = getattr(response, "content", None)
        if isinstance(raw, list):
            raw = "".join(
                str(b.get("text") or "") if isinstance(b, dict) else str(b) for b in raw
            )
        parsed = _parse_conclude_json(str(raw or ""))
    except Exception as e:
        logger.warning("meeting conclude LLM failed: %s", e, exc_info=True)
        blob = "；".join(t["text"] for t in turns[-6:])
        parsed = {
            "summary": f"综合 {len(turns)} 条发言",
            "plan": blob[:600],
            "steps": [],
            "risks": ["模型汇总失败，以上为发言摘录"],
            "owners": [],
        }

    conclusion = _normalize_conclusion(parsed, topic=topic_s)

    asset: dict[str, Any] = {}
    try:
        asset = deposit_meeting_conclusion_document(mid, conclusion, turns=turns)
        if asset.get("ok") and asset.get("path"):
            conclusion["asset_path"] = str(asset["path"])
            conclusion["asset_entity_type"] = str(asset.get("entity_type") or "user")
            conclusion["asset_entity_id"] = str(asset.get("entity_id") or "user")
            conclusion["asset_title"] = str(asset.get("title") or conclusion.get("summary") or "")
    except Exception as e:
        logger.warning("meeting conclude deposit failed: %s", e, exc_info=True)
        asset = {"ok": False, "error": str(e)}

    try:
        save_meeting_conclusion(mid, conclusion, topic=topic_s)
    except Exception:
        logger.debug("save meeting conclusion failed", exc_info=True)

    return {
        "ok": True,
        "meeting_id": mid,
        "conclusion": conclusion,
        "turn_count": len(turns),
        "asset": asset,
    }
