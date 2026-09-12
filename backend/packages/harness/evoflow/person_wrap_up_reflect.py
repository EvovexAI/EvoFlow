"""LLM duty wrap-up reflection — distill shift evidence into person state.

Prompt lineage (adapted, not copied wholesale):
- evoflow-inner-life journal.md — What happened / understood / shifted / next + 2–3 line state summary
- generative_agents insight_and_evidence — high-level insights with evidence indices
- legacy voice module thread-summarize — Chinese first-person ("我"), no play-by-play
- claude-soul-memory — verbal lessons as ``When [context], [what works/fails]``
- nur digestion.md — unresolved_flags + emotional arc label
- letta sleeptime — selective writes; skip when nothing meaningful; absolute dates over "today"
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# ── Prompts (reference-adapted) ───────────────────────────────────────

PERSON_WRAP_UP_SYSTEM = """\
你是智能体员工的「收工复盘」系统（Person Kernel metabolism）。
本轮值班刚结束：根据证据把经历蒸馏成可注入明日提示词的长期人格记忆。
你不是用户助理；「我」= 这位员工自己。

## 借鉴原则（机制来源）
1. evoflow journal：分清「发生了什么 / 领悟 / 自我变化 / 下一步」；空日允许一句诚实的话，禁止注水。
2. Generative Agents：高阶洞察必须挂证据序号（because of 1,3）；禁止无出处鸡汤。
3. legacy voice module：用第一人称「我」写中文结论；不把用户/上游的话当成我的决定。
4. claude-soul：可执行教训格式 Prefer「当[情境]，[有效/失效做法]」；弱证据不要升格为人设。
5. nur：标出未闭合张力 unresolved；情绪用短 arc_label，不要戏精长文。
6. Letta sleeptime：无实质更新则 skip=true；改写要精确，日期用具体日不要「今天/最近」。

## 硬规则
- 只根据输入证据推理；禁止编造未出现的任务、人名、结果。
- 不要改 L0 身份硬边界；不要输出要直接覆写整份 SOUL 的长文。
- 职场调性：克制、可审计；affect_delta 每轴建议在 -0.12～+0.12。
- 只输出一个 JSON 对象，不要 Markdown 围栏外的散文。

## JSON schema
{
  "skip": false,
  "mood": "一个英文或中文词",
  "arc_label": "情绪轨迹短标签，如 steady / tense-to-resolved",
  "journal": "第一人称中文心智日记：发生了什么；若有则含领悟/自我变化/下一步。空日可一句。≤400字",
  "state_summary": "给明日注入的 2～3 句站立摘要（局势+一条行为变化），具体日期，≤120字；无则空字符串",
  "lesson": "当[情境]，[做法]。无则 null",
  "craft": {"title":"短标题","kind":"howto|negative","content":"可复用步骤或负约束"} 或 null,
  "insights": [{"text":"洞察","evidence":[1,3]}],
  "affect_delta": {
    "curiosity": 0.0, "confidence": 0.0, "pressure": 0.0,
    "connection": 0.0, "frustration": 0.0, "energy": 0.0
  },
  "poignancy": 1,
  "unresolved": ["未闭合事项"],
  "incomplete": false
}

poignancy：1=纯例行巡检，10=对本岗极重要的成败/关系转折（对齐 Generative Agents 量表）。
skip=true 仅当证据几乎无事可记（真正空转）；此时其它字段可空。
"""


def build_person_wrap_up_user_prompt(
    *,
    agent_code: str,
    role_name: str = "",
    as_of_date: str = "",
    identity_excerpt: str = "",
    recent_journals: list[str] | None = None,
    statements: list[str] | None = None,
    environment_context: str = "",
    run_error: str | None = None,
    open_commitments: int = 0,
    affect: dict[str, Any] | None = None,
) -> str:
    """User message: numbered evidence statements + light person context."""
    lines: list[str] = [
        f"员工：{role_name or agent_code}（agent_code=`{agent_code}`）",
        f"日期：{as_of_date or '（未提供）'}",
    ]
    if identity_excerpt.strip():
        lines.append("身份摘录（只读，勿改写）：\n" + identity_excerpt.strip()[:400])
    if affect and isinstance(affect, dict):
        axes = ", ".join(
            f"{k}={float(affect.get(k) or 0):.2f}"
            for k in (
                "curiosity",
                "confidence",
                "pressure",
                "connection",
                "frustration",
                "energy",
            )
        )
        lines.append(f"当前职场情绪态：{axes}")
    if open_commitments:
        lines.append(f"开放承诺条数：{int(open_commitments)}")
    if environment_context.strip():
        lines.append("本轮环境/目标上下文：\n" + environment_context.strip()[:500])
    if run_error:
        lines.append(f"运行异常：{str(run_error)[:120]}")

    stmts = [str(s).strip() for s in (statements or []) if str(s).strip()]
    if stmts:
        lines.append("本轮证据陈述（编号供 insights.evidence 引用）：")
        for i, s in enumerate(stmts[:24], start=1):
            lines.append(f"{i}. {s[:280]}")
    else:
        lines.append("本轮证据陈述：（无）")

    recent = [str(j).strip() for j in (recent_journals or []) if str(j).strip()]
    if recent:
        lines.append("近日心智日记（供连贯，勿逐条复述）：")
        for j in recent[:5]:
            lines.append(f"- {j[:200]}")

    lines.append("请按 system 要求只输出 JSON。")
    return "\n".join(lines)


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    text = str(raw or "").strip()
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(text[start : end + 1])
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def parse_wrap_up_llm_result(raw: str) -> dict[str, Any] | None:
    """Parse model JSON; normalize fields."""
    obj = _extract_json_object(raw)
    if not obj:
        return None
    skip = bool(obj.get("skip"))
    journal = str(obj.get("journal") or "").strip()
    state_summary = str(obj.get("state_summary") or "").strip()
    lesson = obj.get("lesson")
    lesson_s = str(lesson).strip() if lesson is not None else ""
    if lesson_s.lower() in {"null", "none", "无"}:
        lesson_s = ""
    craft = obj.get("craft")
    craft_out: dict[str, str] | None = None
    if isinstance(craft, dict):
        kind = str(craft.get("kind") or "howto").strip().lower()
        if kind not in {"howto", "negative"}:
            kind = "howto"
        title = str(craft.get("title") or "").strip()[:80]
        content = str(craft.get("content") or "").strip()[:500]
        if title or content:
            craft_out = {
                "title": title or ("避坑" if kind == "negative" else "做法"),
                "kind": kind,
                "content": content or title,
            }
    insights_in = obj.get("insights") if isinstance(obj.get("insights"), list) else []
    insights: list[dict[str, Any]] = []
    for it in insights_in[:5]:
        if not isinstance(it, dict):
            continue
        text = str(it.get("text") or "").strip()
        if not text:
            continue
        ev = it.get("evidence") if isinstance(it.get("evidence"), list) else []
        insights.append(
            {
                "text": text[:300],
                "evidence": [int(x) for x in ev if str(x).isdigit() or isinstance(x, int)][:8],
            }
        )
    deltas_in = obj.get("affect_delta") if isinstance(obj.get("affect_delta"), dict) else {}
    affect_delta = {
        k: max(-0.15, min(0.15, float(deltas_in.get(k) or 0.0)))
        for k in (
            "curiosity",
            "confidence",
            "pressure",
            "connection",
            "frustration",
            "energy",
        )
    }
    try:
        poi = int(float(obj.get("poignancy") or 1))
    except (TypeError, ValueError):
        poi = 1
    poi = max(1, min(10, poi))
    unresolved = [
        str(u).strip()[:160]
        for u in (obj.get("unresolved") or [])
        if str(u).strip()
    ][:6]
    return {
        "skip": skip and not journal,
        "mood": str(obj.get("mood") or "").strip()[:40],
        "arc_label": str(obj.get("arc_label") or "").strip()[:80],
        "journal": journal[:800],
        "state_summary": state_summary[:240],
        "lesson": lesson_s[:240] or None,
        "craft": craft_out,
        "insights": insights,
        "affect_delta": affect_delta,
        "poignancy": poi,
        "unresolved": unresolved,
        "incomplete": bool(obj.get("incomplete")),
    }


def collect_duty_wrap_up_statements(
    *,
    tasks: list[dict[str, Any]] | None = None,
    round_initiatives: list[Any] | None = None,
    environment_context: str = "",
    run_error: str | None = None,
    tool_msg_count: int = 0,
) -> dict[str, Any] | None:
    """Gather numbered evidence for the LLM. ``None`` = skip call (empty patrol)."""
    tasks = [t for t in (tasks or []) if isinstance(t, dict)]
    inits = list(round_initiatives or [])
    statements: list[str] = []

    done_st = {"completed", "reviewed", "done"}
    fail_st = {"failed", "error", "cancelled"}
    n_done = n_fail = n_open = 0
    for t in tasks:
        st = str(t.get("status") or "").strip().lower()
        title = str(t.get("title") or t.get("name") or "").strip()
        outcome = str(t.get("outcome") or t.get("result") or "").strip()
        bit = f"Task[{st}] {title}".strip()
        if outcome:
            bit = f"{bit} — {outcome[:200]}"
        if title or outcome:
            statements.append(bit[:280])
        if st in done_st:
            n_done += 1
        elif st in fail_st:
            n_fail += 1
        else:
            n_open += 1

    for init in inits[:6]:
        title = str(getattr(init, "title", None) or "").strip()
        if not title and isinstance(init, dict):
            title = str(init.get("title") or "").strip()
        out = str(getattr(init, "outcome", None) or "").strip()
        if not out and isinstance(init, dict):
            out = str(init.get("outcome") or init.get("description") or "").strip()
        if title or out:
            statements.append((f"事项 {title}: {out}" if title else out)[:280])

    env = " ".join(str(environment_context or "").strip().split())[:240]
    err = str(run_error or "").strip()
    if env:
        statements.append(f"环境上下文：{env}")
    if err:
        statements.append(f"运行异常：{err[:160]}")
    if int(tool_msg_count or 0) > 0:
        statements.append(f"本轮工具消息约 {int(tool_msg_count)} 条")

    if not tasks and not inits and not err:
        return None

    return {
        "statements": statements[:24],
        "n_done": n_done,
        "n_fail": n_fail,
        "n_open": n_open,
        "run_error": err or None,
        "environment_context": env,
        "tool_msg_count": int(tool_msg_count or 0),
    }


def _invoke_chat(*, system: str, user: str, model_name: str | None = None) -> str:
    from evoflow.models import create_chat_model

    model = create_chat_model(
        name=(model_name or "").strip() or None,
        thinking_enabled=False,
        invocation_kind="person_wrap_up",
    )
    try:
        model = model.bind(temperature=0.3)
    except Exception:
        pass
    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        lc = [SystemMessage(content=system), HumanMessage(content=user)]
        resp = model.invoke(lc)
    except Exception:
        resp = model.invoke(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ]
        )
    content = getattr(resp, "content", resp)
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return str(content or "")


async def _ainvoke_chat(*, system: str, user: str, model_name: str | None = None) -> str:
    from evoflow.models import create_chat_model

    model = create_chat_model(
        name=(model_name or "").strip() or None,
        thinking_enabled=False,
        invocation_kind="person_wrap_up",
    )
    try:
        model = model.bind(temperature=0.3)
    except Exception:
        pass
    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        lc = [SystemMessage(content=system), HumanMessage(content=user)]
        resp = await model.ainvoke(lc)
    except Exception:
        resp = await model.ainvoke(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ]
        )
    content = getattr(resp, "content", resp)
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return str(content or "")


def _apply_affect_deltas(agent_code: str, deltas: dict[str, float]) -> None:
    from evoflow.persistence import person_relations_repositories as rel_repo

    code = str(agent_code or "").strip().lower()
    if not code:
        return
    cur = rel_repo.get_affect(code)
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
    for k, d in (deltas or {}).items():
        if k not in axes:
            continue
        axes[k] = max(0.0, min(1.0, axes[k] + float(d)))
    rel_repo.save_affect(code, axes, meta={"last_event": "llm_wrap_up"})


def apply_llm_wrap_up_result(
    agent_code: str,
    parsed: dict[str, Any],
    *,
    round_id: str = "",
    source: str = "duty_llm",
) -> dict[str, Any]:
    """Persist LLM wrap-up into Person Kernel tables."""
    from evoflow.person_kernel import (
        add_poignancy,
        append_lesson_to_soul,
        wrap_up_already_recorded,
    )
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence import person_memory_repositories as pm_repo

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
    if parsed.get("skip") and not str(parsed.get("journal") or "").strip():
        return {"ok": True, "skipped": True, "reason": "model_skip", "round_id": rid}

    src = str(source or "duty_llm")[:80]
    journal = str(parsed.get("journal") or "").strip()
    if not journal:
        journal = "本轮值班已结束，模型未写出日记正文。"

    journal_id = pm_repo.insert_person_memory(
        code,
        journal,
        layer="journal",
        importance=min(0.95, 0.45 + int(parsed.get("poignancy") or 1) * 0.05),
        vitality=1.0,
        round_id=rid,
        source=src,
        access_tier="archival",
        evidence={
            "mood": parsed.get("mood"),
            "arc_label": parsed.get("arc_label"),
            "unresolved": parsed.get("unresolved") or [],
            "poignancy": parsed.get("poignancy"),
        },
    )

    state_summary = str(parsed.get("state_summary") or "").strip()
    state_id = None
    if state_summary:
        state_id = pm_repo.insert_person_memory(
            code,
            state_summary,
            layer="semantic_self",
            importance=0.82,
            vitality=1.0,
            round_id=rid,
            source=f"{src}:state_summary",
            access_tier="core",
            evidence={"kind": "standing_summary"},
        )

    insight_ids: list[str] = []
    for ins in parsed.get("insights") or []:
        if not isinstance(ins, dict):
            continue
        text = str(ins.get("text") or "").strip()
        if not text:
            continue
        ev = ins.get("evidence") or []
        sid = pm_repo.insert_person_memory(
            code,
            f"反思洞察：{text}" + (f"（证据：{','.join(str(x) for x in ev)}）" if ev else ""),
            layer="semantic_self",
            importance=0.75,
            vitality=1.0,
            round_id=rid,
            source=f"{src}:insight",
            access_tier="core",
            evidence={"indices": ev, "text": text},
        )
        if sid:
            insight_ids.append(sid)

    lesson = parsed.get("lesson")
    lesson_result = None
    if lesson:
        from datetime import datetime, timezone

        from evoflow.person_kernel import extract_lessons_section

        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        old = cfg_repo.get_agent_soul(code) or ""
        new = append_lesson_to_soul(old, str(lesson), stamp=stamp)
        if new != old:
            cfg_repo.save_agent_soul(code, new)
            cfg_repo.append_soul_changelog(
                code,
                field="lessons_learned",
                old_value=extract_lessons_section(old)[:500],
                new_value=str(lesson)[:500],
                reason="llm duty wrap_up lesson",
                evidence={"round_id": rid, "source": src},
                source=src,
                approved_by="system",
            )
            lesson_result = {"ok": True, "changed": True, "lesson": lesson}
        else:
            lesson_result = {"ok": True, "changed": False, "lesson": lesson}

    craft = parsed.get("craft")
    craft_id = None
    if isinstance(craft, dict):
        kind = str(craft.get("kind") or "howto")
        status = "corrected" if kind == "negative" or parsed.get("incomplete") else "proposed"
        craft_id = pm_repo.insert_person_memory(
            code,
            str(craft.get("content") or "")[:500],
            layer="procedural",
            importance=0.78 if status == "corrected" else 0.6,
            vitality=1.0,
            round_id=rid,
            source=src,
            status=status,
            kind=kind,
            title=str(craft.get("title") or "")[:80],
            evidence={"round_id": rid},
            hit_count=0,
        )

    try:
        _apply_affect_deltas(code, dict(parsed.get("affect_delta") or {}))
    except Exception:
        logger.debug("llm wrap_up affect apply failed", exc_info=True)

    # GA-scale 1–10 → accumulate toward reflection threshold
    poi = int(parsed.get("poignancy") or 1)
    delta = round(poi / 10.0, 4)
    poi_out = add_poignancy(
        code,
        delta,
        reason=f"{src}:p{poi}",
        maybe_reflect=True,
    )

    asset_hub: dict[str, Any] | None = None
    try:
        asset_hub = mirror_wrap_up_to_asset_hub(
            code,
            parsed,
            round_id=rid,
            journal_body=journal,
        )
    except Exception:
        logger.debug("llm wrap_up asset hub mirror failed", exc_info=True)
        asset_hub = {"ok": False, "error": "mirror_failed"}

    return {
        "ok": True,
        "skipped": False,
        "round_id": rid,
        "source": src,
        "journal_id": journal_id,
        "state_summary_id": state_id,
        "insight_ids": insight_ids,
        "lesson": lesson_result,
        "craft_id": craft_id,
        "poignancy": poi_out,
        "asset_hub": asset_hub,
        "parsed": parsed,
    }


def mirror_wrap_up_to_asset_hub(
    agent_code: str,
    parsed: dict[str, Any],
    *,
    round_id: str = "",
    journal_body: str = "",
) -> dict[str, Any]:
    """Mirror duty wrap-up journal/craft into employee Asset Hub markdown.

    Person Kernel SQLite remains the primary write; Asset Center / chat injection
    read the vault. Failures should not roll back kernel writes (caller wraps).
    """
    from evoflow.assets.hub import save_craft_note, write_journal
    from evoflow.assets.paths import EntityRef

    code = str(agent_code or "").strip().lower()
    if not code:
        return {"ok": False, "error": "missing agent_code"}

    entity = EntityRef("employee", code)
    out: dict[str, Any] = {"ok": True, "entity": f"employees/{code}"}

    body = str(journal_body or parsed.get("journal") or "").strip()
    if body:
        bits: list[str] = [body]
        mood = str(parsed.get("mood") or "").strip()
        arc = str(parsed.get("arc_label") or "").strip()
        if mood or arc:
            bits.append(f"_mood: {mood or '—'} · arc: {arc or '—'}_")
        rid = str(round_id or "").strip()
        if rid:
            bits.append(f"_round: `{rid}`_")
        unresolved = parsed.get("unresolved") or []
        if isinstance(unresolved, list) and unresolved:
            lines = [f"- {str(u).strip()}" for u in unresolved if str(u).strip()]
            if lines:
                bits.append("未闭合：\n" + "\n".join(lines[:8]))
        state = str(parsed.get("state_summary") or "").strip()
        if state:
            bits.append(f"**站立摘要**：{state}")
        summary = (str(parsed.get("state_summary") or "").strip() or body.split("\n", 1)[0])[:30]
        jres = write_journal(entity, "\n\n".join(bits), summary=summary)
        out["journal"] = jres

    craft = parsed.get("craft")
    if isinstance(craft, dict):
        title = str(craft.get("title") or "").strip()
        content = str(craft.get("content") or "").strip()
        if title and content:
            kind = str(craft.get("kind") or "howto").strip() or "howto"
            desc = f"[{kind}] duty wrap-up"[:30]
            cres = save_craft_note(
                entity,
                title=title[:80],
                content=content[:2000],
                description=desc,
            )
            out["craft"] = cres

    if "journal" not in out and "craft" not in out:
        return {"ok": True, "skipped": True, "reason": "nothing_to_mirror"}
    return out


def run_person_wrap_up_llm(
    agent_code: str,
    *,
    statements: list[str],
    round_id: str = "",
    role_name: str = "",
    environment_context: str = "",
    run_error: str | None = None,
    model_name: str | None = None,
    source: str = "duty_llm",
) -> dict[str, Any]:
    """Sync LLM wrap-up (submit_work / scripts)."""
    from evoflow.person_kernel import _beijing_today, wrap_up_already_recorded
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence import person_memory_repositories as pm_repo
    from evoflow.persistence import person_relations_repositories as rel_repo

    code = str(agent_code or "").strip().lower()
    rid = str(round_id or "").strip()
    if not code:
        return {"ok": False, "error": "missing agent_code"}
    if rid and wrap_up_already_recorded(code, rid):
        return {"ok": True, "skipped": True, "reason": "already_recorded_for_round"}

    identity = (cfg_repo.get_agent_identity(code) or "")[:400]
    recent = [
        str(r.get("content") or "")
        for r in pm_repo.list_person_memory(code, limit=5, layer="journal")
    ]
    user = build_person_wrap_up_user_prompt(
        agent_code=code,
        role_name=role_name,
        as_of_date=_beijing_today(),
        identity_excerpt=identity,
        recent_journals=recent,
        statements=statements,
        environment_context=environment_context,
        run_error=run_error,
        open_commitments=rel_repo.count_open_commitments(code),
        affect=rel_repo.get_affect(code),
    )
    try:
        raw = _invoke_chat(system=PERSON_WRAP_UP_SYSTEM, user=user, model_name=model_name)
    except Exception as exc:
        logger.warning("person wrap_up llm failed agent=%s: %s", code, exc, exc_info=True)
        return {"ok": False, "error": f"llm_failed:{exc}"}
    parsed = parse_wrap_up_llm_result(raw)
    if not parsed:
        return {"ok": False, "error": "parse_failed", "raw": str(raw)[:500]}
    return apply_llm_wrap_up_result(code, parsed, round_id=rid, source=source)


async def run_person_wrap_up_llm_async(
    agent_code: str,
    *,
    statements: list[str],
    round_id: str = "",
    role_name: str = "",
    environment_context: str = "",
    run_error: str | None = None,
    model_name: str | None = None,
    source: str = "duty_llm",
) -> dict[str, Any]:
    """Async LLM wrap-up for duty engine."""
    from evoflow.person_kernel import _beijing_today, wrap_up_already_recorded
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence import person_memory_repositories as pm_repo
    from evoflow.persistence import person_relations_repositories as rel_repo

    code = str(agent_code or "").strip().lower()
    rid = str(round_id or "").strip()
    if not code:
        return {"ok": False, "error": "missing agent_code"}
    if rid and wrap_up_already_recorded(code, rid):
        return {"ok": True, "skipped": True, "reason": "already_recorded_for_round"}

    identity = (cfg_repo.get_agent_identity(code) or "")[:400]
    recent = [
        str(r.get("content") or "")
        for r in pm_repo.list_person_memory(code, limit=5, layer="journal")
    ]
    user = build_person_wrap_up_user_prompt(
        agent_code=code,
        role_name=role_name,
        as_of_date=_beijing_today(),
        identity_excerpt=identity,
        recent_journals=recent,
        statements=statements,
        environment_context=environment_context,
        run_error=run_error,
        open_commitments=rel_repo.count_open_commitments(code),
        affect=rel_repo.get_affect(code),
    )
    try:
        raw = await _ainvoke_chat(
            system=PERSON_WRAP_UP_SYSTEM, user=user, model_name=model_name
        )
    except Exception as exc:
        logger.warning("person wrap_up llm async failed agent=%s: %s", code, exc, exc_info=True)
        return {"ok": False, "error": f"llm_failed:{exc}"}
    parsed = parse_wrap_up_llm_result(raw)
    if not parsed:
        return {"ok": False, "error": "parse_failed", "raw": str(raw)[:500]}
    return apply_llm_wrap_up_result(code, parsed, round_id=rid, source=source)
