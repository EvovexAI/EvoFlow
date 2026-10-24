"""Stream card patches must not become duplicate chat bubbles."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.persistence.channel_push_repositories import mirror_channel_push_to_chat


def test_card_patched_is_not_mirrored_to_chat():
    with patch(
        "evoflow.persistence.channel_push_repositories._session_keys_for_push",
        return_value=["agent:emp-x:feishu:oc_1"],
    ) as keys:
        with patch(
            "evoflow.persistence.channel_push_repositories._ensure_transcript_session"
        ) as ensure:
            mirror_channel_push_to_chat(
                push_id="push_1",
                direction="outbound",
                channel="feishu",
                kind="im_message",
                event="card_patched",
                content_summary="我是",
                receive_id="oc_1",
                sender_account_id="emp-x",
            )
            keys.assert_not_called()
            ensure.assert_not_called()


def test_final_im_message_stream_not_mirrored_either():
    """Final IM text is already stored by ChannelManager._finalize_channel_transcript_turn."""
    with patch(
        "evoflow.persistence.channel_push_repositories._session_keys_for_push",
        return_value=["agent:emp-x:feishu:oc_1"],
    ) as keys:
        mirror_channel_push_to_chat(
            push_id="push_2",
            direction="outbound",
            channel="feishu",
            kind="im_message",
            event="sent",
            content_summary="我是智能辅导老师",
            receive_id="oc_1",
            sender_account_id="emp-x",
        )
        keys.assert_not_called()


def test_approval_card_still_mirrored():
    with patch(
        "evoflow.persistence.channel_push_repositories._session_keys_for_push",
        return_value=["proactive:emp-x"],
    ) as keys:
        with patch(
            "evoflow.persistence.channel_push_repositories._ensure_transcript_session",
            return_value="tid",
        ):
            with patch(
                "evoflow.persistence.channel_push_repositories.get_db"
            ) as get_db:
                db = get_db.return_value
                db.execute.return_value.fetchone.return_value = None
                mirror_channel_push_to_chat(
                    push_id="push_3",
                    direction="outbound",
                    channel="feishu",
                    kind="approval_card",
                    event="sent",
                    title="待审批",
                    content_summary="请确认",
                    receive_id="oc_1",
                    role_agent_code="emp-x",
                )
                keys.assert_called_once()
