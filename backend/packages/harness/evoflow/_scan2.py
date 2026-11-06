"""Scan prompt-facing sources for retired tool names (temporary)."""
import re
from pathlib import Path

ROOT = Path(r"d:\dev\github\EvoFlow\backend\packages\harness\evoflow")

RETIRED = [
    "terminal", "read_file", "write_file", "str_replace", "replace_in_file",
    "delete_file", "find_file", "glob", "rg", "find", "ls", "list_dir",
    "list_agents", "create_agent", "update_agent", "panel_set", "stage_set",
    "mind_map", "process", "process_start", "process_log", "process_wait",
    "process_kill", "process_poll", "search_content", "view_image",
    "read_lints", "browser", "browser_navigate", "browser_click",
]

# Only prompt-bearing files.
FILES = [
    "agents/lead_agent/prompt_blocks_zh.py",
    "agents/lead_agent/prompt_blocks_en.py",
    "agents/lead_agent/prompt_dynamic_zh.py",
    "agents/lead_agent/prompt_dynamic_en.py",
    "agents/lead_agent/plan_prompt_blocks_zh.py",
    "agents/lead_agent/plan_prompt_blocks_en.py",
    "agents/lead_agent/prompt.py",
    "agents/lead_agent/agent.py",
    "agents/lead_agent/intent_tool_profile.py",
    "agents/middlewares/collab_phase_middleware.py",
    "agents/middlewares/uploads_middleware.py",
    "agents/middlewares/dynamic_system_prompt_middleware.py",
    "agents/middlewares/memory_live_footer_middleware.py",
    "agents/middlewares/plan_guard_middleware.py",
    "agents/middlewares/loop_detection_middleware.py",
    "agents/middlewares/transcript_middleware.py",
    "agents/middlewares/automation_run_guard_middleware.py",
    "agents/middlewares/proactive_tool_middleware.py",
    "agents/middlewares/session_transcript_hydration_middleware.py",
    "agents/middlewares/tool_timeout_middleware.py",
    "agents/middlewares/session_budget_middleware.py",
    "agents/middlewares/invalid_tool_call_middleware.py",
    "agents/middlewares/memory_runtime_control_middleware.py",
    "agents/middlewares/pre_call_guardrail_agent_middleware.py",
    "tools/builtins/plan_tool.py",
    "tools/builtins/subagent_tool_description.py",
    "tools/builtins/worker_tool.py",
    "tools/builtins/task_tool.py",
    "tools/builtins/scenario_activation.py",
    "tools/builtins/tool_search.py",
    "tools/builtins/supervisor_tool.py",
    "tools/builtins/supervisor/orchestration_hints.py",
    "tools/builtins/supervisor/execution.py",
    "tools/builtins/supervisor/monitor.py",
    "tools/builtins/supervisor/dependency.py",
    "tools/builtins/clarification_tool.py",
    "tools/builtins/stage_tool.py",
    "tools/builtins/assets_tool.py",
    "tools/builtins/knowledge_tool.py",
    "tools/builtins/browser_engine.py",
    "tools/builtins/tasks_tool.py",
    "tools/builtins/todo_tool.py",
    "tools/builtins/trae_tool.py",
    "tools/builtins/supervisor/subtask_outcome_report_tool.py",
    "subagents/builtins/search_worker.py",
    "subagents/builtins/file_worker.py",
    "subagents/builtins/code_agent.py",
    "subagents/builtins/bash_agent.py",
    "subagents/builtins/media_crew.py",
    "subagents/builtins/project_crew.py",
    "exploration_graph/prompt.py",
    "exploration_graph/mind_map_hints.py",
]

# Match tool names inside backticks (prompt-visible mentions).
BACKTICK = re.compile(r"`([^`\n]{1,80})`")

for rel in FILES:
    p = ROOT / rel
    if not p.exists():
        continue
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        for span in BACKTICK.findall(line):
            for name in RETIRED:
                if re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", span):
                    print(f"{rel}:{i}: [{span}]  <-- {name}")
                    break
