"""内置子智能体配置（代码侧默认值，可与 agents 目录持久化合并）。"""

from .bash_agent import BASH_AGENT_CONFIG
from .claude_session_worker import CLAUDE_CODE_WORKER_CONFIG, CLAUDE_SESSION_WORKER_CONFIG
from .code_agent import CODE_AGENT_CONFIG
from .file_worker import FILE_WORKER_CONFIG
from .general_purpose import GENERAL_PURPOSE_CONFIG
from .knowledge_curator import KNOWLEDGE_CURATOR_CONFIG
from .knowledge_retriever import KNOWLEDGE_RETRIEVER_CONFIG
from .finance_crew import FINANCE_CREW_SUBAGENTS
from .marketing_crew import MARKETING_SOCIAL_MEDIA_OPERATION_CONFIG
from .media_crew import MEDIA_CREW_SUBAGENTS
from .hyperframes_crew import HYPERFRAMES_CREW_SUBAGENTS
from .project_crew import PROJECT_CREW_SUBAGENTS
from .search_worker import SEARCH_WORKER_CONFIG

__all__ = [
    "GENERAL_PURPOSE_CONFIG",
    "CODE_AGENT_CONFIG",
    "FILE_WORKER_CONFIG",
    "SEARCH_WORKER_CONFIG",
    "BASH_AGENT_CONFIG",
    "CLAUDE_CODE_WORKER_CONFIG",
    "CLAUDE_SESSION_WORKER_CONFIG",
    "MARKETING_SOCIAL_MEDIA_OPERATION_CONFIG",
    "KNOWLEDGE_RETRIEVER_CONFIG",
    "KNOWLEDGE_CURATOR_CONFIG",
    "MEDIA_CREW_SUBAGENTS",
    "HYPERFRAMES_CREW_SUBAGENTS",
    "PROJECT_CREW_SUBAGENTS",
    "FINANCE_CREW_SUBAGENTS",
    "BUILTIN_SUBAGENTS",
]

# Registry of built-in subagents shown in the agent picker / materialize loop.
# Ephemeral worker templates (file-worker, search-worker) stay importable but
# are intentionally omitted — same pattern as search-worker historically.
BUILTIN_SUBAGENTS = {
    "general-purpose": GENERAL_PURPOSE_CONFIG,
    "code-agent": CODE_AGENT_CONFIG,
    "bash": BASH_AGENT_CONFIG,
    "claude-code": CLAUDE_CODE_WORKER_CONFIG,
    "marketing-social-media-operation": MARKETING_SOCIAL_MEDIA_OPERATION_CONFIG,
    "knowledge-retriever": KNOWLEDGE_RETRIEVER_CONFIG,
    "knowledge-curator": KNOWLEDGE_CURATOR_CONFIG,
    **MEDIA_CREW_SUBAGENTS,
    **HYPERFRAMES_CREW_SUBAGENTS,
    **PROJECT_CREW_SUBAGENTS,
    **FINANCE_CREW_SUBAGENTS,
}
