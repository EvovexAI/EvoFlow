import type { SiteLocale } from "../locales";

/** 维护说明：正文与 EvoPanel 客户端菜单、按钮文案对齐；改版时以实际软件界面为准。 */
/** URL 段，如 ["chat","models-scenes"] → /docs/chat/models-scenes */
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
      zh: "下载安装 EvoPanel，在软件里配好模型即可开始用。",
      en: "Install EvoPanel, add your models in the app, and start using it.",
    },
    body: {
      zh: `
下文说明 **EvoPanel 桌面客户端**：装好以后，在软件里完成模型相关设置即可。

## 1. 下载安装包

打开 [EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases/latest)，按你的系统选择与本仓库一并发布的桌面安装包（若有），下载后按向导安装。

也可从本站顶栏 **下载** 进入同一发行页。

## 2. 首次打开

若出现欢迎或引导页，按屏幕提示选语言、外观等即可。

## 3. 配置模型

1. 在软件侧栏找到 **配置**，点 **模型配置**。  
2. 按界面提示添加服务商或模型：填入访问密钥、选好模型；若有「测试连接」之类按钮，建议先测再保存。  
3. 若有「默认模型」选项，可把常用模型设为默认。

密钥只保存在你的电脑上，不要发给他人。

## 4. 开始用

点 **实时聊天**（或主界面上的聊天入口），在输入框下方选好模型，即可对话。任务、定时任务、技能等入口在侧栏或聊天窗口左侧的快捷区里。

本站文档按 **开始 → 实时对话 → 任务与调度 → 配置与面板** 分区，方便你对照软件里的位置。

## 延伸阅读

- [功能说明](/#capabilities)、[典型场景](/#scenarios)  
- [概念总览](/docs/concepts/overview)、[架构要点](/docs/concepts/architecture)
`.trim(),
      en: `
This page is about the **EvoPanel** desktop app: install it, then finish model setup inside the app.

## 1. Download and install

Open [EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases/latest), pick the desktop installer for your platform when published, download, and run it.

You can also use **Download** in the site header to reach the same releases page.

## 2. First launch

If a welcome or setup screen appears, follow the prompts for language, appearance, and so on.

## 3. Configure models

1. In the sidebar, open **配置** → **模型配置**.  
2. Add a provider or model: paste your **access keys**, pick model names, and use any **test connection** button if shown, then save.  
3. Set a **default model** when the app offers that option.

Keys stay on your machine—do not share them.

## 4. Start using the app

Open **实时聊天** (or the main chat entry), choose a model above the input area, and send a message. Tasks, schedules, skills, and more live in the sidebar or the shortcuts next to the chat list.

These docs follow **Start → Chat → Tasks & schedules → Configuration & panel** so you can match them to the app.

## Read next

- [Capabilities](/#capabilities), [Scenarios](/#scenarios)  
- [Concepts overview](/docs/concepts/overview), [Architecture notes](/docs/concepts/architecture)
`.trim(),
    },
  },

  {
    slug: ["chat", "models-scenes"],
    title: { zh: "模型与场景", en: "Model & scenes" },
    description: {
      zh: "在输入区下方选模型；在顶栏切换对话场景。",
      en: "Pick a model under the composer; switch the chat scene in the header.",
    },
    body: desktopStub(
      [
        "## 模型与场景",
        "在 **实时聊天** 里：",
        "- **模型**：输入框下面左侧的按钮会显示当前使用的模型名称。点开后从列表里切换；若暂时没有任何可用模型，界面会给出相应提示。若某条模型支持看图或附件，列表里一般会标出来。",
        "- **场景**：顶栏可以切换不同对话场景，例如 **日常对话**、**任务规划**、**文件处理**、**网络搜索** 等；把鼠标悬停在选项上，通常能看到简短说明，帮助你选对场景。",
        "具体列表和说明以你安装的版本为准；场景有时会和你选的模型搭配使用。",
      ],
      [
        "## Model & scenes",
        "In **live chat**:",
        "- **Model**: use the pill under the composer to see and change the active model. If nothing is available yet, the UI explains what to do next. Models that support images or attachments are usually labeled in the list.",
        "- **Scenes**: use the header to switch presets such as **Daily chat**, **Task planning**, **Files**, **Web**, and more—hover the entries to read short hints.",
        "Exact labels depend on your build; scenes may interact with the model you picked.",
      ],
    ),
  },
  {
    slug: ["chat", "session-modes"],
    title: { zh: "会话模式", en: "Session modes" },
    description: {
      zh: "输入区下方的「模式」：快慢与推理深度等档位。",
      en: "The **Mode** control under the composer: speed and reasoning depth presets.",
    },
    body: desktopStub(
      [
        "## 会话模式",
        "点输入框下方的 **「模式」** 按钮，一般可以看到 **闪速**、**思考**、**Pro**、**Ultra** 等档位，用来在同一模型下切换「更快」或「更细」等偏好。",
        "部分版本还会在菜单里提供 **任务协作（界面里可能写作 Plan）** 相关项。详见 [Plan（任务协作）](/docs/chat/plan-collab)。",
      ],
      [
        "## Session modes",
        "Open the **Mode** pill under the composer to pick presets such as **Flash**, **Thinking**, **Pro**, and **Ultra**—these tune speed vs depth for the same model.",
        "Some builds also show **task collaboration** entries (sometimes labeled **Plan**). See [Plan (task collaboration)](/docs/chat/plan-collab).",
      ],
    ),
  },
  {
    slug: ["chat", "plan-collab"],
    title: { zh: "Plan（任务协作）", en: "Plan (task collaboration)" },
    description: {
      zh: "多步任务时在「模式」里协作、规划与授权执行。",
      en: "Collaborate, plan, and authorize execution for multi-step work from **Mode**.",
    },
    body: desktopStub(
      [
        "## 这是做什么的",
        "适合目标步骤多、需要先对齐再执行的情况：软件里可以打开 **任务协作**，先停留在「想清楚再动手」的阶段，再由你确认后进入执行阶段。",
        "## 在哪里找",
        "入口一般在 **实时聊天** 输入框下方的 **「模式」** 菜单里，可能显示为 **Plan** 或 **任务协作** 等字样（以你屏幕上的为准）。**若当前版本没有这个菜单项，说明该入口未在界面中开放**，不代表你以后升级后不会出现。",
        "## 打开之后怎么用",
        "开启后，同一区域可能出现 **回到规划**、**授权执行** 一类按钮：前者把流程拉回「只规划、不擅自执行」；后者表示你同意进入执行阶段。具体用词以界面为准。",
        "这和顶栏里选的「任务规划」类场景不是一回事：顶栏更像「这类事用什么方式聊」；这里是「这一轮对话要不要走协作与分阶段确认」。更多基础说明见 [会话模式](/docs/chat/session-modes)。",
      ],
      [
        "## What it is for",
        "Useful when work has many steps: turn on **task collaboration**, stay in a planning-first phase, then explicitly allow execution.",
        "## Where it lives",
        "Look under the composer **Mode** menu in **live chat**—labels may read **Plan** or similar. If the item is missing, your build simply hides that control; it may appear after an update.",
        "## After you turn it on",
        "You may see actions such as **Back to plan** and **Authorize run** (wording varies). Header **task planning** presets describe the kind of work; this menu describes how strictly the chat waits for your approval.",
        "See also [Session modes](/docs/chat/session-modes).",
      ],
    ),
  },
  {
    slug: ["chat", "memory-hosted-workspace"],
    title: { zh: "记忆、托管与工作空间", en: "Memory, hosted agent & workspace" },
    description: {
      zh: "记忆开关、托管面板、工作文件夹在输入区下方的入口。",
      en: "Memory toggle, hosted run panel, and workspace picker under the composer.",
    },
    body: desktopStub(
      [
        "## 记忆",
        "**「记忆：开 / 关」** 决定这一轮对话要不要带上之前的要点摘要、并在回复后继续整理记忆。关掉后对话更「健忘」，适合一次性问答；打开后更适合长期跟进同一主题。",
        "## 托管",
        "**「托管」** 会打开一块单独的区域，用来查看或操作「交给助手自动跑」的那部分流程，和「记不记得以前说过什么」不是同一件事。",
        "## 工作空间",
        "**「工作空间」** 用来表示当前文件操作落在哪个文件夹（有时是软件提供的沙箱目录，有时是你本机上的某个文件夹）。更完整的默认目录、是否使用沙箱等，可以在 **面板设置 → 通用** 里改；聊天窗口这里主要是快速查看和切换。",
      ],
      [
        "## Memory",
        "**Memory on/off** decides whether the thread keeps helpful summaries across turns.",
        "## Hosted",
        "**Hosted** opens a panel for runs that continue on their own—separate from memory.",
        "## Workspace",
        "**Workspace** shows which folder (or sandbox) file actions use. Set defaults under **Panel settings → General**; the chat pill is for quick checks.",
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
        "## 任务中心",
        "在侧栏 **扩展** 里点 **任务中心**；聊天窗口左侧也有同名快捷入口，进去是同一处。",
        "适合把一件大事拆成多步、需要反复打开查看进度或结果的工作；和随手聊天相比，更偏「清单式」的长期事项。",
      ],
      [
        "## Task center",
        "Open **任务中心** under **扩展**, or use the matching shortcut beside the chat list.",
        "Use it for longer checklists and work you revisit; chat is better for quick back-and-forth.",
      ],
    ),
  },
  {
    slug: ["tasks", "cron"],
    title: { zh: "定时任务", en: "Scheduled jobs" },
    description: {
      zh: "按时间表自动跑检查或任务。",
      en: "Run checks or jobs on a schedule.",
    },
    body: desktopStub(
      [
        "## 定时任务",
        "在侧栏 **数据** 里点 **定时任务**；聊天窗口左侧也有入口。",
        "用来按周期提醒、巡检或执行固定流程。若要发到飞书、钉钉、Telegram 等，需要先在 **消息渠道**（或 **设置 → IM 通信**）里把对应平台接好并显示为已连接。",
      ],
      [
        "## Scheduled jobs",
        "Open **定时任务** under **数据**, or use the shortcut beside the chat list.",
        "Use it for recurring checks. Connect **消息渠道** first if results should go to Feishu, Telegram, and so on.",
      ],
    ),
  },

  {
    slug: ["config", "models"],
    title: { zh: "模型配置", en: "Model configuration" },
    description: {
      zh: "从添加服务商、填密钥到设主模型的完整说明。",
      en: "Add providers, keys, models, and pick the primary model.",
    },
    body: desktopStub(
      [
        "## 从哪里进",
        "在侧栏点 **配置**，再点 **模型配置**。这里是整台软件共用的模型列表：聊天、任务都会用到你在这里设好的主模型和备选。",
        "正在聊天时也可以点窗口底部的 **设置**，左侧选 **模型**——界面和这里相同，只是入口不同。",
        "## 建议按这个顺序做",
        "1. **先管好服务商**：左侧会列出常见云厂商等。若还没有你要用的，点 **添加服务商**，在弹窗里填 **名称**、**接口地址**（有的选项会自动带出地址）、**访问密钥**（本地、免鉴权的服务可按提示留空）。填完点保存。",
        "2. **确认能连上**：选中刚加的服务商后，若右侧有连接、鉴权或测试类按钮，建议先按界面说明测一遍，再添加模型，避免名字填对却连不通。",
        "3. **添加具体模型**：在该服务商下点 **添加模型**，把平台控制台里显示的**模型名称**原样填进来（多填几条也可以）。不需要的条目可以关掉或删掉。",
        "4. **指定主模型**：在列表里选一个作为**主模型**——这是聊天和任务默认会用的那个；以后想换默认，就改主模型即可。",
        "5. **排序与清理**：需要时可以拖拽调整顺序，或删除不再使用的服务商；多数改动保存后会有提示，按提示来即可。",
      ],
      [
        "## Where to open it",
        "Sidebar **配置 → 模型配置** is the shared catalog for the whole app. You can also open **Settings → Models** from the chat footer—the UI is the same.",
        "## Recommended flow",
        "1. **Add a provider**: pick a vendor on the left or use **Add provider**. Enter a **name**, **endpoint**, and **API key** (leave blank only when the UI says it is optional). Save.",
        "2. **Check connectivity**: run any **test** or **auth** actions the page offers before adding models, so you know keys and URLs work.",
        "3. **Add models**: under that provider, use **Add model** and paste the **exact model IDs** shown in the vendor console. Disable or remove entries you do not need.",
        "4. **Pick a primary model**: choose which model chat and tasks should default to; change it anytime.",
        "5. **Reorder or clean up**: drag to reorder or delete unused providers; watch the on-screen save hints.",
      ],
    ),
  },
  {
    slug: ["config", "agents"],
    title: { zh: "智能体管理", en: "Agent management" },
    description: {
      zh: "维护角色与智能体列表。",
      en: "Maintain personas and agent profiles.",
    },
    body: desktopStub(
      [
        "## 智能体管理",
        "在侧栏 **配置** 里点 **智能体管理**；聊天窗口左侧有时显示为 **预设角色**，进去是同一页。",
        "在这里新增、改名或调整各个智能体的说明；具体能改哪些字段，以界面为准。",
      ],
      [
        "## Agent management",
        "Sidebar **配置 → 智能体管理** matches the **预设角色** shortcut beside the chat list.",
        "Create and tune personas; fields depend on your build.",
      ],
    ),
  },
  {
    slug: ["config", "channels"],
    title: { zh: "消息渠道", en: "Messaging channels" },
    description: {
      zh: "在软件里启用飞书、钉钉、Slack、Telegram 等，并填写机器人凭据。",
      en: "Turn on Feishu, DingTalk, Slack, Telegram, etc., and paste bot credentials.",
    },
    body: desktopStub(
      [
        "## 从哪里进",
        "在侧栏点 **配置**，再点 **消息渠道**（单独一页）。正在聊天时，也可以点窗口底部的 **设置**，左侧选 **IM 通信**——进去后和这里是**同一块界面**：左侧是平台列表，右侧是当前平台的表单与说明。",
        "## 页面上长什么样",
        "- **左侧**：环境已接入的平台会列出来（常见有飞书、钉钉、Slack、Telegram 等，以你屏幕上为准）。每一项右侧有**开关**，只有打开才会真正启用该渠道。",
        "- **右侧**：顶部会显示当前平台的名称和 **「某某设置」**，旁边有 **已连接 / 未连接** 状态。下面是一段**操作提示**（飞书、钉钉等会写清去哪个开放平台建机器人、要开哪些能力，并附文档链接）。再往下是**表单**：一般要填 **App ID**、**App Secret**（名称和各开放平台控制台里一致；密钥框旁可以切换显示/隐藏）。",
        "## 建议按这个顺序做",
        "1. 在左侧点选要用的平台，先把它的**总开关**打开。",
        "2. 按右侧灰色提示里的步骤，到对应开放平台创建机器人或应用，拿到编号和密钥。",
        "3. 把 **App ID**、**App Secret** 填进表单；输入框在**失去焦点**一小会儿后会**自动保存**，成功时通常会弹出「已保存」一类提示。",
        "4. 需要时展开 **高级设置**，点 **测试连通性**：会先把当前填写写进去，再尝试拉起连接，按提示看是否成功。",
        "5. 看标题旁的连接状态是否变成 **已连接**；若仍是未连接，对照提示检查权限、网络或凭据是否填错。",
        "若左侧完全空白或提示没有可用渠道，说明当前连到的服务端还没为你开放任何消息平台，需要部署或管理员先在服务端准备好渠道后再来此处配置。",
      ],
      [
        "## Where to open it",
        "Sidebar **配置 → 消息渠道** opens the full page. From chat, use footer **Settings**, then **IM 通信** on the left—the layout matches: a platform rail on the left and a detail panel on the right.",
        "## What you see",
        "- **Left rail**: enabled platforms (Feishu, DingTalk, Slack, Telegram, etc.—depends on your server). Each row has an **on/off** switch.",
        "- **Right panel**: a title like **“… settings”**, a **connected / not connected** badge, step-by-step **tips** with doc links, then **App ID** and **App Secret** fields (with a show/hide control for the secret).",
        "## Recommended flow",
        "1. Select a platform and turn its **master switch** on.",
        "2. Follow the tip list to create the bot or app in the vendor console and copy credentials.",
        "3. Paste **App ID** and **App Secret**; the form **auto-saves shortly after you leave a field**.",
        "4. Open **Advanced**, run **Test connectivity** when you need a live check.",
        "5. Watch the badge until it reads **connected**; if not, re-check permissions, network, and values.",
        "If the rail is empty, your server has not exposed any messaging channels yet—ask your admin or finish server-side setup first.",
      ],
    ),
  },
  {
    slug: ["data", "memory-files"],
    title: { zh: "记忆文件", en: "Memory files" },
    description: {
      zh: "按角色查看和整理长期记忆内容。",
      en: "Review and tidy long-term memory per persona.",
    },
    body: desktopStub(
      [
        "## 记忆文件",
        "在侧栏 **数据** 里打开 **记忆文件**，可以按不同智能体查看已经存下来的长期内容，做清理或修改。",
        "聊天窗口里 **记忆：开 / 关** 决定「以后还记不记」；这一页用来管「已经记下来的东西」。设置里也有一个较简的 **记忆** 页，偏重当前主助手，要看分栏的完整列表就到这里来。",
      ],
      [
        "## Memory files",
        "Sidebar **数据 → 记忆文件** lists stored memories per persona for cleanup or edits.",
        "The dock **Memory** toggle controls future writes; this page curates what already exists. **Panel settings → Memory** shows a shorter view for the lead assistant.",
      ],
    ),
  },
  {
    slug: ["ext", "skills"],
    title: { zh: "技能", en: "Skills" },
    description: {
      zh: "启用或安装技能扩展。",
      en: "Enable or install skill extensions.",
    },
    body: desktopStub(
      [
        "## 技能",
        "在侧栏 **扩展** 里打开 **技能**；聊天窗口左侧也有入口。",
        "用来打开或安装额外的能力包；每个包一般自带说明，告诉你适合干什么、要不要额外密钥。",
      ],
      [
        "## Skills",
        "Sidebar **扩展 → 技能** (and the chat shortcut) manage optional capability packs.",
        "Each pack usually ships with its own instructions and key requirements.",
      ],
    ),
  },
  {
    slug: ["ext", "tools"],
    title: { zh: "工具管理（含 MCP）", en: "Tools & MCP" },
    description: {
      zh: "管理内置工具与外部工具连接。",
      en: "Manage built-in tools and external tool links.",
    },
    body: desktopStub(
      [
        "## 工具管理",
        "在侧栏 **扩展** 里叫 **工具管理**；聊天窗口左侧的 **MCP** 按钮进去是同一页。",
        "在这里维护「还能调用哪些外部能力」：例如远程工具、自动化脚本等，按向导添加或关闭即可。",
      ],
      [
        "## Tools & MCP",
        "Sidebar **扩展 → 工具管理** matches the **MCP** shortcut beside the chat list.",
        "Add or remove external capabilities following the in-app wizard.",
      ],
    ),
  },
  {
    slug: ["ext", "coding-assistants"],
    title: { zh: "编码助手（Claude Code）", en: "Coding assistants (Claude Code)" },
    description: {
      zh: "总控如何把编码类子任务交给本机 Claude Code，以及如何对照桌面端输出。",
      en: "How the lead delegates coding work to Claude Code on your machine and how to read outputs in the desktop client.",
    },
    body: desktopStub(
      [
        "## 适合谁看",
        "你已经会用 EvoPanel 做日常对话或任务编排，并希望把「写代码、改仓库、看日志」交给本机上的 **Claude Code**（或同类终端编码环境），同时仍在总控里统一拆分任务、追问和收口。",
        "## 和主对话有什么区别",
        "主对话里你直接和总控交流；编码助手这条线是 **总控把明确的编码子任务派出去**，在外部环境里执行，再把过程与结果流式回到桌面端。适合长步骤、需要本地工具链或你更习惯在终端里干的活；总控仍然负责大图的依赖、验收和对齐。",
        "## 在桌面端你能看到什么",
        "外部编码侧的输出会流式展示在控制台一类区域里，便于和长任务主线对照，而不必只靠猜「外面跑完了没有」。同一外部会话里通常可以多轮往返纠偏，不必每问一句就新开一条会话。",
        "## 和 Plan、场景是什么关系",
        "顶栏选的 **场景** 决定「这类事默认带哪些能力」；输入区下方的 **Plan（任务协作）** 决定「这一轮要不要先规划再授权执行」。编码委派是在此之上的一种执行方式：先在对齐好的子任务里把编码活划清楚，再交给外部助手落地。基础操作顺序见 [模型与场景](/docs/chat/models-scenes) 与 [Plan（任务协作）](/docs/chat/plan-collab)。",
        "## 需要接命令行或自动化时",
        "若要在 Claude Code 里用技能、脚本或 HTTP 与正在运行的 EvoFlow 实例联动，仓库里另有面向开发者的集成说明；正文不展开命令与接口，需要时请打开本仓库文档中的 **Claude Code 集成** 专题，或参阅 [Claude Code 官方说明](https://docs.anthropic.com/en/docs/claude-code)。",
      ],
      [
        "## Who this is for",
        "You already use EvoPanel for chat or task orchestration and want **Claude Code** (or a similar terminal-first coding setup) to handle concrete coding, refactors, and log reading on your machine—while the lead agent still owns decomposition, follow-ups, and closure.",
        "## How it differs from the main chat",
        "In the main thread you talk to the lead directly. The coding-assistant path is **delegated subtasks** executed in an external environment, with streams returned to the desktop. It fits longer steps that need your local toolchain or a terminal-native loop; the lead still manages dependencies, acceptance, and alignment.",
        "## What you see in the desktop client",
        "External coding output streams into console-style views so you can compare it with the main mission instead of waiting blindly. One external session usually supports multiple steering turns without forcing a brand-new session each time.",
        "## Scenes, Plan, and delegation",
        "Header **scenes** choose default capability mixes; composer **Plan (task collaboration)** controls planning-first vs authorized execution. Coding delegation sits on top: clarify subtasks, then hand coding work to the external assistant. See [Model & scenes](/docs/chat/models-scenes) and [Plan (task collaboration)](/docs/chat/plan-collab) for the basics.",
        "## When you need CLI or automation",
        "For skills, scripts, or HTTP hooks that talk to a running EvoFlow instance from Claude Code, the repository has developer-oriented integration docs. This page stays product-level; open the project’s **Claude Code integration** guide when you need commands and APIs, or read [Anthropic’s Claude Code docs](https://docs.anthropic.com/en/docs/claude-code).",
      ],
    ),
  },

  {
    slug: ["panel", "general"],
    title: { zh: "面板设置 · 通用", en: "Panel settings · General" },
    description: {
      zh: "外观、默认记忆、沙箱与数据目录、清理缓存。",
      en: "Theme, default memory, sandbox paths, data folder, cache reset.",
    },
    body: desktopStub(
      [
        "## 通用",
        "在聊天窗口底部点 **设置**，左侧选 **通用**。常见内容包括：",
        "- **外观**：浅色、深色或跟随系统。",
        "- **默认是否打开记忆**：新开的对话要不要默认记住上下文；单个对话里仍可以单独改。",
        "- **是否使用沙箱里的虚拟路径**：打开后，文件相关说明会按沙箱里的路径来写；关闭则更贴近你本机真实路径。",
        "- **用户工作空间**：指定默认的数据或工程根目录。",
        "- **维护**：对话很多、界面变慢时，可以一键清理本地缓存并刷新。",
      ],
      [
        "## General",
        "Footer **设置 → General** covers theme, default memory for new chats, sandbox vs real paths, the default workspace folder, and a cache reset when the UI slows down.",
      ],
    ),
  },
  {
    slug: ["panel", "models-tab"],
    title: { zh: "面板设置 · 模型", en: "Panel settings · Models tab" },
    description: {
      zh: "聊天时打开设置里的「模型」，与侧栏「模型配置」同一界面；下面写清怎么配。",
      en: "Models inside Settings while chatting—same UI as the sidebar guide below.",
    },
    body: desktopStub(
      [
        "## 从哪点进去",
        "在 **实时聊天** 窗口最下面点 **设置**，左侧选 **模型**。出现的页面和侧栏 **配置 → 模型配置** 是**同一块界面、同一份数据**，只是不用离开当前对话。",
        "## 你要在这里完成什么",
        "和 [模型配置](/docs/config/models) 里写的一样，按顺序做即可：",
        "1. **服务商**：左侧选好或 **添加服务商**，填名称、接口地址、密钥并保存。",
        "2. **先测再建模**：有测试或鉴权相关按钮时，先按提示确认能连上。",
        "3. **添加模型**：在该服务商下 **添加模型**，名称要与对方平台一致。",
        "4. **主模型**：指定默认用的那一个，聊天和任务都会跟它走。",
        "5. **收尾**：需要时调整顺序、删掉不用的服务商；留意保存成功的提示。",
        "配完后关掉设置面板即可回到聊天，已选的模型一般会在输入框下方的模型按钮里看到。",
      ],
      [
        "## How you open it",
        "In **live chat**, click **Settings** at the bottom, then **Models** on the left. This is the **same screen and data** as **配置 → 模型配置** in the sidebar.",
        "## What to do here",
        "Follow the same steps as [Model configuration](/docs/config/models): add or pick a **provider**, run any **tests**, **add models** with exact IDs, set the **primary model**, then tidy order or delete unused providers.",
        "Close the settings drawer when you are done—the composer pill should reflect your chosen model.",
      ],
    ),
  },
  {
    slug: ["panel", "im-tab"],
    title: { zh: "面板设置 · IM 通信", en: "Panel settings · IM" },
    description: {
      zh: "聊天时打开设置里的「IM 通信」，与侧栏「消息渠道」同一界面。",
      en: "Configure IM from Settings while chatting—same UI as **消息渠道**.",
    },
    body: desktopStub(
      [
        "## 从哪点进去",
        "在 **实时聊天** 窗口最下面点 **设置**，左侧选 **IM 通信**（这是设置面板里这一列的短名称）。右侧主区域的大标题一般是 **消息渠道**，下面就是和侧栏 **配置 → 消息渠道** 完全相同的布局。",
        "## 在这里要做什么",
        "与 [消息渠道](/docs/config/channels) 里写的一样：左侧选平台并打开开关 → 按灰色提示去各开放平台建机器人 → 填 **App ID**、**App Secret**（失焦自动保存）→ 必要时在 **高级设置** 里 **测试连通性** → 看是否 **已连接**。",
        "配完关掉设置抽屉即可回到聊天；定时任务、通知等若要发到某个群或机器人，也要依赖这里先接好。",
      ],
      [
        "## How you open it",
        "In **live chat**, click **Settings** at the bottom, then **IM 通信** on the left. The main title is usually **消息渠道**; the layout matches **配置 → 消息渠道** in the sidebar.",
        "## What to do",
        "Follow the same steps as [Messaging channels](/docs/config/channels): pick a platform, enable it, follow the tips, fill **App ID** / **App Secret** (auto-save on blur), run **Test connectivity** under **Advanced**, confirm **connected**.",
        "Schedules and notifications that post into chat also depend on these channels being set up first.",
      ],
    ),
  },
  {
    slug: ["panel", "memory-tab"],
    title: { zh: "面板设置 · 记忆", en: "Panel settings · Memory tab" },
    description: {
      zh: "在设置里快速查看主助手相关记忆。",
      en: "Quick view of the lead assistant’s memory in settings.",
    },
    body: desktopStub(
      [
        "## 记忆（设置里）",
        "**设置 → 记忆** 适合快速查看、整理当前主助手相关的记忆摘要。",
        "若要按多个智能体分别浏览、做更细的编辑，请用侧栏 **数据 → 记忆文件**。",
      ],
      [
        "## Memory tab",
        "**Panel settings → Memory** is a short view focused on the lead assistant.",
        "Use sidebar **数据 → 记忆文件** for the full per-persona list.",
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
| 沙箱与工具 | 命令和工具在哪里跑、出错了怎么重试、怎么看到日志 |
| 记忆与上下文 | 长任务里哪些该记住、怎样避免把整段聊天反复塞给模型 |
| 技能与外部工具 | 额外能力包、外部服务怎么接进来、怎么授权 |

更细的说明见 GitHub 仓库中的文档。

## 接下来建议读什么

1. [架构要点](/docs/concepts/architecture)  
2. 首页 [路线图](/#evolution-pulse)、[演进日志](/evolution)
`.trim(),
      en: `
After [Getting started](/docs/getting-started), use this table to read the homepage **capabilities** section:

| Homepage area | In plain terms |
|---------------|----------------|
| Orchestration | Who owns the goal, how work splits and merges |
| Sandbox & tools | Where commands run, how retries and logs help |
| Memory & context | What to remember across long work without pasting entire chats |
| Skills & external tools | How optional packs and services connect and get permission |

Details also live in the GitHub repository docs.

## What to read next

1. [Architecture notes](/docs/concepts/architecture)  
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
    title: { zh: "开始", en: "Start" },
    items: [{ slug: ["getting-started"], title: { zh: "快速开始", en: "Getting started" } }],
  },
  {
    title: { zh: "实时对话", en: "Chat" },
    items: [
      { slug: ["chat", "models-scenes"], title: { zh: "模型与场景", en: "Model & scenes" } },
      { slug: ["chat", "session-modes"], title: { zh: "会话模式", en: "Session modes" } },
      { slug: ["chat", "plan-collab"], title: { zh: "Plan（任务协作）", en: "Plan (collab)" } },
      {
        slug: ["chat", "memory-hosted-workspace"],
        title: { zh: "记忆、托管与工作空间", en: "Memory, hosted & workspace" },
      },
    ],
  },
  {
    title: { zh: "任务与调度", en: "Tasks & schedules" },
    items: [
      { slug: ["tasks", "center"], title: { zh: "任务中心", en: "Task center" } },
      { slug: ["tasks", "cron"], title: { zh: "定时任务", en: "Scheduled jobs" } },
    ],
  },
  {
    title: { zh: "配置与面板", en: "Configuration & panel" },
    items: [
      { slug: ["config", "models"], title: { zh: "模型配置", en: "Models" } },
      { slug: ["config", "agents"], title: { zh: "智能体管理", en: "Agents" } },
      { slug: ["config", "channels"], title: { zh: "消息渠道", en: "Channels" } },
      { slug: ["data", "memory-files"], title: { zh: "记忆文件", en: "Memory files" } },
      { slug: ["ext", "skills"], title: { zh: "技能", en: "Skills" } },
      { slug: ["ext", "coding-assistants"], title: { zh: "编码助手（Claude Code）", en: "Coding assistants" } },
      { slug: ["ext", "tools"], title: { zh: "工具管理（含 MCP）", en: "Tools & MCP" } },
      { slug: ["panel", "general"], title: { zh: "面板设置 · 通用", en: "Panel · General" } },
      { slug: ["panel", "models-tab"], title: { zh: "面板设置 · 模型", en: "Panel · Models" } },
      { slug: ["panel", "im-tab"], title: { zh: "面板设置 · IM 通信", en: "Panel · IM" } },
      { slug: ["panel", "memory-tab"], title: { zh: "面板设置 · 记忆", en: "Panel · Memory" } },
    ],
  },
];

export function getDocPageBySlug(slug: DocSlug): DocPage | undefined {
  return pageByKey.get(slugKey(slug));
}

export function getAllDocSlugs(): DocSlug[] {
  return pages.map((p) => p.slug);
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
      intro: "下方分区与左侧目录一致：**开始 → 实时对话 → 任务与调度 → 配置与面板**。需要「概念总览」「架构要点」时，可从 [快速开始](/docs/getting-started) 文末链接进入。",
    };
  }
  return {
    title: "Documentation",
    description: "Where EvoPanel features live and what they are for.",
    intro:
      "Sections below match the sidebar: **Start → Chat → Tasks & schedules → Configuration & panel**. For **Concepts** / **Architecture**, follow the links at the end of [Getting started](/docs/getting-started).",
  };
}
