from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from evoflow.agents.message_analysis_utils import is_real_user_message
from evoflow.agents.mission_state.config import (
    MISSION_STATE_ANALYSIS_PAIRS,
    MISSION_STATE_ANALYZE_SCENARIOS,
    MISSION_STATE_INCLUDE_READ_REGISTRY,
    MISSION_STATE_MIN_OBJECTIVE_CONFIDENCE,
)
from evoflow.agents.mission_state.logging_utils import log_analyzer_io
from evoflow.agents.mission_state.models import MissionState
from evoflow.agents.mission_state.prompt import build_mission_analyzer_prompt
from evoflow.agents.mission_state.state_manager import stabilize_intent_transition
from evoflow.models import create_chat_model

logger = logging.getLogger(__name__)


def _extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return str(content)


def _msg_type(m: Any) -> str:
    t = getattr(m, "type", None)
    if isinstance(t, str) and t:
        return t
    if isinstance(m, dict):
        role = str(m.get("role") or m.get("type") or "").strip().lower()
        if role in {"user", "human"}:
            return "human"
        if role in {"assistant", "ai"}:
            return "ai"
        return role
    return ""


def _msg_content(m: Any) -> Any:
    c = getattr(m, "content", None)
    if c is not None:
        return c
    if isinstance(m, dict):
        if "content" in m:
            return m.get("content")
        # OpenAI-style message list may contain {"type":"text","text":"..."}
        if isinstance(m.get("parts"), list):
            return m.get("parts")
    return ""


def _conversation_window(messages: list[Any], *, max_pairs: int) -> str:
    rows: list[str] = []
    for m in messages:
        t = _msg_type(m)
        if t not in ("human", "ai"):
            continue
        if t == "human" and not is_real_user_message(m):
            continue
        text = _extract_text(_msg_content(m)).strip()
        if not text:
            continue
        if len(text) > 1200:
            text = text[:1200] + "..."
        rows.append(f"{'User' if t == 'human' else 'Assistant'}: {text}")
    if not rows:
        return ""
    return "\n\n".join(rows[-(max_pairs * 2) :])


def _strip_fence(s: str) -> str:
    text = s.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 2:
            lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            return "\n".join(lines).strip()
    return text


_JSON_FALLBACK_RE = re.compile(r"\{[\s\S]*\}")


def _normalize_subproblems(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for i, item in enumerate(value, start=1):
        if isinstance(item, dict):
            out.append(item)
            continue
        if isinstance(item, str):
            title = item.strip()
            if not title:
                continue
            out.append(
                {
                    "id": f"sp_{i}",
                    "title": title[:120],
                    "status": "pending",
                    "priority": 3,
                    "evidence": "",
                    "suggested_tools": [],
                }
            )
    return out


def _normalize_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        s = value.strip()
        return [s] if s else []
    if not isinstance(value, list):
        s = str(value).strip()
        return [s] if s else []
    out: list[str] = []
    for item in value:
        if item is None:
            continue
        if isinstance(item, str):
            s = item.strip()
            if s:
                out.append(s)
            continue
        if isinstance(item, dict):
            # done_subproblems may come as objects; keep readable summary
            title = str(item.get("title") or item.get("id") or "").strip()
            summary = str(item.get("summary") or item.get("evidence") or "").strip()
            if title and summary:
                out.append(f"{title}: {summary}")
            elif title:
                out.append(title)
            elif summary:
                out.append(summary)
            continue
        s = str(item).strip()
        if s:
            out.append(s)
    return out


def _normalize_payload(data: dict[str, Any]) -> dict[str, Any]:
    out = dict(data)
    primary = str(out.get("primary_objective") or "").strip()
    if len(primary) > 280:
        primary = primary[:277] + "…"
    out["primary_objective"] = primary
    subs = _normalize_subproblems(out.get("active_subproblems"))[:5]
    for i, sp in enumerate(subs, start=1):
        if not str(sp.get("id") or "").strip():
            sp["id"] = f"sp_{i}"
        sp["title"] = str(sp.get("title") or "")[:80].strip()
        st = str(sp.get("status") or "pending").strip().lower()
        if st not in {"pending", "in_progress", "blocked", "done"}:
            st = "pending"
        sp["status"] = st
    out["active_subproblems"] = subs
    out["success_criteria"] = _normalize_str_list(out.get("success_criteria"))[:3]
    out["constraints"] = _normalize_str_list(out.get("constraints"))[:8]
    out["done_subproblems"] = [s[:120] for s in _normalize_str_list(out.get("done_subproblems"))[:12]]
    out["out_of_scope"] = _normalize_str_list(out.get("out_of_scope"))[:8]
    summary = str(out.get("exploration_summary") or "").strip()
    if len(summary) > 2000:
        summary = summary[:1999] + "…"
    out["exploration_summary"] = summary
    out["exploration_gaps"] = [s[:160] for s in _normalize_str_list(out.get("exploration_gaps"))[:3]]
    task_type = str(out.get("task_type") or "").strip().lower()
    allowed = {"locate_file", "understand_code", "data_bug", "implement", "runtime", "general"}
    out["task_type"] = task_type if task_type in allowed else ""
    try:
        conf = float(out.get("objective_confidence") or 0)
        out["objective_confidence"] = max(0.0, min(1.0, conf))
    except (TypeError, ValueError):
        out["objective_confidence"] = 0.0
    ct = str(out.get("change_type") or "update").strip().lower()
    out["change_type"] = ct if ct in {"noop", "update", "reset"} else "update"
    return out


class MissionStateUpdater:
    def __init__(self, model_name: str | None = None):
        self._model_name = model_name

    def _get_model(self):
        return create_chat_model(name=self._model_name, thinking_enabled=False, invocation_kind="mission_state")

    @staticmethod
    def _preserve_intent_hint(previous: MissionState | None, current: MissionState) -> str:
        """场景不由异步分析器推断时，始终保留上一轮 intent_hint（默认 chat）。"""
        if not MISSION_STATE_ANALYZE_SCENARIOS:
            if previous and str(previous.intent_hint or "").strip():
                return str(previous.intent_hint).strip()
            return "chat"
        return str(current.intent_hint or (previous.intent_hint if previous else "chat") or "chat").strip()

    def _merge_state(self, thread_id: str, previous: MissionState | None, current: MissionState) -> MissionState:
        if previous is None:
            current.intent_hint = self._preserve_intent_hint(None, current)
            return current
        if MISSION_STATE_ANALYZE_SCENARIOS:
            stabilized_intent = stabilize_intent_transition(
                thread_id,
                previous_intent=previous.intent_hint,
                candidate_intent=current.intent_hint,
                change_type=current.change_type,
                min_chat_rounds=5,
            )
        else:
            stabilized_intent = self._preserve_intent_hint(previous, current)
        if current.change_type == "reset":
            # reset means a major topic shift — rebuild state from current LLM output,
            # but still preserve activated_scenarios from previous (agent-managed).
            if previous and previous.activated_scenarios:
                current.activated_scenarios = list(previous.activated_scenarios)
            current.intent_hint = self._preserve_intent_hint(previous, current)
            try:
                from evoflow.context.working_memory import clear_registry

                clear_registry(thread_id)
            except Exception:
                pass
            return current
        if current.change_type == "noop":
            keep = previous.model_copy(deep=True)
            keep.version = max(previous.version + 1, current.version)
            keep.ts_ms = current.ts_ms
            keep.turn_id = current.turn_id or previous.turn_id
            keep.intent_hint = stabilized_intent
            return keep
        # update: field-level merge to avoid dropping useful prior context
        merged = previous.model_copy(deep=True)
        if current.primary_objective:
            merged.primary_objective = current.primary_objective
        merged.objective_confidence = current.objective_confidence or merged.objective_confidence
        if current.success_criteria:
            merged.success_criteria = current.success_criteria
        if current.constraints:
            merged.constraints = current.constraints
        if current.active_subproblems:
            merged.active_subproblems = current.active_subproblems
        if current.done_subproblems:
            merged.done_subproblems = current.done_subproblems
        if current.out_of_scope:
            merged.out_of_scope = current.out_of_scope
        if current.exploration_summary:
            merged.exploration_summary = current.exploration_summary
        if current.exploration_gaps:
            merged.exploration_gaps = current.exploration_gaps
        # activated_scenarios is exclusively agent-managed (via scenario() tool).
        # Never let the async LLM analyzer's output (current) override this field.
        # Always carry forward from previous; if previous is None, keep default [].
        if previous and previous.activated_scenarios:
            merged.activated_scenarios = list(previous.activated_scenarios)
        else:
            merged.activated_scenarios = []
        merged.intent_hint = stabilized_intent or merged.intent_hint
        merged.change_type = "update"
        merged.ts_ms = current.ts_ms
        merged.turn_id = current.turn_id or previous.turn_id
        merged.version = max(previous.version + 1, current.version)
        return merged

    def update(
        self,
        *,
        thread_id: str,
        messages: list[Any],
        previous: MissionState | None,
        mode: str,
    ) -> MissionState | None:
        max_pairs = MISSION_STATE_ANALYSIS_PAIRS
        conv = _conversation_window(messages, max_pairs=max_pairs)
        if not conv:
            return None
        prev_json = previous.model_dump_json(ensure_ascii=False, indent=2) if previous else "{}"
        read_registry = ""
        if MISSION_STATE_INCLUDE_READ_REGISTRY:
            try:
                from evoflow.context.working_memory import format_read_registry_for_analyzer

                read_registry = format_read_registry_for_analyzer(thread_id)
            except Exception:
                read_registry = ""
        write_registry = ""
        try:
            from evoflow.context.working_memory import format_write_registry_for_analyzer

            write_registry = format_write_registry_for_analyzer(thread_id)
        except Exception:
            write_registry = ""
        prompt = build_mission_analyzer_prompt(
            thread_id=thread_id,
            mode=mode,
            previous_state_json=prev_json,
            conversation=conv,
            analyze_scenarios=MISSION_STATE_ANALYZE_SCENARIOS,
            read_registry=read_registry,
            write_registry=write_registry,
        )
        try:
            t_start = time.time()
            log_analyzer_io(
                "invoke",
                thread_id=thread_id,
                mode=mode,
                max_pairs=max_pairs,
                previous_state_json=prev_json,
                conversation_window=conv,
            )
            t_invoke_start = time.time()
            resp = self._get_model().invoke(prompt)
            invoke_elapsed_ms = int((time.time() - t_invoke_start) * 1000)
            invoke_elapsed_s = f"{invoke_elapsed_ms / 1000:.3f}s"
            raw = _strip_fence(_extract_text(resp.content))
            log_analyzer_io(
                "raw_response",
                thread_id=thread_id,
                mode=mode,
                invoke_elapsed_ms=invoke_elapsed_ms,
                invoke_elapsed_s=invoke_elapsed_s,
                raw=raw,
            )
            try:
                data = json.loads(raw)
            except Exception:
                m = _JSON_FALLBACK_RE.search(raw)
                if not m:
                    log_analyzer_io(
                        "parse_failed_no_json",
                        thread_id=thread_id,
                        mode=mode,
                        raw=raw,
                    )
                    return None
                data = json.loads(m.group(0))
            if not isinstance(data, dict):
                log_analyzer_io(
                    "parse_failed_not_dict",
                    thread_id=thread_id,
                    mode=mode,
                    raw=raw,
                )
                return None
            data = _normalize_payload(data)
            data["thread_id"] = thread_id
            data["ts_ms"] = int(time.time() * 1000)
            if previous:
                data["version"] = max(int(previous.version) + 1, int(data.get("version") or 1))
            else:
                data["version"] = max(1, int(data.get("version") or 1))
            if not MISSION_STATE_ANALYZE_SCENARIOS:
                data.pop("intent_hint", None)
            state = MissionState.model_validate(data)
            if not MISSION_STATE_ANALYZE_SCENARIOS:
                state.intent_hint = self._preserve_intent_hint(previous, state)
            if state.objective_confidence < MISSION_STATE_MIN_OBJECTIVE_CONFIDENCE and previous and previous.primary_objective:
                state.primary_objective = previous.primary_objective
            # activated_scenarios is agent-managed (via scenario() tool), NOT LLM-managed.
            # The LLM analyzer should never produce this field, but defensively ignore it
            # even if it does — always carry forward from previous state.
            state.activated_scenarios = list(previous.activated_scenarios) if previous and previous.activated_scenarios else []
            state = self._merge_state(thread_id, previous, state)
            total_elapsed_ms = int((time.time() - t_start) * 1000)
            total_elapsed_s = f"{total_elapsed_ms / 1000:.3f}s"
            log_analyzer_io(
                "parsed_state",
                thread_id=thread_id,
                mode=mode,
                invoke_elapsed_ms=invoke_elapsed_ms,
                invoke_elapsed_s=invoke_elapsed_s,
                total_elapsed_ms=total_elapsed_ms,
                total_elapsed_s=total_elapsed_s,
                state=state.model_dump(mode="json"),
            )
            return state
        except Exception as e:
            logger.warning("MissionState update failed for thread %s: %s", thread_id, e)
            log_analyzer_io(
                "exception",
                thread_id=thread_id,
                mode=mode,
                error=str(e),
            )
            return None
