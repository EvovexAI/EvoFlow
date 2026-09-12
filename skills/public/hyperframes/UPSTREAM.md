# HyperFrames skills (upstream)

Bundled from [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) (Apache-2.0).

## EvoFlow usage

1. Enable skills in **EvoPanel → 扩展 → Skills** (public skills default on unless disabled in `extensions_config.json`).
2. Assign to your agent under **Agent 管理 → 技能** (entry: `hyperframes`, plus workflow skills as needed).
3. Activate **workspace** scenario for code/terminal work.
4. Prerequisites on the machine: **Node.js ≥ 22**, **FFmpeg** on `PATH`, then `npx hyperframes doctor`.

Start prompts: ask to make a video with HyperFrames, or reference the `hyperframes` skill for routing.

## Included skill folders

Core: `hyperframes`, `hyperframes-core`, `hyperframes-animation`, `hyperframes-creative`, `hyperframes-cli`, `hyperframes-media`, `hyperframes-registry`, `general-video`.

Workflows: `embedded-captions`, `faceless-explainer`, `motion-graphics`, `music-to-video`, `pr-to-video`, `product-launch-video`, `remotion-to-hyperframes`, `slideshow`, `talking-head-recut`, `website-to-video`, `media-use`.

Update: re-copy from upstream `skills/` or run `npx skills add heygen-com/hyperframes` and sync into `skills/public/`.
