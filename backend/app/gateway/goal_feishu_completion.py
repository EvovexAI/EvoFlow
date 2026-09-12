"""Push goal completion summaries (delegates to :mod:`channel_result_push`)."""

from __future__ import annotations

from app.gateway.channel_result_push import push_markdown_result, resolve_push_target


async def push_markdown_to_default_feishu_chat(*, title: str, markdown_body: str) -> tuple[bool, str]:
    """Legacy Feishu-only entry (automation probes / tests)."""
    resolved = resolve_push_target(push_enabled=True, push_channel="feishu", push_target_id="")
    if not resolved:
        return False, "no_default_chat_id"
    channel, target_id = resolved
    return await push_markdown_result(
        channel=channel,
        target_id=target_id,
        title=title,
        markdown_body=markdown_body,
    )


async def push_goal_completion_markdown(
    *,
    push_enabled: bool,
    push_channel: str | None,
    push_target_id: str | None,
    title: str,
    markdown_body: str,
) -> tuple[bool, str]:
    resolved = resolve_push_target(
        push_enabled=push_enabled,
        push_channel=push_channel,
        push_target_id=push_target_id,
    )
    if not resolved:
        return False, "push_disabled_or_no_target"
    channel, target_id = resolved
    return await push_markdown_result(
        channel=channel,
        target_id=target_id,
        title=title,
        markdown_body=markdown_body,
    )
