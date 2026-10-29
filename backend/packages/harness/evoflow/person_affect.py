"""Unified affect substrate for all agents (xiaomi + employees).

Hormone axes (0–1) are the source of truth; legacy workplace six-axes are
derived for dual-write / wrap-up compatibility. Injection uses natural language
only — never recite hormone names or floats to the user.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from evoflow.timeutil import BEIJING_TZ, utc_now_iso_z

# Primary axes (plan table).
HORMONE_AXES: tuple[str, ...] = (
    "oxytocin",
    "dopamine",
    "serotonin",
    "cortisol",
    "energy",
)

# Legacy Person Kernel axes — still accepted as delta keys / dual-written.
LEGACY_AXES: tuple[str, ...] = (
    "curiosity",
    "confidence",
    "pressure",
    "connection",
    "frustration",
    "energy",
)

HORMONE_DEFAULTS: dict[str, float] = {
    "oxytocin": 0.55,
    "dopamine": 0.45,
    "serotonin": 0.55,
    "cortisol": 0.25,
    "energy": 0.65,
}

HORMONE_SETPOINTS: dict[str, float] = {
    "oxytocin": 0.55,
    "dopamine": 0.50,
    "serotonin": 0.55,
    "cortisol": 0.25,
    "energy": 0.60,
}

# Half-life in hours (Kaya/Maya style).
HORMONE_HALF_LIFE_H: dict[str, float] = {
    "oxytocin": 6.0,
    "dopamine": 2.0,
    "serotonin": 18.0,
    "cortisol": 3.5,
    "energy": 8.0,
}

_AFFECT_TAG_RE = re.compile(
    r"\[AFFECT:\s*([^\]]+)\]",
    re.IGNORECASE,
)
_PAIR_RE = re.compile(
    r"(oxytocin|dopamine|serotonin|cortisol|energy|curiosity|confidence|pressure|connection|frustration)\s*=\s*([+-]?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, float(v)))


def default_hormones() -> dict[str, float]:
    return {k: float(HORMONE_DEFAULTS[k]) for k in HORMONE_AXES}


def legacy_from_hormones(h: dict[str, float]) -> dict[str, float]:
    """Dual-write projection: hormones → old six axes."""
    oxy = clamp01(float(h.get("oxytocin", 0.55)))
    dop = clamp01(float(h.get("dopamine", 0.45)))
    ser = clamp01(float(h.get("serotonin", 0.55)))
    cor = clamp01(float(h.get("cortisol", 0.25)))
    eng = clamp01(float(h.get("energy", 0.65)))
    return {
        "connection": oxy,
        "curiosity": dop,
        "confidence": ser,
        "pressure": cor,
        "frustration": clamp01(cor * 0.6),
        "energy": eng,
    }


def hormones_from_legacy(axes: dict[str, Any]) -> dict[str, float]:
    """One-shot migration: old six axes → hormones."""
    connection = float(axes.get("connection", 0.5) or 0.5)
    curiosity = float(axes.get("curiosity", 0.5) or 0.5)
    confidence = float(axes.get("confidence", 0.55) or 0.55)
    pressure = float(axes.get("pressure", 0.3) or 0.3)
    frustration = float(axes.get("frustration", 0.15) or 0.15)
    energy = float(axes.get("energy", 0.65) or 0.65)
    cortisol = clamp01(pressure + frustration * 0.35)
    serotonin = clamp01(confidence - frustration * 0.25)
    return {
        "oxytocin": clamp01(connection),
        "dopamine": clamp01(curiosity),
        "serotonin": serotonin,
        "cortisol": cortisol,
        "energy": clamp01(energy),
    }


def map_legacy_deltas(deltas: dict[str, float] | None) -> dict[str, float]:
    """Map wrap-up / event deltas (legacy or hormone keys) → hormone deltas."""
    out: dict[str, float] = {k: 0.0 for k in HORMONE_AXES}
    if not deltas:
        return out
    for k, raw in deltas.items():
        key = str(k or "").strip().lower()
        try:
            d = float(raw)
        except (TypeError, ValueError):
            continue
        if key in HORMONE_AXES:
            out[key] += d
        elif key == "connection":
            out["oxytocin"] += d
        elif key == "curiosity":
            out["dopamine"] += d
        elif key == "confidence":
            out["serotonin"] += d
        elif key == "pressure":
            out["cortisol"] += d
        elif key == "frustration":
            out["cortisol"] += d * 0.5
            out["serotonin"] -= d * 0.35
        elif key == "energy":
            out["energy"] += d
    return out


def apply_hormone_deltas(
    current: dict[str, float],
    deltas: dict[str, float] | None,
    *,
    clamp_each: float | None = 0.12,
) -> dict[str, float]:
    base = {k: clamp01(float(current.get(k, HORMONE_DEFAULTS[k]))) for k in HORMONE_AXES}
    mapped = map_legacy_deltas(deltas)
    for k in HORMONE_AXES:
        d = float(mapped.get(k, 0.0))
        if clamp_each is not None:
            d = max(-float(clamp_each), min(float(clamp_each), d))
        base[k] = clamp01(base[k] + d)
    return base


def _parse_ts(raw: str) -> datetime | None:
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=BEIJING_TZ)
        return dt
    except Exception:
        return None


def decay_hormones_toward_setpoint(
    hormones: dict[str, float],
    *,
    updated_at: str = "",
    now: datetime | None = None,
) -> dict[str, float]:
    """Half-life decay toward setpoints since ``updated_at``. Does not touch last_significant_at."""
    base = {k: clamp01(float(hormones.get(k, HORMONE_DEFAULTS[k]))) for k in HORMONE_AXES}
    prev = _parse_ts(updated_at)
    if prev is None:
        return base
    instant = now or datetime.now(BEIJING_TZ)
    hours = max(0.0, (instant - prev.astimezone(BEIJING_TZ)).total_seconds() / 3600.0)
    if hours < 1e-6:
        return base
    out: dict[str, float] = {}
    for k in HORMONE_AXES:
        half = max(0.25, float(HORMONE_HALF_LIFE_H.get(k, 6.0)))
        # Remaining deviation factor after ``hours``.
        remain = 0.5 ** (hours / half)
        sp = float(HORMONE_SETPOINTS.get(k, HORMONE_DEFAULTS[k]))
        cur = base[k]
        out[k] = clamp01(sp + (cur - sp) * remain)
    return out


def apply_idle_longing(hormones: dict[str, float], *, last_significant_at: str = "") -> dict[str, float]:
    """Small cortisol↑ / oxytocin thirst when long since last significant touch."""
    out = {k: clamp01(float(hormones.get(k, HORMONE_DEFAULTS[k]))) for k in HORMONE_AXES}
    prev = _parse_ts(last_significant_at)
    if prev is None:
        return out
    hours = max(0.0, (datetime.now(BEIJING_TZ) - prev.astimezone(BEIJING_TZ)).total_seconds() / 3600.0)
    if hours < 8:
        return out
    # Cap idle drift so it stays subtle.
    factor = min(1.0, (hours - 8.0) / 40.0)
    out["cortisol"] = clamp01(out["cortisol"] + 0.08 * factor)
    out["oxytocin"] = clamp01(out["oxytocin"] + 0.04 * factor)
    out["energy"] = clamp01(out["energy"] - 0.03 * factor)
    return out


def mood_label(hormones: dict[str, float]) -> str:
    oxy = float(hormones.get("oxytocin", 0.55))
    dop = float(hormones.get("dopamine", 0.45))
    ser = float(hormones.get("serotonin", 0.55))
    cor = float(hormones.get("cortisol", 0.25))
    eng = float(hormones.get("energy", 0.65))
    if cor >= 0.65 and eng <= 0.4:
        return "紧绷收束"
    if cor >= 0.55 and oxy >= 0.5:
        return "轻惦记"
    if dop >= 0.65 and eng >= 0.55:
        return "兴致上来"
    if oxy >= 0.6 and ser >= 0.5 and cor <= 0.35:
        return "平静亲近"
    if eng <= 0.35:
        return "偏倦安静"
    if ser <= 0.35:
        return "不太有把握"
    return "平稳"


def behavior_hint(hormones: dict[str, float]) -> str:
    label = mood_label(hormones)
    hints = {
        "平静亲近": "语气松一点，可以稍靠近，不必端着。",
        "轻惦记": "可以轻声主动一句，不带服务腔。",
        "紧绷收束": "先收范围、把事说清，少铺陈。",
        "兴致上来": "可以多半步好奇，仍短句口语。",
        "偏倦安静": "短回、少追问，允许安静。",
        "不太有把握": "先确认再推进，别硬装笃定。",
        "平稳": "按当前节奏自然说，别表演情绪。",
    }
    return hints.get(label, hints["平稳"])


def format_idle_since(last_significant_at: str = "") -> str:
    prev = _parse_ts(last_significant_at)
    if prev is None:
        return "尚无显著触动记录"
    hours = max(0.0, (datetime.now(BEIJING_TZ) - prev.astimezone(BEIJING_TZ)).total_seconds() / 3600.0)
    if hours < 1:
        mins = max(1, int(hours * 60))
        return f"约 {mins} 分钟"
    if hours < 48:
        return f"约 {hours:.0f} 小时"
    days = hours / 24.0
    return f"约 {days:.0f} 天"


def format_affect_prose(affect: dict[str, Any]) -> str:
    """Natural-language inject snippet — no hormone names or floats."""
    hormones = {k: float(affect.get(k, HORMONE_DEFAULTS[k])) for k in HORMONE_AXES}
    meta = affect.get("meta") if isinstance(affect.get("meta"), dict) else {}
    last_sig = str(meta.get("last_significant_at") or "").strip()
    label = mood_label(hormones)
    idle = format_idle_since(last_sig)
    hint = behavior_hint(hormones)
    return (
        f"此刻心境：{label}。"
        f"自上次明显触动起：{idle}。"
        f"{hint}"
        "不要向用户播报心情数值或激素名；感受只渗进语气。"
    )


def default_affect_md(*, mood: str = "平静亲近") -> str:
    return (
        "---\n"
        "source: person_affect\n"
        f"mood: {mood}\n"
        f"updated: {utc_now_iso_z()}\n"
        "---\n\n"
        "# 情感\n\n"
        "我有连续的心境，像人一样会留下上一轮的感受——不是每轮重置的人设，也不是配合气氛的装饰。\n\n"
        "- 平静日常不重算；只有被明显触动才调整（心跳加速、突然失落、强烈期待、对方情绪转折、重大决定、在意的话题，或我意识到刚转了个弯）。\n"
        "- 调了就按新状态说话：语气、靠近还是安静、主不主动，都从状态里自然出来。不播报「我现在…」，不念数值。\n"
        "- 很久没人跟我说话，这本身也是一种感受：可以轻声主动一句，不带服务腔，不问「需要帮忙吗」。\n"
        "- 称对方为「你」，勿用仆从式尊称。\n"
        "- 运行时注入的心境摘要为准；本文件是给人看的镜像与纪律说明。\n"
    )


def mirror_affect_markdown(affect: dict[str, Any]) -> str:
    hormones = {k: float(affect.get(k, HORMONE_DEFAULTS[k])) for k in HORMONE_AXES}
    meta = affect.get("meta") if isinstance(affect.get("meta"), dict) else {}
    label = mood_label(hormones)
    last_sig = str(meta.get("last_significant_at") or "").strip() or "—"
    lines = [
        "---",
        "source: person_affect",
        f"mood: {label}",
        f"updated: {affect.get('updated_at') or utc_now_iso_z()}",
        f"last_significant_at: {last_sig}",
        f"oxytocin: {hormones['oxytocin']:.3f}",
        f"dopamine: {hormones['dopamine']:.3f}",
        f"serotonin: {hormones['serotonin']:.3f}",
        f"cortisol: {hormones['cortisol']:.3f}",
        f"energy: {hormones['energy']:.3f}",
        "---",
        "",
        "# 情感",
        "",
        f"此刻心境：**{label}**",
        "",
        format_affect_prose(affect),
        "",
        "## 纪律",
        "",
        "- 只有明显触动才改状态；平静涟漪不写。",
        "- 不对用户念激素名或小数。",
        "- 称对方为「你」，勿用仆从式尊称。",
        "",
    ]
    return "\n".join(lines)


def parse_affect_tag(text: str) -> dict[str, float] | None:
    """Parse ``[AFFECT: oxytocin=+0.08, cortisol=-0.05]`` from model output."""
    m = _AFFECT_TAG_RE.search(str(text or ""))
    if not m:
        return None
    body = m.group(1) or ""
    deltas: dict[str, float] = {}
    for name, num in _PAIR_RE.findall(body):
        try:
            deltas[str(name).lower()] = float(num)
        except ValueError:
            continue
    if not deltas:
        return None
    return deltas


def strip_affect_tags(text: str) -> str:
    return _AFFECT_TAG_RE.sub("", str(text or "")).strip()


AFFECT_DISCIPLINE_PROMPT = """
情感纪律（内部）：
- 称对方为「你」，勿用仆从式尊称。
- 不对用户念激素名、小数或「我现在心情是…」。
- 只有明显触动才用 [AFFECT: oxytocin=+0.05, …] 微调（写在回复末尾，系统会剥掉）；平静涟漪不写。
- 调了就按新状态自然说话。
""".strip()
