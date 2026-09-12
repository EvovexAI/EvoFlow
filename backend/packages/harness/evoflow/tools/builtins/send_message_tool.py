"""Send Message Tool — cross-channel messaging via configured platforms.

Sends a message to a user or channel on connected messaging platforms.
Supports listing available targets and sending messages.
"""

import json
import logging

from langchain.tools import tool

logger = logging.getLogger(__name__)


@tool("send_message", parse_docstring=False)
def send_message_tool(
    message: str,
    *,
    target: str | None = None,
    action: str = "send",
) -> str:
    """Send a message to a connected messaging platform, or list available targets.

    Call with action='list' first to see targets, then send with target set to
    a platform id or platform:channel id (telegram, slack, discord, etc.).
    """
    import os

    if action == "list":
        # Return available channels from environment / config
        channels = []
        if os.environ.get("EVOFLOW_TELEGRAM_BOT_TOKEN"):
            channels.append("telegram (configured)")
        if os.environ.get("EVOFLOW_DISCORD_BOT_TOKEN"):
            channels.append("discord (configured)")
        if os.environ.get("EVOFLOW_SLACK_BOT_TOKEN"):
            channels.append("slack (configured)")

        if not channels:
            return json.dumps({"targets": [], "note": "No messaging platforms configured. Set EVOFLOW_*_BOT_TOKEN environment variables."}, ensure_ascii=False)
        return json.dumps({"targets": channels}, ensure_ascii=False)

    if not message:
        return json.dumps({"error": "No message provided"})

    if not target:
        return json.dumps({"error": "No target specified. Use action='list' first to see available targets."})

    # Dispatch based on platform
    platform = target.split(":")[0].lower() if ":" in target else target.lower()
    channel = target.split(":", 1)[1] if ":" in target else None

    try:
        if platform == "telegram":
            return _send_telegram(message, channel)
        elif platform == "discord":
            return _send_discord(message, channel)
        elif platform == "slack":
            return _send_slack(message, channel)
        else:
            return json.dumps({"error": f"Unknown platform: {platform}. Supported: telegram, discord, slack"})
    except Exception as e:
        logger.debug("send_message failed: %s", e, exc_info=True)
        return json.dumps({"error": str(e)})


def _send_telegram(message: str, channel: str | None) -> str:
    import json
    import os
    import urllib.parse
    import urllib.request

    token = os.environ.get("EVOFLOW_TELEGRAM_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        return json.dumps({"error": "Telegram not configured. Set EVOFLOW_TELEGRAM_BOT_TOKEN"})

    chat_id = channel or os.environ.get("EVOFLOW_TELEGRAM_CHAT_ID", "")
    if not chat_id:
        return json.dumps({"error": "No Telegram chat_id configured. Set EVOFLOW_TELEGRAM_CHAT_ID or specify target"})

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": message, "parse_mode": "Markdown"}).encode()
    resp = urllib.request.urlopen(url, data, timeout=15)
    result = json.loads(resp.read())
    if result.get("ok"):
        return json.dumps({"success": True, "platform": "telegram"})
    return json.dumps({"error": f"Telegram API error: {result}"})


def _send_discord(message: str, channel: str | None) -> str:
    import json
    import os
    import urllib.request

    token = os.environ.get("EVOFLOW_DISCORD_BOT_TOKEN") or os.environ.get("DISCORD_BOT_TOKEN")
    if not token:
        return json.dumps({"error": "Discord not configured. Set EVOFLOW_DISCORD_BOT_TOKEN"})

    channel_id = (channel or "").lstrip("#") if channel else os.environ.get("EVOFLOW_DISCORD_CHANNEL_ID", "")
    if not channel_id:
        return json.dumps({"error": "No Discord channel configured. Specify target or set EVOFLOW_DISCORD_CHANNEL_ID"})

    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    req = urllib.request.Request(
        url,
        data=json.dumps({"content": message}).encode(),
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
        },
    )
    urllib.request.urlopen(req, timeout=15)
    return json.dumps({"success": True, "platform": "discord"})


def _send_slack(message: str, channel: str | None) -> str:
    import json
    import os
    import urllib.request

    token = os.environ.get("EVOFLOW_SLACK_BOT_TOKEN") or os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        return json.dumps({"error": "Slack not configured. Set EVOFLOW_SLACK_BOT_TOKEN"})

    ch = (channel or "").lstrip("#") if channel else os.environ.get("EVOFLOW_SLACK_CHANNEL", "general")

    url = "https://slack.com/api/chat.postMessage"
    req = urllib.request.Request(
        url,
        data=json.dumps({"channel": ch, "text": message, "mrkdwn": True}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=15).read())
    if resp.get("ok"):
        return json.dumps({"success": True, "platform": "slack", "channel": ch})
    return json.dumps({"error": f"Slack API error: {resp.get('error')}"})
