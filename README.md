<div align="center">

# EvoFlow

**面向长任务的原生 Agent Runtime 与控制平面。**

由 [EvovexAI](https://www.evovexai.com) 打造：规划、拆解、执行、恢复与交付，多 Agent 协作全程可观测、可干预。

[![Release](https://img.shields.io/github/v/release/EvovexAI/EvoFlow?style=flat-square&color=6366f1)](https://github.com/EvovexAI/EvoFlow/releases)
[![License](https://img.shields.io/badge/许可证-源码可见·非商业-orange?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/平台-Windows%20%7C%20macOS%20%7C%20Linux-64748b?style=flat-square)](https://github.com/EvovexAI/EvoFlow/releases)
[![Docs](https://img.shields.io/badge/文档-evovexai.com-6366f1?style=flat-square)](https://www.evovexai.com/docs/chat/evopanel)
[![Contact](https://img.shields.io/badge/联系-cloud%40evovexai.com-64748b?style=flat-square&logo=gmail&logoColor=white)](mailto:cloud@evovexai.com)

[下载](https://github.com/EvovexAI/EvoFlow/releases) · [快速开始](#快速开始) · [文档](docs/index.md) · [贡献](CONTRIBUTING.md) · [English](README.en.md)

</div>

---

## 简介

EvoFlow 把长任务交给可协作的 Agent Teams：先澄清与规划，再在隔离上下文中执行工具与沙箱作业，失败可恢复，过程可验收。控制平面覆盖对话、Plan、Goal、任务中心、工作流与可观测性。

延伸阅读：[为什么用 EvoFlow](docs/user/explanation/why-evoflow.md) · [生态对照（DF / 爱马仕 / Codex / 小龙虾）](docs/user/explanation/ecosystem-comparison.md) · [Agent 体系](docs/user/explanation/agent-system.md)

---

## 能力

- **对话 / Plan / Goal** — 日常协作；先出可修订计划再执行；长任务后台挂起
- **Agent Teams · 智能体员工** — 多 Agent 分工；岗位值班与关键审批、汇报
- **应用中心 / 自动化** — 多节点固定业务工作流产品化；定时与 IM 派发
- **工作空间 · 代码索引** — 项目目录边界；符号/引用图谱供 Agent 检索
- **自我进化** — 资产中心：经验沉淀、反思过程、画像与记忆
- **治理套件** — 多账号/SSO、费用统计、运维观测、安全中心
- **资源市场** — 资源包与扩展应用安装；技能与 MCP 扩展能力
- **沙箱与可观测** — 隔离执行；任务、工具调用与用量可见

---

## 快速开始

### 桌面安装包

1. 从 [Releases](https://github.com/EvovexAI/EvoFlow/releases) 下载并安装。
2. 打开应用，在 **设置 → 模型** 添加服务商与 API Key，测试后设为主模型。
3. 开始对话；复杂任务用 **Plan**，长任务用 **Goal**。

<details>
<summary>macOS 提示「已损坏」/ 无法验证？</summary>

尚未 Apple 公证。可执行：

```bash
xattr -cr /Applications/EvoFlow.app
```

或在 **系统设置 → 隐私与安全性 → 仍要打开**。
</details>

详见：[5 分钟快速上手](docs/user/getting-started/quick-start.md) · [配置模型](docs/user/tutorials/configure-models.md)

### 从源码运行

适合二次开发、贡献代码或自托管。

```bash
git clone https://github.com/EvovexAI/EvoFlow.git
cd EvoFlow
cp config.example.yaml config.yaml   # 沙箱 / 工具 / 渠道等；模型在启动后的界面配置
```

依赖：Git、Python 3.12+、Node.js 22+、[uv](https://docs.astral.sh/uv/)、pnpm 9+。

```bash
make check && make install && make dev
```

Windows：`.\scripts\windows\dev-stack-isolated.bat`

启动后打开入口地址，在界面完成模型配置，再验证对话。步骤说明见 [配置模型](docs/user/tutorials/configure-models.md)；开发环境见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 文档

完整文档在 [`docs/`](docs/index.md)。常用入口：

- [下载与安装](docs/user/getting-started/downloads.md)
- [配置模型](docs/user/tutorials/configure-models.md)
- [Plan 模式](docs/user/guides/chat/plan-mode.md)
- [技能](docs/user/guides/configuration/skill-management.md) · [MCP](docs/user/guides/configuration/tools-mcp.md)
- [IM 渠道](docs/user/guides/integration/im-channels.md)
- [FAQ](docs/user/guides/faq.md)

本地预览：`pip install -r requirements-docs.txt && mkdocs serve`

---

## 参与贡献

欢迎缺陷报告、文档修正与 PR。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，提交前同意 [CLA.md](CLA.md)，并遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私密报告，勿在公开 Issue 中粘贴密钥。

中文导读：[docs/contribute/](docs/contribute/index.md) · 支持渠道：[SUPPORT.md](SUPPORT.md)

---

## 支持项目

如果 EvoFlow 对你有帮助，欢迎支持项目的持续优化与迭代（含定制化等方向）。可以请作者喝杯咖啡，也欢迎有能力的老板多多资助——自愿支持，不影响使用与授权；打赏不构成商用许可。商业合作或定制请联系 [cloud@evovexai.com](mailto:cloud@evovexai.com)。

<p align="center">
  <img src="docs/assets/sponsors/wechat.png" width="220" alt="微信支持二维码">
</p>

<p align="center"><sub>微信扫码支持</sub></p>

---

## 授权

版权所有 © 2026 **景银泰（EvovexAI）**。[PolyForm Noncommercial License 1.0.0](LICENSE)：源码可见（source-available），允许个人学习、研究与非商业使用；**商业使用须书面授权**（[cloud@evovexai.com](mailto:cloud@evovexai.com)）。**本许可证并非 OSI「开源」许可证。**第三方组件见 [NOTICE](NOTICE)；作者与贡献者权利见 [AUTHORS.md](AUTHORS.md)、[CLA.md](CLA.md)。

---

## 致谢

EvoFlow 是独立产品。开发中参考了 [DeerFlow](https://github.com/bytedance/deer-flow)、[Hermes Agent](https://github.com/NousResearch/hermes-agent)、[OpenClaw](https://github.com/openclaw/openclaw)、[OpenAI Codex](https://github.com/openai/codex)、[LangGraph](https://github.com/langchain-ai/langgraph) / [LangChain](https://github.com/langchain-ai/langchain)、[MCP](https://modelcontextprotocol.io)、[Tauri](https://tauri.app) 等项目的设计思路；完整版权与许可证说明见 [NOTICE](NOTICE)。

---

## 联系

[GitHub Issues](https://github.com/EvovexAI/EvoFlow/issues) · [Discussions](https://github.com/EvovexAI/EvoFlow/discussions) · [cloud@evovexai.com](mailto:cloud@evovexai.com) · [evovexai.com](https://www.evovexai.com)

<p align="center">
  <img src="docs/assets/screenshots/wechat-group-qr.png" width="160" alt="微信社群二维码">
</p>

<div align="center">

Built by **EvovexAI** · [English](README.en.md)

</div>
