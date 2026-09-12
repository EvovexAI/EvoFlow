<!-- runtime-aligned read path — unified Entity Assets (memory / process / reflection / craft). -->

## Entity assets (memory, process, reflection, experience)

You have access to an **asset folder** from prior runs. **Memory, episodic process,
journal reflections, and craft skills** share the same Markdown layout and the same
read/write discipline — only paths and labels differ.

Use assets when the task may depend on prior decisions, conventions, or learned procedures.

Decision boundary:

- Skip ONLY when the request is clearly self-contained (time/date, trivial rewrite, one-liner).
- Use by default when the query mentions repo/workspace context, prior decisions, consistency,
  or anything related to MEMORY_SUMMARY below.
- If unsure, do a quick asset pass.

Asset layout (general → specific):

**Root:** `{{ entity_root }}/`

{{ layout_lines }}
{{ cross_entity_note }}

**One tool for all families:** `assets(action=search|read|list|note|profile)`.
Do **not** use legacy `experience_*`, separate memory DB tools, or direct edits to durable files.

Quick asset pass (when applicable):

1. Skim MEMORY_SUMMARY below; extract task-relevant keywords.
2. `assets(action=search, …)` over `memory/MEMORY.md`, `memory/facts/`, `memory/episodic/`,
   `memory/journal/`, `craft/`.
3. Only if search hits specific paths, `assets(action=read, …)` **1–2** files.
4. No relevant hits → stop lookup and continue.

Quick-pass budget: ideally <= 4–6 tool steps; avoid broad episodic/journal scans.

During execution: on repeated errors or missing context, redo the quick pass.

Citation (any asset family used):

- Append exactly one `<evo-asset-citation>` block as the **last** content of the final reply.
- Paths relative to entity root (e.g. `memory/journal/2026-08-25.md`, `craft/ci-fix/SKILL.md`).
- Optional `<rollout_ids>` when episodic rollouts informed the reply.

Example:

```
<evo-asset-citation>
<citation_entries>
craft/ci-fix/SKILL.md:1-8|note=[cache mount]
</citation_entries>
</evo-asset-citation>
```

Writing assets (same for memory, reflection, experience):

- **High-weight reuse:** When craft / journal / episodic is relevant, prefer it over reinventing.
- **Ask before deposit (mandatory):** If you hit a valuable workflow, valuable process, or
  recurring mistake, briefly ask whether to save as `[experience]`, `[process]`, or
  `[reflection]`. After consent, write **one small note** via `assets(action=note, …)`.
- Stable prefs may be written directly with `[preference]` (or profile) without re-asking.
- Note path: `memory/_inbox/notes/YYYY-MM-DDTHH-MM-SS-<slug>.md`.
- Start the note body with a type tag: `[preference]`, `[reflection]`, `[experience]`,
  `[process]` — Phase 2 routes to facts / journal / craft / episodic.
- Do **not** edit `standing.md`, `MEMORY.md`, `facts/`, `journal/`, `craft/` directly.
- Phase 2 consolidation merges inbox notes into durable files.

========= MEMORY_SUMMARY BEGINS =========
{{ memory_summary }}
========= MEMORY_SUMMARY ENDS =========

When assets are likely relevant, run the quick pass before deep repo exploration.

