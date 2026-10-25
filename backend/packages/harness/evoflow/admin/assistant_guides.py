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


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_str_list(value: Any) -> list[str] | None:
    """Normalize list-like binding fields; ``None`` means inherit-all / unset."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for item in value:
            s = str(item or "").strip()
            if s:
                out.append(s)
        return out
    return []


def _short_list(items: list[str] | None, *, empty: str, inherit: str | None = None, limit: int = 6) -> str:
    if items is None:
        return inherit or "继承全部"
    if not items:
        return empty
    if len(items) <= limit:
        return "、".join(items)
    head = "、".join(items[:limit])
    return f"{head} 等共 {len(items)} 项"


_BINDING_KEYS = (
    "tools",
    "skills",
    "mcp_servers",
    "knowledge_vault_ids",
    "capability_pack",
    "tools_mode",
    "tool_groups",
)


def _has_bindings_signal(*sources: dict[str, Any]) -> bool:
    for src in sources:
        if not src:
            continue
        if any(k in src for k in _BINDING_KEYS):
            return True
        if "bindings_applied" in src and isinstance(src.get("bindings_applied"), dict):
            return True
    return False


def collect_bindings_snapshot(result: dict[str, Any] | None = None) -> dict[str, Any]:
    """Normalize tools / skills / MCP / knowledge from create/hire result payloads."""
    data = result if isinstance(result, dict) else {}
    agent = _as_dict(data.get("agent"))
    role = _as_dict(data.get("role"))
    cfg = _as_dict(data.get("config")) or _as_dict(role.get("config"))
    applied = _as_dict(data.get("bindings_applied")) or _as_dict(agent.get("bindings_applied"))
    present = _has_bindings_signal(applied, data, agent, cfg, role)

    tools = applied.get("tools") if "tools" in applied else None
    if "tools" not in applied:
        if "tools" in data:
            tools = data.get("tools")
        elif "tools" in cfg:
            tools = cfg.get("tools")
        elif "tools" in agent:
            tools = agent.get("tools")
        elif "tool_groups" in cfg:
            tools = cfg.get("tool_groups")

    skills = applied.get("skills") if "skills" in applied else None
    if "skills" not in applied:
        if "skills" in data:
            skills = data.get("skills")
        elif "skills" in cfg:
            skills = cfg.get("skills")
        elif "skills" in agent:
            skills = agent.get("skills")

    mcp = applied.get("mcp_servers") if "mcp_servers" in applied else None
    if "mcp_servers" not in applied:
        if "mcp_servers" in data:
            mcp = data.get("mcp_servers")
        elif "mcp_servers" in agent:
            mcp = agent.get("mcp_servers")

    knowledge: list[str] | None
    if "knowledge_vault_ids" in applied:
        knowledge = _as_str_list(applied.get("knowledge_vault_ids")) or []
    elif "knowledge_vault_ids" in data:
        knowledge = _as_str_list(data.get("knowledge_vault_ids")) or []
    elif "knowledge_vault_ids" in cfg:
        knowledge = _as_str_list(cfg.get("knowledge_vault_ids")) or []
    elif "knowledge_vault_ids" in agent:
        knowledge = _as_str_list(agent.get("knowledge_vault_ids")) or []
    else:
        knowledge = None

    tools_mode = _first_str(applied.get("tools_mode"), data.get("tools_mode") if "tools_mode" in data else "")
    if not tools_mode and present:
        if "tools" in applied or "tools" in data or "tools" in agent or "tools" in cfg:
            if tools is None:
                tools_mode = "inherit_all"
            elif _as_str_list(tools):
                tools_mode = "allowlist"
            else:
                tools_mode = "empty"
        else:
            tools_mode = "empty"

    pack = _first_str(
        applied.get("capability_pack"),
        data.get("capability_pack") if "capability_pack" in data else "",
        agent.get("capability_pack") if "capability_pack" in agent else "",
    )

    return {
        "present": present,
        "tools_mode": tools_mode or ("empty" if present else "unknown"),
        "tools": None if tools is None else _as_str_list(tools),
        "skills": None if skills is None else _as_str_list(skills),
        "mcp_servers": None if mcp is None else _as_str_list(mcp),
        "knowledge_vault_ids": knowledge if knowledge is not None else [],
        "capability_pack": pack or None,
        "tool_groups": _as_str_list(
            applied.get("tool_groups")
            if "tool_groups" in applied
            else (cfg.get("tool_groups") if "tool_groups" in cfg else agent.get("tool_groups"))
        )
        or [],
    }


def format_bindings_checklist(bindings: dict[str, Any] | None = None) -> list[str]:
    """Human-readable binding lines for say_to_user / UI details."""
    snap = bindings if isinstance(bindings, dict) else {}
    if not snap.get("present") and _first_str(snap.get("tools_mode")) in {"", "unknown"}:
        return []
    lines: list[str] = []
    pack = _first_str(snap.get("capability_pack"))
    if pack and pack.lower() != "none":
        lines.append(f"能力包：{pack}")

    tools_mode = _first_str(snap.get("tools_mode"))
    tools = snap.get("tools")
    if tools_mode == "inherit_all" or (tools is None and tools_mode != "empty"):
        lines.append("工具：继承全部可配置工具")
    else:
        lines.append(f"工具：{_short_list(_as_str_list(tools) or [], empty='无（空白名单）')}")

    skills = snap.get("skills")
    lines.append(f"技能：{_short_list(_as_str_list(skills) if skills is not None else [], empty='无')}")

    mcp = snap.get("mcp_servers")
    lines.append(f"MCP：{_short_list(_as_str_list(mcp) if mcp is not None else [], empty='无')}")

    knowledge = _as_str_list(snap.get("knowledge_vault_ids")) or []
    lines.append(f"知识库：{_short_list(knowledge, empty='无')}")
    return lines


def format_bindings_say_block(result: dict[str, Any] | None = None) -> str:
    """Paragraph listing what was bound after create/hire."""
    lines = format_bindings_checklist(collect_bindings_snapshot(result))
    if not lines:
        return ""
    return "已绑定：\n" + "\n".join(f"- {line}" for line in lines)


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
    bindings = collect_bindings_snapshot(data)
    bind_block = format_bindings_say_block(data)
    bind_part = f"\n{bind_block}\n" if bind_block else "\n"

    say = (
        f"「{name}」{code_part}已上岗。{bind_part}"
        f"你可以用这些方式使唤他：\n"
        f"1. 在面板里打开该员工对话，直接下达需求；\n"
        f"2. 扫码绑定本岗 AI 员工到飞书/企微后，在群里或私聊发消息；\n"
        f"3. 让其他员工或主助手派发任务给他；\n"
        f"4. 按心跳/上班时间自动值班，或点「现在开始工作」。\n"
        f"若要立刻在飞书或企业微信里用，告诉我绑哪个渠道。"
    )
    next_steps = [
        "把 assistant_guide.say_to_user 告诉用户（含已绑定的工具/技能/知识库，便于核对）",
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
        "bindings": bindings,
        "bind_channels": ["feishu", "wecom"],
        "instruction": "向用户复述 say_to_user（务必带上已绑定清单）；用户确认渠道后调 employees.bind_channel_begin。",
    }


def build_agent_create_assistant_guide(result: dict[str, Any] | None = None) -> dict[str, Any]:
    """Guide after ``agents.create``."""
    data = result if isinstance(result, dict) else {}
    agent = _as_dict(data.get("agent"))
    code = _first_str(
        data.get("agent_code"),
        data.get("agentCode"),
        agent.get("agent_code"),
        agent.get("agentCode"),
    )
    name = _first_str(
        data.get("agent_name"),
        data.get("agentName"),
        agent.get("agent_name"),
        agent.get("agentName"),
        code,
    ) or "新智能体"
    code_part = f"（代号 `{code}`）" if code else ""
    bindings = collect_bindings_snapshot(data)
    bind_block = format_bindings_say_block(data)
    bind_part = f"\n{bind_block}\n" if bind_block else "\n"

    say = (
        f"智能体「{name}」{code_part}已创建。{bind_part}"
        f"可在智能体页查看或继续用 agents.update 调整绑定；"
        f"若要雇为值班员工，用 employees.create / hire。"
    )
    next_steps = [
        "把 assistant_guide.say_to_user 告诉用户（含已绑定清单，便于核对）",
    ]
    if code:
        next_steps.append(f"查看：agents.get name={code}")
        next_steps.append("调整绑定：agents.update 或 agents.bindings 选 pack 后再 update")

    return {
        "status": "agent_created",
        "summary": f"智能体「{name}」已创建",
        "say_to_user": say,
        "next_steps": next_steps,
        "agent_code": code or None,
        "agent_name": name,
        "bindings": bindings,
        "instruction": "向用户复述 say_to_user（务必带上已绑定的工具/技能/MCP/知识库）。",
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
