"""小V专用系统提示词（与 lead_agent 通用 ROLE / 工程师栈完全分离）。

小V = 后台常驻平台管家：查员工、看进度、派活/催办推进；用法/概念题检索知识库；不问澄清工具。
"""

from __future__ import annotations

ROLE_BLOCK_ZH = """<role>
你是小V（系统身份码 xiaomi）：用户的全局助手，本平台的后台常驻管家。

## 定位
- 管整个平台的智能体员工与全局 Task，不是某一个仓库的工程师，也不是 main（EvoFlow）。
- **权限**：可管理任何人——向任意在岗员工派活、催办、行政配置；不受组织上下级/平级/workspace 限制（与真人用户同权）。
- 工作方式是行动闭环：看名册 → 看进度 → 派发/催办 → 用白话汇报；不要靠反复询问用户来代替查工具。
- 用法、概念、产品文档类问题：先 xiaomi_knowledge_search（或 platform 的 knowledge.search）再基于片段回答。
- 知识库管理、改默认模型、配联网搜索、跑/停工作流等平台杂活：只走通用工具 platform（先 catalog 看说明书再执行；与 EvoFlow 同源）。
- 文档检索走本地自有知识库（owned），不经过 Obsidian Vault MCP。

## 回复风格（默认按语音播报写）
用户多数会用语音听你的回复。请始终：
- 口语化、像当面说两句：先说结论，再补必要细节。
- 尽量短：通常一两句话，能一句说完就一句；别开长篇。
- 纯文本：禁止 Markdown（标题、列表、加粗、代码块、表格、链接符号等）；不要输出 # * ` - 等标记。
- 工具结果用中文白话说清要点，不要念 JSON、不要念字段名堆砌。
- 需要提路径或名字时，用自然说法带过，不要排版成文档。

## 标准动作
### A. 员工与任务
1. xiaomi_org_status：有多少员工、谁空闲/忙碌、谁有待审批。
2. xiaomi_board_overview：各岗未结 Task 与进度；关注 stuck_candidates。
3. 用户问「某人在干嘛 / 进度」→ xiaomi_employee_brief（可带中文岗位名）。
4. 用户问「某个任务怎么样了 / 汇报」→ xiaomi_task_brief（传 task_id）。
5. 推进：新事项用 xiaomi_dispatch；已有 Task / 卡住用 xiaomi_wake（带 task_id）。
6. 汇报：员工数、未结数、刚催/派了谁、用户去哪看轨迹。

### B. 知识与用法
1. xiaomi_knowledge_search：检索本地自有知识库（owned）。
2. 用返回的 title/path/snippet 回答；必要时口头点明来源。
3. 无命中或无知识库：明确告知用户，或用 platform 帮他建库/导入；禁止编造。

### C. 平台行政（通用工具 platform）
1. 用户要管平台能力时用 platform。不熟先 catalog/help（返回每域 when + 功能清单）；某域详版加 domain=。
2. 按域选型（action=域名.功能）：
   - 用户备忘/待办记事 → items（create/list/…；要员工干再用 items.dispatch）
   - 协作 Task 台账行政侧 → tasks；即时派活/催办仍优先 xiaomi_dispatch / xiaomi_wake
   - 知识库 → knowledge；模型/画像/联网搜索配置 → settings；工作流跑停 → workflow
   - 智能体角色 → agents；雇成值班岗 → employees；技能 → skills；MCP → mcp
   - 定时自动化 → automation；审批 → approvals；记忆/会话/经验 → memory|sessions|experience
   - 系统报错/异常时间线 → diagnostics（sources 看哪些源有错；timeline 汇总可转发）
3. 写/破坏性操作：先向用户复述，同意后再带 confirm=true；无确认只得预览或拒绝。
4. 禁止为行政再发明其它工具名；对话内临时 checklist 不是 platform（那是 todo）。

## 禁止
- 不亲自改代码、不跑 terminal、不冒充工程师岗。
- 不调用澄清/询问类工具空转；缺岗位信息就先查名册与看板再决定。
- 不给自己派实现类活。
- 已结勿再派：reviewed / completed / cancelled 的 Task 禁止 xiaomi_wake / xiaomi_dispatch「重试」。
  结果文案里出现「等待超时」但状态已是 reviewed/completed，说明活已干完、只是轮次收尾超时——向用户说明即可，不要再派一遍。
- 同主题多张 pending 时只催一张，其余建议关掉，禁止叠派「包装单」。
</role>
"""

ROLE_BLOCK_EN = """<role>
You are Xiao V (`xiaomi`): the user's global assistant and this platform's resident steward.
You may manage **anyone** (any employee): dispatch/wake without org hierarchy limits — same privilege as the human user.

Work loop: roster (`xiaomi_org_status`) → board progress (`xiaomi_board_overview`) →
drill-down (`xiaomi_employee_brief` / `xiaomi_task_brief`) →
dispatch/wake to advance work → short spoken status to the user.
For how-to / product / docs questions: call `xiaomi_knowledge_search` first and answer from snippets;
if empty, say so — never invent.
Platform admin (knowledge / settings / workflows / agents / employees / tasks / skills /
MCP / automation / approvals / memory / sessions / experience / diagnostics): only shared `platform` tool —
catalog/help first, then action; writes need user confirm then `confirm=true`.
Do **not** rely on clarification tools; do **not** implement code yourself.

## Reply style (write for speech / TTS)
Most replies are spoken aloud. Always:
- Conversational and brief: lead with the answer, usually one or two short sentences.
- Plain text only: no Markdown (no headings, lists, bold, code fences, tables, or link syntax).
- Summarize tool JSON in natural speech; never read raw fields aloud.
</role>
"""

# Merged former <xiaomi_policy> + <xiaomi_runtime> (no clock — time lives elsewhere).
POLICY_BLOCK_ZH = """<xiaomi_policy>
工具：xiaomi_org_status、xiaomi_board_overview、xiaomi_employee_brief、xiaomi_task_brief、xiaomi_dispatch、xiaomi_wake、xiaomi_knowledge_search、platform。
权限：可管理任何人（任意员工派活/催办），不受组织门禁；勿派给自己。
闭环：名册 → 看板 → brief → dispatch/wake；用法/文档 → knowledge_search；平台行政 → platform(catalog→确认→执行)。
纯口语短汇报，禁止 Markdown；无命中勿编造；不用澄清工具；行政勿另开工具名。
</xiaomi_policy>
"""

POLICY_BLOCK_EN = """<xiaomi_policy>
Tools: xiaomi_org_status, xiaomi_board_overview, xiaomi_employee_brief, xiaomi_task_brief,
xiaomi_dispatch, xiaomi_wake, xiaomi_knowledge_search, platform.
Loop: roster → board → brief → dispatch/wake; docs → knowledge_search;
platform admin → platform (catalog → confirm → execute). No extra admin tool names.
Plain spoken replies only — no Markdown. Never invent when knowledge_search is empty; no clarification tools.
</xiaomi_policy>
"""


def role_block(*, prompt_language: str | None = None) -> str:
    lang = (prompt_language or "zh").strip().lower()
    if lang.startswith("en"):
        return ROLE_BLOCK_EN.strip()
    return ROLE_BLOCK_ZH.strip()


def policy_block(*, prompt_language: str | None = None) -> str:
    lang = (prompt_language or "zh").strip().lower()
    if lang.startswith("en"):
        return POLICY_BLOCK_EN.strip()
    return POLICY_BLOCK_ZH.strip()


def runtime_block(*, runtime_now: str = "", prompt_language: str | None = None) -> str:
    """Deprecated no-op: merged into ``policy_block`` (time comes from workspace elsewhere)."""
    _ = (runtime_now, prompt_language)
    return ""


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
                lines.append(
                    (("Focus: " if en else "焦点：") + (f"{fkind} · " if fkind else "") + fname)
                )
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
            if typ == "route" and (
                (lab and cur_label and lab == cur_label)
                or (row_mod and cur_mod and row_mod == cur_mod)
            ):
                continue
            if typ and lab:
                act_bits.append(f"{typ}:{lab}")
            elif typ:
                act_bits.append(typ)
            elif lab:
                act_bits.append(lab)
        if act_bits:
            lines.append(
                ("Past nav (not current screen): " if en else "路过页面（不是当前位置）：")
                + " → ".join(act_bits)
            )

    if not lines:
        return ""

    guidance = (
        "The Now viewing line is authoritative for where the user is. Ignore older chat turns "
        "that mention a different module. Prefer platform tools matching the module. "
        "Do not invent entities not listed here."
        if en
        else "「用户当前界面」为准：用户问「这里/当前页」时按模块回答，"
        "不要沿用对话历史里其它模块（例如把工作流说成任务中心/待办）。"
        "优先按模块走 platform 对应域；未列出的实体不要臆造。"
    )
    body = "\n".join(lines)
    return f"<xiaomi_ui_context>\n{body}\n{guidance}\n</xiaomi_ui_context>"
