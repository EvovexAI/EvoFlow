# Asset Hub memory prompts

Provenance: upstream memory-template patterns, path-mapped to EvoFlow
`~/.evoflow/assets/{entity}/`.

| File | Role | When used |
|------|------|-----------|
| `read_path.md` | Shared Entity-assets procedure (once per turn) | Tier 0; composed with entity blocks |
| `read_path_entity.md` | Per-root layout + MEMORY_SUMMARY | Tier 0; one block per user/workspace/… |

| `stage_one_system.md` | Phase 1 extract system | Background worker after idle session |
| `stage_one_input.md` | Phase 1 user/input wrapper | Same |
| `consolidation.md` | Phase 2 consolidate system | Background worker on entity lock |
| `ad_hoc_instructions.md` | How Phase 2 treats inbox notes | Consolidation inputs |

Path map: Entity-assets layout under `~/.evoflow/assets/{entity}/` (see Asset Hub / memory docs in `docs/user/`).
