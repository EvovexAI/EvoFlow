"""
Feishu/Lark channel — connects to Feishu via WebSocket (no public IP needed).

⚠️ COMPLIANCE NOTICE
This integration uses the official Feishu Open Platform API (lark-oapi SDK).
Use only with authorized Feishu app credentials and in compliance with the
Feishu Developer Agreement (https://open.feishu.cn/). Not for unauthorized
data collection or bulk messaging without user consent.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_SETTING_KEY = "feishu.automation_learned_chat_id"
_ACCOUNT_SETTING_KEY = "feishu.automation_learned_account_id"


def read_learned_feishu_automation_chat_id() -> str | None:
    from evoflow.persistence import config_repositories as cfg_repo

    raw = cfg_repo.get_app_setting(_SETTING_KEY)
    if raw is None:
        return None
    cid = str(raw).strip()
    return cid or None


def read_learned_feishu_automation_account_id() -> str | None:
    """Bot account_id that last owned the learned chat (``\"\"`` / None = primary)."""
    from evoflow.persistence import config_repositories as cfg_repo

    raw = cfg_repo.get_app_setting(_ACCOUNT_SETTING_KEY)
    if raw is None:
        return None
    return str(raw).strip()


def remember_feishu_automation_chat_from_inbound(
    chat_id: str,
    account_id: str = "",
) -> None:
    from evoflow.persistence import config_repositories as cfg_repo

    cid = str(chat_id or "").strip()
    if not cid:
        return
    aid = str(account_id or "").strip()
    existing = read_learned_feishu_automation_chat_id()
    existing_aid = read_learned_feishu_automation_account_id()
    if existing == cid and existing_aid == aid:
        return
    cfg_repo.set_app_setting(_SETTING_KEY, cid)
    cfg_repo.set_app_setting(_ACCOUNT_SETTING_KEY, aid)
    if existing and existing != cid:
        logger.info(
            "feishu automation: updated default push chat_id (%s -> %s, account=%s)",
            existing,
            cid,
            aid or "primary",
        )
    elif existing_aid != aid:
        logger.info(
            "feishu automation: updated default push account for chat_id=%s (%s -> %s)",
            cid,
            existing_aid or "primary",
            aid or "primary",
        )
    else:
        logger.info(
            "feishu automation: learned default push chat_id from inbound message (account=%s)",
            aid or "primary",
        )
