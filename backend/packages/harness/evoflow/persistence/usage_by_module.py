"""Product-surface usage breakdown for Settings → 使用统计.

Classifies ledger events into human modules users recognize:
chat / employee / workflow / knowledge / media — not raw invocation_kind.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.persistence.db import get_db, run_db_read
from evoflow.persistence.usage_ledger import (
    CATEGORY_EMBEDDING,
    CATEGORY_LLM,
    CATEGORY_MEDIA,
    _f,
    _parse_range,
    _s,
    _usage_where,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

MODULE_CHAT = "chat"
MODULE_EMPLOYEE = "employee"
MODULE_WORKFLOW = "workflow"
MODULE_KNOWLEDGE = "knowledge"
MODULE_MEDIA = "media"
MODULE_OTHER = "other"

_MODULE_ORDER = (
    MODULE_CHAT,
    MODULE_EMPLOYEE,
    MODULE_WORKFLOW,
    MODULE_KNOWLEDGE,
    MODULE_MEDIA,
    MODULE_OTHER,
)

_MODULE_LABEL_ZH = {
    MODULE_CHAT: "对话",
    MODULE_EMPLOYEE: "员工",
    MODULE_WORKFLOW: "工作流",
    MODULE_KNOWLEDGE: "知识库",
    MODULE_MEDIA: "生图/生视频",
    MODULE_OTHER: "其它",
}


def classify_session_module(
    *,
    session_key: str | None,
    agent_id: str | None = None,
    collab_task_id: str | None = None,
    context: dict[str, Any] | None = None,
    agent_code: str | None = None,
) -> str:
    """Map a chat session (or event attribution) to a product module id."""
    sk = _s(session_key)
    aid = _s(agent_id) or _s(agent_code)
    cid = _s(collab_task_id)
    ctx = context if isinstance(context, dict) else {}

    if sk.startswith("proactive:"):
        return MODULE_EMPLOYEE
    if aid and aid not in ("main", "executor", "lead_agent", "agent") and not aid.startswith("ou_"):
        # agent:{code}:channel:… employee IM / panel sessions
        if sk.startswith("agent:") and aid != "executor":
            # Prefer employee when the owning code looks like a duty role.
            try:
                from evoflow.proactive.repositories import ProactiveRepository

                if ProactiveRepository.get_role(aid) is not None:
                    return MODULE_EMPLOYEE
            except Exception:
                pass

    if cid or bool(ctx.get("workflow_run")) or aid == "executor" or sk.startswith("agent:executor:"):
        return MODULE_WORKFLOW
    if sk.startswith("kb:") or sk.startswith("knowledge:"):
        return MODULE_KNOWLEDGE
    return MODULE_CHAT


def resolve_usage_attribution(session_key: str | None, *, db: Any | None = None) -> dict[str, str]:
    """Best-effort fields to stamp onto new usage ledger rows.

    Pass ``db`` when already inside a write transaction so we reuse that
    connection (RLock-safe) and avoid an extra ``get_db()`` hop.
    """
    sk = _s(session_key)
    out = {
        "module": MODULE_CHAT,
        "agent_code": "",
        "app_id": "",
        "subject_id": "",
    }
    if not sk:
        return out

    agent_id = ""
    collab_task_id = ""
    context: dict[str, Any] = {}
    try:
        conn = db if db is not None else get_db()
        row = conn.execute(
            """
            SELECT agent_id, collab_task_id, context_json
            FROM evoflow_chat_sessions
            WHERE session_key = ? AND is_deleted = 0
            LIMIT 1
            """,
            (sk,),
        ).fetchone()
        if row:
            agent_id = _s(row[0])
            collab_task_id = _s(row[1])
            raw = row[2]
            if isinstance(raw, str) and raw.strip():
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict):
                        context = parsed
                except json.JSONDecodeError:
                    pass
    except Exception:
        logger.debug("resolve_usage_attribution session lookup failed", exc_info=True)

    if sk.startswith("proactive:"):
        try:
            from evoflow.proactive.chat_session import parse_proactive_session_key

            parsed = parse_proactive_session_key(sk)
            agent_id = _s(parsed.get("agent_code")) or agent_id
        except Exception:
            pass
    elif sk.startswith("agent:") and not agent_id:
        # agent:{code}:…
        parts = sk.split(":")
        if len(parts) >= 2:
            agent_id = _s(parts[1])

    module = classify_session_module(
        session_key=sk,
        agent_id=agent_id,
        collab_task_id=collab_task_id,
        context=context,
        agent_code=agent_id,
    )
    app_id = _s(context.get("app_id"))
    wf = context.get("workflow")
    if not app_id and isinstance(wf, dict):
        app_id = _s(wf.get("app_id"))
    # Dedicated workflow sessions store ids on context — see ensure_executor_transcript_session.
    if not app_id:
        app_id = _s(context.get("main_task_id")) or _s(context.get("run_id"))

    out["module"] = module
    if module == MODULE_EMPLOYEE:
        out["agent_code"] = agent_id
    elif agent_id and agent_id not in ("main", "executor"):
        out["agent_code"] = agent_id
    out["app_id"] = app_id or collab_task_id
    out["subject_id"] = out["agent_code"] or out["app_id"] or module
    return out


def _load_session_map(db: Any, session_keys: list[str]) -> dict[str, dict[str, Any]]:
    keys = sorted({_s(k) for k in session_keys if _s(k)})
    if not keys:
        return {}
    out: dict[str, dict[str, Any]] = {}
    # Chunk to keep SQLite variable limits happy.
    for i in range(0, len(keys), 400):
        chunk = keys[i : i + 400]
        placeholders = ",".join("?" * len(chunk))
        rows = db.execute(
            f"""
            SELECT session_key, agent_id, collab_task_id, context_json, title
            FROM evoflow_chat_sessions
            WHERE session_key IN ({placeholders})
            """,
            chunk,
        ).fetchall()
        for row in rows:
            sk = _s(row[0])
            ctx: dict[str, Any] = {}
            raw = row[3]
            if isinstance(raw, str) and raw.strip():
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict):
                        ctx = parsed
                except json.JSONDecodeError:
                    pass
            out[sk] = {
                "agent_id": _s(row[1]),
                "collab_task_id": _s(row[2]),
                "context": ctx,
                "title": _s(row[4]),
            }
    return out


def _employee_labels(codes: set[str]) -> dict[str, str]:
    labels: dict[str, str] = {}
    if not codes:
        return labels
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        for code in codes:
            role = ProactiveRepository.get_role(code)
            if role is None:
                continue
            name = _s(getattr(role, "role_name", None))
            labels[code] = name or code
    except Exception:
        logger.debug("employee label lookup failed", exc_info=True)
    return labels


def _app_labels(app_ids: set[str]) -> dict[str, str]:
    labels: dict[str, str] = {}
    ids = sorted({_s(a) for a in app_ids if _s(a)})
    if not ids:
        return labels
    try:
        db = get_db()
        for i in range(0, len(ids), 200):
            chunk = ids[i : i + 200]
            placeholders = ",".join("?" * len(chunk))
            # Prefer collab apps table when present.
            try:
                rows = db.execute(
                    f"SELECT id, name FROM evoflow_apps WHERE id IN ({placeholders})",
                    chunk,
                ).fetchall()
                for row in rows:
                    labels[_s(row[0])] = _s(row[1]) or _s(row[0])
            except Exception:
                pass
    except Exception:
        logger.debug("app label lookup failed", exc_info=True)
    return labels


def _kb_labels(kb_ids: set[str]) -> dict[str, str]:
    labels: dict[str, str] = {}
    for kid in sorted({_s(k) for k in kb_ids if _s(k)}):
        try:
            from evoflow.knowledge.owned.service import get_base

            base = get_base(kid)
            if isinstance(base, dict):
                name = _s(base.get("name") or base.get("title"))
                if name:
                    labels[kid] = name
                    continue
        except Exception:
            logger.debug("kb label lookup failed id=%s", kid, exc_info=True)
        if kid == "kb_builtin_user_guide":
            labels[kid] = "内置用户指南"
        else:
            labels[kid] = kid
    return labels


def _kb_labels(kb_ids: set[str]) -> dict[str, str]:
    labels: dict[str, str] = {}
    for kid in sorted({_s(k) for k in kb_ids if _s(k)}):
        try:
            from evoflow.knowledge.owned.service import get_base

            base = get_base(kid)
            if isinstance(base, dict):
                name = _s(base.get("name") or base.get("title"))
                if name:
                    labels[kid] = name
                    continue
        except Exception:
            logger.debug("kb label lookup failed id=%s", kid, exc_info=True)
        if kid == "kb_builtin_user_guide":
            labels[kid] = "内置用户指南"
        else:
            labels[kid] = kid
    return labels


def _session_label(session_key: str, sess: dict[str, Any] | None) -> str:
    title = _s((sess or {}).get("title"))
    if title:
        return title
    sk = _s(session_key)
    if len(sk) > 36:
        return sk[:33] + "…"
    return sk or "(session)"


def _bucket() -> dict[str, Any]:
    return {
        "tokens": 0.0,
        "input_tokens": 0.0,
        "output_tokens": 0.0,
        "events": 0,
        "amount": 0.0,
    }


def fetch_usage_by_module(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    principal_id: str | None = None,
    include_orphan: bool = True,
    top_n: int = 12,
) -> dict[str, Any]:
    """Aggregate product-module token usage for Settings UI.

    Read-only: uses the WAL read pool so opening Settings does not serialize
    against chat/session writers on the shared write connection.
    """
    start, end = _parse_range(from_day, to_day)
    lim = max(1, min(int(top_n or 12), 50))

    where, params = _usage_where(
        "date(occurred_at) >= ? AND date(occurred_at) <= ?",
        [start, end],
        principal_id=principal_id,
        include_orphan=include_orphan,
    )

    def _load_rows(db: Any) -> tuple[list[Any], dict[str, dict[str, Any]]]:
        rows_local = db.execute(
            f"""
            SELECT category, subcategory, quantity, quantity_in, quantity_out, amount,
                   session_key, agent_code, app_id, meta_json, subject_type, subject_id
            FROM evoflow_usage_events
            WHERE {where}
            """,
            params,
        ).fetchall()
        session_keys = [_s(r[6]) for r in rows_local if _s(r[6])]
        return rows_local, _load_session_map(db, session_keys)

    rows, session_map = run_db_read(_load_rows)

    modules: dict[str, dict[str, Any]] = {m: _bucket() for m in _MODULE_ORDER}
    employees: dict[str, dict[str, Any]] = {}
    workflows: dict[str, dict[str, Any]] = {}
    knowledge: dict[str, dict[str, Any]] = {}
    conversations: dict[str, dict[str, Any]] = {}
    knowledge_bases: dict[str, dict[str, Any]] = {}

    for row in rows:
        cat = _s(row[0]).lower()
        sub = _s(row[1]).lower()
        qty = _f(row[2])
        qty_in = _f(row[3])
        qty_out = _f(row[4])
        amt = _f(row[5])
        sk = _s(row[6])
        event_agent = _s(row[7])
        event_app = _s(row[8])
        subject_type = _s(row[10]).lower()
        subject_id = _s(row[11])
        meta: dict[str, Any] = {}
        raw_meta = row[9]
        if isinstance(raw_meta, str) and raw_meta.strip():
            try:
                parsed = json.loads(raw_meta)
                if isinstance(parsed, dict):
                    meta = parsed
            except json.JSONDecodeError:
                pass

        sess = session_map.get(sk) or {}
        agent_id = event_agent or _s(sess.get("agent_id")) or _s(meta.get("agent_code"))
        app_id = (
            event_app
            or _s(sess.get("context", {}).get("app_id") if isinstance(sess.get("context"), dict) else "")
            or _s(meta.get("app_id"))
        )
        collab = _s(sess.get("collab_task_id"))
        ctx = sess.get("context") if isinstance(sess.get("context"), dict) else {}

        if cat == CATEGORY_EMBEDDING:
            module = MODULE_KNOWLEDGE
        elif cat == CATEGORY_MEDIA:
            module = MODULE_MEDIA
        elif cat == CATEGORY_LLM:
            meta_module = _s(meta.get("module")).lower()
            if meta_module in _MODULE_ORDER:
                module = meta_module
            else:
                module = classify_session_module(
                    session_key=sk,
                    agent_id=agent_id,
                    collab_task_id=collab,
                    context=ctx,
                    agent_code=agent_id,
                )
        else:
            module = MODULE_OTHER

        slot = modules.setdefault(module, _bucket())
        slot["tokens"] += qty
        slot["input_tokens"] += qty_in
        slot["output_tokens"] += qty_out
        slot["events"] += 1
        slot["amount"] += amt

        def _add(dst: dict[str, Any]) -> None:
            dst["tokens"] += qty
            dst["input_tokens"] += qty_in
            dst["output_tokens"] += qty_out
            dst["events"] += 1
            dst["amount"] += amt

        if module in (MODULE_CHAT, MODULE_EMPLOYEE) and sk:
            conv = conversations.setdefault(
                sk,
                {
                    **_bucket(),
                    "session_key": sk,
                    "module": module,
                    "agent_code": "",
                    "title": _s(sess.get("title")) or sk,
                },
            )
            _add(conv)
            if module == MODULE_EMPLOYEE and not conv.get("agent_code"):
                code = agent_id
                if not code and sk.startswith("proactive:"):
                    try:
                        from evoflow.proactive.chat_session import parse_proactive_session_key

                        code = _s(parse_proactive_session_key(sk).get("agent_code"))
                    except Exception:
                        code = ""
                conv["agent_code"] = code

        if module == MODULE_EMPLOYEE:
            code = agent_id
            if not code and sk.startswith("proactive:"):
                try:
                    from evoflow.proactive.chat_session import parse_proactive_session_key

                    code = _s(parse_proactive_session_key(sk).get("agent_code"))
                except Exception:
                    code = ""
            code = code or "(unknown)"
            emp = employees.setdefault(code, {**_bucket(), "agent_code": code})
            _add(emp)
        elif module == MODULE_WORKFLOW:
            wid = app_id or collab or sk or _s(sess.get("title")) or "(workflow)"
            wf = workflows.setdefault(
                wid,
                {
                    **_bucket(),
                    "workflow_id": wid,
                    "session_key": sk,
                    "title": _s(sess.get("title")) or wid,
                },
            )
            _add(wf)
            if sk and not wf.get("session_key"):
                wf["session_key"] = sk
            title = _s(sess.get("title"))
            if title and (not wf.get("title") or wf.get("title") == wid):
                wf["title"] = title
        elif module == MODULE_KNOWLEDGE:
            purpose = sub or _s(meta.get("purpose")).lower() or "other"
            if purpose not in ("index", "query", "other"):
                purpose = "other"
            kb_purpose = knowledge.setdefault(purpose, {**_bucket(), "purpose": purpose})
            _add(kb_purpose)

            kid = subject_id if subject_type == "kb" else _s(meta.get("kb_id"))
            kid = kid or "(unknown)"
            kb_row = knowledge_bases.setdefault(
                kid,
                {**_bucket(), "kb_id": kid, "purposes": {}},
            )
            _add(kb_row)
            purpose_slot = kb_row["purposes"].setdefault(purpose, 0.0)
            kb_row["purposes"][purpose] = _f(purpose_slot) + qty

    emp_labels = _employee_labels(set(employees.keys()) - {"(unknown)"})
    app_labels = _app_labels({w.get("workflow_id", "") for w in workflows.values()})
    kb_labels = _kb_labels(set(knowledge_bases.keys()) - {"(unknown)"})

    total_tokens = sum(_f(m.get("tokens")) for m in modules.values())

    def _share(tokens: float) -> float:
        if total_tokens <= 0:
            return 0.0
        return round(tokens / total_tokens, 4)

    module_items = []
    for mid in _MODULE_ORDER:
        slot = modules.get(mid) or _bucket()
        toks = _f(slot["tokens"])
        if toks <= 0 and int(slot["events"] or 0) <= 0:
            continue
        module_items.append(
            {
                "module": mid,
                "label": _MODULE_LABEL_ZH.get(mid, mid),
                "tokens": toks,
                "input_tokens": _f(slot["input_tokens"]),
                "output_tokens": _f(slot["output_tokens"]),
                "events": int(slot["events"] or 0),
                "amount": _f(slot["amount"]),
                "share": _share(toks),
            }
        )
    module_items.sort(key=lambda r: r["tokens"], reverse=True)

    employee_items = []
    for code, slot in employees.items():
        toks = _f(slot["tokens"])
        employee_items.append(
            {
                "agent_code": code,
                "label": emp_labels.get(code) or code,
                "tokens": toks,
                "input_tokens": _f(slot["input_tokens"]),
                "output_tokens": _f(slot["output_tokens"]),
                "events": int(slot["events"] or 0),
                "amount": _f(slot["amount"]),
                "share": _share(toks),
            }
        )
    employee_items.sort(key=lambda r: r["tokens"], reverse=True)
    employee_items = employee_items[:lim]

    conversation_items = []
    for sk, slot in conversations.items():
        toks = _f(slot["tokens"])
        module = _s(slot.get("module")) or MODULE_CHAT
        agent_code = _s(slot.get("agent_code"))
        title = _s(slot.get("title")) or sk
        if module == MODULE_EMPLOYEE and agent_code:
            emp_name = emp_labels.get(agent_code) or agent_code
            label = f"{emp_name} · {title}"
        else:
            label = title
        conversation_items.append(
            {
                "session_key": sk,
                "module": module,
                "agent_code": agent_code or None,
                "label": label,
                "title": title,
                "tokens": toks,
                "input_tokens": _f(slot["input_tokens"]),
                "output_tokens": _f(slot["output_tokens"]),
                "events": int(slot["events"] or 0),
                "amount": _f(slot["amount"]),
                "share": _share(toks),
            }
        )
    conversation_items.sort(key=lambda r: r["tokens"], reverse=True)
    conversation_items = conversation_items[:lim]

    workflow_items = []
    for wid, slot in workflows.items():
        toks = _f(slot["tokens"])
        workflow_items.append(
            {
                "workflow_id": wid,
                "session_key": _s(slot.get("session_key")) or None,
                "label": app_labels.get(wid) or _s(slot.get("title")) or wid,
                "tokens": toks,
                "input_tokens": _f(slot["input_tokens"]),
                "output_tokens": _f(slot["output_tokens"]),
                "events": int(slot["events"] or 0),
                "amount": _f(slot["amount"]),
                "share": _share(toks),
            }
        )
    workflow_items.sort(key=lambda r: r["tokens"], reverse=True)
    workflow_items = workflow_items[:lim]

    knowledge_items = []
    purpose_label = {"index": "索引写入", "query": "检索查询", "other": "其它"}
    for purpose, slot in knowledge.items():
        toks = _f(slot["tokens"])
        knowledge_items.append(
            {
                "purpose": purpose,
                "label": purpose_label.get(purpose, purpose),
                "tokens": toks,
                "input_tokens": _f(slot["input_tokens"]),
                "output_tokens": _f(slot["output_tokens"]),
                "events": int(slot["events"] or 0),
                "amount": _f(slot["amount"]),
                "share": _share(toks),
            }
        )
    knowledge_items.sort(key=lambda r: r["tokens"], reverse=True)

    knowledge_base_items = []
    for kid, slot in knowledge_bases.items():
        toks = _f(slot["tokens"])
        purposes = slot.get("purposes") if isinstance(slot.get("purposes"), dict) else {}
        top_purpose = ""
        if purposes:
            top_purpose = max(purposes.items(), key=lambda kv: _f(kv[1]))[0]
        knowledge_base_items.append(
            {
                "kb_id": kid,
                "label": kb_labels.get(kid) or kid,
                "top_purpose": top_purpose or None,
                "tokens": toks,
                "input_tokens": _f(slot["input_tokens"]),
                "output_tokens": _f(slot["output_tokens"]),
                "events": int(slot["events"] or 0),
                "amount": _f(slot["amount"]),
                "share": _share(toks),
            }
        )
    knowledge_base_items.sort(key=lambda r: r["tokens"], reverse=True)
    knowledge_base_items = knowledge_base_items[:lim]

    return {
        "from": start,
        "to": end,
        "day_basis": "utc",
        "generated_at": utc_now_iso_z(),
        "total_tokens": total_tokens,
        "modules": module_items,
        "employees": employee_items,
        "conversations": conversation_items,
        "workflows": workflow_items,
        "knowledge": knowledge_items,
        "knowledge_bases": knowledge_base_items,
    }
