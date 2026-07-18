<div align="center">

# EvoFlow

**A native Agent Runtime and Control Plane for long-running autonomous software work.**

EvoFlow lets AI agents plan, decompose, execute, recover, and deliver long-running software tasks through observable Agent Teams - instead of stopping at one-shot chat or single-turn code generation.

[![Release](https://img.shields.io/github/v/release/EvovexAI/EvoFlow?style=flat-square&color=6366f1)](https://github.com/EvovexAI/EvoFlow/releases)
[![License](https://img.shields.io/badge/license-Source--available%20Non--Commercial-orange?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-64748b?style=flat-square)](https://github.com/EvovexAI/EvoFlow/releases)
[![Docs](https://img.shields.io/badge/docs-evovexai.com-6366f1?style=flat-square)](https://www.evovexai.com/docs/chat/evopanel)
[![Contact](https://img.shields.io/badge/contact-cloud%40evovexai.com-64748b?style=flat-square&logo=gmail&logoColor=white)](mailto:cloud@evovexai.com)

[Download](https://github.com/EvovexAI/EvoFlow/releases) · [Quick Start](#quick-start) · [Docs](https://www.evovexai.com/docs/chat/evopanel) · [Demo](#demo) · [License](#source-availability-and-license) · [中文文档](README.zh-CN.md)

</div>

---

## Demo

<p align="center">
  <a href="docs/assets/plan-supervisor/video-01-plan-clarify-to-ready.mp4">
    <img src="docs/assets/plan-supervisor/video-01-plan-clarify-to-ready-poster.png" width="90%" alt="Plan mode: from requirement clarification to a confirmed plan">
  </a>
</p>

<p align="center"><sub>Plan mode - clarify -> structured plan -> Agent Teams execute -> deliverable produced. More recordings in <a href="docs/assets/plan-supervisor/README.md">docs/assets/plan-supervisor</a>.</sub></p>

A typical run looks like this:

```text
User request
  -> Supervisor clarifies intent
  -> plan() produces a reviewable plan (with bound task id)
  -> User confirms execution
  -> Native Agent Teams take each step in isolated context
  -> Code orchestration / tool execution / sandbox
  -> Recovery & review
  -> Final delivery (artifacts, summary, optional IM push)
```

---

## Why EvoFlow?

Single-agent coding tools are powerful, but complex software work usually needs more than one prompt. Long-running tasks need **planning, state, memory, execution boundaries, recovery, observability, and delivery**. When a multi-step task fails halfway, a chat window alone cannot tell you *which step broke*, *what was already changed*, or *how to resume*.

EvoFlow is built for that layer.

It is a **runtime** (planning, scheduling, sandbox, tools, memory, checkpoints) **and** a **control plane** (a desktop app where you watch, intervene, retry, and accept every step), designed around real software tasks rather than one-shot answers.

### What EvoFlow is not

- **Not a chatbot UI.** It has a runtime that plans, decomposes, executes, and recovers.
- **Not a wrapper around Claude Code, Cline, Codex, or Aider.** EvoFlow runs its own native Agent Teams by default. External coding agents can be connected as *optional workers* (see [Optional External Agent Adapters](#optional-external-agent-adapters-experimental)), but the core does not depend on them.

---

## Core Capabilities

| Capability | What it means |
| --- | --- |
| **Native Agent Runtime** | A LangGraph-based lead agent with a middleware chain, tool system, subagent delegation, memory, and per-thread isolation. EvoFlow runs its own execution loop. |
| **Supervisor Planning** | A Supervisor clarifies intent, proposes a plan, and decomposes a goal into a dependency-ordered subtask graph before any side effects run. |
| **Task Decomposition** | Goals are split into subtasks with explicit inputs, expected outputs, and acceptance criteria, bound to a `boundTaskId` for traceability. |
| **Code Orchestration** | Tools for reading, writing, and editing files (`read_file`, `write_file`, `str_replace`), running commands (`bash`), and listing directories - orchestrated through the runtime, not a raw shell. |
| **Agent Teams** | Built-in subagents (`general-purpose`, `bash`) plus custom agents with their own identity (SOUL), model, and tool whitelist; up to 3 subagents run concurrently per turn. |
| **Tool Execution** | Sandbox tools, built-in tools (`ask_clarification`, `view_image`, `task`), community tools (web search, web fetch, scraping), and any MCP server (stdio / SSE / HTTP). |
| **Sandbox** | Per-thread isolated execution with virtual path translation (`/mnt/user-data/...`). Providers: local filesystem, Docker/container, and a k3s Provisioner for stronger isolation. |
| **Memory & Checkpoints** | LLM-powered memory extracts facts with debounced, atomic writes; thread state and subtask progress are persisted so runs can resume. |
| **Recovery** | Long-running tasks support pause / resume / cancel, retry on failure, and partial re-planning - so a broken step doesn't lose the whole run. |
| **Observability** | Every task, subtask, tool call, status change, and retry is visible. An Agent Trace view shows model/tool/Gateway calls with per-request token usage (including cache hit/write breakdown). |
| **Skills / MCP** | `SKILL.md` skill packages (50+ public skills) loaded by whitelist, plus any Model Context Protocol server as an extension. |
| **Desktop Control Plane** | EvoPanel (Tauri v2 + React): task center, agent management, execution logs, visual subtask workflow / DAG, model config, skill & MCP config, and long-running session management. |

---

## How EvoFlow Is Different

| Category | Examples | Difference |
| --- | --- | --- |
| **Single coding agents** | Claude Code, Codex, Cline, Aider | EvoFlow is not a single coding agent. It provides a runtime and control plane for native Agent Teams - planning, state, recovery, and observability around the whole task, not just the edit. |
| **Agent frameworks** | LangGraph, CrewAI, AutoGen | EvoFlow is a productized runtime with a desktop control plane, gateway, sandbox, memory, and IM channels - not only a low-level SDK. (EvoFlow is itself built on LangGraph.) |
| **Workflow automation** | n8n, Activepieces | EvoFlow focuses on agentic software work: code orchestration, long-running tasks, memory, recovery, and observable execution - not deterministic node wiring. |
| **Cloud AI engineers** | Devin-like products | EvoFlow is designed around local/desktop control, configurable agents, and an extensible runtime you run yourself - not a hosted black box. |

EvoFlow does not claim to replace these tools. A single coding agent is a great *executor*; EvoFlow is the *runtime and control plane* around many executors.

---

## Architecture

```text
User / Desktop / IM Channel (WeChat · Feishu available; Slack · Telegram planned)
        ↓
EvoPanel (Tauri v2 + React)        ← desktop control plane
        ↓ REST / SSE / WebSocket
Gateway (FastAPI · port 8001)      ← models, memory, skills, MCP, files, channels
        ↓ HTTP
LangGraph Runtime (port 2024)      ← lead agent + middleware chain
        ↓
Harness (evoflow.* package)        ← tools, skills, memory, subagents, sandbox, Supervisor
        ↓
Code Orchestrator / Tool Executor / Sandbox
        ↓
Skills / MCP / Terminal / Browser / Filesystem / APIs
        ↓
Logs / Artifacts / Delivery
```

**Harness / App separation.** The `evoflow.*` package is a self-contained, releasable agent framework (tools, skills, memory, subagents, Supervisor, sandbox). The `app.*` layer adds product concerns (channels, gateway routes). The boundary is enforced in CI: App may import `evoflow`, but `evoflow` never imports `app`. This keeps the core stable while product code evolves.

<details>
<summary>Service topology & ports</summary>

| Service | Port | Tech | Role |
| --- | --- | --- | --- |
| Nginx | 2026 | Nginx | Unified reverse proxy entry |
| LangGraph Server | 2024 | LangGraph | Agent runtime & workflow execution |
| Gateway API | 8001 | FastAPI | REST API for models, MCP, skills, memory, files, channels |
| EvoPanel | 1420 | Tauri v2 + React | Desktop UI |
| Provisioner | 8002 | optional | k3s Pod sandbox mode |

</details>

<details>
<summary>Middleware chain (execution order)</summary>

1. **ThreadDataMiddleware** - per-thread isolated directories (workspace, uploads, outputs)
2. **UploadsMiddleware** - inject newly uploaded files into context
3. **SandboxMiddleware** - acquire sandbox for code execution
4. **SummarizationMiddleware** - reduce context near token limits (optional)
5. **TodoListMiddleware** - track multi-step tasks in plan mode (optional)
6. **TitleMiddleware** - auto-generate conversation titles
7. **MemoryMiddleware** - queue conversations for async memory extraction
8. **ViewImageMiddleware** - inject image data for vision-capable models
9. **PlanGuardMiddleware** - filter side-effectful tool calls during planning phases
10. **ClarificationMiddleware** - intercept clarification requests and interrupt

</details>

Full design rationale: [docs/explanation/why-evoflow.md](docs/explanation/why-evoflow.md) · [docs/reference/architecture.md](docs/reference/architecture.md)

---

## Native Agent Teams

EvoFlow runs its own agents by default. The built-in subagent system delegates work concurrently with isolated context:

| Agent | Role |
| --- | --- |
| **Lead Agent** | The runtime entry point: routes the conversation, picks tools, and delegates via the `task()` tool. |
| **Supervisor** | Clarifies intent, calls `plan()`, decomposes into a subtask graph, and dispatches steps to the right agent. |
| **general-purpose subagent** | Full toolset - used for research, file work, and multi-tool tasks. |
| **bash subagent** | Command specialist (exposed only when shell access is available). |
| **Custom agents** | User-defined agents with their own SOUL/identity, model, tool whitelist, and workspace. |

**Preset Agent Teams** group custom agents into roles (e.g. a project team with planning / development / review agents). Teams are configurable; the role layout above is a recommended pattern, not a hard-coded requirement. Up to 3 subagents run concurrently per turn with a 15-minute timeout.

> External coding agents (Claude Code, Codex, Trae, CodeBuddy) may also be attached as workers through the ACP protocol - see the next section. This is *experimental* today; native subagents handle core tasks on their own.

Details: [docs/explanation/subagent-system.md](docs/explanation/subagent-system.md) · [docs/guides/chat/preset-roles.md](docs/guides/chat/preset-roles.md)

---

## Optional External Agent Adapters (Experimental)

External coding agents can be connected as **optional workers** when you want to reuse an existing workflow. EvoFlow does **not** require them to complete core tasks - native subagents handle planning, research, file edits, and commands directly.

The integration path is the **ACP (Agent Client Protocol)** layer, designed to normalize session lifecycle, streaming, and status projection across providers:

| Adapter | Status |
| --- | --- |
| Claude Code | Planned (ACP adapter) |
| Codex | Planned (ACP adapter) |
| Trae | Planned (ACP adapter) |
| CodeBuddy | Planned (ACP) |

> **Status: experimental / not yet verified in real use.** The ACP architecture is designed, but the adapters have not been validated end-to-end yet. If no external agent is configured, the Supervisor uses native subagents - which is the default and recommended path today.

This section is about **future compatibility**, not a core selling point. The native runtime is the default.

---

## Quick Start

EvoFlow is currently distributed as desktop installers and documentation. Source code is not yet publicly released.

### Get the desktop app

1. **Download** the latest installer from [Releases](https://github.com/EvovexAI/EvoFlow/releases).

   | Platform | Asset |
   | --- | --- |
   | Windows | `EvoFlow_<version>_x64-setup.exe` |
   | macOS (Apple Silicon) | `EvoFlow_<version>_aarch64.dmg` |
   | macOS (Intel) | `EvoFlow_<version>_x64.dmg` |
   | Linux (AppImage) | `EvoPanel_<version>_amd64.AppImage` |
   | Linux (DEB) | `EvoPanel_<version>_amd64.deb` |

   > Installers are published for Windows, macOS, and Linux. Windows is the most tested; macOS and Linux builds are available but less tested. See [Releases](https://github.com/EvovexAI/EvoFlow/releases) for the current assets.

2. **Configure a model.** On first launch, EvoPanel guides you to add a provider and API key.

3. **Start a task.** Open the chat page, choose a model, and describe what you want. For complex multi-step work, the system enters **Plan mode** automatically - review the plan, confirm, and watch the Agent Teams execute.

4. **Observe.** Track subtasks in the workflow panel, inspect tool calls and token usage in Agent Trace, and accept the result.

More: [docs/getting-started/quick-start.md](docs/getting-started/quick-start.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Example Tasks

### Build a small feature

```text
Create a simple settings page for this project.
First analyze the codebase, then propose a plan.
After confirmation, implement the change and run tests.
```

### Fix a bug

```text
Find why the login page fails after refresh.
Inspect the routing logic, propose a fix, apply it, and summarize the changed files.
```

### Refactor a module

```text
Refactor the task execution module for better separation between planning, execution, and recovery.
Do not change public behavior without confirmation.
```

### Long-running task (unattended)

```text
Analyze this repository, identify three maintainability issues, create a plan,
and execute the first approved improvement. Run it as a Goal so I can check back later.
```

> **Goal mode** runs a task in an independent thread with pause/resume/cancel and can push a Markdown summary to an IM channel (e.g. Feishu or WeChat) when finished. See [docs/guides/chat/goal-agent.md](docs/guides/chat/goal-agent.md).

---

## Screenshots

<p align="center">
  <img src="docs/assets/screenshots/main-chat.png" width="90%" alt="EvoPanel main interface: streaming chat with tool-call visualization">
</p>
<p align="center"><sub>Main interface - streaming chat and tool-call visualization</sub></p>

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/plan-supervisor/plan-02-structured-plan-modal.png" width="100%" alt="Plan mode: task analysis graph (Mermaid)">
      <br><sub>Plan - task analysis graph (modules, call chain, data flow)</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/plan-supervisor/plan-05-supervisor-workflow-panel.png" width="100%" alt="Supervisor subtask workflow panel">
      <br><sub>Supervisor - subtask workflow & dependencies</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/agents-preset-teams.png" width="100%" alt="Preset Agent Teams overview">
      <br><sub>Preset Agent Teams - team overview</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/agents-preset-roles.png" width="100%" alt="Roles within a team">
      <br><sub>Roles within a team (plan / develop / review …)</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/hosted-1.png" width="100%" alt="Goal task run & config">
      <br><sub>Goal task - run & config</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/assets/screenshots/browser.png" width="100%" alt="Browser automation">
      <br><sub>Browser - agent-driven browsing & interaction</sub>
    </td>
  </tr>
</table>

> More in [docs/assets/screenshots/](docs/assets/screenshots/) and [docs/assets/plan-supervisor/](docs/assets/plan-supervisor/).

---

## Roadmap

EvoFlow is under active development. Items are directional, not dated commitments.

**Short-term**
- Stronger native coding execution within subagents
- Improved subtask DAG visualization and dependency control
- Better recovery and partial re-planning
- More skills and refined skill lifecycle

**Mid-term**
- MCP marketplace and easier adapter discovery
- Sandbox hardening (container & provisioner modes)
- Team collaboration features
- Plugin / extension SDK

**Long-term**
- Enterprise audit & permissions
- Broader IM and integration ecosystem
- More docs, demos, and benchmark scenarios

---

## Source Availability and License

EvoFlow is currently distributed as desktop installers and documentation; the source code is **not yet publicly released**. The project is **not** open-source under an OSI-approved license. It is governed by the [Evovex AI Non-Commercial License 1.0](LICENSE): when source access is granted, personal, educational, and research use is permitted; **commercial use requires written authorization** ([cloud@evovexai.com](mailto:cloud@evovexai.com)).

Some modules, examples, SDKs, skills, adapters, and documentation may be opened progressively as the product, community, and commercial model mature. Upstream and third-party components (including DeerFlow, MIT-licensed) are governed by their own licenses - see [NOTICE](NOTICE).

The names "EvoFlow", "EvoPanel", and "Evovex AI" are trademarks of Evovex AI; trademark use requires separate permission.

---

## Contributing

We currently welcome:

- Bug reports and reproducible issues
- Documentation improvements
- Workflow examples and use cases
- Skill / MCP adapter suggestions
- Integration requests and product feedback

Source code is not yet publicly available, so core code contributions are limited for now; the items above are the best ways to contribute today. The development workflow is documented in [CONTRIBUTING.md](CONTRIBUTING.md) for reference. Any accepted contributions are licensed under the [EvovexAI Non-Commercial License](LICENSE), and EvovexAI may use them for commercial offerings under separate terms.

---

## Security

- **Do not** submit API keys, tokens, private repository contents, or customer data in issues or PRs.
- To report a vulnerability, email [cloud@evovexai.com](mailto:cloud@evovexai.com) or use [GitHub Private Vulnerability Reporting](https://github.com/EvovexAI/EvoFlow/security/advisories/new). Do **not** open a public issue.
- Target response: acknowledgment within 48 hours, initial assessment within 7 days, fix/mitigation within 30 days (severity-dependent).

See [SECURITY.md](SECURITY.md) for supported versions and local-installation best practices (localhost binding, default guardrails, sandbox defaults, CORS).

---

## Acknowledgements

EvoFlow builds on and is inspired by excellent open work:

| Project | Contribution |
| --- | --- |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Graph-based agent orchestration - the runtime foundation |
| [LangChain](https://github.com/langchain-ai/langchain) | LLM abstractions and the tool ecosystem |
| [DeerFlow](https://github.com/bytedance/deer-flow) | Early engineering baseline (MIT; portions retained under MIT, see [NOTICE](NOTICE)) |
| [Model Context Protocol](https://modelcontextprotocol.io) | The MCP standard for tool extensions |
| [Tauri](https://tauri.app) | Cross-platform desktop runtime for EvoPanel |

---

## Contact

| Channel | Use for |
| --- | --- |
| [GitHub Issues](https://github.com/EvovexAI/EvoFlow/issues) | Bug reports, feature requests (recommended) |
| [GitHub Discussions](https://github.com/EvovexAI/EvoFlow/discussions) | Questions and ideas |
| [cloud@evovexai.com](mailto:cloud@evovexai.com) | Commercial licensing & partnerships |
| [evovexai.com](https://www.evovexai.com) | Product, docs, and showcases |

<p align="center">
  <img src="docs/assets/screenshots/wechat-group-qr.jpg" width="180" alt="EvoFlow WeChat group (Chinese)">
</p>
<p align="center"><sub>WeChat group (Chinese users - please keep discussions desensitized, no ads)</sub></p>

---

<div align="center">

Built by **EvovexAI** · [中文文档](README.zh-CN.md)

</div>
