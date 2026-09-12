"""Gateway-aligned scheduled automations (cron / once) in SQLite ``evoflow_automations``.

The ``automation`` tool reads/writes the same records as
``app.gateway.automation_runner`` and EvoPanel (5-field cron in ``schedule``,
``schedule_type`` ``once`` / ``recurring``, Feishu + LangGraph fields).

Actions: ``create``, ``list``, ``query``, ``status``, ``update``, ``run``,
``pause``, ``resume``, ``delete``. Immediate Gateway run: ``action=run`` + ``id``,
or ``run_now=true`` on ``create``/``update`` only when the user asked to execute now.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Any
from urllib.parse import quote

from langchain.tools import tool

from evoflow.automation_toml_strings import escape_toml_basic_string
from evoflow.collab.id_format import make_automation_id

logger = logging.getLogger(__name__)


def _automations_dir() -> Path:
    raw = (os.getenv("EVOFLOW_AUTOMATIONS_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".evoflow" / "tasks" / "automations"


def _ensure_dir() -> Path:
    d = _automations_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def _queue_immediate_run_via_gateway(task_id: str) -> str:
    """POST Gateway ``.../run?run_async=true`` so the task runs once without blocking the tool."""
    tid = (task_id or "").strip()
    if not tid:
        return ""
    base = (os.getenv("EVOFLOW_GATEWAY_URL") or os.getenv("DEER_FLOW_CHANNELS_GATEWAY_URL") or "http://127.0.0.1:8012").strip().rstrip("/")
    url = f"{base}/api/automation/tasks/{quote(tid, safe='')}/run?run_async=true"
    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict) and payload.get("queued"):
            return f"Immediate run queued on Gateway (`{tid}`)."
        return f"Gateway run response: {body[:160].strip()}"
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")[:280]
        return f"Gateway HTTP {e.code} for immediate run: {err}"
    except Exception as e:
        return f"Could not reach Gateway for immediate run ({e!s}). Task file is on disk; run manually from EvoPanel or wait for cron."


def _toml_path(task_id: str) -> Path:
    return _ensure_dir() / f"{task_id}.toml"


def _write_flat_toml(path: Path, data: dict[str, Any]) -> None:
    """Same flat layout as Gateway ``_rewrite_automation_toml`` / EvoPanel ``_saveAutomation``."""
    esc = escape_toml_basic_string
    lines: list[str] = []
    lines.append('name = "' + esc(str(data.get("name") or "")) + '"')
    if "prompt" in data:
        lines.append('prompt = "' + esc(str(data.get("prompt") or "")) + '"')
    if data.get("schedule"):
        lines.append('schedule = "' + esc(str(data["schedule"])) + '"')
    if data.get("rrule"):
        lines.append('rrule = "' + esc(str(data["rrule"])) + '"')
    if data.get("scheduled_at"):
        lines.append('scheduled_at = "' + esc(str(data["scheduled_at"])) + '"')
    if data.get("status"):
        lines.append('status = "' + esc(str(data["status"])) + '"')
    if data.get("schedule_type"):
        lines.append('schedule_type = "' + esc(str(data["schedule_type"])) + '"')
    if data.get("workspace"):
        lines.append('workspace = "' + esc(str(data["workspace"])) + '"')
    if data.get("valid_from"):
        lines.append('valid_from = "' + esc(str(data["valid_from"])) + '"')
    if data.get("valid_until"):
        lines.append('valid_until = "' + esc(str(data["valid_until"])) + '"')
    if data.get("max_duration_minutes") is not None:
        try:
            lines.append("max_duration_minutes = " + str(int(data["max_duration_minutes"])))
        except (TypeError, ValueError):
            pass
    lines.append("feishu_push_enabled = " + ("true" if data.get("feishu_push_enabled") else "false"))
    lines.append("langgraph_run = true")
    if data.get("langgraph_thread_mode"):
        lines.append('langgraph_thread_mode = "' + esc(str(data["langgraph_thread_mode"])) + '"')
    if data.get("langgraph_thread_id"):
        lines.append('langgraph_thread_id = "' + esc(str(data["langgraph_thread_id"])) + '"')
    if data.get("langgraph_timeout_seconds") is not None:
        try:
            lines.append("langgraph_timeout_seconds = " + str(int(data["langgraph_timeout_seconds"])))
        except (TypeError, ValueError):
            pass
    if data.get("once_fired"):
        lines.append("once_fired = true")
    if data.get("created_at"):
        lines.append('created_at = "' + esc(str(data["created_at"])) + '"')
    if data.get("last_run"):
        lines.append('last_run = "' + esc(str(data["last_run"])) + '"')
    if data.get("last_status"):
        lines.append('last_status = "' + esc(str(data["last_status"])) + '"')
    if data.get("run_count") is not None:
        try:
            lines.append("run_count = " + str(int(data["run_count"])))
        except (TypeError, ValueError):
            pass
    if data.get("agent_code"):
        lines.append('agent_code = "' + esc(str(data["agent_code"])) + '"')
    if data.get("model_name"):
        lines.append('model_name = "' + esc(str(data["model_name"])) + '"')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _save_automation_dict(task_id: str, data: dict[str, Any]) -> None:
    from evoflow.persistence import automation_repositories as auto_repo

    auto_repo.save_automation(task_id, data)


def _load_toml_dict(task_id: str) -> dict[str, Any] | None:
    from evoflow.persistence import automation_repositories as auto_repo

    return auto_repo.load_automation(task_id)


def _list_task_ids() -> list[str]:
    from evoflow.persistence import automation_repositories as auto_repo

    return [tid for tid, _ in auto_repo.list_automations()]


def _delete_file(task_id: str) -> bool:
    from evoflow.persistence import automation_repositories as auto_repo

    return auto_repo.delete_automation(task_id)


def _normalize_id(raw: str | None) -> str:
    """Strip Markdown quotes/backticks from automation ``id`` (TOML stem)."""
    if raw is None:
        return ""
    s = str(raw).strip().strip("`").strip('"').strip("'")
    return s


# ─── RRULE → 5-field cron (align EvoPanel ``rruleToCron`` for Gateway runner) ───


def _rrule_to_cron(rrule_str: str, scheduled_at: str = "") -> str:
    if (scheduled_at or "").strip():
        return scheduled_at.strip()
    r = (rrule_str or "").strip()
    if not r:
        return "0 * * * *"
    parts: dict[str, str] = {}
    for seg in r.upper().split(";"):
        seg = seg.strip()
        if not seg or "=" not in seg:
            continue
        k, _, v = seg.partition("=")
        parts[k.strip()] = v.strip()
    freq = parts.get("FREQ", "")
    try:
        interval = max(1, int(parts.get("INTERVAL", "1")))
    except ValueError:
        interval = 1
    try:
        hour = int(parts.get("BYHOUR", "9"))
    except ValueError:
        hour = 9
    try:
        minute = int(parts.get("BYMINUTE", "0"))
    except ValueError:
        minute = 0
    byday = parts.get("BYDAY", "")
    dow_map = {"SU": "0", "MO": "1", "TU": "2", "WE": "3", "TH": "4", "FR": "5", "SA": "6"}
    if freq == "HOURLY":
        return f"0 */{interval} * * *"
    if freq == "DAILY":
        if byday and "," in byday:
            nums = ",".join(dow_map.get(d.strip(), "?") for d in byday.split(","))
            return f"{minute} {hour} * * {nums}"
        return f"{minute} {hour} * * *"
    if freq == "WEEKLY":
        if byday:
            nums = ",".join(dow_map.get(d.strip(), "?") for d in byday.split(","))
            return f"{minute} {hour} * * {nums}"
        return f"{minute} {hour} * * 1"
    return f"{minute} {hour} * * *"


# ─── Human / RRULE schedule parsing (recurring) ───

_HUMAN_SCHEDULE_MAP: dict[str, str] = {
    "every hour": "FREQ=HOURLY;INTERVAL=1",
    "every 2 hours": "FREQ=HOURLY;INTERVAL=2",
    "every 6 hours": "FREQ=HOURLY;INTERVAL=6",
    "every day": "FREQ=DAILY;INTERVAL=1",
    "daily": "FREQ=DAILY;INTERVAL=1",
    "every week": "FREQ=WEEKLY;INTERVAL=1",
    "weekly": "FREQ=WEEKLY;INTERVAL=1",
    "every monday": "FREQ=WEEKLY;BYDAY=MO",
    "weekdays": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
    "workdays": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
}


def _parse_schedule(schedule_input: str) -> tuple[str, str]:
    """Return (rrule_or_empty, ``recurring``|``once``)."""
    s = schedule_input.strip()
    if not s:
        return "", "recurring"
    low = s.lower()
    if re.match(r"^\d{4}-\d{2}-\d{2}", s) and ("t" in low or len(s) >= 16):
        return "", "once"
    for pattern, rrule in _HUMAN_SCHEDULE_MAP.items():
        if pattern == low or pattern.replace(" ", "_") == low.replace(" ", "_"):
            return rrule, "recurring"
    if s.upper().startswith("FREQ="):
        return s.upper(), "recurring"
    return s, "recurring"


_ISO_ONCE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}|$)")


def _effective_schedule_fields(schedule_input: str) -> dict[str, Any]:
    """Build ``schedule`` / ``scheduled_at`` / ``schedule_type`` / ``rrule`` for TOML."""
    s = (schedule_input or "").strip()
    if not s:
        return {}
    parts = s.split()
    if len(parts) == 6 and parts[0].isdigit() and 0 <= int(parts[0]) <= 59:
        parts = parts[1:]
    if len(parts) == 5:
        return {
            "schedule_type": "recurring",
            "schedule": " ".join(parts),
            "scheduled_at": "",
            "rrule": "",
        }
    if _ISO_ONCE_RE.match(s):
        try:
            datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            pass
        else:
            return {"schedule_type": "once", "scheduled_at": s, "schedule": s, "rrule": ""}

    rrule, st = _parse_schedule(s)
    if st == "once":
        return {"schedule_type": "once", "scheduled_at": s, "schedule": s, "rrule": ""}
    cron = _rrule_to_cron(rrule)
    return {"schedule_type": "recurring", "schedule": cron, "rrule": rrule, "scheduled_at": ""}


def _format_task_markdown(tid: str, d: dict[str, Any]) -> str:
    st = str(d.get("status") or "")
    icon = {"active": "[ON]", "paused": "[PAUSED]"}.get(st.lower(), "[?]")
    sched = d.get("schedule") or d.get("scheduled_at") or d.get("rrule") or "(none)"
    prompt = str(d.get("prompt") or "")
    trunc = (prompt[:72] + "…") if len(prompt) > 72 else prompt
    feishu = "on" if d.get("feishu_push_enabled") else "off"
    return f"- {icon} **{d.get('name') or '(unnamed)'}** (`{tid}`)\n  status={st} | type={d.get('schedule_type') or 'cron'} | schedule=`{sched}`\n  feishu_push={feishu}\n  prompt: {trunc or '(empty)'}"


# ─── In-process scheduler compat (``core.scheduler.manager``) ─────────────


class AutomationStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"


def _cron_five_to_rrule(cron: str) -> str:
    """Approximate RRULE for legacy scheduler when TOML has cron but no ``rrule``."""
    parts = cron.strip().split()
    if len(parts) != 5:
        return "FREQ=DAILY;INTERVAL=1"
    mi_s, h_s, _dom, _mon, dow_s = parts

    def _ival(x: str, default: int) -> int:
        if x in ("*", "?"):
            return default
        try:
            return int(x)
        except ValueError:
            return default

    mi = _ival(mi_s, 0)
    h = _ival(h_s, 9)
    if mi_s == "0" and h_s.startswith("*/"):
        try:
            n = max(1, int(h_s[2:]))
            return f"FREQ=HOURLY;INTERVAL={n}"
        except ValueError:
            return "FREQ=HOURLY;INTERVAL=1"
    if dow_s not in ("*", "?"):
        num_to_day = {"0": "SU", "1": "MO", "2": "TU", "3": "WE", "4": "TH", "5": "FR", "6": "SA"}
        days = ",".join(num_to_day.get(p.strip(), "MO") for p in dow_s.split(","))
        return f"FREQ=WEEKLY;INTERVAL=1;BYDAY={days};BYHOUR={h};BYMINUTE={mi}"
    return f"FREQ=DAILY;INTERVAL=1;BYHOUR={h};BYMINUTE={mi}"


@dataclass
class AutomationTask:
    """Legacy scheduler task shape + Gateway TOML fields (``schedule`` cron string)."""

    id: str = ""
    name: str = ""
    prompt: str = ""
    schedule_type: str = "recurring"
    rrule: str = ""
    scheduled_at: str = ""
    status: str = AutomationStatus.ACTIVE.value
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    valid_from: str | None = None
    valid_until: str | None = None
    cwds: list[str] = field(default_factory=list)
    max_duration_minutes: int | None = None
    last_run: str | None = None
    last_status: str | None = None
    run_count: int = 0
    schedule_cron: str = field(default="", repr=False)


def _task_to_flat_dict(task: AutomationTask) -> dict[str, Any]:
    sched_cron = (task.schedule_cron or "").strip()
    if not sched_cron and task.schedule_type != "once" and task.rrule:
        sched_cron = _rrule_to_cron(task.rrule, "")
    sched_once = task.scheduled_at if task.schedule_type == "once" else ""
    d: dict[str, Any] = {
        "name": task.name,
        "prompt": task.prompt,
        "status": task.status,
        "schedule_type": task.schedule_type,
        "rrule": task.rrule if task.schedule_type != "once" else "",
        "scheduled_at": sched_once,
        "schedule": sched_once if task.schedule_type == "once" else sched_cron,
        "created_at": task.created_at,
    }
    if task.valid_from:
        d["valid_from"] = task.valid_from
    if task.valid_until:
        d["valid_until"] = task.valid_until
    if task.cwds:
        d["workspace"] = task.cwds[0]
    if task.max_duration_minutes is not None:
        d["max_duration_minutes"] = task.max_duration_minutes
    if task.last_run:
        d["last_run"] = task.last_run
    if task.last_status:
        d["last_status"] = task.last_status
    d["run_count"] = task.run_count
    return d


def _dict_to_automation_task(task_id: str, d: dict[str, Any]) -> AutomationTask:
    rrule = str(d.get("rrule") or "")
    sched_cron = str(d.get("schedule") or "").strip()
    st = str(d.get("schedule_type") or "recurring").lower()
    if st == "once":
        sa = str(d.get("scheduled_at") or d.get("schedule") or "")
        rrule = ""
        sched_cron = ""
    else:
        sa = str(d.get("scheduled_at") or "")
        if not rrule and sched_cron and len(sched_cron.split()) == 5:
            rrule = _cron_five_to_rrule(sched_cron)
    ws = str(d.get("workspace") or "").strip()
    cwds = [ws] if ws else []
    rc = 0
    if d.get("run_count") is not None:
        try:
            rc = int(d["run_count"])
        except (TypeError, ValueError):
            rc = 0
    md: int | None = None
    if d.get("max_duration_minutes") is not None:
        try:
            md = int(d["max_duration_minutes"])
        except (TypeError, ValueError):
            md = None
    return AutomationTask(
        id=task_id,
        name=str(d.get("name") or ""),
        prompt=str(d.get("prompt") or ""),
        schedule_type=st,
        rrule=rrule,
        scheduled_at=sa,
        status=str(d.get("status") or AutomationStatus.ACTIVE.value),
        created_at=str(d.get("created_at") or datetime.now().isoformat(timespec="seconds")),
        valid_from=str(d.get("valid_from") or "") or None,
        valid_until=str(d.get("valid_until") or "") or None,
        cwds=cwds,
        max_duration_minutes=md,
        last_run=str(d.get("last_run") or "") or None,
        last_status=str(d.get("last_status") or "") or None,
        run_count=rc,
        schedule_cron=sched_cron if st != "once" else "",
    )


def _load_task(automation_id: str) -> AutomationTask | None:
    d = _load_toml_dict(automation_id)
    if not d:
        return None
    return _dict_to_automation_task(automation_id, d)


def _save_task(task: AutomationTask) -> None:
    existing = _load_toml_dict(task.id) or {}
    merged = {**existing, **_task_to_flat_dict(task)}
    _save_automation_dict(task.id, merged)


def _list_all_tasks(status_filter: str | None = None) -> list[AutomationTask]:
    tasks: list[AutomationTask] = []
    for tid in _list_task_ids():
        t = _load_task(tid)
        if t is None:
            continue
        if status_filter and t.status != status_filter:
            continue
        tasks.append(t)
    tasks.sort(key=lambda x: x.created_at, reverse=True)
    return tasks


# ─── Tool ───────────────────────────────────────────────────────────


@tool("automation", parse_docstring=False)
def automation_tool(
    action: str,
    *,
    name: str | None = None,
    prompt: str | None = None,
    schedule: str | None = None,
    workspace: str | None = None,
    id: str | None = None,
    valid_from: str | None = None,
    valid_until: str | None = None,
    feishu_push_enabled: bool | None = None,
    langgraph_thread_mode: str | None = None,
    langgraph_timeout_seconds: int | None = None,
    status: str | None = None,
    run_now: bool | None = None,
    agent_code: str | None = None,
    model_name: str | None = None,
) -> str:
    """Manage Gateway cron automations (same records as EvoPanel / ``automation_runner``).

    Storage: SQLite table ``evoflow_automations``.

    Args:
        action: One of:
            ``create`` — needs ``name``, ``prompt``, ``schedule``;
            ``list`` / ``query`` — optional ``id`` filter;
            ``status``, ``update``, ``pause``, ``resume``, ``delete`` — need ``id``;
            ``run`` — immediate execution via Gateway (EvoPanel manual run equivalent); needs ``id``.
        name: Task title.
        prompt: Instructions for the model when the task runs (LangGraph user message body).
        schedule: **5-field cron** (``min hour dom month dow``), ISO datetime for one-shot,
            human text (``daily``, ``weekdays``, …), or RRULE (``FREQ=…``).
        workspace: Optional workspace path string (stored as ``workspace`` in TOML).
        id: Automation id — same as the ``*.toml`` filename stem (no extension), e.g. ``Automation_…``.
        valid_from / valid_until: Optional validity window strings.
        feishu_push_enabled: Enable Feishu card push on each run (target is the gateway default chat, resolved at run time).
        langgraph_thread_mode: ``fresh`` or ``sticky`` (optional).
        langgraph_timeout_seconds: Optional run cap for ``runs.wait``.
        status: For ``update`` only — e.g. ``active`` / ``paused``.
        run_now: If ``True`` on ``create`` / ``update`` only, queue one immediate Gateway run after writing TOML.
            Omit or ``False`` when the user only wants to save the schedule (default).
        agent_code: Agent code to run (``lead_agent`` by default). Use any registered agent code.
        model_name: Override model name for this automation (defaults to the agent's configured model).

    Returns:
        Human-readable result or error message.
    """
    action_lower = (action or "").strip().lower()

    if action_lower in ("list", "ls", "l", "query", "search"):
        tid_filter = _normalize_id(id)
        ids = _list_task_ids()
        rows: list[str] = []
        for tid in ids:
            if tid_filter and tid != tid_filter:
                continue
            d = _load_toml_dict(tid)
            if d is None:
                continue
            rows.append(_format_task_markdown(tid, d))
        if tid_filter and not rows:
            return f"No automation with id=`{tid_filter}`."
        if not rows:
            return "No automations. Use action='create' with name, prompt, schedule."
        title = "## Automation" + (" (filtered)\n" if tid_filter else f"s ({len(rows)})\n")
        return title + "\n" + "\n".join(rows)

    if action_lower in ("status", "show", "info", "get"):
        tid = _normalize_id(id)
        if not tid:
            return "Error: ``id`` is required for status."
        d = _load_toml_dict(tid)
        if not d:
            return f"Error: No automation with id=`{tid}`."
        ws = str(d.get("workspace") or "(default)")
        sched = d.get("schedule") or d.get("scheduled_at") or d.get("rrule") or "(none)"
        lines = [
            f"## {d.get('name') or '(unnamed)'} (`{tid}`)",
            "",
            f"- **status**: {d.get('status')}",
            f"- **schedule_type**: {d.get('schedule_type') or 'cron'}",
            f"- **schedule / once / rrule**: `{sched}`",
            f"- **agent_code**: {d.get('agent_code') or 'lead_agent (default)'}",
            f"- **model_name**: {d.get('model_name') or '(default)'}",
            f"- **prompt**: {d.get('prompt') or ''}",
            f"- **workspace**: {ws}",
            f"- **feishu_push_enabled**: {bool(d.get('feishu_push_enabled'))}",
            f"- **langgraph_thread_mode**: {d.get('langgraph_thread_mode') or 'fresh'}",
            f"- **created_at**: {d.get('created_at', '')}",
            f"- **once_fired**: {bool(d.get('once_fired'))}",
        ]
        return "\n".join(lines)

    if action_lower == "create":
        if not name or not str(name).strip():
            return "Error: ``name`` is required for create."
        if not prompt or not str(prompt).strip():
            return "Error: ``prompt`` is required for create."
        if not schedule or not str(schedule).strip():
            return "Error: ``schedule`` is required for create."
        sf = _effective_schedule_fields(str(schedule).strip())
        if not sf or not sf.get("schedule_type"):
            return f"Error: could not interpret schedule `{schedule!r}`."
        tid = make_automation_id()
        now = datetime.now().isoformat(timespec="seconds")
        data: dict[str, Any] = {
            "name": name.strip(),
            "prompt": prompt.strip(),
            "status": "active",
            "created_at": now,
            "feishu_push_enabled": bool(feishu_push_enabled) if feishu_push_enabled is not None else False,
            **sf,
        }
        if workspace and str(workspace).strip():
            data["workspace"] = str(workspace).strip()
        if valid_from:
            data["valid_from"] = str(valid_from).strip()
        if valid_until:
            data["valid_until"] = str(valid_until).strip()
        if langgraph_thread_mode and str(langgraph_thread_mode).strip().lower() in ("fresh", "sticky"):
            data["langgraph_thread_mode"] = str(langgraph_thread_mode).strip().lower()
        if langgraph_timeout_seconds is not None:
            try:
                data["langgraph_timeout_seconds"] = int(langgraph_timeout_seconds)
            except (TypeError, ValueError):
                pass
        if agent_code and str(agent_code).strip():
            data["agent_code"] = str(agent_code).strip()
        if model_name and str(model_name).strip():
            data["model_name"] = str(model_name).strip()
        _save_automation_dict(tid, data)
        logger.info("automation_tool create id=%s name=%r", tid, data.get("name"))
        lines = [
            f"OK: created automation (id=`{tid}`)",
            f"- schedule_type={data.get('schedule_type')} schedule=`{data.get('schedule') or data.get('scheduled_at')}`",
            "- Gateway scheduler reads SQLite ``evoflow_automations``",
            "Use ``action=status`` with ``id``; ``pause`` / ``delete`` to manage.",
        ]
        if run_now:
            run_note = _queue_immediate_run_via_gateway(tid)
            if run_note:
                lines.append(run_note)
        return "\n".join(lines)

    if action_lower in ("update", "modify", "edit"):
        tid = _normalize_id(id)
        if not tid:
            return "Error: ``id`` is required for update."
        d = _load_toml_dict(tid)
        if not d:
            return f"Error: No automation with id=`{tid}`."
        if name is not None:
            d["name"] = str(name).strip()
        if prompt is not None:
            d["prompt"] = str(prompt).strip()
        if schedule is not None and str(schedule).strip():
            d.pop("once_fired", None)
            sf = _effective_schedule_fields(str(schedule).strip())
            d.update(sf)
        if workspace is not None:
            d["workspace"] = str(workspace).strip() if str(workspace).strip() else ""
        if valid_from is not None:
            d["valid_from"] = str(valid_from).strip() if valid_from else ""
        if valid_until is not None:
            d["valid_until"] = str(valid_until).strip() if valid_until else ""
        if feishu_push_enabled is not None:
            d["feishu_push_enabled"] = bool(feishu_push_enabled)
        if langgraph_thread_mode is not None and str(langgraph_thread_mode).strip().lower() in ("fresh", "sticky", ""):
            lm = str(langgraph_thread_mode).strip().lower()
            if lm:
                d["langgraph_thread_mode"] = lm
        if langgraph_timeout_seconds is not None:
            try:
                d["langgraph_timeout_seconds"] = int(langgraph_timeout_seconds)
            except (TypeError, ValueError):
                pass
        if status is not None and str(status).strip():
            d["status"] = str(status).strip().lower()
        if agent_code is not None:
            d["agent_code"] = str(agent_code).strip() if str(agent_code).strip() else ""
        if model_name is not None:
            d["model_name"] = str(model_name).strip() if str(model_name).strip() else ""
        _save_automation_dict(tid, d)
        logger.info("automation_tool update id=%s", tid)
        msg = f"OK: updated automation `{tid}`. Use ``action=status`` to verify."
        if run_now:
            run_note = _queue_immediate_run_via_gateway(tid)
            return f"{msg}\n{run_note}" if run_note else msg
        return msg

    if action_lower in ("run", "execute_now"):
        tid = _normalize_id(id)
        if not tid:
            return "Error: ``id`` is required for run."
        if _load_toml_dict(tid) is None:
            return f"Error: No automation with id=`{tid}`."
        return _queue_immediate_run_via_gateway(tid)

    if action_lower == "pause":
        tid = _normalize_id(id)
        if not tid:
            return "Error: ``id`` is required for pause."
        d = _load_toml_dict(tid)
        if not d:
            return f"Error: No automation with id=`{tid}`."
        if str(d.get("status") or "").lower() != "active":
            return f"Info: `{tid}` is already `{d.get('status')}`."
        d["status"] = "paused"
        _save_automation_dict(tid, d)
        return f"OK: paused `{tid}`."

    if action_lower in ("resume", "unpause"):
        tid = _normalize_id(id)
        if not tid:
            return "Error: ``id`` is required for resume."
        d = _load_toml_dict(tid)
        if not d:
            return f"Error: No automation with id=`{tid}`."
        if str(d.get("status") or "").lower() != "paused":
            return f"Info: `{tid}` is `{d.get('status')}` (resume only from paused)."
        d["status"] = "active"
        _save_automation_dict(tid, d)
        return f"OK: resumed `{tid}`."

    if action_lower in ("delete", "remove", "rm"):
        tid = _normalize_id(id)
        if not tid:
            return "Error: ``id`` is required for delete."
        d = _load_toml_dict(tid)
        if not d:
            return f"Error: No automation with id=`{tid}`."
        label = str(d.get("name") or tid)
        if _delete_file(tid):
            return f"OK: deleted `{label}` (`{tid}`)."
        return f"Error: failed to delete `{tid}`."

    valid = "create | list | query | status | update | run | pause | resume | delete"
    return (
        f"Error: unknown action `{action!r}`. Valid: {valid}\n\n"
        "Examples:\n"
        "- ``automation('create', name='日报', prompt='…', schedule='0 9 * * *')``\n"
        "- ``automation('run', id='<stem>')`` — immediate run (user asked to execute now)\n"
        "- ``automation('list')`` / ``automation('query', id='<stem>')``\n"
        "- ``automation('update', id='<stem>', schedule='30 14 * * *', …)``"
    )
