# Asset injection layers (SoT)

Runtime injects **indexes + full standing page**, never experience bodies by default.
Source of truth for durable know-how is the Asset Hub tree, **not** `agents.system_prompt`.

## Layers (employee / user entity)

| Layer | What | When loaded | Owns |
|-------|------|-------------|------|
| **L0 job** | `<agent_system_prompt>` / soul | every turn | Duty skeleton only: role, I/O shape, hard gates, tool allow-hints |
| **L1 standing（长期记忆）** | `memory/standing.md` (**full**, no runtime scissors) | every turn | Prefs, tips, **What's in Memory** name-only file index — overall memory page for this entity. Keep the file short when rewriting, not via prompt truncation. |
| **L2 catalog** | filenames under craft/episodic/journal headings + `MEMORY.md` | every turn | Discoverability — basename + one-line label (no dir prefix, no body) |
| **L3 body** | full md under craft / MEMORY / episodic / … | on demand | Details via `assets` `read` / `search` |

**Product IA:** `standing.md` = **长期记忆** (overall entity memory); `episodic/` = **过程** (dialogue recaps). Product no longer uses 「条目 / facts」. Dialogue write/load policy SoT: `read_path.md` decision table.

## Write rules (anti dual-write) — **one step, by tag**

| Content | Write to (direct) | Never write to |
|---------|-------------------|----------------|
| Stable prefs / habits | `assets note` `[preference]` → `standing.md`；identity → `assets profile` | `system_prompt`; `_inbox/notes` hop |
| Process recap | `assets note` `[process]` → `episodic/` | `system_prompt` / soul |
| Experience / reflection | `assets note` `[experience]` / `[reflection]` → `craft/` / `journal/` | `system_prompt` / soul |
| Reusable playbook | `craft/*.md` | paste into job prompt |
| Job duty / output contract | `system_prompt` (short) | duplicate into every craft file |

If the same rule exists in both job prompt and assets, **assets win for details**; slim the job prompt to a one-line pointer (“详见 craft/… / MEMORY …”).

## Catalog policy

- Kind heading + **basename only** (no `craft/` / `memory/facts/` prefix on every row — filenames are unique enough within an entity; `assets read` resolves basename).
- Short titles/labels; **no row cap** for now (labels are cheap).
- Bodies stay on disk; model opens by filename when the turn needs them.
- Overflow / missing detail → `assets` search/read, not “stuff into system_prompt”.

## Turn-tail Hub Recall (why assets “feel empty” otherwise)

Writing to Hub does **not** paste the body into the next system prompt (except
standing, which is L1-injected whole). Without a pull, models often ignore catalog.
Runtime therefore:

1. Inject L1 standing（长期记忆）+ L2 catalog every turn.
2. **Default-on** title/path recall against craft/episodic/journal catalog
   labels (`EVOFLOW_HUB_RECALL`, default on) → path·title lines on the HumanMessage
   tail (**no body search** — less noise).
3. Model `assets read` for full playbooks when a title matches.

Legacy SQLite / person-kernel recall stays behind `EVOFLOW_QUERY_RECALL` (default off).
