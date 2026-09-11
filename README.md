<div align="center">

# EvoFlow

**A native Agent Runtime and Control Plane for long-running autonomous software work.**

Built by [Evovex AI](https://www.evovexai.com). Plan → decompose → execute → recover → deliver with observable Agent Teams — not one-shot chat or a single coding CLI wrap.

[![Release](https://img.shields.io/github/v/release/EvovexAI/EvoFlow?style=flat-square&color=6366f1)](https://github.com/EvovexAI/EvoFlow/releases)
[![License](https://img.shields.io/badge/license-Source--available%20Non--Commercial-orange?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-64748b?style=flat-square)](https://github.com/EvovexAI/EvoFlow/releases)
[![Docs](https://img.shields.io/badge/docs-evovexai.com-6366f1?style=flat-square)](https://www.evovexai.com/docs/chat/evopanel)
[![Contact](https://img.shields.io/badge/contact-cloud%40evovexai.com-64748b?style=flat-square&logo=gmail&logoColor=white)](mailto:cloud@evovexai.com)

[Download](https://github.com/EvovexAI/EvoFlow/releases) · [Quick Start](#quick-start) · [Docs](docs/index.md) · [Contributing](CONTRIBUTING.md) · [中文](README.zh-CN.md)

</div>

---

## What is EvoFlow?

It is **not** a chatbot UI and **not** a wrapper around a single coding agent. It is a **runtime** (planning, scheduling, sandbox, tools, memory, checkpoints) **and** a **control plane** (EvoPanel) so you can watch, intervene, retry, and accept every step of a long-running software task.

Use any model provider you configure in the panel. Native Agent Teams handle the work; Skills and MCP extend capabilities without forking the core.

---

## Key features

| | |
| --- | --- |
| **Supervisor planning** | Clarify intent, produce a reviewable plan, then run a dependency-ordered subtask graph. |
| **Native Agent Teams** | Lead agent + built-in / custom subagents (SOUL, model, tool whitelist); concurrent delegation. |
| **Sandbox & tools** | Isolated execution, file/bash tools, community web tools, any MCP server. |
| **Memory & recovery** | Persisted thread state, pause / resume / cancel, retry and partial re-plan. |
| **Observability** | Task / subtask / tool / token traces in the desktop control plane. |
| **Skills** | `SKILL.md` packages (50+ public skills) loaded on demand. |
| **Channels** | Feishu / WeChat available; more IM gateways on the roadmap. |

Deep dive: [Why EvoFlow](docs/user/explanation/why-evoflow.md) · [Agent system](docs/user/explanation/agent-system.md)

---

## Demo

<p align="center">
  <a href="docs/assets/plan-supervisor/video-01-plan-clarify-to-ready.mp4">
    <img src="docs/assets/plan-supervisor/video-01-plan-clarify-to-ready-poster.png" width="90%" alt="Plan mode: clarify to ready">
  </a>
</p>

<p align="center"><sub>Plan mode → structured plan → Agent Teams execute. More in <a href="docs/assets/plan-supervisor/README.md">docs/assets/plan-supervisor</a>.</sub></p>

```text
User request → Supervisor clarifies → plan() → confirm
  → Agent Teams (isolated context) → tools / sandbox
  → recovery & review → artifacts / optional IM delivery
```

---

## Quick Start

### Option A — Desktop installer (fastest)

1. Download from [Releases](https://github.com/EvovexAI/EvoFlow/releases):

   | Platform | Asset |
   | --- | --- |
   | Windows | `EvoFlow_<version>_x64-setup.exe` |
   | macOS (Apple Silicon) | `EvoFlow_<version>_aarch64.dmg` |
   | macOS (Intel) | `EvoFlow_<version>_x64.dmg` |
   | Linux | `EvoPanel_<version>_amd64.AppImage` / `.deb` |

2. Launch EvoPanel → add a model provider and API key.
3. Start a chat. Multi-step work enters **Plan mode** — review, confirm, watch subtasks run.
4. Use Task Center / Agent Trace to observe and accept results.

<details>
<summary>macOS: “damaged” / can’t be verified?</summary>

Not Apple-notarized yet. Run:

```bash
xattr -cr /Applications/EvoFlow.app
```

Or **System Settings → Privacy & Security → Open Anyway**.
</details>

User guide: [5-minute quick start](docs/user/getting-started/quick-start.md)

### Option B — Run from this repository (contributors)

```bash
cp config.example.yaml config.yaml   # add model keys
make docker-init && make docker-start
# open http://localhost:2026
```

Full setup, checks, and PR workflow: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Documentation

All product docs live under [`docs/`](docs/index.md) (MkDocs). Start here:

| | |
| --- | --- |
| [Documentation home](docs/index.md) | Quick links |
| [Installation & downloads](docs/user/getting-started/downloads.md) | Installers |
| [Configure models](docs/user/tutorials/configure-models.md) | Providers |
| [Plan mode](docs/user/guides/chat/plan-mode.md) | Long-running tasks |
| [Skills](docs/user/guides/configuration/skill-management.md) / [MCP](docs/user/guides/configuration/tools-mcp.md) | Extensions |
| [IM channels](docs/user/guides/integration/im-channels.md) | Feishu / WeChat |
| [FAQ](docs/user/guides/faq.md) | Troubleshooting |
| [Contributing](CONTRIBUTING.md) | Dev env, branches, CI |

```bash
pip install -r requirements-docs.txt && mkdocs serve
```

---

## Example prompts

```text
Create a simple settings page for this project.
First analyze the codebase, then propose a plan.
After confirmation, implement the change and run tests.
```

```text
Analyze this repository, identify three maintainability issues, create a plan,
and execute the first approved improvement as a Goal so I can check back later.
```

More: [Goal agent](docs/user/guides/chat/goal-agent.md) · [Cases](docs/user/cases/index.md)

---

## Screenshots

<p align="center">
  <img src="docs/assets/screenshots/main-chat.png" width="90%" alt="EvoPanel main chat">
</p>

More: [screenshots](docs/assets/screenshots/) · [Task Center](docs/user/guides/tasks/task-center.md) · [App Center](docs/user/guides/configuration/app-center.md)

---

## Contributing

We welcome bug reports, docs fixes, skills, and code PRs (when you have source access to this tree).

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) — env setup, branch names, required checks.
2. Chinese path: [docs/contribute/](docs/contribute/index.md).
3. Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
4. Prefer [SUPPORT.md](SUPPORT.md) for “where to ask”.
5. Security issues → [SECURITY.md](SECURITY.md) (never public issues).

Contribution paths (easiest → hardest): **docs** → **skills** → **bugfix** → **runtime / gateway**.

---

## License

Governed by the [Evovex AI Non-Commercial License 1.0](LICENSE): personal, educational, and research use when source access is granted; **commercial use requires written authorization** ([cloud@evovexai.com](mailto:cloud@evovexai.com)).

Not an OSI open-source license. Third-party components keep their own licenses — see [NOTICE](NOTICE).

Public [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow) currently emphasizes **docs + desktop releases**; this development tree holds the full application source used for builds and contributor workflows.

---

## Security

Do **not** paste API keys, tokens, or private customer data into issues/PRs. Report vulnerabilities privately: [cloud@evovexai.com](mailto:cloud@evovexai.com) or [GitHub Security Advisories](https://github.com/EvovexAI/EvoFlow/security/advisories/new).

---

## Acknowledgements

| Project | Role |
| --- | --- |
| [LangGraph](https://github.com/langchain-ai/langgraph) / [LangChain](https://github.com/langchain-ai/langchain) | Runtime & LLM tooling |
| [DeerFlow](https://github.com/bytedance/deer-flow) | Early engineering baseline (MIT; see NOTICE) |
| [Model Context Protocol](https://modelcontextprotocol.io) | Tool extension standard |
| [Tauri](https://tauri.app) | EvoPanel desktop shell |

---

## Contact

| Channel | Use |
| --- | --- |
| [GitHub Issues](https://github.com/EvovexAI/EvoFlow/issues) | Bugs & features |
| [GitHub Discussions](https://github.com/EvovexAI/EvoFlow/discussions) | Questions & ideas |
| [cloud@evovexai.com](mailto:cloud@evovexai.com) | Commercial / security |
| [evovexai.com](https://www.evovexai.com) | Product site |

<p align="center">
  <img src="docs/assets/screenshots/wechat-group-qr.png" width="180" alt="WeChat community QR">
</p>

<div align="center">

Built by **EvovexAI** · [中文文档](README.zh-CN.md)

</div>
