"""Assistant-facing guides returned on platform write results.

The lead agent reads ``assistant_guide.say_to_user`` and relays it to the user
(same pattern as ``settings.get_web_search``). Keep copy short and actionable.
"""

from __future__ import annotations

from typing import Any


def _first_str(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def build_employee_create_assistant_guide(result: dict[str, Any] | None = None) -> dict[str, Any]:
    """Guide after ``employees.create`` / ``employees.hire``."""
    data = result if isinstance(result, dict) else {}
    role = data.get("role") if isinstance(data.get("role"), dict) else {}
    code = _first_str(
        data.get("agent_code"),
        data.get("agentCode"),
        role.get("agent_code"),
        role.get("agentCode"),
    )
    name = _first_str(
        data.get("role_name"),
        data.get("roleName"),
        role.get("role_name"),
        role.get("roleName"),
        data.get("agent_name"),
        code,
    ) or "新员工"
    code_part = f"（代号 `{code}`）" if code else ""

    say = (
        f"「{name}」{code_part}已上岗。你可以用这些方式使唤他：\n"
        f"1. 在面板里打开该员工对话，直接下达需求；\n"
        f"2. 扫码绑定本岗 AI 员工到飞书/企微后，在群里或私聊发消息；\n"
        f"3. 让其他员工或主助手派发任务给他；\n"
        f"4. 按心跳/上班时间自动值班，或点「现在开始工作」。\n"
        f"若要立刻在飞书或企业微信里用，告诉我绑哪个渠道。"
    )
    next_steps = [
        "把 assistant_guide.say_to_user 告诉用户",
        "用户要绑渠道：employees.bind_channel_begin（agent_code + channel=feishu|wecom，confirm=true）",
    ]
    if code:
        next_steps.append(f"查看岗位：employees.get agent_code={code}")

    return {
        "status": "employee_created",
        "summary": f"员工「{name}」已创建/雇佣",
        "say_to_user": say,
        "next_steps": next_steps,
        "agent_code": code or None,
        "role_name": name,
        "bind_channels": ["feishu", "wecom"],
        "instruction": "向用户复述 say_to_user；用户确认渠道后调 employees.bind_channel_begin。",
    }


def build_knowledge_create_assistant_guide(result: dict[str, Any] | None = None) -> dict[str, Any]:
    """Guide after ``knowledge.create``."""
    data = result if isinstance(result, dict) else {}
    base = data.get("base") if isinstance(data.get("base"), dict) else {}
    vault = data.get("vault") if isinstance(data.get("vault"), dict) else {}
    name = _first_str(
        data.get("name"),
        base.get("name"),
        vault.get("name"),
        "新知识库",
    )
    vid = _first_str(
        data.get("kbId"),
        data.get("kb_id"),
        data.get("vaultId"),
        data.get("vault_id"),
        base.get("id"),
        vault.get("id"),
        vault.get("vaultId"),
    )
    id_part = f"（id `{vid}`）" if vid else ""

    say = (
        f"知识库「{name}」{id_part}已建好。接下来你可以：\n"
        f"1. 把文档/笔记交给我，我用 knowledge.ingest 写入；\n"
        f"2. 在对话里让我按主题检索（knowledge.search / recall）；\n"
        f"3. 把该库绑到某个智能体员工，值班与对话时就会自动参考。\n"
        f"直接说要写入什么内容，或要绑给哪位员工即可。"
    )
    next_steps = [
        "把 assistant_guide.say_to_user 告诉用户",
        "写入：knowledge.ingest（vaultId/kbId 均可）",
        "检索：knowledge.search / knowledge.recall",
        "绑到员工：employees.update（knowledge_vault_ids）或创建员工时带上该 id",
    ]
    return {
        "status": "knowledge_created",
        "summary": f"知识库「{name}」已创建",
        "say_to_user": say,
        "next_steps": next_steps,
        "vault_id": vid or None,
        "name": name,
        "instruction": "向用户复述 say_to_user，再按用户意图 ingest / 绑定员工。",
    }


def build_bind_channel_begin_assistant_guide(
    *,
    agent_code: str,
    role_name: str,
    channel: str,
    qr_url: str,
    session_id: str,
) -> dict[str, Any]:
    """Guide after ``employees.bind_channel_begin``.

    QR image is rendered by the frontend under the tool result; say_to_user stays
    short and does not narrate UI chrome.
    """
    ch = str(channel or "").strip().lower()
    labels = {"feishu": "飞书", "wecom": "企业微信", "dingtalk": "钉钉", "weixin": "微信"}
    label = labels.get(ch, ch or "IM")
    name = str(role_name or agent_code or "该员工").strip() or "该员工"
    qr = str(qr_url or "").strip()
    has_qr = bool(qr)

    if has_qr:
        say = (
            f"已为「{name}」发起{label}绑定。"
            f"扫完后把他拉进群，@{name} 即可协作。"
        )
    else:
        say = f"已开始为「{name}」绑定{label}，但未拿到二维码，请稍后再试。"

    return {
        "status": "bind_qr_ready" if has_qr else "bind_qr_missing",
        "summary": f"为「{name}」发起{label}扫码，绑定本岗 AI 员工",
        "say_to_user": say,
        "next_steps": [
            "把 assistant_guide.say_to_user 告诉用户",
        ],
        "agent_code": agent_code,
        "role_name": name,
        "channel": ch,
        "session_id": session_id,
        "qr_url": qr or None,
        "instruction": "向用户复述 say_to_user。",
    }
