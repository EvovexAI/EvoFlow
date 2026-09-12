"""Chat panel tool visibility (gateway-side filter)."""

from evoflow.tools.chat_panel_tools import tool_omit_from_chat_panel


def test_ask_clarification_and_hosted_proposal_stay_on_wire() -> None:
    assert not tool_omit_from_chat_panel("ask_clarification")
    assert not tool_omit_from_chat_panel("propose_goal")


def test_mind_map_visible_in_chat_panel() -> None:
    assert not tool_omit_from_chat_panel("mind_map")
    assert not tool_omit_from_chat_panel({"name": "mind_map", "function": {"name": "mind_map"}})


def test_write_visible_in_chat_panel() -> None:
    assert not tool_omit_from_chat_panel("write")
    assert not tool_omit_from_chat_panel({"name": "write", "function": {"name": "write"}})


def test_scheduler_prefetch_omitted() -> None:
    assert tool_omit_from_chat_panel("scheduler:post_search_read")
    assert tool_omit_from_chat_panel(
        {"name": "read", "args": {"invocation_source": "prefetch"}},
    )
