# ⚡ EvoFlow
> EvoFlow 是 **EvovexAI** 旗下的**超级 Agent 编排框架**：采用 **Supervisor 超级智能体全局主控模式**，从源头解决长任务易中断、Token 无效消耗等核心痛点，支持用户随时下达任务指令、执行过程全程透明可干预、自动交付最终结果，由可扩展技能生态驱动能力边界。

[![官网](https://img.shields.io/badge/官网-evovexai.com-6366f1?style=flat-square)](https://www.evovexai.com)
[![联系](https://img.shields.io/badge/联系-cloud%40evovexai.com-64748b?style=flat-square&logo=gmail&logoColor=white)](mailto:cloud@evovexai.com)
[![许可证](https://img.shields.io/badge/许可证-非商业-orange?style=flat-square)](LICENSE)

欢迎在 GitHub **Star** 关注进展，**完整源码开放**将在社区成熟后另行公布。


---
## 📑 目录
- [📦 获取产品与桌面端](#获取产品与桌面端)
- [🎬 Plan 模式 · Agent Teams 从 0 到 1](#-plan-模式--agent-teams-从-0-到-1)
- [🖼️ 界面预览](#界面预览)
- [🎯 核心价值亮点](#核心价值亮点)
- [✨ 功能总览](#功能总览)
- [💬 社区与交流](#社区与交流)
- [🙏 致谢](#致谢)

---
## 📦 获取产品与桌面端
| 内容 | 入口 |
|--------|------|
| 📥 官方发行版与桌面安装包 | [EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases) |
| 📚 使用教程 | [桌面端使用指南](https://www.evovexai.com/docs/chat/evopanel) |
| 🎬 产品演示（视频与截图） | [官网产品演示](https://www.evovexai.com/showcase/) |

---

## 🎬 Plan 模式 · Agent Teams 从 0 到 1

在 **Plan 模式** 下，**Supervisor 超级智能体** 不会「一口气干到底」，而是按 **先澄清 → 再规划 → 确认后执行** 的节奏推进：自动拆解目标与子任务依赖，并通过 **Agent Teams** 把每一步派给最合适的子 Agent（通用智能体、终端执行、Claude Code 等），全程可在桌面端观察、干预与验收。

下面用 **2 段演示视频** 与 **5 张过程截图** 展示一次典型的 **从 0 到 1 项目开发** 协作闭环：视频一呈现 Plan 与 Agent Teams 协作过程，视频二呈现 **项目跑通后的运行结果**（素材路径：[docs/assets/plan-supervisor/](docs/assets/plan-supervisor/)）。官网可播放版本见 [产品演示](https://www.evovexai.com/showcase/)。

### 视频演示

<p align="center">
  <a href="docs/assets/plan-supervisor/video-01-plan-clarify-to-ready.mp4">
    <img src="docs/assets/plan-supervisor/video-01-plan-clarify-to-ready-poster.png" width="92%" alt="Plan 模式演示：从需求澄清到计划定稿">
  </a>
</p>
<p align="center"><sub>▶ <a href="docs/assets/plan-supervisor/video-01-plan-clarify-to-ready.mp4">视频一 · Plan 协作全过程</a>（澄清 → 结构化计划 → Agent Teams 分工执行至交付物产出）</sub></p>

<p align="center">
  <a href="docs/assets/plan-supervisor/video-02-plan-project-running-result.mp4">
    <img src="docs/assets/plan-supervisor/video-02-plan-project-running-result-poster.png" width="92%" alt="Plan 模式演示：项目运行结果展示">
  </a>
</p>
<p align="center"><sub>▶ <a href="docs/assets/plan-supervisor/video-02-plan-project-running-result.mp4">视频二 · 项目运行结果展示</a>（Plan 协作交付完成后，启动并演示可运行产物：页面交互、接口调用或核心功能验收）</sub></p>

### 协作过程一览

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/plan-supervisor/plan-02-structured-plan-modal.png" width="100%" alt="Plan 模式：任务分析图（Mermaid）">
      <br><sub>② 计划 · 任务分析图（模块结构、调用链与数据流）</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/plan-supervisor/plan-02-structured-plan-modal-2.png" width="100%" alt="Plan 模式：执行步骤与各智能体目标与任务信息">
      <br><sub>② 计划 · 执行步骤与各智能体目标、输入/输出物、验收标准</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/plan-supervisor/plan-04-exec-confirm-dock.png" width="100%" alt="Plan 模式：用户确认开始执行">
      <br><sub>④ 执行闸口 · 用户确认后再进入执行阶段</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/plan-supervisor/plan-05-supervisor-workflow-panel.png" width="100%" alt="Supervisor 子任务工作流面板">
      <br><sub>⑤ Supervisor · 子任务工作流与依赖进度</sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="docs/assets/plan-supervisor/video-02-plan-project-running-result-poster.png" width="92%" alt="多 Agent 子任务并行执行">
      <br><sub>⑥ 多 Agent 协作 · 子任务执行中 / 完成回传</sub>
    </td>
  </tr>
</table>

> **流程摘要：** 用户描述目标 → Supervisor 澄清 → `plan()` 生成可修订计划（含 `boundTaskId`）→ 用户 **开始执行** → Supervisor 创建子任务并按 **Agent Teams** 派发 → 子 Agent 在隔离上下文中完成各 Step → 主会话汇总验收。  
> 素材清单与录制建议见 [docs/assets/plan-supervisor/README.md](docs/assets/plan-supervisor/README.md)。

---
## 🖼️ 界面预览

以下为 EvoFlow **桌面图形界面（GUI）** 示意（截图随版本更新，请以 [最新发行版](https://github.com/EvovexAI/EvoFlow/releases/latest) 为准）。完整操作见 [桌面端使用指南](https://www.evovexai.com/docs/chat/evopanel)。

<p align="center">
  <img src="docs/assets/screenshots/main-chat.png" width="92%" alt="EvoFlow 桌面端主界面：实时对话与工具调用可视化">
</p>
<p align="center"><sub>主界面 · 流式对话与工具过程可视化</sub></p>

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/agents-preset-teams.png" width="100%" alt="预设角色 · Agent Teams 团队总览">
      <br><sub>预设角色（一）· 团队总览（全局 / 核心执行 / 项目 / 媒体等）</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/agents-preset-roles.png" width="100%" alt="预设角色 · 团队内子智能体角色">
      <br><sub>预设角色（二）· 团队内角色（以项目团队为例：方案 / 计划 / 开发 / 审查…）</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/scheduled-tasks-1.png" width="100%" alt="自动化配置与列表（一）">
      <br><sub>自动化（一）</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/scheduled-tasks-2.png" width="100%" alt="自动化配置与列表（二）">
      <br><sub>自动化（二）</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/hosted-1.png" width="100%" alt="目标任务运行与配置（一）">
      <br><sub>目标任务（一）</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/hosted-2.png" width="100%" alt="目标任务运行与配置（二）">
      <br><sub>目标任务（二）</sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="docs/assets/screenshots/browser.png" width="92%" alt="浏览器自动化操作与网页交互">
      <br><sub>浏览器操作 · Agent 驱动浏览、点击与页面交互</sub>
    </td>
  </tr>
</table>

> 截图文件目录：[docs/assets/screenshots/](docs/assets/screenshots/)（见该目录 `README.md` 中的文件名说明）

---
## 🎯 核心价值亮点
- ✅ **长任务自动闭环**  
解决传统Agent对话「长任务易中断、上下文漂移、人工值守成本高」的痛点，支持跨会话任务断点续跑、异常自动重试、局部重编排，任务全程可观测，保障自动闭环到验收

- ✅ **智能多代理调度**  
Supervisor全局总控模式，全自动完成任务全生命周期管理：自动意图澄清→方案规划→子任务依赖图拆解，基于子智能体能力画像精准分发任务，支持需求分析/设计/编码等多角色子代理分工协作，无需用户手动调度

- ✅ **无人值守目标运行**  
7×24小时目标运行能力，解放人力：后台独立沙箱隔离执行，支持暂停/恢复/终止，运行状态实时可查，任务结束自动推送Markdown结果小结到飞书，无需人工值守

- ✅ **飞书全链路联动**  
IM侧即可完成全流程操作，不用开客户端：飞书侧可直接下达各类任务指令，支持定时/周期任务配置，执行结果自动推送飞书，IM侧即可完成任务全流程管控

- ✅ **Claude Code深度协同**  
编码类任务效率提升神器：既支持直接和Claude Code实时交互完成编码/调试，也可在Supervisor模式中作为编码子代理承接开发专项任务，支持多Claude Code会话并行分工，大幅提升研发效率

- ✅ **零门槛自然语言操作**  
所有能力自然语言触发，不用复杂配置：目标任务、自动化直接在对话中即可创建，用自然语言就能下达指令，无需学习复杂配置

- ✅ **降本增效 · Prompt 缓存**  
系统提示前缀稳定 + 工具渐进暴露；配合模型 Prompt Caching，典型长任务场景**缓存命中率可达约 90%**，显著降低输入 Token 费用（观测页可查看缓存命中统计）

- ✅ **子任务工作流可视化**  
Plan / Supervisor 执行时，桌面端**工作流面板**展示子任务 DAG、依赖与进度，复杂链路一目了然，便于介入、重试与验收

- ✅ **思维导图 · 问题链路**  
聊天右侧**思维导图**由 Agent 自动维护，多轮对话中可看清假设、分支与结论，**排查卡点、排除干扰、复盘解决路径**；Plan 与长目标场景尤其有用

---
## ✨ 功能总览
### 🚀 1. 核心特色（八大支柱）
| 特色 | 说明 |
|------|------|
| **长任务与可恢复编排** | 跨会话任务监督、排队与重试，必要时局部重编排，保障任务闭环到验收 |
| **超级总控智能体（Supervisor）** | 澄清意图→方案规划→拆解为有向无环子任务依赖图；基于子Agent能力画像精准分发任务，能力与任务最优匹配；子任务上下文自动传递；全局进度调控、异常纠错与局部重编排 |
| **Claude Code 多会话协同** | 直连Claude Code交互，也可作为子代理承接编码/调试专项任务，支持多Claude Code会话并行分工与结果汇总 |
| **目标智能体与长期任务** | 独立沙箱隔离，支持7×24小时后台目标运行，实时查看状态与日志，支持暂停/恢复/终止，结果可追溯；支持模型通过 `propose_goal` 提议方案，用户确认后执行；结束后可向飞书等IM推送Markdown结果小结 |
| **场景与工作阶段** | 按任务切换形态，遵循「先规划、再确认、后执行」流程，降低误触，控制上下文规模 |
| **工具渐进暴露 · 技能 / MCP** | 核心能力先行，扩展按需挂载；支持MCP生态扩展接入 |
| **记忆 · 任务状态 · 主线快照** | 会话/任务状态与主线快照持久化；子问题进度自动回注；Plan闸口与护栏收口，避免长对话漂移 |
| **子任务工作流** | Plan 执行后可视化子任务 DAG、依赖与进度；支持监督、重试与局部重编排 |
| **Prompt 缓存降本** | 稳定系统提示前缀 + 渐进工具暴露；典型多轮场景缓存命中率约 90%，显著节省 API 费用 |
| **思维导图** | Agent 自动维护思路图，多轮对话中看清问题链路与排查路径，便于复盘与排除干扰 |
| **智能体进化** | 智能体配置（模型、工具白名单、扩展）与技能生命周期协同治理，变更支持热重载 |

### 🖥️ 2. 桌面图形界面能力
| 功能域 | 说明 |
|--------|------|
| **对话模式** | Chat · Plan · Execute · Infinite；支持thinking/规划/子代理等开关组合 |
| **实时聊天** | 流式输出、Markdown渲染、多模态交互、工具调用过程可视化 |
| **模型配置** | 多提供商模型切换、thinking/vision能力开关、自定义网关地址配置 |
| **任务中心** | 任务创建/监控、批量操作、历史记录追溯 |
| **多代理与项目管理** | 项目维度隔离、Supervisor协调、上下文/记忆相互隔离 |
| **Agent 管理** | **Agent Teams 团队** + 团队内预设角色；人设、模型与工具白名单按角色配置 |
| **工具与技能市场** | 技能浏览/启停、归档安装、MCP扩展状态管理 |
| **IM 渠道** | 支持飞书/Slack/Telegram等渠道接入，消息双向同步 |
| **自动化** | Cron周期任务配置，支持结果推送、周期编排运行 |
| **目标任务** | 目标启停/参数配置，支持 `propose_goal` 提议→用户确认执行流程 |
| **记忆管理** | 全局/Agent级记忆导入导出，外部记忆插件接入 |
| **观测与调用日志** | Agent Trace 页面展示模型、工具与 Gateway 调用日志；含 **缓存命中 / 写入缓存** Token 分项；Gateway 请求以异步方式写入观测 SQLite，并对敏感 headers/body 字段脱敏；Gateway 内置卡顿诊断会在事件循环 lag/卡死时输出线程栈、asyncio task 与活跃 stream 快照 |
| **思维导图** | 聊天右侧自动维护思路图，展示目标、分支与排查链路；与消息流互补，适合多轮排障与复盘 |
| **个性化配置** | 明暗主题切换、多语言支持 |

---
## ⚖️ 许可证
本项目以 [EvovexAI 非商业许可证 1.0](LICENSE) 发布：**允许学习与非商业使用；商业使用须书面授权**（[cloud@evovexai.com](mailto:cloud@evovexai.com)）。上游与第三方组件见 [NOTICE](NOTICE)。

---
## 💬 社区与交流

| 渠道 | 说明 |
|------|------|
| [GitHub Issues](https://github.com/EvovexAI/EvoFlow/issues) | Bug 反馈、功能建议（推荐） |
| [cloud@evovexai.com](mailto:cloud@evovexai.com) | 商务与合作咨询 |
| 微信交流群 | 扫码加入中文用户群（讨论请脱敏，禁止广告） |

<p align="center">
  <img src="docs/assets/screenshots/wechat-group-qr.png" width="200" alt="EvoFlow 微信交流群二维码">
</p>

---
## 🙏 致谢
| 项目 | 说明 |
|------|------|
| [LangChain](https://github.com/langchain-ai/langchain) | LLM 抽象与工具生态 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 图式 Agent 编排 |
| [DeerFlow](https://github.com/bytedance/deer-flow) | 早期工程基线（MIT，见 [NOTICE](NOTICE)） |
