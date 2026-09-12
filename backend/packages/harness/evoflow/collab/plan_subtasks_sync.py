"""Sync collaboration subtasks from structured ``plan`` steps (``bound_plan_steps``)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from evoflow.collab.agent_assignment import resolve_assignable_agent, resolve_step_assigned_agent
from evoflow.collab.id_format import make_subtask_id
from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

PLAN_ANALYSIS_HEADING = "## Analysis"
PLAN_FLOWCHART_HEADING_LEGACY = "## Flowchart"

_STEP_HEADER_RE = re.compile(r"^###\s+Step\s+(\d+)\s*:\s*(.+?)\s*$", re.IGNORECASE)
_FIELD_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("goal", re.compile(r"^\s*-\s*\*\*目标\*\*:\s*(.*)$", re.IGNORECASE)),
    ("inputs", re.compile(r"^\s*-\s*\*\*输入物\*\*:\s*(.*)$", re.IGNORECASE)),
    ("outputs", re.compile(r"^\s*-\s*\*\*输出物\*\*:\s*(.*)$", re.IGNORECASE)),
    ("acceptance", re.compile(r"^\s*-\s*\*\*验收标准\*\*:\s*(.*)$", re.IGNORECASE)),
    ("failure", re.compile(r"^\s*-\s*\*\*失败处理\*\*:\s*(.*)$", re.IGNORECASE)),
    ("depends", re.compile(r"^\s*-\s*\*\*依赖\*\*:\s*(.*)$", re.IGNORECASE)),
    (
        "assignee",
        re.compile(
            r"^\s*-\s*\*\*(?:执行人|Assignee|Assigned agent)\*\*:\s*(.*)$",
            re.IGNORECASE,
        ),
    ),
)


def resolve_step_assigned_to(step: dict[str, Any]) -> str:
    """Map Plan ``- **执行人**:`` to subtask ``assigned_to`` (validated agent_code)."""
    code, _, _ = resolve_step_assigned_agent(step if isinstance(step, dict) else {})
    return code


def _coerce_str_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        if text.startswith("["):
            try:
                loaded = json.loads(text)
                if isinstance(loaded, list):
                    return [str(x).strip() for x in loaded if str(x).strip()]
            except json.JSONDecodeError:
                pass
        return [p.strip() for p in re.split(r"[,，、\n]+", text) if p.strip()]
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    return []


def _parse_output_paths(raw: str) -> list[str]:
    text = str(raw or "").strip()
    if not text:
        return []
    paths = re.findall(r"`([^`]+)`", text)
    if paths:
        return [p.strip() for p in paths if p.strip()]
    return _coerce_str_list(text)


def build_worker_profile_from_step(
    step: dict[str, Any],
    *,
    assigned: str,
    depends_refs: list[str],
) -> dict[str, Any]:
    """Build ``worker_profile`` aligned with supervisor ``create_subtasks``."""
    from evoflow.collab.models import WorkerProfile

    base = str(assigned or "general-purpose").strip() or "general-purpose"
    wp_data: dict[str, Any] = {"base_subagent": base}
    if depends_refs:
        wp_data["depends_on"] = [str(x).strip() for x in depends_refs if str(x).strip()]

    instr = str(step.get("instruction") or "").strip()
    if instr:
        wp_data["instruction"] = instr
    model = str(step.get("model") or "").strip()
    if model:
        wp_data["model"] = model
    tools = _coerce_str_list(step.get("tools"))
    if tools:
        from evoflow.tools.tool_aliases import PROCESS_TOOL_SUITE, augment_process_tools, normalize_worker_tool_names

        normalized = normalize_worker_tool_names(tools)
        wp_data["tools"] = augment_process_tools(normalized, set(PROCESS_TOOL_SUITE))
    skills = _coerce_str_list(step.get("skills"))
    if skills:
        wp_data["skills"] = skills

    expected = _coerce_str_list(step.get("expected_outputs"))
    if not expected:
        expected = _parse_output_paths(str(step.get("outputs") or ""))
    if expected:
        wp_data["expected_outputs"] = expected

    acceptance = str(step.get("acceptance") or "").strip()
    if acceptance:
        wp_data["validation"] = acceptance

    wp_json = step.get("worker_profile_json") or step.get("worker_profile")
    if isinstance(wp_json, str) and wp_json.strip():
        try:
            wp_json = json.loads(wp_json)
        except json.JSONDecodeError:
            wp_json = None
    if isinstance(wp_json, dict):
        wp_data = {**wp_data, **{k: v for k, v in wp_json.items() if v is not None and v != ""}}

    try:
        validated = WorkerProfile.model_validate(wp_data)
        return validated.to_storage_dict() or wp_data
    except Exception:
        return wp_data


def _output_tokens_for_depends_match(outputs: str) -> list[str]:
    """Tokens from a prior step's outputs field used to match downstream inputs."""
    tokens: list[str] = []
    for part in re.split(r"[,，、\n]+", str(outputs or "")):
        part = str(part or "").strip().strip("\"'")
        if not part or len(part) < 3:
            continue
        tokens.append(part)
        base = part.rsplit("/", 1)[-1]
        if base and base != part and len(base) >= 3:
            tokens.append(base)
    seen: set[str] = set()
    out: list[str] = []
    for t in tokens:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _step_mention_patterns(ref: str) -> list[str]:
    n = str(ref or "").strip()
    if not n.isdigit():
        return []
    return [
        f"task{n}",
        f"Task{n}",
        f"TASK{n}",
        f"任务{n}",
        f"step {n}",
        f"Step {n}",
        f"STEP{n}",
        f"步骤{n}",
    ]


def _infer_depends_refs_from_step_context(
    *,
    step_num: int,
    step: dict[str, Any],
    prior_steps: list[dict[str, Any]],
) -> list[str] | None:
    """Infer upstream refs from inputs/goal vs prior step outputs (fan-out vs chain)."""
    if step_num <= 1 or not prior_steps:
        return None
    blob = "\n".join(
        str(step.get(k) or "")
        for k in ("inputs", "goal", "description", "block_markdown")
    ).strip()
    if not blob:
        return None

    matched: list[str] = []
    seen: set[str] = set()
    for ps in prior_steps:
        pref = str(ps.get("ref") or ps.get("step_num") or "").strip()
        if not pref or not pref.isdigit():
            continue
        if int(pref) >= step_num:
            continue
        outputs = str(ps.get("outputs") or ps.get("output") or "").strip()
        hit = False
        for token in _output_tokens_for_depends_match(outputs):
            if token in blob:
                hit = True
                break
        if not hit:
            for pat in _step_mention_patterns(pref):
                if pat in blob:
                    hit = True
                    break
        if hit and pref not in seen:
            seen.add(pref)
            matched.append(pref)
    if not matched:
        return None
    return sorted(matched, key=int)


def _plan_step_num_for_index(raw: dict[str, Any], *, idx: int) -> int:
    """Resolve canonical numeric step ref (1-based) from a raw plan/app step."""
    ref_raw = raw.get("ref") if raw.get("ref") is not None else raw.get("step_num")
    try:
        return int(ref_raw) if ref_raw is not None and str(ref_raw).strip() else idx
    except (TypeError, ValueError):
        return idx


def _build_semantic_ref_aliases(steps: list[dict[str, Any]]) -> dict[str, str]:
    """Map workflow/App semantic refs (e.g. ``brief``) to numeric plan refs (``1``)."""
    aliases: dict[str, str] = {}
    for i, raw in enumerate(steps, start=1):
        if not isinstance(raw, dict):
            continue
        step_num = _plan_step_num_for_index(raw, idx=i)
        canonical = str(step_num)
        original = str(
            raw.get("ref") if raw.get("ref") is not None else raw.get("step_num") or ""
        ).strip()
        if original and original != canonical:
            aliases[original] = canonical
    return aliases


def _apply_ref_aliases(refs: list[str], aliases: dict[str, str] | None) -> list[str]:
    if not aliases:
        return refs
    out: list[str] = []
    for ref in refs:
        r = str(ref or "").strip()
        if not r:
            continue
        out.append(aliases.get(r, r))
    return out


def _resolve_depends_refs(
    *,
    step_num: int,
    step: dict[str, Any],
    prior_steps: list[dict[str, Any]] | None = None,
    depends_raw: Any = None,
) -> list[str]:
    """Resolve depends refs: explicit list/text, else infer from I/O, else chain default.

    An explicitly empty list ``[]`` means "no dependencies" (parallel root node)
    and is respected — it does NOT fall through to inference.
    """
    if isinstance(depends_raw, list):
        # Explicit list (including empty []) is authoritative — do not infer.
        return [str(x).strip() for x in depends_raw if str(x).strip()]
    else:
        text = str(depends_raw or step.get("depends") or "").strip()
        if text and text not in {"无", "none", "—", "-"}:
            parsed = _parse_depends_refs(text, step_num=step_num)
            if parsed:
                return parsed

    inferred = _infer_depends_refs_from_step_context(
        step_num=step_num,
        step=step,
        prior_steps=prior_steps or [],
    )
    if inferred:
        return inferred
    return [str(step_num - 1)] if step_num > 1 else []


def normalize_plan_step_dict(
    raw: dict[str, Any],
    *,
    idx: int,
    prior_steps: list[dict[str, Any]] | None = None,
    ref_aliases: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Unify structured ``plan`` steps and markdown-parsed steps for sync."""
    step = dict(raw)
    ref_raw = step.get("ref") if step.get("ref") is not None else step.get("step_num")
    step_num = _plan_step_num_for_index(step, idx=idx)
    semantic_ref = str(ref_raw or "").strip()
    short_name = str(step.get("name") or step.get("short_name") or f"Step {step_num}").strip()
    depends_raw = step.get("depends_on") if step.get("depends_on") is not None else step.get("depends_refs")
    depends_refs = _resolve_depends_refs(
        step_num=step_num,
        step=step,
        prior_steps=prior_steps,
        depends_raw=depends_raw,
    )
    depends_refs = _apply_ref_aliases(depends_refs, ref_aliases)

    if isinstance(step.get("tools"), str):
        step["tools"] = _coerce_str_list(step["tools"])
    if isinstance(step.get("skills"), str):
        step["skills"] = _coerce_str_list(step["skills"])

    step["ref"] = str(step_num)
    step["step_num"] = step_num
    if semantic_ref and semantic_ref != str(step_num):
        step["semantic_ref"] = semantic_ref
    step["short_name"] = short_name
    step["display_name"] = str(step.get("display_name") or f"Step {step_num}: {short_name}").strip()
    step["depends_refs"] = depends_refs
    return step


def _format_depends_line(depends_refs: list[str]) -> str:
    refs = [str(x).strip() for x in depends_refs if str(x).strip()]
    if not refs:
        return ""
    return f"- **依赖**: {', '.join(refs)}"


_MERMAID_FENCE_RE = re.compile(r"^```(?:mermaid)?\s*\n?([\s\S]*?)```\s*$", re.IGNORECASE)


def normalize_mermaid_body(raw: str | None) -> str:
    """Strip optional fences; keep flowchart/graph source for rendering."""
    text = str(raw or "").strip()
    if not text:
        return ""
    m = _MERMAID_FENCE_RE.match(text)
    if m:
        text = str(m.group(1) or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:mermaid)?\s*\n?", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\n?```\s*$", "", text).strip()
    return text


def _mermaid_node_label(step_num: int, name: str) -> str:
    short = str(name or f"Step {step_num}").strip().replace('"', "'").replace("\n", " ")
    if len(short) > 48:
        short = short[:45] + "…"
    return f'S{step_num}["Step {step_num}: {short}"]'


def synthesize_flowchart_mermaid_from_steps(steps: list[dict[str, Any]]) -> str:
    """Build a default flowchart TD from step refs and depends_on (when model omits flowchart_mermaid)."""
    if not steps:
        return ""
    ordered: list[tuple[int, str, list[str]]] = []
    for idx, raw in enumerate(steps, start=1):
        step = raw if isinstance(raw, dict) else {}
        ref = step.get("ref")
        try:
            step_num = int(ref) if ref is not None and str(ref).strip() else idx
        except (TypeError, ValueError):
            step_num = idx
        name = str(step.get("name") or step.get("short_name") or f"Step {step_num}").strip()
        depends_raw = step.get("depends_on") or step.get("depends_refs")
        if isinstance(depends_raw, list):
            depends = [str(x).strip() for x in depends_raw if str(x).strip()]
        else:
            depends = _resolve_depends_refs(
                step_num=step_num,
                step=step if isinstance(step, dict) else {},
                prior_steps=[s for s in steps[: idx - 1] if isinstance(s, dict)],
                depends_raw=depends_raw,
            )
        ordered.append((step_num, name, depends))

    lines = ["flowchart TD", '  START["开始"]']
    refs_seen = {n for n, _, _ in ordered}
    for step_num, name, _depends in ordered:
        lines.append(f"  {_mermaid_node_label(step_num, name)}")

    edges: list[str] = []
    for step_num, _name, depends in ordered:
        dst = f"S{step_num}"
        if depends:
            for dep in depends:
                try:
                    dnum = int(str(dep).strip())
                except (TypeError, ValueError):
                    continue
                if dnum in refs_seen:
                    edges.append(f"  S{dnum} --> {dst}")
        elif step_num == ordered[0][0]:
            edges.append(f"  START --> {dst}")
        else:
            prev_nums = [n for n, _, _ in ordered if n < step_num]
            if prev_nums:
                edges.append(f"  S{prev_nums[-1]} --> {dst}")
            else:
                edges.append(f"  START --> {dst}")

    lines.extend(edges)
    return "\n".join(lines).strip()


def build_plan_markdown(
    *,
    goal: str,
    steps: list[dict[str, Any]],
    flowchart_mermaid: str | None = None,
    validation: list[str] | str | None = None,
    open_questions: str = "无",
) -> str:
    """Render canonical ``# Plan`` markdown from structured ``plan`` tool fields."""
    goal_text = str(goal or "").strip()
    if not goal_text:
        raise ValueError("goal is required")
    if not steps:
        raise ValueError("steps must not be empty")

    lines: list[str] = ["# Plan", "", "## Goal", goal_text, ""]

    mermaid_body = normalize_mermaid_body(flowchart_mermaid)
    if mermaid_body:
        if mermaid_body.startswith("```"):
            lines.extend([PLAN_ANALYSIS_HEADING, mermaid_body, ""])
        else:
            lines.extend([PLAN_ANALYSIS_HEADING, "```mermaid", mermaid_body, "```", ""])

    lines.extend(["## Steps", ""])
    for idx, raw in enumerate(steps, start=1):
        step = raw if isinstance(raw, dict) else {}
        ref = step.get("ref")
        try:
            step_num = int(ref) if ref is not None and str(ref).strip() else idx
        except (TypeError, ValueError):
            step_num = idx
        name = str(step.get("name") or step.get("short_name") or f"Step {step_num}").strip()
        _code, assignee_display, _assign_warns = resolve_assignable_agent(
            str(step.get("assigned_agent") or step.get("assignee") or "").strip() or None,
        )
        depends_raw = step.get("depends_on") or step.get("depends_refs")
        if isinstance(depends_raw, list):
            depends_refs = [str(x).strip() for x in depends_raw if str(x).strip()]
        else:
            depends_refs = _resolve_depends_refs(
                step_num=step_num,
                step=step if isinstance(step, dict) else {},
                prior_steps=[s for s in steps[: idx - 1] if isinstance(s, dict)],
                depends_raw=depends_raw,
            )

        lines.append(f"### Step {step_num}: {name}")
        lines.append(f"- **目标**: {str(step.get('goal') or '').strip()}")
        lines.append(f"- **输入物**: {str(step.get('inputs') or '').strip()}")
        lines.append(f"- **输出物**: {str(step.get('outputs') or '').strip()}")
        lines.append(f"- **验收标准**: {str(step.get('acceptance') or '').strip()}")
        lines.append(f"- **失败处理**: {str(step.get('failure') or '').strip()}")
        lines.append(f"- **执行人**: {assignee_display}")
        dep_line = _format_depends_line(depends_refs)
        if dep_line:
            lines.append(dep_line)
        lines.append("")

    lines.extend(["## Validation"])
    if validation is None or validation == "":
        lines.append("- （待补充）")
    elif isinstance(validation, list):
        for item in validation:
            text = str(item or "").strip()
            if text:
                lines.append(f"- {text}" if not text.startswith("-") else text)
    else:
        for vline in str(validation).splitlines():
            text = vline.strip()
            if text:
                lines.append(text if text.startswith("-") else f"- {text}")
    lines.extend(["", "## Open Questions", str(open_questions or "无").strip() or "无", ""])
    return "\n".join(lines).strip() + "\n"


def subtask_sync_public_fields(
    *,
    subtask_id: str,
    display_name: str,
    description: str,
    parent_task_id: str,
    ref: str,
    status: Any,
    assigned_to: str,
    depends_refs: list[str],
    assigned_agent_name: str = "",
    work_checklist: list[dict[str, Any]] | None = None,
    tools: list[str] | None = None,
) -> dict[str, Any]:
    """Fields returned in ``plan`` tool ``created`` / ``updated`` arrays (UI + agent trace)."""
    row: dict[str, Any] = {
        "subtaskId": subtask_id,
        "name": display_name,
        "description": description,
        "parentTaskId": parent_task_id,
        "ref": ref,
        "status": status,
        "assignedTo": assigned_to,
        "assigned_to": assigned_to,
        "dependsOn": depends_refs,
        "depends_on": depends_refs,
    }
    dn = str(assigned_agent_name or "").strip()
    if dn:
        row["assignedAgentName"] = dn
        row["assigned_agent_name"] = dn
    if work_checklist:
        row["workChecklist"] = work_checklist
    if tools:
        row["tools"] = tools
    return row


_EDITABLE_SUBTASK_STATUSES = frozenset({"pending", "planned", "planning", ""})
_PROTECTED_SUBTASK_STATUSES = frozenset(
    {"executing", "running", "in_progress", "active", "completed", "done", "failed", "cancelled", "canceled", "timed_out"},
)


def parse_plan_goal(markdown: str) -> str:
    """First non-empty line under ``## Goal``."""
    md = str(markdown or "")
    in_goal = False
    for line in md.splitlines():
        stripped = line.strip()
        if stripped.startswith("## Goal"):
            in_goal = True
            continue
        if in_goal:
            if stripped.startswith("## ") and not stripped.startswith("### "):
                break
            if stripped:
                return stripped
    return ""


def parse_plan_steps(markdown: str) -> list[dict[str, Any]]:
    """Parse ``### Step N: …`` blocks under ``## Steps`` (display/tests only; sync uses ``bound_plan_steps``)."""
    md = str(markdown or "").strip()
    if not md:
        return []

    steps_section = ""
    in_steps = False
    for line in md.splitlines():
        stripped = line.strip()
        if stripped.startswith("## Steps"):
            in_steps = True
            continue
        if in_steps and stripped.startswith("## ") and not stripped.startswith("### "):
            break
        if in_steps:
            steps_section += line + "\n"

    if not steps_section.strip():
        return []

    blocks: list[str] = []
    current: list[str] = []
    for line in steps_section.splitlines():
        if _STEP_HEADER_RE.match(line.strip()):
            if current:
                blocks.append("\n".join(current))
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append("\n".join(current))

    out: list[dict[str, Any]] = []
    for block in blocks:
        lines = block.splitlines()
        if not lines:
            continue
        m = _STEP_HEADER_RE.match(lines[0].strip())
        if not m:
            continue
        step_num = int(m.group(1))
        short_name = str(m.group(2) or "").strip()
        fields: dict[str, str] = {}
        for body_line in lines[1:]:
            for key, pat in _FIELD_PATTERNS:
                fm = pat.match(body_line)
                if fm:
                    fields[key] = str(fm.group(1) or "").strip()
                    break
        dep_raw = fields.get("depends", "")
        step_stub = {
            "step_num": step_num,
            "ref": str(step_num),
            "short_name": short_name,
            "goal": fields.get("goal", ""),
            "inputs": fields.get("inputs", ""),
            "outputs": fields.get("outputs", ""),
        }
        depends_refs = _resolve_depends_refs(
            step_num=step_num,
            step=step_stub,
            prior_steps=out,
            depends_raw=dep_raw or None,
        )
        out.append(
            {
                **step_stub,
                "display_name": f"Step {step_num}: {short_name}" if short_name else f"Step {step_num}",
                "acceptance": fields.get("acceptance", ""),
                "failure": fields.get("failure", ""),
                "assignee": fields.get("assignee", ""),
                "depends_refs": depends_refs,
                "block_markdown": block.strip(),
            }
        )
    out.sort(key=lambda x: int(x.get("step_num") or 0))
    return out


def _parse_depends_refs(raw: str, *, step_num: int) -> list[str]:
    """Parse ``**依赖**: 1`` or ``1, 2`` / ``Step 1`` into numeric step refs (explicit text only)."""
    text = str(raw or "").strip()
    if not text or text in {"无", "none", "—", "-"}:
        return []
    refs: list[str] = []
    for part in re.split(r"[,，、\s]+", text):
        p = str(part or "").strip()
        if not p:
            continue
        m = re.match(r"^(?:step\s*)?(\d+)$", p, re.IGNORECASE)
        if m:
            refs.append(m.group(1))
            continue
        m2 = re.search(r"(\d+)", p)
        if m2:
            refs.append(m2.group(1))
    seen: set[str] = set()
    out: list[str] = []
    for r in refs:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _step_likely_bundles_parallel_tasks(step: dict[str, Any]) -> bool:
    """Heuristic: one Step block mentions multiple numbered 任务/任务N."""
    blob = "\n".join(str(step.get(k) or "") for k in ("goal", "inputs", "outputs", "acceptance", "block_markdown", "short_name"))
    hits = set(re.findall(r"任务\s*(\d+)", blob))
    return len(hits) >= 2


def build_subtask_description_from_step(step: dict[str, Any]) -> str:
    parts: list[str] = []
    for label, key in (
        ("目标", "goal"),
        ("输入物", "inputs"),
        ("输出物", "outputs"),
        ("验收标准", "acceptance"),
        ("失败处理", "failure"),
    ):
        val = str(step.get(key) or "").strip()
        if val:
            parts.append(f"{label}：{val}")
    if not parts:
        return str(step.get("block_markdown") or step.get("display_name") or "").strip()[:8000]
    return "\n".join(parts)[:8000]


def _norm_status(raw: Any) -> str:
    return str(raw or "").strip().lower().replace("-", "_")


def _match_existing_by_ref(existing: list[dict[str, Any]], ref: str) -> dict[str, Any] | None:
    r = str(ref or "").strip()
    if not r:
        return None
    for st in existing:
        if not isinstance(st, dict):
            continue
        if str(st.get("ref") or "").strip() == r:
            return st
        nm = str(st.get("name") or "").strip()
        m = re.match(r"^Step\s+(\d+)\s*:", nm, re.IGNORECASE)
        if m and m.group(1) == r:
            return st
    return None


def sync_subtasks_from_plan_steps(
    task_id: str,
    steps: list[dict[str, Any]],
    *,
    storage: Any | None = None,
    goal: str | None = None,
) -> dict[str, Any]:
    """Create or update subtasks from structured or parsed plan steps (1:1 with ``create_subtasks`` fields)."""
    tid = str(task_id or "").strip()
    result: dict[str, Any] = {
        "success": False,
        "task_id": tid,
        "created": [],
        "updated": [],
        "removed": [],
        "unchanged": 0,
        "warnings": [],
    }
    if not tid:
        return result

    store = storage if storage is not None else get_project_storage()
    row = find_main_task(store, tid)
    if not row:
        result["warnings"].append("task_not_found")
        return result

    project, task = row
    raw_steps = [s if isinstance(s, dict) else {} for s in steps]
    ref_aliases = _build_semantic_ref_aliases(raw_steps)
    normalized: list[dict[str, Any]] = []
    for i, s in enumerate(raw_steps, start=1):
        normalized.append(
            normalize_plan_step_dict(
                s,
                idx=i,
                prior_steps=normalized,
                ref_aliases=ref_aliases,
            )
        )
    if not normalized:
        result["warnings"].append("no_steps")
        result["success"] = True
        return result

    goal_text = str(goal or "").strip()
    if goal_text:
        from evoflow.collab.plan_task_storage import sync_main_task_identity_from_plan_goal

        sync_main_task_identity_from_plan_goal(task, project, goal_text)

    existing = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    now = utc_now_iso_z()
    new_refs = {str(s["ref"]) for s in normalized}
    touched_ids: set[str] = set()

    for step in normalized:
        if _step_likely_bundles_parallel_tasks(step):
            result["warnings"].append(f"step_{step.get('ref')}_bundles_multiple_tasks: split parallel work into separate ### Step headers (1 Step = 1 subtask)")
        ref = str(step["ref"])
        display_name = str(step["display_name"])
        desc_override = str(step.get("description") or "").strip()
        desc = desc_override or build_subtask_description_from_step(step)
        depends_refs = [str(x).strip() for x in (step.get("depends_refs") or []) if str(x).strip()]
        semantic_ref = str(step.get("semantic_ref") or "").strip()
        assigned, assigned_display, assign_warns = resolve_step_assigned_agent(step)
        worker_profile = build_worker_profile_from_step(step, assigned=assigned, depends_refs=depends_refs)
        if semantic_ref:
            worker_profile["semantic_ref"] = semantic_ref
        tools_list = list(worker_profile.get("tools") or []) if isinstance(worker_profile.get("tools"), list) else []
        wc_raw = step.get("work_checklist") or step.get("work_todos") or step.get("checklist")
        work_checklist: list[dict[str, Any]] | None = None
        if wc_raw is not None:
            from evoflow.collab.work_checklist import normalize_checklist_items

            work_checklist = normalize_checklist_items(wc_raw)
        project_path = str(step.get("project_path") or "").strip()
        for w in assign_warns:
            if w and w not in result["warnings"]:
                result["warnings"].append(w)
        prev = _match_existing_by_ref(existing, ref)
        pub_kwargs = {
            "assigned_agent_name": assigned_display,
            "depends_refs": depends_refs,
            "work_checklist": work_checklist,
            "tools": tools_list or None,
        }
        if prev:
            sid = str(prev.get("id") or "").strip()
            status = _norm_status(prev.get("status"))
            touched_ids.add(sid)
            if status in _PROTECTED_SUBTASK_STATUSES:
                result["unchanged"] += 1
                continue
            changed = False
            if str(prev.get("name") or "").strip() != display_name:
                prev["name"] = display_name
                changed = True
            if str(prev.get("description") or "").strip() != desc:
                prev["description"] = desc
                changed = True
            if str(prev.get("ref") or "").strip() != ref:
                prev["ref"] = ref
                changed = True
            if semantic_ref and str(prev.get("semantic_ref") or "").strip() != semantic_ref:
                prev["semantic_ref"] = semantic_ref
                changed = True
            if str(prev.get("assigned_to") or "").strip() != assigned:
                prev["assigned_to"] = assigned
                changed = True
            if str(prev.get("assigned_agent_name") or "").strip() != assigned_display:
                prev["assigned_agent_name"] = assigned_display
                changed = True
            if list(prev.get("worker_profile") or {}) != worker_profile:
                prev["worker_profile"] = worker_profile
                changed = True
            if depends_refs and list(prev.get("dependencies") or []) != depends_refs:
                prev["dependencies"] = depends_refs
                changed = True
            if work_checklist is not None and list(prev.get("work_checklist") or []) != work_checklist:
                prev["work_checklist"] = work_checklist
                changed = True
            if project_path and str(prev.get("project_path") or "").strip() != project_path:
                prev["project_path"] = project_path
                changed = True
            if changed:
                prev["updated_at"] = now
                result["updated"].append(
                    subtask_sync_public_fields(
                        subtask_id=sid,
                        display_name=display_name,
                        description=desc,
                        parent_task_id=tid,
                        ref=ref,
                        status=prev.get("status"),
                        assigned_to=assigned,
                        **pub_kwargs,
                    )
                )
            else:
                result["unchanged"] += 1
            continue

        sid = make_subtask_id()
        row_data: dict[str, Any] = {
            "id": sid,
            "ref": ref,
            **({"semantic_ref": semantic_ref} if semantic_ref else {}),
            "name": display_name,
            "description": desc,
            "status": "planned",
            "dependencies": depends_refs,
            "assigned_to": assigned,
            "assigned_agent_name": assigned_display,
            "result": None,
            "error": None,
            "created_at": now,
            "started_at": None,
            "completed_at": None,
            "progress": 0,
            "worker_profile": worker_profile,
        }
        if work_checklist is not None:
            row_data["work_checklist"] = work_checklist
        if project_path:
            row_data["project_path"] = project_path
        existing.append(row_data)
        touched_ids.add(sid)
        result["created"].append(
            subtask_sync_public_fields(
                subtask_id=sid,
                display_name=display_name,
                description=desc,
                parent_task_id=tid,
                ref=ref,
                status="planned",
                assigned_to=assigned,
                **pub_kwargs,
            )
        )

    kept: list[dict[str, Any]] = []
    for st in existing:
        sid = str(st.get("id") or "").strip()
        ref = str(st.get("ref") or "").strip()
        status = _norm_status(st.get("status"))
        if sid in touched_ids:
            kept.append(st)
            continue
        if ref and ref not in new_refs and status in _EDITABLE_SUBTASK_STATUSES:
            result["removed"].append({"subtaskId": sid, "ref": ref, "name": st.get("name")})
            continue
        if not ref and status in _EDITABLE_SUBTASK_STATUSES:
            result["warnings"].append(f"orphan_subtask_kept:{sid}")
        kept.append(st)

    task["subtasks"] = kept
    task["updated_at"] = now
    project["updated_at"] = now

    for step in normalized:
        ref = str(step.get("ref") or "").strip()
        sub = _match_existing_by_ref(kept, ref) or _match_existing_by_ref(existing, ref)
        if not sub:
            continue
        desc = str(sub.get("description") or "").strip()
        if desc:
            for label, key in (
                ("目标", "goal"),
                ("输入物", "inputs"),
                ("输出物", "outputs"),
                ("验收标准", "acceptance"),
                ("失败处理", "failure"),
            ):
                if str(step.get(key) or "").strip():
                    continue
                m = re.search(rf"(?:^|\n)\s*{re.escape(label)}[：:]\s*(.+?)(?=\n\s*\S+[：:]|$)", desc, re.DOTALL)
                if m:
                    step[key] = str(m.group(1) or "").strip()
        wp = sub.get("worker_profile")
        if isinstance(wp, dict):
            if not str(step.get("instruction") or "").strip() and wp.get("instruction"):
                step["instruction"] = str(wp.get("instruction") or "").strip()
            if not step.get("tools") and wp.get("tools"):
                step["tools"] = list(wp.get("tools") or [])
            if not step.get("skills") and wp.get("skills"):
                step["skills"] = list(wp.get("skills") or [])

    try:
        persist_bound_plan_steps(task, normalized)
    except Exception:
        logger.debug("sync_subtasks_from_plan: persist plan_steps_json failed", exc_info=True)

    if not store.save_project(project):
        result["warnings"].append("save_failed")
        return result

    try:
        from evoflow.tools.builtins.supervisor.dependency import normalize_subtask_depends_on_refs

        normalize_subtask_depends_on_refs(store, tid)
    except Exception:
        logger.exception("sync_subtasks_from_plan: normalize depends_on refs failed task_id=%s", tid)

    result["success"] = True
    logger.info(
        "sync_subtasks_from_plan: task_id=%s created=%d updated=%d removed=%d",
        tid,
        len(result["created"]),
        len(result["updated"]),
        len(result["removed"]),
    )

    return result


def load_bound_plan_steps(task: dict[str, Any]) -> list[dict[str, Any]]:
    """Structured steps on main task row (``plan_steps_json``)."""
    from evoflow.collab.plan_task_storage import load_plan_steps

    return load_plan_steps(task)


def persist_bound_plan_steps(task: dict[str, Any], steps: list[dict[str, Any]]) -> None:
    from evoflow.collab.plan_task_storage import persist_plan_steps

    persist_plan_steps(task, steps)


def ensure_subtasks_synced_before_start_execution(
    task_id: str,
    *,
    storage: Any | None = None,
) -> dict[str, Any]:
    """If the main task has bound plan steps but missing/stale subtasks, sync before start_execution."""
    tid = str(task_id or "").strip()
    out: dict[str, Any] = {
        "task_id": tid,
        "attempted": False,
        "subtaskCountBefore": 0,
        "subtaskCountAfter": 0,
        "planStepCount": 0,
    }
    if not tid:
        out["reason"] = "task_id_required"
        return out

    store = storage if storage is not None else get_project_storage()
    row = find_main_task(store, tid)
    if not row:
        out["reason"] = "task_not_found"
        return out

    _project, task = row
    subs_before = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    steps = load_bound_plan_steps(task)
    out["subtaskCountBefore"] = len(subs_before)
    out["planStepCount"] = len(steps)
    if not steps:
        out["reason"] = "no_bound_plan_steps"
        out["subtaskCountAfter"] = len(subs_before)
        return out

    need_sync = len(subs_before) == 0 or len(subs_before) < len(steps)
    if not need_sync:
        out["reason"] = "subtasks_already_present"
        out["subtaskCountAfter"] = len(subs_before)
        return out

    out["attempted"] = True
    sync_result = sync_subtasks_from_bound_plan(tid, storage=store)
    out["subtasksSync"] = sync_result

    row2 = find_main_task(store, tid)
    subs_after = []
    if row2:
        subs_after = [x for x in (row2[1].get("subtasks") or []) if isinstance(x, dict)]
    out["subtaskCountAfter"] = len(subs_after)
    out["reason"] = "synced_from_bound_plan" if subs_after else "sync_attempted_still_empty"
    return out


def sync_subtasks_from_bound_plan(
    task_id: str,
    *,
    storage: Any | None = None,
    goal: str | None = None,
) -> dict[str, Any]:
    """Sync subtasks from ``task.bound_plan_steps`` (structured only; no markdown parse)."""
    tid = str(task_id or "").strip()
    result: dict[str, Any] = {
        "success": False,
        "task_id": tid,
        "created": [],
        "updated": [],
        "removed": [],
        "unchanged": 0,
        "warnings": [],
    }
    if not tid:
        return result
    store = storage if storage is not None else get_project_storage()
    row = find_main_task(store, tid)
    if not row:
        result["warnings"].append("task_not_found")
        return result
    _project, task = row
    steps = load_bound_plan_steps(task)
    if not steps:
        result["warnings"].append("no_bound_plan_steps")
        result["success"] = True
        return result
    goal_text = str(goal or "").strip() or str(task.get("plan_goal") or "").strip()
    return sync_subtasks_from_plan_steps(tid, steps, storage=store, goal=goal_text or None)


__all__ = [
    "parse_plan_goal",
    "parse_plan_steps",
    "build_subtask_description_from_step",
    "build_plan_markdown",
    "build_worker_profile_from_step",
    "normalize_plan_step_dict",
    "resolve_step_assigned_to",
    "subtask_sync_public_fields",
    "load_bound_plan_steps",
    "persist_bound_plan_steps",
    "sync_subtasks_from_plan_steps",
    "sync_subtasks_from_bound_plan",
    "ensure_subtasks_synced_before_start_execution",
]
