"""Application document JSON contract + normalize (single write-path for App blobs).

## Storage layers (do not treat as three masters)

```
evoflow_apps              ← 定义真相（SOP 模板：parameters / steps / canvas）
        │ run(parameters)
        ▼
render_plan()             ← 纯内存：{{param}} → 实参，产出 PlanInput
        │
        ├─► evoflow_app_runs     ← 运行索引（parameters 快照 + app_id/version + task_id）
        │
        └─► evoflow_collab_tasks ← 执行实例：plan_goal / plan_steps_json …
                    │
                    └─► evoflow_collab_subtasks  ← 步骤实例（DAG 调度单元）
```

- **App 表**：只存「可复用定义」。不要往里面塞某次运行的结果。
- **Task.plan_***：某次开跑后的**物化 plan**（执行链路必需），不是第二套应用定义。
- **Subtasks**：步骤级运行态，从当次 plan steps 展开。
- **AppRun**：连接「用了哪个 App / 哪版 / 哪些参数 / 哪个 task」，避免在 App 行上堆运行历史细节。

读写 App 时一律经 ``normalize_app_document``，消除 tools CSV vs list、steps.canvas 残留、边与 depends_on 漂移。
"""

from __future__ import annotations

from typing import Any

from evoflow.collab.app_canvas import (
    ANSWER_NODE_ID,
    START_NODE_ID,
    canvas_from_steps,
)

_STEP_CONTENT_KEYS = (
    "name",
    "description",
    "goal",
    "inputs",
    "outputs",
    "acceptance",
    "failure",
    "instruction",
    "model",
    "project_path",
    "mcp_servers",
)

_PARAM_TYPES = frozenset({"text", "textarea", "select", "number"})


def _as_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip()


def _as_str_list(value: Any) -> list[str]:
    """Normalize tools/skills/tags: accept list or comma-separated string."""
    if value is None:
        return []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            s = _as_str(item)
            if s and s not in out:
                out.append(s)
        return out
    if isinstance(value, str):
        parts = [p.strip() for p in value.replace("，", ",").split(",")]
        out = []
        for p in parts:
            if p and p not in out:
                out.append(p)
        return out
    s = _as_str(value)
    return [s] if s else []


def normalize_parameter(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    name = _as_str(raw.get("name") or raw.get("key"))
    if not name:
        return None
    ptype = _as_str(raw.get("type"), "text") or "text"
    if ptype not in _PARAM_TYPES:
        ptype = "text"
    param: dict[str, Any] = {
        "name": name,
        "label": _as_str(raw.get("label"), name) or name,
        "type": ptype,
        "required": bool(raw.get("required", True)),
        "default": _as_str(raw.get("default")),
        "description": _as_str(raw.get("description")),
    }
    options = raw.get("options")
    if isinstance(options, list):
        cleaned = [_as_str(o) for o in options if _as_str(o)]
        if cleaned:
            param["options"] = cleaned
    return param


def normalize_step(raw: Any, index: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    ref = _as_str(raw.get("ref") or raw.get("step_ref") or str(index + 1)) or str(index + 1)
    depends_on = [_as_str(d) for d in (raw.get("depends_on") or []) if _as_str(d)]
    depends_on = [d for d in depends_on if d != ref]

    step: dict[str, Any] = {
        "ref": ref,
        "name": _as_str(raw.get("name")),
        "depends_on": depends_on,
    }
    for key in _STEP_CONTENT_KEYS:
        if key == "name":
            continue
        val = raw.get(key)
        if val is None:
            continue
        text = _as_str(val)
        if text:
            step[key] = text

    agent = _as_str(raw.get("assigned_agent") or raw.get("agent_code") or raw.get("assignee"))
    if agent:
        step["assigned_agent"] = agent

    tools = _as_str_list(raw.get("tools"))
    if tools:
        step["tools"] = tools
    skills = _as_str_list(raw.get("skills"))
    if skills:
        step["skills"] = skills

    checklist = raw.get("work_checklist")
    if isinstance(checklist, list) and checklist:
        step["work_checklist"] = checklist

    # P0: Structured I/O contract - output_schema
    output_schema = raw.get("output_schema")
    if isinstance(output_schema, dict) and output_schema:
        step["output_schema"] = output_schema

    # P0.5-1: Schema enforcement policy (strict|warn|ignore) per-step override
    schema_policy = _as_str(raw.get("schema_enforcement"))
    if schema_policy in ("strict", "warn", "ignore"):
        step["schema_enforcement"] = schema_policy

    # P0.5-3: Input schema + type contract for input_bindings
    input_schema = raw.get("input_schema")
    if isinstance(input_schema, dict) and input_schema:
        step["input_schema"] = input_schema

    # P0: Structured I/O contract - input_bindings
    input_bindings = raw.get("input_bindings")
    if isinstance(input_bindings, dict) and input_bindings:
        cleaned_bindings: dict[str, str] = {}
        for bk, bv in input_bindings.items():
            bk_s = _as_str(bk)
            bv_s = _as_str(bv)
            if bk_s and bv_s:
                cleaned_bindings[bk_s] = bv_s
        if cleaned_bindings:
            step["input_bindings"] = cleaned_bindings

    # P1: step_type "agent" (default) | "condition" (branch node)
    step_type = _as_str(raw.get("step_type") or raw.get("type"), "agent") or "agent"
    if step_type not in ("agent", "condition"):
        step_type = "agent"
    if step_type == "condition":
        step["step_type"] = "condition"
        cond = raw.get("condition")
        if isinstance(cond, dict):
            condition_cfg: dict[str, Any] = {}
            expr_val = _as_str(cond.get("expression"))
            if expr_val:
                condition_cfg["expression"] = expr_val
            true_branch = _as_str(cond.get("true_branch") or cond.get("trueBranch"))
            if true_branch:
                condition_cfg["true_branch"] = true_branch
            false_branch = _as_str(cond.get("false_branch") or cond.get("falseBranch"))
            if false_branch:
                condition_cfg["false_branch"] = false_branch
            if condition_cfg:
                step["condition"] = condition_cfg

    # Never persist layout on steps — canvas_json is the visual track
    return step


def _normalize_canvas(raw: Any, steps: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("nodes"), list) or not raw.get("nodes"):
        return canvas_from_steps(steps)

    nodes: list[dict[str, Any]] = []
    for n in raw.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        node_id = _as_str(n.get("nodeId") or n.get("id"))
        if not node_id:
            continue
        ntype = _as_str(n.get("type"), "agentStep")
        if node_id == START_NODE_ID or ntype == "start":
            ntype = "start"
        elif node_id == ANSWER_NODE_ID or ntype == "answer":
            ntype = "answer"
            node_id = ANSWER_NODE_ID
        else:
            ntype = "agentStep"
        pos = n.get("position") if isinstance(n.get("position"), dict) else {}
        nodes.append(
            {
                "nodeId": node_id,
                "type": ntype,
                "position": {
                    "x": float(pos.get("x") or 0),
                    "y": float(pos.get("y") or 0),
                },
            }
        )

    if not any(n["nodeId"] == START_NODE_ID for n in nodes):
        nodes.insert(
            0,
            {"nodeId": START_NODE_ID, "type": "start", "position": {"x": 48.0, "y": 140.0}},
        )

    step_refs = {s["ref"] for s in steps}
    # Drop canvas agent nodes that no longer exist; keep start/answer; add missing step nodes
    kept: list[dict[str, Any]] = []
    seen_refs: set[str] = set()
    answer_pos: dict[str, float] | None = None
    for n in nodes:
        if n["type"] == "start":
            kept.append(n)
            continue
        if n["type"] == "answer":
            answer_pos = n["position"]
            continue
        if n["nodeId"] not in step_refs:
            continue
        kept.append(n)
        seen_refs.add(n["nodeId"])
    for s in steps:
        if s["ref"] in seen_refs:
            continue
        # fallback position from canvas_from_steps later merge
        built = canvas_from_steps([s])
        agent_nodes = [x for x in built["nodes"] if x["type"] == "agentStep"]
        if agent_nodes:
            kept.append(agent_nodes[0])
    # Preserve at most one answer sink (visual + answer_from_ref pointer)
    if answer_pos is not None or any(
        isinstance(e, dict) and _as_str(e.get("target")) == ANSWER_NODE_ID
        for e in (raw.get("edges") or [])
        if isinstance(raw.get("edges"), list)
    ):
        kept.append(
            {
                "nodeId": ANSWER_NODE_ID,
                "type": "answer",
                "position": answer_pos
                or {"x": 720.0, "y": 140.0},
            }
        )

    edges_in = raw.get("edges") if isinstance(raw.get("edges"), list) else []
    edges: list[dict[str, Any]] = []
    valid_ids = {n["nodeId"] for n in kept}
    answer_edge: dict[str, Any] | None = None
    for e in edges_in:
        if not isinstance(e, dict):
            continue
        src = _as_str(e.get("source"))
        tgt = _as_str(e.get("target"))
        if not src or not tgt or src not in valid_ids or tgt not in valid_ids:
            continue
        if src == tgt:
            continue
        # Answer sink: only step → answer; keep a single inbound edge
        if tgt == ANSWER_NODE_ID:
            if src == START_NODE_ID or src == ANSWER_NODE_ID or src not in step_refs:
                continue
            answer_edge = {
                "source": src,
                "target": ANSWER_NODE_ID,
                "sourceHandle": _as_str(e.get("sourceHandle"), "out") or "out",
                "targetHandle": _as_str(e.get("targetHandle"), "in") or "in",
            }
            continue
        if src == ANSWER_NODE_ID:
            continue
        edges.append(
            {
                "source": src,
                "target": tgt,
                "sourceHandle": _as_str(e.get("sourceHandle"), "out") or "out",
                "targetHandle": _as_str(e.get("targetHandle"), "in") or "in",
            }
        )
    if answer_edge is not None:
        edges.append(answer_edge)

    canvas: dict[str, Any] = {"nodes": kept, "edges": edges}
    vp = raw.get("viewport")
    if isinstance(vp, dict) and vp.get("zoom") is not None:
        try:
            canvas["viewport"] = {
                "x": float(vp.get("x") or 0),
                "y": float(vp.get("y") or 0),
                "zoom": float(vp.get("zoom") or 1),
            }
        except (TypeError, ValueError):
            pass
    return canvas


def _ensure_edges_from_depends_on(
    steps: list[dict[str, Any]], canvas: dict[str, Any]
) -> dict[str, Any]:
    """Rebuild canvas business edges from depends_on ONLY when canvas has zero edges.

    If canvas already has edges (even only start->node), the user has been
    editing the canvas and intentionally set the current edge set. We must
    NOT silently restore deleted business edges from steps.depends_on,
    otherwise the user cannot achieve parallel execution by deleting all
    node-to-node connections (F7).
    """
    edges = [e for e in (canvas.get("edges") or []) if isinstance(e, dict)]
    if edges:
        # Canvas has edges (any kind) - respect user's current edge set
        return canvas

    refs = {s["ref"] for s in steps}
    rebuilt: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for step in steps:
        tgt = step["ref"]
        for dep in step.get("depends_on") or []:
            src = _as_str(dep)
            if not src or src == tgt or src not in refs:
                continue
            key = (src, tgt)
            if key in seen:
                continue
            seen.add(key)
            rebuilt.append(
                {
                    "source": src,
                    "target": tgt,
                    "sourceHandle": "out",
                    "targetHandle": "in",
                }
            )
    if not rebuilt:
        return canvas

    start_edges = [e for e in edges if _as_str(e.get("source")) == START_NODE_ID]
    out = dict(canvas)
    out["edges"] = start_edges + rebuilt
    return out


def _sync_depends_on_from_canvas(
    steps: list[dict[str, Any]], canvas: dict[str, Any]
) -> list[dict[str, Any]]:
    """Execution truth: depends_on derived from non-start canvas edges."""
    incoming: dict[str, list[str]] = {}
    step_refs = {s["ref"] for s in steps}
    for e in canvas.get("edges") or []:
        if not isinstance(e, dict):
            continue
        src = _as_str(e.get("source"))
        tgt = _as_str(e.get("target"))
        if not src or not tgt or src == START_NODE_ID:
            continue
        # Answer sink is not an executable step — ignore for depends_on
        if src == ANSWER_NODE_ID or tgt == ANSWER_NODE_ID:
            continue
        if tgt not in step_refs or src not in step_refs:
            continue
        incoming.setdefault(tgt, [])
        if src not in incoming[tgt]:
            incoming[tgt].append(src)

    # canvas 没有业务边时，保留步骤上已有 depends_on，避免被清空
    if not incoming:
        return list(steps)

    synced: list[dict[str, Any]] = []
    for step in steps:
        row = dict(step)
        row["depends_on"] = list(incoming.get(step["ref"], []))
        synced.append(row)
    return synced


def _answer_from_ref_from_canvas(canvas: dict[str, Any], step_refs: set[str]) -> str:
    """Prefer the step that feeds the answer sink node."""
    for e in canvas.get("edges") or []:
        if not isinstance(e, dict):
            continue
        if _as_str(e.get("target")) != ANSWER_NODE_ID:
            continue
        src = _as_str(e.get("source"))
        if src in step_refs:
            return src
    return ""


def _ensure_start_edges(canvas: dict[str, Any]) -> dict[str, Any]:
    edges = [e for e in (canvas.get("edges") or []) if isinstance(e, dict)]
    any_in = {_as_str(e.get("target")) for e in edges}
    nodes = canvas.get("nodes") or []
    extra: list[dict[str, Any]] = []
    for n in nodes:
        if not isinstance(n, dict) or n.get("type") in ("start", "answer"):
            continue
        nid = _as_str(n.get("nodeId"))
        if nid == ANSWER_NODE_ID:
            continue
        if nid and nid not in any_in:
            extra.append(
                {
                    "source": START_NODE_ID,
                    "target": nid,
                    "sourceHandle": "out",
                    "targetHandle": "in",
                }
            )
    if extra:
        canvas = dict(canvas)
        canvas["edges"] = edges + extra
    return canvas


def normalize_app_document(document: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``document`` with parameters/steps/canvas normalized.

    Safe to call on create/update/load. Does not invent name/id.
    """
    doc = dict(document)

    params_raw = doc.get("parameters")
    if not isinstance(params_raw, list):
        params_raw = []
    parameters: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for raw in params_raw:
        p = normalize_parameter(raw)
        if not p or p["name"] in seen_names:
            continue
        seen_names.add(p["name"])
        parameters.append(p)
    doc["parameters"] = parameters

    steps_raw = doc.get("steps")
    if not isinstance(steps_raw, list):
        steps_raw = []
    steps: list[dict[str, Any]] = []
    seen_refs: set[str] = set()
    for i, raw in enumerate(steps_raw):
        s = normalize_step(raw, i)
        if not s or s["ref"] in seen_refs:
            continue
        seen_refs.add(s["ref"])
        steps.append(s)

    canvas = _normalize_canvas(doc.get("canvas"), steps)
    canvas = _ensure_edges_from_depends_on(steps, canvas)
    canvas = _ensure_start_edges(canvas)
    steps = _sync_depends_on_from_canvas(steps, canvas)

    doc["steps"] = steps
    doc["canvas"] = canvas

    step_refs = {s["ref"] for s in steps}
    from_canvas = _answer_from_ref_from_canvas(canvas, step_refs)
    explicit = _as_str(doc.get("answer_from_ref"))
    if from_canvas:
        doc["answer_from_ref"] = from_canvas
    elif explicit and explicit in step_refs:
        doc["answer_from_ref"] = explicit
        # Ensure answer node + edge exist so canvas round-trips
        nodes = list(canvas.get("nodes") or [])
        if not any(
            isinstance(n, dict) and _as_str(n.get("nodeId")) == ANSWER_NODE_ID for n in nodes
        ):
            nodes.append(
                {
                    "nodeId": ANSWER_NODE_ID,
                    "type": "answer",
                    "position": {"x": 720.0, "y": 140.0},
                }
            )
            canvas = dict(canvas)
            canvas["nodes"] = nodes
        edges = [
            e
            for e in (canvas.get("edges") or [])
            if isinstance(e, dict) and _as_str(e.get("target")) != ANSWER_NODE_ID
        ]
        edges.append(
            {
                "source": explicit,
                "target": ANSWER_NODE_ID,
                "sourceHandle": "out",
                "targetHandle": "in",
            }
        )
        canvas = dict(canvas)
        canvas["edges"] = edges
        doc["canvas"] = canvas
    else:
        doc["answer_from_ref"] = ""

    tags = doc.get("tags")
    if tags is not None:
        doc["tags"] = _as_str_list(tags)

    validation = doc.get("validation_template")
    if isinstance(validation, list):
        doc["validation_template"] = [_as_str(v) for v in validation if _as_str(v)]
    elif validation is None:
        doc["validation_template"] = []

    if "goal_template" in doc:
        doc["goal_template"] = _as_str(doc.get("goal_template"))
    if "flowchart_mermaid" in doc:
        doc["flowchart_mermaid"] = _as_str(doc.get("flowchart_mermaid"))

    mode = _as_str(doc.get("execution_mode"), "workflow") or "workflow"
    if mode not in ("workflow", "lead_supervised"):
        mode = "workflow"
    doc["execution_mode"] = mode

    status = _as_str(doc.get("status"), "draft") or "draft"
    if status not in ("draft", "published", "archived"):
        status = "draft"
    doc["status"] = status

    # Final rollup config — mandatory for multi-step workflows; default "auto".
    rollup_mode = _as_str(doc.get("final_rollup"), "auto") or "auto"
    if rollup_mode not in ("off", "answer_node_only", "auto"):
        rollup_mode = "auto"
    doc["final_rollup"] = rollup_mode
    doc["final_rollup_agent"] = _as_str(doc.get("final_rollup_agent"))
    doc["final_rollup_instruction"] = _as_str(doc.get("final_rollup_instruction"))

    # P0.5-1: App-level schema enforcement policy (strict|warn|ignore)
    app_policy = _as_str(doc.get("schema_enforcement"), "warn") or "warn"
    if app_policy not in ("strict", "warn", "ignore"):
        app_policy = "warn"
    doc["schema_enforcement"] = app_policy

    return doc
