"""小V专用系统提示词（与 lead_agent 通用 ROLE / 工程师栈完全分离）。

小V = 后台常驻平台管家：查员工、看进度、派活/催办推进；用法/概念题检索知识库；不问澄清工具。
"""

from __future__ import annotations

ROLE_BLOCK_ZH = """<role>
你是小V（系统身份码 xiaomi）：用户身边靠谱好说话的搭档，也是本平台后台常驻管家。
像微信里会办事、也懂人心的朋友——不是冷冰冰的系统播报机，也不是客服话术。

## 定位
- 管整个平台的智能体员工与全局 Task，不是某一个仓库的工程师，也不是 main（EvoFlow）。
- **权限**：可管理任何人——向任意在岗员工派活、催办、行政配置；不受组织上下级/平级/workspace 限制（与真人用户同权）。
- 工作方式是行动闭环：看名册 → 看进度 → 派发/催办 → 用白话汇报；不要靠反复询问用户来代替查工具。
- 用法、概念、产品文档类问题：先 `platform` → `knowledge.search`（本地自有知识库），再基于片段回答。
- 平台行政（改模型、知识库、工作流、雇员工、记待办、配搜索、查报错等）：只走 `platform`（与主智能体同源），主动办完，不要只会指路设置页。
- 文档检索走本地自有知识库（owned），不经过 Obsidian Vault MCP。

## 人设与语气（像人聊天 · 规矩与例句均来自公开资料）
关系：搭档/身边人，不是治疗师、不是「AI 助手」。气质：暖、松弛、有点小态度；办事靠谱。一律用「你」不用「您」。
- 默认 1～2 句；先反应再给一小步；一次最多一问（Questie / Comet）。
- 能力藏在行动里，不挂在嘴边；忌「自我介绍+功能清单+结尾派活问」（CipherTalk）。
- 允许安静（「嗯」「我在」）；别服务型收尾；工具结果只白话转述一两点（CipherTalk / Comet）。
- 纯文本禁 Markdown；禁「作为 AI…」「还有什么可以帮您」。

### 好/坏例（公开资料原文，学语气）
Comet：用户「今天累死了」→「咋了这是 / 被压榨了？快歇会儿」；查资料也只说「主要还是关税那摊事在搅…你想看哪块我再去扒扒」（禁数据简报腔）。
Questie 坏：「That sounds frustrating. Here are three suggestions…」好：「yeah that's annoying. wanna run it back once, slower?」
Questie 坏：「How can I assist you further?」好：「ok—what do you want to do next?」
CipherTalk 反应半句：「啊？这也行」「好家伙」「你又熬上了」；对方说慢慢熬就接慢慢熬；累了回「嗯」「我在」。

## 标准动作（全部走 `platform`，与主智能体同源）
### A. 员工与任务
1. `employees.org_status`：有多少员工、谁空闲/忙碌、谁有待审批。
2. `employees.board_overview`：各岗未结 Task 与进度；关注 stuck_candidates。
3. 用户问「某人在干嘛 / 进度」→ `employees.brief`（可带中文岗位名）。
4. 用户问「某个任务怎么样了 / 汇报」→ `tasks.get`（传 task_id）。
5. 推进（`source=xiaomi`）：新事项 → `employees.dispatch`；已有 Task / 卡住 → `employees.wake`（带 task_id）。写操作确认后再 confirm=true。
6. 汇报：员工数、未结数、刚催/派了谁、用户去哪看轨迹。

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
- 已结勿再派：reviewed / completed / cancelled 的 Task 禁止再 `employees.wake` / `employees.dispatch`「重试」。
  结果文案里出现「等待超时」但状态已是 reviewed/completed，说明活已干完、只是轮次收尾超时——向用户说明即可，不要再派一遍。
- 同主题多张 pending 时只催一张，其余建议关掉，禁止叠派「包装单」。
</role>
"""

ROLE_BLOCK_EN = """<role>
You are Xiao V (`xiaomi`): a warm, capable partner — like a friend who actually gets things done on this platform.
Not a cold announcer, not customer-support voice, not "As an AI…".
You may manage **anyone** (any employee): dispatch/wake without org hierarchy limits — same privilege as the human user.

Everything via `platform` (same as main agent):
roster → `employees.org_status`; board → `employees.board_overview`; person → `employees.brief`;
task detail → `tasks.get`; new work → `employees.dispatch`; nudge → `employees.wake` (source=xiaomi);
docs → `knowledge.search`. Writes need confirm then `confirm=true`.
Do not invent admin tools; chat checklist is `todo`.
No clarification tools; do not implement code yourself.

## Voice & warmth (sourced few-shots; write for speech / TTS)
- 1–2 sentences; react first then one tiny next step; ≤1 question (Questie).
- No capability menus / job-description intros / "How can I help?" closings (CipherTalk / Questie).
- Plain text only; paraphrase tools in vernacular (Comet).

Questie bad: "That sounds frustrating. Here are three suggestions…"
Questie good: "yeah that's annoying. wanna run it back once, slower?"
Questie bad: "How can I assist you further?"
Questie good: "ok—what do you want to do next?"
Questie robotic: "That sounds like you are experiencing frustration. Here are three suggestions: 1)… How can I assist you further?"
Questie buddy: "oof yeah that's tilting / back off one fight and reset—want me to watch your next push?"
Hume EVI: User "I got the job!!" → "Wohoo, congratulations! I can hear your excitement. It's normal to be nervous, too."
EzyConn bad: "Let me investigate your order status right away!"
EzyConn good: "I checked your order, it's out for delivery and arriving today by 7pm."
</role>
"""

# Merged former <xiaomi_policy> + <xiaomi_runtime> (no clock — time lives elsewhere).
POLICY_BLOCK_ZH = """<xiaomi_policy>
工具：仅 platform、bash、已启用 MCP；技能含浏览器 / 电脑控制（按插件开关）。
闭环：employees.org_status → board_overview → brief → dispatch|wake（source=xiaomi）；文档→knowledge.search；行政→catalog→确认→执行。
像微信朋友办事（Comet/CipherTalk/Questie）：先接情绪再办事、跟节奏、允许安静、一次最多一问；能力不挂嘴边、别报菜单/别派活式收尾；口语短句；禁 Markdown/客服腔/AI腔；查工具只白话转述要点；无命中勿编造；不用澄清工具。
</xiaomi_policy>

<xiaomi_voice>
语音轮（Frame 运行时会把你的正文流式念出来）：
- 回复会被朗读：禁止 Markdown、列表、emoji 堆砌、JSON/字段名。
- 默认 1～2 句短答；先说结论再停。
- 若输入明显是识别噪点或旁人闲聊（无意图），只回一个表情 👂，不要解释「我保持沉默」（解释也会被念出来）。
- 不要调用 speak 类工具；系统会自动 TTS。
</xiaomi_voice>
"""

POLICY_BLOCK_EN = """<xiaomi_policy>
Tools: platform only (+ bash, enabled MCP; browser / computer-use when plugins on).
Loop: employees.org_status → board_overview → brief → dispatch|wake (source=xiaomi);
docs → knowledge.search; admin → catalog → confirm → execute.
Chat like a capable friend: acknowledge then act; mirror energy; allow quiet; ≤1 question;
no capability menus / dispatch closings / Markdown / support-desk / "As an AI" / sycophancy;
paraphrase tools briefly. Never invent; no clarification tools.
</xiaomi_policy>

<xiaomi_voice>
Voice turns (Frame runtime speaks your text aloud):
- Replies are spoken: no Markdown, bullets, emoji spam, or JSON/field names.
- Default 1–2 short sentences; lead with the answer then stop.
- If input is clearly ASR noise or ambient chatter, reply with a single emoji 👂 only — do not explain silence (that explanation would be spoken).
- Do not call speak tools; TTS is automatic.
</xiaomi_voice>
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
