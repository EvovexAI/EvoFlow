<div align="center">

# EvoFlow

**A native Agent Runtime and Control Plane for long-running work.**

Built by [EvovexAI](https://www.evovexai.com): plan, decompose, execute, recover, and deliver — with observable, intervenable Agent Teams.

[![Release](https://img.shields.io/github/v/release/EvovexAI/EvoFlow?style=flat-square&color=6366f1)](https://github.com/EvovexAI/EvoFlow/releases)
[![License](https://img.shields.io/badge/license-Source--available%20Non--Commercial-orange?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-64748b?style=flat-square)](https://github.com/EvovexAI/EvoFlow/releases)
[![Docs](https://img.shields.io/badge/docs-evovexai.com-6366f1?style=flat-square)](https://www.evovexai.com/docs/chat/evopanel)
[![Contact](https://img.shields.io/badge/contact-cloud%40evovexai.com-64748b?style=flat-square&logo=gmail&logoColor=white)](mailto:cloud@evovexai.com)

[Download](https://github.com/EvovexAI/EvoFlow/releases) · [Quick Start](#quick-start) · [Docs](docs/index.md) · [Contributing](CONTRIBUTING.md) · [中文](README.md)

</div>

---

## Overview

EvoFlow runs long tasks with collaborative Agent Teams: clarify and plan first, then execute tools and sandboxed work in isolated context, with recovery and human review. The control plane covers chat, Plan, Goal, task center, workflows, and observability.

Further reading: [Why EvoFlow](docs/user/explanation/why-evoflow.md) · [Ecosystem comparison (DeerFlow / Hermes / Codex / OpenClaw)](docs/user/explanation/ecosystem-comparison.md) · [Agent system](docs/user/explanation/agent-system.md)

---

## Capabilities

- **Chat / Plan / Goal** — everyday collaboration; reviewable plans before execution; long jobs in the background
- **Agent Teams · smart employees** — multi-agent division of labor; on-duty posts with checkpoint approval and reports
- **App Center / automation** — productize multi-node fixed business workflows; schedules and IM dispatch
- **Workspace · code index** — project-directory bounds; symbol/import graphs for agent retrieval
- **Self-evolution** — Asset Center: experience capture, reflection journals, profiles and memory
- **Governance suite** — multi-account / SSO, cost ledger, ops observability, Security Center
- **Resource market** — install packs and extension apps; Skills and MCP for capability expansion
- **Sandbox & observability** — isolated execution; visible tasks, tool calls, and usage

---

## Quick Start

### Desktop installer

1. Download from [Releases](https://github.com/EvovexAI/EvoFlow/releases) and install.
2. Open the app → **Settings → Models** → add a provider and API key → test → set as primary.
3. Chat; use **Plan** for multi-step work and **Goal** for long-running jobs.

<details>
<summary>macOS: “damaged” / can’t be verified?</summary>

```bash
xattr -cr /Applications/EvoFlow.app
```

Or **System Settings → Privacy & Security → Open Anyway**.
</details>

Guides: [5-minute quick start](docs/user/getting-started/quick-start.md) · [Configure models](docs/user/tutorials/configure-models.md)

### Run from source

For contributors and self-hosters.

```bash
git clone https://github.com/EvovexAI/EvoFlow.git
cd EvoFlow
cp config.example.yaml config.yaml   # sandbox / tools / channels; models via the UI after start
```

Requires Git, Python 3.12+, Node.js 22+, [uv](https://docs.astral.sh/uv/), and pnpm 9+.

```bash
make check && make install && make dev
```

Windows: `.\scripts\windows\dev-stack-isolated.bat`

Open the entry URL, configure models in the UI, then verify chat. See [Configure models](docs/user/tutorials/configure-models.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Documentation

Full docs live under [`docs/`](docs/index.md):

- [Downloads](docs/user/getting-started/downloads.md)
- [Configure models](docs/user/tutorials/configure-models.md)
- [Plan mode](docs/user/guides/chat/plan-mode.md)
- [Skills](docs/user/guides/configuration/skill-management.md) · [MCP](docs/user/guides/configuration/tools-mcp.md)
- [IM channels](docs/user/guides/integration/im-channels.md)
- [FAQ](docs/user/guides/faq.md)

Local preview: `pip install -r requirements-docs.txt && mkdocs serve`

---

## Contributing

Bug reports, docs fixes, and PRs are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), agree to [CLA.md](CLA.md) before submitting, and follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report security issues privately per [SECURITY.md](SECURITY.md) — never paste API keys into public issues.

Also: [SUPPORT.md](SUPPORT.md)

---

## Support the project

If EvoFlow helps you, consider supporting ongoing development and iteration (including customization). A coffee tip is welcome; sponsors who can contribute more are especially appreciated. Support is optional and does not change license terms or grant commercial rights. For commercial use or custom work, contact [cloud@evovexai.com](mailto:cloud@evovexai.com).

<p align="center">
  <img src="docs/assets/sponsors/wechat.png" width="220" alt="WeChat support QR">
</p>

<p align="center"><sub>WeChat tip / sponsorship</sub></p>

---

## License

Copyright © 2026 **景银泰（EvovexAI）**. [PolyForm Noncommercial License 1.0.0](LICENSE): source-available; personal, research, and non-commercial use allowed; **commercial use requires written authorization** ([cloud@evovexai.com](mailto:cloud@evovexai.com)). **Not an OSI open-source license.** Third-party terms: [NOTICE](NOTICE). Authorship and contributor rights: [AUTHORS.md](AUTHORS.md), [CLA.md](CLA.md).

---

## Acknowledgements

EvoFlow is an independent product. Development drew design inspiration from [DeerFlow](https://github.com/bytedance/deer-flow), [Hermes Agent](https://github.com/NousResearch/hermes-agent), [OpenClaw](https://github.com/openclaw/openclaw), [OpenAI Codex](https://github.com/openai/codex), [LangGraph](https://github.com/langchain-ai/langgraph) / [LangChain](https://github.com/langchain-ai/langchain), [MCP](https://modelcontextprotocol.io), and [Tauri](https://tauri.app). Full notices: [NOTICE](NOTICE).

---

## Contact

[GitHub Issues](https://github.com/EvovexAI/EvoFlow/issues) · [Discussions](https://github.com/EvovexAI/EvoFlow/discussions) · [cloud@evovexai.com](mailto:cloud@evovexai.com) · [evovexai.com](https://www.evovexai.com)

<p align="center">
  <img src="docs/assets/screenshots/wechat-group-qr.png" width="160" alt="WeChat community QR">
</p>

<div align="center">

Built by **EvovexAI** · [中文](README.md)

</div>
