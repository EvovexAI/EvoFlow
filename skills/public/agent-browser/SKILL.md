---
name: agent-browser
description: Browser automation via the deferred ``browser`` tool (open/snapshot/click/fill/screenshot) or agent-browser CLI via terminal. Use for interactive web browsing, login flows, or dynamic pages.
---

# Agent Browser

Interactive browser control uses the unified **`browser`** tool (recommended) or the [agent-browser](https://github.com/vercel-labs/agent-browser) CLI via **`terminal`**.

## Recommended: `browser` tool (deferred)

1. Activate agent mode: `scenario(action='activate', scenario_key='agent')`
2. Load the tool schema: `tool_search(query='select:browser')`
3. Run actions on one session:

```
browser(action='open', url='https://example.com')   # opens live view in EvoPanel browser side panel
browser(action='snapshot')
browser(action='click', ref='@e2')
browser(action='fill', ref='@e3', text='search text')
browser(action='press', key='Enter')
browser(action='snapshot')
browser(action='screenshot')   # optional still capture for history
browser(action='close')
```

Actions: `open`, `snapshot`, `click`, `fill`, `press`, `scroll`, `screenshot`, `back`, `close`.

## Fallback: terminal + agent-browser CLI

There are no legacy built-in `browser_*` tools — run CLI commands in the same terminal session for a multi-step flow.

## Prerequisites

```bash
npm install -g agent-browser
agent-browser install
```

Desktop installs bundle `tools/agent-browser/`; dev: `make setup-agent-browser`.

Optional CDP (logged-in Chrome): `EVOFLOW_BROWSER_CDP_URL=http://127.0.0.1:9222`

## Core workflow (snapshot + ref)

Use one terminal session and reuse `--session evoflow` (or any fixed name):

```bash
agent-browser --session evoflow open https://example.com
agent-browser --session evoflow snapshot -c
agent-browser --session evoflow click @e2
agent-browser --session evoflow fill @e3 "search text"
agent-browser --session evoflow press Enter
agent-browser --session evoflow snapshot -c
agent-browser --session evoflow close
```

Rules:

1. **Always snapshot** before choosing refs (`@e1`, `@e2`, …).
2. **Re-snapshot** after navigation or clicks that change the page.
3. Prefer refs from the latest snapshot over guessing CSS selectors.

## Common commands

| Command | Purpose |
|---------|---------|
| `open <url>` | Navigate |
| `snapshot -c` | Compact aria tree with refs (**primary way to “see” the page**) |
| `click @eN` | Click element |
| `fill @eN "text"` | Clear and type |
| `type @eN "text"` | Append text |
| `press Enter` | Keyboard |
| `scroll down 800` | Scroll |
| `screenshot <path>` | PNG capture (**pixels only — see below**) |
| `back` | History back |
| `close` | End session |

JSON output (for scripting): append `--json` before the subcommand, e.g. `agent-browser --session evoflow --json snapshot -c`.

## Seeing the page: snapshot vs screenshot

**Default — use `snapshot -c` (text)**

The compact snapshot returns an aria tree with `@e1`, `@e2`, … refs. The main agent reads this **text** to click, fill, and judge page state. Use this for almost all interactive browsing.

**When you need pixels — `screenshot` + `view_image`**

`terminal` running `screenshot` only saves a file and returns **text output** (path/status). It does **not** inject image pixels into the model context.

To let the main agent **see** a screenshot:

1. Activate agent mode if needed: `scenario(activate, agent)` (loads `view_image`).
2. Save under session outputs (absolute path or virtual path):

```bash
agent-browser --session evoflow screenshot /mnt/user-data/outputs/page.png
```

On Windows, use the resolved outputs path from the workspace block, e.g. `D:\...\outputs\page.png`.

3. Immediately call **`view_image`** with the same path (not another terminal command):

```
view_image(image_path="/mnt/user-data/outputs/page.png")
```

`ViewImageMiddleware` injects the PNG into the next model turn as multimodal input.

- Remote http/https image URLs are also supported by `view_image(image_path="https://…")`.

**When to screenshot**

| Need | Use |
|------|-----|
| Click, fill, read structure | `snapshot -c` |
| CAPTCHA, dense layout, visual-only UI | `screenshot` → `view_image` |
| Deliver a picture to the user | `screenshot` → cite `@@outputs/…@@` |

## When to use what

| Task | Approach |
|------|----------|
| Read article / static page | `web_fetch` first (cheaper) |
| Login, forms, multi-step UI | This skill + `terminal` + `snapshot -c` |
| Visual proof / layout check | `screenshot` → `view_image` |
| One-shot page text | `open` → `snapshot -c` → `close` |

## Tips

- Keep the same `--session` name across steps in one user task.
- Prefer **`snapshot -c`** over screenshot unless pixels are required.
- After **`screenshot`**, always follow with **`view_image`** if you need to understand the image yourself.
- Call `close` when done to free the browser.
- Do not use `agent-browser chat` unless the user explicitly wants the standalone AI mode (separate from EvoFlow's model).
