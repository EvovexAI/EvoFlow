"""小V提示词配套工具（职责文本 + 页面上下文注入）。

小V 提示词按「风格 / 职责」两层拆分，运行时经 ``_inject_identity_layers`` 注入：
- ``<agent_system_prompt>`` = 职责与约束（本模块 ``DUTY_SYSTEM_PROMPT``，
  由 ``agents_config`` 播种到 xiaomi agent 的 ``system_prompt`` 字段）。
- ``<soul>`` = 风格（``assets/builtin_agent_souls/xiaomi.md``：语气、例句、心情、语音轮），
  排在职责块之后。

本模块同时保留页面上下文（<xiaomi_ui_context>）的格式化与清理工具——
它走 live footer（临时 HumanMessage），不进系统提示词，避免打爆前缀缓存。
"""

from __future__ import annotations

DUTY_SYSTEM_PROMPT = """# 小V · 职责与约束

## 你怎么做事

- 管整个平台的智能体员工与全局 Task：向任意在岗员工派活、催办、行政配置；不受组织上下级/平级/workspace 限制（与真人用户同权）。
- 行动闭环：看名册 → 看进度 → 派发/催办 → 用白话汇报；不要靠反复询问用户来代替查工具。
- 用法、概念、产品文档类问题：先 `platform` → `knowledge.search`（本地自有知识库），再基于片段回答。
- 平台行政（改模型、知识库、工作流、雇员工、记待办、配搜索、查报错等）：只走 `platform`，主动办完，不要只会指路设置页。
- 用户画像与记忆：用户说「记住我喜欢…」「我是做…的」，或想看/改自己的画像、偏好、过往经验，走 `assets`（search / read / note / profile）；会话记忆关闭时该工具不可用，别硬调。

## 带用户看见

用户的第一眼很重要：聊到什么值得看的，就把它摆到他眼前，别只丢一个链接或一段白话。

- 展示走 `platform` 的 `ui.show`（刷新用 `ui.update`，收起用 `ui.hide`），内容出现在右侧面板，用户立刻能看到。
- 平台支持展示的都可以开：任务工作流图 `kind=collab-workflow`（data.mainTaskId）；员工执行过程 `kind=employeeProcess`（data.taskId+agentCode）；节点进度/对话 `kind=collabSubtaskTranscript`。
- 网页 `kind=web-embed`（data.url）：找到值得看的页面就替用户打开，不要只在聊天里贴裸链接。
- 文件、图片、视频等产物 `kind=artifacts`（data.items[{type, path|url|content, name?}]）。
- 本地文件、图片、日志也可以直接用 `read` 读：读取的内容会以卡片出现在对话里，点开就在右侧面板看全文（图片直接显示）——用户问「这文件里写了啥 / 这图什么样」，读了就等于给他看了。要「自动弹开右侧面板」的主动展示（成品文件/图片/视频），仍走 `ui.show` 的 `artifacts`。
- 时机：派完活、查到进度、找到资料、产出文件时主动展示；但别对每次写操作都开，别刷屏。

## 标准动作（全部走 `platform`）

### A. 员工与任务

1. `employees.org_status`：有多少员工、谁空闲/忙碌、谁有待审批。
2. `employees.board_overview`：各岗未结 Task 与进度；关注 stuck_candidates。
3. 用户问「某人在干嘛 / 进度」→ `employees.brief`（可带中文岗位名）。
4. 用户问「某个任务怎么样了 / 汇报」→ `tasks.get`（传 task_id）。
5. 推进（`source=xiaomi`）：新事项 → `employees.dispatch`；已有 Task / 卡住 → `employees.wake`（带 task_id）。写操作确认后再 confirm=true。
6. 汇报：员工数、未结数、刚催/派了谁、用户去哪看轨迹；值得看的用 `ui.show` 摆到用户眼前。

### B. 知识与用法

1. `knowledge.search`：检索本地自有知识库（owned）。
2. 用返回的 title/path/snippet（或 entries）回答；必要时口头点明来源。
3. 无命中或无知识库：明确告知，或用 knowledge.* 建库/写入；禁止编造。

### C. 其它行政

不熟先 catalog/help → `action=域名.功能`；写操作确认后再 confirm=true。
易混：items=备忘；tasks=工单；todo=对话勾选；agents=角色；employees=在岗。报错用 diagnostics。勿另开行政工具名。

### D. 终端 / MCP / 技能

- 本机命令用 `bash`；已启用的 MCP 工具可直接调。
- 浏览器、电脑控制：按已注入技能说明操作（插件开关打开时可用）。

## 禁止

- 不亲自改仓库代码、不冒充工程师岗改业务工程；杂活优先派员工或走 platform。
- 不调用澄清/询问类工具空转；缺岗位信息就先查名册与看板再决定。
- 不给自己派实现类活。
- 不编造虚假人类经历；不谄媚吹捧；不写免责声明。
- 已结勿再派：reviewed / completed / cancelled 的 Task 禁止再 `employees.wake` / `employees.dispatch`「重试」。
  结果文案里出现「等待超时」但状态已是 reviewed/completed，说明活已干完、只是轮次收尾超时——向用户说明即可，不要再派一遍。
- 同主题多张 pending 时只催一张，其余建议关掉，禁止叠派「包装单」。

## 工作边界（自己知道 · 别背诵）

- 闭环一律 `platform`：org_status → board_overview → brief → dispatch / wake → 白话一两句。
- 文档 `knowledge.search`；单任务 `tasks.get`；行政 catalog→确认→执行；值得看的主动 `ui.show`。
- 另有 `bash`、`read`（只读文件：日志/导出/文档，用户提「看看这个文件」直接读）、`assets`（记忆/画像/经验读写）、已启用 MCP；浏览器 / 电脑控制技能（插件开着时）可直接用。
"""


def duty_system_prompt() -> str:
    """Return the xiaomi duty/constraint prompt (seeded into ``system_prompt``)."""
    return DUTY_SYSTEM_PROMPT.strip()


def strip_xiaomi_ui_context_from_system_prompt(text: str) -> str:
    """Remove stale ``<xiaomi_ui_context>`` blocks before live footer re-injection."""
    import re

    out = re.sub(
        r"<xiaomi_ui_context>[\s\S]*?</xiaomi_ui_context>\s*",
        "\n",
        str(text or ""),
        flags=re.IGNORECASE,
    )
    return re.sub(r"\n{3,}", "\n\n", out).rstrip()


def _clip_text(value: object, limit: int = 120) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


_MODULE_LABEL_ZH = {
    "workflow": "工作流",
    "tasks": "任务中心",
    "items": "待办事项",
    "employees": "智能体员工",
    "knowledge": "知识库",
    "settings": "设置",
    "chat": "主对话",
    "home": "首页",
}

_MODULE_HINT_ZH = {
    "workflow": "当前是「工作流」页（创建/改参数/运行），不是任务中心，也不是待办事项。",
    "tasks": "当前是「任务中心」（协作任务台账），不是工作流编辑页，也不是个人待办列表。",
    "items": "当前是「待办/我的事项」，不是工作流，也不是任务中心台账。",
    "employees": "当前是「智能体员工」，可管岗位与派活。",
    "knowledge": "当前是「知识库」。",
    "settings": "当前是「设置」。",
    "chat": "当前在主对话工作台旁协助。",
}

_MODULE_HINT_EN = {
    "workflow": "User is on Workflows (create/edit/run), NOT Task Center or personal todos.",
    "tasks": "User is on Task Center (collab ledger), NOT the workflow editor.",
    "items": "User is on personal todos/items, NOT workflows or Task Center.",
    "employees": "User is on AI employees.",
    "knowledge": "User is on Knowledge.",
    "settings": "User is on Settings.",
    "chat": "User is beside the main chat workbench.",
}


def format_page_context_block(
    page_context: dict | None,
    *,
    prompt_language: str | None = None,
) -> str:
    """Format panel ``xiaomi_page_context`` for an ephemeral HumanMessage footer.

    Used by ``XiaomiUiContextLiveFooterMiddleware`` (``name=xiaomi_ui_context``).
    Do not put this in the system prompt — that busts prefix cache on every nav.
    """
    if not isinstance(page_context, dict) or not page_context:
        return ""

    lang = (prompt_language or "zh").strip().lower()
    en = lang.startswith("en")

    lines: list[str] = []
    module = _clip_text(page_context.get("module"), 40)
    label = _clip_text(page_context.get("label"), 80)
    route = _clip_text(page_context.get("route"), 120)
    context_type = _clip_text(page_context.get("contextType"), 40)
    context_id = _clip_text(page_context.get("contextId"), 80)
    module_key = (module or "").strip().lower()

    if module or label or route:
        if en:
            bits = []
            if module:
                bits.append(f"module={module}")
            if label:
                bits.append(f"screen={label}")
            if route:
                bits.append(f"route={route}")
            if context_type:
                bits.append(f"type={context_type}")
            if context_id:
                bits.append(f"id={context_id}")
            lines.append("Now viewing: " + "; ".join(bits))
        else:
            bits = []
            if module:
                zh = _MODULE_LABEL_ZH.get(module_key) or module
                bits.append(f"模块={zh}({module})" if zh != module else f"模块={module}")
            if label:
                bits.append(f"页面={label}")
            if route:
                bits.append(f"路由={route}")
            if context_type:
                bits.append(f"类型={context_type}")
            if context_id:
                bits.append(f"实体={context_id}")
            lines.append("用户当前界面：" + "；".join(bits))

    hint = (_MODULE_HINT_EN if en else _MODULE_HINT_ZH).get(module_key)
    if hint:
        lines.append(hint)

    ui = page_context.get("ui")
    if isinstance(ui, dict) and ui:
        page_title = _clip_text(ui.get("pageTitle"), 80)
        if page_title:
            lines.append(("Title: " if en else "标题：") + page_title)
        tabs = ui.get("activeTabs")
        if isinstance(tabs, list) and tabs:
            tab_s = "、".join(_clip_text(t, 40) for t in tabs[:4] if _clip_text(t, 40))
            if tab_s:
                lines.append(("Active tabs: " if en else "当前 Tab：") + tab_s)
        filters = ui.get("filters")
        if isinstance(filters, list) and filters:
            filt_s = "、".join(_clip_text(t, 40) for t in filters[:4] if _clip_text(t, 40))
            if filt_s:
                lines.append(("Filters: " if en else "筛选：") + filt_s)
        selected = ui.get("selected")
        if isinstance(selected, list) and selected:
            sel_bits: list[str] = []
            for row in selected[:6]:
                if isinstance(row, dict):
                    lab = _clip_text(row.get("label") or row.get("id"), 60)
                    rid = _clip_text(row.get("id"), 40)
                    if lab and rid and lab != rid:
                        sel_bits.append(f"{lab}({rid})")
                    elif lab:
                        sel_bits.append(lab)
                else:
                    lab = _clip_text(row, 60)
                    if lab:
                        sel_bits.append(lab)
            if sel_bits:
                lines.append(("Selected: " if en else "已选：") + "；".join(sel_bits))
        focus = ui.get("focus")
        if isinstance(focus, dict) and focus:
            fname = _clip_text(focus.get("name"), 60)
            fkind = _clip_text(focus.get("kind"), 20)
            if fname:
                lines.append(("Focus: " if en else "焦点：") + (f"{fkind} · " if fkind else "") + fname)
            draft = _clip_text(ui.get("focusDraftPreview"), 80)
            if draft:
                lines.append(("Draft preview: " if en else "输入预览：") + draft)

    recent = page_context.get("recentActivity")
    if isinstance(recent, list) and recent:
        cur_label = (label or "").strip()
        cur_mod = module_key
        act_bits: list[str] = []
        for row in recent[-6:]:
            if not isinstance(row, dict):
                continue
            typ = _clip_text(row.get("type"), 30)
            lab = _clip_text(row.get("label") or row.get("entityId") or row.get("detail"), 50)
            row_mod = _clip_text(row.get("module"), 40).lower()
            # Skip noise: empty rows, or route entries that are the current screen.
            if not typ and not lab:
                continue
            if typ == "route" and ((lab and cur_label and lab == cur_label) or (row_mod and cur_mod and row_mod == cur_mod)):
                continue
            if typ and lab:
                act_bits.append(f"{typ}:{lab}")
            elif typ:
                act_bits.append(typ)
            elif lab:
                act_bits.append(lab)
        if act_bits:
            lines.append(("Past nav (not current screen): " if en else "路过页面（不是当前位置）：") + " → ".join(act_bits))

    if not lines:
        return ""

    guidance = (
        "The Now viewing line is authoritative for where the user is. Ignore older chat turns that mention a different module. Prefer platform tools matching the module. Do not invent entities not listed here."
        if en
        else "「用户当前界面」为准：用户问「这里/当前页」时按模块回答，不要沿用对话历史里其它模块（例如把工作流说成任务中心/待办）。优先按模块走 platform 对应域；未列出的实体不要臆造。"
    )
    body = "\n".join(lines)
    return f"<xiaomi_ui_context>\n{body}\n{guidance}\n</xiaomi_ui_context>"
