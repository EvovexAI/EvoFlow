---
name: agent-browser
description: Interactive browser automation via the deferred ``browser`` tool (open/snapshot/click/fill/press/scroll/screenshot/back/close). The agent drives the same WebView2 page the user sees in the EvoPanel browser side panel. Use for dynamic pages, login flows, and anything needing clicks or forms.
---

# Agent Browser

Interactive browser control uses the unified **`browser`** tool. The agent drives the
**EvoPanel embedded WebView2** — the same page the user watches in the browser side
panel (ZCode model: one host-owned browser, no second window, no screencast).

## Loading the tool (deferred)

1. Activate agent mode: `scenario(action='activate', scenario_key='agent')`
2. Load the tool schema: `tool_search(query='select:browser')`

## Core workflow (snapshot + ref)

```
browser(action='open', url='https://example.com')   # live view appears in the EvoPanel side panel
browser(action='snapshot')                           # read the page → refs e1, e2, …
browser(action='click', ref='e2')
browser(action='fill', ref='e3', text='search text')
browser(action='press', key='Enter')
browser(action='snapshot')                           # page changed → refs are stale
browser(action='screenshot')                         # optional — pixels, shown to the user
browser(action='close')
```

Actions: `open`, `snapshot`, `click`, `fill`, `press`, `scroll`, `screenshot`, `back`, `close`.

## Discipline (do not skip)

1. **Always `snapshot` before choosing refs.** Refs (`e1`, `e2`, …) come from the latest
   snapshot and are invalidated by navigation and by clicks that change the page.
2. **Re-snapshot after navigation or state-changing clicks.** A stale ref returns
   `ref_not_found` — that is the signal to take a fresh snapshot, not to retry.
3. **Never guess CSS selectors, labels, or placeholders.** Build clicks and fills only
   from facts in the latest snapshot. If a locator target is ambiguous, take a fresh
   snapshot and narrow it instead of guessing.
4. **One state-changing action per observation.** After acting, judge success by the
   expected effect (URL, page state, next snapshot) — not by absence of errors.
5. **`snapshot` is how you read the page.** It returns URL, title, interactive elements
   with refs, and a compact content outline. Use `screenshot` only when pixels matter.

## When to screenshot

| Need | Use |
|------|-----|
| Click, fill, read structure | `snapshot` |
| CAPTCHA, dense layout, visual-only UI | `screenshot` (then judge from the returned image info) |
| Deliver a picture to the user | `screenshot(full_page=…)` — the image is shown in the chat UI |

The screenshot image is rendered for the user in the chat timeline; the tool result
itself stays compact (no base64 in context).

## Prerequisites

- The EvoFlow desktop app must be running — the tool drives its embedded WebView2.
  If the engine is unreachable the tool returns a structured
  `backend_unavailable` error; report it instead of trying other browsers.
- Do not invent alternate browsers or CLIs. The legacy `agent-browser` CLI path was
  removed; terminal-based browsing recipes are obsolete.

## Tips

- `fill` goes through the keyboard path (focus + insertText), so React/Vue controlled
  inputs work as if the user typed.
- `press` accepts `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, arrow keys,
  `Home`/`End`/`PageUp`/`PageDown`, single characters, and `modifiers` (e.g. Ctrl).
- `scroll` takes `direction` (`down`/`up`/`left`/`right`) and `amount` in CSS pixels.
- `back` walks the WebView2 session history; `close` ends the agent session (the user
  keeps the panel and can close it from the UI).
- The user can interact with the panel too (address bar, clicks). Treat unexpected page
  changes as user actions: re-snapshot before continuing.
