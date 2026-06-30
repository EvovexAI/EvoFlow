import type { SiteLocale } from "../locales";

/** 维护说明：正文与 EvoPanel 客户端菜单、按钮文案对齐；改版时以实际软件界面为准。 */
/** URL 段，如 ["chat","composer"] → /docs/chat/composer */
export type DocSlug = string[];

export interface DocNavItem {
  slug: DocSlug;
  title: Record<SiteLocale, string>;
}

export interface DocNavSection {
  title: Record<SiteLocale, string>;
  items: DocNavItem[];
}

export interface DocPage {
  slug: DocSlug;
  title: Record<SiteLocale, string>;
  description: Record<SiteLocale, string>;
  body: Record<SiteLocale, string>;
}

function slugKey(slug: DocSlug): string {
  return slug.length === 0 ? "" : slug.join("/");
}

/** 功能说明正文：仅拼接段落，不加统一脚注 */
function desktopStub(zhParagraphs: string[], enParagraphs: string[]): Record<SiteLocale, string> {
  return {
    zh: zhParagraphs.join("\n\n"),
    en: enParagraphs.join("\n\n"),
  };
}

const pages: DocPage[] = [
  {
    slug: ["getting-started"],
    title: { zh: "快速开始", en: "Getting started" },
    description: {
      zh: "下载安装 EvoFlow，在软件里配好模型即可开始用。",
      en: "Install EvoFlow, add your models in the app, and start using it.",
    },
    body: {
      zh: `
下文说明 **EvoFlow 桌面客户端**：装好以后，在软件里完成模型相关设置即可。

## 1. 下载安装包

打开 [EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases/latest)，按你的系统选择 **EvoFlow 桌面安装包**（若有），下载后按向导安装。

也可从本站顶栏 **下载** 进入同一发行页。

## 2. 首次打开

若出现欢迎或引导页，按屏幕提示选语言、外观等即可。

## 3. 配置模型

推荐在窗口底部 **设置 → 模型** 进入（与旧侧栏「模型配置」为同一界面）。若你仍在使用旧侧栏，也可打开 **配置 → 模型配置**。这里是整台软件共用的模型列表：聊天、任务都会用到你在这里设好的主模型与备选。

建议按这个顺序完成：

1. **先管好服务商**：左侧会列出常见云厂商等。若还没有你要用的，点 **添加服务商**，在弹窗里填 **名称**、**接口地址**（有的选项会自动带出地址）、**访问密钥**（本地、免鉴权的服务可按提示留空）。填完点保存。  
2. **确认能连上**：选中刚加的服务商后，若右侧有连接、鉴权或测试类按钮，建议先按界面说明测一遍，再添加模型，避免名字填对却连不通。  
3. **添加具体模型**：在该服务商下点 **添加模型**，把平台控制台里显示的**模型名称**原样填进来（多填几条也可以）。不需要的条目可以关掉或删掉。  
4. **指定主模型**：在列表里选一个作为**主模型**——这是聊天和任务默认会用的那个；以后想换默认，就改主模型即可。  
5. **排序与清理**：需要时可以拖拽调整顺序，或删除不再使用的服务商；多数改动保存后会有提示，按提示来即可。

访问密钥只保存在你的电脑上，不要发给他人。

## 4. 开始用

点侧栏 **新建对话** 或进入聊天主区，在输入框下方选好 **模型** 后即可对话。**输入栏上模型、模式、记忆、创意、工作空间** 等说明见 [输入栏与选项](/docs/chat/composer)；**目标** 见 [目标](/docs/chat/goal)。

侧栏从上到下与 **任务中心、自动化、技能、MCP、预设角色** 等入口一致；底部 **设置** 见对应分区。

本站产品文档按 **快速开始 → 实时对话（输入栏与选项、目标）→ 侧栏菜单（任务中心、自动化、技能、MCP、预设角色）→ 设置** 分区，与 EvoFlow 主界面一致。

## 延伸阅读

- [功能说明](/#capabilities)、[典型场景](/#scenarios)
`.trim(),
      en: `
This page is about the **EvoFlow** desktop app: install it, then finish model setup inside the app.

## 1. Download and install

Open [EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases/latest), pick the desktop installer for your platform when published, download, and run it.

You can also use **Download** in the site header to reach the same releases page.

## 2. First launch

If a welcome or setup screen appears, follow the prompts for language, appearance, and so on.

## 3. Configure models

Prefer **Settings → Models** from the chat footer (same UI as legacy sidebar **Configuration → Model configuration**). This catalog is shared across chat and tasks—the **primary model** you pick here is what new threads default to.

Recommended flow:

1. **Add a provider**: pick a vendor on the left or use **Add provider**. Enter a **name**, **endpoint**, and **API key** (leave blank only when the UI says it is optional). Save.  
2. **Check connectivity**: run any **test** or **auth** actions the page offers before adding models, so you know keys and URLs work.  
3. **Add models**: under that provider, use **Add model** and paste the **exact model IDs** shown in the vendor console. Disable or remove entries you do not need.  
4. **Pick a primary model**: choose which model chat and tasks should default to; change it anytime.  
5. **Reorder or clean up**: drag to reorder or delete unused providers; watch the on-screen save hints.

Keys stay on your machine—do not share them.

## 4. Start using the app

Open **New chat** in the shell (or the main chat surface), pick a **model** under the composer, and send a message. Composer controls (**Mode**, **Memory**, **Creativity**, **Workspace**) are in [Composer & options](/docs/chat/composer); **Goal** has its own page: [Goal](/docs/chat/goal).

The shell lists **Task center**, **Scheduled jobs**, **Skills**, **MCP**, and **Preset roles** in the same order as the app; **Settings** lives in the footer section of this doc set.

These product docs follow **Getting started → Live chat (composer & options, then Goal) → Shell entries (tasks, schedules, skills, MCP, preset roles) → Settings**, aligned with the EvoFlow shell.

## Read next

- [Capabilities](/#capabilities), [Scenarios](/#scenarios)
`.trim(),
    },
  },

  {
    slug: ["quick-commands"],
    title: { zh: "快捷指令", en: "Shortcuts" },
    description: {
      zh: "斜杠指令因客户端而异：EvoPanel 与飞书等 IM 不完全相同；以 /help 与界面为准。",
      en: "Slash commands differ by client (EvoPanel vs IM). Trust `/help` and the UI.",
    },
    body: desktopStub(
      [
        "## 斜杠指令说明",
        "在 **EvoPanel 实时聊天** 和 **飞书等机器人聊天** 里，以 `/` 开头的消息是否会被当成「指令」，**规则不一样**。下面按常用场景说明；**最稳妥**的做法是：在机器人里发一条 **`/help`**，看当前版本返回的说明。",
        "",
        "## EvoPanel 里（桌面端）",
        "发送前软件会**单独识别**的整行文字只有：",
        "- `/claude` 或 `/claude-code`：当前会话开启 **Claude Code 直连**",
        "- `/lead` 或 `/main`：当前会话切回 **主智能体**",
        "- `/goal <目标内容>`：直接启动当前会话的 **目标模式**（后台自动执行，不会当作普通聊天发出）",
        "- `/goal start` 或发 **「开始」「确认」**：应用对话里已有的 **目标方案** 并启动（需先有 `propose_goal` 确认条）",
        "",
        "以上几条发出去后会有提示，**不会**当作普通问题去聊天。",
        "",
        "**其它**以 `/` 开头的句子，多数会**照常当作你说的话**发给助手；助手会不会按「指令」去理解，**不能保证**。**目标**请用输入栏的 **[目标](/docs/chat/goal)** 面板完成启停与设置。",
        "",
        "## 飞书、Slack、Telegram 等机器人里",
        "在飞书里，若**第一条有效文字以 `/` 开头**，一般会走「指令」通道（不是普通一问一答）。机器人不认识的指令会提示你发 **`/help`**。",
        "",
        "发 **`/help`** 后，你通常会看到类似说明（以你屏幕上的为准）：",
        "- `/bootstrap` — 引导式会话",
        "- `/claude`（可带会话编号续用）、`/lead`、`/main` — 在本话题内 **Claude Code 直连** 与 **主智能体** 切换；**复用当前助手线程**，便于直连后 **连续多轮** 改需求（详见 [编码助手（Claude Code）](/docs/ext/coding-assistants)）。",
        "- `/new` — 换一条新的助手会话线（飞书里的聊天记录还在，变的是背后的会话）",
        "- `/goal <目标>` — 直接启动当前会话的目标任务（别名 `/hosted`、`/hd`）",
        "- `/status` — 看当前模式、会话等摘要",
        "- `/models`、`/memory` — 查看模型列表、记忆摘要等简要信息",
        "- `/help` — 帮助",
        "",
        "下面这类在营销文案里常见、**在机器人指令里通常没有**：`/clear`、`/reset`、`/model`、`/mode`、`/task`、`/cron`、`/web`、`/file` 等。**任务中心、自动化**请在 EvoPanel **侧栏**对应页面里操作。",
        "",
        "## 小提示",
        "1. 指令里若有一大段话带空格，建议用英文引号包起来再发。",
        "2. 软件升级后指令可能有变化，**以你当时收到的 `/help` 为准**。",
      ],
      [
        "## How slash messages work",
        "Whether a `/…` line is treated as a **command** differs between **EvoPanel chat** and **IM bots** (Feishu, Slack, Telegram, …). The safest habit is to send **`/help`** on the bot and read what **your build** lists.",
        "",
        "## Inside EvoPanel (desktop)",
        "Only these **full-line** messages are handled specially before send:",
        "- `/claude` or `/claude-code` — turn on **Claude Code** for this thread",
        "- `/lead` or `/main` — switch back to the **lead** assistant",
        "- `/goal <task goal>` — **start goal mode** on this thread immediately (not sent as normal chat)",
        "- `/goal start` or phrases like **Start** / **确认** — apply an existing **goal proposal** from `propose_goal`",
        "",
        "They show a toast and are **not** sent as a normal prompt.",
        "",
        "Other lines starting with `/` are usually sent **as normal chat text**; the assistant may or may not treat them like commands. For goal mode use the composer **[Goal](/docs/chat/goal)** panel.",
        "",
        "## On Feishu / Slack / Telegram bots",
        "In Feishu, when the **first non-empty line starts with `/`**, the message is usually handled as a **command**. Unknown commands ask you to run **`/help`**.",
        "",
        "After **`/help`**, you should see something like (follow your screen):",
        "- `/bootstrap`",
        "- `/claude` (optional session id), `/lead`, `/main` — switch between **Claude Code direct** and the **lead** on the **same assistant thread** so you can **iterate many turns** (see [Coding assistants](/docs/ext/coding-assistants)).",
        "- `/new` — start a fresh assistant thread (IM chat history stays; the backend thread changes)",
        "- `/status`",
        "- `/goal <goal text>` — start a background goal on this thread (aliases `/hosted`, `/hd`)",
        "- `/models`, `/memory`",
        "- `/help`",
        "",
        "Marketing-style lists often mention `/clear`, `/reset`, `/model`, `/task`, `/cron`, `/web`, etc.—those are **usually not IM commands**. Use EvoPanel sidebar pages for **Task center** and **Scheduled jobs**.",
        "",
        "## Tips",
        "1. Wrap long goals with spaces in quotes when needed, e.g. `/goal \"check disk every hour\"`.",
        "2. Commands change after updates—**trust the live `/help` output**.",
      ],
    ),
  },

  {
    slug: ["chat", "composer"],
    title: { zh: "输入栏与选项", en: "Composer & options" },
    description: {
      zh: "与 EvoPanel 输入框下方控件一致：模型、模式、预设角色、记忆、创意、工作空间；不含目标。",
      en: "Matches EvoPanel composer controls: model, mode, preset role, memory, creativity, workspace (not Goal).",
    },
    body: desktopStub(
      [
        "## 控件在哪",
        "在 **EvoPanel** 打开聊天并**选中一个会话**后，**输入框下方第一行**从左到右依次为：**模型**、**模式:**（带当前档位名）、**预设角色**（显示当前角色名）、**记忆:**（开/关）、**创意**、**目标**、右侧 **回形针**（图片附件）、再靠右 **工作空间:**。",
        "**目标** 有单独说明，见 [目标](/docs/chat/goal)。本页只讲其余与输入栏直接相关的选项。",
        "",
        "## 模型",
        "按钮上显示**当前模型名**；未配置或未选时可能显示 **未选择模型**。点开后为下拉列表，点选即切换**本会话**使用的模型。若某模型在配置里声明支持视觉，列表中会带 **视觉** 标签；**回形针** 是否可点取决于当前模型是否支持图片。",
        "列表为空时会提示 **暂无可用模型**——请到 **设置 → 模型** 添加服务商与模型，步骤见 [快速开始](/docs/getting-started)。",
        "",
        "## 模式",
        "按钮文案为 **模式:** 加上当前档位（**闪速**、**思考**、**Pro**、**Ultra** 四选一）。点开后菜单里也是这四档，用于在同一模型下切换响应偏好。",
        "这与窗口**顶栏**里显示的 **场景** 不是同一个东西：场景标签会随**所选模型配置**或本轮运行结果变化，概括「当前在做哪类事」；**模式**四档是你在输入栏手动选的会话档位。",
        "",
        "## 预设角色",
        "按钮显示当前 **预设角色** 的名称。点开列表可切换到其它预设；**切换会新开对应该角色的会话**（与按钮上的说明一致）。",
        "若暂无可用预设，会提示先到 **「角色管理」** 创建。侧栏完整管理与编辑见 [预设角色](/docs/config/agents)。",
        "",
        "## 记忆",
        "按钮显示 **记忆: 开** 或 **记忆: 关**，表示**本会话**是否启用「带历史摘要的多轮记忆」能力（具体以软件提示为准）。未选中会话时不可点。",
        "需要查看或整理已写入的长期记忆时，使用 **设置 → 记忆**（与侧栏 **记忆管理** 为同一能力，布局入口不同）。**新会话默认是否启用记忆** 在 **设置 → 通用**，见 [设置 · 通用](/docs/panel/general)。",
        "",
        "## 创意",
        "点开 **创意** 后，是固定的几条 **快捷提示**（例如：开始创作、写作、深入研究、收集、学习、创建、创建角色）。点选会把对应文字**插入输入框**，你改完再发送。",
        "**正在发送或流式输出时**该按钮会置灰不可用。",
        "",
        "## 工作空间",
        "按钮文案为 **工作空间:** 加当前摘要（例如已选目录的简称、**虚拟** 表示走虚拟路径模式、或 **本机**）。点开菜单可 **设置本机工作目录**（桌面端可选文件夹；浏览器里需自行输入**绝对路径**）、从历史路径里切换；另有入口会提示到 **设置 → 通用 → 维护** 做「清理对话缓存并重载」类操作。",
        "这里管的是「工具默认在哪个目录读写文件」，与 **记忆: 开/关** 无关。",
        "",
        "## Plan（任务协作）",
        "与 **闪速 / 思考 / Pro / Ultra** 并列的 **「Plan（任务协作）」** 入口，在**当前公开发布的 EvoPanel 里不会出现在「模式」菜单中**（界面未开放该项；后端协作逻辑仍可能随会话演进，但你不能在输入栏从这里打开或关闭）。若你使用的定制版本重新打开了该菜单，才会看到 **Plan（任务协作）** 以及「回到 Plan / Authorize 执行」等按钮。",
        "需要把编码活交给 Claude Code 时，另见 [编码助手（Claude Code）](/docs/ext/coding-assistants)。",
      ],
      [
        "## Where the controls are",
        "In **EvoPanel** chat, after you **select a session**, the **row under the composer** shows, left to right: **model**, **Mode:** (with the current preset name), **preset role** label, **Memory:** on/off, **Creativity**, **Goal**, the **paperclip** for images, then **Workspace:**.",
        "**Goal** is documented separately: [Goal](/docs/chat/goal). This page covers the other composer controls.",
        "",
        "## Model",
        "The pill shows the **active model name**; if nothing is chosen you may see **未选择模型**. Open the dropdown to pick a model for **this thread**. Models flagged for vision show a **视觉** tag; the **paperclip** stays disabled when the current model does not support images.",
        "If the list is empty you will see **暂无可用模型**—add providers under **Settings → Models**; follow [Getting started](/docs/getting-started).",
        "",
        "## Mode",
        "The pill reads **Mode:** plus one of **闪速 (Flash)**, **思考 (Thinking)**, **Pro**, or **Ultra**. The menu lists exactly those four options to tune response style on the same model.",
        "That is different from the **scene** chip in the **header**: the scene summarizes the kind of work (driven by model metadata or runtime tools), while **Mode** is the four-way switch you pick here.",
        "",
        "## Preset role",
        "Shows the current **preset role** name. The menu switches roles; **switching starts a new thread for that role**, matching the in-app hint.",
        "If no presets exist, the UI asks you to create them in **角色管理** first. Full management: [Preset roles](/docs/config/agents).",
        "",
        "## Memory",
        "The pill reads **Memory: on** or **Memory: off** for **this thread** (whether the session keeps summarized history—follow the tooltip text in the app). It is disabled when no session is selected.",
        "To review or edit stored long-term memory, use **Settings → Memory** (same capability as sidebar **Memory management**, different layout). Whether **new** chats default to memory on is under **Settings → General**—see [Settings · General](/docs/panel/general).",
        "",
        "## Creativity",
        "Opens a short list of **quick prompts** (e.g. start writing, deep dive, collect, study, create, create role). Choosing one **inserts text into the composer** for you to edit before sending.",
        "The control is disabled while a message is sending or streaming.",
        "",
        "## Workspace",
        "The pill reads **Workspace:** plus a short label (folder basename, **虚拟** when virtual paths are enabled, or **本机**). The menu offers **设置本机工作目录** (folder picker on desktop; type an **absolute path** in the web build), pick from history, and a path that reminds you to clear chat cache via **Settings → General → Maintenance**.",
        "This is about **where file tools run**, not the memory toggle.",
        "",
        "## Plan (task collaboration)",
        "A **Plan (task collaboration)** row next to the four modes is **not shown in the public EvoPanel build**—the menu flag is off, so you cannot turn Plan on/off from the composer even if collaboration state exists server-side. Custom builds that re-enable the flag will show **Plan（任务协作）** plus actions like **Back to plan** / **Authorize 执行**.",
        "For delegating coding work to Claude Code, see [Coding assistants](/docs/ext/coding-assistants).",
      ],
    ),
  },
  {
    slug: ["chat", "goal"],
    title: { zh: "目标", en: "Goal" },
    description: {
      zh: "输入栏「目标」：可手写任务目标，也可由模型调用 propose_goal 生成目标方案后确认再跑；支持结束汇总推送到飞书（需网关侧配置）。",
      en: "Composer **Goal**: manual goals, or model-proposed plans via **propose_goal** you confirm before run; optional Feishu summary on completion (Gateway + Feishu configured).",
    },
    body: desktopStub(
      [
        "## 目标适合做什么",
        "当你希望助手**在同一轮对话里连续推进多步**（改代码、查资料、写文档等），又不想每一步都手动发「继续」时，使用 **目标**。主聊天区照常显示助手回复与工具结果；**目标面板**负责写任务目标、启停、看轮次与状态。**目标**与输入栏 **记忆** 不同：记忆决定是否沿用历史上下文；目标模式决定是否由调度侧**自动发下一轮指令**驱动主助手。",
        "",
        "## 打开目标面板",
        "1. **先选中一个会话**（未选中时「目标」可能不可用）。",
        "2. 点输入栏下方的 **「目标」**，右侧滑出 **「目标模式」** 面板。",
        "3. 再点 **「目标」** 或面板 **关闭** 可收起；运行中也可先看聊天区，需要停止时再打开面板点 **「停止目标」**。",
        "",
        "## 两种启动方式",
        "### 1）在面板里手写并启动",
        "在 **任务目标** 中写清验收口径 → 设 **最大轮次**、可选 **定时自动停止**、**人格风格** 等 → 点 **「启动目标」**。运行中目标栏会锁定，需先停止再改。",
        "### 2）由模型生成方案，确认后再执行（推荐）",
        "对话中模型可调用 **`propose_goal`** 给出目标参数（任务目标、轮次、定时、飞书汇报开关等）。此时输入区上方会出现 **「目标方案」确认条**：",
        "- **填入并开始**：把方案写入面板并**立即启动**目标。",
        "- **填入面板**：只写入配置，不自动开跑。",
        "- **关闭**：放弃本条方案。",
        "默认需你**手动点确认**才会跑，避免误触。进阶：可在本机浏览器存储键 **`evopanel_hosted_propose_action`** 设为 `auto_fill`（仅写入面板）或 `auto_start`（写入并自动启动），供自动化或飞书衔接等场景使用。",
        "",
        "## 结束条件（「先到先停」）",
        "**最大轮次** 与 **定时自动停止** 彼此独立，**满足任一即停止**。可搭配使用：怕跑太久可开定时；希望多给助手几步可调大轮次。",
        "",
        "## 飞书：结束汇总与远程「开始」",
        "### 结果汇总通知",
        "在目标方案或面板中打开 **「飞书汇报」**（或等价选项）后，若 **Gateway 已配置默认可推送的飞书会话**（与自动化飞书推送同源探测），目标运行**正常结束或达到停止条件**时，可向飞书推送 **Markdown 小结**（含结论、步数、摘要等，具体以当前客户端为准）。",
        "### 从飞书直接启动目标",
        "在已绑定 EvoFlow 线程的飞书会话中，发送 **`/goal 任务目标描述`**（别名 `/hosted`、`/hd`），网关会在**当前会话**后台自动启动目标模式。",
        "### 从飞书确认已有方案",
        "若对话里已有 **`propose_goal`** 生成的目标方案，可在 **EvoPanel** 输入框发 **「开始」「确认」** 或 **`/goal start`** 一键填入并启动；飞书 IM 侧请优先用 **`/goal <目标>`** 直接创建。",
        "### 结构化询问在飞书里的展示",
        "若主助手发起 **`ask_clarification`**，网关侧会对飞书出站文案做可读化（列表化选项与说明），避免整段 JSON 直接出现在群里；**在桌面 EvoPanel 侧栏点选**仍是最稳妥的提交方式。",
        "",
        "## 运行期间的配合",
        "- 主会话里若出现澄清/确认，请按气泡或侧栏提示作答；紧急停止用面板 **「停止目标」**。",
        "- 也可在输入框发 **「开始」「确认」** 等短指令（与飞书侧语义对齐）以应用当前确认条上的目标方案（以当前版本为准）。",
        "",
        "## 与快捷指令的关系",
        "详见 [快捷指令](/docs/quick-commands)。**面板与快捷指令二选一习惯即可**；IM 里能用的 `/` 指令以机器人 **`/help`** 为准，与 EvoPanel 本地输入框不一定相同。",
      ],
      [
        "## When Goal mode helps",
        "Use **Goal** when you want the assistant to **keep driving multi-step work in the same chat** (edits, research, writing) without you sending “continue” every turn. Progress stays in the main thread; the **Goal** drawer is for task goals, start/stop, and status. **Goal ≠ Memory**: memory keeps thread context; goal mode decides whether a **planner loop** keeps issuing the next instruction to the main assistant.",
        "",
        "## Open the Goal drawer",
        "1. **Select a thread** first.",
        "2. Tap **Goal** under the composer to open **Goal mode**.",
        "3. Tap **Goal** again or **Close** to hide it; use **Stop goal** when you need to abort.",
        "",
        "## Two ways to start",
        "### 1) Type goals in the panel",
        "Fill **Task goal**, set **Max rounds**, optional **Timed auto-stop**, **Persona**, then **Start goal**. The goal field locks while running—stop first to edit.",
        "### 2) Model-proposed plan, then you confirm (recommended)",
        "The model may call **`propose_goal`** with parameters (goal, rounds, timer, Feishu summary toggle, etc.). A **Goal plan** strip appears above the composer:",
        "- **Apply & start** — writes the plan and **starts** goal mode immediately.",
        "- **Apply to panel** — writes settings without auto-start.",
        "- **Dismiss** — discard this proposal.",
        "By default nothing runs until you confirm (safer). Power users can set browser storage key **`evopanel_hosted_propose_action`** to `auto_fill` or `auto_start` for automation/Feishu flows.",
        "",
        "## Stop conditions (“first signal wins”)",
        "**Max rounds** and **Timed auto-stop** are independent—**whichever hits first stops the run**.",
        "",
        "## Feishu: completion summary & remote start",
        "### Completion summary",
        "When **Feishu notify on completion** (or equivalent) is enabled **and** the Gateway has a **default Feishu chat** configured (same discovery path as automation Feishu push), a **Markdown wrap-up** can be sent when goal mode ends normally or hits a stop condition (wording/layout depends on your build).",
        "### Start a goal from Feishu",
        "In a Feishu thread bound to EvoFlow, send **`/goal <task goal>`** (aliases `/hosted`, `/hd`) to **start goal mode on that thread** in the background.",
        "### Confirm an existing proposal",
        "If the thread already has a **`propose_goal`** plan strip in **EvoPanel**, send **Start** / **确认** or **`/goal start`** in the desktop composer to apply & start. On Feishu IM, prefer **`/goal <goal>`** to create directly.",
        "### ask_clarification on Feishu",
        "Outbound text for **`ask_clarification`** is formatted for IM readability (options as a short list). **Answering in EvoPanel’s clarification sidebar** remains the most reliable path.",
        "",
        "## While it runs",
        "Answer in-thread questions; use **Stop goal** for an emergency stop.",
        "",
        "## Slash commands",
        "See [Shortcuts](/docs/quick-commands). Prefer **either** the drawer **or** slash habits; IM slash sets follow the bot **`/help`**, which may differ from EvoPanel’s local composer.",
      ],
    ),
  },

  {
    slug: ["tasks", "center"],
    title: { zh: "任务中心", en: "Task center" },
    description: {
      zh: "建立和跟进多步骤任务。",
      en: "Create and follow multi-step tasks.",
    },
    body: desktopStub(
      [
        "## 入口",
        "侧栏点 **任务中心**（与 **新建对话** 同一列）。",
        "",
        "## 页面上有什么",
        "- **新建任务**：右上角按钮，弹窗里填 **任务名称**（必填）和 **任务描述**。创建成功后会提示 **Supervisor 正在分析并拆解**；列表自动刷新。",
        "- **搜索**：上方输入框按 **名称 / 描述 / 状态** 关键字过滤卡片。",
        "- **刷新**：重新拉取列表。",
        "- **每张任务卡片**：显示状态角标、描述、子任务完成进度条（若有子任务）。底部按钮一般为 **查看详情**（进入 `#/task/…` 详情页）、**实时对话**（跳到聊天里看该任务的流式输出）、处于规划态时的 **开始执行**、运行中的 **暂停**、以及 **删除**。",
        "- **批量选择**：进入勾选模式后，底部工具条可 **批量启动**（规划启动）、**批量暂停**、**批量删除** 或 **取消选择**；删除前会二次确认。",
        "",
        "## 注意",
        "不要用聊天里的 `/task …` 当「建任务」入口——在 EvoPanel 里会当普通文字发出。请在本页与 **任务详情** 管理。详见 [快捷指令](/docs/quick-commands)。",
        "",
        "## 补充说明",
        "接口与排障见 GitHub 仓库：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Entry",
        "Shell sidebar **Task center** (same column as **New chat**).",
        "",
        "## What you can do",
        "- **New task**: top-right button; modal asks for a **name** (required) and **description**. After create you should see a toast that the supervisor is analyzing; the list refreshes.",
        "- **Search**: filter cards by keywords in name, description, or status.",
        "- **Refresh**: reload the list from the server.",
        "- **Each card**: status badge, description, optional subtask progress bar. Footer actions are typically **Open details** (`#/task/…`), **Live chat** (jump to chat for streaming output), **Start** when status is planning, **Pause** while executing, and **Delete** (with confirm).",
        "- **Batch select**: enables checkboxes and a bottom bar for **batch start**, **batch pause**, **batch delete**, or **cancel selection**.",
        "",
        "## Heads-up",
        "Do not use `/task …` in chat as a task creator—EvoPanel sends it as normal text. Use this page and the task detail route. See [Shortcuts](/docs/quick-commands).",
        "",
        "## Supplementary docs",
        "APIs and troubleshooting: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ]
    ),
  },
  {
    slug: ["tasks", "cron"],
    title: { zh: "自动化", en: "Scheduled jobs" },
    description: {
      zh: "按时间表自动跑检查或任务。",
      en: "Run checks or jobs on a schedule.",
    },
    body: desktopStub(
      [
        "## 入口",
        "侧栏点 **自动化**。",
        "",
        "## 页面上有什么",
        "- **新建任务**：打开创建/编辑向导，按步骤填写任务名称、要执行的说明（给模型看的 **Prompt**）、计划方式（页面内有 **预设快捷**：如每小时、每天 9 点、工作日 9 点等，也有 Cron / 一次性等选项，以向导为准）。",
        "- **状态条**：显示调度器是否在跑，以及 **活跃 / 已暂停 / 总计** 数量。若桌面端连不上 Gateway，可能出现与 **EVOFLOW_GATEWAY_URL** 或 `/api/automation/scheduler` 相关的错误提示。",
        "- **任务列表**：每条可 **编辑**、**删除**、**立即运行**、**暂停 / 恢复**、查看 **历史**（以卡片上按钮为准）。",
        "",
        "## 注意",
        "聊天里的 `/cron …` **不会**在本页替你建任务；在 EvoPanel 聊天里也会当普通文字。请在本页或 [快捷指令](/docs/quick-commands) 了解机器人侧差异。",
        "",
        "## 补充说明",
        "TOML 存储、Gateway 自动化等见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Entry",
        "Shell sidebar **Scheduled jobs**.",
        "",
        "## What you can do",
        "- **New task**: opens a wizard—set a name, the **prompt** the model should run, and the schedule (the page ships **quick presets** such as hourly, 9am daily, weekday 9am, plus cron/one-shot options—follow the wizard).",
        "- **Status bar**: shows whether the scheduler is running and counts for **active / paused / total**. Desktop builds may toast if the Gateway URL is wrong or `/api/automation/scheduler` fails.",
        "- **List actions** (per row): **edit**, **delete**, **run now**, **pause/resume**, **history**—labels match the buttons on your card.",
        "",
        "## Heads-up",
        "`/cron …` in chat does **not** create jobs here; EvoPanel treats it as plain text. See [Shortcuts](/docs/quick-commands) for IM differences.",
        "",
        "## Supplementary docs",
        "TOML layout and Gateway automation: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ]
    ),
  },

  {
    slug: ["config", "agents"],
    title: { zh: "预设角色", en: "Preset roles" },
    description: {
      zh: "侧栏「预设角色」：管理多角色人设；输入栏旁也可快速切换。",
      en: "Sidebar **Preset roles**; quick switch from the composer button.",
    },
    body: desktopStub(
      [
        "## 入口",
        "侧栏 **角色管理**（产品里标题为「角色管理」，与聊天输入栏 **预设角色** 对应）。",
        "",
        "## 能做什么",
        "- **新建 / 编辑 / 删除**：填写展示名、系统提示词、描述、默认模型等；页面会从后端拉取 **工具 / MCP / 技能** 列表，在表单里勾选该角色允许用的能力。",
        "- **复制**：在现有角色上快速复制一份再改。",
        "- **测试 / 保存**：按界面按钮试跑当前配置，满意后保存。",
        "",
        "## 和聊天里切换的关系",
        "输入栏 **预设角色** 用于 **新开一条** 使用该角色的会话；完整增删改仍在本页。详见 [输入栏与选项](/docs/chat/composer)。",
        "",
        "## 外部 CLI 类角色",
        "若某角色标记为依赖 **本机外部 CLI**（例如需本机 Claude Code），工具/MCP 可能由运行时提供，本页不必逐项勾选——以界面提示为准。",
        "",
        "## 补充说明",
        "配置文件格式、导入导出等见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Entry",
        "Sidebar **角色管理** (Role management)—pairs with the composer **Preset role** pill.",
        "",
        "## What you can do",
        "- **Create / edit / delete**: set display name, system prompt, description, default model, etc. The page loads **tools / MCP / skills** metadata from the backend—check what this role may call.",
        "- **Duplicate** an existing role as a starting point.",
        "- **Test / save** using the on-page actions before you rely on the persona.",
        "",
        "## Relation to chat",
        "The composer **Preset role** control starts a **new** thread for that persona; full CRUD stays here. See [Composer & options](/docs/chat/composer).",
        "",
        "## External-CLI personas",
        "Some personas require a **host CLI** (e.g. Claude Code). Tools/MCP may be provided by the runtime—follow the in-app hint instead of forcing every checkbox.",
        "",
        "## Supplementary docs",
        "YAML/JSON layout and import/export: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ]
    ),
  },
  {
    slug: ["config", "feishu"],
    title: { zh: "飞书集成", en: "Feishu integration" },
    description: {
      zh: "飞书机器人与 EvoPanel「IM 通信」配套说明；开放平台与网关部署见 Git。",
      en: "Feishu bot notes alongside EvoPanel **IM** settings; open platform + Gateway on Git.",
    },
    body: desktopStub(
      [
        "## EvoPanel 中的配置",
        "桌面端请在 **设置 → IM 通信**（或侧栏 **IM Channels**）里选 **飞书**，按右侧说明填 **App ID / App Secret**，需要时用 **扫码绑定**，再点 **测试连通性**；左侧开关用于启用或停用该渠道。详见 [设置 · IM 通信](/docs/panel/feishu-tab)。",
        "",
        "## 飞书中的使用",
        "单聊直接找机器人；群聊一般需 **@机器人** 再发。能用的 **`/` 指令**以机器人返回的 **`/help`** 为准，与 EvoPanel 聊天不完全相同，见 [快捷指令](/docs/quick-commands)。目标若在 IM 里不好操作，用 **[目标](/docs/chat/goal)** 面板。",
        "",
        "## 服务端还要做什么",
        "开放平台里需创建应用、开权限、配事件订阅 URL（形如 `…/api/feishu/webhook`）等，与具体部署方式有关。",
        "",
        "## 补充说明",
        "完整清单与排障见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Configuration in EvoPanel",
        "In EvoPanel open **Settings → IM** (or shell **IM Channels**), pick **Feishu**, fill **App ID / App Secret**, use **Scan to bind** when offered, then **Test connectivity**; the left toggle enables or disables the channel. Details: [Settings · IM](/docs/panel/feishu-tab).",
        "",
        "## Usage in Feishu",
        "DM the bot directly; in groups **@mention** first. Slash commands follow **`/help`** from the bot—see [Shortcuts](/docs/quick-commands). Prefer the **[Goal](/docs/chat/goal)** panel when IM controls are unclear.",
        "",
        "## Server-side setup",
        "You still need a Feishu Open Platform app, permissions, and a reachable webhook URL (e.g. `…/api/feishu/webhook`)—depends on your deployment.",
        "",
        "## Supplementary docs",
        "Checklists and troubleshooting: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ]
    ),
  },
  {
    slug: ["ext", "skills"],
    title: { zh: "技能", en: "Skills" },
    description: {
      zh: "侧栏「技能」页：已安装与搜索安装、导入本地。",
      en: "Sidebar **Skills**: installed list, search/install, import from disk.",
    },
    body: desktopStub(
      [
        "## 入口",
        "侧栏 **技能**（页面标题为 **Skills**）。",
        "",
        "## 两个主 Tab",
        "- **已安装**：列出本机已有技能；每项可 **开/关**（安装后默认启用）。右上角 **导入本地技能** 从本机目录导入。",
        "- **搜索安装**：在搜索框输入关键词，从社区索引里查找并安装（具体列表与按钮文案以界面为准）。",
        "",
        "## 和「角色」的关系",
        "技能装好后，还需要在 **[角色管理](/docs/config/agents)** 里给对应角色勾选，才能在对话里被该角色使用。",
        "",
        "## 补充说明",
        "技能目录、`SKILL.md` 约定与 CLI 见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Entry",
        "Sidebar **Skills** (page title **Skills**).",
        "",
        "## Two tabs",
        "- **Installed**: toggle each skill on/off (installed skills default to on). **Import local skill** adds a folder from disk.",
        "- **Search & install**: keyword search then follow the wizard (labels depend on your build).",
        "",
        "## Relation to roles",
        "After a skill is installed, enable it for a persona under **[Preset roles](/docs/config/agents)** so that role may use it in chat.",
        "",
        "## Supplementary docs",
        "Skill folders and `SKILL.md` conventions: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ]
    ),
  },
  {
    slug: ["ext", "tools"],
    title: { zh: "MCP", en: "MCP" },
    description: {
      zh: "侧栏「工具管理」：已安装的 MCP 与市场搜索添加。",
      en: "Sidebar **Tools**: installed MCP servers and marketplace search.",
    },
    body: desktopStub(
      [
        "## 入口",
        "侧栏 **工具管理**（界面标题为「工具管理」，文档里常写作 **MCP**）。",
        "",
        "## 两个主 Tab",
        "- **已安装**：列出当前配置里的 MCP 服务器；右上角 **添加服务器** 打开表单，按向导填写命令、参数等（以弹窗为准）。加载失败时页面会显示错误文案。",
        "- **市场**：在搜索框输入关键词查找社区里的 MCP，一键 **加入本地配置**（以按钮为准）。",
        "",
        "## 和「角色」的关系",
        "服务器加好后，仍需在 **[角色管理](/docs/config/agents)** 中允许该角色调用对应 MCP/工具。",
        "",
        "## 补充说明",
        "MCP 配置示例、stdio/SSE 等见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Entry",
        "Sidebar **工具管理** (often referred to as **MCP** in docs).",
        "",
        "## Two tabs",
        "- **Installed**: lists configured MCP servers; **Add server** opens the form (command, args, env—follow the modal). Errors render inline when load fails.",
        "- **Market**: search keywords, then add entries to your local config.",
        "",
        "## Relation to roles",
        "Grant MCP/tools to a persona under **[Preset roles](/docs/config/agents)** so chat runs can call them.",
        "",
        "## Supplementary docs",
        "Sample configs (stdio/SSE, etc.): [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ]
    ),
  },
  {
    slug: ["ext", "coding-assistants"],
    title: { zh: "编码助手（Claude Code）", en: "Coding assistants (Claude Code)" },
    description: {
      zh: "飞书或面板里「直连」连续对话、总控会话里委派、以及协作子任务里执行三种用法；教你怎么选、怎么切换。",
      en: "Three ways to use Claude Code: IM/panel direct chat, lead delegation, and collaboration subtasks—when to pick each.",
    },
    body: desktopStub(
      [
        "## 概览",
        "在本产品里，**Claude Code**（本机编码环境）可以出现在三种用法里：你在 **飞书等 IM 里先切到直连再连续聊**；你在 **总控（主智能体）会话里** 让它当 **子代理** 干活；在 **协作 / 子任务** 流程里由某一格指派给它执行。三种方式共用同一套 Claude Code 能力，差别只在 **谁在控场、消息从哪条入口进来**。**桌面端 EvoPanel** 与飞书的斜杠切换是对齐的。",
        "",
        "## 用法一：飞书里先切到 Claude Code，再连续对话",
        "在飞书（或其它已接入的 IM）里发 **`/claude`**（或 **`/claude-code`**），机器人会切到 **Claude Code 直连模式**：**后面你在这个话题里发的普通消息**，都会交给 Claude Code 处理，可以 **多轮追问、改需求、接着改代码**，会话会在后台 **续接积累**，不是「一句一断」。",
        "",
        "- **切回总控**：发 **`/lead`** 或 **`/main`**，回到主智能体模式；**同一条 IM 话题仍复用原来的编排线程**，方便总控接着协调别的事。",
        "- **续接某次 Claude 会话**：发 **`/claude`** 并在同一行带上上次提示里给出的 **会话 ID**（`/status` 里也会看到「上次 Claude 会话」）。",
        "- **看当前状态**：发 **`/status`**，可看到当前是「Claude Code 直连」还是「主智能体」，以及线程/会话摘要。",
        "",
        "这与 **发 `/new` 换一条全新助手线程** 不同：`/new` 会换背后的 LangGraph 线程；**`/claude` 只是在当前线程上切换「这一轨走 Claude Code」**，所以才能 **连续对话**。飞书若要求先建线程，按机器人提示发 **`/new`** 后再用 **`/claude`** 即可。",
        "",
        "## 用法二：总控模式下，让 Claude Code 当子代理",
        "当你 **没有** 用 `/claude` 把整条会话切成「全程直连」时，你对话的对象是 **总控（主智能体）**。这时你只要用 **自然话** 说明要写什么、改哪里、有什么约束，总控会在需要时把 **编码类步骤** 派给 **Claude Code 子代理** 执行，再把结果收回对话里。",
        "",
        "在 **EvoPanel** 里，这类执行过程往往会 **流式出现在控制台一类区域**，便于你和主对话对照。**同一条主会话里**，系统通常会 **默认复用同一条 Claude Code 外部会话**，方便你接着喊「再改一下」「加个单测」而不用从零重开；若你希望完全隔离一条新的编码会话，在对话里跟总控说清楚即可。",
        "",
        "## 用法三：任务协作（子任务）里由 Claude Code 执行",
        "当会话处于 **协作 / 子任务** 流程、且某一步指派给 **编码子代理** 时，**Claude Code** 可以执行该步；与总控里口头委派是 **同一类子代理机制**，只是任务落在子任务格里，便于并行与追溯。**当前公开 EvoPanel 不会在输入栏「模式」菜单里展示 Plan 开关**，是否进入协作流以你界面与流式输出为准。见 [输入栏与选项](/docs/chat/composer) 中的 Plan 说明。",
        "",
        "## EvoPanel 操作（与飞书一致）",
        "- 发 **`/claude`** 或 **`/claude-code`**：当前会话进入 **Claude Code 直连**（与飞书 `/claude` 同款语义）。",
        "- 发 **`/lead`** 或 **`/main`**：切回 **主智能体**。",
        "- 或在角色/预设里选用 **Claude Code 直连** 入口（若你的版本提供），效果与上述斜杠一致。",
        "",
        "## 使用前提与注意",
        "- 运行环境需已按安装说明能 **正常拉起 Claude Code**（本机 SDK）；若直连失败，请看界面或日志里的提示。",
        "- 确认当前会话的 **工作空间** 指向你要改的项目目录，否则编码会在错误根目录下执行。",
        "- 更多斜杠差异（例如 **`/cron` 不会当建自动化**）见 [快捷指令](/docs/quick-commands)；输入栏与 **Plan** 菜单状态见 [输入栏与选项](/docs/chat/composer)。",
        "",
        "## 延伸阅读",
        "- [Claude Code 官方文档](https://docs.anthropic.com/en/docs/claude-code)",
      ],
      [
        "## Overview",
        "**Claude Code** (the coding runtime on your machine) shows up in **three patterns**: switch IM or EvoPanel to **direct Claude Code chat** and keep talking; stay on the **lead** and let it **delegate** coding steps to Claude Code as a **sub-agent**; or run **collaboration / subtask** flows where a row is assigned to the coding worker. Same engine, different **who owns the conversation**. EvoPanel slash commands align with IM where supported.",
        "",
        "## Pattern A — IM: switch to Claude Code, then chat continuously",
        "In Feishu (or another connected IM), send **`/claude`** (or **`/claude-code`**). The bot enters **Claude Code direct mode**: **your next normal messages in that topic** go to Claude Code, so you can **iterate, refine requirements, and keep coding across many turns** in one **continuous** Claude session.",
        "",
        "- **Back to the lead**: send **`/lead`** or **`/main`** to return to the main assistant while **keeping the same IM topic and LangGraph thread** so the lead can coordinate other work.",
        "- **Resume a Claude session**: send **`/claude`** with the **session id** from the bot hint or **`/status`** (“last Claude session”).",
        "- **Check state**: **`/status`** shows whether you are in **Claude Code direct** or **lead** mode plus a short summary.",
        "",
        "This is different from **`/new`**, which starts a **fresh** assistant thread. **`/claude` only switches the active track on the current thread**, which is why **continuous** coding chat works. On Feishu, follow any **`/new`** requirement first, then **`/claude`**.",
        "",
        "## Pattern B — Lead mode: Claude Code as a sub-agent",
        "When you **have not** switched the whole thread to direct mode, you talk to the **lead**. Describe goals, files, and constraints in **plain language**; the lead **delegates coding work** to the **Claude Code sub-agent** when needed and folds results back into the thread.",
        "",
        "In **EvoPanel**, watch the **console-style stream** alongside the main chat. On the **same main thread**, Claude Code sessions are **usually reused** so follow-ups like “add tests” or “fix the error” continue in one external session unless you ask for a clean break.",
        "",
        "## Pattern C — Collaboration subtasks",
        "When a **collaboration / subtask** flow assigns a step to the **coding worker**, **Claude Code** can run that step—same delegation mechanism as Pattern B, but **structured on a subtask row** for parallelism and traceability. The public EvoPanel build **does not show a Plan toggle in the Mode menu**; follow your UI and stream panels. See **Plan** under [Composer & options](/docs/chat/composer).",
        "",
        "## EvoPanel usage (same as IM)",
        "- **`/claude`** or **`/claude-code`**: enable **Claude Code direct** for this session.",
        "- **`/lead`** or **`/main`**: return to the **lead** assistant.",
        "- Or pick a **Claude Code direct** preset/entry if your build exposes one.",
        "",
        "## Prerequisites and cautions",
        "- Claude Code must be **installed and runnable** per your setup guide; if direct mode fails, follow the on-screen or log hints.",
        "- Point the session **workspace** at the repo you intend to edit.",
        "- Slash-command quirks (e.g. **`/cron` is not a scheduler shortcut**) live under [Shortcuts](/docs/quick-commands); composer layout and **Plan** visibility are in [Composer & options](/docs/chat/composer).",
        "",
        "## Read more",
        "- [Anthropic’s Claude Code docs](https://docs.anthropic.com/en/docs/claude-code)",
      ],
    ),
  },
  {
    slug: ["chat", "quick-create-role"],
    title: { zh: "快速创建角色", en: "Quick create: preset role" },
    description: {
      zh: "在实时对话里用自然话新建预设角色（智能体），与侧栏预设角色同一套数据。",
      en: "Create a preset role from live chat in plain language—same data as sidebar preset roles.",
    },
    body: desktopStub(
      [
        "## 操作说明",
        "在 **实时对话** 里像和同事交代需求一样打字即可，不必记斜杠命令。说明白：**要新建一个预设角色 / 智能体**、**内部代号**、**显示名称**、**负责什么、语气与禁区**。",
        "",
        "**内部代号**（给软件当文件名用的那一段）只能用 **英文字母、数字、连字符**，不要用中文、空格或特殊符号；**显示名和人设**可以用中文写清楚。",
        "",
        "助手会整理成可保存的配置，**写入前通常会请你确认**；确认后就会出现在侧栏 **[预设角色](/docs/config/agents)** 里，之后也可在那里编辑、复制或删除。",
        "",
        "## 可以怎么说（示例）",
        "- 「帮我新建预设角色：代号 `data-helper`，显示名「数据助手」，专门把表格总结成三条要点，不要编造数字。」",
        "- 「创建一个子智能体，代号 `invoice-bot`，人设里强调只根据附件读字段，不确定就写未知。」",
        "",
        "## 小提示",
        "若模型、技能、工具权限一次说不清，可以分几条消息补充；与在预设角色页里手动填写是同一套结果，选你顺手的方式即可。",
      ],
      [
        "## How it works",
        "In **live chat**, describe what you want in plain language—no slash commands required. Say you want a **new preset role / agent**, give a **machine id**, **display name**, and **behavior** (tone, scope, things to avoid).",
        "",
        "The **machine id** (used like a file key) must be **ASCII letters, digits, or hyphens** only—no spaces or punctuation. **Display names and persona text** can be in any language you prefer.",
        "",
        "The assistant will draft a saveable config and **usually asks you to confirm** before writing. After save, the role appears under sidebar **[Preset roles](/docs/config/agents)** for later edits.",
        "",
        "## Example prompts",
        "- “Create a preset role with code `data-helper`, display name ‘Data helper’, summarize spreadsheets into three bullets, never invent numbers.”",
        "- “Add a sub-agent `invoice-bot` whose persona says: only read fields from attachments; write ‘unknown’ when unsure.”",
        "",
        "## Tips",
        "You can send follow-up messages for model choice, skills, or tool limits—same outcome as filling the preset-roles page by hand; pick whichever is faster for you.",
      ],
    ),
  },
  {
    slug: ["chat", "quick-create-skill"],
    title: { zh: "快速创建技能", en: "Quick create: skill" },
    description: {
      zh: "在实时对话里用自然话把可复用流程保存为技能，与侧栏技能同一套数据。",
      en: "Save a reusable workflow as a skill from live chat—same data as sidebar skills.",
    },
    body: desktopStub(
      [
        "## 操作说明",
        "当你刚跑通一套**以后还想照做**的步骤（检查清单、发布流程、排错顺序等），在 **实时对话** 里直接说：**「请把刚才这套做法保存成技能」**，并给一个 **技能名**（建议 **小写英文、数字、连字符**，例如 `deploy-checklist`）。",
        "",
        "助手会起草技能说明（何时该用、分步怎么做、注意点），**创建或大范围改写前一般会请你确认**。保存后可在侧栏 **[技能](/docs/ext/skills)** 里开关、继续改或删掉。",
        "",
        "## 适合 / 不适合",
        "- **适合**：多步、会重复、你希望团队或以后自己「按同一套规矩」执行的事。",
        "- **不适合**：一次性随口问答；不必什么都存成技能。",
        "",
        "## 小提示",
        "若技能要附带示例文件或脚本，可以在对话里说明，助手会按界面能力帮你整理；复杂内容也可之后在技能目录里再改。",
      ],
      [
        "## How it works",
        "After you finish a **repeatable** workflow (checklists, releases, debugging order, …), say in **live chat**: **“Save what we just did as a skill named …”** and pick a **skill id** (lowercase letters, digits, hyphens—e.g. `deploy-checklist`).",
        "",
        "The assistant drafts the skill text (when to use it, numbered steps, pitfalls) and **usually asks for confirmation** before create or large rewrites. Saved skills show up under **[Skills](/docs/ext/skills)** for toggles and edits.",
        "",
        "## When to use it",
        "- **Good fit**: multi-step work you expect to repeat and want standardized.",
        "- **Skip**: one-off questions—no need to save everything as a skill.",
        "",
        "## Tips",
        "Mention if you need sample files or helper scripts; you can refine files later from the skill folder when the UI exposes that.",
      ],
    ),
  },
  {
    slug: ["chat", "quick-create-cron"],
    title: { zh: "快速创建自动化", en: "Quick create: scheduled job" },
    description: {
      zh: "在实时对话里用自然话创建自动化自动化，与侧栏自动化同一套数据。",
      en: "Create scheduled automations from live chat—same jobs as the Scheduled jobs sidebar.",
    },
    body: desktopStub(
      [
        "## 操作说明",
        "在 **实时对话** 里说清三件事：**多久执行一次**、**任务标题怎么叫**、**到点要让助手帮你做什么**（可以带工作空间、输出格式等要求）。例如：「每个工作日早上 9 点，根据当前工作空间写一段昨日工作总结」。",
        "",
        "助手会整理成与侧栏 **[自动化](/docs/tasks/cron)** **同一条数据**；你之后在那页里启用/暂停、改时间或手动跑一次都可以。",
        "",
        "若你熟悉 cron，也可以直接说「用 `0 9 * * 1-5` 触发，名字叫…，执行时让模型…」。",
        "",
        "## 不要用错成「斜杠指令」",
        "在 EvoPanel 里输入 `/cron …` **通常只会当普通聊天文字**，不会变成建任务按钮。**建计划靠自然话说明**，或打开侧栏自动化页操作；机器人里的指令规则也不完全一样，详见 [快捷指令](/docs/quick-commands)。",
      ],
      [
        "## How it works",
        "In **live chat**, state **how often** it should run, **what to call the job**, and **what the assistant should do each time** (workspace, output shape, …). Example: “Every weekday at 9am, draft a short yesterday recap from my current workspace.”",
        "",
        "The assistant turns that into the same automation entry as **[Scheduled jobs](/docs/tasks/cron)**—you can pause, edit schedules, or run once from that page later.",
        "",
        "If you know cron, you can say: “Use `0 9 * * 1-5`, title …, prompt …”.",
        "",
        "## Not a slash command",
        "Typing `/cron …` in EvoPanel is **usually plain chat**, not a magic create shortcut. Create jobs **in natural language** or from the sidebar page; IM bots differ—see [Shortcuts](/docs/quick-commands).",
      ],
    ),
  },

  {
    slug: ["panel", "general"],
    title: { zh: "设置 · 通用", en: "Settings · General" },
    description: {
      zh: "外观、默认记忆、沙箱与数据目录、清理缓存。",
      en: "Theme, default memory, sandbox paths, data folder, cache reset.",
    },
    body: desktopStub(
      [
        "## 入口",
        "聊天窗口底部 **设置 → 通用**。",
        "",
        "## 各区块做什么",
        "- **外观**：在 **浅色 / 深色 / 跟随系统** 间切换，点选后会有「外观已保存」提示。",
        "- **记忆与上下文 · 默认启用记忆**：控制**新会话**是否默认打开记忆；关掉了也仍可在输入栏旁单独打开；已开会话的开关存在本机会话列表里（见界面灰色说明）。",
        "- **文件系统模式 · 启用虚拟/沙箱路径**：开则助手说明里倾向用虚拟路径（如 `/mnt/user-data`）；关则更贴近本机路径与当前终端语法（如 Windows PowerShell）。",
        "- **用户工作空间**：填默认数据目录，旁有 **选择目录** 按钮。",
        "- **维护 · 清理对话缓存并重载**：对话很多、页面卡顿时用；会清本地会话相关缓存并刷新页面。",
        "",
        "## 补充说明",
        "更多环境变量与目录约定见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Entry",
        "Chat footer **Settings → General**.",
        "",
        "## Sections",
        "- **Appearance**: pick **light / dark / system**; you should see a saved toast.",
        "- **Memory & context · Memory on by default**: default for **new** threads; per-thread override stays in the composer; closed threads keep their own toggle (see the gray hint in-app).",
        "- **Filesystem mode · Virtual/sandbox paths**: on prefers virtual paths such as `/mnt/user-data`; off prefers host paths and shell syntax (e.g. PowerShell on Windows).",
        "- **User workspace**: default data root with **Pick folder**.",
        "- **Maintenance · Clear chat caches and reload**: when the UI stalls from huge history—clears local session caches and reloads.",
        "",
        "## Supplementary docs",
        "Env vars and folder conventions: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ],
    ),
  },
  {
    slug: ["panel", "models-tab"],
    title: { zh: "设置 · 模型", en: "Settings · Models" },
    description: {
      zh: "设置左侧「模型」：与旧侧栏「模型配置」同一界面。",
      en: "Settings **Models** tab—same UI as legacy sidebar model setup.",
    },
    body: desktopStub(
      [
        "## 入口",
        "在对话窗口底部点 **设置**，左侧选 **模型**。与旧版侧栏 **配置 → 模型配置** 是**同一块界面、同一份数据**（若你的版本已隐藏旧侧栏，只保留此处入口亦可）。",
        "## 在本页完成的操作",
        "按下列顺序操作即可：",
        "1. **服务商**：左侧选好或 **添加服务商**，填名称、接口地址、密钥并保存。",
        "2. **先测再建模**：有测试或鉴权相关按钮时，先按提示确认能连上。",
        "3. **添加模型**：在该服务商下 **添加模型**，名称要与对方平台一致。",
        "4. **主模型**：指定默认用的那一个，聊天和任务都会跟它走。",
        "5. **收尾**：需要时调整顺序、删掉不用的服务商；留意保存成功的提示。",
        "配完后关掉设置面板即可回到聊天，已选的模型一般会在输入框下方的模型按钮里看到。",
        "",
        "## 补充说明",
        "多密钥、自建兼容接口等见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Entry",
        "In **live chat**, click **Settings** at the bottom, then **Models** on the left—the **same screen and data** as legacy sidebar **Configuration → Model configuration** when that entry still exists.",
        "## Tasks on this screen",
        "Add or pick a **provider**, run any **tests**, **add models** with exact IDs, set the **primary model**, then tidy order or delete unused providers.",
        "Close the settings drawer when you are done—the composer **model** button should reflect your chosen model.",
        "",
        "## Supplementary docs",
        "Custom endpoints and provider quirks: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ],
    ),
  },
  {
    slug: ["panel", "feishu-tab"],
    title: { zh: "设置 · IM 通信", en: "Settings · IM" },
    description: {
      zh: "设置里「IM 通信」：左侧渠道列表与开关，右侧表单、扫码绑定与测试。",
      en: "Settings **IM**: channel list + toggles, right-hand form, QR bind, test.",
    },
    body: desktopStub(
      [
        "## 入口",
        "聊天窗口底部 **设置 → IM 通信**（全屏侧栏入口标题可能为 **IM Channels**）。",
        "",
        "## 界面与操作",
        "- **左侧**：本机已暴露的渠道列表（飞书、钉钉、Slack、Telegram 等，以你网关配置为准）。点一行切换右侧详情；行末 **开关** 启用/停用该渠道（勿点在开关上误切行）。",
        "- **右侧标题栏**：显示 **已连接 / 未连接**；飞书、微信等支持时会出现 **扫码绑定**；点 **测试连通性** 走网关自检。",
        "- **说明区**：渠道相关的步骤链接随当前渠道变化。",
        "- **表单**：多数渠道为 **App ID** + **App Secret**（微信个人号为 **Account ID** + **Bot Token**）；密码框旁可点 **眼睛** 切换显示。",
        "- **保存**：输入框 **失焦** 后约 0.3 秒自动保存，成功会有「已保存」提示。",
        "- **全屏页** 右上角还有 **Reload**：重新拉渠道状态。",
        "",
        "## 补充说明",
        "网关侧渠道清单、Webhook、开放平台权限等见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。飞书场景说明另见 [飞书集成](/docs/config/feishu)。",
      ],
      [
        "## Entry",
        "Chat footer **Settings → IM** (full-page shell may read **IM Channels**).",
        "",
        "## UI layout and actions",
        "- **Left**: channels your Gateway exposes (Feishu, DingTalk, Slack, Telegram, …). Click a row to edit; use the **toggle** at the end to enable/disable (click the row body, not the toggle, when switching channels).",
        "- **Title bar**: **Connected / Not connected**; **Scan to bind** appears for Feishu/WeChat when supported; **Test connectivity** hits the Gateway check.",
        "- **Tips**: step-by-step HTML updates per channel.",
        "- **Form**: usually **App ID** + **App Secret** (WeChat iLink uses **Account ID** + **Bot Token**); eye icon toggles secret visibility.",
        "- **Save**: values persist shortly after an input **blurs**—watch the success toast.",
        "- **Full page** also has **Reload** in the header to refresh channel status.",
        "",
        "## Supplementary docs",
        "Gateway channel wiring and webhooks: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow). Feishu-oriented notes: [Feishu integration](/docs/config/feishu).",
      ],
    ),
  },
  {
    slug: ["panel", "memory-tab"],
    title: { zh: "设置 · 记忆", en: "Settings · Memory" },
    description: {
      zh: "按助手查看摘要与事实，支持搜索、刷新与清空；与侧栏记忆管理为同一能力。",
      en: "Per-agent summaries and facts—search, reload, clear; same capability as sidebar Memory management.",
    },
    body: desktopStub(
      [
        "## 入口",
        "**设置 → 记忆**：聊天窗口底部打开 **设置**，左侧选 **记忆**。侧栏若存在 **记忆管理**（全页），与本文为**同一套数据与操作**，仅布局不同：设置内顶部为 **下拉** 选择助手；侧栏全页为多助手时的 **芯片** 切换。",
        "",
        "## 界面能力",
        "- **切换助手**：顶部选择当前要查看的助手（默认 **main**）；展示名与 **[预设角色](/docs/config/agents)** 一致。",
        "- **搜索**：在搜索框输入关键词，筛选 **摘要** 与 **事实** 中的文字。",
        "- **Tab**：**全部** / **摘要** / **事实** 控制展示范围。",
        "- **摘要**：按「用户上下文」「历史背景」等分组只读浏览，并显示更新时间。",
        "- **事实**：每条可 **删除**（需确认）。",
        "- **刷新**：从网关重新加载当前助手记忆。",
        "- **清空当前**：清空**当前选中助手**的全部已存记忆（需确认，不可恢复）。",
        "",
        "## 与输入栏「记忆」的关系",
        "输入栏 **记忆：开/关** 只影响**之后**是否写入；本页用于查看或删除**已写入**内容。**新会话是否默认开启记忆** 在 **设置 → 通用**，见 [设置 · 通用](/docs/panel/general)。",
        "",
        "## 补充说明",
        "落盘 `memory.json`、API 等见 GitHub：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)。",
      ],
      [
        "## Entry",
        "**Settings → Memory**: open **Settings** from the chat footer, then **Memory** on the left. Sidebar **Memory management** (full page) is the **same data and actions** with a different layout: the drawer uses a top **dropdown** for the agent; the full page uses **chips** when many personas exist.",
        "",
        "## Capabilities",
        "- **Switch agent**: pick the persona to inspect (defaults to **main**); labels align with **[Preset roles](/docs/config/agents)**.",
        "- **Search**: filter summary and fact text.",
        "- **Tabs**: **All** / **Summaries** / **Facts**.",
        "- **Summaries**: read-only cards grouped under user context vs. history, with update hints.",
        "- **Facts**: **Delete** per row (with confirmation).",
        "- **Reload**: fetch the latest memory from the Gateway.",
        "- **Clear current**: wipe **the selected agent’s** stored memory (irreversible after confirm).",
        "",
        "## Relation to the composer Memory toggle",
        "The composer toggle controls **future** writes; this screen manages **what is already stored**. Default memory-on for new chats is under **Settings → General**—see [Settings · General](/docs/panel/general).",
        "",
        "## Supplementary docs",
        "On-disk `memory.json` and APIs: [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow).",
      ],
    ),
  },
  {
    slug: ["concepts", "overview"],
    title: { zh: "概念总览", en: "Concepts overview" },
    description: {
      zh: "用一页话对齐首页里各块能力在说什么。",
      en: "One page that maps homepage areas to plain language.",
    },
    body: {
      zh: `
读完 [快速开始](/docs/getting-started) 后，可以用下面这张表对照首页「能力」区块：

| 你在首页看到的 | 可以理解为 |
|----------------|------------|
| 编排 · 总控 | 谁负责定目标、拆步骤、把多路工作收束到一起 |
| 子任务工作流 | Plan 执行后，子任务依赖与进度在面板里摊开，不用在聊天里翻 |
| 沙箱与工具 | 命令和工具在哪里跑、出错了怎么重试、怎么看到日志 |
| Prompt 缓存 | 长对话里稳定提示前缀，典型命中率约 90%，显著省 API 费用 |
| 思维导图 | Agent 自动维护思路图，多轮里看清排查链路与问题怎么被解决 |
| 记忆与上下文 | 长任务里哪些该记住、怎样避免把整段聊天反复塞给模型 |
| 技能与外部工具 | 额外能力包、外部服务怎么接进来、怎么授权 |

具体怎么用在 EvoPanel 里，可按左侧目录从 [快速开始](/docs/getting-started) 或 [输入栏与选项](/docs/chat/composer) 往下看。

## 接下来建议读什么

1. [快速开始](/docs/getting-started)  
2. 首页 [路线图](/#evolution-pulse)、[演进日志](/evolution)
`.trim(),
      en: `
After [Getting started](/docs/getting-started), use this table to read the homepage **capabilities** section:

| Homepage area | In plain terms |
|---------------|----------------|
| Orchestration | Who owns the goal, how work splits and merges |
| Subtask workflow | After Plan runs, dependencies and progress on a panel—not buried in chat |
| Sandbox & tools | Where commands run, how retries and logs help |
| Prompt caching | Stable prefixes on long threads; ~90% hit rates typical; lower API spend |
| Mind map | Auto-maintained reasoning graph for triage and multi-turn retrospectives |
| Memory & context | What to remember across long work without pasting entire chats |
| Skills & external tools | How optional packs and services connect and get permission |

For how to use these in EvoPanel, follow the left-hand doc tree from [Getting started](/docs/getting-started) or [Composer & options](/docs/chat/composer).

## What to read next

1. [Getting started](/docs/getting-started)  
2. Homepage [roadmap pulse](/#evolution-pulse) and [Evolution log](/evolution)
`.trim(),
    },
  },
  {
    slug: ["concepts", "architecture"],
    title: { zh: "架构要点", en: "Architecture notes" },
    description: {
      zh: "用分层方式理解编排、执行、记忆和界面。",
      en: "Layers for planning, execution, memory, and surfaces.",
    },
    body: {
      zh: `
可以把 EvoFlow 想成四层（从下往上依赖）：

1. **编排**：把目标说清楚、拆成任务、盯住依赖和进度。  
2. **执行**：真正去跑命令、调工具、连外部系统；这一层强调日志可读、失败可重试。  
3. **记忆与状态**：在长对话、长任务里留下该留的摘要和产物，而不是把全部聊天记录反复交给模型。  
4. **使用与集成**：EvoPanel、技能、外部工具等是你日常点得到的地方；它们调用下面几层的能力。

聊天是一种用法；任务、定时流程等也可以共用同一套能力。

## 延伸阅读

- [概念总览](/docs/concepts/overview)  
- [演进日志](/evolution)
`.trim(),
      en: `
Think of EvoFlow in four layers (bottom to top):

1. **Orchestration**: clarify goals, split work, track dependencies.  
2. **Execution**: run tools and integrations with logs and retries you can trust.  
3. **Memory & state**: keep useful summaries without stuffing entire chats into the model.  
4. **Surfaces**: EvoPanel, skills, and external tools—the places you click; they call into the layers below.

Chat is one surface; tasks and schedules use the same stack.

## Read more

- [Concepts overview](/docs/concepts/overview)  
- [Evolution log](/evolution)
`.trim(),
    },
  },
];

const pageByKey = new Map<string, DocPage>();
for (const p of pages) {
  pageByKey.set(slugKey(p.slug), p);
}

export const docsNavSections: DocNavSection[] = [
  {
    title: { zh: "快速开始", en: "Getting started" },
    items: [
      { slug: ["getting-started"], title: { zh: "快速开始", en: "Getting started" } },
      { slug: ["quick-commands"], title: { zh: "快捷指令", en: "Shortcuts" } },
      { slug: ["ext", "coding-assistants"], title: { zh: "编码助手（Claude Code）", en: "Coding assistants" } },
      { slug: ["chat", "quick-create-role"], title: { zh: "快速创建角色", en: "Quick create: role" } },
      { slug: ["chat", "quick-create-skill"], title: { zh: "快速创建技能", en: "Quick create: skill" } },
      { slug: ["chat", "quick-create-cron"], title: { zh: "快速创建自动化", en: "Quick create: schedule" } },
    ],
  },
  {
    title: { zh: "实时对话", en: "Live chat" },
    items: [
      { slug: ["chat", "composer"], title: { zh: "输入栏与选项", en: "Composer & options" } },
      { slug: ["chat", "goal"], title: { zh: "目标", en: "Goal" } },
    ],
  },
  {
    title: { zh: "侧栏菜单", en: "Shell sidebar" },
    items: [
      { slug: ["tasks", "center"], title: { zh: "任务中心", en: "Task center" } },
      { slug: ["tasks", "cron"], title: { zh: "自动化", en: "Scheduled jobs" } },
      { slug: ["ext", "skills"], title: { zh: "技能", en: "Skills" } },
      { slug: ["ext", "tools"], title: { zh: "MCP", en: "MCP" } },
      { slug: ["config", "agents"], title: { zh: "预设角色", en: "Preset roles" } },
    ],
  },
  {
    title: { zh: "设置", en: "Settings" },
    items: [
      { slug: ["panel", "general"], title: { zh: "通用", en: "General" } },
      { slug: ["panel", "models-tab"], title: { zh: "模型", en: "Models" } },
      { slug: ["panel", "feishu-tab"], title: { zh: "IM 通信", en: "IM" } },
      { slug: ["panel", "memory-tab"], title: { zh: "记忆", en: "Memory" } },
    ],
  },
];

export function getDocPageBySlug(slug: DocSlug): DocPage | undefined {
  return pageByKey.get(slugKey(slug));
}

export function getAllDocSlugs(): DocSlug[] {
  return pages.map((p) => p.slug);
}

/** Legacy doc paths → current slug (static export + dev redirects). */
export const DOC_SLUG_REDIRECTS: Record<string, DocSlug> = {
  "chat/hosted": ["chat", "goal"],
};

export function getDocSlugRedirect(slug: DocSlug): DocSlug | undefined {
  return DOC_SLUG_REDIRECTS[slugKey(slug)];
}

export function getLegacyDocRedirectSlugs(): DocSlug[] {
  return Object.keys(DOC_SLUG_REDIRECTS).map((k) => k.split("/").filter(Boolean));
}

export function flattenDocsNav(): { href: string; title: Record<SiteLocale, string> }[] {
  const out: { href: string; title: Record<SiteLocale, string> }[] = [];
  for (const section of docsNavSections) {
    for (const item of section.items) {
      out.push({
        href: `/docs/${item.slug.join("/")}`,
        title: item.title,
      });
    }
  }
  return out;
}

export function docsIndexCopy(locale: SiteLocale): {
  title: string;
  description: string;
  intro: string;
} {
  if (locale === "zh") {
    return {
      title: "文档",
      description: "说明 EvoPanel 里常用功能在什么位置、适合干什么。",
      intro:
        "下方分区与 EvoPanel 主界面一致：**快速开始**（含入门与模型说明、快捷指令、编码助手，以及在对话里快速创建角色/技能/自动化的说明）→ **实时对话**（**输入栏与选项**、**目标**）→ **侧栏菜单** → **设置**。Plan 模式演示视频与界面截图见站内 [**产品演示**](/showcase/)。",
    };
  }
  return {
    title: "Documentation",
    description: "Where EvoPanel features live and what they are for.",
    intro:
      "Sections mirror EvoPanel: **Getting started** (onboarding with model setup, shortcuts, coding assistants, plus chat-first quick create for roles/skills/schedules) → **Live chat** (**Composer & options**, then **Goal**) → **Shell sidebar** → **Settings**. Plan-mode videos and GUI screenshots: [**Product showcase**](/showcase/).",
  };
}
