"""Cron / RRULE helpers for automation — shared by Gateway runner, admin CLI, and Panel preview."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any


def _parse_cron_five(expr: str) -> tuple[str, str, str, str, str]:
    parts = expr.strip().split()
    if len(parts) >= 5:
        return parts[0], parts[1], parts[2], parts[3], parts[4]
    return "*", "*", "*", "*", "*"


def is_five_field_cron_or_keyword(s: str) -> bool:
    t = (s or "").strip()
    if not t or "FREQ=" in t.upper():
        return False
    if t.startswith("@"):
        return True
    return len(t.split()) >= 5


def cron_field_matches(value: int, field: str) -> bool:
    """Match a numeric cron field (minute/hour/dom/month). Supports *, lists, ranges, steps."""
    f = (field or "").strip()
    if not f or f in ("*", "?"):
        return True
    if "," in f:
        return any(cron_field_matches(value, x.strip()) for x in f.split(","))
    if f.startswith("*/"):
        try:
            step = int(f[2:])
        except ValueError:
            return False
        return step > 0 and value % step == 0
    if "/" in f and not f.startswith("*/"):
        try:
            left, right = f.split("/", 1)
            step = int(right.strip())
            if step <= 0:
                return False
            base_s = left.strip()
            # ``9-19/2`` → 9,11,13,… within range (default duty cron).
            if "-" in base_s:
                lo_s, hi_s = base_s.split("-", 1)
                lo, hi = int(lo_s), int(hi_s)
                if lo > hi:
                    lo, hi = hi, lo
                if not (lo <= value <= hi):
                    return False
                return (value - lo) % step == 0
            base = int(base_s) if base_s else 0
            return value >= base and (value - base) % step == 0
        except ValueError:
            return False
    if "-" in f:
        try:
            lo_s, hi_s = f.split("-", 1)
            lo, hi = int(lo_s), int(hi_s)
            return lo <= value <= hi
        except ValueError:
            return False
    try:
        return int(f) == value
    except ValueError:
        return False


def cron_dow_matches(js_dow: int, field: str) -> bool:
    """Match day-of-week. ``js_dow`` is JS style: Sun=0 … Sat=6. Supports 7=Sun and ranges like 1-5."""
    f = (field or "").strip()
    if not f or f in ("*", "?"):
        return True
    for part in f.split(","):
        p = part.strip().upper()
        name_map = {"SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6}
        if p in name_map:
            if name_map[p] == js_dow:
                return True
            continue
        if p.startswith("*/"):
            try:
                step = int(p[2:])
                if step > 0 and js_dow % step == 0:
                    return True
            except ValueError:
                pass
            continue
        if "-" in p:
            try:
                lo_s, hi_s = p.split("-", 1)
                lo, hi = int(lo_s), int(hi_s)
                for n in range(lo, hi + 1):
                    nn = 0 if n == 7 else n
                    if nn == js_dow:
                        return True
            except ValueError:
                pass
            continue
        try:
            n = int(p)
        except ValueError:
            continue
        if n == 7:
            n = 0
        if n == js_dow:
            return True
    return False


def cron_matches_at(expr: str, when: datetime | None = None) -> bool:
    """Whether a 5-field cron matches ``when`` (local naive datetime; default now)."""
    parts = (expr or "").strip().split()
    if len(parts) < 5:
        return False
    now = when or datetime.now()
    js_dow = (now.weekday() + 1) % 7
    m_f, h_f, dom_f, mon_f, dow_f = parts[0], parts[1], parts[2], parts[3], parts[4]
    return (
        cron_field_matches(now.minute, m_f)
        and cron_field_matches(now.hour, h_f)
        and cron_field_matches(now.day, dom_f)
        and cron_field_matches(now.month, mon_f)
        and cron_dow_matches(js_dow, dow_f)
    )


def next_cron_runs(expr: str, count: int = 5, from_dt: datetime | None = None) -> list[datetime]:
    """Next ``count`` fire times for a 5-field cron (local clock), scanned minute-by-minute."""
    parts = (expr or "").strip().split()
    if len(parts) < 5 or count <= 0:
        return []
    cursor = (from_dt or datetime.now()).replace(second=0, microsecond=0) + timedelta(minutes=1)
    out: list[datetime] = []
    max_scan = 366 * 24 * 60
    for _ in range(max_scan):
        if cron_matches_at(expr, cursor):
            out.append(cursor)
            if len(out) >= count:
                break
        cursor += timedelta(minutes=1)
    return out


def _format_time_fields(min_f: str, hour_f: str) -> str:
    def parse_list(f: str, lo: int, hi: int) -> list[int] | None:
        t = (f or "").strip()
        if not re.fullmatch(r"\d+(,\d+)*", t):
            return None
        arr = [int(x) for x in t.split(",") if x.isdigit() and lo <= int(x) <= hi]
        return arr or None

    mins = parse_list(min_f, 0, 59)
    hours = parse_list(hour_f, 0, 23)
    if not mins or not hours:
        return ""
    if len(mins) == 1 and len(hours) == 1:
        return f"{hours[0]:02d}:{mins[0]:02d}"
    if len(mins) == 1:
        mm = f"{mins[0]:02d}"
        return "、".join(f"{h:02d}:{mm}" for h in hours)
    if len(hours) == 1:
        hh = f"{hours[0]:02d}"
        return "、".join(f"{hh}:{m:02d}" for m in mins)
    parts: list[str] = []
    for h in hours:
        for m in mins:
            parts.append(f"{h:02d}:{m:02d}")
    return "、".join(parts)


def _format_dow_field(dow_f: str) -> str:
    days: list[int] = []
    for seg in (dow_f or "").split(","):
        p = seg.strip()
        if not p:
            continue
        if "-" in p:
            try:
                lo_s, hi_s = p.split("-", 1)
                lo, hi = int(lo_s), int(hi_s)
                for d in range(lo, hi + 1):
                    days.append(0 if d == 7 else d)
            except ValueError:
                continue
            continue
        try:
            n = int(p)
        except ValueError:
            continue
        days.append(0 if n == 7 else n)
    uniq = sorted({d for d in days if 0 <= d <= 6}, key=lambda d: 7 if d == 0 else d)
    if not uniq:
        return ""
    if uniq == [1, 2, 3, 4, 5]:
        return "workdays"
    names = {0: "日", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六"}
    return "/".join(names[d] for d in uniq)


def cron_human_summary(expr: str) -> str:
    """Human-readable summary for a 5-field cron (local time semantics).

    Prefer short, user-facing phrases (每 2 小时 / 每天 10:00). Never leave
    raw cron as the primary label when a common pattern is recognized.
    """
    raw = (expr or "").strip()
    parts = raw.split()
    if len(parts) < 5:
        return raw or "未知"
    min_f, hour_f, dom_f, mon_f, dow_f = parts[0], parts[1], parts[2], parts[3], parts[4]

    def star(x: str) -> bool:
        return x in ("*", "?")

    def _minute0(mf: str) -> bool:
        return mf in ("0", "00")

    # */N * * * *  → 每 N 分钟
    min_step = re.fullmatch(r"\*/(\d+)", min_f)
    if min_step and star(hour_f) and star(dom_f) and star(mon_f) and star(dow_f):
        n = int(min_step.group(1))
        return "每分钟" if n <= 1 else f"每 {n} 分钟"

    # */N H-H * * *  → 每天 H–H 点每 N 分钟
    hour_span = re.fullmatch(r"(\d{1,2})-(\d{1,2})", hour_f)
    if min_step and hour_span and star(dom_f) and star(mon_f) and star(dow_f):
        n = int(min_step.group(1))
        lo, hi = int(hour_span.group(1)), int(hour_span.group(2))
        base = "每分钟" if n <= 1 else f"每 {n} 分钟"
        return f"{base}（{lo}–{hi} 点）"

    # 0 */N * * *  /  M */N * * *  → 每 N 小时
    hour_step = re.fullmatch(r"\*/(\d+)", hour_f)
    if hour_step and star(dom_f) and star(mon_f) and star(dow_f):
        n = int(hour_step.group(1))
        label = "每小时" if n <= 1 else f"每 {n} 小时"
        if _minute0(min_f) or min_f in ("*", "?"):
            return label
        if re.fullmatch(r"\d+", min_f):
            return f"{label}（第 {int(min_f):02d} 分）"
        return label

    # 0 H-H/N * * *  → 每 N 小时（H–H 点）
    hour_range_step = re.fullmatch(r"(\d{1,2})-(\d{1,2})/(\d+)", hour_f)
    if hour_range_step and star(dom_f) and star(mon_f) and star(dow_f):
        lo, hi, n = (
            int(hour_range_step.group(1)),
            int(hour_range_step.group(2)),
            int(hour_range_step.group(3)),
        )
        label = "每小时" if n <= 1 else f"每 {n} 小时"
        return f"{label}（{lo}–{hi} 点）"

    # 0 H-H * * *  → 每小时（H–H 点）
    if hour_span and star(dom_f) and star(mon_f) and star(dow_f):
        lo, hi = int(hour_span.group(1)), int(hour_span.group(2))
        if _minute0(min_f) or min_f in ("*", "?"):
            return f"每小时（{lo}–{hi} 点）"
        if re.fullmatch(r"\d+", min_f):
            return f"每小时（{lo}–{hi} 点 · 第 {int(min_f):02d} 分）"
        return f"每小时（{lo}–{hi} 点）"

    # 0 * * * * / M * * * * → 每小时
    if star(hour_f) and star(dom_f) and star(mon_f) and star(dow_f):
        if re.fullmatch(r"\d+(,\d+)*", min_f):
            mins = [int(x) for x in min_f.split(",")]
            if len(mins) == 1 and mins[0] == 0:
                return "每小时"
            if len(mins) == 1:
                return f"每小时第 {mins[0]:02d} 分"
            return "每小时第 " + "、".join(f"{m:02d}" for m in mins) + " 分"
        return "每小时"

    time_label = _format_time_fields(min_f, hour_f)
    if not time_label:
        return "按计划自动上班"

    if star(dom_f) and star(mon_f) and not star(dow_f):
        dow_label = _format_dow_field(dow_f)
        if dow_label == "workdays":
            return f"工作日 {time_label}"
        if dow_label:
            return f"每周 ({dow_label}) {time_label}"
    if star(dom_f) and star(mon_f) and star(dow_f):
        return f"每天 {time_label}"
    return f"{time_label} · 自定义计划"


def cron_to_rrule(cron_expr: str) -> dict[str, Any]:
    raw = (cron_expr or "").strip()
    if not raw:
        return {"rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=9", "scheduled_at": ""}
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        return {"rrule": "", "scheduled_at": raw}
    kw = raw.lower().strip()
    if kw in ("@hourly", "每小时"):
        return {"rrule": "FREQ=HOURLY;INTERVAL=1", "scheduled_at": ""}
    if kw in ("@daily", "每天", "daily"):
        return {"rrule": "FREQ=DAILY;INTERVAL=1", "scheduled_at": ""}
    if kw in ("@weekly", "每周"):
        return {"rrule": "FREQ=WEEKLY;INTERVAL=1;BYDAY=SU", "scheduled_at": ""}

    minute, hour, dom, month, dow = _parse_cron_five(raw)
    _hour_step_match = re.fullmatch(r"\*/(\d+)", hour)
    if _hour_step_match and dom in ("*", "?") and month in ("*", "?") and dow in ("*", "?"):
        step = int(_hour_step_match.group(1))
        mf = minute.strip()
        try:
            by_minute = int(mf, 10) if mf not in ("*", "?") else 0
        except ValueError:
            by_minute = 0
        rrule = f"FREQ=HOURLY;INTERVAL={step}"
        if by_minute != 0:
            rrule += f";BYMINUTE={by_minute}"
        return {"rrule": rrule, "scheduled_at": ""}

    is_hourly_slot = hour in ("*", "?") and dom in ("*", "?") and month in ("*", "?") and (dow in ("*", "?"))
    if is_hourly_slot:
        mf = minute.strip()
        if mf in ("*", "?"):
            return {"rrule": "FREQ=HOURLY;INTERVAL=1", "scheduled_at": ""}
        if mf.isdigit() or re.fullmatch(r"\d{1,2}(,\d{1,2})*", mf):
            return {"rrule": f"FREQ=HOURLY;INTERVAL=1;BYMINUTE={mf}", "scheduled_at": ""}

    is_daily = hour != "*" and dom == "*" and month == "*" and (dow == "*" or dow == "?")
    if is_daily:
        # Keep multi-hour as cron-backed; rrule only approximates first hour for legacy readers.
        try:
            h = int(str(hour).split(",")[0], 10)
        except ValueError:
            h = 9
        try:
            m = 0 if minute == "*" else int(str(minute).split(",")[0], 10)
        except ValueError:
            m = 0
        rule = "FREQ=DAILY;INTERVAL=1"
        rule += f";BYHOUR={h}"
        if m != 0:
            rule += f";BYMINUTE={m}"
        return {"rrule": rule, "scheduled_at": ""}

    is_weekly = dow not in ("*", "?")
    if is_weekly:
        dow_map = {"0": "SU", "1": "MO", "2": "TU", "3": "WE", "4": "TH", "5": "FR", "6": "SA", "7": "SU"}
        days: list[str] = []
        for part in dow.split(","):
            p = part.strip()
            if "-" in p:
                try:
                    lo_s, hi_s = p.split("-", 1)
                    lo, hi = int(lo_s), int(hi_s)
                    for d in range(lo, hi + 1):
                        days.append(dow_map.get(str(d), str(d)))
                except ValueError:
                    days.append(p)
            else:
                days.append(dow_map.get(p, p))
        try:
            h = int(str(hour).split(",")[0], 10) if hour != "*" else 0
        except ValueError:
            h = 0
        try:
            m = 0 if minute == "*" else int(str(minute).split(",")[0], 10)
        except ValueError:
            m = 0
        rule = "FREQ=WEEKLY;INTERVAL=1"
        if days:
            # dedupe preserve order
            seen: set[str] = set()
            uniq_days: list[str] = []
            for d in days:
                if d not in seen:
                    seen.add(d)
                    uniq_days.append(d)
            rule += ";BYDAY=" + ",".join(uniq_days)
        rule += f";BYHOUR={h}"
        if m != 0:
            rule += f";BYMINUTE={m}"
        return {"rrule": rule, "scheduled_at": ""}

    try:
        dh = int(str(hour).split(",")[0], 10) if hour != "*" else 9
    except ValueError:
        dh = 9
    return {"rrule": f"FREQ=DAILY;INTERVAL=1;BYHOUR={dh}", "scheduled_at": ""}


def schedule_for_payload(args: dict[str, Any], rrule: str, scheduled_at: str, schedule_fallback: str) -> str:
    raw = str(args.get("schedule") or "").strip()
    if raw and is_five_field_cron_or_keyword(raw):
        return raw
    if scheduled_at:
        return scheduled_at
    return schedule_fallback or rrule


def preview_schedule(
    *,
    schedule: str = "",
    schedule_type: str = "",
    scheduled_at: str = "",
    rrule: str = "",
    count: int = 5,
) -> dict[str, Any]:
    """Normalize schedule input and return summary + next runs (same matching as Gateway runner)."""
    sched = (schedule or "").strip()
    sat = (scheduled_at or "").strip()
    st = (schedule_type or "").strip().lower()
    rr = (rrule or "").strip()

    # Once: datetime-like
    if st == "once" or (sat and not is_five_field_cron_or_keyword(sched)):
        once_raw = sat or sched
        if re.match(r"^\d{4}-\d{2}-\d{2}", once_raw):
            try:
                # accept "YYYY-MM-DDTHH:MM" / with seconds / space
                normalized = once_raw.replace(" ", "T")
                if len(normalized) == 16:
                    normalized += ":00"
                dt = datetime.fromisoformat(normalized)
            except ValueError:
                return {
                    "ok": False,
                    "error": "无法解析一次性时间",
                    "schedule_type": "once",
                    "scheduled_at": once_raw,
                    "schedule": once_raw,
                    "cron": "",
                    "rrule": "",
                    "summary": "",
                    "next_runs": [],
                }
            return {
                "ok": True,
                "schedule_type": "once",
                "scheduled_at": once_raw[:16] if "T" in once_raw.replace(" ", "T") else once_raw,
                "schedule": once_raw,
                "cron": "",
                "rrule": "",
                "summary": f"一次性: {dt.strftime('%Y-%m-%d %H:%M')}",
                "next_runs": [dt.isoformat(timespec="minutes")],
            }

    if is_five_field_cron_or_keyword(sched):
        conv = cron_to_rrule(sched)
        runs = next_cron_runs(sched, count=max(1, min(int(count or 5), 20)))
        return {
            "ok": True,
            "schedule_type": "recurring",
            "scheduled_at": "",
            "schedule": sched,
            "cron": sched,
            "rrule": str(conv.get("rrule") or ""),
            "summary": cron_human_summary(sched),
            "next_runs": [d.isoformat(timespec="minutes") for d in runs],
        }

    if rr and "FREQ=" in rr.upper():
        # Best-effort: cannot reliably expand all RRULEs here; surface as opaque.
        return {
            "ok": True,
            "schedule_type": "recurring",
            "scheduled_at": "",
            "schedule": sched or rr,
            "cron": sched if is_five_field_cron_or_keyword(sched) else "",
            "rrule": rr,
            "summary": rr,
            "next_runs": [],
            "warning": "仅含 RRULE 时无法预览下次运行；请提供 5 段 cron",
        }

    return {
        "ok": False,
        "error": "请提供 5 段 Cron 或一次性时间",
        "schedule_type": st or "recurring",
        "scheduled_at": sat,
        "schedule": sched,
        "cron": "",
        "rrule": rr,
        "summary": "",
        "next_runs": [],
    }


def schedule_summary_for_task(task: dict[str, Any]) -> str:
    """Card/list summary for a stored automation row — never expose raw RRULE."""
    st = str(task.get("schedule_type") or "").strip().lower()
    sat = str(task.get("scheduled_at") or "").strip()
    sched = str(task.get("schedule") or "").strip()
    if st == "once" or (sat and not is_five_field_cron_or_keyword(sched)):
        return f"一次性: {sat or sched or '?'}"
    if is_five_field_cron_or_keyword(sched):
        return cron_human_summary(sched)
    rr = str(task.get("rrule") or "").strip()
    if "FREQ=" in sched.upper():
        rr = sched
    if rr and "FREQ=" in rr.upper():
        cron = rrule_to_cron(rr)
        if is_five_field_cron_or_keyword(cron):
            return cron_human_summary(cron)
        return rrule_human_summary(rr)
    return cron_human_summary(sched) if sched else "未知"


def rrule_to_cron(rrule_str: str) -> str:
    """Best-effort RRULE → 5-field cron (local-time semantics used by Gateway runner)."""
    r = (rrule_str or "").strip()
    if not r:
        return ""
    # Accept both ``FREQ=…`` and ``RRULE:FREQ=…`` / ``rrule:FREQ=…``.
    if ":" in r.split(";", 1)[0] and "FREQ=" in r.upper():
        head, _, rest = r.partition(":")
        if "FREQ=" not in head.upper() and rest.strip():
            r = rest.strip()
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
        hour = int(str(parts.get("BYHOUR", "9")).split(",")[0])
    except ValueError:
        hour = 9
    try:
        minute = int(str(parts.get("BYMINUTE", "0")).split(",")[0])
    except ValueError:
        minute = 0
    byday = parts.get("BYDAY", "")
    dow_map = {"SU": "0", "MO": "1", "TU": "2", "WE": "3", "TH": "4", "FR": "5", "SA": "6"}
    if freq == "HOURLY":
        return f"{minute} */{interval} * * *" if interval > 1 else f"{minute} * * * *"
    if freq == "DAILY":
        if byday:
            nums = ",".join(dow_map.get(d.strip(), "?") for d in byday.split(",") if d.strip())
            if nums and "?" not in nums:
                return f"{minute} {hour} * * {nums}"
        return f"{minute} {hour} * * *"
    if freq == "WEEKLY":
        if byday:
            nums = ",".join(dow_map.get(d.strip(), "?") for d in byday.split(",") if d.strip())
            if nums and "?" not in nums:
                return f"{minute} {hour} * * {nums}"
        return f"{minute} {hour} * * 1"
    return ""


def rrule_human_summary(rrule_str: str) -> str:
    """Natural-language summary for common RRULE shapes (e.g. FREQ=DAILY;BYHOUR=9 → 每天 09:00)."""
    cron = rrule_to_cron(rrule_str)
    if is_five_field_cron_or_keyword(cron):
        return cron_human_summary(cron)
    r = (rrule_str or "").strip().upper()
    if not r:
        return "未知"
    parts: dict[str, str] = {}
    for seg in r.split(";"):
        if "=" not in seg:
            continue
        k, _, v = seg.partition("=")
        parts[k.strip()] = v.strip()
    freq = parts.get("FREQ", "")
    try:
        hour = int(str(parts.get("BYHOUR", "9")).split(",")[0])
    except ValueError:
        hour = 9
    try:
        minute = int(str(parts.get("BYMINUTE", "0")).split(",")[0])
    except ValueError:
        minute = 0
    time_label = f"{hour:02d}:{minute:02d}"
    if freq == "DAILY":
        return f"每天 {time_label}"
    if freq == "HOURLY":
        return "每小时"
    if freq == "WEEKLY":
        return f"每周 {time_label}"
    return "周期性任务"


def enrich_automation_for_api(task: dict[str, Any], *, latest_run: dict[str, Any] | None = None) -> dict[str, Any]:
    """Attach schedule_summary / next_run / last_run fields for EvoPanel cards."""
    row = dict(task)
    sched = str(row.get("schedule") or "").strip()
    # Prefer 5-field cron; if schedule is RRULE-only, derive cron for display/runner hints
    if not is_five_field_cron_or_keyword(sched):
        rr = str(row.get("rrule") or "").strip()
        if "FREQ=" in sched.upper():
            rr = sched
        derived = rrule_to_cron(rr) if rr else ""
        if is_five_field_cron_or_keyword(derived):
            row["schedule_cron"] = derived
        else:
            row["schedule_cron"] = ""
    else:
        row["schedule_cron"] = sched

    row["schedule_summary"] = schedule_summary_for_task(row)

    pv = preview_schedule(
        schedule=str(row.get("schedule_cron") or row.get("schedule") or ""),
        schedule_type=str(row.get("schedule_type") or ""),
        scheduled_at=str(row.get("scheduled_at") or ""),
        rrule="",
        count=1,
    )
    next_runs = pv.get("next_runs") if isinstance(pv, dict) else None
    row["next_run_at"] = (next_runs[0] if isinstance(next_runs, list) and next_runs else "") or ""
    row["schedule_ok"] = bool(isinstance(pv, dict) and pv.get("ok"))

    last = latest_run if isinstance(latest_run, dict) else None
    if last is None:
        # fall back to scalar fields on the document
        row["last_run_at"] = str(row.get("last_run") or "")
        row["last_run_status"] = str(row.get("last_status") or "")
        row["last_run_duration_seconds"] = None
        row["last_run_error"] = ""
        row["has_active_run"] = False
    else:
        st = str(last.get("status") or "").strip().lower()
        row["last_run_at"] = str(last.get("started_at") or last.get("created_at") or "")
        row["last_run_status"] = st
        try:
            row["last_run_duration_seconds"] = int(last.get("duration_seconds") or 0)
        except (TypeError, ValueError):
            row["last_run_duration_seconds"] = 0
        row["last_run_error"] = str(last.get("error") or "")
        row["has_active_run"] = st in ("running", "queued", "pending", "in_progress")

    return row
