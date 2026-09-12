"""Tool approval state + replay queue (SQLite tables bound to chat sessions)."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any

from evoflow.agents.tool_approval_config import (
    RISK_SESSION,
    approval_signature,
    should_persist_tool_name_grant,
    summarize_tool_for_approval,
    tool_requires_approval,
    tool_risk_level,
)
from evoflow.agents.tool_approval_trace_log import log_tool_approval_trace
from evoflow.persistence import tool_approval_repositories as ta_repo
from evoflow.persistence.tool_approval_policy import (
    POLICY_GRANT_ALL,
    effective_policy,
    is_grant_all_policy,
    set_session_policy,
)

logger = logging.getLogger(__name__)

# ── Per-thread approval locks ──────────────────────────────────────────────────
# Prevent concurrent approve/deny on the same thread_id, which causes a TOCTOU
# race in _replay_ids_when_no_pending (two concurrent approvals can each get
# the full replay list, leading to duplicate tool execution).
_approval_locks: dict[str, threading.RLock] = {}
_approval_locks_guard = threading.Lock()
_APPROVAL_LOCKS_MAX = 4096


def _get_approval_lock(thread_id: str) -> threading.RLock:
    """Get or create a per-thread reentrant lock for approval operations."""
    tid = str(thread_id or "").strip()
    if not tid:
        tid = "__global__"
    with _approval_locks_guard:
        lock = _approval_locks.get(tid)
        if lock is None:
            lock = threading.RLock()
            _approval_locks[tid] = lock
            # Shed stale entries when the dict grows too large.
            if len(_approval_locks) > _APPROVAL_LOCKS_MAX:
                _approval_locks.clear()
        return lock


REPLAY_MARKER = "__evf_tool_approval_replay_v1__:"

_expire_sweep_last_at: dict[str, float] = {}
_EXPIRE_SWEEP_INTERVAL_S = max(
    30.0,
    float(os.getenv("EVOFLOW_TOOL_APPROVAL_EXPIRE_SWEEP_S", "60") or "60"),
)


def _maybe_expire_stale_pending(thread_id: str) -> None:
    """Throttled expire sweep — avoid UPDATE on every UI poll / stream tail tick."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    now = time.monotonic()
    last = _expire_sweep_last_at.get(tid, 0.0)
    if now - last < _EXPIRE_SWEEP_INTERVAL_S:
        return
    _expire_sweep_last_at[tid] = now
    ta_repo.expire_stale_pending(tid)


def thread_has_pending_approvals(thread_id: str) -> bool:
    """Lightweight pending probe for Gateway stream defer (no expire sweep)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    return ta_repo.thread_has_pending_approvals(tid)


@dataclass
class ToolApprovalApplyResult:
    reply: str
    replay_tool_call_ids: list[str]
    denied_tool_call_ids: list[str]
    resume_action: str = ""


@dataclass
class ToolApprovalApplyBundle:
    result: ToolApprovalApplyResult
    session_key: str
    still_pending: bool


def apply_user_approval_with_session(
    thread_id: str,
    data: dict[str, Any],
    *,
    workspace_root: str | None = None,
) -> ToolApprovalApplyBundle:
    """Single DB lock scope: approve + resolve session_key + pending probe."""
    import logging
    import time

    from evoflow.persistence.session_repositories import find_session_key_by_thread_id

    _log = logging.getLogger(__name__)
    tid = str(thread_id or "").strip()
    t0 = time.perf_counter()
    result = apply_user_approval(tid, data, workspace_root=workspace_root)
    t1 = time.perf_counter()
    sk = str(find_session_key_by_thread_id(tid) or "").strip()
    still_pending = thread_has_pending_approvals(tid)
    _log.info(
        "apply_user_approval_with_session thread=%s approve_ms=%.1f lookup_ms=%.1f still_pending=%s",
        tid,
        (t1 - t0) * 1000.0,
        (time.perf_counter() - t1) * 1000.0,
        still_pending,
    )
    return ToolApprovalApplyBundle(result=result, session_key=sk, still_pending=still_pending)


def _session_for_thread(thread_id: str) -> tuple[str, str]:
    return ta_repo.resolve_session_key_for_thread(thread_id)


def load_grants_for_thread(thread_id: str) -> dict[str, Any]:
    sk, _ = _session_for_thread(thread_id)
    runtime = ta_repo.load_runtime_signatures(sk)
    return {
        **runtime,
        "grant_all": is_grant_all_policy(effective_policy(sk)),
        "policy": effective_policy(sk),
    }


def _tool_name_granted(tool_name: str, grants: dict[str, Any]) -> bool:
    tn = str(tool_name or "").strip().lower()
    if not tn:
        return False
    names = grants.get("tool_names") or []
    return isinstance(names, list) and tn in names


def is_granted_for_thread(
    thread_id: str,
    tool_name: str,
    args: dict[str, Any],
    *,
    workspace_root: str | None = None,
) -> bool:
    sk, _ = _session_for_thread(thread_id)
    policy = effective_policy(sk)
    try:
        from evoflow.persistence.permission_preset_store import effective_preset_spec_for_thread

        preset_spec = effective_preset_spec_for_thread(thread_id)
    except Exception:
        preset_spec = None
    granted = False
    reason = ""
    if is_grant_all_policy(policy):
        granted = True
        reason = "grant_all"
    elif preset_spec is not None and not preset_spec.signature_grants_enabled:
        granted = False
        reason = "read_only_preset"
    else:
        grants = ta_repo.load_runtime_signatures(sk)
        if _tool_name_granted(tool_name, grants):
            granted = True
            reason = "tool_name_grant"
        else:
            sig = approval_signature(tool_name, args, workspace_root=workspace_root)
            sigs = grants.get("signatures") or []
            if isinstance(sigs, list) and sig in sigs:
                granted = True
                reason = "signature_grant"
    log_tool_approval_trace(
        "检查会话授权缓存",
        thread_id=thread_id,
        session_key=sk,
        tool_name=tool_name,
        有效策略=policy,
        已授权=granted,
        原因=reason or "未授权",
    )
    if granted:
        return True
    return False


def consume_signature_grant(
    thread_id: str,
    tool_name: str,
    args: dict[str, Any],
    *,
    workspace_root: str | None = None,
) -> None:
    """Consume one-shot signature grants; session-level grants persist.

    - ``RISK_SESSION``: signature persists (not consumed) — auto-runs for session.
    - ``RISK_CONFIRM``: signature consumed after one execution.
    - ``worker``: never has tool_name grant; session-risk signatures persist,
      confirm-risk signatures are consumed.
    """
    sk, tid = _session_for_thread(thread_id)
    policy = effective_policy(sk)
    if is_grant_all_policy(policy):
        return
    try:
        from evoflow.persistence.permission_preset_store import effective_preset_spec

        if not effective_preset_spec(sk).signature_grants_enabled:
            return
    except Exception:
        pass
    grants = ta_repo.load_runtime_signatures(sk)
    if _tool_name_granted(tool_name, grants):
        return
    # Session-risk tools: signature persists for the session (not consumed)
    if tool_risk_level(tool_name, args) == RISK_SESSION:
        return
    # Confirm-risk tools: consume the one-shot signature after execution
    sig = approval_signature(tool_name, args, workspace_root=workspace_root)
    sigs = [s for s in (grants.get("signatures") or []) if isinstance(s, str)]
    if sig in sigs:
        sigs = [s for s in sigs if s != sig]
        ta_repo.save_runtime_signatures(sk, tid, sigs, tool_names=list(grants.get("tool_names") or []))


def list_pending_approvals(thread_id: str) -> list[dict[str, Any]]:
    """Pending items awaiting user decision (for EvoPanel poll)."""
    from evoflow.agents.tool_approval_config import tool_risk_level

    _maybe_expire_stale_pending(thread_id)

    out = []
    for row in ta_repo.list_pending_for_thread(thread_id):
        tc_id = str(row.get("tool_call_id") or "").strip()
        if not tc_id:
            continue
        tn = str(row.get("tool_name") or "")
        row_args = row.get("args") if isinstance(row.get("args"), dict) else {}
        out.append(
            {
                "tool_call_id": tc_id,
                "tool_name": tn,
                "summary": str(row.get("summary") or ""),
                "args": row_args,
                "risk": tool_risk_level(tn, row_args),
                "created_at": row.get("created_at"),
            }
        )
    return out


def cancel_all_pending_approvals(thread_id: str, *, reason: str = "run_cancelled") -> int:
    n = ta_repo.cancel_pending_and_approved_for_thread(thread_id)
    if n:
        logger.info("Cancelled %s tool approval(s) on thread %s (%s)", n, thread_id, reason)
    return n


def begin_approval_batch(thread_id: str, keep_tool_call_ids: list[str] | None = None) -> int:
    """Cancel stale **PENDING** approvals before registering a new interrupt batch.

    Only cancels rows with status=PENDING that are *not* in ``keep_tool_call_ids``.
    APPROVED rows are preserved so previously approved-but-not-yet-replayed
    tools can still execute on the next resume.

    Additionally, when ``keep_tool_call_ids`` is provided, orphaned APPROVED rows
    from previous batches (those whose tool_call_id is not in the current batch)
    are marked EXECUTED to prevent cross-batch replay contamination.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    cancelled = ta_repo.cancel_pending_outside_ids(tid, keep_tool_call_ids)
    # Clean up orphaned APPROVED rows from previous batches that were never
    # executed (e.g. replay failed mid-way).  This prevents _replay_ids_when_no_pending
    # from pulling in stale approved rows from an older batch.
    orphaned: list[str] = []
    if keep_tool_call_ids is not None:
        try:
            keep_set = {str(x).strip() for x in keep_tool_call_ids if str(x).strip()}
            if keep_set:
                approved_rows = ta_repo.list_approved_for_replay(tid)
                orphaned = [
                    str(r.get("tool_call_id") or "").strip()
                    for r in approved_rows
                    if str(r.get("tool_call_id") or "").strip() not in keep_set
                ]
                for orphan_id in orphaned:
                    ta_repo.set_approval_status(tid, orphan_id, ta_repo.STATUS_EXECUTED)
        except Exception:
            logger.debug("begin_approval_batch: orphan cleanup failed thread=%s", tid, exc_info=True)
    log_tool_approval_trace("数据层·begin_batch", thread_id=tid, side="数据层",
        event_data={"keep_ids": list(keep_tool_call_ids or []), "cancelled": cancelled,
                    "orphaned_cleaned": len(orphaned)})
    return cancelled


def build_replay_message(tool_call_ids: list[str]) -> str:
    ids = [str(x).strip() for x in tool_call_ids if str(x).strip()]
    return f"{REPLAY_MARKER} {json.dumps({'tool_call_ids': ids}, ensure_ascii=False)}"


def parse_replay_message(text: str) -> list[str] | None:
    raw = str(text or "").strip()
    if not raw.lower().startswith(REPLAY_MARKER.lower()):
        return None
    try:
        data = json.loads(raw[len(REPLAY_MARKER) :].strip())
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    ids = data.get("tool_call_ids")
    if not isinstance(ids, list):
        return None
    return [str(x).strip() for x in ids if str(x).strip()]


def pop_replay_queue(thread_id: str, tool_call_ids: list[str] | None = None) -> list[dict[str, Any]]:
    """Peek approved entries **without** consuming them.

    Callers must call ``consume_replay_queue`` after the tools have executed
    successfully.  This avoids the destructive-consume bug where a failed
    execution left rows marked EXECUTED but no tool result existed.
    """
    tid = str(thread_id or "").strip()
    log_tool_approval_trace(
        "DB层·pop_replay_queue进入",
        thread_id=tid, side="数据层",
        event_data={"requested_ids": tool_call_ids or "ALL"},
    )
    entries = ta_repo.list_approved_for_replay(thread_id, tool_call_ids)
    if not entries:
        log_tool_approval_trace(
            "DB层·pop_replay_queue返回空",
            thread_id=tid, side="数据层",
            event_data={"requested_ids": tool_call_ids or "ALL"},
        )
        return []
    # 诊断：列出每个条目的关键字段
    _diag = []
    for e in entries:
        _diag.append({
            "tool_call_id": str(e.get("tool_call_id") or ""),
            "tool_name": str(e.get("tool_name") or ""),
            "status": str(e.get("status") or ""),
        })
    log_tool_approval_trace(
        "DB层·pop_replay_queue返回条目",
        thread_id=tid, side="数据层",
        event_data={"count": len(entries), "entries": _diag},
    )
    return [{**e, "status": "approved"} for e in entries]


def consume_replay_queue(thread_id: str, tool_call_ids: list[str]) -> None:
    """Mark approved entries as EXECUTED after tools have run successfully."""
    sk, _ = _session_for_thread(thread_id)
    ids = [str(x).strip() for x in (tool_call_ids or []) if str(x).strip()]
    if sk and ids:
        ta_repo.mark_replay_consumed(sk, ids)


def _entry_from_hint(
    thread_id: str,
    tool_call_id: str,
    hint: dict[str, Any],
    *,
    workspace_root: str | None = None,
) -> dict[str, Any] | None:
    """Create DB row from EvoPanel POST body when an old pending was never persisted."""
    tc_id = str(tool_call_id or "").strip()
    hint_name = str(hint.get("tool_name") or "").strip()
    if not tc_id or not hint_name or not tool_requires_approval(hint_name):
        return None
    hint_args = hint.get("args") if isinstance(hint.get("args"), dict) else {}
    summary = str(hint.get("summary") or "").strip() or summarize_tool_for_approval(hint_name, hint_args)
    entry = make_pending_entry(
        tool_call_id=tc_id,
        tool_name=hint_name,
        args=hint_args,
        summary=summary,
        workspace_root=workspace_root,
    )
    append_pending(thread_id, entry)
    return entry


def _approve_pending_row(
    sk: str,
    tid: str,
    row: dict[str, Any],
    grants: dict[str, Any],
    *,
    workspace_root: str | None = None,
    force_remember: bool = False,
) -> str:
    """Mark one pending row approved; persist grants based on risk level.

    - Normal approve: one-shot signature (and optional session tool grant when policy says so)
    - force_remember / approve_remember: also persist tool_name for this session
      (「始终允许本项目」)
    """
    tc_id = str(row.get("tool_call_id") or "").strip()
    if not tc_id:
        return ""
    sigs = list(grants.get("signatures") or [])
    tool_names = list(grants.get("tool_names") or [])
    tn = str(row.get("tool_name") or "").strip().lower()
    row_args = row.get("args") if isinstance(row.get("args"), dict) else {}
    persist_name = force_remember or should_persist_tool_name_grant(tn, row_args)
    if tn and persist_name and tn not in tool_names:
        tool_names.append(tn)
    # Always add the one-shot signature (consumed after execution for confirm-risk)
    sig = str(row.get("signature") or approval_signature(str(row.get("tool_name") or ""), row_args, workspace_root=workspace_root))
    if isinstance(sigs, list) and sig and sig not in sigs:
        sigs.append(sig)
    ta_repo.save_runtime_signatures(sk, tid, sigs, tool_names=tool_names)
    ta_repo.set_approval_status(sk, tc_id, ta_repo.STATUS_APPROVED)
    return tc_id


def _replay_ids_when_no_pending(tid: str) -> list[str]:
    """When every pending item is resolved, replay all approved rows in order."""
    if ta_repo.list_pending_for_thread(tid):
        return []
    approved = ta_repo.list_approved_for_replay(tid)
    return [str(e.get("tool_call_id") or "").strip() for e in approved if str(e.get("tool_call_id") or "").strip()]


def apply_user_approval(
    thread_id: str,
    data: dict[str, Any],
    *,
    workspace_root: str | None = None,
) -> ToolApprovalApplyResult:
    tid = str(thread_id or "").strip()
    lock = _get_approval_lock(tid)
    with lock:
        sk, _ = _session_for_thread(tid)
        grants = ta_repo.load_grants(sk)
        action = str(data.get("action") or "").strip().lower()
        tc_id = str(data.get("tool_call_id") or "").strip()

        log_tool_approval_trace("数据层·收到审批请求", thread_id=tid, side="数据层",
            event_data={"action": action, "tool_call_id": tc_id})

        log_tool_approval_trace("数据层·获得审批锁", thread_id=tid, side="数据层",
            event_data={"action": action})

        if action == "approve_all":
            pending = ta_repo.list_pending_for_thread(tid)
            log_tool_approval_trace("数据层·批量批准", thread_id=tid, side="数据层",
                event_data={"count": len(pending), "ids": [str(p.get("tool_call_id") or "") for p in pending]})
            for p in pending:
                _approve_pending_row(sk, tid, p, grants, workspace_root=workspace_root)
                grants = ta_repo.load_grants(sk)
                ta_repo.write_audit_log(
                    session_key=sk,
                    thread_id=tid,
                    tool_call_id=str(p.get("tool_call_id") or ""),
                    tool_name=str(p.get("tool_name") or ""),
                    args=p.get("args") if isinstance(p.get("args"), dict) else {},
                    action="approve",
                )
            replay_ids = _replay_ids_when_no_pending(tid)
            log_tool_approval_trace("数据层·replay_ids计算", thread_id=tid, side="数据层",
                event_data={"replay_ids": replay_ids, "remaining_pending": 0})
            n = len(replay_ids)
            return ToolApprovalApplyResult(
                reply=f"已批准本批 {n} 个工具，正在执行…" if n else "没有待授权项。",
                replay_tool_call_ids=replay_ids,
                denied_tool_call_ids=[],
            )

        if action == "grant_all":
            set_session_policy(sk, POLICY_GRANT_ALL)
            pending = ta_repo.list_pending_for_thread(tid)
            log_tool_approval_trace("数据层·grant_all", thread_id=tid, side="数据层",
                event_data={"count": len(pending)})
            replay_ids = [str(p.get("tool_call_id") or "").strip() for p in pending]
            replay_ids = [x for x in replay_ids if x]
            for p in pending:
                p_id = str(p.get("tool_call_id") or "").strip()
                if p_id:
                    ta_repo.set_approval_status(sk, p_id, ta_repo.STATUS_APPROVED)
                    ta_repo.write_audit_log(
                        session_key=sk,
                        thread_id=tid,
                        tool_call_id=p_id,
                        tool_name=str(p.get("tool_name") or ""),
                        args=p.get("args") if isinstance(p.get("args"), dict) else {},
                        action="grant_all",
                    )
            ta_repo.save_runtime_signatures(
                sk,
                tid,
                list(grants.get("signatures") or []),
                tool_names=list(grants.get("tool_names") or []),
            )
            return ToolApprovalApplyResult(
                reply="已开启本会话全部工具授权；正在执行已批准的副作用工具。",
                replay_tool_call_ids=replay_ids,
                denied_tool_call_ids=[],
            )

        if action == "approve_remember" and tc_id:
            patched = dict(data or {})
            patched["action"] = "approve"
            patched["remember"] = True
            data = patched
            action = "approve"

        if action == "approve" and tc_id:
            hit = ta_repo.get_approval_row(sk, tc_id)
            if not hit or str(hit.get("status") or "") != ta_repo.STATUS_PENDING:
                recovered = _entry_from_hint(
                    tid,
                    tc_id,
                    {
                        "tool_name": data.get("tool_name"),
                        "args": data.get("args"),
                        "summary": data.get("summary"),
                    },
                    workspace_root=workspace_root,
                )
                hit = recovered or ta_repo.get_approval_row(sk, tc_id)
            if not hit or str(hit.get("status") or "") != ta_repo.STATUS_PENDING:
                return ToolApprovalApplyResult(
                    reply=f"未找到待授权项 {tc_id}。",
                    replay_tool_call_ids=[],
                    denied_tool_call_ids=[],
                )
            log_tool_approval_trace("数据层·找到pending行", thread_id=tid, side="数据层",
                event_data={"tool_call_id": tc_id, "status": str(hit.get("status") or "")})
            force_remember = bool(data.get("remember") or data.get("always") or data.get("always_allow"))
            if str(data.get("scope") or "").strip().lower() in {"session", "project", "tool"}:
                force_remember = True
            _approve_pending_row(
                sk,
                tid,
                hit,
                grants,
                workspace_root=workspace_root,
                force_remember=force_remember,
            )
            log_tool_approval_trace("数据层·工具已标记approved", thread_id=tid, side="数据层",
                event_data={"tool_call_id": tc_id, "remember": force_remember})
            ta_repo.write_audit_log(
                session_key=sk,
                thread_id=tid,
                tool_call_id=tc_id,
                tool_name=str(hit.get("tool_name") or ""),
                args=hit.get("args") if isinstance(hit.get("args"), dict) else {},
                action="approve_remember" if force_remember else "approve",
            )
            name = str(hit.get("tool_name") or "")
            replay_ids = _replay_ids_when_no_pending(tid)
            remaining = ta_repo.list_pending_for_thread(tid)
            log_tool_approval_trace("数据层·replay_ids计算", thread_id=tid, side="数据层",
                event_data={"replay_ids": replay_ids, "remaining_pending": len(remaining)})
            if replay_ids:
                log_tool_approval_trace("数据层·返回replay_ids", thread_id=tid, side="数据层",
                    event_data={"replay_ids": replay_ids, "reply": f"已全部确认，正在执行 {len(replay_ids)} 个工具…"})
                return ToolApprovalApplyResult(
                    reply=(
                        f"已记住本会话「{name}」授权，正在执行…"
                        if force_remember
                        else f"已全部确认，正在执行 {len(replay_ids)} 个工具…"
                    ),
                    replay_tool_call_ids=replay_ids,
                    denied_tool_call_ids=[],
                )
            log_tool_approval_trace("数据层·返回await_next", thread_id=tid, side="数据层",
                event_data={"remaining_pending": len(remaining), "reply": "等待其他工具授权"})
            return ToolApprovalApplyResult(
                reply=(
                    f"已记住本会话「{name}」授权，尚有 {len(remaining)} 个工具待授权。"
                    if force_remember
                    else f"已批准 {name}，尚有 {len(remaining)} 个工具待授权。"
                ),
                replay_tool_call_ids=[],
                denied_tool_call_ids=[],
                resume_action="await_next",
            )

        if action == "deny" and tc_id:
            row = ta_repo.get_approval_row(sk, tc_id)
            tool_name = str((row or {}).get("tool_name") or data.get("tool_name") or "")
            if row and str(row.get("status") or "") == ta_repo.STATUS_PENDING:
                ta_repo.set_approval_status(sk, tc_id, ta_repo.STATUS_DENIED)
                ta_repo.write_audit_log(
                    session_key=sk,
                    thread_id=tid,
                    tool_call_id=tc_id,
                    tool_name=tool_name,
                    args=row.get("args") if isinstance(row.get("args"), dict) else {},
                    action="deny",
                )
            # 立刻把 transcript 从 pending_approval 改成 denied（不能等 deny_run；
            # append 会因 tool_call_id 去重跳过，必须 UPDATE）。
            _persist_denied_tool_transcript(sk, tc_id, tool_name=tool_name)
            log_tool_approval_trace("数据层·工具已标记denied", thread_id=tid, side="数据层",
                event_data={"tool_call_id": tc_id})
            remaining = ta_repo.list_pending_for_thread(tid)
            if remaining:
                # 与部分批准对称：同批还有待授权时绝不 resume / deny_run，
                # 否则图会继续跑、后面的 sibling 仍可被批或被 signature_grant 放行。
                log_tool_approval_trace(
                    "数据层·拒绝后返回await_next",
                    thread_id=tid,
                    side="数据层",
                    event_data={"denied": tc_id, "remaining_pending": len(remaining)},
                )
                return ToolApprovalApplyResult(
                    reply=f"已拒绝工具调用 {tc_id}，尚有 {len(remaining)} 个工具待授权。",
                    replay_tool_call_ids=[],
                    denied_tool_call_ids=[tc_id],
                    resume_action="await_next",
                )
            replay_ids = _replay_ids_when_no_pending(tid)
            denied_ids = [
                str(e.get("tool_call_id") or "").strip()
                for e in ta_repo.list_denied_for_thread(tid)
                if str(e.get("tool_call_id") or "").strip()
            ]
            if not denied_ids:
                denied_ids = [tc_id]
            if replay_ids:
                # 同批有的拒绝、有的已批准：走 replay 执行已批准项
                log_tool_approval_trace(
                    "数据层·拒绝后返回replay_ids",
                    thread_id=tid,
                    side="数据层",
                    event_data={"replay_ids": replay_ids, "denied_ids": denied_ids},
                )
                return ToolApprovalApplyResult(
                    reply=f"已拒绝部分工具；正在执行已批准的 {len(replay_ids)} 个工具。",
                    replay_tool_call_ids=replay_ids,
                    denied_tool_call_ids=denied_ids,
                )
            log_tool_approval_trace(
                "数据层·本批全部拒绝",
                thread_id=tid,
                side="数据层",
                event_data={"denied_ids": denied_ids},
            )
            return ToolApprovalApplyResult(
                reply="已拒绝本批全部待授权工具。",
                replay_tool_call_ids=[],
                denied_tool_call_ids=denied_ids,
            )

        pending = ta_repo.list_pending_for_thread(tid)
        if action == "approve_latest" and pending:
            last = pending[-1]
            return apply_user_approval(
                thread_id,
                {"action": "approve", "tool_call_id": str(last.get("tool_call_id") or "")},
                workspace_root=workspace_root,
            )

        return ToolApprovalApplyResult(
            reply="无法识别的授权指令。",
            replay_tool_call_ids=[],
            denied_tool_call_ids=[],
        )


def _denied_tool_transcript_content(*, reason: str = "用户已拒绝") -> str:
    import json

    return json.dumps(
        {
            "_evoflow_tool": {"status": "denied"},
            "message": f"[denied] {reason}",
        },
        ensure_ascii=False,
    )


def _persist_denied_tool_transcript(
    session_key: str,
    tool_call_id: str,
    *,
    tool_name: str = "",
    reason: str = "用户已拒绝",
) -> None:
    """Overwrite pending_approval tool row → denied (append would dedupe-skip)."""
    sk = str(session_key or "").strip()
    tc = str(tool_call_id or "").strip()
    if not sk or not tc:
        return
    try:
        from evoflow.persistence.chat_message_repositories import update_tool_transcript_content

        update_tool_transcript_content(
            sk,
            tc,
            content=_denied_tool_transcript_content(reason=reason),
            tool_name=str(tool_name or "").strip() or None,
        )
    except Exception:
        import logging

        logging.getLogger(__name__).debug(
            "persist denied tool transcript failed sk=%s tc=%s",
            sk,
            tc,
            exc_info=True,
        )


def make_pending_entry(
    *,
    tool_call_id: str,
    tool_name: str,
    args: dict[str, Any],
    summary: str,
    workspace_root: str | None = None,
) -> dict[str, Any]:
    from evoflow.timeutil import utc_now_iso_z

    return {
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "args": dict(args or {}),
        "summary": summary,
        "signature": approval_signature(tool_name, args, workspace_root=workspace_root),
        "status": ta_repo.STATUS_PENDING,
        "created_at": utc_now_iso_z(),
    }


def append_pending(thread_id: str, entry: dict[str, Any]) -> None:
    sk, tid = _session_for_thread(thread_id)
    existing = ta_repo.get_approval_row(sk, str(entry.get("tool_call_id") or ""))
    if existing and str(existing.get("status") or "") in (
        ta_repo.STATUS_EXECUTED,
        ta_repo.STATUS_DENIED,
        ta_repo.STATUS_APPROVED,
    ):
        return
    ta_repo.upsert_pending(
        session_key=sk,
        thread_id=tid,
        tool_call_id=str(entry.get("tool_call_id") or ""),
        tool_name=str(entry.get("tool_name") or ""),
        args=dict(entry.get("args") or {}),
        summary=str(entry.get("summary") or ""),
        signature=str(entry.get("signature") or ""),
    )
    from evoflow.agents.tool_approval_pause_registry import mark_tool_approval_pause

    mark_tool_approval_pause(tid)


__all__ = [
    "REPLAY_MARKER",
    "ToolApprovalApplyBundle",
    "ToolApprovalApplyResult",
    "append_pending",
    "apply_user_approval",
    "apply_user_approval_with_session",
    "build_replay_message",
    "cancel_all_pending_approvals",
    "begin_approval_batch",
    "consume_signature_grant",
    "is_granted_for_thread",
    "list_pending_approvals",
    "thread_has_pending_approvals",
    "load_grants_for_thread",
    "make_pending_entry",
    "parse_replay_message",
    "pop_replay_queue",
    "consume_replay_queue",
    "tool_requires_approval",
    "summarize_tool_for_approval",
]
