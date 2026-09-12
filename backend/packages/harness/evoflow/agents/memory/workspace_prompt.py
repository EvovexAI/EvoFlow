"""Prompt templates and formatters for workspace (project) memory."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from evoflow.agents.memory.prompt import _coerce_confidence, _count_tokens, _truncate_summary, format_conversation_for_update

_EPHEMERAL_PATH_MARKERS = (
    "/mnt/user-data/uploads/",
    "/mnt/user-data/outputs/",
    "<uploaded_files>",
    ".evo-flow/threads/",
    "backend/.evo-flow/threads/",
)

_EPHEMERAL_PATH_RE = re.compile(
    r"(?:"
    r"/mnt/user-data/(?:uploads|outputs)/"
    r"|\.evo-flow/threads/"
    r"|backend/\.evo-flow/threads/"
    r"|/threads/[^/\s]+/user-data/"
    r"|<uploaded_files>"
    r")",
    re.IGNORECASE,
)

_SESSION_NOISE_LINE_RE = re.compile(
    r"^\s*(?:User|Assistant):\s*.*(?:"
    r"/mnt/user-data/(?:uploads|outputs)/"
    r"|\.evo-flow/threads/"
    r"|<uploaded_files>"
    r")\s*$",
    re.IGNORECASE | re.MULTILINE,
)

WORKSPACE_BOOTSTRAP_PROMPT = """You are a codebase analyst. Build durable **project assets** for an AI coding assistant.

IMPORTANT: Generate all content in Chinese. Keep proper nouns and technical terms in their original form (EvoFlow, LangGraph, etc.).

Repository context:
<repository>
{repository_context}
</repository>

Write **Asset Hub style** notes — same as user memory/craft:
- standing: ≤400 chars project focus (what this repo is + how to work in it)
- facts: durable project points; each needs title + summary (10–30 Chinese chars) + content body
- craft (optional): reusable how-to for this repo only; name/title + description (10–30 chars) + steps

Do NOT use the old project.overview / architecture / entryPoints JSON sections.
Do NOT dump directory trees into standing.

Output JSON only:
{{
  "standing": "…≤400字…",
  "facts": [
    {{
      "title": "短标题",
      "summary": "10～30字能辨认用途",
      "category": "module|logic|architecture|convention|gotcha|entrypoint",
      "content": "正文要点…"
    }}
  ],
  "craft": [
    {{
      "title": "name-or-title",
      "description": "10～30字",
      "content": "步骤/结论…"
    }}
  ]
}}

Rules:
- Focus on **this repository root only** — do not catalog unrelated sibling folders in a monorepo unless they are direct dependencies.
- Prefer 3–8 facts covering **core modules**, **important logic**, **run/build entrypoints**, **conventions**, **gotchas**.
- Each fact needs category: module | logic | architecture | convention | gotcha | entrypoint.
- summary/description must be 10–30 characters when possible; never a long paragraph.
- Do NOT store test scripts, one-off experiments, or session changelogs.
- Do not invent paths not shown in context.
- Return ONLY valid JSON, no markdown."""


WORKSPACE_UPDATE_PROMPT = """You are a workspace asset curator. Merge **durable project knowledge** from the conversation into Asset Hub files.

IMPORTANT: Generate all content in Chinese. Keep proper nouns and technical terms in their original form.

Workspace root: {workspace_root}

Module index (hint):
{module_index}

Current catalog (title/summary only — full bodies are on disk):
{current_memory}

Conversation:
{conversation}

Output JSON only — same schema as bootstrap. Only include fields that should be written/updated:
{{
  "standing": "optional new standing ≤400字 (omit if unchanged)",
  "facts": [{{"title":"…","summary":"10～30字","content":"…"}}],
  "craft": [{{"title":"…","description":"10～30字","content":"…"}}],
  "episodes": [{{"title":"…","summary":"10～30字","content":"本轮过程回顾…"}}]
}}

Rules:
- Prefer updating standing + adding a few facts when conversation reveals **durable project structure** (not session tasks).
- Skip tests, trivial edits, greetings, and one-off debugging notes.
- Each fact needs category: module | logic | architecture | convention | gotcha | entrypoint.
- episodes only when the conversation process is worth reviewing later (rare).
- Do NOT emit legacy project.overview / architecture / layout JSON.
- summary/description: 10–30 chars; never long blurbs.
- Return ONLY valid JSON, no markdown."""

# Bootstrap one-time scan: shallow tree depth if ever needed (module index is primary).
WORKSPACE_BOOTSTRAP_TREE_DEPTH = 2
WORKSPACE_BOOTSTRAP_TREE_MAX_LINES = 60

# Legacy — directory trees are no longer persisted or passed to update/injection prompts.
WORKSPACE_UPDATE_TREE_DEPTH = 2
WORKSPACE_UPDATE_TREE_MAX_LINES = 60

_SKIP_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        ".next",
        "target",
        "logs",
        "temp",
        "outputs",
        "uploads",
    }
)

_MODULE_DOC_NAMES = ("README.md", "README", "readme.md", "ARCHITECTURE.md")
_MANIFEST_NAMES = ("pyproject.toml", "package.json", "go.mod", "Cargo.toml", "Makefile")


def is_ephemeral_workspace_path(path: str) -> bool:
    """True for session uploads, thread temp dirs, and other non-project paths."""
    p = str(path or "").strip().replace("\\", "/")
    if not p:
        return True
    lower = p.lower()
    if _EPHEMERAL_PATH_RE.search(p):
        return True
    return any(marker.lower() in lower for marker in _EPHEMERAL_PATH_MARKERS)


def normalize_workspace_relative_path(path: str, workspace_root: str) -> str:
    """Normalize to project-relative path; empty string if outside root or ephemeral."""
    raw = str(path or "").strip()
    if not raw or is_ephemeral_workspace_path(raw):
        return ""
    root = Path(workspace_root).resolve()
    candidate = Path(raw.replace("\\", "/"))
    try:
        if candidate.is_absolute():
            rel = candidate.resolve().relative_to(root)
        else:
            rel = (root / candidate).resolve().relative_to(root)
        rel_s = str(rel).replace("\\", "/").lstrip("./")
        if not rel_s or is_ephemeral_workspace_path(rel_s):
            return ""
        return rel_s
    except (OSError, ValueError):
        rel_s = raw.replace("\\", "/").lstrip("./")
        if is_ephemeral_workspace_path(rel_s):
            return ""
        return rel_s


def scrub_ephemeral_workspace_text(text: str, workspace_root: str) -> str:
    """Remove upload/thread-temp noise from conversation text before LLM."""
    del workspace_root  # reserved for future path-to-relative rewriting
    cleaned = _SESSION_NOISE_LINE_RE.sub("", str(text or ""))
    cleaned = re.sub(r"<uploaded_files>[\s\S]*?</uploaded_files>\n*", "", cleaned, flags=re.IGNORECASE)
    cleaned = _EPHEMERAL_PATH_RE.sub("[ephemeral-path]", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def format_conversation_for_workspace_update(messages: list[Any], workspace_root: str) -> str:
    """Format conversation for workspace memory LLM, with ephemeral path scrubbing."""
    base = format_conversation_for_update(messages)
    return scrub_ephemeral_workspace_text(base, workspace_root)


def strip_ephemeral_from_workspace_memory(memory_data: dict[str, Any], workspace_root: str) -> dict[str, Any]:
    """Drop ephemeral paths/facts from persisted workspace memory."""
    project = memory_data.get("project")
    if isinstance(project, dict):
        for block in project.values():
            if isinstance(block, dict) and isinstance(block.get("summary"), str):
                block["summary"] = scrub_ephemeral_workspace_text(block["summary"], workspace_root)

    facts = memory_data.get("facts")
    if isinstance(facts, list):
        kept: list[dict[str, Any]] = []
        for fact in facts:
            if not isinstance(fact, dict):
                continue
            content = str(fact.get("content") or "").strip()
            if not content or is_ephemeral_workspace_path(content):
                continue
            if is_ephemeral_workspace_fact_content(content):
                continue
            source = str(fact.get("source") or "").strip()
            if not should_persist_workspace_fact(fact, source=source or "conversation"):
                continue
            path = normalize_workspace_relative_path(str(fact.get("path") or ""), workspace_root)
            if str(fact.get("path") or "").strip() and not path:
                continue
            parent = normalize_workspace_relative_path(str(fact.get("parent") or ""), workspace_root)
            entry = dict(fact)
            if path:
                entry["path"] = path
            elif "path" in entry:
                entry.pop("path", None)
            if parent:
                entry["parent"] = parent
            elif "parent" in entry:
                entry.pop("parent", None)
            if _EPHEMERAL_PATH_RE.search(content):
                continue
            kept.append(entry)
        memory_data["facts"] = kept
    return memory_data


_PROJECT_SECTION_LABELS = {
    "overview": "Overview",
    "architecture": "Architecture",
    "entryPoints": "Entry points",
    "conventions": "Conventions",
    "gotchas": "Gotchas",
}

# Categories eligible for persistence/injection (aligned with workspace_memory_policy).
def _injectable_fact_categories() -> frozenset[str]:
    from evoflow.assets.workspace_memory_policy import WORKSPACE_FACT_CATEGORIES

    return frozenset(WORKSPACE_FACT_CATEGORIES)

_ENTRY_POINT_PATH_MARKERS = (
    "/agent.py",
    "/app.py",
    "/main.py",
    "/__main__.py",
    "readme.md",
    "makefile",
    "pyproject.toml",
    "package.json",
    "cargo.toml",
)

_EPHEMERAL_FACT_CONTENT_RE = re.compile(
    r"(?:"
    r"已重写|新增(?:了|多个)?|修改为|重构了?|本次|浮标|进度卡片|组件签名|"
    r"rewrote|rewritten|refactored|added (?:new )?(?:props?|features?|ui)|"
    r"component (?:was )?(?:rewritten|updated|refactored)"
    r")",
    re.IGNORECASE,
)


def is_ephemeral_workspace_fact_content(content: str) -> bool:
    """True when fact text looks like a session task outcome, not durable structure."""
    text = str(content or "").strip()
    if not text:
        return True
    return bool(_EPHEMERAL_FACT_CONTENT_RE.search(text))


def is_entry_point_path(path: str) -> bool:
    """True for repo entry points worth persisting as file-level facts."""
    normalized = str(path or "").strip().replace("\\", "/").lower()
    if not normalized:
        return False
    return any(marker in normalized for marker in _ENTRY_POINT_PATH_MARKERS)


def should_persist_workspace_fact(fact: dict[str, Any], *, source: str) -> bool:
    """Filter facts before persistence — drop session noise and stray file facts."""
    from evoflow.assets.workspace_memory_policy import normalize_workspace_fact_category

    content = str(fact.get("content") or "").strip()
    if not content or is_ephemeral_workspace_fact_content(content):
        return False

    raw_category = str(fact.get("category") or "module").strip().lower() or "module"
    if raw_category == "file":
        if source == "bootstrap":
            path = str(fact.get("path") or "")
            return is_entry_point_path(path)
        return False

    category = normalize_workspace_fact_category(raw_category)
    return category in _injectable_fact_categories()


def should_inject_workspace_fact(fact: dict[str, Any]) -> bool:
    """Facts eligible for ``<workspace_memory>`` injection."""
    from evoflow.assets.workspace_memory_policy import normalize_workspace_fact_category

    if not isinstance(fact, dict):
        return False
    content = str(fact.get("content") or "").strip()
    if not content or is_ephemeral_workspace_fact_content(content):
        return False
    category = normalize_workspace_fact_category(str(fact.get("category") or "module"))
    return category in _injectable_fact_categories()


def format_workspace_memory_for_injection(
    memory_data: dict[str, Any],
    max_tokens: int = 1500,
    *,
    injection_profile: str = "full",
    workspace_path: str | None = None,
) -> str:
    """Format workspace memory for ``<workspace_memory>`` injection.

    Output is a compact **project profile**: section summaries first, then module map,
    then structural facts. Raw directory trees and session file changelogs are omitted.
    """
    if not memory_data:
        return ""

    chat_compact = injection_profile == "chat_compact"
    section_cap = 360 if chat_compact else None
    min_fact_confidence = 0.72 if chat_compact else 0.0
    max_fact_lines = 6 if chat_compact else 12

    sections: list[str] = []
    running_tokens = 0

    project_data = memory_data.get("project", {})
    if isinstance(project_data, dict):
        project_lines: list[str] = []
        for kind, label in _PROJECT_SECTION_LABELS.items():
            if chat_compact and kind not in ("overview", "architecture", "entryPoints"):
                continue
            block = project_data.get(kind, {})
            if not isinstance(block, dict):
                continue
            summary = str(block.get("summary") or "").strip()
            if not summary:
                continue
            if section_cap is not None:
                summary = _truncate_summary(summary, section_cap)
            if summary:
                project_lines.append(f"{label}: {summary}")
        if project_lines:
            block = "Project profile:\n" + "\n".join(f"- {line}" for line in project_lines)
            block_tokens = _count_tokens(block)
            sections.append(block)
            running_tokens += block_tokens

    layout_data = memory_data.get("layout")
    if isinstance(layout_data, dict):
        module_summary = str((layout_data.get("moduleIndex") or {}).get("summary") or "").strip()

        if not module_summary and workspace_path:
            snapshot = build_workspace_layout_snapshot(workspace_path)
            module_summary = str(snapshot.get("moduleIndex") or "").strip()

        if module_summary:
            block = f"Top-level modules:\n{module_summary}"
            block_tokens = _count_tokens("\n\n" + block) if sections else _count_tokens(block)
            if running_tokens + block_tokens <= max_tokens:
                sections.append(block)
                running_tokens += block_tokens

    facts_data = memory_data.get("facts", [])
    if isinstance(facts_data, list) and facts_data:
        ranked_facts = sorted(
            (
                f
                for f in facts_data
                if isinstance(f, dict)
                and should_inject_workspace_fact(f)
                and isinstance(f.get("content"), str)
                and f.get("content").strip()
            ),
            key=lambda fact: _coerce_confidence(fact.get("confidence"), default=0.0),
            reverse=True,
        )
        if chat_compact:
            ranked_facts = [f for f in ranked_facts if _coerce_confidence(f.get("confidence"), default=0.0) >= min_fact_confidence]

        facts_header = "Key modules & interfaces:\n"
        separator_tokens = _count_tokens("\n\n" + facts_header) if sections else _count_tokens(facts_header)
        running_tokens += separator_tokens

        fact_lines: list[str] = []
        for fact in ranked_facts:
            if len(fact_lines) >= max_fact_lines:
                break
            content = str(fact.get("content") or "").strip()
            path = str(fact.get("path") or "").strip()
            if path:
                line = f"- `{path}` — {content}"
            else:
                line = f"- {content}"

            line_text = ("\n" + line) if fact_lines else line
            line_tokens = _count_tokens(line_text)
            if running_tokens + line_tokens <= max_tokens:
                fact_lines.append(line)
                running_tokens += line_tokens
            else:
                break

        if fact_lines:
            sections.append(facts_header + "\n".join(fact_lines))

    if not sections:
        return ""

    result = "\n\n".join(sections)
    token_count = _count_tokens(result)
    if token_count > max_tokens:
        char_per_token = len(result) / token_count if token_count else 4
        target_chars = int(max_tokens * char_per_token * 0.95)
        result = result[:target_chars] + "\n..."

    return result


def build_workspace_layout_snapshot(workspace_path: str) -> dict[str, str]:
    """Build top-level module map for persistence and model injection."""
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {}

    module_index = build_workspace_module_index(str(root))
    if not module_index.strip():
        return {}
    return {"moduleIndex": module_index}


def format_workspace_module_index_for_update(workspace_path: str) -> str:
    """Module map passed to the workspace memory update LLM (not a deep directory tree)."""
    return build_workspace_module_index(workspace_path)


def collect_repository_context(root_path: str, *, max_readme_chars: int = 8000) -> str:
    """Gather README, manifests, module index, and directory tree for bootstrap."""
    root = Path(root_path).resolve()
    if not root.is_dir():
        return ""

    parts: list[str] = [f"Root: {root}"]

    module_index = build_workspace_module_index(str(root))
    if module_index.strip():
        parts.append(module_index)

    module_docs = collect_module_documentation(str(root))
    if module_docs.strip():
        parts.append(module_docs)

    for name in ("README.md", "README", "README.MD", "readme.md"):
        readme = root / name
        if readme.is_file():
            try:
                text = readme.read_text(encoding="utf-8", errors="replace")
                if len(text) > max_readme_chars:
                    text = text[: max_readme_chars - 3] + "..."
                parts.append(f"## Root {name}\n{text}")
            except OSError:
                pass
            break

    for manifest in _MANIFEST_NAMES:
        mf = root / manifest
        if mf.is_file():
            try:
                text = mf.read_text(encoding="utf-8", errors="replace")
                if len(text) > 4000:
                    text = text[:3997] + "..."
                parts.append(f"## Root {manifest}\n{text}")
            except OSError:
                pass

    return "\n\n".join(parts)


def collect_module_documentation(
    root_path: str,
    *,
    max_doc_chars: int = 2500,
    max_modules: int = 14,
) -> str:
    """Collect README/ARCHITECTURE excerpts from root and top-level subdirectories."""
    root = Path(root_path).resolve()
    if not root.is_dir():
        return ""

    sections: list[str] = ["## Module documentation excerpts"]
    seen_paths: set[str] = set()

    for scan_dir in _iter_workspace_scan_dirs(root)[: max_modules + 1]:
        rel_prefix = "." if scan_dir == root else scan_dir.relative_to(root).as_posix()
        for doc_name in _MODULE_DOC_NAMES:
            doc_path = scan_dir / doc_name
            key = doc_path.as_posix()
            if key in seen_paths or not doc_path.is_file():
                continue
            excerpt = _read_text_excerpt(doc_path, max_doc_chars)
            if not excerpt.strip():
                continue
            seen_paths.add(key)
            label = f"{rel_prefix}/{doc_name}" if rel_prefix != "." else doc_name
            sections.append(f"### {label}\n{excerpt}")

        for manifest in _MANIFEST_NAMES:
            mf_path = scan_dir / manifest
            key = mf_path.as_posix()
            if key in seen_paths or not mf_path.is_file():
                continue
            excerpt = _read_text_excerpt(mf_path, 1200)
            if not excerpt.strip():
                continue
            seen_paths.add(key)
            label = f"{rel_prefix}/{manifest}" if rel_prefix != "." else manifest
            sections.append(f"### {label}\n{excerpt}")

    if len(sections) == 1:
        return ""
    return "\n\n".join(sections)


def build_workspace_module_index(root_path: str, *, max_modules: int = 20) -> str:
    """Deterministic top-level module map derived from directory layout."""
    root = Path(root_path).resolve()
    if not root.is_dir():
        return ""

    top_dirs, top_files = _list_top_level_entries(root)
    lines = [
        "## Module index (auto scan)",
        f"Top-level directories ({len(top_dirs)}): {', '.join(top_dirs) if top_dirs else '(none)'}",
    ]
    if top_files:
        lines.append(f"Top-level files: {', '.join(top_files[:16])}")
    lines.append("")

    for scan_dir in _iter_workspace_scan_dirs(root)[1 : max_modules + 1]:
        rel = scan_dir.relative_to(root).as_posix()
        markers = _detect_package_markers(scan_dir)
        subdirs = _list_immediate_subdirs(scan_dir)
        role_hint = _infer_module_role_hint(scan_dir)

        lines.append(f"### module {rel}/")
        if role_hint:
            lines.append(f"- Summary: {role_hint}")
        if markers:
            lines.append(f"- Package markers: {', '.join(markers)}")
        if subdirs:
            lines.append(f"- Subdirs: {', '.join(subdirs)}")
        lines.append("")

    return "\n".join(lines).strip()


def extract_deterministic_module_facts(workspace_path: str, *, max_modules: int = 20) -> list[dict[str, Any]]:
    """Build high-confidence module facts from directory scan (no LLM)."""
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return []

    facts: list[dict[str, Any]] = []
    for scan_dir in _iter_workspace_scan_dirs(root)[1 : max_modules + 1]:
        rel = scan_dir.relative_to(root).as_posix()
        markers = _detect_package_markers(scan_dir)
        subdirs = _list_immediate_subdirs(scan_dir, limit=8)
        role_hint = _infer_module_role_hint(scan_dir)

        parts = [f"顶层模块 `{rel}/`"]
        if role_hint:
            parts.append(role_hint)
        if markers:
            parts.append(f"包标识: {', '.join(markers)}")
        if subdirs:
            parts.append(f"主要子目录: {', '.join(subdirs)}")

        facts.append(
            {
                "content": "；".join(parts),
                "category": "module",
                "confidence": 0.88,
                "path": rel,
            }
        )
    return facts


def _iter_workspace_scan_dirs(root: Path) -> list[Path]:
    """Root plus top-level subdirectories worth scanning."""
    dirs = [root]
    try:
        for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if not entry.is_dir():
                continue
            if entry.name.startswith(".") and entry.name not in (".github", ".evo-flow"):
                continue
            if entry.name in _SKIP_DIRS:
                continue
            dirs.append(entry)
    except OSError:
        pass
    return dirs


def _list_top_level_entries(root: Path) -> tuple[list[str], list[str]]:
    top_dirs: list[str] = []
    top_files: list[str] = []
    try:
        for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if entry.name.startswith(".") and entry.name not in (".github",):
                continue
            if entry.is_dir():
                if entry.name in _SKIP_DIRS:
                    continue
                top_dirs.append(f"{entry.name}/")
            elif entry.is_file():
                top_files.append(entry.name)
    except OSError:
        pass
    return top_dirs, top_files


def _list_immediate_subdirs(dir_path: Path, *, limit: int = 12) -> list[str]:
    names: list[str] = []
    try:
        for entry in sorted(dir_path.iterdir(), key=lambda p: p.name.lower()):
            if not entry.is_dir():
                continue
            if entry.name.startswith(".") and entry.name not in (".github", ".evo-flow"):
                continue
            if entry.name in _SKIP_DIRS:
                continue
            names.append(f"{entry.name}/")
            if len(names) >= limit:
                break
    except OSError:
        pass
    return names


def _detect_package_markers(dir_path: Path) -> list[str]:
    found: list[str] = []
    for name in _MANIFEST_NAMES:
        if (dir_path / name).is_file():
            found.append(name)

    try:
        for sub in sorted(dir_path.iterdir(), key=lambda p: p.name.lower()):
            if not sub.is_dir() or sub.name in _SKIP_DIRS:
                continue
            for name in _MANIFEST_NAMES:
                marker = f"{sub.name}/{name}"
                if (sub / name).is_file() and marker not in found:
                    found.append(marker)
            if len(found) >= 8:
                break
    except OSError:
        pass
    return found


def _read_text_excerpt(path: Path, max_chars: int) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""
    if len(text) > max_chars:
        return text[: max_chars - 3] + "..."
    return text


def _infer_module_role_hint(dir_path: Path) -> str:
    for doc_name in _MODULE_DOC_NAMES:
        doc_path = dir_path / doc_name
        if not doc_path.is_file():
            continue
        try:
            text = doc_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        hint = _first_meaningful_doc_line(text)
        if hint:
            return hint
    return ""


def _first_meaningful_doc_line(text: str) -> str:
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("!["):
            continue
        if line.startswith("<") and line.endswith(">"):
            continue
        if line.startswith("#"):
            line = line.lstrip("#").strip()
        line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)
        line = re.sub(r"[*_`]", "", line).strip()
        if len(line) >= 8:
            return line[:220]
    return ""


def format_workspace_directory_outline(
    workspace_path: str,
    *,
    depth: int = WORKSPACE_UPDATE_TREE_DEPTH,
    max_lines: int | None = None,
) -> str:
    """Compact project directory tree (full relative paths from workspace root)."""
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return "(invalid workspace path)"
    depth = max(1, min(int(depth), 5))
    if max_lines is None:
        max_lines = WORKSPACE_BOOTSTRAP_TREE_MAX_LINES if depth > WORKSPACE_UPDATE_TREE_DEPTH else WORKSPACE_UPDATE_TREE_MAX_LINES
    tree = _directory_tree_summary(root, depth=depth, max_lines=max_lines)
    if not tree.strip():
        return "(empty)"
    return f"project={root.name}\nroot={root}\ndepth={depth}\n{tree}"


def _directory_tree_summary(root: Path, depth: int = 3, *, max_lines: int = WORKSPACE_UPDATE_TREE_MAX_LINES) -> str:
    lines: list[str] = [f"{root.name}/"]

    def walk(dir_path: Path, level: int) -> None:
        if level > depth or len(lines) >= max_lines:
            return
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for entry in entries:
            if len(lines) >= max_lines:
                break
            if entry.name.startswith(".") and entry.name not in (".github", ".evo-flow"):
                if entry.is_dir():
                    continue
            try:
                rel = entry.relative_to(root).as_posix()
            except ValueError:
                rel = entry.name
            if entry.is_dir() and entry.name in _SKIP_DIRS:
                lines.append(f"{rel}/ (skipped)")
                continue
            if entry.is_dir():
                lines.append(f"{rel}/")
                walk(entry, level + 1)
            else:
                lines.append(rel)

    walk(root, 1)
    if len(lines) >= max_lines:
        lines = lines[:max_lines] + ["... (truncated)"]
    return "\n".join(lines) if lines else "(empty)"
