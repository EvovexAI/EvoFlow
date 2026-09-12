"""KPI classification + allowlisted builtin probes + duty performance reports (O6).

Builtin probes use argv + ``cwd=workspace`` + timeout (no ``shell=True``).
Arbitrary free-form ``metric_command`` strings are **not** executed.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from evoflow.proactive.models import ProactiveRole

logger = logging.getLogger(__name__)

# Free-text KPIs that look measurable (numbers / known metrics).
_MEASURABLE_HINTS = re.compile(
    r"(<|>|<=|>=|＝|=|\d+\s*%|\d+\s*s\b|error|eslint|coverage|lint|build|耗时|延迟|qps|通过率|零|0\s*error)",
    re.I,
)
_SUBJECTIVE_HINTS = re.compile(
    r"(美观|好看|体验好|合理|优雅|清晰|友好|质量高|正常|健康)",
    re.I,
)
_ESLINT_HINT = re.compile(r"eslint|lint\s*error|零\s*error|0\s*error", re.I)
_BUILD_HINT = re.compile(r"构建|build\s*(通过|成功|ok)|npm\s*run\s*build", re.I)
_PROBE_TIMEOUT = 45
_BUILTIN_PROBES = frozenset({"eslint_count", "build_ok", "file_exists"})
_BUILD_ARGV: dict[str, list[str]] = {
    "npm": ["npm", "run", "build", "--if-present"],
    "pnpm": ["pnpm", "run", "build", "--if-present"],
    "yarn": ["yarn", "run", "build"],
}


@dataclass
class KpiAssessment:
    name: str
    measurable: bool
    status: str = "unknown"  # pass|fail|unknown|unmeasurable
    detail: str = ""
    target: str = ""
    observed: str = ""
    probe: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "measurable": self.measurable,
            "status": self.status,
            "detail": self.detail,
            "target": self.target,
            "observed": self.observed,
            "probe": self.probe,
        }


@dataclass
class PerformanceReport:
    agent_code: str
    role_name: str
    days: int
    period_start: str = ""
    period_end: str = ""
    patrol_rounds: int = 0
    initiatives_total: int = 0
    completed: int = 0
    failed: int = 0
    pending_approval: int = 0
    approval_total: int = 0
    approval_approved: int = 0
    approval_rate: float = 0.0
    cost_usd: float = 0.0
    tokens: int = 0
    consecutive_noop: int = 0
    kpis: list[KpiAssessment] = field(default_factory=list)
    suggestion: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_code": self.agent_code,
            "role_name": self.role_name,
            "days": self.days,
            "period_start": self.period_start,
            "period_end": self.period_end,
            "patrol_rounds": self.patrol_rounds,
            "initiatives": {
                "total": self.initiatives_total,
                "completed": self.completed,
                "failed": self.failed,
                "pending_approval": self.pending_approval,
            },
            "approvals": {
                "total": self.approval_total,
                "approved": self.approval_approved,
                "approval_rate": self.approval_rate,
            },
            "cost_usd": self.cost_usd,
            "tokens": self.tokens,
            "consecutive_noop": self.consecutive_noop,
            "kpis": [k.to_dict() for k in self.kpis],
            "suggestion": self.suggestion,
        }


def classify_kpi_text(text: str) -> KpiAssessment:
    name = str(text or "").strip()
    if not name:
        return KpiAssessment(name="（空）", measurable=False, status="unmeasurable", detail="空指标")
    if _SUBJECTIVE_HINTS.search(name) and not _MEASURABLE_HINTS.search(name):
        return KpiAssessment(
            name=name,
            measurable=False,
            status="unmeasurable",
            detail="主观描述，建议改为可量化指标（如 error 数、耗时、覆盖率）",
        )
    if _MEASURABLE_HINTS.search(name):
        probe = ""
        if _ESLINT_HINT.search(name):
            probe = "eslint_count"
        elif _BUILD_HINT.search(name):
            probe = "build_ok"
        return KpiAssessment(
            name=name,
            measurable=True,
            status="unknown",
            detail=(
                f"可映射内置探针 `{probe}`；巡检后会自动核验"
                if probe
                else "可量化表述；可用内置探针（eslint_count / build_ok / file_exists）"
            ),
            target=_extract_target_hint(name),
            probe=probe,
        )
    return KpiAssessment(
        name=name,
        measurable=False,
        status="unmeasurable",
        detail="缺少可度量阈值，建议补充数字阈值或使用内置探针",
    )


def classify_kpi_item(item: Any) -> KpiAssessment:
    """Accept free-text or light structured dict (name/target/probe/metric_type)."""
    if isinstance(item, dict):
        name = str(item.get("name") or item.get("title") or "").strip()
        target = item.get("target")
        target_op = str(item.get("target_op") or "").strip()
        metric_type = str(item.get("metric_type") or "").strip().lower()
        probe = str(item.get("probe") or "").strip().lower()
        if not name:
            name = str(item.get("metric_command") or "（未命名 KPI）").strip()[:80]
        target_s = ""
        if target is not None and str(target).strip() != "":
            target_s = f"{target_op}{target}" if target_op else str(target)
        if probe in _BUILTIN_PROBES or metric_type == "builtin":
            if probe not in _BUILTIN_PROBES:
                probe = str(item.get("probe") or "").strip().lower()
            return KpiAssessment(
                name=name or probe or "（内置探针）",
                measurable=True,
                status="unknown",
                detail=f"内置探针 `{probe or '?'}`；将在巡检后自动核验",
                target=target_s or ("0" if probe == "eslint_count" else ""),
                probe=probe if probe in _BUILTIN_PROBES else "",
            )
        if target_s or metric_type in ("command", "number", "threshold"):
            detail = "结构化指标已配置"
            if metric_type == "command" and item.get("metric_command"):
                detail = "含自由命令（不会自动执行）；请改用内置探针 probe=eslint_count|build_ok|file_exists"
            # Infer builtin from name when possible
            inferred = ""
            if _ESLINT_HINT.search(name):
                inferred = "eslint_count"
            elif _BUILD_HINT.search(name):
                inferred = "build_ok"
            return KpiAssessment(
                name=name or "（结构化 KPI）",
                measurable=True,
                status="unknown",
                detail=detail,
                target=target_s or _extract_target_hint(name),
                probe=inferred,
            )
        return classify_kpi_text(name)
    return classify_kpi_text(str(item or ""))


def _extract_target_hint(text: str) -> str:
    m = re.search(r"(<=|>=|<|>|=)\s*([\d.]+%?)", text)
    if m:
        return f"{m.group(1)}{m.group(2)}"
    m2 = re.search(r"(\d+)\s*(error|s|秒|%|次)", text, re.I)
    if m2:
        return f"{m2.group(1)}{m2.group(2)}"
    if re.search(r"零|0\s*error", text, re.I):
        return "0"
    return ""


def assess_role_kpis(role: ProactiveRole) -> list[KpiAssessment]:
    """Classify configured KPI entries (no arbitrary shell execution)."""
    raw = list(role.config.kpis or [])
    if not raw:
        return [
            KpiAssessment(
                name="（未配置 KPI）",
                measurable=False,
                status="unmeasurable",
                detail="请在岗位合同中配置可核验指标",
            )
        ]
    return [classify_kpi_item(k) for k in raw]


def _parse_iso_utc(iso: str) -> datetime | None:
    s = str(iso or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _window_bounds(days: int) -> tuple[datetime, datetime]:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=max(1, days))
    return start, end


def _in_window(iso: str, start: datetime, end: datetime) -> bool:
    dt = _parse_iso_utc(iso)
    if dt is None:
        return False
    return start <= dt <= end


def _workspace_root(role: ProactiveRole) -> Path | None:
    raw = str(role.config.workspace_path or "").strip()
    if not raw:
        return None
    try:
        p = Path(raw).expanduser().resolve()
    except OSError:
        return None
    return p if p.is_dir() else None


def _safe_rel_path(ws: Path, rel: str) -> Path | None:
    rel = str(rel or "").strip().replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    try:
        target = (ws / rel).resolve()
        target.relative_to(ws)
        return target
    except (OSError, ValueError):
        return None


def _run_argv(cmd: list[str], *, cwd: Path, timeout: int = _PROBE_TIMEOUT) -> tuple[int, str]:
    try:
        from evoflow.utils.subprocess_platform import subprocess_text_io_kwargs

        kwargs = subprocess_text_io_kwargs()
    except Exception:
        kwargs = {}
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(cwd),
            shell=False,
            **kwargs,
        )
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        combined = "\n".join(x for x in (out, err) if x)
        return int(proc.returncode), combined
    except FileNotFoundError:
        return 127, f"Command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, f"Timed out after {timeout}s"
    except Exception as exc:
        return 1, str(exc)


def _compare_numeric(observed: float, target_raw: str, default_op: str = "<=") -> bool:
    s = str(target_raw or "").strip()
    op = default_op
    num_s = s
    m = re.match(r"^(<=|>=|<|>|=)\s*([\d.]+)", s)
    if m:
        op = m.group(1)
        num_s = m.group(2)
    else:
        num_s = re.sub(r"[^\d.]", "", s) or "0"
    try:
        target = float(num_s)
    except ValueError:
        target = 0.0
    if op == "<":
        return observed < target
    if op == ">":
        return observed > target
    if op == ">=":
        return observed >= target
    if op == "=":
        return abs(observed - target) < 1e-9
    return observed <= target  # <= default


def _probe_file_exists(ws: Path, item: dict[str, Any], base: KpiAssessment) -> KpiAssessment:
    args = item.get("args") if isinstance(item.get("args"), dict) else {}
    rel = str(args.get("path") or item.get("path") or "").strip()
    if not rel:
        # Heuristic from name
        for cand in ("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "package.json"):
            if cand in base.name:
                rel = cand
                break
    if not rel:
        return KpiAssessment(
            name=base.name,
            measurable=True,
            status="unknown",
            detail="file_exists 缺少 path",
            target=base.target,
            probe="file_exists",
        )
    path = _safe_rel_path(ws, rel)
    if path is None:
        return KpiAssessment(
            name=base.name,
            measurable=True,
            status="fail",
            detail="非法路径（禁止越出工作区）",
            target=rel,
            observed="invalid",
            probe="file_exists",
        )
    ok = path.exists()
    return KpiAssessment(
        name=base.name,
        measurable=True,
        status="pass" if ok else "fail",
        detail=f"{'存在' if ok else '不存在'}: {rel}",
        target=rel,
        observed="exists" if ok else "missing",
        probe="file_exists",
    )


def _probe_eslint_count(ws: Path, base: KpiAssessment) -> KpiAssessment:
    target = base.target or "0"
    npx = shutil.which("npx")
    eslint = shutil.which("eslint")
    # Prefer local node_modules/.bin
    local = ws / "node_modules" / ".bin" / ("eslint.cmd" if os.name == "nt" else "eslint")
    if local.is_file():
        cmd = [str(local), ".", "--format", "json", "--no-error-on-unmatched-pattern"]
    elif eslint:
        cmd = [eslint, ".", "--format", "json", "--no-error-on-unmatched-pattern"]
    elif npx:
        cmd = [npx, "--no-install", "eslint", ".", "--format", "json", "--no-error-on-unmatched-pattern"]
    else:
        return KpiAssessment(
            name=base.name,
            measurable=True,
            status="unknown",
            detail="未找到 eslint / npx，跳过探针",
            target=target,
            probe="eslint_count",
        )
    code, out = _run_argv(cmd, cwd=ws, timeout=_PROBE_TIMEOUT)
    # ESLint exits 1 when there are errors — still parse JSON
    errors = 0
    try:
        import json

        # Find JSON array in output
        start = out.find("[")
        end = out.rfind("]")
        if start >= 0 and end > start:
            data = json.loads(out[start : end + 1])
            if isinstance(data, list):
                errors = sum(int(f.get("errorCount") or 0) for f in data if isinstance(f, dict))
        else:
            # stylish fallback: count "error" lines
            errors = len(re.findall(r"\berror\b", out, re.I))
    except Exception:
        if code == 0:
            errors = 0
        else:
            return KpiAssessment(
                name=base.name,
                measurable=True,
                status="unknown",
                detail=f"eslint 输出无法解析 (exit={code})",
                target=target,
                observed="",
                probe="eslint_count",
            )
    passed = _compare_numeric(float(errors), target, "<=")
    return KpiAssessment(
        name=base.name,
        measurable=True,
        status="pass" if passed else "fail",
        detail=f"ESLint errorCount={errors}（目标 {target}）",
        target=target,
        observed=str(errors),
        probe="eslint_count",
    )


def _probe_build_ok(ws: Path, item: dict[str, Any], base: KpiAssessment) -> KpiAssessment:
    args = item.get("args") if isinstance(item.get("args"), dict) else {}
    tool = str(args.get("cmd") or args.get("tool") or "").strip().lower()
    if tool not in _BUILD_ARGV:
        if (ws / "pnpm-lock.yaml").exists():
            tool = "pnpm"
        elif (ws / "yarn.lock").exists():
            tool = "yarn"
        else:
            tool = "npm"
    cmd = list(_BUILD_ARGV[tool])
    code, out = _run_argv(cmd, cwd=ws, timeout=max(_PROBE_TIMEOUT, 120))
    ok = code == 0
    snippet = (out or "")[-240:].replace("\n", " ")
    return KpiAssessment(
        name=base.name,
        measurable=True,
        status="pass" if ok else "fail",
        detail=f"{' '.join(cmd)} → exit {code}" + (f"；{snippet}" if snippet and not ok else ""),
        target="exit 0",
        observed=str(code),
        probe="build_ok",
    )


def _raw_kpi_dict(item: Any) -> dict[str, Any]:
    if isinstance(item, dict):
        return item
    return {"name": str(item or "")}


def run_role_kpi_probes(role: ProactiveRole) -> list[KpiAssessment]:
    """Run allowlisted builtin probes for a role's KPIs.

    Free-text KPIs that mention eslint/build may be auto-mapped.
    Free ``metric_command`` strings are never executed.
    """
    ws = _workspace_root(role)
    classified = assess_role_kpis(role)
    raw = list(role.config.kpis or [])
    if not raw:
        return classified
    if ws is None:
        return [
            KpiAssessment(
                name=k.name,
                measurable=k.measurable,
                status=k.status if k.status != "unknown" else "unknown",
                detail=(k.detail or "") + "；未绑定工作区，无法跑探针",
                target=k.target,
                observed=k.observed,
                probe=k.probe,
            )
            for k in classified
        ]

    out: list[KpiAssessment] = []
    for i, base in enumerate(classified):
        item = _raw_kpi_dict(raw[i] if i < len(raw) else {})
        probe = base.probe or str(item.get("probe") or "").strip().lower()
        if probe not in _BUILTIN_PROBES:
            out.append(base)
            continue
        try:
            if probe == "file_exists":
                out.append(_probe_file_exists(ws, item, base))
            elif probe == "eslint_count":
                out.append(_probe_eslint_count(ws, base))
            elif probe == "build_ok":
                out.append(_probe_build_ok(ws, item, base))
            else:
                out.append(base)
        except Exception as exc:
            logger.debug("kpi probe failed role=%s probe=%s", role.agent_code, probe, exc_info=True)
            out.append(
                KpiAssessment(
                    name=base.name,
                    measurable=True,
                    status="unknown",
                    detail=f"探针异常: {exc}",
                    target=base.target,
                    probe=probe,
                )
            )
    return out


def persist_kpi_probe_results(role: ProactiveRole, assessments: list[KpiAssessment]) -> None:
    """Store last probe snapshot on role memory.extra."""
    from evoflow.proactive.repositories import ProactiveMemoryRepository
    from evoflow.timeutil import utc_now_iso_z

    try:
        mem = ProactiveMemoryRepository.get(role.agent_code)
        extra = dict(mem.extra or {})
        extra["last_kpi_probe_at"] = utc_now_iso_z()
        extra["last_kpi_probe"] = [a.to_dict() for a in assessments]
        mem.extra = extra
        ProactiveMemoryRepository.save(mem)
    except Exception:
        logger.debug("persist_kpi_probe_results failed", exc_info=True)


def format_weekly_report_markdown(report: PerformanceReport) -> str:
    """Short Feishu/desktop markdown for weekly duty digest."""
    period = ""
    if report.period_start and report.period_end:
        period = f"（{report.period_start[:10]} ~ {report.period_end[:10]}）"
    lines = [
        f"**{report.role_name}** 履职周报{period}",
        f"- 值班轮次：{report.patrol_rounds} 轮",
        (
            f"- 事项：{report.initiatives_total}（完成 {report.completed} / "
            f"失败 {report.failed} / 待批 {report.pending_approval}）"
        ),
        (
            f"- 审批：{report.approval_approved}/{report.approval_total} "
            f"（通过率 {report.approval_rate}%）"
        ),
        f"- 成本：${report.cost_usd:.4f} · {report.tokens} tok",
    ]
    if report.consecutive_noop >= 3:
        lines.append(f"- ⚠️ 连续空转 {report.consecutive_noop} 轮")
    if report.kpis:
        lines.append("- KPI：")
        for k in report.kpis[:8]:
            mark = {"pass": "✅", "fail": "❌", "unmeasurable": "⚠️"}.get(k.status, "◎")
            obs = f" → {k.observed}" if k.observed else ""
            lines.append(f"  - {mark} {k.name}{obs}")
    if report.suggestion:
        lines.append(f"- 建议：{report.suggestion}")
    return "\n".join(lines)


def build_performance_report(
    role: ProactiveRole,
    *,
    days: int = 7,
    run_probes: bool = False,
    use_cached_probes: bool = True,
) -> PerformanceReport:
    """Aggregate recent duty stats + KPI classification / probe results."""
    from evoflow.proactive.repositories import (
        ProactiveCostRepository,
        ProactiveMemoryRepository,
        ProactiveRepository,
    )

    days = max(1, min(int(days or 7), 90))
    start, end = _window_bounds(days)
    period_start = start.isoformat().replace("+00:00", "Z")
    period_end = end.isoformat().replace("+00:00", "Z")

    inits = ProactiveRepository.list_initiatives(role_agent_code=role.agent_code, limit=200)
    recent = [i for i in inits if _in_window(i.created_at, start, end)]
    completed = sum(1 for i in recent if i.status.value == "completed")
    failed = sum(1 for i in recent if i.status.value in ("failed", "timeout_rejected"))
    pending = sum(1 for i in recent if i.status.value == "pending_approval")
    journals = sum(
        1
        for i in recent
        if isinstance(i.action_plan, dict) and str(i.action_plan.get("kind") or "") == "round_log"
    )

    approvals = [
        a
        for a in ProactiveRepository.list_approvals(limit=300)
        if a.role_agent_code == role.agent_code and _in_window(a.created_at, start, end)
    ]
    appr_approved = sum(1 for a in approvals if a.status.value == "approved")
    appr_total = len(approvals)
    cost = ProactiveCostRepository.get_cost_summary(role.agent_code, days=days)
    mem = ProactiveMemoryRepository.get(role.agent_code)
    noop = int((mem.extra or {}).get("consecutive_noop_count", 0) or 0)

    kpis: list[KpiAssessment]
    if run_probes:
        kpis = run_role_kpi_probes(role)
        persist_kpi_probe_results(role, kpis)
    elif use_cached_probes and isinstance((mem.extra or {}).get("last_kpi_probe"), list):
        cached = (mem.extra or {}).get("last_kpi_probe") or []
        kpis = [
            KpiAssessment(
                name=str(x.get("name") or ""),
                measurable=bool(x.get("measurable", True)),
                status=str(x.get("status") or "unknown"),
                detail=str(x.get("detail") or ""),
                target=str(x.get("target") or ""),
                observed=str(x.get("observed") or ""),
                probe=str(x.get("probe") or ""),
            )
            for x in cached
            if isinstance(x, dict)
        ] or assess_role_kpis(role)
    else:
        kpis = assess_role_kpis(role)

    suggestion_parts: list[str] = []
    if noop >= 3:
        suggestion_parts.append(f"连续 {noop} 轮疑似空转，已/将降频；可派发具体任务或收紧职责")
    fail_k = sum(1 for k in kpis if k.status == "fail")
    if fail_k:
        suggestion_parts.append(f"有 {fail_k} 条 KPI 未达标，优先处理失败项")
    unmeas = sum(1 for k in kpis if not k.measurable)
    if unmeas:
        suggestion_parts.append(f"有 {unmeas} 条 KPI 不可自动度量，建议改成内置探针或带阈值指标")
    if appr_total and appr_approved / appr_total < 0.4:
        suggestion_parts.append("审批通过率偏低，检查提案粒度与驳回原因")
    if not recent and not approvals:
        suggestion_parts.append("本周期暂无事项与审批，可派发任务或确认上岗节奏")

    return PerformanceReport(
        agent_code=role.agent_code,
        role_name=role.role_name,
        days=days,
        period_start=period_start,
        period_end=period_end,
        patrol_rounds=journals,
        initiatives_total=len(recent),
        completed=completed,
        failed=failed,
        pending_approval=pending,
        approval_total=appr_total,
        approval_approved=appr_approved,
        approval_rate=round(100 * appr_approved / appr_total, 1) if appr_total else 0.0,
        cost_usd=float(cost.get("total_cost_usd") or 0),
        tokens=int(cost.get("total_tokens") or 0),
        consecutive_noop=noop,
        kpis=kpis,
        suggestion="；".join(suggestion_parts) or "继续按工作汇报推进可核验目标",
    )
