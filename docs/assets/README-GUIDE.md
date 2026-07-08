# Asset Placement Guide

This guide tells you **which screenshots / GIFs / videos should go where** so the new README renders cleanly on GitHub and stays maintainable. It is a recommendation; the existing assets already work, but several spots would benefit from dedicated captures.

---

## Current asset inventory (already in the repo)

```
docs/assets/
├── EvoFlow-LOGO.png                              # hero logo (used in hero)
├── wechat-image-20260520-302.png                 # (spare, not referenced by README)
├── plan-supervisor/
│   ├── video-01-plan-clarify-to-ready.mp4        # hero demo video
│   ├── video-01-plan-clarify-to-ready-poster.png # hero demo poster (fallback image)
│   ├── video-02-plan-project-running-result.mp4  # running-result demo
│   ├── video-02-plan-project-running-result-poster.png
│   ├── plan-02-structured-plan-modal.png         # task analysis graph
│   ├── plan-02-structured-plan-modal-2.png       # exec steps + agent goals
│   ├── plan-04-exec-confirm-dock.png             # execution confirm gate
│   ├── plan-05-supervisor-workflow-panel.png     # supervisor workflow panel
│   └── README.md                                  # recording notes (internal)
└── screenshots/
    ├── main-chat.png                             # main interface
    ├── agents-preset-teams.png                   # preset teams overview
    ├── agents-preset-roles.png                   # roles within a team
    ├── agents.png                                # (spare)
    ├── browser.png                               # browser automation
    ├── hosted-1.png / hosted-2.png               # goal task run & config
    ├── scheduled-tasks-1.png / scheduled-tasks-2.png  # automation
    ├── wechat-group-qr.jpg                       # wechat group QR
    └── 微信图片_20260607215240_23_495.png          # (spare)
```

---

## What the new README references

| README section | Asset path | Status |
| --- | --- | --- |
| Hero logo | `docs/assets/EvoFlow-LOGO.png` | exists |
| Demo (hero) | `docs/assets/plan-supervisor/video-01-plan-clarify-to-ready.mp4` + `-poster.png` | exists |
| Screenshots / Plan | `docs/assets/plan-supervisor/plan-02-structured-plan-modal.png` | exists |
| Screenshots / Supervisor | `docs/assets/plan-supervisor/plan-05-supervisor-workflow-panel.png` | exists |
| Screenshots / Teams | `docs/assets/screenshots/agents-preset-teams.png` | exists |
| Screenshots / Roles | `docs/assets/screenshots/agents-preset-roles.png` | exists |
| Screenshots / Goal | `docs/assets/screenshots/hosted-1.png` | exists |
| Screenshots / Browser | `docs/assets/screenshots/browser.png` | exists |
| Contact / WeChat | `docs/assets/screenshots/wechat-group-qr.jpg` | exists |

All referenced assets already exist, so the READMEs render today with no broken images.

---

## Recommended additions (optional, would strengthen the README)

These are the gaps between what the brief asked for ("Main panel / Plan mode / Agent Teams / Task graph / Tool calls / Logs / Settings / Skills-MCP / IM integration") and what currently exists. If you capture them, place them here:

| Desired shot | Suggested path | Which README section it improves |
| --- | --- | --- |
| Agent Trace / observability logs (token usage, cache hit) | `docs/assets/screenshots/agent-trace.png` | Core Capabilities -> Observability; Screenshots |
| Model configuration page | `docs/assets/screenshots/settings-models.png` | Quick Start (step 2) |
| Skills market / MCP config | `docs/assets/screenshots/skills-mcp.png` | Core Capabilities -> Skills/MCP |
| IM integration (Feishu card in-thread) | `docs/assets/screenshots/im-feishu.png` | Contact / enterprise note |
| Mind map (knowledge graph) panel | `docs/assets/screenshots/mind-map.png` | Screenshots (currently not shown) |
| A short hero GIF (5-10s loop) of plan->execute->deliver | `docs/assets/plan-supervisor/hero-demo.gif` | Hero (replace/augment video link for instant preview) |

> GitHub does not autoplay `.mp4` inline, so a lightweight hero **GIF** in the hero block gives the strongest "30-second first impression." The `.mp4` can stay as the click-through for full quality.

---

## Placement conventions

1. **Hero**: one logo + one demo (video link with a poster image, or a GIF). Do not stack multiple images in the hero.
2. **Screenshots section**: use a 2-column `<table>` layout (already in the README) so they stay aligned on desktop and stack on mobile.
3. **Always use relative paths** from repo root (`docs/assets/...`), never absolute URLs, so forks and mirrors render correctly.
4. **Add `alt` text** to every `<img>` for accessibility and for cases where images fail to load.
5. **Keep originals**; GitHub will downscale large PNGs in the markdown preview, but the full-size files remain downloadable.
6. **Naming**: `kebab-case`, descriptive, no timestamps or Chinese characters in filenames (the existing `微信图片_*.png` is a leftover to avoid referencing).

---

## Internal note

`docs/assets/plan-supervisor/README.md` already contains recording/shot-list guidance - keep using it when producing new plan-supervisor assets. This guide is only about *where final assets live and how the README references them*.
