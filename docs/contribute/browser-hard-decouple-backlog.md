# Browser hard-decouple backlog (not this PR)

Soft-decouple (host owns HWND; panel is display + user chrome only) is the current contract.

**Hard-decouple** would mean:

- Agent drives a hidden / off-slot WebView2 (or headless) with full CDP.
- Right-stage panel is a **mirror** (screencast or second WebView) that never shares navigation control with the agent instance.
- Multi-session could then use multiple agent surfaces without `browser-embed-primary` ownership fights.

Risks: double memory, mirror latency, click-coordinate mapping, login/cookie split. Track separately; do not block soft-decouple shipping.
