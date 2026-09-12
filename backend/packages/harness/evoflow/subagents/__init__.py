"""Subagent package — keep this module light to avoid import cycles.

Heavy symbols (executor, registry) are loaded lazily via ``__getattr__``.
Built-in templates under ``subagents.builtins`` only need ``config.SubagentConfig``.
"""

from evoflow.claude_subagent_type import is_claude_code_subagent_type

from .config import SubagentConfig

__all__ = [
    "SubagentConfig",
    "SubagentExecutor",
    "SubagentResult",
    "get_available_subagent_names",
    "get_subagent_config",
    "is_claude_code_subagent_type",
    "list_subagents",
]


def __getattr__(name: str):
    if name in {"SubagentExecutor", "SubagentResult"}:
        from .executor import SubagentExecutor, SubagentResult

        return SubagentExecutor if name == "SubagentExecutor" else SubagentResult
    if name in {"get_available_subagent_names", "get_subagent_config", "list_subagents"}:
        from . import registry as _registry

        return getattr(_registry, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
