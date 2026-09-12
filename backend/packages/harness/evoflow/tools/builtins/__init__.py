from .browser_tool import browser_tool
from .automation_tool import automation_tool
from .catalog_tools import list_assignable_tools_tool, list_skills_catalog_tool
from .clarification_tool import ask_clarification_tool
from .claude_session_tool import claude_session_tool
from .collab_peer_tools import (
    collab_peer_read_tool,
    collab_peer_reply_tool,
    collab_peer_send_tool,
)
from .create_agent_tool import create_agent_tool
from .experience_tool import (
    experience_delete_tool,
    experience_get_tool,
    experience_list_tool,
    experience_mark_used_tool,
    experience_save_tool,
    experience_update_tool,
)
from .goal_report_tool import goal_report_tool  # noqa: F401 — retained for DB compat; no longer bound to LLM
from .kb_search_tool import search_knowledge_base_tool
from .knowledge_vault_tools import knowledge_tool
from .list_agents_tool import list_agents_tool
from .mind_map_tool import mind_map_tool
from .pattern_fix_tool import pattern_fix_tool
from .memory_remember_tool import memory_remember_tool
from .assets_tool import assets_tool
from .person_memory_edit_tool import person_memory_edit_tool
from .plan_tool import plan_tool
from .platform_tool import platform_tool
from .process_tool import process_tool
from .propose_goal_tool import propose_goal_tool
from .read_lints_tool import read_lints_tool
# scenario_activation (mode_set/scenario) — import submodule directly; avoids circular import at startup
from .stage_tool import panel_set_tool, stage_set_tool
from .send_message_tool import send_message_tool
from .session_workspace_tool import session_workspace_tool
from .setup_agent_tool import setup_agent
from .skill_manager_tool import skill_manager_tool
from .subtask_outcome_report_tool import subtask_outcome_report_tool
from .subtask_progress_tool import subtask_progress_report_tool
from .subtask_work_checklist_tool import subtask_work_checklist_tool
from .supervisor_tool import supervisor_tool
from .task_tool import task_tool
from .tasks_tool import tasks_tool
from .todo_tool import todo_tool
from .trae_tool import trae_delegate_tool, trae_new_chat_tool, trae_start_tool, trae_status_tool, trae_switch_mode_tool
from .update_agent_tool import update_agent_tool
from .view_image_tool import view_image_tool

# worker_tool temporarily unregistered (code retained for future re-enablement)
# from .worker_tool import worker_tool

__all__ = [
    "setup_agent",
    "plan_tool",
    "ask_clarification_tool",
    "claude_session_tool",
    "view_image_tool",
    "task_tool",
    "tasks_tool",
    "supervisor_tool",
    "subtask_work_checklist_tool",
    "subtask_outcome_report_tool",
    "subtask_progress_report_tool",
    "collab_peer_send_tool",
    "collab_peer_read_tool",
    "collab_peer_reply_tool",
    "todo_tool",
    # "worker_tool",  # temporarily unregistered (code retained)
    "propose_goal_tool",
    "goal_report_tool",
    "search_knowledge_base_tool",
    "knowledge_tool",
    "platform_tool",
    "automation_tool",
    "create_agent_tool",
    "update_agent_tool",
    "list_assignable_tools_tool",
    "list_skills_catalog_tool",
    "list_agents_tool",
    "mind_map_tool",
    "skill_manager_tool",
    "trae_start_tool",
    "trae_status_tool",
    "trae_new_chat_tool",
    "trae_switch_mode_tool",
    "trae_delegate_tool",
    # "mode_set",  # 暂不导出给主会话挂载（UI 切模式）；实现仍在 scenario_activation
    # "scenario",
    "panel_set_tool",
    "stage_set_tool",
    "session_workspace_tool",
    "send_message_tool",
    "experience_save_tool",
    "experience_list_tool",
    "experience_get_tool",
    "experience_update_tool",
    "experience_mark_used_tool",
    "experience_delete_tool",
    "process_tool",
    "browser_tool",
    "read_lints_tool",
    "pattern_fix_tool",
    "person_memory_edit_tool",
    "memory_remember_tool",
    "assets_tool",
]
