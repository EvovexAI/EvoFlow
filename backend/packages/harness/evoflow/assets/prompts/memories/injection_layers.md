# Asset injection layers (SoT)

Runtime injects **indexes + full standing page**; experience bodies stay on disk until `assets read`.

| Layer | What | When | Owns |
|-------|------|------|------|
| **L0 job** | system_prompt / soul | every turn | Duty skeleton only |
| **L1 standing（长期记忆）** | `memory/standing.md` full page | every turn (memory on) | Prefs, tips, What's in Memory name index |
| **L1b affect（心境）** | `profile/affect.md` → `<affect>` | every turn (memory on) | Main→user vault; employee/小微→own vault |
| **L2 catalog** | craft / episodic / journal filenames + `MEMORY.md` | every turn (memory on) | Discoverability |
| **L3 body** | craft / episodic / … | on demand | `assets` read / search |

`memory_enabled` / 资产工具开关关 → standing、catalog、`<affect>` 全不注入（主智能体 / 员工 / 小微同一套）。

## Write (agent)

| Content | Tool |
|---------|------|
| Prefs / hard constraints | `assets note` `kind=preference` → standing |
| Process recap | `assets note` `kind=process` → episodic |
| Experience / reflection | `kind=experience` → craft；`kind=reflection` → journal |
| User identity | `assets profile`（`mode=append\|replace`） |
| Mood (main→user vault; employee→employee) | `assets affect`（`mode=append\|replace`；主动写） |
| Job duty | short system_prompt only |

Outdated / duplicate topics → **model decides**: `read` then `note`+`path=` or `write` to overwrite. Runtime never auto-merges by similarity.

Assets win for details over job prompt; job prompt may keep a one-line pointer.

## Catalog & recall

- Catalog: basename only under kind headings.
- Hub Recall (`EVOFLOW_HUB_RECALL`, default on): path·title lines on the turn tail; model `assets read` for bodies.
