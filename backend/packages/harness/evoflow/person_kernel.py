"""Person Kernel helpers: identity / memory / metabolism / relations / craft (Phases A–E).

Design SSOT: ``internal design docs (not published in this repository)``.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_IDENTITY_HEADING = re.compile(
    r"(?im)^\s*(?:\*\*Identity\*\*|#{1,3}\s*Identity)\s*$"
)
_SECTION_HEADING = re.compile(
    r"(?im)^\s*(?:\*\*(?P<bold>[^*]+)\*\*|#{1,3}\s*(?P<hash>.+?))\s*$"
)
_LESSONS_HEADING = re.compile(
    r"(?im)^\s*(?:\*\*Lessons Learned\*\*|#{1,3}\s*Lessons Learned)\s*$"
)

_MAX_LESSON_CHARS = 400
_MAX_LESSONS_KEEP = 40
_MAX_JOURNAL_CHARS = 600
_PERSON_MEMORY_INJECT_LIMIT = 8
_PERSON_MEMORY_INJECT_CHARS = 1200


def extract_identity_block(soul_md: str) -> str:
    """Pull the Identity section body (re-wrapped with **Identity** heading)."""
    text = str(soul_md or "").replace("\r\n", "\n")
    if not text.strip():
        return ""
    match = _IDENTITY_HEADING.search(text)
    if not match:
        return ""
    start = match.end()
    rest = text[start:]
    next_heads = list(
        re.finditer(
            r"(?im)^\s*(?:\*\*(?:Core Traits|Communication|Growth|Lessons Learned)\*\*|"
            r"#{1,3}\s*(?:Core Traits|Communication|Growth|Lessons Learned))\s*$",
            rest,
        )
    )
    end = next_heads[0].start() if next_heads else len(rest)
    body = rest[:end].strip()
    if not body:
        return ""
    return f"**Identity**\n\n{body}".strip()


def extract_lessons_section(soul_md: str) -> str:
    text = str(soul_md or "").replace("\r\n", "\n")
    match = _LESSONS_HEADING.search(text)
    if not match:
        return ""
    rest = text[match.end() :]
    nxt = _SECTION_HEADING.search(rest)
    body_end = len(rest)
    if nxt:
        body_end = nxt.start()
    return rest[:body_end].strip()


def omit_identity_section(soul_md: str) -> str:
    """Drop the Identity section from soul text (file on disk unchanged).

    Product identity lives in ``<role>`` for the lead assistant; soul keeps traits/habits only.
    """
    text = str(soul_md or "").replace("\r\n", "\n")
    match = _IDENTITY_HEADING.search(text)
    if not match:
        return str(soul_md or "").strip()
    prefix = text[: match.start()].rstrip()
    rest = text[match.end() :]
    next_sec = None
    for m in _SECTION_HEADING.finditer(rest):
        title = (m.group("bold") or m.group("hash") or "").strip().lower()
        if title and title != "identity":
            next_sec = m
            break
    suffix = rest[next_sec.start() :].lstrip() if next_sec else ""
    parts = [p for p in (prefix, suffix) if p.strip()]
    return "\n\n".join(parts).strip()


def omit_lessons_learned_section(soul_md: str) -> str:
    """Drop the Lessons Learned section from soul text (file on disk unchanged).

    Past verification/timeout tips in Lessons Learned often re-steer the model into
    patrol loops; keep Core Traits / Communication in the inject, strip lessons.
    """
    text = str(soul_md or "").replace("\r\n", "\n")
    match = _LESSONS_HEADING.search(text)
    if not match:
        return str(soul_md or "").strip()
    prefix = text[: match.start()].rstrip()
    rest = text[match.end() :]
    next_sec = None
    for m in _SECTION_HEADING.finditer(rest):
        title = (m.group("bold") or m.group("hash") or "").strip().lower()
        if title and title != "lessons learned":
            next_sec = m
            break
    suffix = rest[next_sec.start() :].lstrip() if next_sec else ""
    parts = [p for p in (prefix, suffix) if p.strip()]
    return "\n\n".join(parts).strip()


def append_lesson_to_soul(soul_md: str, lesson: str, *, stamp: str) -> str:
    """Append one lesson bullet under Lessons Learned; create section if missing."""
    lesson_s = " ".join(str(lesson or "").strip().split())
    if not lesson_s:
        return str(soul_md or "")
    if len(lesson_s) > _MAX_LESSON_CHARS:
        lesson_s = lesson_s[: _MAX_LESSON_CHARS - 1] + "…"
    bullet = f"- [{stamp}] {lesson_s}"

    text = str(soul_md or "").replace("\r\n", "\n").rstrip()
    match = _LESSONS_HEADING.search(text)
    if not match:
        if text:
            text = text + "\n\n"
        return text + f"**Lessons Learned**\n\n{bullet}\n"

    prefix = text[: match.start()].rstrip()
    rest = text[match.end() :]
    next_sec = None
    for m in _SECTION_HEADING.finditer(rest):
        title = (m.group("bold") or m.group("hash") or "").strip().lower()
        if title and title != "lessons learned":
            if title in {
                "identity",
                "core traits",
                "communication",
                "growth",
            } or m.group(0).lstrip().startswith("#"):
                next_sec = m
                break
    if next_sec:
        body = rest[: next_sec.start()]
        suffix = rest[next_sec.start() :]
    else:
        body = rest
        suffix = ""

    lines = [ln for ln in body.strip().splitlines() if ln.strip()]
    lines = [
        ln
        for ln in lines
        if not re.match(r"(?i)^_?\(?(mistakes|insights|none|暂无|空).*$", ln.strip())
    ]
    lines.append(bullet)
    if len(lines) > _MAX_LESSONS_KEEP:
        lines = lines[-_MAX_LESSONS_KEEP :]
    body_out = "\n".join(lines)
    parts = []
    if prefix:
        parts.append(prefix)
    parts.append("**Lessons Learned**\n\n" + body_out)
    if suffix.strip():
        parts.append(suffix.strip())
    return "\n\n".join(parts) + "\n"


def derive_lesson_from_wrap_up(
    *,
    reflection: str = "",
    outcome: str = "",
    observations: list[str] | None = None,
) -> str:
    """Heuristic lesson text for Phase A (no extra LLM call)."""
    ref = str(reflection or "").strip()
    out = str(outcome or "").strip()
    obs = [str(o).strip() for o in (observations or []) if str(o).strip()]

    raw = ref or out or (obs[0] if obs else "")
    if not raw:
        return "本轮无新教训（收工未提供反思/产出摘要）。"

    one_line = " ".join(raw.split())
    if len(one_line) > _MAX_LESSON_CHARS:
        one_line = one_line[: _MAX_LESSON_CHARS - 1] + "…"
    return one_line


def derive_journal_from_wrap_up(
    *,
    reflection: str = "",
    outcome: str = "",
    observations: list[str] | None = None,
    goal: str = "",
) -> str:
    """Shift mind-journal line for person_memory (about self, not the user)."""
    parts: list[str] = []
    g = " ".join(str(goal or "").strip().split())
    if g:
        parts.append(f"本轮目标：{g[:120]}")
    out = " ".join(str(outcome or "").strip().split())
    if out:
        parts.append(f"产出：{out[:200]}")
    ref = " ".join(str(reflection or "").strip().split())
    if ref:
        parts.append(f"反思：{ref[:200]}")
    obs = [str(o).strip() for o in (observations or []) if str(o).strip()]
    if obs and not ref:
        parts.append(f"观察：{obs[0][:160]}")
    if not parts:
        return "本轮值班已收工，暂无详细心智日记。"
    text = "；".join(parts)
    if len(text) > _MAX_JOURNAL_CHARS:
        text = text[: _MAX_JOURNAL_CHARS - 1] + "…"
    return text


def ensure_agent_identity(agent_code: str, soul_md: str | None = None) -> str:
    """Return identity_md; backfill from soul once if empty."""
    from evoflow.persistence import config_repositories as cfg_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return ""
    existing = cfg_repo.get_agent_identity(code) or ""
    if existing.strip():
        return existing.strip()
    soul = soul_md if soul_md is not None else (cfg_repo.get_agent_soul(code) or "")
    extracted = extract_identity_block(soul)
    if extracted:
        cfg_repo.save_agent_identity(code, extracted, source="backfill")
        return extracted
    return ""


def record_wrap_up_lesson(
    agent_code: str,
    *,
    reflection: str = "",
    outcome: str = "",
    observations: list[str] | None = None,
    round_id: str = "",
) -> dict[str, Any]:
    """Append a lesson to agent soul_md and write changelog. Never touches identity_md."""
    from datetime import datetime, timezone

    from evoflow.persistence import config_repositories as cfg_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return {"ok": False, "error": "missing agent_code"}

    lesson = derive_lesson_from_wrap_up(
        reflection=reflection, outcome=outcome, observations=observations
    )
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    old_soul = cfg_repo.get_agent_soul(code) or ""
    new_soul = append_lesson_to_soul(old_soul, lesson, stamp=stamp)
    if new_soul == old_soul:
        return {"ok": True, "changed": False, "lesson": lesson}

    cfg_repo.save_agent_soul(code, new_soul)
    evidence = {
        "round_id": round_id,
        "reflection": (reflection or "")[:200],
        "outcome": (outcome or "")[:200],
    }
    cfg_repo.append_soul_changelog(
        code,
        field="lessons_learned",
        old_value=extract_lessons_section(old_soul)[:500],
        new_value=lesson,
        reason="proactive wrap_up lesson",
        evidence=evidence,
        source="wrap_up",
        approved_by="system",
    )
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
        if role and (role.config.soul_md or "").strip():
            role.config.soul_md = append_lesson_to_soul(
                role.config.soul_md, lesson, stamp=stamp
            )
            saver = getattr(ProactiveRepository, "save_role", None) or getattr(
                ProactiveRepository, "upsert_role", None
            )
            if callable(saver):
                saver(role)
    except Exception:
        logger.debug("wrap_up: role soul sync skipped", exc_info=True)

    return {"ok": True, "changed": True, "lesson": lesson}


def record_wrap_up_person_memory(
    agent_code: str,
    *,
    reflection: str = "",
    outcome: str = "",
    observations: list[str] | None = None,
    goal: str = "",
    round_id: str = "",
    source: str = "wrap_up",
) -> dict[str, Any]:
    """Write a journal entry about this agent's own shift (never into user memory)."""
    from evoflow.persistence import person_memory_repositories as pm_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return {"ok": False, "error": "missing agent_code"}

    journal = derive_journal_from_wrap_up(
        reflection=reflection,
        outcome=outcome,
        observations=observations,
        goal=goal,
    )
    importance = 0.55
    if str(reflection or "").strip():
        importance = 0.72
    elif str(outcome or "").strip():
        importance = 0.62

    eid = pm_repo.insert_person_memory(
        code,
        journal,
        layer="journal",
        importance=importance,
        vitality=1.0,
        round_id=round_id,
        source=str(source or "wrap_up")[:80],
    )
    if not eid:
        return {"ok": False, "error": "insert_failed"}

    episodic_id = None
    ref = " ".join(str(reflection or "").strip().split())
    out = " ".join(str(outcome or "").strip().split())
    if ref and out and ref != out:
        episodic_id = pm_repo.insert_person_memory(
            code,
            f"经历：{ref[:400]}",
            layer="episodic",
            importance=min(0.85, importance + 0.08),
            vitality=1.0,
            round_id=round_id,
            source="wrap_up",
        )

    return {
        "ok": True,
        "journal_id": eid,
        "episodic_id": episodic_id,
        "content": journal,
    }


def format_identity_prompt_block(identity_md: str) -> str:
    text = str(identity_md or "").strip()
    if not text:
        return ""
    return (
        "<identity>\n"
        "<!-- L0 IDENTITY — READ-ONLY hard boundaries. Never renegotiate or soft-pedal. -->\n"
        f"{text}\n"
        "</identity>\n"
    )


def format_soul_prompt_block(
    soul_md: str,
    *,
    max_chars: int = 1800,
    omit_identity: bool = False,
    omit_lessons_learned: bool = False,
) -> str:
    """L1 soul inject; truncate long souls (Phase F core cap)."""
    text = str(soul_md or "").strip()
    if not text:
        return ""
    if omit_identity:
        text = omit_identity_section(text)
        if not text:
            return ""
    if omit_lessons_learned:
        text = omit_lessons_learned_section(text)
        if not text:
            return ""
    if max_chars > 0 and len(text) > max_chars:
        text = text[: max_chars - 1].rstrip() + "…\n<!-- soul truncated; details in archival -->"
    return (
        "<soul>\n"
        "<!-- L1 — communication/work habits only; reference, not standing orders. "
        "Do not resume old verification/patrol lessons unless the user asks. -->\n"
        f"{text}\n"
        "</soul>\n"
    )


def format_standing_summary_block(agent_code: str | None) -> str:
    """Pin newest core standing summary (duty LLM state_summary) for tomorrow's self."""
    code = str(agent_code or "").strip().lower()
    if not code:
        return ""
    try:
        from evoflow.persistence import person_memory_repositories as pm_repo

        rows = pm_repo.list_person_memory(code, limit=24, layer="semantic_self")
    except Exception:
        logger.debug("format_standing_summary_block failed", exc_info=True)
        return ""
    best: dict[str, Any] | None = None
    for r in rows:
        src = str(r.get("source") or "")
        if src.endswith(":state_summary"):
            best = r
            break
    if best is None:
        for r in rows:
            if str(r.get("access_tier") or "") == "core":
                best = r
                break
    if not best:
        return ""
    text = str(best.get("content") or "").strip()
    if not text:
        return ""
    return (
        "<standing_summary>\n"
        "<!-- 跨班次站立摘要：背景参考。用户本轮没点名则不要续跑、重开或复查其中的旧任务。 -->\n"
        f"{text[:320]}\n"
        "</standing_summary>\n"
    )


def format_person_presence_block(
    agent_code: str | None = None,
    *,
    for_duty: bool = False,
) -> str:
    """Workplace continuous-person stance (not companion drama).

    Inject on duty and chat so the model acts as the same subject across shifts.
    ``for_duty=True`` keeps patrol/handoff language; chat uses a softer colleague stance
    so user conversation is not forced into「巡检收工」.
    """
    standing = ""
    # Chat must not ingest duty standing summaries — they look like open work and
    # make the model re-run yesterday's verification / patrol.
    if agent_code and for_duty:
        standing = format_standing_summary_block(agent_code)
    if for_duty:
        stance = (
            "<person_presence>\n"
            "你是跨班次连续存在的职场同事（Person），不是无状态工具函数。\n"
            "本班岗位合同（DutyMask）决定你做什么；人格账本决定你是谁、记得什么。\n"
            "纪律：\n"
            "1. 动手前先扫自传 / 本事 / 开放承诺 / 站立摘要；相关则用第一人称点名承接"
            "（「上次…这次…」），一两句即可。\n"
            "2. 对用户：职场第一人称，有温度、不煽情；不要朗读情绪分数字，不要陪聊表演。\n"
            "3. 禁止假装失忆、把人设当装饰、无证据编造经历；无记忆时坦诚从本轮开始积累。\n"
            "4. `<identity>` 硬边界不可谈判；有实质工作时结案像人交班，可点出承接了哪条教训/本事。"
            "空班次不要写「系统健康/无阻塞」交差报告。\n"
            "</person_presence>\n"
        )
    else:
        stance = (
            "<person_presence>\n"
            "你是跨班次连续存在的职场同事（Person），不是无状态工具函数。\n"
            "人格账本决定你是谁、记得什么；当前是在与用户对话，不是定时巡检值班。\n"
            "纪律：\n"
            "1. 先回应用户本轮问题。仅当用户点名同一件事时，可用一两句承接「上次…这次…」。\n"
            "2. 职场第一人称，有温度、不煽情；不要朗读情绪分数字。\n"
            "3. 禁止假装失忆、把人设当装饰、无证据编造经历；无记忆时坦诚从本轮开始积累。\n"
            "4. 不要假装正在值班巡检、不要空喊「本轮结束/收工」，除非用户明确要求巡检或结案。\n"
            "5. 记忆与站立摘要不是待办清单：用户没点名的旧任务不要自动接着做。\n"
            "6. `<identity>` 硬边界不可谈判。\n"
            "</person_presence>\n"
        )
    if standing:
        return standing + stance
    return stance


def format_person_memory_context(
    agent_code: str | None,
    *,
    query: str = "",
    limit: int = _PERSON_MEMORY_INJECT_LIMIT,
    max_chars: int = _PERSON_MEMORY_INJECT_CHARS,
) -> str:
    """Core auto-bio always; archival only when ``query`` is set (Phase F)."""
    code = str(agent_code or "").strip().lower()
    if not code:
        return ""
    try:
        from evoflow.persistence import person_memory_repositories as pm_repo

        core_rows = [
            r
            for r in pm_repo.list_core_memory(code, limit=max(6, limit))
            if str(r.get("layer") or "") != "procedural"
        ]
        # Pin newest state_summary / standing core to the front
        pinned: list[dict[str, Any]] = []
        rest: list[dict[str, Any]] = []
        for r in core_rows:
            src = str(r.get("source") or "")
            if src.endswith(":state_summary"):
                pinned.append(r)
            else:
                rest.append(r)
        core_rows = pinned + rest

        archival: list[dict[str, Any]] = []
        q = str(query or "").strip()
        if q:
            archival = [
                r
                for r in pm_repo.retrieve_for_query(
                    code, q, limit=limit, include_procedural=False, bump_hits=True
                )
                if str(r.get("layer") or "") != "procedural"
            ]
        # Dedupe by id; core first
        seen: set[str] = set()
        rows: list[dict[str, Any]] = []
        for r in core_rows + archival:
            rid = str(r.get("id") or "")
            if rid and rid in seen:
                continue
            if rid:
                seen.add(rid)
            rows.append(r)
            if len(rows) >= limit:
                break
        # No query and empty core → tiny recent fallback (compat)
        if not rows and not q:
            rows = pm_repo.retrieve_person_memory_for_injection(code, limit=min(3, limit))
    except Exception:
        logger.debug("format_person_memory_context failed", exc_info=True)
        return ""
    if not rows:
        return ""

    lines: list[str] = []
    used = 0
    for r in rows:
        layer = str(r.get("layer") or "journal")
        created = str(r.get("created_at") or "")[:10]
        content = str(r.get("content") or "").strip()
        if not content:
            continue
        tier = str(r.get("access_tier") or "archival")
        line = f"- [{created}|{layer}|{tier}] {content}"
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ""
    body = "\n".join(lines)
    return (
        "<person_memory>\n"
        "<!-- AUTOBIOGRAPHICAL — about THIS agent. Read first, use when relevant; "
        "never confuse with <memory> (about the user). Do not invent missing entries. -->\n"
        f"{body}\n"
        "</person_memory>\n"
    )


def _build_latest_wrap_up(person_memory: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick the newest LLM duty wrap-up journal + same-round companions."""
    journals = [
        r
        for r in person_memory
        if str(r.get("layer") or "") == "journal"
        and (
            "llm" in str(r.get("source") or "").lower()
            or str(r.get("source") or "") in {"duty_auto", "wrap_up", "duty_llm", "wrap_up_llm"}
        )
    ]
    if not journals:
        # fallback: newest journal with mood evidence
        journals = [
            r
            for r in person_memory
            if str(r.get("layer") or "") == "journal"
            and isinstance(r.get("evidence"), dict)
            and (r.get("evidence") or {}).get("mood")
        ]
    if not journals:
        return None
    journals.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    j = journals[0]
    rid = str(j.get("round_id") or "").strip()
    ev = j.get("evidence") if isinstance(j.get("evidence"), dict) else {}
    state_summary = ""
    insights: list[dict[str, Any]] = []
    for r in person_memory:
        if rid and str(r.get("round_id") or "").strip() != rid:
            continue
        src = str(r.get("source") or "")
        layer = str(r.get("layer") or "")
        if layer == "semantic_self" and src.endswith(":state_summary"):
            state_summary = str(r.get("content") or "").strip()
        elif layer == "semantic_self" and (
            src.endswith(":insight") or str(r.get("content") or "").startswith("反思洞察")
        ):
            insights.append(
                {
                    "id": r.get("id"),
                    "text": str(r.get("content") or "").strip(),
                    "created_at": r.get("created_at"),
                }
            )
    return {
        "journal_id": j.get("id"),
        "round_id": rid,
        "source": str(j.get("source") or ""),
        "created_at": j.get("created_at"),
        "journal": str(j.get("content") or "").strip(),
        "mood": str(ev.get("mood") or "").strip(),
        "arc_label": str(ev.get("arc_label") or "").strip(),
        "poignancy": ev.get("poignancy"),
        "unresolved": list(ev.get("unresolved") or [])
        if isinstance(ev.get("unresolved"), list)
        else [],
        "state_summary": state_summary,
        "insights": insights[:6],
    }


def get_growth_snapshot(
    agent_code: str,
    *,
    changelog_limit: int = 30,
    person_memory_limit: int = 20,
    timeline_limit: int = 40,
) -> dict[str, Any]:
    from datetime import datetime

    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence import person_memory_repositories as pm_repo
    from evoflow.persistence import person_metabolism_repositories as meta_repo
    from evoflow.timeutil import BEIJING_TZ

    code = str(agent_code or "").strip().lower()
    identity = cfg_repo.get_agent_identity(code) or ""
    soul = cfg_repo.get_agent_soul(code) or ""
    lessons = extract_lessons_section(soul)
    changelog = cfg_repo.list_soul_changelog(code, limit=changelog_limit)
    # Pull a wider window then partition for §13.1 growth contract
    fetch_n = max(int(person_memory_limit), int(timeline_limit), 40)
    person_memory = pm_repo.list_person_memory(code, limit=max(fetch_n * 2, 80))
    today = datetime.now(BEIJING_TZ).date().isoformat()
    person_state = meta_repo.get_person_state(code, today)
    dream_log = meta_repo.get_dream_log(code, today)
    proposals = meta_repo.list_evolution_proposals(code, limit=20)
    from evoflow.persistence import person_relations_repositories as rel_repo

    craft_all = pm_repo.list_craft(code, limit=30)
    craft_active = [
        r
        for r in craft_all
        if str(r.get("status") or "") in {"proposed", "corrected", "graduated"}
    ]
    meta = (person_state or {}).get("meta")
    if not isinstance(meta, dict):
        meta = {}
    try:
        poignancy = float(meta.get("poignancy") or 0.0)
    except (TypeError, ValueError):
        poignancy = 0.0
    latest_wrap = _build_latest_wrap_up(person_memory)

    timeline: list[dict[str, Any]] = []
    semantic_self: list[dict[str, Any]] = []
    for r in person_memory:
        layer = str(r.get("layer") or "").strip().lower()
        if layer in {"journal", "episodic"}:
            timeline.append(r)
        elif layer in {"semantic_self", "semantic"}:
            semantic_self.append(r)
    timeline = timeline[: max(1, int(timeline_limit))]
    semantic_self = semantic_self[: max(1, int(person_memory_limit))]
    # Compact rows for UI (keep evidence out of huge payloads)
    def _compact(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row.get("id"),
            "layer": row.get("layer"),
            "kind": row.get("kind"),
            "title": row.get("title") or "",
            "content": row.get("content") or "",
            "created_at": row.get("created_at") or "",
            "updated_at": row.get("updated_at") or "",
            "importance": row.get("importance"),
            "access_tier": row.get("access_tier") or "",
            "source": row.get("source") or "",
            "status": row.get("status") or "",
            "pin": bool(str(row.get("access_tier") or "") == "core"),
        }

    open_count = rel_repo.count_open_commitments(code)
    draft_n = meta_repo.count_open_draft_proposals(code)
    overview = {
        "journal_count": len([r for r in person_memory if str(r.get("layer") or "") in {"journal", "episodic"}]),
        "craft_count": len(craft_active),
        "craft_graduated_count": pm_repo.count_craft(code, status="graduated"),
        "open_commitments": open_count,
        "pending_proposals": draft_n,
        "affect_brief": rel_repo.get_affect(code),
        "semantic_count": len(semantic_self),
    }

    return {
        "agent_code": code,
        "identity_md": identity,
        "soul_md": soul,
        "lessons": lessons,
        "changelog": changelog,
        "person_memory": person_memory[:person_memory_limit],
        "person_memory_count": pm_repo.count_person_memory(code),
        # §13.1 partitioned contract
        "overview": overview,
        "timeline": [_compact(r) for r in timeline],
        "semantic_self": [_compact(r) for r in semantic_self],
        "identity_pin": {
            "identity_md_preview": (identity or "")[:800],
            "soul_brief": (lessons or soul or "")[:600],
        },
        "person_state": person_state,
        "dream_log": dream_log,
        "proposals": proposals,
        "draft_proposal_count": draft_n,
        "affect": rel_repo.get_affect(code),
        "relations": rel_repo.list_relations(code, limit=12),
        "open_commitments": rel_repo.list_open_commitments(code, as_to=True, limit=12),
        "open_commitment_count": open_count,
        "craft": craft_active,
        "craft_graduated_count": pm_repo.count_craft(code, status="graduated"),
        "craft_proposed_count": pm_repo.count_craft(code, status="proposed"),
        "poignancy": poignancy,
        "last_reflection_at": str(meta.get("last_reflection_at") or ""),
        "last_reflection_theme": str(meta.get("last_reflection_theme") or ""),
        "latest_wrap_up": latest_wrap,
        "growth_views": ["timeline", "craft", "semantic", "identity"],
        "memory_edit_enabled": False,  # §13.5: growth page default read-only
    }


def _beijing_today() -> str:
    from datetime import datetime

    from evoflow.timeutil import BEIJING_TZ

    return datetime.now(BEIJING_TZ).date().isoformat()


def run_morning_check(agent_code: str, *, force: bool = False) -> dict[str, Any]:
    """Removed: morning check is no longer a product surface.

    Kept as a no-op stub so old callers / scripts fail soft.
    """
    del force
    today = _beijing_today()
    return {
        "ok": True,
        "skipped": True,
        "reason": "morning_check_removed",
        "as_of_date": today,
        "agent_code": str(agent_code or "").strip().lower(),
        "stance_md": "",
    }


def format_morning_stance_block(agent_code: str | None) -> str:
    """Removed with morning check; always empty."""
    del agent_code
    return ""


def run_night_dream(agent_code: str, *, force: bool = False) -> dict[str, Any]:
    """Removed: night dream is no longer scheduled or exposed.

    Consolidation / reflection now runs via wrap_up poignancy → run_reflection.
    """
    del force
    today = _beijing_today()
    return {
        "ok": True,
        "skipped": True,
        "reason": "night_dream_removed",
        "as_of_date": today,
        "agent_code": str(agent_code or "").strip().lower(),
        "summary_md": "",
        "proposal_id": None,
        "semantic_ids": [],
    }


def _heuristic_theme(texts: list[str]) -> str:
    """Pick a recurring 2–6 char Chinese/token fragment from journals."""
    import re
    from collections import Counter

    blob = "\n".join(texts)
    # Prefer quoted /「」 themes and repeated CJK bigrams
    quoted = re.findall(r"[「『]([^」』]{2,12})[」』]", blob)
    if quoted:
        return Counter(quoted).most_common(1)[0][0]
    tokens = re.findall(r"[\u4e00-\u9fff]{2,6}", blob)
    stop = {
        "本轮目标",
        "本轮值班",
        "暂无详细",
        "产出",
        "反思",
        "观察",
        "心智日记",
        "工作汇报",
    }
    counts: Counter[str] = Counter()
    for t in tokens:
        if t in stop or len(t) < 2:
            continue
        counts[t] += 1
    for tok, n in counts.most_common(12):
        if n >= 2:
            return tok
    return ""


def approve_evolution_proposal(
    proposal_id: str,
    *,
    resolved_by: str = "user",
) -> dict[str, Any]:
    """Apply draft patch to soul (Lessons only in Phase C) + changelog."""
    from datetime import datetime, timezone

    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence import person_metabolism_repositories as meta_repo

    prop = meta_repo.get_evolution_proposal(proposal_id)
    if not prop:
        return {"ok": False, "error": "not_found"}
    if str(prop.get("status") or "") != "draft":
        return {"ok": False, "error": "not_draft", "status": prop.get("status")}

    code = str(prop.get("agent_code") or "").strip().lower()
    patch = prop.get("patch") if isinstance(prop.get("patch"), dict) else {}
    action = str(patch.get("action") or "").strip()
    applied = False
    if action == "append_lesson":
        lesson = str(patch.get("lesson") or "").strip()
        if lesson:
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            old = cfg_repo.get_agent_soul(code) or ""
            new = append_lesson_to_soul(old, lesson, stamp=stamp)
            if new != old:
                cfg_repo.save_agent_soul(code, new)
                cfg_repo.append_soul_changelog(
                    code,
                    field="lessons_learned",
                    old_value=extract_lessons_section(old)[:500],
                    new_value=lesson,
                    reason=f"approved proposal {proposal_id}",
                    evidence=prop.get("evidence") or [],
                    source="evolution_approve",
                    approved_by=resolved_by,
                )
                applied = True

    updated = meta_repo.resolve_evolution_proposal(
        proposal_id, status="approved", resolved_by=resolved_by
    )
    return {
        "ok": True,
        "applied": applied,
        "proposal": updated,
    }


def reject_evolution_proposal(
    proposal_id: str,
    *,
    resolved_by: str = "user",
) -> dict[str, Any]:
    from evoflow.persistence import person_metabolism_repositories as meta_repo

    prop = meta_repo.get_evolution_proposal(proposal_id)
    if not prop:
        return {"ok": False, "error": "not_found"}
    if str(prop.get("status") or "") != "draft":
        return {"ok": False, "error": "not_draft", "status": prop.get("status")}
    updated = meta_repo.resolve_evolution_proposal(
        proposal_id, status="rejected", resolved_by=resolved_by
    )
    return {"ok": True, "applied": False, "proposal": updated}


# ── Phase D: relations + workplace affect ─────────────────────────────

_AFFECT_EVENTS: dict[str, dict[str, float]] = {
    "handoff_sent": {"connection": 0.04, "pressure": 0.03, "energy": -0.02},
    "handoff_received": {"pressure": 0.06, "curiosity": 0.03, "energy": -0.03},
    "handoff_fulfilled": {
        "confidence": 0.05,
        "connection": 0.04,
        "frustration": -0.05,
        "pressure": -0.04,
    },
    "wake_peer": {"connection": 0.03, "curiosity": 0.02},
    "woken_by_peer": {"pressure": 0.04, "energy": -0.02},
    "wrap_up_ok": {"confidence": 0.03, "energy": -0.04, "frustration": -0.02},
    "morning_decay": {
        "pressure": -0.03,
        "frustration": -0.02,
        "energy": 0.04,
        "curiosity": 0.01,
    },
}


def update_affect_from_event(agent_code: str, event: str) -> dict[str, Any]:
    """Apply small workplace affect deltas. Never dramatic; axes stay in [0,1]."""
    from evoflow.persistence import person_relations_repositories as rel_repo

    code = str(agent_code or "").strip().lower()
    if not code or code in {"user", "system"}:
        return {"ok": False, "skipped": True}
    cur = rel_repo.get_affect(code)
    deltas = _AFFECT_EVENTS.get(str(event or "").strip(), {})
    if not deltas:
        return {"ok": True, "skipped": True, "affect": cur}
    axes = {
        k: float(cur.get(k, 0.5))
        for k in (
            "curiosity",
            "confidence",
            "pressure",
            "connection",
            "frustration",
            "energy",
        )
    }
    for k, d in deltas.items():
        if k in axes:
            axes[k] = float(axes[k]) + float(d)
    rel_repo.save_affect(code, axes, meta={"last_event": event})
    return {"ok": True, "affect": rel_repo.get_affect(code), "event": event}


def on_handoff_dispatched(
    *,
    from_agent: str,
    to_agent: str,
    parent_task_id: str = "",
    child_task_id: str = "",
    note: str = "",
) -> dict[str, Any]:
    """Formal handoff success: bond + open commitment + affect."""
    from evoflow.persistence import person_relations_repositories as rel_repo

    fr = str(from_agent or "").strip().lower()
    to = str(to_agent or "").strip().lower()
    if not to:
        return {"ok": False, "error": "missing to_agent"}
    if fr and fr not in {"user", "system"}:
        rel_repo.upsert_relation_edge(fr, to, bond_delta=0.06, last_event="handoff_sent")
        rel_repo.upsert_relation_edge(to, fr, bond_delta=0.05, last_event="handoff_received")
        update_affect_from_event(fr, "handoff_sent")
    else:
        rel_repo.upsert_relation_edge(to, "user", bond_delta=0.03, last_event="handoff_from_user")
    update_affect_from_event(to, "handoff_received")
    cid = rel_repo.open_commitment(
        from_agent=fr or "user",
        to_agent=to,
        kind="handoff",
        parent_task_id=parent_task_id,
        child_task_id=child_task_id,
        note=note or "正式交工",
    )
    try:
        if fr and fr not in {"user", "system"}:
            record_relation_memo(
                agent_code=fr,
                peer_code=to,
                event="交工派出",
                note=note,
                child_task_id=child_task_id,
            )
        record_relation_memo(
            agent_code=to,
            peer_code=fr or "user",
            event="收到交工",
            note=note,
            child_task_id=child_task_id,
        )
        add_poignancy(to, 0.2, reason="handoff_received", maybe_reflect=False)
    except Exception:
        logger.debug("relation memo on handoff skipped", exc_info=True)
    return {"ok": True, "commitment_id": cid}


def on_handoff_fulfilled(
    *,
    child_task_id: str,
    child_agent: str = "",
    upstream_agent: str = "",
) -> dict[str, Any]:
    """Child terminal → close commitments + positive affect."""
    from evoflow.persistence import person_relations_repositories as rel_repo

    closed = rel_repo.close_commitments_for_child(
        child_task_id, note="下游已结案回执"
    )
    child = str(child_agent or "").strip().lower()
    up = str(upstream_agent or "").strip().lower()
    if child:
        update_affect_from_event(child, "handoff_fulfilled")
    if up and up not in {"user", "system"}:
        update_affect_from_event(up, "handoff_fulfilled")
        if child:
            rel_repo.upsert_relation_edge(
                child, up, bond_delta=0.04, last_event="handoff_fulfilled"
            )
            rel_repo.upsert_relation_edge(up, child, bond_delta=0.03, last_event="receipt")
    try:
        if child:
            record_relation_memo(
                agent_code=child,
                peer_code=up or "user",
                event="交工已兑现",
                note="下游结案回执",
                child_task_id=child_task_id,
            )
            add_poignancy(child, 0.15, reason="handoff_fulfilled", maybe_reflect=False)
        if up and up not in {"user", "system"}:
            record_relation_memo(
                agent_code=up,
                peer_code=child or "peer",
                event="收到下游回执",
                note="承诺关闭",
                child_task_id=child_task_id,
            )
    except Exception:
        logger.debug("relation memo on fulfill skipped", exc_info=True)
    return {"ok": True, "closed": closed}


def on_peer_wake(*, from_agent: str, to_agent: str, source: str = "") -> dict[str, Any]:
    """Employee↔employee wake/dispatch (not formal handoff)."""
    from evoflow.persistence import person_relations_repositories as rel_repo

    fr = str(from_agent or "").strip().lower()
    to = str(to_agent or "").strip().lower()
    if not fr or not to or fr == to:
        return {"ok": False, "skipped": True}
    if fr in {"user", "system"}:
        return {"ok": True, "skipped": True, "reason": "human_or_system"}
    src = str(source or "").strip().lower()
    rel_repo.upsert_relation_edge(
        fr, to, bond_delta=0.03, last_event=f"wake:{src or 'peer'}"
    )
    rel_repo.upsert_relation_edge(to, fr, bond_delta=0.02, last_event="woken")
    update_affect_from_event(fr, "wake_peer")
    update_affect_from_event(to, "woken_by_peer")
    try:
        record_relation_memo(
            agent_code=fr,
            peer_code=to,
            event=f"叫醒:{src or 'peer'}",
        )
        record_relation_memo(
            agent_code=to,
            peer_code=fr,
            event="被叫醒",
        )
    except Exception:
        logger.debug("relation memo on peer wake skipped", exc_info=True)
    return {"ok": True}


def format_affect_and_commitments_block(agent_code: str | None) -> str:
    """Short duty-brief inject: affect axes + open commitment count."""
    from evoflow.persistence import person_relations_repositories as rel_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return ""
    aff = rel_repo.get_affect(code)
    opens = rel_repo.list_open_commitments(code, as_to=True, limit=5)
    axes = (
        f"好奇 {aff.get('curiosity', 0.5):.2f} · "
        f"把握 {aff.get('confidence', 0.5):.2f} · "
        f"压力 {aff.get('pressure', 0.3):.2f} · "
        f"连结 {aff.get('connection', 0.5):.2f} · "
        f"受挫 {aff.get('frustration', 0.15):.2f} · "
        f"精力 {aff.get('energy', 0.65):.2f}"
    )
    lines = [
        "\n### 职场情绪态与开放承诺（内部）",
        axes,
    ]
    if opens:
        lines.append(f"开放承诺 {len(opens)} 条（优先兑现，勿遗忘上游交工）：")
        for c in opens[:4]:
            fr = str(c.get("from_agent") or "")
            kind = str(c.get("kind") or "handoff")
            child = str(c.get("child_task_id") or "")[:20]
            lines.append(
                f"- 欠 {fr} · {kind}" + (f" · task `{child}`" if child else "")
            )
    else:
        lines.append("开放承诺：无")
    pressure = float(aff.get("pressure") or 0.3)
    energy = float(aff.get("energy") or 0.65)
    if pressure >= 0.7:
        lines.append("提示：压力偏高 → 本轮聚焦最高优先级事项，必要时向上游澄清。")
    if energy <= 0.35:
        lines.append("提示：精力偏低 → 控制范围，优先收口与汇报，勿新开大项。")
    return "\n".join(lines) + "\n"


def desensitized_person_brief(agent_code: str) -> dict[str, Any]:
    """For Xiaomi / org overview — no journal / stance / lessons / craft body."""
    from evoflow.persistence import person_memory_repositories as pm_repo
    from evoflow.persistence import person_relations_repositories as rel_repo

    code = str(agent_code or "").strip().lower()
    aff = rel_repo.get_affect(code)
    opens = rel_repo.count_open_commitments(code)
    rels = rel_repo.list_relations(code, limit=5)

    def _bucket(v: float) -> str:
        if v >= 0.7:
            return "偏高"
        if v <= 0.35:
            return "偏低"
        return "平稳"

    return {
        "affect_summary": {
            "pressure": _bucket(float(aff.get("pressure") or 0.3)),
            "energy": _bucket(float(aff.get("energy") or 0.65)),
            "confidence": _bucket(float(aff.get("confidence") or 0.55)),
            "frustration": _bucket(float(aff.get("frustration") or 0.15)),
        },
        "open_commitment_count": opens,
        "relation_highlights": [
            {
                "peer": str(r.get("peer_code") or ""),
                "bond_tier": (
                    "强"
                    if float(r.get("bond") or 0) >= 0.65
                    else ("弱" if float(r.get("bond") or 0) < 0.35 else "中")
                ),
                "last_event": str(r.get("last_event") or "")[:40],
            }
            for r in rels[:4]
        ],
        "craft_summary": {
            "graduated_count": pm_repo.count_craft(code, status="graduated"),
            "proposed_count": pm_repo.count_craft(code, status="proposed"),
        },
    }


# ── Phase E: procedural craft (auto graduate, no human approval) ─────────

_MAX_CRAFT_CHARS = 500
_PERSON_CRAFT_INJECT_CHARS = 800


def derive_craft_from_wrap_up(
    *,
    reflection: str = "",
    outcome: str = "",
    observations: list[str] | None = None,
    goal: str = "",
    incomplete: bool = False,
) -> dict[str, str]:
    """Derive a short howto / negative craft card from wrap_up fields."""
    ref = " ".join(str(reflection or "").strip().split())
    out = " ".join(str(outcome or "").strip().split())
    g = " ".join(str(goal or "").strip().split())
    obs = [str(o).strip() for o in (observations or []) if str(o).strip()]
    theme = _heuristic_theme([ref, out, g] + obs[:2]) or (g[:16] if g else "") or "本岗流程"
    if incomplete:
        body = ref or out or (obs[0] if obs else "") or "本轮未完整收口，下次先核对前置条件。"
        return {
            "title": f"避坑：{theme}"[:80],
            "kind": "negative",
            "content": f"负约束 · {theme}：{body}"[:_MAX_CRAFT_CHARS],
        }
    steps = ref or out or (obs[0] if obs else "")
    if not steps:
        return {
            "title": f"做法：{theme}"[:80],
            "kind": "howto",
            "content": f"做法 · {theme}：收工时记录本轮有效步骤，下次同类任务优先复用。"[:_MAX_CRAFT_CHARS],
        }
    return {
        "title": f"做法：{theme}"[:80],
        "kind": "howto",
        "content": f"做法 · {theme}：{steps}"[:_MAX_CRAFT_CHARS],
    }


def record_wrap_up_craft(
    agent_code: str,
    *,
    reflection: str = "",
    outcome: str = "",
    observations: list[str] | None = None,
    goal: str = "",
    round_id: str = "",
    incomplete: bool = False,
    source: str = "wrap_up",
) -> dict[str, Any]:
    """Write procedural draft (or negative). Does not create skills yet."""
    from evoflow.persistence import person_memory_repositories as pm_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return {"ok": False, "error": "missing agent_code"}
    card = derive_craft_from_wrap_up(
        reflection=reflection,
        outcome=outcome,
        observations=observations,
        goal=goal,
        incomplete=incomplete,
    )
    status = "corrected" if incomplete or card["kind"] == "negative" else "proposed"
    importance = 0.78 if status == "corrected" else 0.6
    src = str(source or "wrap_up").strip() or "wrap_up"
    if incomplete and not src.endswith("_incomplete"):
        src = f"{src}_incomplete"
    eid = pm_repo.insert_person_memory(
        code,
        card["content"],
        layer="procedural",
        importance=importance,
        vitality=1.0,
        round_id=round_id,
        source=src[:80],
        status=status,
        kind=card["kind"],
        title=card["title"],
        evidence={"round_id": round_id, "goal": (goal or "")[:120]},
        hit_count=0,
    )
    # Soft bump if similar graduated craft already exists (second sighting)
    bumped = None
    theme = _heuristic_theme([card["title"], card["content"]])
    if theme and not incomplete:
        for row in pm_repo.list_craft(code, statuses=["graduated", "proposed"], limit=20):
            rid = str(row.get("id") or "")
            if rid == eid:
                continue
            blob = f"{row.get('title') or ''} {row.get('content') or ''}"
            if theme in blob:
                bumped = pm_repo.bump_craft_hit(rid)
                break
    return {
        "ok": bool(eid),
        "entry_id": eid,
        "title": card["title"],
        "kind": card["kind"],
        "status": status,
        "bumped_hit": bumped,
    }


def wrap_up_already_recorded(agent_code: str, round_id: str) -> bool:
    """True if this duty round already has a person journal (idempotency)."""
    from evoflow.persistence import person_memory_repositories as pm_repo

    code = str(agent_code or "").strip().lower()
    rid = str(round_id or "").strip()
    if not code or not rid:
        return False
    for row in pm_repo.list_person_memory(code, limit=40, layer="journal"):
        if str(row.get("round_id") or "").strip() == rid:
            return True
    return False


def record_person_kernel_wrap_up(
    agent_code: str,
    *,
    reflection: str = "",
    outcome: str = "",
    observations: list[str] | None = None,
    goal: str = "",
    round_id: str = "",
    incomplete: bool = False,
    source: str = "wrap_up",
) -> dict[str, Any]:
    """Single write path for Lessons + journal + craft + affect + poignancy.

    Used by legacy ``proactive_submit_work`` and by duty-engine auto wrap-up.
    Idempotent per ``round_id`` when a journal already exists for that stamp.
    """
    code = str(agent_code or "").strip().lower()
    rid = str(round_id or "").strip()
    if not code:
        return {"ok": False, "error": "missing agent_code"}
    if rid and wrap_up_already_recorded(code, rid):
        return {
            "ok": True,
            "skipped": True,
            "reason": "already_recorded_for_round",
            "round_id": rid,
        }

    src = str(source or "wrap_up").strip() or "wrap_up"
    obs = list(observations or [])
    lesson_result: dict[str, Any] | None = None
    person_memory_result: dict[str, Any] | None = None
    if not incomplete:
        lesson_result = record_wrap_up_lesson(
            code,
            reflection=reflection,
            outcome=outcome,
            observations=obs,
            round_id=rid,
        )
        person_memory_result = record_wrap_up_person_memory(
            code,
            reflection=reflection,
            outcome=outcome,
            observations=obs,
            goal=goal,
            round_id=rid,
            source=src,
        )
        try:
            update_affect_from_event(code, "wrap_up_ok")
        except Exception:
            logger.debug("wrap_up affect skipped", exc_info=True)
    else:
        # Still leave a thin journal so empty-growth doesn't hide failed shifts
        person_memory_result = record_wrap_up_person_memory(
            code,
            reflection=reflection or "本轮未完整收口",
            outcome=outcome,
            observations=obs,
            goal=goal,
            round_id=rid,
            source=f"{src}_incomplete" if not src.endswith("_incomplete") else src,
        )

    craft_result = record_wrap_up_craft(
        code,
        reflection=reflection,
        outcome=outcome,
        observations=obs,
        goal=goal,
        round_id=rid,
        incomplete=bool(incomplete),
        source=src,
    )
    delta = 0.35 if incomplete else (0.25 if str(reflection or "").strip() else 0.18)
    poi = add_poignancy(
        code,
        delta,
        reason=f"{src}_incomplete" if incomplete else src,
        maybe_reflect=True,
    )
    asset_hub: dict[str, Any] | None = None
    try:
        from evoflow.person_wrap_up_reflect import mirror_wrap_up_to_asset_hub

        journal_body = ""
        if isinstance(person_memory_result, dict):
            journal_body = str(person_memory_result.get("content") or "").strip()
        if not journal_body:
            journal_body = derive_journal_from_wrap_up(
                goal=goal,
                outcome=outcome,
                reflection=reflection,
            )
        craft_payload = None
        if isinstance(craft_result, dict) and craft_result.get("ok"):
            craft_payload = {
                "title": str(craft_result.get("title") or "").strip(),
                "kind": str(craft_result.get("kind") or "howto"),
                "content": str(craft_result.get("content") or "").strip(),
            }
            if not craft_payload["content"]:
                # craft_result may omit content; derive from wrap-up fields
                card = derive_craft_from_wrap_up(
                    reflection=reflection,
                    outcome=outcome,
                    observations=obs,
                    goal=goal,
                    incomplete=bool(incomplete),
                )
                craft_payload["content"] = str(card.get("content") or "").strip()
                if not craft_payload["title"]:
                    craft_payload["title"] = str(card.get("title") or "").strip()
                if not craft_payload["kind"]:
                    craft_payload["kind"] = str(card.get("kind") or "howto")
            if not craft_payload["title"] or not craft_payload["content"]:
                craft_payload = None
        asset_hub = mirror_wrap_up_to_asset_hub(
            code,
            {"journal": journal_body, "craft": craft_payload},
            round_id=rid,
            journal_body=journal_body,
        )
    except Exception:
        logger.debug("heuristic wrap_up asset hub mirror failed", exc_info=True)
        asset_hub = {"ok": False, "error": "mirror_failed"}
    return {
        "ok": True,
        "skipped": False,
        "round_id": rid,
        "source": src,
        "incomplete": bool(incomplete),
        "lesson": lesson_result,
        "person_memory": person_memory_result,
        "craft": craft_result,
        "poignancy": poi,
        "asset_hub": asset_hub,
    }


def build_wrap_up_from_duty_evidence(
    *,
    tasks: list[dict[str, Any]] | None = None,
    round_initiatives: list[Any] | None = None,
    environment_context: str = "",
    run_error: str | None = None,
    tool_msg_count: int = 0,
) -> dict[str, Any] | None:
    """Build wrap-up fields from duty Task evidence. ``None`` = skip (empty patrol).

    No extra LLM call — only structured Task / initiative / error signals.
    """
    tasks = [t for t in (tasks or []) if isinstance(t, dict)]
    inits = list(round_initiatives or [])

    done_st = {"completed", "reviewed", "done"}
    fail_st = {"failed", "error", "cancelled"}
    open_st = {"pending", "idle", "req_confirm", "waiting_user", "executing", "in_progress"}

    done: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    open_tasks: list[dict[str, Any]] = []
    for t in tasks:
        st = str(t.get("status") or "").strip().lower()
        if st in done_st:
            done.append(t)
        elif st in fail_st:
            failed.append(t)
        elif st in open_st or st:
            open_tasks.append(t)

    observations: list[str] = []
    for t in (done + failed + open_tasks)[:8]:
        title = str(t.get("title") or t.get("name") or "").strip()
        st = str(t.get("status") or "").strip()
        outcome = str(t.get("outcome") or t.get("result") or "").strip()
        line = f"[{st}] {title}".strip()
        if outcome:
            line = f"{line} — {outcome[:160]}"
        if title or outcome:
            observations.append(line[:240])

    for init in inits[:5]:
        title = str(getattr(init, "title", None) or "").strip()
        if not title and isinstance(init, dict):
            title = str(init.get("title") or "").strip()
        out = str(getattr(init, "outcome", None) or "").strip()
        if not out and isinstance(init, dict):
            out = str(init.get("outcome") or init.get("description") or "").strip()
        if title or out:
            observations.append((f"{title}: {out}" if title else out)[:240])

    env = " ".join(str(environment_context or "").strip().split())[:200]
    err = str(run_error or "").strip()

    has_task_signal = bool(done or failed or open_tasks)
    has_init_signal = bool(inits)
    # Empty heartbeat / board glance: do not pollute journal.
    # tool_msg_count alone is not enough (listing tasks is routine noise).
    if not has_task_signal and not has_init_signal and not err:
        return None

    incomplete = bool(err) or (bool(failed) and not done) or (
        bool(open_tasks) and not done and not failed and int(tool_msg_count or 0) >= 2
    )

    goal_parts: list[str] = []
    for t in (open_tasks + done + failed)[:3]:
        title = str(t.get("title") or "").strip()
        if title:
            goal_parts.append(title[:80])
    if not goal_parts and env:
        goal_parts.append(env[:120])
    goal = "；".join(goal_parts)[:200] or ("值班巡检" if err else "")

    outcome_bits: list[str] = []
    if done:
        outcome_bits.append(f"完成 {len(done)} 项")
    if failed:
        outcome_bits.append(f"失败 {len(failed)} 项")
    if open_tasks and not done:
        outcome_bits.append(f"仍开放 {len(open_tasks)} 项")
    if err:
        outcome_bits.append(f"运行异常：{err[:80]}")
    if int(tool_msg_count or 0) > 0 and outcome_bits:
        outcome_bits.append(f"工具约 {int(tool_msg_count)} 次")
    outcome = "；".join(outcome_bits)[:400]

    reflection_bits: list[str] = []
    for t in done[:3]:
        o = str(t.get("outcome") or t.get("result") or "").strip()
        if o:
            reflection_bits.append(o[:160])
    for t in failed[:2]:
        o = str(t.get("outcome") or t.get("result") or t.get("title") or "").strip()
        if o:
            reflection_bits.append(f"失败要点：{o[:140]}")
    if err:
        reflection_bits.append(f"值班未完整结束（{err[:60]}），下次先收口再开新项。")
    reflection = "；".join(reflection_bits)[:500]

    if not (goal or outcome or reflection or observations):
        return None

    return {
        "goal": goal,
        "outcome": outcome,
        "reflection": reflection,
        "observations": observations[:8],
        "incomplete": incomplete,
    }


def format_person_craft_context(
    agent_code: str | None,
    *,
    query: str = "",
    goal: str = "",
    max_chars: int = _PERSON_CRAFT_INJECT_CHARS,
) -> str:
    """Core craft (negatives + graduated titles); archival howto via query (Phase F)."""
    from evoflow.persistence import person_memory_repositories as pm_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return ""
    q = str(query or goal or "").strip()
    try:
        negatives = pm_repo.list_craft(
            code, statuses=["corrected", "graduated"], kind="negative", limit=6
        )
        howtos = pm_repo.list_craft(
            code, statuses=["graduated"], kind="howto", limit=8
        )
        # Prefer core / high importance for always-on; full content only for top few
        if q:
            hit_rows = pm_repo.retrieve_for_query(
                code, q, limit=6, include_procedural=True, bump_hits=True
            )
            hit_howtos = [
                r
                for r in hit_rows
                if str(r.get("layer") or "") == "procedural"
                and str(r.get("kind") or "howto") == "howto"
                and str(r.get("status") or "") in {"graduated", "proposed", "corrected"}
            ]
            # Merge hit howtos first
            seen = {str(r.get("id") or "") for r in hit_howtos}
            howtos = hit_howtos + [
                r for r in howtos if str(r.get("id") or "") not in seen
            ]
    except Exception:
        logger.debug("format_person_craft_context failed", exc_info=True)
        return ""
    lines: list[str] = []
    used = 0
    for r in negatives[:3]:
        title = str(r.get("title") or "负约束").strip()
        content = str(r.get("content") or "").strip()
        bit = f"- [负] {title}：{content}"[:220]
        if used + len(bit) > max_chars:
            break
        lines.append(bit)
        used += len(bit)
    # With query: fuller howto bodies; without: titles only (core budget)
    howto_budget = 4 if q else 4
    for r in howtos[:howto_budget]:
        title = str(r.get("title") or "做法").strip()
        skill = str(r.get("skill_name") or "").strip()
        extra = f"（技能 `{skill}`）" if skill else ""
        if q:
            content = str(r.get("content") or "").strip()
            bit = f"- [法] {title}{extra}：{content}"[:220]
        else:
            bit = f"- [法] {title}{extra}"[:120]
        if used + len(bit) > max_chars:
            break
        lines.append(bit)
        used += len(bit)
    if not lines:
        return ""
    body = "\n".join(lines)
    return (
        "<person_craft>\n"
        "<!-- HIGH WEIGHT PROCEDURAL — howtos & hard-won negatives. MUST prefer matching craft before reinventing; not optional decoration. -->\n"
        f"{body}\n"
        "</person_craft>\n"
    )


def _skill_slug_for_agent(agent_code: str, title: str) -> str:
    import hashlib
    import re

    code = re.sub(r"[^a-z0-9]+", "", str(agent_code or "").lower())[:12] or "agent"
    digest = hashlib.sha1(f"{agent_code}:{title}".encode("utf-8")).hexdigest()[:8]
    return f"craft-{code}-{digest}"[:64]


def _auto_create_craft_skill(
    agent_code: str,
    *,
    title: str,
    body: str,
    entry_id: str = "",
) -> dict[str, Any]:
    """Create skill file automatically (no human approval). Idempotent by name."""
    from evoflow.persistence import config_repositories as cfg_repo

    name = _skill_slug_for_agent(agent_code, title)
    desc = f"本事自动巩固：{title}"[:200]
    content = (
        f"---\nname: {name}\ndescription: {desc}\n---\n\n"
        f"# {title}\n\n"
        f"{body}\n\n"
        "## 来源\n"
        f"- agent: `{agent_code}`\n"
        f"- person_memory: `{entry_id or '-'}`\n"
        "- 由 Person Kernel 证据门控自动晋升，可随时用 skill_manager 修订。\n"
    )
    try:
        from evoflow.tools.builtins.skill_manager_tool import _create_skill

        result = _create_skill(name, content, "custom")
    except Exception as exc:
        logger.debug("auto craft skill create failed", exc_info=True)
        return {"ok": False, "error": str(exc), "skill_name": name}
    ok = bool(result.get("success"))
    if ok:
        try:
            cfg_repo.append_soul_changelog(
                agent_code,
                field="craft_skill",
                old_value="",
                new_value=name,
                reason=f"auto graduate craft → skill ({title})",
                evidence={"entry_id": entry_id, "title": title},
                source="craft_auto",
                approved_by="system",
            )
        except Exception:
            logger.debug("craft skill changelog skipped", exc_info=True)
    return {
        "ok": ok,
        "skill_name": name,
        "result": result,
        "already_exists": (not ok) and "已存在" in str(result.get("error") or ""),
    }


def consolidate_craft_overnight(
    agent_code: str,
    *,
    theme: str = "",
) -> dict[str, Any]:
    """Evidence gate: repeat signal → graduate + auto skill. No human approval."""
    from evoflow.persistence import person_memory_repositories as pm_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return {"ok": False, "error": "missing agent_code"}
    rows = pm_repo.list_craft(
        code, statuses=["proposed", "corrected", "graduated"], limit=40
    )
    howtos = [r for r in rows if str(r.get("kind") or "howto") == "howto"]
    graduated_ids: list[str] = []
    skills_created: list[str] = []
    retired: list[str] = []

    # Group by heuristic theme from title+content
    groups: dict[str, list[dict[str, Any]]] = {}
    for r in howtos:
        key = _heuristic_theme(
            [str(r.get("title") or ""), str(r.get("content") or "")]
        ) or str(r.get("title") or "流程")[:12]
        groups.setdefault(key, []).append(r)

    # Prefer night-dream theme if provided
    prefer = str(theme or "").strip()
    keys = list(groups.keys())
    if prefer and prefer in groups:
        keys = [prefer] + [k for k in keys if k != prefer]

    for key in keys:
        cluster = groups.get(key) or []
        if not cluster:
            continue
        hits = sum(int(r.get("hit_count") or 0) for r in cluster)
        already_grad = [
            r for r in cluster if str(r.get("status") or "") == "graduated"
        ]
        drafts = [
            r
            for r in cluster
            if str(r.get("status") or "") in {"proposed", "corrected"}
        ]
        # Gate: ≥2 sightings OR hit_count≥2 OR (1 graduated + 1 new draft)
        strong = (
            len(cluster) >= 2
            or hits >= 2
            or (already_grad and drafts)
            or any(int(r.get("hit_count") or 0) >= 2 for r in cluster)
        )
        if not strong:
            continue

        # Choose canonical body: longest graduated else longest draft
        pool = already_grad or drafts or cluster
        canon = max(pool, key=lambda r: len(str(r.get("content") or "")))
        title = str(canon.get("title") or f"做法：{key}")[:80]
        body = str(canon.get("content") or "")[:_MAX_CRAFT_CHARS]
        eid = str(canon.get("id") or "")
        if str(canon.get("status") or "") != "graduated":
            pm_repo.update_craft_entry(
                eid,
                status="graduated",
                importance=0.82,
                evidence={
                    **(canon.get("evidence") if isinstance(canon.get("evidence"), dict) else {}),
                    "theme": key,
                    "cluster_size": len(cluster),
                    "hits": hits,
                },
            )
            graduated_ids.append(eid)
        else:
            graduated_ids.append(eid)

        # Retire weaker duplicates in the same theme cluster
        for r in cluster:
            rid = str(r.get("id") or "")
            if rid and rid != eid:
                pm_repo.update_craft_entry(rid, status="retired")
                retired.append(rid)

        # Auto skill if missing
        if not str(canon.get("skill_name") or "").strip():
            sk = _auto_create_craft_skill(
                code, title=title, body=body, entry_id=eid
            )
            if sk.get("ok") or sk.get("already_exists"):
                sname = str(sk.get("skill_name") or "")
                pm_repo.update_craft_entry(eid, skill_name=sname)
                if sk.get("ok"):
                    skills_created.append(sname)
                elif sk.get("already_exists"):
                    # Link existing skill name even if create skipped
                    pm_repo.update_craft_entry(eid, skill_name=sname)

    return {
        "ok": True,
        "graduated": graduated_ids,
        "retired": retired,
        "skills_created": skills_created,
    }


# ── Phase F: poignancy reflection + bounded edits + relation memos ─────

_POIGNANCY_THRESHOLD = 1.0
_MAX_TOOL_EDITS_PER_DAY = 20
_MAX_TOOL_WRITE_CHARS = 500


def _today_state_meta(agent_code: str) -> tuple[str, str, dict[str, Any]]:
    from evoflow.persistence import person_metabolism_repositories as meta_repo

    code = str(agent_code or "").strip().lower()
    today = _beijing_today()
    state = meta_repo.get_person_state(code, today) or {}
    meta = state.get("meta") if isinstance(state.get("meta"), dict) else {}
    return code, today, dict(meta or {})


def get_poignancy(agent_code: str) -> float:
    _, _, meta = _today_state_meta(agent_code)
    try:
        return float(meta.get("poignancy") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def add_poignancy(
    agent_code: str,
    delta: float,
    *,
    reason: str = "",
    maybe_reflect: bool = True,
) -> dict[str, Any]:
    """Accumulate workplace poignancy; optionally trigger reflection at threshold."""
    from evoflow.persistence import person_metabolism_repositories as meta_repo

    code, today, meta = _today_state_meta(agent_code)
    if not code:
        return {"ok": False, "error": "missing agent_code"}
    try:
        cur = float(meta.get("poignancy") or 0.0)
    except (TypeError, ValueError):
        cur = 0.0
    cur = max(0.0, cur + float(delta))
    meta["poignancy"] = round(cur, 4)
    if reason:
        hist = list(meta.get("poignancy_events") or [])
        if not isinstance(hist, list):
            hist = []
        hist.append({"d": float(delta), "r": str(reason)[:80]})
        meta["poignancy_events"] = hist[-12:]
    state = meta_repo.get_person_state(code, today) or {}
    stance = str(state.get("stance_md") or "")
    meta_repo.upsert_person_state(code, today, stance, meta=meta)
    out: dict[str, Any] = {
        "ok": True,
        "poignancy": cur,
        "threshold": _POIGNANCY_THRESHOLD,
    }
    if maybe_reflect and cur >= _POIGNANCY_THRESHOLD:
        ref = run_reflection(code, source="poignancy")
        out["reflection"] = ref
    return out


def run_reflection(agent_code: str, *, source: str = "poignancy") -> dict[str, Any]:
    """Importance-triggered reflection with evidence ids (GA-style)."""
    from evoflow.persistence import person_memory_repositories as pm_repo
    from evoflow.persistence import person_metabolism_repositories as meta_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return {"ok": False, "error": "missing agent_code"}

    journals = pm_repo.list_person_memory(code, layer="journal", limit=12)
    episodic = pm_repo.list_person_memory(code, layer="episodic", limit=8)
    pool = journals + episodic
    if not pool:
        _reset_poignancy(code)
        return {"ok": True, "skipped": True, "reason": "no_entries"}

    texts = [str(r.get("content") or "") for r in pool[:12]]
    theme = _heuristic_theme(texts)
    evidence_ids = [str(r.get("id") or "") for r in pool[:8] if r.get("id")]
    semantic_id = None
    if theme:
        semantic_id = pm_repo.insert_person_memory(
            code,
            f"反思洞察：围绕「{theme}」的近期经历需要持续关注。"
            f"（证据：{', '.join(evidence_ids[:5])}）",
            layer="semantic_self",
            importance=0.78,
            vitality=1.0,
            source=f"reflection:{source}",
            access_tier="core",
            evidence={"ids": evidence_ids, "theme": theme, "source": source},
        )
    craft = consolidate_craft_overnight(code, theme=theme or "")
    _reset_poignancy(code)
    today = _beijing_today()
    state = meta_repo.get_person_state(code, today) or {}
    meta = dict(state.get("meta") or {}) if isinstance(state.get("meta"), dict) else {}
    meta["last_reflection_at"] = utc_now_iso_safe()
    meta["last_reflection_theme"] = theme or ""
    meta_repo.upsert_person_state(
        code, today, str(state.get("stance_md") or ""), meta=meta
    )
    return {
        "ok": True,
        "theme": theme or "",
        "semantic_id": semantic_id,
        "evidence_ids": evidence_ids,
        "craft": craft,
        "source": source,
    }


def utc_now_iso_safe() -> str:
    try:
        from evoflow.timeutil import utc_now_iso_z

        return utc_now_iso_z()
    except Exception:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _reset_poignancy(agent_code: str) -> None:
    from evoflow.persistence import person_metabolism_repositories as meta_repo

    code, today, meta = _today_state_meta(agent_code)
    if not code:
        return
    meta["poignancy"] = 0.0
    state = meta_repo.get_person_state(code, today) or {}
    meta_repo.upsert_person_state(
        code, today, str(state.get("stance_md") or ""), meta=meta
    )


def edit_person_memory(
    agent_code: str,
    *,
    action: str,
    content: str = "",
    entry_id: str = "",
    layer: str = "journal",
    title: str = "",
) -> dict[str, Any]:
    """Bounded mid-duty self-edit (Letta-style). Never touches L0 identity."""
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence import person_memory_repositories as pm_repo
    from evoflow.persistence import person_metabolism_repositories as meta_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return {"ok": False, "error": "missing agent_code"}
    act = str(action or "").strip().lower()
    if act not in {"append", "replace", "rethink"}:
        return {"ok": False, "error": "invalid_action"}

    _, today, meta = _today_state_meta(code)
    try:
        edits = int(meta.get("tool_edits_today") or 0)
    except (TypeError, ValueError):
        edits = 0
    if edits >= _MAX_TOOL_EDITS_PER_DAY:
        return {
            "ok": False,
            "error": "daily_edit_limit",
            "limit": _MAX_TOOL_EDITS_PER_DAY,
        }

    text = " ".join(str(content or "").strip().split())
    if act in {"append", "replace"} and not text:
        return {"ok": False, "error": "content_required"}
    if len(text) > _MAX_TOOL_WRITE_CHARS:
        return {
            "ok": False,
            "error": "content_too_long",
            "max": _MAX_TOOL_WRITE_CHARS,
        }

    result: dict[str, Any] = {"ok": False, "action": act}

    if act == "append":
        ly = str(layer or "journal").strip().lower()
        if ly not in {"journal", "episodic", "procedural"}:
            ly = "journal"
        status = "proposed" if ly == "procedural" else ""
        kind = "howto" if ly == "procedural" else ""
        eid = pm_repo.insert_person_memory(
            code,
            text,
            layer=ly,
            importance=0.62,
            vitality=1.0,
            source="tool_edit",
            status=status,
            kind=kind,
            title=(title or text[:40])[:80],
            access_tier="archival",
            evidence={"action": "append"},
        )
        result = {"ok": bool(eid), "entry_id": eid, "action": act}

    elif act == "replace":
        eid = str(entry_id or "").strip()
        row = pm_repo.get_person_memory(eid) if eid else None
        if not row or str(row.get("agent_code") or "").lower() != code:
            return {"ok": False, "error": "entry_not_found"}
        ok = pm_repo.update_craft_entry(eid, content=text, title=title or None)
        result = {"ok": ok, "entry_id": eid, "action": act}

    elif act == "rethink":
        eid = str(entry_id or "").strip()
        row = pm_repo.get_person_memory(eid) if eid else None
        if not row or str(row.get("agent_code") or "").lower() != code:
            return {"ok": False, "error": "entry_not_found"}
        old = str(row.get("content") or "").strip()
        theme = _heuristic_theme([old, title, text]) or (title or old[:16] or "经验")
        summary = text or f"精炼：{theme} — {old[:160]}"
        summary = summary[:_MAX_TOOL_WRITE_CHARS]
        new_id = pm_repo.insert_person_memory(
            code,
            summary,
            layer="semantic_self",
            importance=0.74,
            vitality=1.0,
            source="tool_rethink",
            access_tier="core",
            evidence={"ids": [eid], "action": "rethink"},
            title=f"精炼：{theme}"[:80],
        )
        pm_repo.update_craft_entry(eid, vitality=0.35)
        result = {
            "ok": bool(new_id),
            "entry_id": new_id,
            "source_id": eid,
            "action": act,
        }

    if result.get("ok"):
        meta["tool_edits_today"] = edits + 1
        state = meta_repo.get_person_state(code, today) or {}
        meta_repo.upsert_person_state(
            code, today, str(state.get("stance_md") or ""), meta=meta
        )
        try:
            cfg_repo.append_soul_changelog(
                code,
                field="person_memory",
                old_value=str(entry_id or "")[:80],
                new_value=str(result.get("entry_id") or "")[:80],
                reason=f"tool_edit:{act}",
                evidence={"action": act},
                source="tool_edit",
                approved_by="system",
            )
        except Exception:
            logger.debug("tool_edit changelog skipped", exc_info=True)
    return result


def record_relation_memo(
    *,
    agent_code: str,
    peer_code: str,
    event: str,
    note: str = "",
    child_task_id: str = "",
) -> dict[str, Any]:
    """Short episodic memo after handoff/wake (GA-style relationship memory)."""
    from evoflow.persistence import person_memory_repositories as pm_repo

    code = str(agent_code or "").strip().lower()
    peer = str(peer_code or "").strip().lower()
    if not code or not peer or code in {"user", "system"}:
        return {"ok": False, "skipped": True}
    ev = str(event or "collab").strip()[:40]
    note_s = " ".join(str(note or "").strip().split())[:160]
    child = str(child_task_id or "").strip()[:40]
    body = f"与 {peer}：{ev}"
    if child:
        body += f"（task `{child}`）"
    if note_s:
        body += f"。{note_s}"
    eid = pm_repo.insert_person_memory(
        code,
        body[:500],
        layer="episodic",
        importance=0.58,
        vitality=1.0,
        source="relation_memo",
        access_tier="archival",
        title=f"关系·{peer}"[:80],
        evidence={"peer": peer, "event": ev, "child_task_id": child},
    )
    return {"ok": bool(eid), "entry_id": eid}

