"""Map OpenAI-style chat/completions bodies onto App parameters (FastGPT-aligned).

External clients call ``POST /v1/chat/completions`` with Bearer app keys.
This module is the pure mapping + wait helpers used by the gateway facade.
"""

from __future__ import annotations

import os
import time
from typing import Any

from evoflow.persistence import app_repositories

# Parameter names that may absorb the last user message (FastGPT-like query slot).
_MESSAGE_PARAM_ALIASES = ("query", "input", "prompt")

_SNAPSHOT_KEYS = (
    "name",
    "description",
    "icon",
    "category",
    "parameters",
    "steps",
    "canvas",
    "goal_template",
    "validation_template",
    "flowchart_mermaid",
    "execution_mode",
    "auto_run",
    "tags",
    "answer_from_ref",
)


def load_app_for_run(
    app_id: str,
    *,
    pinned_version: int | None = None,
) -> dict[str, Any]:
    """Load app definition for OpenAPI / workflow run.

    When ``pinned_version`` is set, merge that immutable revision snapshot.
    Falls back to the live app row when pin is missing or revision not found.
    """
    current = app_repositories.load_app(app_id)
    if current is None:
        raise ValueError(f"Application not found: {app_id}")

    if pinned_version is None:
        return current

    rev = app_repositories.load_revision(app_id, int(pinned_version))
    if rev is None:
        # Legacy / deleted revision: run current definition
        return current
    snap = rev.get("snapshot")
    if not isinstance(snap, dict):
        return current

    merged = dict(current)
    for key in _SNAPSHOT_KEYS:
        if key in snap:
            merged[key] = snap[key]
    merged["id"] = app_id
    merged["version"] = int(pinned_version)
    # OpenAPI still requires published status on the live row; keep it.
    merged["status"] = current.get("status") or merged.get("status")
    return merged

_TERMINAL_STATUSES = frozenset(
    {"completed", "failed", "cancelled", "canceled", "error", "timeout"}
)


def extract_last_user_text(messages: list[Any] | None) -> str:
    """Return the content of the last ``role=user`` message as plain text."""
    if not messages:
        return ""
    for item in reversed(messages):
        if not isinstance(item, dict):
            continue
        if str(item.get("role") or "").strip().lower() != "user":
            continue
        content = item.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
                elif isinstance(block, str):
                    parts.append(block)
            return "\n".join(p for p in parts if p).strip()
        if content is not None:
            return str(content).strip()
    return ""


def map_chat_to_parameters(
    app: dict[str, Any],
    *,
    variables: dict[str, Any] | None = None,
    messages: list[Any] | None = None,
) -> dict[str, str]:
    """Build ``parameters`` for :func:`run_app` from FastGPT-style chat fields.

    - ``variables`` values become string parameters (by name).
    - Last user message fills ``query`` / ``input`` / ``prompt`` when that param
      is defined on the app and not already present in ``variables``.
    """
    params: dict[str, str] = {}
    if isinstance(variables, dict):
        for key, value in variables.items():
            name = str(key or "").strip()
            if not name:
                continue
            if value is None:
                params[name] = ""
            elif isinstance(value, (dict, list)):
                import json

                params[name] = json.dumps(value, ensure_ascii=False)
            else:
                params[name] = str(value)

    defined = app.get("parameters") if isinstance(app.get("parameters"), list) else []
    defined_names = {
        str(p.get("name") or "").strip()
        for p in defined
        if isinstance(p, dict) and str(p.get("name") or "").strip()
    }

    user_text = extract_last_user_text(messages)
    if user_text:
        for alias in _MESSAGE_PARAM_ALIASES:
            if alias in defined_names and alias not in params:
                params[alias] = user_text
                break

    return params


def _is_required_param(spec: dict[str, Any]) -> bool:
    required = spec.get("required")
    if required in (True, 1, "1", "true", "True", "yes", "required"):
        return True
    return False


def missing_required_parameters(
    app: dict[str, Any],
    parameters: dict[str, Any] | None,
) -> list[str]:
    """Return required parameter names that are missing or blank after mapping."""
    defined = app.get("parameters") if isinstance(app.get("parameters"), list) else []
    params = parameters if isinstance(parameters, dict) else {}
    missing: list[str] = []
    for p in defined:
        if not isinstance(p, dict) or not _is_required_param(p):
            continue
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        raw = params.get(name)
        if raw is None or str(raw).strip() == "":
            missing.append(name)
    return missing


def resolve_app_id_from_request(
    *,
    bound_app_id: str,
    body_app_id: str | None = None,
    model: str | None = None,
) -> str:
    """Resolve target app id; body ``appId`` / ``model`` must match the key when set."""
    app_id = str(bound_app_id or "").strip()
    if not app_id:
        raise ValueError("API key is not bound to an application")

    for label, raw in (("appId", body_app_id), ("model", model)):
        value = str(raw or "").strip()
        if not value:
            continue
        # OpenAI SDK often sends a dummy model; treat non-matching only as conflict
        # when it looks like our app id (starts with App_ / equals bound id).
        if value == app_id:
            continue
        if value.startswith("App_") or label == "appId":
            if value != app_id:
                raise ValueError(
                    f"{label} '{value}' does not match API key app '{app_id}'"
                )
    return app_id


def openai_completions_timeout_sec() -> float:
    raw = str(os.environ.get("EVOFLOW_APP_OPENAPI_TIMEOUT_SEC") or "600").strip()
    try:
        return max(5.0, float(raw))
    except ValueError:
        return 600.0


def iter_run_status(
    run_id: str,
    *,
    get_status,
    timeout_sec: float | None = None,
    poll_interval_sec: float = 1.0,
):
    """Yield status documents until terminal or timeout.

    Yields:
        ``(status_doc, is_terminal)`` for each poll with a dict payload.

    Raises:
        TimeoutError: ``(run_id, last_status_doc)`` when deadline hit without terminal.
    """
    deadline = time.monotonic() + float(
        timeout_sec if timeout_sec is not None else openai_completions_timeout_sec()
    )
    last: dict[str, Any] | None = None
    while True:
        status_doc = get_status(run_id)
        if isinstance(status_doc, dict):
            last = status_doc
            status = str(status_doc.get("status") or "").strip().lower()
            terminal = status in _TERMINAL_STATUSES
            yield status_doc, terminal
            if terminal:
                return
        if time.monotonic() >= deadline:
            raise TimeoutError(run_id, last)
        time.sleep(max(0.1, float(poll_interval_sec)))


def wait_for_run_terminal(
    run_id: str,
    *,
    get_status,
    timeout_sec: float | None = None,
    poll_interval_sec: float = 1.0,
) -> dict[str, Any]:
    """Poll ``get_status(run_id)`` until a terminal status or timeout.

    Raises:
        TimeoutError: when elapsed exceeds timeout (includes last status in args if any).
    """
    final: dict[str, Any] | None = None
    for status_doc, terminal in iter_run_status(
        run_id,
        get_status=get_status,
        timeout_sec=timeout_sec,
        poll_interval_sec=poll_interval_sec,
    ):
        final = status_doc
        if terminal:
            return status_doc
    raise TimeoutError(run_id, final)


_STEP_DONE = frozenset(
    {"completed", "done", "success", "failed", "error", "cancelled", "canceled"}
)


def _step_rows(status_doc: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("steps", "steps_detail"):
        rows = status_doc.get(key)
        if isinstance(rows, list):
            return [r for r in rows if isinstance(r, dict)]
    return []


def resolve_step_agent(step: dict[str, Any] | None) -> str:
    """Best-effort agent identity for an App step / subtask row."""
    if not isinstance(step, dict):
        return ""
    wp = step.get("worker_profile") if isinstance(step.get("worker_profile"), dict) else {}
    return str(
        step.get("assigned_agent")
        or step.get("assigned_to")
        or step.get("agent_id")
        or step.get("agent_code")
        or wp.get("base_subagent")
        or wp.get("agent_code")
        or ""
    ).strip()


def publicize_step_response(step: dict[str, Any]) -> dict[str, Any]:
    """FastGPT-aligned node row for OpenAPI ``detail`` / ``flowResponses``.

    Callers that need multi-agent attribution should read ``assigned_agent``
    (also mirrored as ``agent`` / FastGPT ``moduleName`` when name is empty).
    """
    ref = str(step.get("ref") or "").strip()
    name = str(step.get("name") or "").strip()
    agent = resolve_step_agent(step)
    st = str(step.get("status") or "").strip()
    body = str(
        step.get("result_summary")
        or step.get("output_summary")
        or step.get("result")
        or ""
    ).strip()
    err = str(step.get("error_text") or step.get("error") or "").strip()
    module_name = name or agent or (f"step-{ref}" if ref else "step")
    out: dict[str, Any] = {
        # FastGPT-shaped fields
        "moduleName": module_name,
        "moduleType": "agentStep",
        # EvoFlow explicit identity
        "ref": ref,
        "assigned_agent": agent,
        "agent": agent,
        "name": name or module_name,
        "status": st,
        "result_summary": body,
        "error_text": err,
        "subtask_id": str(step.get("subtask_id") or "").strip(),
        "progress": int(step.get("progress") or 0),
    }
    if step.get("started_at") is not None:
        out["started_at"] = step.get("started_at")
    if step.get("completed_at") is not None:
        out["completed_at"] = step.get("completed_at")
    if bool(step.get("is_rollup_step")):
        out["is_rollup_step"] = True
    return out


def build_response_data(status_doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Ordered public step rows for ``responseData`` / ``flowResponses``."""
    if not isinstance(status_doc, dict):
        return []
    return [
        publicize_step_response(step)
        for step in sorted(_step_rows(status_doc), key=_ref_sort_key)
    ]


def format_step_stream_piece(step: dict[str, Any]) -> str:
    """Format one completed/failed step as streamed assistant markdown."""
    name = str(step.get("name") or step.get("ref") or "步骤").strip() or "步骤"
    agent = resolve_step_agent(step)
    heading = f"{name} · @{agent}" if agent else name
    st = str(step.get("status") or "").strip().lower()
    body = str(
        step.get("result_summary")
        or step.get("output_summary")
        or step.get("result")
        or step.get("error_text")
        or step.get("error")
        or ""
    ).strip()
    if st in {"failed", "error"}:
        return f"## {heading} · 失败\n{body or '步骤执行失败'}"
    if st in {"cancelled", "canceled"}:
        return f"## {heading} · 已取消\n{body}".rstrip()
    if body:
        return f"## {heading}\n{body}"
    return f"## {heading}\n（已完成）"


def _ref_sort_key(step: dict[str, Any]) -> tuple[int, str]:
    ref = str(step.get("ref") or "").strip()
    try:
        return (int(ref), ref)
    except ValueError:
        return (10**9, ref or str(step.get("name") or ""))


def _step_emit_key(step: dict[str, Any]) -> str:
    return str(
        step.get("subtask_id") or step.get("ref") or step.get("name") or ""
    ).strip()


def collect_new_step_stream_events(
    status_doc: dict[str, Any] | None,
    emitted_keys: set[str],
) -> list[dict[str, Any]]:
    """Return terminal step events in ref order; mutates ``emitted_keys``.

    Each event: ``{"text": str, "step": <raw>, "response": <publicize_step_response>}``.
    Buffers parallel completions into ascending ref order (same as pieces).
    """
    if not isinstance(status_doc, dict):
        return []
    steps = sorted(_step_rows(status_doc), key=_ref_sort_key)
    if not steps:
        return []

    out: list[dict[str, Any]] = []
    for step in steps:
        key = _step_emit_key(step)
        if not key:
            continue
        if key in emitted_keys:
            continue
        st = str(step.get("status") or "").strip().lower()
        if st not in _STEP_DONE:
            # Stop — later terminal siblings wait until this ref finishes
            break
        piece = format_step_stream_piece(step)
        if piece:
            emitted_keys.add(key)
            out.append(
                {
                    "text": piece,
                    "step": step,
                    "response": publicize_step_response(step),
                }
            )
    return out


def collect_new_step_stream_pieces(
    status_doc: dict[str, Any] | None,
    emitted_keys: set[str],
) -> list[str]:
    """Return terminal step markdown pieces in ref order; mutates ``emitted_keys``."""
    return [str(ev.get("text") or "") for ev in collect_new_step_stream_events(status_doc, emitted_keys)]


def progress_fingerprint(status_doc: dict[str, Any] | None) -> str:
    """Stable fingerprint for stream progress de-dupe."""
    if not isinstance(status_doc, dict):
        return ""
    import json

    sub = status_doc.get("subtask_status") if isinstance(status_doc.get("subtask_status"), dict) else {}
    payload = {
        "status": str(status_doc.get("status") or ""),
        "progress": int(status_doc.get("progress") or 0),
        "sub": {str(k): str(v) for k, v in sorted(sub.items(), key=lambda kv: str(kv[0]))},
    }
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def last_successful_step_text(status_doc: dict[str, Any] | None) -> str:
    """Body text of the last successful step (by ref order)."""
    if not isinstance(status_doc, dict):
        return ""
    success = {"completed", "done", "success"}
    last = ""
    for step in sorted(_step_rows(status_doc), key=_ref_sort_key):
        st = str(step.get("status") or "").strip().lower()
        if st not in success:
            continue
        body = str(
            step.get("result_summary")
            or step.get("output_summary")
            or step.get("result")
            or ""
        ).strip()
        if body:
            last = body
    return last


def step_text_by_ref(status_doc: dict[str, Any] | None, ref: str) -> str:
    """Result (or error) text for a specific step ref."""
    want = str(ref or "").strip()
    if not want or not isinstance(status_doc, dict):
        return ""
    rows = _step_rows(status_doc)
    from evoflow.collab.app_step_ref_bridge import build_step_ref_alias_map, resolve_step_ref

    alias_map = build_step_ref_alias_map([], rows)
    canonical = resolve_step_ref(want, alias_map)
    success = {"completed", "done", "success"}
    for step in rows:
        if str(step.get("ref") or "").strip() != canonical:
            continue
        st = str(step.get("status") or "").strip().lower()
        body = str(
            step.get("result_summary")
            or step.get("output_summary")
            or step.get("result")
            or ""
        ).strip()
        if body:
            return body
        if st in {"failed", "error"}:
            err = str(step.get("error_text") or step.get("error") or "").strip()
            if err:
                return err
    return ""


def summarize_run_content(status_doc: dict[str, Any] | None) -> str:
    """Final OpenAPI answer: answer node ref → run summary → last successful step."""
    if not isinstance(status_doc, dict):
        return ""
    answer_ref = str(status_doc.get("answer_from_ref") or "").strip()
    if answer_ref:
        pinned = step_text_by_ref(status_doc, answer_ref)
        if pinned:
            return pinned
    for key in ("result_summary", "summary", "output", "message"):
        text = str(status_doc.get(key) or "").strip()
        if text:
            return text
    last = last_successful_step_text(status_doc)
    if last:
        return last
    err = str(status_doc.get("error") or status_doc.get("error_message") or "").strip()
    if err:
        return err
    # Failed last step text if present
    for step in reversed(sorted(_step_rows(status_doc), key=_ref_sort_key)):
        st = str(step.get("status") or "").strip().lower()
        if st in {"failed", "error"}:
            body = str(step.get("error_text") or step.get("result_summary") or "").strip()
            if body:
                return body
    status = str(status_doc.get("status") or "").strip()
    return f"Run finished with status: {status}" if status else ""


def summarize_all_steps_content(status_doc: dict[str, Any] | None) -> str:
    """Concatenate all step results (for comparing against final answer)."""
    if not isinstance(status_doc, dict):
        return ""
    parts: list[str] = []
    for step in sorted(_step_rows(status_doc), key=_ref_sort_key):
        piece = format_step_stream_piece(step) if str(step.get("status") or "").lower() in _STEP_DONE else ""
        if piece:
            parts.append(piece)
    return "\n\n".join(parts)


def should_append_final_answer_delta(
    answer: str,
    *,
    streamed_parts: list[str],
    status_doc: dict[str, Any] | None,
) -> bool:
    """Avoid repeating the same final answer after step-level stream pieces."""
    ans = (answer or "").strip()
    if not ans:
        return False
    if not streamed_parts:
        return True
    joined = "\n\n".join(streamed_parts).strip()
    if ans == joined or ans in joined:
        return False
    last_step = last_successful_step_text(status_doc).strip()
    if last_step and ans == last_step:
        return False
    steps_blob = summarize_all_steps_content(status_doc).strip()
    if steps_blob and (ans == steps_blob or ans in steps_blob):
        return False
    return True


def sample_parameter_value(param: dict[str, Any]) -> str:
    """Pick a paste-ready sample for OpenAPI ``variables`` (never ``<name>`` placeholders)."""
    if not isinstance(param, dict):
        return ""
    default = param.get("default")
    if default is not None and str(default).strip() != "":
        return str(default)
    opts = param.get("options") if isinstance(param.get("options"), list) else None
    if opts:
        for opt in opts:
            text = str(opt or "").strip()
            if text:
                return text
    ptype = str(param.get("type") or "text").strip().lower()
    name = str(param.get("name") or "").strip()
    label = str(param.get("label") or name or "示例").strip()
    if ptype == "number":
        return "1"
    if ptype == "textarea":
        return f"示例内容：{label}"
    if name.lower() in {"query", "input", "prompt"}:
        return f"请执行本工作流（{label}）"
    return f"示例{label}"


def build_example_variables(app: dict[str, Any] | None) -> dict[str, str]:
    """Build a complete ``variables`` object that satisfies required params."""
    if not isinstance(app, dict):
        return {}
    rows = app.get("parameters") if isinstance(app.get("parameters"), list) else []
    out: dict[str, str] = {}
    for p in rows:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        out[name] = sample_parameter_value(p)
    return out


def build_example_user_message(app: dict[str, Any] | None, variables: dict[str, str] | None = None) -> str:
    """Human-readable last user message for the callable example."""
    vars_map = variables if isinstance(variables, dict) else {}
    for alias in _MESSAGE_PARAM_ALIASES:
        text = str(vars_map.get(alias) or "").strip()
        if text:
            return text
    if isinstance(app, dict):
        goal = str(app.get("goal_template") or app.get("description") or "").strip()
        name = str(app.get("name") or "").strip()
        if goal:
            # Keep short; do not expand {{vars}} here — variables carry values.
            clipped = goal.replace("\n", " ").strip()
            if len(clipped) > 120:
                clipped = clipped[:117] + "…"
            return f"请按 variables 执行「{name or '工作流'}」：{clipped}"
        if name:
            return f"请按 variables 执行工作流「{name}」"
    return "请按 variables 执行本工作流"


def build_example_chat_request(
    app_id: str,
    app: dict[str, Any] | None,
    *,
    detail: bool = True,
    stream: bool = False,
    async_mode: bool = False,
) -> dict[str, Any]:
    """Paste-ready ``POST /v1/chat/completions`` body for this published app."""
    variables = build_example_variables(app)
    body: dict[str, Any] = {
        "model": str(app_id or "").strip(),
        "stream": bool(stream),
        "detail": bool(detail),
        "messages": [
            {
                "role": "user",
                "content": build_example_user_message(app, variables),
            }
        ],
        "variables": variables,
    }
    if async_mode:
        body["async"] = True
        body["stream"] = False
    return body


def _app_step_rows(app: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(app, dict):
        return []
    rows = app.get("steps") if isinstance(app.get("steps"), list) else []
    return [r for r in rows if isinstance(r, dict)]


def build_example_response_data(app: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Synthetic ``responseData`` rows from the app's step graph (for docs / models)."""
    out: list[dict[str, Any]] = []
    for idx, step in enumerate(_app_step_rows(app)):
        ref = str(step.get("ref") or idx + 1).strip() or str(idx + 1)
        name = str(step.get("name") or "").strip() or f"步骤{ref}"
        agent = str(
            step.get("assigned_agent")
            or step.get("assigned_to")
            or step.get("agent_id")
            or ""
        ).strip()
        out.append(
            {
                "moduleName": name,
                "moduleType": "agentStep",
                "ref": ref,
                "assigned_agent": agent,
                "agent": agent,
                "name": name,
                "status": "completed",
                "result_summary": f"（示例）{name} 的输出摘要",
                "error_text": "",
                "subtask_id": f"Sub_example_{ref}",
                "progress": 100,
            }
        )
    return out


def build_example_answer_text(app: dict[str, Any] | None, rows: list[dict[str, Any]]) -> str:
    """Sample ``choices[0].message.content`` respecting ``answer_from_ref``."""
    answer_ref = ""
    if isinstance(app, dict):
        answer_ref = str(app.get("answer_from_ref") or "").strip()
        plan = app.get("plan") if isinstance(app.get("plan"), dict) else {}
        if not answer_ref:
            answer_ref = str(plan.get("answer_from_ref") or "").strip()
    if answer_ref:
        for row in rows:
            if str(row.get("ref") or "").strip() == answer_ref:
                return str(row.get("result_summary") or "").strip() or f"（示例）步骤 {answer_ref} 答案"
    if rows:
        return str(rows[-1].get("result_summary") or "").strip() or "（示例）工作流最终答案"
    name = str((app or {}).get("name") or "工作流").strip()
    return f"（示例）{name} 已完成"


def build_response_contract() -> dict[str, Any]:
    """Stable field map for external integrators (not OpenAI-complete)."""
    return {
        "shell": "OpenAI-shaped chat.completion; usage is always 0; not full OpenAI semantics",
        "detail_false": {
            "read": "choices[0].message.content",
            "meaning": "对外答案单字符串（answer_from_ref → result_summary → 末步）",
        },
        "detail_true": {
            "read_answer": "choices[0].message.content",
            "read_steps": "responseData[] 或 evoflow.flowResponses[]",
            "step_fields": {
                "ref": "步骤编号",
                "assigned_agent": "执行该步的 Agent 标识（多 Agent 必看）",
                "agent": "同 assigned_agent",
                "moduleName": "步骤显示名（FastGPT 对齐）",
                "moduleType": "固定 agentStep",
                "status": "completed | failed | cancelled | …",
                "result_summary": "该步输出摘要",
                "error_text": "失败信息（若有）",
            },
            "run_id": "evoflow.run_id → GET /v1/runs/{run_id}?detail=true",
        },
        "async_true": {
            "object": "chat.completion.async",
            "poll": "evoflow.status_url 或 GET /v1/runs/{evoflow.run_id}?detail=true",
            "terminal": "同 detail 同步 chat.completion",
        },
    }


def build_example_chat_response(
    app_id: str,
    app: dict[str, Any] | None,
    *,
    detail: bool = True,
) -> dict[str, Any]:
    """Paste-ready sample success response for this app (with per-step agents when detail)."""
    rows = build_example_response_data(app)
    content = build_example_answer_text(app, rows)
    version = None
    if isinstance(app, dict) and app.get("version") is not None:
        try:
            version = int(app.get("version"))
        except (TypeError, ValueError):
            version = app.get("version")
    evoflow: dict[str, Any] = {
        "run_id": "Run_example",
        "app_id": str(app_id or "").strip(),
    }
    if version is not None:
        evoflow["app_version"] = version
    resp: dict[str, Any] = {
        "id": "chatcmpl-example",
        "object": "chat.completion",
        "created": 0,
        "model": str(app_id or "").strip(),
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
        "evoflow": evoflow,
    }
    if detail:
        resp["responseData"] = rows
        evoflow["flowResponses"] = rows
        evoflow["steps"] = rows
    return resp


def attach_detail_response_data(
    resp: dict[str, Any],
    status_doc: dict[str, Any] | None,
    *,
    detail: bool,
) -> dict[str, Any]:
    """When ``detail``, attach FastGPT-style per-node rows (with agent ids)."""
    if not detail or not isinstance(resp, dict):
        return resp
    rows = build_response_data(status_doc)
    # FastGPT sync field
    resp["responseData"] = rows
    evo = resp.setdefault("evoflow", {})
    if isinstance(evo, dict):
        evo["flowResponses"] = rows
        evo["steps"] = rows
    return resp


def build_chat_completion_response(
    *,
    app_id: str,
    content: str,
    run_id: str | None = None,
    finish_reason: str = "stop",
    app_version: int | None = None,
    status_doc: dict[str, Any] | None = None,
    detail: bool = False,
) -> dict[str, Any]:
    """Assemble an OpenAI-shaped ``chat.completion`` (compat shell, not full OpenAI).

    With ``detail=True``, also returns ``responseData`` / ``evoflow.flowResponses``
    so multi-agent step outputs keep ``assigned_agent`` / ``ref`` identity.
    """
    import time as _time
    import uuid

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    evoflow: dict[str, Any] = {
        "run_id": run_id,
        "app_id": app_id,
    }
    if app_version is not None:
        evoflow["app_version"] = app_version
    resp: dict[str, Any] = {
        "id": completion_id,
        "object": "chat.completion",
        "created": int(_time.time()),
        "model": app_id,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content or ""},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
        "evoflow": evoflow,
    }
    return attach_detail_response_data(resp, status_doc, detail=detail)
