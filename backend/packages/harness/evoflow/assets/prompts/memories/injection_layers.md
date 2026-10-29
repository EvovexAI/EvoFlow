# Asset injection layers (SoT)

Runtime injects **indexes + short standing**, never experience bodies by default.
Source of truth for durable know-how is the Asset Hub tree, **not** `agents.system_prompt`.

## Layers (employee / user entity)

| Layer | What | When loaded | Owns |
|-------|------|-------------|------|
| **L0 job** | `<agent_system_prompt>` / soul | every turn | Duty skeleton only: role, I/O shape, hard gates, tool allow-hints |
| **L1 standing** | `memory/standing.md` (capped) | every turn | Prefs, tips, **What's in Memory** routing pointers |
| **L2 catalog** | short titles under craft/facts/episodic/journal + `MEMORY.md` | every turn | Discoverability — filenames / one-line labels (no body) |
| **L3 body** | full md under craft / MEMORY / facts / … | on demand | Details via `assets` `read` / `search` |
| **L4 inbox** | `_inbox/notes` pending | until Phase2 | Fresh notes not yet consolidated |

## Write rules (anti dual-write)

| Content | Write to | Never write to |
|---------|----------|----------------|
| Stable prefs / habits | standing (via Phase2) or profile | `system_prompt` |
| Process / experience / reflection | `assets` `note` → inbox → Phase2 | `system_prompt` / soul |
| Reusable playbook | `craft/*.md` | paste into job prompt |
| Job duty / output contract | `system_prompt` (short) | duplicate into every craft file |

If the same rule exists in both job prompt and assets, **assets win for details**; slim the job prompt to a one-line pointer (“详见 craft/… / MEMORY …”).

## Catalog policy

- Short titles only; **no row cap** for now (labels are cheap).
- Bodies stay on disk; model opens paths when the turn needs them.
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
