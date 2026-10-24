from typing import Any, Literal

from langchain.tools import tool

_ASK_CLARIFICATION_DESCRIPTION = """\
Use this tool when you need to ask the user structured clarification questions \
(zcode AskUserQuestion alignment). Use when blocked on missing info / ambiguity / \
approach choice / risk confirmation. Up to 3 questions per call.
Single question: use `question` + `options` (+ optional `header`). \
Multiple questions: use `questions` (each item: `prompt`, `options`, optional \
`header`, `allow_multiple`, `context`) + `title`.
Each option: a 1-5 word `label`, or an object `{label, description}` where \
`description` is a one-sentence explanation shown under the label in the panel. \
Provide 2-4 mutually exclusive options per question; do NOT add an "Other" option — \
the panel provides a free-text field automatically. \
When one option is clearly the best choice, append "(Recommended)" to its label. \
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
    options: list[Any] | None = None,
    questions: list[dict[str, Any]] | None = None,
    title: str | None = None,
    header: str | None = None,
    category: str | None = None,
) -> str:
    """Ask the user structured clarification (policy in tool description)."""
    # This is a placeholder implementation
    # The actual logic is handled by ClarificationMiddleware which intercepts this tool call
    # and interrupts execution to present the question to the user
    return "Clarification request processed by middleware"
