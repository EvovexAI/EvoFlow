# Asset injection layers (SoT)

Runtime injects **indexes + full standing page**, never experience bodies by default.
Source of truth for durable know-how is the Asset Hub tree, **not** `agents.system_prompt`.

## Layers (employee / user entity)

| Layer | What | When loaded | Owns |
|-------|------|-------------|------|
| **L0 job** | `<agent_system_prompt>` / soul | every turn | Duty skeleton only: role, I/O shape, hard gates, tool allow-hints |
| **L1 standing** | `memory/standing.md` (**full**, no runtime scissors) | every turn | Prefs, tips, **What's in Memory** routing pointers — **derived summary**, not a third content kind. Keep the file short via Phase2 rewrite, not prompt truncation. |
| **L2 catalog** | filenames under craft/facts/episodic/journal headings + `MEMORY.md` | every turn | Discoverability — basename + one-line label (no dir prefix, no body) |
| **L3 body** | full md under craft / MEMORY / facts / … | on demand | Details via `assets` `read` / `search` |
| **L4 inbox** | `_inbox/notes` pending | until Phase2 | Fresh notes not yet consolidated |

**Product IA:** `facts/` = 条目 (detail lines: prefs/facts); `episodic/` = 过程 (dialogue recaps); `standing.md` = 记忆摘要 (overall derived page, not a third content kind). Dialogue write/load policy SoT: `read_path.md` decision table.

## Write rules (anti dual-write)

| Content | Write to | Never write to |
|---------|----------|----------------|
| Stable prefs / habits | `assets note` `[preference]` → Phase2 → facts (+ standing rewrite) or `profile` | `system_prompt`; direct `standing.md` |
| Process recap | `assets note` `[process]` → Phase2 → episodic | `system_prompt` / soul |
| Experience / reflection | `assets note` `[experience]` / `[reflection]` → Phase2 → craft / journal | `system_prompt` / soul |
| Reusable playbook | `craft/*.md` (via Phase2) | paste into job prompt |
| Job duty / output contract | `system_prompt` (short) | duplicate into every craft file |

If the same rule exists in both job prompt and assets, **assets win for details**; slim the job prompt to a one-line pointer (“详见 craft/… / MEMORY …”).

## Catalog policy

- Kind heading + **basename only** (no `craft/` / `memory/facts/` prefix on every row — filenames are unique enough within an entity; `assets read` resolves basename).
- Short titles/labels; **no row cap** for now (labels are cheap).
- Bodies stay on disk; model opens by filename when the turn needs them.
- Overflow / missing detail → `assets` search/read, not “stuff into system_prompt”.

## Turn-tail Hub Recall (why assets “feel empty” otherwise)

Writing to Hub does **not** paste the body into the next system prompt. Without a
pull, models often ignore catalog. Runtime therefore:

1. Inject L1 standing + L2 catalog every turn.
2. **Default-on** title/path recall against craft/facts/episodic/journal catalog
   labels (`EVOFLOW_HUB_RECALL`, default on) → path·title lines on the HumanMessage
   tail (**no body search** — less noise).
3. Model `assets read` for full playbooks when a title matches.

Legacy SQLite / person-kernel recall stays behind `EVOFLOW_QUERY_RECALL` (default off).
