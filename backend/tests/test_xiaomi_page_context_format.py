"""format_page_context_block must surface main-chat sessionKey + run state."""

from evoflow.agents.xiaomi.prompt import format_page_context_block


def test_format_includes_chat_session_zh():
    block = format_page_context_block(
        {
            "module": "chat",
            "route": "/chat",
            "label": "主对话 · 报价跟进",
            "contextType": "chat_session",
            "contextId": "agent:main:thread-abc",
            "chat": {
                "sessionKey": "agent:main:thread-abc",
                "title": "报价跟进",
                "runState": "running",
            },
        },
        prompt_language="zh",
    )
    assert "<xiaomi_ui_context>" in block
    assert "sessionKey=agent:main:thread-abc" in block
    assert "运行中" in block
    assert "报价跟进" in block


def test_format_reads_ui_chat_session_fallback():
    block = format_page_context_block(
        {
            "module": "chat",
            "ui": {
                "chatSession": {
                    "sessionKey": "sk-1",
                    "title": "草稿",
                    "runState": "idle",
                }
            },
        },
        prompt_language="zh",
    )
    assert "sessionKey=sk-1" in block
    assert "空闲" in block
