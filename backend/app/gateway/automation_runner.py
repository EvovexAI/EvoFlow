"""Background scheduler for EvoPanel-style automations under ``~/.evoflow/tasks/automations``.

Default execution paths:

1. **Bound published workflow** (``app_id``): ``app_runner.run_app`` → render plan → subtask DAG (no Lead planning)
2. **Prompt-only** (default): direct LangGraph ``runs.wait`` — full agent tools, no Task Center plan worker / plan_guard
3. **Prompt + opt-in** (``execution_mode=task_center`` or ``EVOFLOW_AUTOMATION_VIA_TASK=1``): Task Center unattended → plan → dispatch

Runs by default on the Gateway process. Set ``EVOFLOW_AUTOMATION_SCHEDULER=0`` (or
``false`` / ``no`` / ``off`` / ``disabled``) to turn it off.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import time
import tomllib
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 60
# Legacy TOML directory (optional one-time import when SQLite table is empty).
AUTOMATIONS_DIR = Path(os.getenv("EVOFLOW_AUTOMATIONS_DIR", "")).expanduser() if os.getenv("EVOFLOW_AUTOMATIONS_DIR") else Path.home() / ".evoflow" / "tasks" / "automations"

_automations_toml_import_done = False

_last_slot: dict[str, str] = {}
# Populated every tick for ``GET /api/automation/scheduler/status`` and logs.
_last_tick_info: dict[str, Any] = {}
# Avoid spamming gateway.log every tick for the same broken ``*.toml``.
_warned_invalid_toml_paths: set[str] = set()
_scheduler_loop_running: bool = False
_langgraph_semaphore: asyncio.Semaphore | None = None


def _langgraph_run_semaphore() -> asyncio.Semaphore:
    global _langgraph_semaphore
    if _langgraph_semaphore is None:
        n = max(1, int(os.getenv("EVOFLOW_AUTOMATION_LANGGRAPH_MAX_CONCURRENT", "2")))
        _langgraph_semaphore = asyncio.Semaphore(n)
    return _langgraph_semaphore


def _task_wants_langgraph_run(_task: dict[str, Any]) -> bool:
    """Automation always runs LangGraph (``runs.wait``); TOML ``langgraph_run`` is ignored."""
    return True


# Prepended to every automation LangGraph user message (cron / manual run). No interactive channel.
_AUTOMATION_LANGGRAPH_OUTER_RULES = """\
【自动化模式 · 必须遵守】
当前由定时或手动触发，无真人用户在会话里等待；请按下列方式执行：

1) 不要使用、不要调用会「向用户提问 / 等待用户确认 / 等待用户输入」的工具或流程；无法自行决定时请根据任务目标做合理假设并继续，在最终回复里简要说明假设即可。
2) 在同一轮执行中尽量一次性完成下方「具体任务」的全部要求，避免中途停下、把未完成状态当作结束。
3) 只有在已产出明确、可用的结果（例如完整报告、结论列表、操作摘要等）时再结束；若信息不足，仍须给出当前最佳结论并标注不确定性，而不是留空或仅说「需要更多信息」后停止。
4) 若任务包含多步（检索、整理、输出），请连贯做完再收尾。
5) **工具轮次**：整轮执行中工具调用（含 web_search、read、execute 等）宜控制在约 15 次以内；信息已够写结论时**必须立刻收尾**，禁止为「更完美」反复搜索或读文件。
6) **交付文件**：若下方指定了交付路径，必须写入该文件并在结案 outputs 中登记；禁止在未写入前标记 completed。

—— 以下为本次「具体任务」（用户配置的正文）——
"""


def _resolve_automation_deliverable(
    automation_id: str,
    task: dict[str, Any],
    *,
    run_id: str,
) -> tuple[str, str]:
    """Return ``(absolute_path, relative_outputs_path)`` for one automation run."""
    from evoflow.automation.output_paths import (
        automation_deliverable_rel_path,
        resolve_automation_deliverable_path,
    )

    abs_path = resolve_automation_deliverable_path(
        automation_id,
        automation_name=str(task.get("name") or ""),
        run_id=run_id,
        output_template=str(task.get("output_path") or task.get("output") or "").strip() or None,
    )
    rel_path = automation_deliverable_rel_path(abs_path)
    return str(abs_path), rel_path


def _automation_deliverable_block_for_prompt(
    automation_id: str,
    task: dict[str, Any],
    *,
    run_id: str,
) -> str:
    from evoflow.automation.output_paths import automation_output_instructions

    try:
        abs_out, rel_out = _resolve_automation_deliverable(automation_id, task, run_id=run_id)
        return automation_output_instructions(abs_out, rel_path=rel_out)
    except Exception:
        logger.debug(
            "automation_runner: deliverable block skipped automation_id=%s",
            automation_id,
            exc_info=True,
        )
        return ""


def _automation_user_message_for_langgraph(user_prompt: str, *, deliverable_block: str = "") -> str:
    """Wrap TOML ``prompt`` with non-interactive, run-to-completion instructions."""
    body = (user_prompt or "").strip()
    extra = (deliverable_block or "").strip()
    if extra:
        return _AUTOMATION_LANGGRAPH_OUTER_RULES + extra + "\n\n" + body
    return _AUTOMATION_LANGGRAPH_OUTER_RULES + body


def _truncate_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def _messages_from_run_result(result: dict | list | None) -> list[dict[str, Any]]:
    """Extract LangGraph ``messages`` from a ``runs.wait`` final state payload."""
    if isinstance(result, list):
        raw = result
    elif isinstance(result, dict):
        raw = result.get("messages", [])
    else:
        return []
    if not isinstance(raw, list):
        return []
    return [m for m in raw if isinstance(m, dict)]


def _automation_open_chat_link(thread_id: str) -> str:
    tpl = (os.getenv("EVOFLOW_AUTOMATION_CHAT_LINK_TEMPLATE") or "").strip()
    if not tpl or not thread_id:
        return ""
    return tpl.replace("{thread_id}", thread_id)


_AUTOMATION_RECURSION_DEFAULT = 1500
_AUTOMATION_RECURSION_MIN = 200
_AUTOMATION_RECURSION_MAX = 3000


def _resolve_automation_recursion_limit(task: dict[str, Any], *, plan_mode: bool) -> int:
    """LangGraph super-step cap for cron runs (tool + middleware loops count as steps)."""
    raw_task = task.get("langgraph_recursion_limit")
    if raw_task is not None:
        try:
            n = int(raw_task)
            if n >= _AUTOMATION_RECURSION_MIN:
                return min(n, _AUTOMATION_RECURSION_MAX)
        except (TypeError, ValueError):
            pass

    base = _AUTOMATION_RECURSION_DEFAULT
    env_raw = (os.getenv("EVOFLOW_AUTOMATION_LANGGRAPH_RECURSION_LIMIT") or "").strip()
    if env_raw:
        try:
            env_n = int(env_raw)
            if env_n >= _AUTOMATION_RECURSION_MIN:
                base = env_n
        except ValueError:
            pass
    else:
        try:
            from evoflow.config import get_app_config

            cfg = get_app_config()
            channels = getattr(cfg, "channels", None)
            if channels is None and hasattr(cfg, "model_dump"):
                channels = (cfg.model_dump() or {}).get("channels")
            if isinstance(channels, dict):
                sess = channels.get("session") or {}
                run_cfg = sess.get("config") if isinstance(sess, dict) else {}
                if isinstance(run_cfg, dict) and run_cfg.get("recursion_limit") is not None:
                    panel_lim = int(run_cfg["recursion_limit"])
                    base = max(panel_lim * 2, _AUTOMATION_RECURSION_DEFAULT)
        except Exception:
            logger.debug("automation_runner: read channels.session.config recursion_limit failed", exc_info=True)

    if plan_mode:
        base = min(_AUTOMATION_RECURSION_MAX, int(base * 1.75))

    return max(_AUTOMATION_RECURSION_MIN, min(base, _AUTOMATION_RECURSION_MAX))


def _format_automation_run_error(exc: BaseException, *, recursion_limit: int) -> str:
    err = str(exc).strip() or type(exc).__name__
    name = type(exc).__name__
    if name == "GraphRecursionError" or "Recursion limit of" in err:
        return (
            f"LangGraph 步数上限已用尽（recursion_limit={recursion_limit}）。"
            " 自动化工具轮次或上下文压缩/规划门禁占用步数较多；"
            " 可在任务 TOML 增加 langgraph_recursion_limit，"
            " 或设置环境变量 EVOFLOW_AUTOMATION_LANGGRAPH_RECURSION_LIMIT（当前默认 1500，上限 3000）。"
            f" 详情: {err[:400]}"
        )
    return err


async def _invoke_langgraph_for_automation(
    task_id: str,
    task: dict[str, Any],
    prompt: str,
    *,
    session_key: str | None = None,
    chat_prepare: dict[str, Any] | None = None,
    run_id: str = "",
) -> dict[str, Any]:
    """Run Lead Agent once via ``runs.wait``; returns ``ok``, ``text``, ``thread_id``, ``messages``, ``error``."""
    from langgraph_sdk import get_client

    from app.channels.manager import (
        DEFAULT_RUN_CONFIG,
        _extract_response_text,
    )

    langgraph_url = (os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph") or "").rstrip("/") or "http://127.0.0.1:8070/api/langgraph"
    from evoflow.runtime.long_run_limits import LONG_RUN_WALL_SECONDS

    default_timeout = max(30, int(os.getenv("EVOFLOW_AUTOMATION_LANGGRAPH_TIMEOUT", str(LONG_RUN_WALL_SECONDS))))
    try:
        timeout_s = int(task.get("langgraph_timeout_seconds") or default_timeout)
    except (TypeError, ValueError):
        timeout_s = default_timeout
    timeout_s = max(15, min(timeout_s, LONG_RUN_WALL_SECONDS))

    mode = str(task.get("langgraph_thread_mode") or "fresh").strip().lower()
    if mode not in ("fresh", "sticky"):
        mode = "fresh"
    if mode == "sticky":
        logger.warning(
            "automation_runner: langgraph_thread_mode=sticky task_id=%s — history accumulates across runs; prefer fresh for cron unless you need continuity (raises tool rounds / recursion risk)",
            task_id,
        )

    resolved_agent_code = str(task.get("agent_code") or "").strip().lower() or "lead_agent"
    assistant_id = resolved_agent_code
    run_context: dict[str, Any] = {
        "session_mode": "agent",
        "thinking_enabled": False,
        "reasoning_effort": "minimum",
        "is_plan_mode": False,
        "subagent_enabled": False,
        "thread_id": "(pending)",
        "triggered_by": "automation_scheduler",
        "automation_task_id": task_id,
        "agent_name": resolved_agent_code if resolved_agent_code != "lead_agent" else "main",
    }
    if sk_meta := str(session_key or "").strip():
        run_context["session_key"] = sk_meta
    try:
        from evoflow.authz.runtime_identity import (
            enrich_run_context_identity,
            resolve_identity_from_automation,
        )

        identity = resolve_identity_from_automation(task_id)
        for k, v in identity.items():
            if v:
                run_context[k] = v
        run_context = enrich_run_context_identity(run_context)
    except Exception:
        logger.debug("automation_runner: identity inject failed task_id=%s", task_id, exc_info=True)
    requested_model_name = str(task.get("model_name") or "").strip()
    if requested_model_name:
        run_context["requested_model_name"] = requested_model_name

    # 规划模式会走 plan_guard / 多轮门禁，LangGraph 超步远大于「工具调用次数」；定时默认关闭，可用 EVOFLOW_AUTOMATION_PLAN_MODE=1 打开
    automation_plan_mode = os.getenv("EVOFLOW_AUTOMATION_PLAN_MODE", "").strip().lower() in ("1", "true", "yes", "on")
    auto_recursion = _resolve_automation_recursion_limit(task, plan_mode=automation_plan_mode)

    client = get_client(url=langgraph_url)
    thread_id = str(task.get("langgraph_thread_id") or "").strip() or None
    if mode == "fresh":
        thread_id = None

    if mode == "sticky" and thread_id:
        try:
            await client.threads.get(thread_id)
        except Exception:
            logger.warning(
                "automation_runner: sticky langgraph_thread_id invalid, creating new thread (task_id=%s old=%s)",
                task_id,
                thread_id,
            )
            thread_id = None

    sk_meta = str(session_key or "").strip()
    if not thread_id:
        meta: dict[str, Any] = {
            "source": "evoflow_automation",
            "automation_task_id": task_id,
            "automation_name": str(task.get("name") or ""),
            "langgraph_thread_mode": mode,
        }
        if sk_meta:
            meta["session_key"] = sk_meta
        try:
            thread = await client.threads.create(metadata=meta)
        except Exception as e:
            err_msg = str(e)
            resp = getattr(e, "response", None)
            body = getattr(e, "body", None)
            if body is not None:
                err_msg = f"status={resp.status_code} body={body!r}"
            elif resp is not None:
                err_msg = f"status={resp.status_code} msg={e!s}"
            logger.error(
                "automation_runner: thread create failed. task_id=%s mode=%s error=%s",
                task_id,
                mode,
                err_msg,
            )
            # Retry once with empty metadata (some LangGraph versions reject metadata on create)
            try:
                logger.info("automation_runner: retrying thread create without metadata task_id=%s", task_id)
                thread = await client.threads.create()
            except Exception:
                logger.exception("automation_runner: thread create retry also failed task_id=%s", task_id)
                raise
            logger.info(
                "automation_runner: thread create retry succeeded task_id=%s thread_id=%s",
                task_id,
                str(thread.get("thread_id", "")),
            )
        thread_id = str(thread["thread_id"])

    run_context["thread_id"] = thread_id
    run_context["is_plan_mode"] = automation_plan_mode
    # 自动化默认不写 TOML 键时视为关闭记忆（与 EvoPanel 新建默认一致）
    run_context["memory_enabled"] = bool(task.get("memory_enabled"))
    ws_root = str(task.get("workspace") or "").strip()
    if ws_root:
        run_context["local_workspace_root"] = ws_root

    if chat_prepare and sk_meta:
        from app.gateway.automation_chat_session import prepare_automation_chat_session

        prep = dict(chat_prepare)
        prep.setdefault("thread_id", thread_id)
        prep.setdefault("session_key", sk_meta)
        await asyncio.to_thread(prepare_automation_chat_session, **prep)

    try:
        from evoflow.agents.automation_runtime import bootstrap_unattended_automation_scenarios

        await asyncio.to_thread(
            bootstrap_unattended_automation_scenarios,
            thread_id=thread_id,
            session_key=sk_meta or None,
            scenarios=["agent"] if not automation_plan_mode else ["plan"],
        )
    except Exception:
        logger.debug("automation_runner: scenario bootstrap failed task_id=%s", task_id, exc_info=True)

    # Agent Server forbids sending both ``config.configurable`` and ``context`` on the same run;
    # use ``context`` only for user/session fields (see ``_langgraph_merge_configurable_into_context``).
    run_config = {k: v for k, v in {**DEFAULT_RUN_CONFIG, "recursion_limit": auto_recursion}.items() if k != "configurable"}

    user_message = _automation_user_message_for_langgraph(
        prompt,
        deliverable_block=_automation_deliverable_block_for_prompt(task_id, task, run_id=run_id),
    )

    logger.info(
        "automation_runner: langgraph runs.wait begin task_id=%s thread_id=%s mode=%s timeout_s=%s recursion_limit=%s is_plan_mode=%s",
        task_id,
        thread_id,
        mode,
        timeout_s,
        auto_recursion,
        automation_plan_mode,
    )
    try:
        result = await asyncio.wait_for(
            client.runs.wait(
                thread_id,
                assistant_id,
                input={"messages": [{"role": "human", "content": user_message}]},
                config=run_config,
                context=run_context,
            ),
            timeout=timeout_s,
        )
    except TimeoutError:
        err = f"langgraph runs.wait timed out after {timeout_s}s"
        logger.warning("automation_runner: %s task_id=%s thread_id=%s", err, task_id, thread_id)
        return {
            "ok": False,
            "text": "",
            "thread_id": thread_id or "",
            "messages": [],
            "error": err,
        }
    except Exception as e:
        err = _format_automation_run_error(e, recursion_limit=auto_recursion)
        resp = getattr(e, "response", None)
        if resp is not None:
            try:
                body = (getattr(resp, "text", None) or "").strip()
                if body:
                    err = f"{err} body={body[:4000]!r}"
            except Exception:
                pass
        logger.warning("automation_runner: langgraph runs.wait failed task_id=%s: %s", task_id, err)
        return {
            "ok": False,
            "text": "",
            "thread_id": thread_id or "",
            "messages": [],
            "error": err,
        }

    run_messages = _messages_from_run_result(result if isinstance(result, (dict, list)) else None)
    text = _extract_response_text(result) if isinstance(result, (dict, list)) else ""
    if not (text or "").strip():
        text = "(模型未返回可读文本；可在 EvoPanel 打开 thread 查看状态)"

    logger.info(
        "automation_runner: langgraph runs.wait done task_id=%s thread_id=%s chars=%d",
        task_id,
        thread_id,
        len(text),
    )
    return {
        "ok": True,
        "text": text,
        "thread_id": thread_id,
        "messages": run_messages,
        "error": "",
    }


def _maybe_import_legacy_toml_automations() -> None:
    global _automations_toml_import_done
    if _automations_toml_import_done:
        return
    _automations_toml_import_done = True
    from evoflow.persistence import automation_repositories as auto_repo
    from evoflow.persistence.db import get_db

    get_db()
    if auto_repo.automation_count() > 0:
        return
    if not AUTOMATIONS_DIR.is_dir():
        return
    n = 0
    for p in sorted(AUTOMATIONS_DIR.glob("*.toml")):
        if "_history" in p.name:
            continue
        try:
            data = tomllib.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, dict):
            auto_repo.save_automation(p.stem, data)
            n += 1
    if n:
        logger.info("Imported %d legacy automation TOML files into SQLite", n)


def get_automation_scheduler_status() -> dict[str, Any]:
    """Snapshot for HTTP / debugging (safe to expose: no secrets)."""
    from evoflow.persistence.db import resolve_evolflow_db_path

    return {
        "backend_env_enabled": automation_scheduler_enabled(),
        "backend_loop_running": _scheduler_loop_running,
        "storage_backend": "sqlite",
        "sqlite_path": str(resolve_evolflow_db_path()),
        "hint": ("Automations are stored in evoflow.db (evoflow_automations). Gateway scheduler runs on a background loop by default; set EVOFLOW_AUTOMATION_SCHEDULER=0 to disable."),
        "last_tick": dict(_last_tick_info) if _last_tick_info else None,
    }


def _cron_field_matches(value: int, field: str) -> bool:
    from evoflow.admin.automation_schedule import cron_field_matches

    return cron_field_matches(value, field)


def _cron_field_matches_dow(js_dow: int, field: str) -> bool:
    from evoflow.admin.automation_schedule import cron_dow_matches

    return cron_dow_matches(js_dow, field)


def cron_matches_now(expr: str) -> bool:
    from evoflow.admin.automation_schedule import cron_matches_at

    return cron_matches_at(expr)


def _effective_cron(task: dict[str, Any]) -> str | None:
    """Resolve a 5-field cron for the runner tick.

    Prefer ``schedule`` when it is already cron; otherwise derive from RRULE
    stored in ``schedule`` or ``rrule`` (API enrich already does this for display,
    but the runner historically skipped rrule-only rows).
    """
    from evoflow.admin.automation_schedule import (
        is_five_field_cron_or_keyword,
        rrule_to_cron,
    )

    sched = str(task.get("schedule") or "").strip()
    if is_five_field_cron_or_keyword(sched):
        return sched
    rr = str(task.get("rrule") or "").strip()
    if "FREQ=" in sched.upper():
        rr = sched
    if rr and "FREQ=" in rr.upper():
        derived = rrule_to_cron(rr)
        if is_five_field_cron_or_keyword(derived):
            return derived
    return None


def _active_tasks_brief_for_log(active_pairs: list[tuple[str, dict[str, Any]]]) -> str:
    """One-line summary for gateway.log (no secrets)."""
    parts: list[str] = []
    for tid, t in active_pairs[:25]:
        name = str(t.get("name") or "")[:36]
        stype = str(t.get("schedule_type") or "cron")
        if stype == "once" and t.get("scheduled_at"):
            sched = f"once@{t.get('scheduled_at')}"
        else:
            ec = _effective_cron(t)
            sched = ec if ec else "NO_5FIELD_SCHEDULE"
        push = "feishu_on" if t.get("feishu_push_enabled") else "feishu_off"
        lg = "lg_on" if _task_wants_langgraph_run(t) else "lg_off"
        tm = str(t.get("langgraph_thread_mode") or "fresh").strip().lower()[:12]
        parts.append(f"{tid}[{name!r} {stype} {sched} {push} {lg} tm={tm}]")
    out = " | ".join(parts)
    if len(active_pairs) > 25:
        out += f" | …+{len(active_pairs) - 25} more"
    return out or "(none)"


def _load_automation_tomls() -> list[tuple[str, dict[str, Any]]]:
    _maybe_import_legacy_toml_automations()
    from evoflow.persistence import automation_repositories as auto_repo

    return auto_repo.list_automations()


def load_automation_toml(task_id: str) -> dict[str, Any] | None:
    """Load a single automation by id. Used by HTTP manual run and tests."""
    _maybe_import_legacy_toml_automations()
    from evoflow.persistence import automation_repositories as auto_repo

    return auto_repo.load_automation(task_id)


def _slot_key() -> str:
    d = datetime.now()
    return f"{d.year}-{d.month}-{d.day}_{d.hour}_{d.minute}"


def _automation_via_task_center(task: dict[str, Any] | None = None) -> bool:
    """Whether a **prompt-only** automation uses Task Center plan pipeline (opt-in).

    Default is **False** (direct LangGraph ``runs.wait``). Workflow-bound automations
    (``app_id``) never use this — they go through ``run_app_workflow`` instead.

    Opt in via task field ``execution_mode=task_center`` or env ``EVOFLOW_AUTOMATION_VIA_TASK=1``.
    """
    if task is not None:
        explicit = str(
            task.get("execution_mode") or task.get("prompt_execution_mode") or ""
        ).strip().lower().replace("-", "_")
        if explicit in ("task_center", "plan", "unattended", "task_center_plan"):
            return True
        if explicit in ("direct", "direct_langgraph", "langgraph", "execute", "runs_wait"):
            return False
    v = (os.getenv("EVOFLOW_AUTOMATION_VIA_TASK") or "0").strip().lower()
    return v in ("1", "true", "yes", "on")


def _enqueue_automation_as_unattended_task(
    automation_id: str,
    task: dict[str, Any],
    *,
    run_id: str,
    trigger_type: str,
    prompt: str,
) -> dict[str, Any]:
    """Create a Task Center main task (run_mode=unattended) so the queue drives plan → task_tool.

    Returns ``{ok, collab_task_id, error?}``.
    """
    from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
    from evoflow.collab.task_source import TASK_SOURCE_WORKFLOW, resolve_write_source
    from evoflow.timeutil import utc_now_iso_z

    name = str(task.get("name") or "").strip() or f"自动化 {automation_id}"
    desc = str(prompt or "").strip()
    if not desc:
        return {"ok": False, "collab_task_id": "", "error": "empty prompt"}

    deliverable_block = _automation_deliverable_block_for_prompt(automation_id, task, run_id=run_id)
    abs_out, rel_out = "", ""
    if deliverable_block:
        try:
            abs_out, rel_out = _resolve_automation_deliverable(automation_id, task, run_id=run_id)
        except Exception:
            abs_out, rel_out = "", ""

    plan_body = desc
    if deliverable_block:
        plan_body = f"{deliverable_block}\n\n{desc}"

    project_data, task_data = new_project_bundle_root_task(
        name[:120],
        plan_body[:8000],
        thread_id=None,
        session_model_name=str(task.get("model_name") or "").strip() or None,
    )
    collab_task_id = str(task_data.get("id") or "").strip()
    if not collab_task_id:
        return {"ok": False, "collab_task_id": "", "error": "task id missing"}

    now = utc_now_iso_z()
    src, channel = resolve_write_source("automation", default=TASK_SOURCE_WORKFLOW)
    task_data["run_mode"] = "unattended"
    task_data["status"] = "pending"
    task_data["unattended_stage"] = "queued"
    task_data["unattended_enqueued_at"] = now
    task_data["unattended_attempts"] = 0
    task_data["source"] = src
    task_data["source_channel"] = channel or "automation"
    task_data["raised_by"] = "automation"
    task_data["trigger_kind"] = str(trigger_type or "schedule").strip() or "schedule"
    task_data["automation_id"] = str(automation_id).strip()
    task_data["automation_run_id"] = str(run_id).strip()
    task_data["automation_name"] = name[:120]
    if abs_out:
        task_data["automation_output_path"] = abs_out
        task_data["automation_output_rel"] = rel_out
    # Active automations imply unattended consent — authorize now so the queue can
    # dispatch immediately after plan bind (kick only starts planning on first tick).
    task_data["execution_authorized"] = True
    task_data["authorized_at"] = now
    task_data["authorized_by"] = "automation"
    agent_code = str(task.get("agent_code") or "").strip()
    if agent_code:
        task_data["preferred_agent_code"] = agent_code
        task_data["agent_code"] = agent_code
    if bool(task.get("feishu_push_enabled")):
        task_data["automation_feishu_push"] = True
        push_ch = str(task.get("push_channel") or "").strip()
        push_tid = str(task.get("push_target_id") or "").strip()
        if push_ch:
            task_data["automation_push_channel"] = push_ch
        if push_tid:
            task_data["automation_push_target_id"] = push_tid

    # Bundle id must equal main task id (same as HTTP create_task / app_runner).
    project_data["id"] = collab_task_id
    project_data["tasks"] = [task_data]
    storage = get_project_storage()
    if not storage.save_project(project_data):
        return {"ok": False, "collab_task_id": collab_task_id, "error": "save_project failed"}

    logger.info(
        "automation_runner: enqueued Task Center job automation_id=%s collab_task_id=%s run_id=%s trigger=%s",
        automation_id,
        collab_task_id,
        run_id,
        trigger_type,
    )
    return {"ok": True, "collab_task_id": collab_task_id, "error": ""}


async def _kick_unattended_task(collab_task_id: str) -> None:
    """Best-effort first advance so planning starts without waiting for the next queue tick."""
    tid = str(collab_task_id or "").strip()
    if not tid:
        return
    try:
        from app.gateway.unattended_task_pipeline import advance_unattended_task

        result = await advance_unattended_task(tid)
        logger.info(
            "automation_runner: kicked unattended task collab_task_id=%s action=%s",
            tid,
            (result or {}).get("action") or (result or {}).get("error"),
        )
    except Exception:
        logger.warning(
            "automation_runner: kick unattended failed collab_task_id=%s (queue will pick up)",
            tid,
            exc_info=True,
        )


def _bound_app_id(task: dict[str, Any]) -> str:
    return str(task.get("app_id") or task.get("workflow_id") or "").strip()


def _coerce_app_parameters(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, val in raw.items():
        k = str(key or "").strip()
        if not k:
            continue
        out[k] = "" if val is None else str(val)
    return out


def _stamp_automation_on_collab_task(
    collab_task_id: str,
    *,
    automation_id: str,
    automation_run_id: str,
    automation_name: str = "",
) -> None:
    """Attach automation provenance onto the Task Center row created by app_runner."""
    tid = str(collab_task_id or "").strip()
    if not tid:
        return
    try:
        from evoflow.collab.storage import get_project_storage
        from evoflow.collab.task_source import TASK_SOURCE_WORKFLOW, resolve_write_source
        from evoflow.timeutil import utc_now_iso_z

        storage = get_project_storage()
        project = storage.load_project(tid)
        if not project:
            return
        tasks = list(project.get("tasks") or [])
        if not tasks or not isinstance(tasks[0], dict):
            return
        root = dict(tasks[0])
        src, channel = resolve_write_source("automation", default=TASK_SOURCE_WORKFLOW)
        root["source"] = src
        root["source_channel"] = channel or "automation"
        root["automation_id"] = str(automation_id).strip()
        root["automation_run_id"] = str(automation_run_id).strip()
        if automation_name:
            root["automation_name"] = str(automation_name).strip()[:120]
        root["updated_at"] = utc_now_iso_z()
        project["tasks"] = [root] + tasks[1:]
        project["updated_at"] = utc_now_iso_z()
        storage.save_project(project)
    except Exception:
        logger.debug(
            "automation_runner: stamp automation on collab task failed collab_task_id=%s",
            tid,
            exc_info=True,
        )


def _run_bound_app_for_automation(
    automation_id: str,
    task: dict[str, Any],
    *,
    run_id: str,
    trigger_type: str,
) -> dict[str, Any]:
    """Run published app via app_runner (creates Task Center unattended job + DAG / task_tool)."""
    from evoflow.collab.app_runner import run_app
    from evoflow.persistence import app_repositories

    app_id = _bound_app_id(task)
    if not app_id:
        return {"ok": False, "error": "missing app_id", "collab_task_id": "", "app_run_id": ""}

    app = app_repositories.load_app(app_id)
    if app is None:
        return {"ok": False, "error": f"app not found: {app_id}", "collab_task_id": "", "app_run_id": ""}
    status = str(app.get("status") or "").strip().lower()
    if status != "published":
        return {
            "ok": False,
            "error": f"app '{app_id}' is not published (status={status or 'unknown'})",
            "collab_task_id": "",
            "app_run_id": "",
        }

    params = _coerce_app_parameters(task.get("app_parameters") or task.get("parameters"))
    trigger_kind = "schedule" if str(trigger_type or "").strip().lower() == "schedule" else "manual"
    try:
        result = run_app(
            app_id,
            params,
            execution_mode="workflow",
            run_kind="scheduled",
            trigger_kind=trigger_kind,
            app=app,
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc), "collab_task_id": "", "app_run_id": ""}

    collab_task_id = str((result or {}).get("task_id") or "").strip()
    app_run_id = str((result or {}).get("run_id") or "").strip()
    if collab_task_id:
        _stamp_automation_on_collab_task(
            collab_task_id,
            automation_id=automation_id,
            automation_run_id=run_id,
            automation_name=str(task.get("name") or ""),
        )
    return {
        "ok": True,
        "error": "",
        "collab_task_id": collab_task_id,
        "app_run_id": app_run_id,
        "app_id": app_id,
        "app_name": str(app.get("name") or app_id),
        "result": result or {},
    }


async def _run_one_task(
    task_id: str,
    task: dict[str, Any],
    service: Any,
    *,
    skip_status_gate: bool = False,
    trigger_type: str = "schedule",
) -> None:
    fresh = dict(task)
    if not skip_status_gate:
        if str(fresh.get("status") or "").lower() != "active":
            return
        if fresh.get("schedule_type") == "once" and fresh.get("once_fired"):
            return

    record_started = datetime.now().isoformat()
    run_t0 = time.monotonic()
    lines: list[str] = []
    err: str | None = None
    push = bool(fresh.get("feishu_push_enabled"))
    prompt = str(fresh.get("prompt") or "").strip()
    run_id = secrets.token_hex(6)
    ai_text = ""
    thread_for_history = ""
    session_key_for_chat = ""
    collab_task_id = ""
    summary = ""
    app_id = _bound_app_id(fresh)

    logger.info(
        "automation_runner: run begin task_id=%s trigger=%s skip_status_gate=%s name=%r app_id=%r via_task=%s feishu_push=%s",
        task_id,
        trigger_type,
        skip_status_gate,
        fresh.get("name", ""),
        app_id or "",
        _automation_via_task_center(fresh),
        push,
    )

    # ── Bound published workflow → app_runner (Task Center + task_tool DAG) ──
    if app_id:
        try:
            wf = await asyncio.to_thread(
                _run_bound_app_for_automation,
                task_id,
                fresh,
                run_id=run_id,
                trigger_type=trigger_type,
            )
            if not wf.get("ok"):
                err = str(wf.get("error") or "workflow run failed")
                lines.append(f"workflow: fail ({err[:240]})")
            else:
                collab_task_id = str(wf.get("collab_task_id") or "").strip()
                app_run_id = str(wf.get("app_run_id") or "").strip()
                app_name = str(wf.get("app_name") or app_id)
                lines.append(
                    f"workflow: ok app_id={app_id} app_run_id={app_run_id} collab_task_id={collab_task_id}"
                )
                summary = f"已启动工作流「{app_name}」" + (f"（任务 ID：{collab_task_id}）" if collab_task_id else "")
                if collab_task_id:
                    from evoflow.collab.app_runner import _dispatch_result_ok, dispatch_workflow_task_now

                    wf_result = wf.get("result") if isinstance(wf.get("result"), dict) else {}
                    existing_dispatch = wf_result.get("dispatch")
                    if isinstance(existing_dispatch, dict) and _dispatch_result_ok(existing_dispatch):
                        wf_dispatch = existing_dispatch
                    else:
                        wf_dispatch = await dispatch_workflow_task_now(collab_task_id, authorized_by="api")
                    logger.info(
                        "automation_runner: workflow dispatch collab_task_id=%s ok=%s err=%s",
                        collab_task_id,
                        _dispatch_result_ok(wf_dispatch),
                        str((wf_dispatch or {}).get("error") or "")[:240],
                    )
                    if not _dispatch_result_ok(wf_dispatch):
                        await _kick_unattended_task(collab_task_id)

                if push:
                    from app.gateway.channel_result_push import push_markdown_result, resolve_push_target

                    push_target = resolve_push_target(
                        push_enabled=True,
                        push_channel=str(fresh.get("push_channel") or ""),
                        push_target_id=str(fresh.get("push_target_id") or ""),
                    )
                    if push_target:
                        channel, target_id = push_target
                        title = str(fresh.get("name") or "自动化")
                        body = (
                            f"**{title}** 已触发已发布工作流\n\n"
                            f"- 工作流：{app_name} (`{app_id}`)\n"
                            f"- 任务 ID：`{collab_task_id or '—'}`\n"
                            f"- 运行 ID：`{app_run_id or '—'}`\n"
                            f"- 触发：{trigger_type}\n"
                            f"- 时间：{record_started}\n"
                        )
                        ok, push_msg = await push_markdown_result(
                            channel=channel, target_id=target_id, title=title, markdown_body=body
                        )
                        lines.append(f"push:{channel}: {'ok (workflow started)' if ok else push_msg}")
                    else:
                        lines.append("push: skipped (no target; bind an IM session or pick a push channel)")
                else:
                    lines.append("push: disabled")
        except Exception as e:
            err = str(e)
            logger.warning("automation_runner: workflow fire failed task_id=%s: %s", task_id, err)
            lines.append(f"workflow: exception ({err[:240]})")

        duration_seconds = max(0, int(round(time.monotonic() - run_t0)))
        try:
            from evoflow.persistence import automation_repositories as auto_repo

            rec: dict[str, Any] = {
                "run_id": run_id,
                "started_at": record_started,
                "trigger_type": trigger_type,
                "status": "fail" if err else "queued",
                "output": "\n".join(lines),
                "error": err or "",
                "duration_seconds": duration_seconds,
                "execution_mode": "workflow",
                "app_id": app_id,
            }
            if summary:
                rec["summary"] = summary
            if collab_task_id:
                rec["collab_task_id"] = collab_task_id
            auto_repo.append_automation_run(task_id, rec)
        except Exception:
            logger.debug("automation_runner: append history failed", exc_info=True)

        if not err and str(fresh.get("schedule_type") or "") == "once" and fresh.get("scheduled_at"):
            try:
                fresh["once_fired"] = True
                fresh["status"] = "paused"
                _rewrite_automation_toml(task_id, fresh)
            except Exception:
                logger.warning("automation_runner: could not mark once_fired for %s", task_id, exc_info=True)

        logger.info(
            "automation_runner: run end (workflow) task_id=%s ok=%s app_id=%s collab_task_id=%s err=%r",
            task_id,
            err is None,
            app_id,
            collab_task_id,
            err or "",
        )
        return

    # ── Prompt-only: opt-in Task Center plan pipeline ──
    if _automation_via_task_center(fresh):
        try:
            if not prompt:
                err = "empty prompt"
                lines.append("task_center: skipped (empty prompt)")
            else:
                enq = await asyncio.to_thread(
                    _enqueue_automation_as_unattended_task,
                    task_id,
                    fresh,
                    run_id=run_id,
                    trigger_type=trigger_type,
                    prompt=prompt,
                )
                if not enq.get("ok"):
                    err = str(enq.get("error") or "enqueue failed")
                    lines.append(f"task_center: fail ({err[:240]})")
                else:
                    collab_task_id = str(enq.get("collab_task_id") or "").strip()
                    lines.append(f"task_center: queued collab_task_id={collab_task_id}")
                    summary = f"已入队任务中心执行（任务 ID：{collab_task_id}）"
                    await _kick_unattended_task(collab_task_id)

                    if push:
                        from app.gateway.channel_result_push import push_markdown_result, resolve_push_target

                        push_target = resolve_push_target(
                            push_enabled=True,
                            push_channel=str(fresh.get("push_channel") or ""),
                            push_target_id=str(fresh.get("push_target_id") or ""),
                        )
                        if push_target:
                            channel, target_id = push_target
                            title = str(fresh.get("name") or "自动化")
                            body = (
                                f"**{title}** 已触发并入队任务中心\n\n"
                                f"- 任务 ID：`{collab_task_id}`\n"
                                f"- 触发：{trigger_type}\n"
                                f"- 时间：{record_started}\n\n"
                                f"系统将自动规划并派发子任务（task 工具）。"
                            )
                            ok, push_msg = await push_markdown_result(
                                channel=channel, target_id=target_id, title=title, markdown_body=body
                            )
                            lines.append(f"push:{channel}: {'ok (enqueued)' if ok else push_msg}")
                        else:
                            lines.append("push: skipped (no target; bind an IM session or pick a push channel)")
                    else:
                        lines.append("push: disabled")
        except Exception as e:
            err = str(e)
            logger.warning("automation_runner: task-center enqueue failed task_id=%s: %s", task_id, err)
            lines.append(f"task_center: exception ({err[:240]})")

        duration_seconds = max(0, int(round(time.monotonic() - run_t0)))
        try:
            from evoflow.persistence import automation_repositories as auto_repo

            rec: dict[str, Any] = {
                "run_id": run_id,
                "started_at": record_started,
                "trigger_type": trigger_type,
                "status": "fail" if err else "queued",
                "output": "\n".join(lines),
                "error": err or "",
                "duration_seconds": duration_seconds,
                "execution_mode": "task_center",
            }
            if summary:
                rec["summary"] = summary
            if collab_task_id:
                rec["collab_task_id"] = collab_task_id
            auto_repo.append_automation_run(task_id, rec)
        except Exception:
            logger.debug("automation_runner: append history failed", exc_info=True)

        if not err and str(fresh.get("schedule_type") or "") == "once" and fresh.get("scheduled_at"):
            try:
                fresh["once_fired"] = True
                fresh["status"] = "paused"
                _rewrite_automation_toml(task_id, fresh)
            except Exception:
                logger.warning("automation_runner: could not mark once_fired for %s", task_id, exc_info=True)

        logger.info(
            "automation_runner: run end (task_center) task_id=%s ok=%s collab_task_id=%s err=%r",
            task_id,
            err is None,
            collab_task_id,
            err or "",
        )
        return

    # ── Default path: direct LangGraph runs.wait (no Task Center plan worker / plan_guard) ──
    await _run_one_task_direct_langgraph(
        task_id,
        fresh,
        service,
        trigger_type=trigger_type,
        record_started=record_started,
        run_t0=run_t0,
        run_id=run_id,
        prompt=prompt,
        push=push,
    )


async def _run_one_task_direct_langgraph(
    task_id: str,
    fresh: dict[str, Any],
    service: Any,
    *,
    trigger_type: str,
    record_started: str,
    run_t0: float,
    run_id: str,
    prompt: str,
    push: bool,
) -> None:
    """Prompt-only automation: one-shot LangGraph ``runs.wait`` (no Task Center planning)."""
    del service  # reserved for channel push helpers parity
    lines: list[str] = []
    err: str | None = None
    lg = _task_wants_langgraph_run(fresh)
    ai_text = ""
    thread_for_history = ""
    run_messages_for_chat: list[dict[str, Any]] = []
    session_key_for_chat = ""
    lg_mode = str(fresh.get("langgraph_thread_mode") or "fresh").strip().lower()
    automation_plan_mode = os.getenv("EVOFLOW_AUTOMATION_PLAN_MODE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if lg and prompt:
        from app.gateway.automation_chat_session import automation_session_key

        session_key_for_chat = automation_session_key(task_id, lg_mode, run_id)

    try:
        if lg:
            if not prompt:
                lines.append("langgraph: skipped (empty prompt)")
            else:
                chat_prepare = None
                if session_key_for_chat:
                    chat_prepare = {
                        "task_id": task_id,
                        "task": fresh,
                        "prompt": prompt,
                        "run_id": run_id,
                        "trigger_type": trigger_type,
                        "started_at_iso": record_started,
                        "is_plan_mode": automation_plan_mode,
                        "memory_enabled": bool(fresh.get("memory_enabled")),
                    }
                async with _langgraph_run_semaphore():
                    lg_res = await _invoke_langgraph_for_automation(
                        task_id,
                        fresh,
                        prompt,
                        session_key=session_key_for_chat or None,
                        chat_prepare=chat_prepare,
                        run_id=run_id,
                    )
                thread_for_history = str(lg_res.get("thread_id") or "")
                run_messages_for_chat = lg_res.get("messages") if isinstance(lg_res.get("messages"), list) else []
                if thread_for_history and session_key_for_chat:
                    lines.append(f"chat_session: {session_key_for_chat}")
                if lg_res.get("ok"):
                    ai_text = str(lg_res.get("text") or "")
                    lines.append(f"langgraph: ok thread={thread_for_history}")
                    mode = str(fresh.get("langgraph_thread_mode") or "fresh").strip().lower()
                    if mode == "sticky" and thread_for_history:
                        prev_tid = str(fresh.get("langgraph_thread_id") or "").strip()
                        if thread_for_history != prev_tid:
                            fresh["langgraph_thread_id"] = thread_for_history
                            try:
                                _rewrite_automation_toml(task_id, fresh)
                                lines.append("langgraph: persisted sticky thread_id to TOML")
                            except Exception:
                                logger.warning(
                                    "automation_runner: failed to persist langgraph_thread_id for %s",
                                    task_id,
                                    exc_info=True,
                                )
                else:
                    err = str(lg_res.get("error") or "langgraph failed")
                    lines.append(f"langgraph: fail ({err[:240]})")

        from app.gateway.channel_result_push import push_markdown_result, resolve_push_target

        push_target = resolve_push_target(
            push_enabled=push,
            push_channel=str(fresh.get("push_channel") or ""),
            push_target_id=str(fresh.get("push_target_id") or ""),
        )
        if push_target:
            channel, target_id = push_target
            title = str(fresh.get("name") or "自动化")
            if lg and prompt:
                if ai_text:
                    link = _automation_open_chat_link(thread_for_history)
                    footer = f"\n\n---\n**LangGraph thread**: `{thread_for_history}`"
                    if link:
                        footer += f"\n[打开会话]({link})"
                    body = _truncate_text(ai_text, 7800) + footer
                    ok, push_msg = await push_markdown_result(
                        channel=channel, target_id=target_id, title=title, markdown_body=body
                    )
                    lines.append(f"push:{channel}: {'ok (model reply)' if ok else push_msg}")
                elif err:
                    snippet = prompt[:500] + ("…" if len(prompt) > 500 else "")
                    md = f"**{title}**（定时 AI 执行失败）\n\n**错误**: {err}\n\n**Prompt 摘要**: {snippet}\n\n_时间_: {record_started}"
                    ok, push_msg = await push_markdown_result(
                        channel=channel, target_id=target_id, title=title, markdown_body=md
                    )
                    lines.append(f"push:{channel}: {'ok (failure notice)' if ok else push_msg}")
                else:
                    snippet = prompt[:500] + ("…" if len(prompt) > 500 else "")
                    md = f"计划任务已触发（未跑 LangGraph）。\n\n**Prompt 摘要**: {snippet}\n\n_时间_: {record_started}"
                    ok, push_msg = await push_markdown_result(
                        channel=channel, target_id=target_id, title=title, markdown_body=md
                    )
                    lines.append(f"push:{channel}: {'ok (notify only)' if ok else push_msg}")
            else:
                snippet = prompt[:500] + ("…" if len(prompt) > 500 else "") if prompt else ""
                md = (
                    f"计划任务已触发。\n\n**Prompt 摘要**: {snippet}\n\n_时间_: {record_started}"
                    if snippet
                    else f"计划任务已触发。\n\n_时间_: {record_started}"
                )
                ok, push_msg = await push_markdown_result(
                    channel=channel, target_id=target_id, title=title, markdown_body=md
                )
                lines.append(f"push:{channel}: {'ok' if ok else push_msg}")
        elif push:
            lines.append("push: skipped (no target; bind an IM session or pick a push channel)")
        else:
            lines.append("push: disabled")
    except Exception as e:
        err = str(e)
        logger.warning("automation_runner: task %s failed: %s", task_id, err)
    finally:
        if thread_for_history and session_key_for_chat:
            from app.gateway.automation_chat_session import finalize_automation_chat_session

            try:
                fin = await finalize_automation_chat_session(
                    thread_id=thread_for_history,
                    session_key=session_key_for_chat,
                    run_messages=run_messages_for_chat or None,
                )
                appended = int(fin.get("appended") or 0)
                if appended:
                    lines.append(f"chat_transcript: appended={appended}")
            except Exception:
                logger.warning(
                    "automation_runner: chat transcript finalize failed task_id=%s session=%s",
                    task_id,
                    session_key_for_chat,
                    exc_info=True,
                )

    logger.info(
        "automation_runner: run end task_id=%s ok=%s lines=%r err=%r history=%s",
        task_id,
        err is None,
        lines,
        err or "",
        "sqlite:evoflow_automation_runs",
    )

    try:
        from evoflow.persistence import automation_repositories as auto_repo

        duration_seconds = max(0, int(round(time.monotonic() - run_t0)))
        summary = _truncate_text(str(ai_text or "").strip(), 500)
        rec: dict[str, Any] = {
            "run_id": run_id,
            "started_at": record_started,
            "trigger_type": trigger_type,
            "status": "fail" if err else "success",
            "output": "\n".join(lines),
            "error": err or "",
            "duration_seconds": duration_seconds,
            "langgraph_thread_id": thread_for_history or None,
            "langgraph_run": lg,
            "execution_mode": "direct_langgraph",
        }
        if summary:
            rec["summary"] = summary
        if session_key_for_chat:
            rec["session_key"] = session_key_for_chat
        auto_repo.append_automation_run(task_id, rec)
    except Exception:
        logger.debug("automation_runner: append history failed", exc_info=True)

    if str(fresh.get("schedule_type") or "") == "once" and fresh.get("scheduled_at"):
        try:
            fresh["once_fired"] = True
            fresh["status"] = "paused"
            _rewrite_automation_toml(task_id, fresh)
        except Exception:
            logger.warning("automation_runner: could not mark once_fired for %s", task_id, exc_info=True)


def _rewrite_automation_toml(task_id: str, data: dict[str, Any]) -> None:
    """Persist automation document to SQLite."""
    from evoflow.persistence import automation_repositories as auto_repo

    payload = dict(data)
    payload.pop("feishu_chat_id", None)
    payload.setdefault("langgraph_run", True)
    auto_repo.save_automation(str(task_id).strip(), payload)


async def automation_tick() -> None:
    global _last_tick_info
    from app.channels.service import get_channel_service

    slot = _slot_key()
    tick_iso = datetime.now().isoformat(timespec="seconds")
    now = datetime.now()
    all_loaded = await asyncio.to_thread(_load_automation_tomls)
    loaded_ids = [tid for tid, _ in all_loaded]
    active_pairs = [(tid, t) for tid, t in all_loaded if str(t.get("status") or "").lower() == "active"]

    service = get_channel_service()
    ch_status: dict[str, Any] | None = None
    if service is not None:
        try:
            ch_status = service.get_status()
        except Exception:
            ch_status = {"error": "get_status_failed"}
            logger.exception("automation_tick: channel get_status failed")
    channel_ok = service is not None and bool((ch_status or {}).get("service_running"))

    skipped_reasons: list[str] = []
    fired_ids: list[str] = []

    log_tick = logger.info if active_pairs else logger.debug
    log_tick(
        "automation_tick begin tick=%s local_now=%s slot=%s storage=sqlite task_count=%d loaded_ids=%s active_count=%d",
        tick_iso,
        now.isoformat(timespec="seconds"),
        slot,
        len(all_loaded),
        loaded_ids[:50] if len(loaded_ids) <= 50 else loaded_ids[:50] + [f"…+{len(loaded_ids) - 50} more"],
        len(active_pairs),
    )
    if active_pairs:
        logger.debug("automation_tick active_tasks detail: %s", _active_tasks_brief_for_log(active_pairs))
    elif all_loaded:
        parts: list[str] = []
        for tid, t in all_loaded[:30]:
            lg = _task_wants_langgraph_run(t)
            parts.append(f"{tid}(status={t.get('status')!r}, langgraph_run={lg}, once_fired={bool(t.get('once_fired'))})")
        tail = f" …+{len(all_loaded) - 30} more" if len(all_loaded) > 30 else ""
        logger.debug(
            "automation_tick: %d TOML loaded but active_count=0 — no run, no LangGraph. Only status=active tasks are scheduled. In EvoPanel click Resume or edit TOML. Detail: %s%s",
            len(all_loaded),
            "; ".join(parts),
            tail,
        )

    if service is None:
        logger.debug("automation_tick: get_channel_service() is None (channel service never started on this process). Scheduler will not execute automations until ChannelService is running.")
    elif ch_status is not None:
        logger.debug(
            "automation_tick channel snapshot service_running=%s channels=%s",
            ch_status.get("service_running"),
            ch_status.get("channels"),
        )

    if not channel_ok:
        skipped_reasons.append("channel_service_not_running_im_channels_disabled_or_failed")

    for task_id, task in active_pairs:
        # 检查 valid_from / valid_until 时间窗口
        vf = str(task.get("valid_from") or "").strip()
        vu = str(task.get("valid_until") or "").strip()
        if vf or vu:
            _now = datetime.now()
            _skip_valid = False
            if vf:
                try:
                    _vf = datetime.fromisoformat(vf.replace("Z", "+00:00"))
                    if _vf.tzinfo:
                        _vf = _vf.astimezone().replace(tzinfo=None)
                    if _now < _vf:
                        skipped_reasons.append(f"{task_id}:before_valid_from")
                        _skip_valid = True
                except Exception:
                    pass
            if vu and not _skip_valid:
                try:
                    _vu = datetime.fromisoformat(vu.replace("Z", "+00:00"))
                    if _vu.tzinfo:
                        _vu = _vu.astimezone().replace(tzinfo=None)
                    if _now > _vu:
                        skipped_reasons.append(f"{task_id}:after_valid_until")
                        _skip_valid = True
                except Exception:
                    pass
            if _skip_valid:
                continue
        if str(task.get("schedule_type") or "") == "once" and task.get("scheduled_at"):
            if task.get("once_fired"):
                skipped_reasons.append(f"{task_id}:once_already_fired")
                continue
            try:
                t = datetime.fromisoformat(str(task["scheduled_at"]).replace("Z", "+00:00"))
                if t.tzinfo:
                    t = t.astimezone().replace(tzinfo=None)
                should = abs((datetime.now() - t).total_seconds()) < 120
            except Exception:
                should = False
            if not should:
                skipped_reasons.append(f"{task_id}:once_not_in_window")
                continue
        else:
            cron_expr = _effective_cron(task)
            if not cron_expr:
                skipped_reasons.append(f"{task_id}:no_five_field_schedule_or_derivable_rrule")
                logger.warning(
                    "automation task %s (%s): missing 5-field cron and could not derive one from rrule/schedule",
                    task_id,
                    task.get("name", ""),
                )
                continue
            should = bool(cron_matches_now(cron_expr))
            if not should:
                skipped_reasons.append(f"{task_id}:cron_no_match_now expr={cron_expr!r} slot={slot}")
                continue
        # Direct LangGraph and task-center enqueue both run without IM channel; push is best-effort.
        if _last_slot.get(task_id) == slot:
            skipped_reasons.append(f"{task_id}:dedupe_same_minute")
            continue
        _last_slot[task_id] = slot
        cron_expr = _effective_cron(task) if str(task.get("schedule_type") or "") != "once" else None
        logger.info(
            "automation_runner: firing task_id=%s name=%r schedule_type=%s cron=%r once_at=%r slot=%s via_task=%s channel_ok=%s",
            task_id,
            task.get("name", ""),
            task.get("schedule_type") or "cron",
            cron_expr,
            task.get("scheduled_at"),
            slot,
            _automation_via_task_center(task),
            channel_ok,
        )
        await _run_one_task(task_id, task, service)
        fired_ids.append(task_id)
        logger.info("automation_runner: fired done task_id=%s name=%r", task_id, task.get("name", ""))

    _last_tick_info = {
        "tick_iso": tick_iso,
        "slot": slot,
        "task_count": len(all_loaded),
        "active_tasks": len(active_pairs),
        "fired_task_ids": fired_ids,
        "channel_service_running": channel_ok,
        "skipped_reasons_sample": skipped_reasons[:12],
        "skipped_reasons_total": len(skipped_reasons),
    }

    logger.debug(
        "automation_tick end slot=%s files=%d active=%d fired=%s channel_ok=%s (HTTP GET /api/automation/scheduler/status → last_tick)",
        slot,
        len(all_loaded),
        len(active_pairs),
        fired_ids or "none",
        channel_ok,
    )
    if fired_ids:
        logger.info(
            "automation_tick fired slot=%s active=%d fired=%s channel_ok=%s",
            slot,
            len(active_pairs),
            fired_ids,
            channel_ok,
        )
    if skipped_reasons:
        cap = 40
        shown = skipped_reasons[:cap]
        tail = f" …(+{len(skipped_reasons) - cap} more)" if len(skipped_reasons) > cap else ""
        logger.debug(
            "automation_tick skipped_reasons total=%d: %s%s",
            len(skipped_reasons),
            "; ".join(shown),
            tail,
        )
    if active_pairs and not fired_ids and channel_ok:
        logger.debug("automation_tick: no task fired this minute — cron matches local machine clock; check expr vs now, dedupe_same_minute, or once window. Full skipped list above; also last_tick in GET /api/automation/scheduler/status")
    elif active_pairs and not fired_ids and not channel_ok:
        logger.warning("automation_tick: no task fired — channel service down; fix IM channel startup/config then restart Gateway (see channel snapshot log lines above)")


async def run_automation_scheduler(stop: asyncio.Event) -> None:
    global _scheduler_loop_running
    interval = max(5, int(os.getenv("EVOFLOW_AUTOMATION_TICK_SECONDS", str(DEFAULT_INTERVAL_SECONDS))))
    _env_dir = os.getenv("EVOFLOW_AUTOMATIONS_DIR", "").strip()
    _scheduler_loop_running = True
    logger.info(
        "automation_runner: loop started storage=sqlite tick_interval_s=%s env EVOFLOW_AUTOMATION_TICK_SECONDS=%r diagnostics=GET /api/automation/scheduler/status",
        interval,
        os.getenv("EVOFLOW_AUTOMATION_TICK_SECONDS", ""),
    )
    try:
        while not stop.is_set():
            from evoflow.observability.poll_loop_log import log_poll_tick

            log_poll_tick("automation_scheduler", key="global", interval_s=600.0)
            try:
                await automation_tick()
            except Exception:
                logger.exception("automation_runner: tick failed (next tick after interval sleep)")
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except TimeoutError:
                pass
    finally:
        _scheduler_loop_running = False
        reason = "stop_event" if stop.is_set() else "loop_exit"
        logger.info("automation_runner: loop stopped (%s)", reason)


def automation_scheduler_enabled() -> bool:
    """True unless ``EVOFLOW_AUTOMATION_SCHEDULER`` explicitly disables the loop."""
    v = os.getenv("EVOFLOW_AUTOMATION_SCHEDULER", "").strip().lower()
    if not v:
        return True
    if v in ("0", "false", "no", "off", "disabled"):
        return False
    return True
