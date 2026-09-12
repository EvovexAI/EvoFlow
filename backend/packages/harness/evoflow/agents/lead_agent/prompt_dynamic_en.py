"""English dynamic prompt fragments (assembled in ``prompt.py``). Keep in sync with ``prompt_dynamic_zh``."""

from __future__ import annotations

WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

DEFAULT_DISPLAY_AGENT_NAME = "EvoFlow"

RUNTIME_HOST_HINT_VIRTUAL = "Sandbox mode: deliverables under `outputs/`, uploads under `uploads/`; other file paths per tool schema."

SKILLS_CONTAINER_LABEL_LOCAL = "Local skills directory"

MEMORY_PREAMBLE = "Long-term memory below is reference only; on conflict, follow the latest user message."

AGENT_CUSTOM_PROMPT_WRAPPER = (
    "The following is the agent's system_prompt from config.yaml. It applies together with global role, scenario, and tool policy above. If it conflicts with platform defaults, this section wins (still subject to safety rules at the top)."
)

INTENT_DEBUG_SCENARIO_LABEL = "Current scenario"
INTENT_DEBUG_DESC_LABEL = "Scenario description"
INTENT_DEBUG_MODULES_LABEL = "Active modules"

MISSION_STATE_INTRO = "Prior-turn task snapshot for this turn's priorities (not an archive)."
MISSION_SUMMARY_TAG = "summary"
MISSION_PRIMARY_LABEL = "Primary objective"
MISSION_COMPLETED_LINE = "Completed: yes"
MISSION_ACTIVE_TAG = "active_subproblems"
MISSION_CONSTRAINTS_TAG = "constraints"
MISSION_DONE_TAG = "done_subproblems"
MISSION_SUCCESS_TAG = "success_criteria"
MISSION_OUT_OF_SCOPE_TAG = "out_of_scope"

TOOL_CATALOG_NOT_BOUND = "Not bound, no schema—activate first. n={n}: {pending}"
TOOL_CATALOG_NOT_BOUND_COMPACT = "{n} tools deferred (not bound this turn)—use `tool_search` to enable."
TOOL_CATALOG_RULE_SCHEMA = "Fetch schema only when missing; do not re-search bound tools."
TOOL_CATALOG_RULE_ACTIVATION_POINTER = "Load deferred tools with `tool_search` before calling."
TOOL_CATALOG_DEFERRED_HINT = (
    "Deferred tools (`<available-deferred-tools>`) require "
    '`tool_search(query="select:name")` before calling. '
    'Edits: `query="select:write,replace"`; long jobs: `query="select:process"`; '
    'web: `query="select:web_search,fetch_url"`; research subtasks: `query="select:subagent"`.'
)

PLAN_RUNTIME_NOTE = "note: Task JSON follows supervisor returns; phase is a state-machine hint only."

PHASE_GUARD_PLANNING = """<phase_execution_guard>
Collaboration phase is planning-like (planning/plan_ready/awaiting_exec).
- **Lead role (orchestrator)**: No heavy hands-on repo digging, long reads. **``platform action=agents.list``** (or ``evoflow agents list``) for quick agent lookup; but broad capability surveys (per-agent tools/skills/rate limits) go through **``subagent``** read-only subtasks or ``agents.get``. You still: **``ask_clarification``** with the user; **``plan(goal, steps[])``** after the three gates; orchestrate when allowed. Do not call retired ``list_agents`` / ``create_agent``.
- **Side effects**: No direct write/execute tools in this session; no **`subagent`** for code delivery, shell, installs—those belong to executing via **`supervisor`**. **`subagent`** here is research-only; **no** **`subagent_type=bash`**.
- **`supervisor`**: Without **`has_plan`** (successful **`plan`** tool), **no** **`supervisor`** create/start—submit **`plan`** first. After the user clicks「开始执行」, the gateway authorizes **and auto-dispatches** wave 1; you mainly **`monitor_execution_step`**. Call **`start_execution`** only as fallback if nothing was dispatched. Do not re-ask whether to start.
- **`todo`**: Lightweight in-session checklist—**core tool**, no plan scenario required; **does not write to Task Center**. For cross-session memos/assignment use Task Center inbox or `tasks`; use **`supervisor`** for cross-agent orchestration.
- **Mode switch (user-facing)**: Do not suggest agent until Plan is done; if the user abandons or is stuck, cancel/fail the main task first (see `<plan_workflow>` §5).
- If this conflicts with scenario policy, this phase wins.
</phase_execution_guard>"""

PHASE_GUARD_EXECUTING = """<phase_execution_guard>
Collaboration phase is executing.
- Full execution loop via `supervisor` (dispatch, monitor, validate, converge).
- Parallel read-only recon or cross-checks may still use **`subagent`**—avoid long in-thread tool chains.
- **After all subtasks complete** (`orchestrationPhase=all_subtasks_completed_main_open` or `recommendation.action=finalize_main`): run Plan validation, then `supervisor(set_task_state, status=completed)` or `update_progress(..., progress=100, status=completed)`; phase advances verifying→reflecting→done; no manual `scenario(deactivate, plan)`.
- **Mode switch (user-facing)**: Do not activate agent until Plan is done. If the user wants another mode mid-flight, they must **cancel or mark the main task failed** first via supervisor; only then may agent mode resume. If stuck after retries/steer, terminate the task (cancelled/failed) before suggesting a mode change—no bypass.
- If this conflicts with planning-like rules, executing wins.
</phase_execution_guard>"""

PHASE_GUARD_VERIFYING = """<phase_execution_guard>
Collaboration phase: verifying.
- Run tests/checks (terminal) and read-only inspection against the Plan.
- Do **not** use terminal commands (sed/cat/rm etc.) or any mutating workspace operations.
- After compaction, use `refs:` in `[tool:summary]` / `[tool:history]` and `read` for full persisted output.
</phase_execution_guard>"""

PHASE_GUARD_REFLECTING = """<phase_execution_guard>
Collaboration phase: reflecting.
- Summarize outcomes in 2–5 sentences: what was delivered, evidence, remaining risks.
- No workspace writes; read-only search; use `read` for persisted paths.
- Use `supervisor` to finalize the main task when ready; avoid large new code changes.
</phase_execution_guard>"""

LIVE_COLLAB_INTRO = "Live collaboration/task state for **this thread** (refreshed before each model call; unrelated to summarization)."
LIVE_COLLAB_NO_MAIN = "main_task: (none — subtask list may still refer to a bound main task)"
COMMITTED_PLAN_NOTE = "Committed plan from `plan` tool on this thread (orchestration/validation must match; if summary conflicts, this wins)."
COMMITTED_PLAN_TRUNCATED = " Body truncated for length."

SKILL_SYSTEM_INTRO = "You can use skills for specialized tasks. Each skill documents best practices and steps."
SKILL_PROGRESSIVE_HEADER = "**Progressive loading:**"
SKILL_RULE_1 = (
    '``<location>`` is ``skill:<name>`` (preferred) or a sandbox virtual path; ``read("<location>")`` only when executing skill steps or metadata is insufficient. '
    '**Files only**: ``read("skill:<name>")`` for SKILL.md; **directories** via ``terminal`` (e.g. dir / ls)—never ``read("skill:<name>/scripts")``. '
    'Other files in the same skill: ``skill:<name>/relative/path`` (forward slashes, must be a real file). '
    'For product self-intro / capability overview (e.g. evoflow-intro) when ``<available_skills>`` already has name+description, **do not read SKILL.md**—answer from description. '
)
SKILL_RULE_2 = (
    "Load resources as needed; follow skill steps and boundaries. "
    "Run skill scripts: ``terminal`` for quick commands; ``process`` (start → log/wait/kill) for scripts, tests, or long jobs; "
    "``workdir=\"skill:<name>\"`` with relative command paths (do not use deprecated execute_command)."
)
SKILL_RULE_3 = "Follow skill steps; conversation mode is UI-driven—do not call mode_set/scenario."
SKILL_RULE_COMPACT = (
    "If `<skill_injection>` is present or `<available_skills>` description suffices, do not re-read SKILL.md. "
    "Skills are **not** in the user workspace: read files via ``read(\"skill:<name>/path\")``; "
    "run scripts with ``terminal`` or ``process(action='start')`` and ``workdir=\"skill:<name>\"`` "
    "(command paths relative to the skill root, e.g. ``python scripts/foo.py``). "
    "Never find/grep ``skills/`` or ``SKILL.md`` under the workspace."
)
MCP_RULE_COMPACT = (
    "MCP tools are **native function tools** named ``mcp__<server>__<tool>`` — call them directly. "
    "Do **not** use ``terminal``, ``mcp-terminal``, JSON-RPC, or ``npx`` for MCP. "
    "Skills (``skill:<name>``) and MCP are separate: skills = workflow/docs/scripts; MCP = external connectors."
)
SKILL_DIR_LABEL = "**Skills root (logical; use skill: URIs per SKILL_RULE, not install-dir absolute paths in workspace tools):**"
SKILL_EMPTY_COMMENT = "No skill metadata loaded in this process (disabled or empty catalog). If the UI still lists skills, use ``read(\"skill:<name>\")``."

SUBAGENT_FOCUS_MODE_BLOCK = ""

SUBAGENT_HEADER = ""
SUBAGENT_WHEN_TITLE = ""
SUBAGENT_SUPERVISOR_WHEN_TITLE = ""
SUBAGENT_BOUNDARY_TITLE = ""
SUBAGENT_AVAILABLE_TITLE = "**Available subagents**"
SUBAGENT_MODEL_NOTE = ""
SUBAGENT_GP_LABEL = "(general analysis / retrieval / code exploration)"
SUBAGENT_CODE_LABEL = "(code read/write specialist: search-locate + precise edit + syntax check)"
SUBAGENT_BASH_LABEL = "(command execution)"
SUBAGENT_CLAUDE_LABEL = "(Claude Code client continuous session)"
SUBAGENT_MEDIA_CREW_TITLE = "**Media crew (skill + terminal scripts · pipeline order; do not substitute general-purpose)**"
SUBAGENT_MEDIA_CREW_RULE = "Pipeline: screenwriter → visual-planner → artist → video-director → post; verify outputs/ each step. Image: byted-ark-seedream-skill; video: media-production scripts via terminal."
SUBAGENT_MEDIA_WHEN_BULLETS = ""


# File-edit routing no longer injected here; keep replace/write/delete descriptions short.
EDIT_CORE_GUIDANCE = ""
WORKER_CORE_GUIDANCE = EDIT_CORE_GUIDANCE

# TEMP unused — `_build_task_router_section` returns "" early.
TASK_ROUTER_GUIDANCE = ""
TASK_ROUTER_MIND_MAP_BULLET = ""

# Policy moved to mind_map tool description (MIND_MAP_TOOL_DESCRIPTION).
MIND_MAP_GUIDANCE = ""
KNOWLEDGE_MAP_GUIDANCE = MIND_MAP_GUIDANCE

# Routing moved to subagent / supervisor tool descriptions.
SUBAGENT_WHEN_BULLETS = ""
SUBAGENT_SUPERVISOR_WHEN_BULLETS = ""
SUBAGENT_BOUNDARY_BULLETS = ""

# Policy moved to trae_delegate tool description.
TRAE_POLICY_BODY = ""

LOCAL_HOST_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    (
        "- User uploads: `/mnt/user-data/uploads` - user files (auto-listed in context)",
        "- User uploads: local upload directory (per current system paths)",
    ),
    (
        "- Outputs: `/mnt/user-data/outputs` - final deliverables must go here",
        "- Outputs: local output directory (per current system paths)",
    ),
    (
        "- Output quality: deliverables must be in /mnt/user-data/outputs and be complete",
        "- Output quality: deliverables must be in the local output directory and be complete",
    ),
    (
        "sandbox paths `/mnt/user-data/outputs/`, `/mnt/user-data/uploads/`",
        "local subdirs: `outputs/`, `uploads/`",
    ),
    ("/mnt/acp-workspace/", "local ACP work directory/"),
    ("NOT in `/mnt/user-data/`", "NOT in local upload/work dirs"),
)

LOCAL_HOST_MNT_PREFIX = "/mnt/"
LOCAL_HOST_MNT_REPLACEMENT = "local-path/"


def format_scenario_activated_tools_reminder(
    tools_sample: str,
    extra_count: int,
    *,
    deferred_sample: str = "",
    deferred_extra: int = 0,
) -> str:
    extra_line = f"\n({extra_count} more bound tools not listed; see JSON.)" if extra_count > 0 else ""
    deferred_line = ""
    if deferred_sample.strip():
        d_extra = f"\n({deferred_extra} more deferred; see JSON `deferred_tools`)" if deferred_extra > 0 else ""
        deferred_line = (
            f"\n`deferred_tools` (sample: {deferred_sample}){d_extra} need "
            '`tool_search(query="select:name")` before calling.'
        )
    return (
        "<scenario_activated_tools>\n"
        f"Scenario activated this turn. `activated_tools` are bound with schema—call directly (sample: {tools_sample}){extra_line}"
        f"{deferred_line}\n"
        'Do not tool_search names in `activated_tools`; use `tool_search(query="select:…")` only for '
        "`deferred_tools` or `<available-deferred-tools>` entries.\n"
        "</scenario_activated_tools>"
    )
