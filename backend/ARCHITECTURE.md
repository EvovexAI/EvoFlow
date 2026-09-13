# EvoFlow Backend Architecture

This document defines the backend's layering rules and the guardrails that keep
it from regressing. It accompanies the review
(`outputs/2026-09-13-EvoFlow架构评估与治理方案.md`, 2026-09-13).

## Layering

```
┌────────────────────────────────────────────────────────────┐
│  Application layer  backend/app                            │
│  (gateway HTTP/SSE, channels, orchestration glue)          │
│        │  imports evoflow.*  (allowed, one direction)      │
│        ▼                                                   │
│  Core (kernel)      backend/packages/harness/evoflow       │
│  (agents, tools, knowledge, persistence, proactive, …)     │
│        │  must NOT import app.*  (rule R1)                 │
└────────────────────────────────────────────────────────────┘
```

- The application layer owns process entrypoints, HTTP routes, SSE/WS plumbing
  and channel integrations. It may import anything in the core.
- The core owns domain logic and persistence. It must stay importable and
  testable **without** `backend/app`.

### Core → application dependencies (the one allowed bridge)

When the core needs an application-layer capability (event broadcast, channel
registration, …), it consumes a **port** defined in the core; the application
layer registers its adapter at startup. This is the only sanctioned pattern.

```python
# evoflow/runtime/events.py  (port, defined in core)
from typing import Any, Protocol

class EventBroadcaster(Protocol):
    async def broadcast(self, thread_id: str, event_type: str, data: dict[str, Any]) -> None: ...

def register_event_broadcaster(impl: EventBroadcaster) -> None: ...
def get_event_broadcaster() -> EventBroadcaster | None: ...
```

```python
# app/gateway/app.py  (adapter registration at startup)
from evoflow.runtime.events import register_event_broadcaster
register_event_broadcaster(broadcaster)
```

## Rules

| ID | Rule | Enforced by |
|----|------|-------------|
| R1 | Files under `packages/harness/evoflow/` must not import `app.*`. Existing violations are grandfathered in `scripts/arch_ban_app_imports_baseline.txt`; the list may only shrink. New needs go through ports in `evoflow/runtime/`. | `python backend/scripts/arch_ban_app_imports.py` (CI) |
| R2 | New top-level/second-level package inside `evoflow/` must be registered in the domain table below with a one-line responsibility. | Code review (ARCHITECTURE.md diff must accompany the new package) |
| R3 | A single package directory should stay under ~40 `.py` files; when exceeded, split into domain subpackages. | CI warning (non-blocking) |
| R4 | Do not reuse an existing concept root (`scheduler`, `exploration`, `memory`, …) for a new package unless it truly belongs to that domain; extend the existing package instead. | Code review |
| R5 | `packages/harness/app/` is a test-only shim. Production code must never reference it. Phase 2 of the remediation plan removes it once R1 violations reach zero. | `rg` spot checks + Phase 2 |

## Domain table (top-level `evoflow/` packages)

| Package | Layer | Responsibility |
|---|---|---|
| `a2a` | domain | Agent-to-agent meeting protocol (cards, orchestrator, adapter) |
| `agents` | domain | Lead agent, goal graph, middlewares, memory plugins, mission state |
| `assets` | domain | Entity asset store (memory / process / reflection / craft) |
| `authz` | infra | Authorization, principals, workspace visibility |
| `collab` | domain | Task orchestration ledger, workflows, subtask streaming |
| `community` | infra | Third-party integrations (search, firecrawl, media generation) |
| `config` | infra | Typed configuration (yaml/env) per feature |
| `knowledge` | infra | KB vaults, owned wiki, indexing, embeddings |
| `memory` | domain | Memory facade, consolidation, KG extraction |
| `models` | infra | Chat-model factory, vendor payloads, patched providers |
| `observability` | infra | Trace stores, latency, thinking context, queries |
| `persistence` | infra | SQLite schema + repositories (the only DB owner) |
| `proactive` | domain | Heartbeat runner, proactive engine, duty cycle |
| `runtime` | runtime | Ports for application-layer capabilities (event broadcaster, channel registry) — the R1 escape hatch |
| `scheduler` | domain | Local tool scheduler (prefetch, post-edit lint, search follow-up) |
| `session_execution` | runtime | Session run lifecycle, cancellation, mirrors |
| `skills` | domain | Skill loading, install, injection |
| `subagents` | domain | Subagent registry, executor, builtins |
| `tools` | domain | Tool catalog, builtins, host-direct file/terminal tools |
| `webui` | infra | Web UI auth (JWT/OIDC), static serving |

(The remaining packages follow the same registration requirement for any
*new* additions; this table covers the load-bearing ones.)

## Remediation status

Track progress against `outputs/2026-09-13-EvoFlow架构评估与治理方案.md`:

- [x] Phase 0 — rules + CI guard (`scripts/arch_ban_app_imports.py` + baseline, 60 entries)
- [ ] Phase 1 — port the 49 `app.gateway` + 11 `app.channels` imports to `evoflow/runtime/`
- [ ] Phase 2 — delete `packages/harness/app/` shim once R1 count reaches 0
- [ ] Phase 3 — renames (`exploration_graph` → `mind_map`, scheduler disambiguation)
- [ ] Phase 4 — split giant flat packages (`agents/middlewares` 77, `tools/builtins` 48)
