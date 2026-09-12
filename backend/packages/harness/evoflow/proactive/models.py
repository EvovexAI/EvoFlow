"""Data models for the proactive (embodied AI) module.

Pure dataclasses / enums - no I/O, no DB.  Persistence lives in
``repositories.py``.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any

# ── Enums ──────────────────────────────────────────────────────────────


class ProactiveAutonomyLevel(str, Enum):
    """How much freedom a role has to act without human approval."""

    FULL_AUTO = "full_auto"  # autonomous except critical
    APPROVAL_FOR_RISKY = "approval_for_risky"  # approve medium+
    APPROVAL_FOR_ALL = "approval_for_all"  # approve everything


class InitiativeActionType(str, Enum):
    """What kind of action the initiative proposes."""

    CODE_CHANGE = "code_change"
    ANALYSIS = "analysis"
    REPORT = "report"
    TASK_DELEGATION = "task_delegation"
    ALERT = "alert"
    OPTIMIZATION = "optimization"


class InitiativeRiskLevel(str, Enum):
    """Risk assessment for an initiative."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class InitiativeStatus(str, Enum):
    """Lifecycle of an initiative."""

    PROPOSED = "proposed"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT_REJECTED = "timeout_rejected"
    SKIPPED = "skipped"  # auto-skipped (e.g. duplicate)


class ApprovalStatus(str, Enum):
    """Human decision status."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    TIMEOUT = "timeout"
    ESCALATED = "escalated"


# ── Risk × Autonomy matrix ────────────────────────────────────────────

# Returns True if the initiative needs human approval.
_RISK_ORDER = {
    InitiativeRiskLevel.LOW: 0,
    InitiativeRiskLevel.MEDIUM: 1,
    InitiativeRiskLevel.HIGH: 2,
    InitiativeRiskLevel.CRITICAL: 3,
}

# Thresholds: initiatives at or above this risk need approval.
_AUTONOMY_THRESHOLD = {
    ProactiveAutonomyLevel.FULL_AUTO: InitiativeRiskLevel.CRITICAL,
    ProactiveAutonomyLevel.APPROVAL_FOR_RISKY: InitiativeRiskLevel.MEDIUM,
    ProactiveAutonomyLevel.APPROVAL_FOR_ALL: InitiativeRiskLevel.LOW,
}


def needs_approval(
    risk: InitiativeRiskLevel | str,
    autonomy: ProactiveAutonomyLevel | str,
) -> bool:
    """Whether a given risk level triggers approval for this autonomy level."""
    r = InitiativeRiskLevel(risk) if not isinstance(risk, InitiativeRiskLevel) else risk
    a = (
        ProactiveAutonomyLevel(autonomy)
        if not isinstance(autonomy, ProactiveAutonomyLevel)
        else autonomy
    )
    threshold = _AUTONOMY_THRESHOLD[a]
    return _RISK_ORDER[r] >= _RISK_ORDER[threshold]


# ── Dataclasses ───────────────────────────────────────────────────────


@dataclass
class ProactiveRoleConfig:
    """Configuration embedded in ``ProactiveRole.config_json``."""

    responsibilities: list[str] = field(default_factory=list)
    # Bound local workspace root — primary jurisdiction for think/execute tools.
    workspace_path: str = ""
    # Optional focus paths/modules inside the workspace (relative snippets).
    domain_scope: list[str] = field(default_factory=list)
    # Bound Knowledge Vault ids (multi). Injected into duty system prompt when set.
    knowledge_vault_ids: list[str] = field(default_factory=list)
    # Free-text strings and/or structured dicts (name/target/probe/…).
    kpis: list[Any] = field(default_factory=list)
    # Default: human must approve before any initiative executes.
    autonomy_level: ProactiveAutonomyLevel = ProactiveAutonomyLevel.APPROVAL_FOR_ALL
    max_initiatives_per_cycle: int = 3
    risk_threshold: InitiativeRiskLevel = InitiativeRiskLevel.MEDIUM
    approval_channels: list[str] = field(default_factory=lambda: ["desktop", "feishu"])
    approval_timeout_minutes: int = 30
    soul_md: str = ""
    # Phase 2: agent-loop think configuration
    think_mode: str = "agent_loop"  # "agent_loop" | "prompt_only"
    # Override model for this role's patrol / execute (empty = agent default / app primary)
    model_name: str = ""
    max_turns: int = 10
    # 0 / 未配置 = 不设 wall-clock 上限（无限等待，受 recursion_limit 保护）；显式配置则限制。
    timeout_seconds: int = 0
    tool_groups: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    # Optional: extra context injected into the think prompt (e.g. recent CI logs)
    extra_context: dict[str, Any] = field(default_factory=dict)
    # ── Work schedule (上班时间) ────────────────────────────────
    # When enabled, the runner only works during [work_start_hour, work_end_hour).
    # Default: 09:00 ~ 20:00 local time.
    work_schedule_enabled: bool = True
    work_start_hour: int = 9   # inclusive (local hour, 0-23)
    work_end_hour: int = 20    # exclusive (local hour, 0-23)

    # ── Approval timeouts by action type (minutes) ────────────
    # When non-empty, overrides ``approval_timeout_minutes`` per action_type.
    # Recommended: analysis/report=120, code_change=1440, optimization=1440,
    # alert=60, task_delegation=240.  Empty = use flat approval_timeout_minutes.
    approval_timeout_by_type: dict[str, int] = field(default_factory=dict)

    # ── Daily cost budget (USD) ───────────────────────────────
    # When > 0, the runner pauses the role if daily cost exceeds this.
    # 0 = unlimited (no budget enforcement).
    daily_budget_usd: float = 0.0
    # Soft per-patrol budget (USD). 0 = unlimited. When a finished round's cost
    # exceeds this, notify and optionally pause per budget_exceed_policy.
    per_run_budget_usd: float = 0.0
    # When daily (or per-run) budget is exceeded:
    #   skip_patrol — skip auto/manual patrol until next day (default)
    #   pause_role  — skip and set role status to paused
    #   notify_only — notify but still allow the run
    budget_exceed_policy: str = "skip_patrol"

    # When True, scheduled heartbeat ticks skip this role until resume (stop-work / 停止值班).
    # Distinct from status=paused (请假): stop keeps 在岗 badge but blocks auto patrol.
    auto_patrol_suspended: bool = False

    # Direct manager in the org chart (agent_code). Empty = top-level / unset.
    reports_to: str = ""

    # ── Per-employee Feishu PersonalAgent binding (QR scan) ──
    # Same credentials shape as settings IM scan; synced to channels.feishu.accounts.
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    feishu_open_id: str = ""
    feishu_bound_at: str = ""
    # Persist self-intro delivery so restarts / rebinds do not spam.
    # Keys: "open_id:<id>" or "chat_id:<id>" → ISO timestamp of last successful send.
    feishu_intro_sent: dict[str, str] = field(default_factory=dict)
    # Timestamp when the self-introduction was last sent to this employee's
    # Feishu private chat (open_id). Empty = not yet sent. Non-empty = sent at
    # that ISO timestamp; the value is updated on every successful send so a
    # re-bind (same open_id) after an unbind will still send a fresh intro.
    feishu_intro_sent_at: str = ""

    # ── Validation constants ────────────────────────────────────
    # approval_timeout_by_type: 1 min ~ 1 week (10080 min)
    APPROVAL_TIMEOUT_MIN_MINUTES = 1
    APPROVAL_TIMEOUT_MAX_MINUTES = 10080

    def to_json(self) -> str:
        d = asdict(self)
        d["autonomy_level"] = self.autonomy_level.value
        d["risk_threshold"] = self.risk_threshold.value
        return json.dumps(d, ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str | dict | None) -> ProactiveRoleConfig:
        if not raw:
            return cls()
        d = raw if isinstance(raw, dict) else json.loads(raw)
        # Normalize enums
        al = d.get("autonomy_level")
        if isinstance(al, str):
            d["autonomy_level"] = ProactiveAutonomyLevel(al)
        rt = d.get("risk_threshold")
        if isinstance(rt, str):
            d["risk_threshold"] = InitiativeRiskLevel(rt)
        # LOW-003: warn on unknown fields (was silent drop)
        import logging as _log

        _logger = _log.getLogger(__name__)
        unknown = [k for k in d.keys() if k not in cls.__dataclass_fields__]
        if unknown:
            _logger.warning(
                "ProactiveRoleConfig.from_json: ignoring unknown fields: %s",
                ", ".join(sorted(unknown)),
            )
        valid = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        # Normalize vault ids to a de-duplicated string list
        if "knowledge_vault_ids" in valid:
            raw_ids = valid.get("knowledge_vault_ids") or []
            if isinstance(raw_ids, str):
                raw_ids = [raw_ids]
            seen: set[str] = set()
            cleaned: list[str] = []
            for item in raw_ids:
                vid = str(item or "").strip()
                if not vid or vid in seen:
                    continue
                seen.add(vid)
                cleaned.append(vid)
            valid["knowledge_vault_ids"] = cleaned
        if "feishu_intro_sent" in valid:
            raw_sent = valid.get("feishu_intro_sent") or {}
            cleaned_sent: dict[str, str] = {}
            if isinstance(raw_sent, dict):
                for k, v in raw_sent.items():
                    key = str(k or "").strip()
                    ts = str(v or "").strip()
                    if key and ts:
                        cleaned_sent[key] = ts
            valid["feishu_intro_sent"] = cleaned_sent
        if "budget_exceed_policy" in valid:
            pol = str(valid.get("budget_exceed_policy") or "skip_patrol").strip().lower()
            if pol not in ("skip_patrol", "pause_role", "notify_only"):
                pol = "skip_patrol"
            valid["budget_exceed_policy"] = pol
        # LOW-005: clamp approval_timeout_by_type values to [1, 10080] minutes
        if "approval_timeout_by_type" in valid:
            raw_map = valid.get("approval_timeout_by_type") or {}
            if isinstance(raw_map, dict):
                clamped: dict[str, int] = {}
                for k, v in raw_map.items():
                    try:
                        mins = int(v)
                        if mins < cls.APPROVAL_TIMEOUT_MIN_MINUTES:
                            mins = cls.APPROVAL_TIMEOUT_MIN_MINUTES
                        elif mins > cls.APPROVAL_TIMEOUT_MAX_MINUTES:
                            mins = cls.APPROVAL_TIMEOUT_MAX_MINUTES
                        clamped[str(k).strip()] = mins
                    except (TypeError, ValueError):
                        continue
                valid["approval_timeout_by_type"] = clamped
        return cls(**valid)


# Role lifecycle (O5.1): only ``active`` roles receive automatic patrols.
ROLE_STATUSES = frozenset({"active", "paused", "archived", "draft"})


def normalize_role_status(status: str | None, *, default: str = "active") -> str:
    s = str(status or "").strip().lower() or default
    if s not in ROLE_STATUSES:
        raise ValueError(f"Invalid role status: {status!r} (expected one of {sorted(ROLE_STATUSES)})")
    return s


@dataclass
class ProactiveRole:
    """A single embodied AI role (a job-position owner).

    ``agent_code`` is the employee (Agent) code; ``position_code`` is the
    job-position code (1:N - the same position may be held by multiple
    employees). ``role_name`` is the display name (Chinese) for UI only.
    """

    agent_code: str
    role_name: str
    position_code: str = ""
    department: str = ""
    config: ProactiveRoleConfig = field(default_factory=ProactiveRoleConfig)
    heartbeat_rrule: str = "FREQ=HOURLY;INTERVAL=2"
    # Authoritative 5-field cron (same semantics as automation tasks).
    heartbeat_schedule: str = ""
    status: str = "active"  # active / paused / archived / draft
    last_heartbeat_at: str | None = None
    next_heartbeat_at: str | None = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class Initiative:
    """A single AI-proposed action."""

    id: str
    role_agent_code: str
    title: str
    description: str
    rationale: str = ""
    action_type: InitiativeActionType = InitiativeActionType.ANALYSIS
    risk_level: InitiativeRiskLevel = InitiativeRiskLevel.LOW
    action_plan: dict[str, Any] = field(default_factory=dict)
    expected_outcome: str = ""
    status: InitiativeStatus = InitiativeStatus.PROPOSED
    approval_id: str | None = None
    approved_by: str | None = None
    approved_at: str | None = None
    approval_timeout_minutes: int = 30
    execution_thread_id: str | None = None
    execution_result: str | None = None
    # Phase 2: round tracking + goal/outcome
    round_id: str | None = None
    goal: str = ""
    outcome: str = ""
    created_at: str = ""
    updated_at: str = ""

    def needs_approval(self) -> bool:
        return needs_approval(self.risk_level, self.config_autonomy_level)

    # Convenience for needs_approval; set by engine when loading.
    config_autonomy_level: ProactiveAutonomyLevel = ProactiveAutonomyLevel.APPROVAL_FOR_RISKY


@dataclass
class Approval:
    """A human decision gate entry."""

    id: str
    initiative_id: str = ""  # legacy; empty when task_id is set
    role_agent_code: str = ""
    channel: str = "feishu"  # feishu / desktop / both
    feishu_message_id: str | None = None
    status: ApprovalStatus = ApprovalStatus.PENDING
    decided_by: str | None = None
    decided_at: str | None = None
    decision_comment: str = ""
    escalation_level: int = 0
    # User-provided reason when rejecting; used to improve AI proposal quality.
    rejection_reason: str = ""
    # Task-native work items (岗位工作项); preferred over initiative_id when set.
    task_id: str = ""
    created_at: str = ""
    updated_at: str = ""


@dataclass
class ProactiveMemory:
    """Per-role long-term memory persisted across heartbeat cycles."""

    role_agent_code: str
    observations: list[str] = field(default_factory=list)
    strategies: list[str] = field(default_factory=list)
    completed_initiatives: int = 0
    failed_initiatives: int = 0
    last_think_at: str = ""
    last_think_summary: str = ""
    focus_areas: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    # ── Size limits (prevent prompt blowup) ────────────────────
    MAX_FOCUS_AREAS = 50
    MAX_EXTRA_ENTRIES = 50
    MAX_OBSERVATIONS = 200
    MAX_STRATEGIES = 80

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, role_agent_code: str, raw: str | dict | None) -> ProactiveMemory:
        if not raw:
            return cls(role_agent_code=role_agent_code)
        d = raw if isinstance(raw, dict) else json.loads(raw)
        valid = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        valid["role_agent_code"] = role_agent_code
        # LOW-004: cap list/dict fields to prevent unbounded growth
        if isinstance(valid.get("focus_areas"), list):
            valid["focus_areas"] = [
                str(x).strip() for x in valid["focus_areas"] if str(x).strip()
            ][: cls.MAX_FOCUS_AREAS]
        if isinstance(valid.get("extra"), dict):
            items = list(valid["extra"].items())[: cls.MAX_EXTRA_ENTRIES]
            valid["extra"] = dict(items)
        if isinstance(valid.get("observations"), list):
            valid["observations"] = [
                str(x).strip() for x in valid["observations"] if str(x).strip()
            ][: cls.MAX_OBSERVATIONS]
        if isinstance(valid.get("strategies"), list):
            valid["strategies"] = [
                str(x).strip() for x in valid["strategies"] if str(x).strip()
            ][: cls.MAX_STRATEGIES]
        return cls(**valid)

    def summary(self, max_items: int = 5) -> str:
        """Compact text summary for injection into the think prompt.

        Dedupes identical lines across observations / strategies so a single
        rejection note is not printed twice under two headings.
        """
        parts: list[str] = []
        seen: set[str] = set()

        def _uniq(items: list[str]) -> list[str]:
            out: list[str] = []
            for raw in items[-max_items:]:
                text = str(raw or "").strip()
                if not text:
                    continue
                key = text[:80]
                if key in seen:
                    continue
                seen.add(key)
                out.append(text)
            return out

        obs = _uniq(list(self.observations or []))
        # Strategies after observations so shared rejection notes keep one slot.
        strats = _uniq(list(self.strategies or []))
        if obs:
            parts.append("近期观察：\n" + "\n".join(f"  - {o}" for o in obs))
        if strats:
            parts.append("策略方向：\n" + "\n".join(f"  - {s}" for s in strats))
        if self.focus_areas:
            parts.append("关注领域：" + ", ".join(self.focus_areas))
        think = str(self.last_think_summary or "").strip()
        if think and think[:80] not in seen:
            parts.append(f"上次思考总结：{think}")
        return "\n".join(parts) if parts else "（暂无历史记忆）"


# ── Think-result parsing ───────────────────────────────────────────────


@dataclass
class ThinkResult:
    """Parsed output from the LLM think cycle."""

    observations: list[str] = field(default_factory=list)
    initiatives: list[dict[str, Any]] = field(default_factory=list)
    reflection: str = ""
    goal: str = ""
    outcome: str = ""
    # Populated by the engine after initiatives are persisted (for the runner to act on).
    created_initiative_ids: list[str] = field(default_factory=list)
    # Agent-loop round key; empty for legacy prompt_only when no round tagged.
    round_id: str = ""
    # All initiative ids written this cycle (journal + actionable).
    round_initiative_ids: list[str] = field(default_factory=list)
    # Pending role work-item Task ids created this round (assigned_role stamped).
    created_task_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_llm_output(cls, raw: str) -> ThinkResult:
        """Parse LLM JSON for ``prompt_only`` mode (legacy single-shot path).

        Agent-loop mode must use ``proactive_submit_work`` instead of prose JSON.
        """
        text = str(raw or "").strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines)
        try:
            d = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return cls(reflection=str(raw or "")[:500])

        if not isinstance(d, dict):
            return cls(reflection=str(raw or "")[:500])

        obs = d.get("observations") or []
        inits = d.get("initiatives") or []
        refl = d.get("reflection") or ""

        if not isinstance(obs, list):
            obs = []
        if not isinstance(inits, list):
            inits = []
        return cls(
            observations=[str(o) for o in obs],
            initiatives=[i if isinstance(i, dict) else {} for i in inits],
            reflection=str(refl),
            goal=str(d.get("goal") or ""),
            outcome=str(d.get("outcome") or ""),
        )
