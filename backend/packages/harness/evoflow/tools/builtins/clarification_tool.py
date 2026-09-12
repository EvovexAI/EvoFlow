from typing import Any, Literal

from langchain.tools import tool


_ASK_CLARIFICATION_DESCRIPTION = """\
Structured clarification for EvoPanel sidebar (do not list options only in chat).
Use when blocked on missing info / ambiguity / approach / risk; max 3 questions.
Single: question + options[]. Multi: questions[{prompt,options,id?,context?,allow_multiple?}] + title.
Types: missing_info | ambiguous_requirement | approach_choice | risk_confirmation | suggestion.
Execution pauses until the user answers in the panel.
"""


# return_direct MUST be True: LangChain ``create_agent``'s ``_make_tools_to_model_edge``
# otherwise **always** routes tools → model again unless every client-side tool in the
# batch has ``return_direct`` (see langchain/agents/factory.py). Without this, after
# ClarificationMiddleware returns ``Command(goto=END)`` the graph can still re-enter the
# model and loop on another ``ask_clarification`` before the user answers.
@tool("ask_clarification", description=_ASK_CLARIFICATION_DESCRIPTION, parse_docstring=False, return_direct=True)
def ask_clarification_tool(
    question: str = "",
    clarification_type: Literal[
        "missing_info",
        "ambiguous_requirement",
        "approach_choice",
        "risk_confirmation",
        "suggestion",
    ] = "missing_info",
    context: str | None = None,
    options: list[str] | None = None,
    questions: list[dict[str, Any]] | None = None,
    title: str | None = None,
    category: str | None = None,
) -> str:
    """Ask the user structured clarification (policy in tool description)."""
    # This is a placeholder implementation
    # The actual logic is handled by ClarificationMiddleware which intercepts this tool call
    # and interrupts execution to present the question to the user
    return "Clarification request processed by middleware"
