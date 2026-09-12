"""Parameter extraction engine: convert existing task plan to a reusable App definition.

Analyzes plan content to identify variable values (product names, domains,
numeric ranges, etc.), replaces them with `{{param}}` placeholders, and
generates AppParameter definitions.
"""

from __future__ import annotations

import re
import uuid
from collections import Counter
from typing import Any

from evoflow.timeutil import utc_now_iso_z


# ──────────────────────────────── Parameter Detectors ───────────────────────────────


# Skip low-value / format-extension noise
_GENERIC_SKIP = frozenset(
    {
        "md",
        "json",
        "csv",
        "pdf",
        "txt",
        "xlsx",
        "docx",
        "top",
        "first",
        "last",
        "min",
        "max",
        "limit",
        "format",
        "output",
        "input",
        "http",
        "https",
        "www",
        "com",
        "org",
        "net",
        "version",
        "data",
        "file",
        "path",
        "test",
        "demo",
        "example",
        "null",
        "none",
        "true",
        "false",
    }
)

# Bare number detector only keeps hits that appear at least this many times
_NUMBER_MIN_FREQ = 2


def _detect_numeric_ranges(text: str) -> list[tuple[str, str]]:
    """Detect numbers and numeric ranges: '1-50', 'top 10', 'version 2.1'"""
    patterns = [
        (r"\b(\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?)\b", "range"),
        (r"\b(?:top|first|last)\s+(\d+)\b", "count"),
        (r"\b(?:min|max|limit)\s*[=:]\s*(\d+)\b", "limit"),
        (r"\bversion\s+(\d+(?:\.\d+)*)\b", "version"),
        (r"\bv(\d+(?:\.\d+)*)\b", "version"),
    ]
    results = []
    for pattern, ptype in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            results.append((match.group(1), ptype))
    # Bare numbers — collected separately and frequency-filtered later
    for match in re.finditer(r"\b(\d{2,4}(?:\.\d+)?)\b", text):
        results.append((match.group(1), "number"))
    return results


def _detect_product_names(text: str) -> list[tuple[str, str]]:
    """Detect potential product/brand names (capitalized words in context)."""
    # Simple heuristic: sequences of 2+ capitalized words not at sentence start
    # Or words in quotes that look like product names
    results = []
    for match in re.finditer(r'"([A-Z][a-zA-Z0-9\s\-]{2,})"', text):
        results.append((match.group(1), "product"))
    for match in re.finditer(r"'([A-Z][a-zA-Z0-9\s\-]{2,})'", text):
        results.append((match.group(1), "product"))
    return results


def _detect_domains(text: str) -> list[tuple[str, str]]:
    """Detect domain names and URLs."""
    results = []
    for match in re.finditer(r"(https?://[^\s<>\"'{}|\\^`\[\]]+)", text):
        results.append((match.group(1), "url"))
    for match in re.finditer(r"\b([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)\b", text):
        results.append((match.group(1), "domain"))
    return results


def _detect_dates(text: str) -> list[tuple[str, str]]:
    """Detect date patterns (YYYY, YYYY-MM, YYYY-Q1, etc.)."""
    patterns = [
        (r"\b(20\d{2})\b", "year"),
        (r"\b(20\d{2}[-–—/](?:0[1-9]|1[0-2]))\b", "year_month"),
        (r"\b(Q[1-4]\s*20\d{2}|20\d{2}\s*Q[1-4])\b", "quarter"),
    ]
    results = []
    for pattern, ptype in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            results.append((match.group(1), ptype))
    return results


def _detect_file_paths(text: str) -> list[tuple[str, str]]:
    """Detect file paths and output formats."""
    results = []
    # File extensions in context
    for match in re.finditer(r"\b([\w\-/\\]+\.(?:md|csv|json|pdf|xlsx?|docx?|txt))\b", text, re.IGNORECASE):
        results.append((match.group(1), "file_path"))
    # Explicit format mentions
    for match in re.finditer(r"(?:format|output)\s*(?:=|as|in|:)\s*(\w+)\b", text, re.IGNORECASE):
        results.append((match.group(1), "format"))
    return results


def _detect_languages_tech(text: str) -> list[tuple[str, str]]:
    """Detect programming languages, frameworks, and tech terms."""
    keywords = {
        "python", "javascript", "typescript", "java", "c++", "c#", "go", "golang",
        "rust", "ruby", "php", "swift", "kotlin", "scala", "haskell", "elixir",
        "react", "vue", "angular", "next.js", "nextjs", "nuxt", "svelte", "django",
        "flask", "fastapi", "spring", "express", "nestjs", "laravel", "rails",
        "pandas", "numpy", "tensorflow", "pytorch", "openai", "gpt", "claude",
        "llama", "mistral", "langchain", "llamaindex", "vector", "embedding",
        "sqlite", "postgres", "mysql", "mongodb", "redis", "elasticsearch",
        "docker", "kubernetes", "k8s", "aws", "gcp", "azure", "terraform",
    }
    results = []
    for kw in keywords:
        pattern = r"\b" + re.escape(kw) + r"\b"
        for match in re.finditer(pattern, text, re.IGNORECASE):
            results.append((match.group(0), "tech"))
    return results


# ──────────────────────────────── Extraction Engine ─────────────────────────────────


def _collect_all_values(goal: str, steps: list[dict]) -> dict[str, list[str]]:
    """Scan all content fields and collect candidate values by type."""
    values_by_type: dict[str, list[str]] = {}

    def scan_text(text: str):
        detectors = [
            _detect_numeric_ranges,
            _detect_product_names,
            _detect_domains,
            _detect_dates,
            _detect_file_paths,
            _detect_languages_tech,
        ]
        for detector in detectors:
            for value, vtype in detector(text):
                if len(value) < 2:  # Skip too-short values
                    continue
                values_by_type.setdefault(vtype, []).append(value.lower())

    scan_text(goal)
    for step in steps:
        if isinstance(step, dict):
            scan_text(step.get("name", ""))
            scan_text(step.get("goal", ""))
            scan_text(step.get("inputs", ""))
            scan_text(step.get("outputs", ""))
            scan_text(step.get("acceptance", ""))
            scan_text(step.get("instruction", ""))

    return values_by_type


def _rank_candidates(values_by_type: dict[str, list[str]]) -> list[tuple[str, str, int]]:
    """Rank candidate parameters by frequency and type quality."""
    type_scores = {
        "product": 10,
        "domain": 8,
        "url": 8,
        "tech": 6,
        "format": 5,
        "file_path": 5,
        "year": 4,
        "quarter": 4,
        "year_month": 4,
        "version": 3,
        "range": 2,
        "count": 2,
        "limit": 1,
        "number": 1,
    }

    all_values = []
    for vtype, values in values_by_type.items():
        if not values:
            continue
        counts = Counter(values)
        for value, freq in counts.items():
            if vtype == "number" and freq < _NUMBER_MIN_FREQ:
                continue
            score = type_scores.get(vtype, 1) * freq
            # Prefer multi-occurrence / longer tokens slightly
            score += min(freq - 1, 3) + min(len(value) // 8, 3)
            all_values.append((value, vtype, score))

    return sorted(all_values, key=lambda x: -x[2])


def _dedupe_substring_values(selected: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Drop shorter values that are substrings of a longer selected value."""
    kept: list[tuple[str, str]] = []
    lowers = []
    # Longer first so shorter leftovers get dropped
    ordered = sorted(selected, key=lambda x: -len(x[0]))
    for value, vtype in ordered:
        vl = value.lower()
        if any(vl != other and vl in other for other in lowers):
            continue
        kept.append((value, vtype))
        lowers.append(vl)
    # Restore score-ish order by reusing input relative ranking among survivors
    order = {v.lower(): i for i, (v, _) in enumerate(selected)}
    return sorted(kept, key=lambda x: order.get(x[0].lower(), 999))


def _make_param_name(value: str, vtype: str, used_names: set[str]) -> str:
    """Generate a meaningful parameter name from value and type."""
    del value  # value only used for uniqueness via used_names
    base_map = {
        "product": "product_name",
        "domain": "domain",
        "url": "base_url",
        "tech": "framework",
        "format": "output_format",
        "file_path": "output_path",
        "year": "target_year",
        "quarter": "quarter",
        "year_month": "target_month",
        "version": "version",
        "range": "range",
        "count": "top_n",
        "limit": "limit",
        "number": "number",
    }

    base = base_map.get(vtype, "param")
    candidate = base
    counter = 1
    while candidate in used_names:
        counter += 1
        candidate = f"{base}_{counter}"
    used_names.add(candidate)
    return candidate


def _generate_labels(param_names: list[str]) -> dict[str, str]:
    """Generate human-readable labels from snake_case parameter names."""
    label_map = {
        "product_name": "产品名称",
        "domain": "域名",
        "base_url": "基础 URL",
        "framework": "技术框架",
        "output_format": "输出格式",
        "output_path": "输出路径",
        "target_year": "目标年份",
        "quarter": "季度",
        "target_month": "目标月份",
        "version": "版本号",
        "range": "范围",
        "top_n": "Top N",
        "limit": "限制数量",
        "number": "数字",
    }
    return {name: label_map.get(name, name.replace("_", " ").title()) for name in param_names}


def extract_parameters_from_plan(
    goal: str,
    steps: list[dict],
    max_params: int = 5,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Extract parameter placeholders from an existing task plan.

    Args:
        goal: The plan_goal from the task
        steps: The plan_steps list from the task
        max_params: Maximum number of parameters to extract

    Returns:
        (rendered_plan, parameters)
        - rendered_plan: Plan dict with values replaced by {{param_name}}
        - parameters: List of AppParameter definitions
    """
    if not isinstance(steps, list):
        steps = []
    values_by_type = _collect_all_values(goal or "", steps)
    ranked = _rank_candidates(values_by_type)

    seen_values: set[str] = set()
    selected: list[tuple[str, str]] = []
    for value, vtype, _ in ranked:
        vl = value.lower()
        if vl in seen_values:
            continue
        if len(selected) >= max_params * 2:  # gather extras then substring-dedupe
            break
        if len(value) <= 2:
            continue
        if vl in _GENERIC_SKIP:
            continue
        seen_values.add(vl)
        selected.append((value, vtype))

    selected = _dedupe_substring_values(selected)[:max_params]

    used_names: set[str] = set()
    param_map: dict[str, str] = {}  # value -> param_name
    # Replace longer values first to avoid partial clobber
    selected_for_replace = sorted(selected, key=lambda x: -len(x[0]))
    for value, vtype in selected_for_replace:
        param_map[value] = _make_param_name(value, vtype, used_names)

    labels = _generate_labels(list(param_map.values()))
    parameters: list[dict[str, Any]] = []
    for value, vtype in selected:
        pname = param_map[value]
        param: dict[str, Any] = {
            "name": pname,
            "label": labels[pname],
            "type": "text",
            "required": True,
            "default": value,
            "description": f"Auto-extracted {vtype} parameter",
        }
        if vtype == "format":
            param["type"] = "select"
            opts = sorted({value.lower(), "markdown", "json", "csv", "html"})
            param["options"] = opts
        elif vtype in ("count", "limit", "number", "year"):
            param["type"] = "number"
        parameters.append(param)

    def render_text(text: str) -> str:
        result = text or ""
        for value, pname in sorted(param_map.items(), key=lambda x: -len(x[0])):
            pattern = re.compile(re.escape(value), re.IGNORECASE)
            result = pattern.sub("{{" + pname + "}}", result)
        return result

    rendered_goal = render_text(goal)
    rendered_steps = []
    for step in steps:
        if isinstance(step, dict):
            rendered_step = dict(step)
            rendered_step["name"] = render_text(step.get("name", ""))
            rendered_step["goal"] = render_text(step.get("goal", ""))
            rendered_step["inputs"] = render_text(step.get("inputs", ""))
            rendered_step["outputs"] = render_text(step.get("outputs", ""))
            rendered_step["acceptance"] = render_text(step.get("acceptance", ""))
            rendered_step["instruction"] = render_text(step.get("instruction", ""))
            rendered_steps.append(rendered_step)
        else:
            rendered_steps.append(step)

    rendered_plan = {
        "goal_template": rendered_goal,
        "steps": rendered_steps,
        "param_count": len(parameters),
    }

    return rendered_plan, parameters


def create_app_from_task(
    task_id: str,
    task_name: str,
    task_description: str,
    plan_goal: str,
    plan_steps: list[dict],
    plan_validation: list[str] | None = None,
    flowchart_mermaid: str = "",
    app_name: str | None = None,
    app_description: str | None = None,
    execution_mode: str = "workflow",
    auto_extract: bool = True,
) -> dict[str, Any]:
    """Create an App definition from an existing task plan.

    This is the core engine behind `POST /api/tasks/{task_id}/save-as-app`.

    Args:
        task_id: Source task ID
        task_name: Source task name
        task_description: Source task description
        plan_goal: Plan goal from task
        plan_steps: Plan steps list from task
        plan_validation: Optional validation list
        flowchart_mermaid: Optional flowchart
        app_name: Override app name (defaults to sanitized task name)
        app_description: Override app description
        execution_mode: Default execution mode for the app
        auto_extract: Enable auto parameter extraction (if False, raw plan with 0 params)

    Returns:
        Complete App document ready for save_app()
    """
    # Extract parameters if enabled
    if auto_extract and plan_goal and plan_steps:
        rendered_plan, parameters = extract_parameters_from_plan(plan_goal, plan_steps)
        goal_template = rendered_plan["goal_template"]
        steps = rendered_plan["steps"]
    else:
        goal_template = plan_goal or ""
        steps = plan_steps or []
        parameters = []

    # Build validation template (preserve structure, don't extract params)
    validation_template = plan_validation or []

    # Generate app name (sanitize task name)
    name = app_name or f"{task_name}"
    # Remove "Task: " prefix if present
    if name.lower().startswith("task: "):
        name = name[6:]

    description = app_description or (
        f"Auto-generated from successful task: {task_name}. "
        f"{len(parameters)} parameter(s) detected."
    )

    ts = utc_now_iso_z().replace(":", "").replace("-", "").replace("T", "").split(".")[0]
    app_id = f"App_{ts}_{uuid.uuid4().hex[:6]}"

    return {
        "id": app_id,
        "name": name,
        "description": description,
        "icon": "📋",
        "category": "extracted",
        "parameters": parameters,
        "steps": steps,
        "goal_template": goal_template,
        "validation_template": validation_template,
        "flowchart_mermaid": flowchart_mermaid or "",
        "execution_mode": execution_mode,
        "auto_run": False,
        "source": "from_task",
        "source_task_id": task_id,
        "version": 1,
        "status": "draft",
        "tags": ["auto-extracted", "from-task"],
        "created_at": utc_now_iso_z(),
        "updated_at": utc_now_iso_z(),
        "usage_count": 0,
        "last_used_at": None,
    }
