"""Structured task deliverables (``outputs``) shared by main tasks and subtasks.

Any Task row may carry:

- ``summary`` — free-text handoff narrative
- ``outputs`` — list of typed key/value deliverables

Legacy ``evidence_paths`` (subtask worker_profile / outcome meta) maps to
``type=file`` outputs for read paths.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

OUTPUT_TYPES = frozenset({"file", "url", "text", "other"})
_OUTPUT_MAX_ITEMS = 40
_KEY_MAX = 64
_VALUE_MAX = 4000
_LABEL_MAX = 200

# Agents sometimes emit pseudo-JSON like:
#   [{docs/a.md,label:报告}]
# or a bare value:
#   docs/a.md,label:报告}]
# or an unquoted object blob:
#   type:file,key:报告,value:docs/a.md
_PATH_LABEL_RE = re.compile(
    r"(?P<path>"
    r"(?:docs|evoflow|outputs|backend|evopanel|frontend)/[^\s,\]\}]+?"
    r"|(?:[^\s,\]\}]+/)*[^\s,\]\}]+"
    r")"
    r"\.(?P<ext>md|html?|pdf|json|ya?ml|tsx?|jsx?|py|css|txt|csv)"
    r"(?:\s*,\s*label\s*[:=]\s*(?P<label>[^,\}\]]+))?",
    re.IGNORECASE,
)
_LABEL_SUFFIX_RE = re.compile(r",\s*label\s*[:=]\s*(.+)$", re.IGNORECASE)
# Accept both ``type:file`` and JSON-ish ``"type": "file"`` blobs agents often emit.
_KV_FIELD_RE = re.compile(
    r"[\"']?(?P<field>type|key|name|value|path|url|content|label|title)[\"']?\s*[:=]\s*"
    r"[\"']?(?P<val>[^,\"'\]\}]+)[\"']?",
    re.IGNORECASE,
)
_KV_BLOB_HINT_RE = re.compile(
    r"(?i)(?:^|[,{\s])[\"']?(?:type|key|value|path|url|label)[\"']?\s*[:=]",
)
_FILE_EXT_RE = re.compile(
    r"\.(md|html?|pdf|json|ya?ml|tsx?|jsx?|py|css|txt|csv)$",
    re.IGNORECASE,
)


def normalize_output_type(raw: Any) -> str:
    t = str(raw or "").strip().lower()
    if t in OUTPUT_TYPES:
        return t
    if t in {"path", "filepath", "artifact", "doc", "document"}:
        return "file"
    if t in {"link", "uri", "href"}:
        return "url"
    if t in {"note", "string", "markdown", "md"}:
        return "text"
    return "other"


def _strip_wrapping_brackets(text: str) -> str:
    s = str(text or "").strip()
    while len(s) >= 2 and (
        (s[0] == "[" and s[-1] == "]")
        or (s[0] == "{" and s[-1] == "}")
        or (s[0] == "(" and s[-1] == ")")
    ):
        s = s[1:-1].strip()
    # Leftover trailing junk from ``…}]`` when opening `[` was already stripped.
    while s.endswith("]") or s.endswith("}"):
        s = s[:-1].rstrip()
    while s.startswith("[") or s.startswith("{"):
        s = s[1:].lstrip()
    return s


def _clean_field_token(raw: str) -> str:
    s = str(raw or "").strip().strip("'\"")
    while s.endswith("]") or s.endswith("}"):
        s = s[:-1].rstrip()
    return s.strip()


def split_path_label_suffix(value: str) -> tuple[str, str]:
    """Repair agent typos like ``path.md,label:标题}]`` → ``(path.md, 标题)``."""
    s = _strip_wrapping_brackets(value)
    if not s:
        return "", ""
    m = _LABEL_SUFFIX_RE.search(s)
    if not m:
        return s, ""
    path = s[: m.start()].strip().strip("'\"")
    label = m.group(1).strip().strip("'\"")
    # Drop trailing brackets still stuck to the label.
    while label.endswith("]") or label.endswith("}"):
        label = label[:-1].rstrip()
    return path, label


def parse_output_kv_blob(text: str) -> dict[str, str]:
    """Parse ``type:file,key:x,value:path.md[,label:标题]`` style blobs.

    Also accepts JSON-ish agent typos: ``"type": "file", "value": "outputs/a.md"``.
    """
    s = _strip_wrapping_brackets(text)
    if not s or not _KV_FIELD_RE.search(s):
        return {}
    # Must look like a key/value blob, not a normal path that happens to contain ``:``.
    if not _KV_BLOB_HINT_RE.search(s):
        return {}
    out: dict[str, str] = {}
    for m in _KV_FIELD_RE.finditer(s):
        field = m.group("field").lower()
        if field == "name":
            field = "key"
        elif field == "title":
            field = "label"
        elif field in {"path", "url", "content"}:
            # Prefer explicit value= when present; otherwise accept path/url/content.
            if "value" in out:
                continue
            field = "value"
        out[field] = _clean_field_token(m.group("val"))
    return out


def _split_concatenated_output_blobs(text: str) -> list[str]:
    """Split ``{...}, {...}`` / bare object concatenations into chunks."""
    raw = str(text or "").strip()
    if not raw:
        return []
    # Common agent mistake: one string containing several pseudo-objects.
    parts = re.split(r"\}\s*,\s*\{", raw)
    if len(parts) <= 1:
        return [raw]
    out: list[str] = []
    for i, part in enumerate(parts):
        chunk = part.strip()
        if i > 0 and not chunk.startswith("{"):
            chunk = "{" + chunk
        if i < len(parts) - 1 and not chunk.endswith("}"):
            chunk = chunk + "}"
        out.append(chunk)
    return out


def extract_output_path_fields(value: str) -> tuple[str, str, str]:
    """Return ``(path, label, key)`` from a clean path or agent typo blob."""
    s = _strip_wrapping_brackets(value)
    if not s:
        return "", "", ""

    kv = parse_output_kv_blob(s)
    if kv.get("value"):
        path = kv["value"].replace("\\", "/")
        label = kv.get("label", "")
        key = kv.get("key", "")
        nested_path, nested_label = split_path_label_suffix(path)
        if nested_path:
            path = nested_path
        if not label and nested_label:
            label = nested_label
        return path, label, key

    path, label = split_path_label_suffix(s)
    if path and (
        "/" in path
        or _FILE_EXT_RE.search(path)
        or path.startswith("http://")
        or path.startswith("https://")
    ):
        # Reject values that are still clearly kv blobs without a usable path.
        if parse_output_kv_blob(path) and not _FILE_EXT_RE.search(path) and "/" not in path:
            pass
        else:
            if not path.lower().startswith("type:"):
                return path, label, ""

    m = _PATH_LABEL_RE.search(s)
    if m:
        found = f"{m.group('path')}.{m.group('ext')}".replace("\\", "/")
        found = found.strip().strip("'\"")
        found_label = _clean_field_token(m.group("label") or "") or label
        return found, found_label, ""

    return path, label, ""


def coerce_outputs_from_messy_text(text: str) -> list[dict[str, str]]:
    """Best-effort parse when ``--outputs`` is not valid JSON."""
    raw = str(text or "").strip()
    if not raw:
        return []

    chunks = _split_concatenated_output_blobs(raw)
    collected: list[dict[str, str]] = []
    for chunk in chunks:
        kv = parse_output_kv_blob(chunk)
        if kv.get("value"):
            path, label, key = extract_output_path_fields(chunk)
            if path:
                item: dict[str, str] = {
                    "type": normalize_output_type(kv.get("type") or "file"),
                    "key": (key or kv.get("key") or "artifact")[:_KEY_MAX],
                    "value": path[:_VALUE_MAX],
                }
                use_label = label or kv.get("label") or ""
                if use_label:
                    item["label"] = use_label[:_LABEL_MAX]
                collected.append(item)
                continue
        for m in _PATH_LABEL_RE.finditer(chunk):
            path = f"{m.group('path')}.{m.group('ext')}".replace("\\", "/").strip().strip("'\"")
            if not path:
                continue
            item = {
                "type": "file",
                "key": "artifact",
                "value": path[:_VALUE_MAX],
            }
            label = _clean_field_token(m.group("label") or "")
            if label:
                item["label"] = label[:_LABEL_MAX]
            collected.append(item)

    if collected:
        out: list[dict[str, str]] = []
        for i, item in enumerate(collected):
            row = dict(item)
            if row.get("key") in {"", "artifact"}:
                row["key"] = f"artifact_{i + 1}"
            out.append(row)
        return out

    found: list[dict[str, str]] = []
    seen: set[str] = set()
    for m in _PATH_LABEL_RE.finditer(raw):
        path = f"{m.group('path')}.{m.group('ext')}".replace("\\", "/")
        path = path.strip().strip("'\"")
        if not path or path in seen:
            continue
        seen.add(path)
        item = {
            "type": "file",
            "key": f"artifact_{len(found) + 1}",
            "value": path[:_VALUE_MAX],
        }
        label = _clean_field_token(m.group("label") or "")
        if label:
            item["label"] = label[:_LABEL_MAX]
        found.append(item)
    if found:
        return found
    path, label, key = extract_output_path_fields(raw)
    if not path:
        return []
    item = {
        "type": "file",
        "key": (key or "artifact")[:_KEY_MAX],
        "value": path[:_VALUE_MAX],
    }
    if label:
        item["label"] = label[:_LABEL_MAX]
    return [item]


def normalize_task_output(item: Any, *, default_key: str = "artifact") -> dict[str, str] | None:
    """Normalize one output item to ``{type, key, value, label?}``."""
    if item is None:
        return None
    if isinstance(item, str):
        value = item.strip()
        if not value:
            return None
        from evoflow.collab.workflow_handoff_sanitize import sanitize_output_value_field

        value = sanitize_output_value_field(value)
        repaired = coerce_outputs_from_messy_text(value)
        if repaired:
            # Caller that needs multi-items should use normalize_task_outputs.
            return repaired[0]
        path, label, key = extract_output_path_fields(value)
        if not path:
            return None
        out: dict[str, str] = {
            "type": "file",
            "key": (key or default_key)[:_KEY_MAX],
            "value": path[:_VALUE_MAX],
        }
        if label:
            out["label"] = label[:_LABEL_MAX]
        return out
    if not isinstance(item, dict):
        return None
    value = str(item.get("value") or item.get("path") or item.get("url") or item.get("content") or "").strip()
    if not value:
        return None
    from evoflow.collab.workflow_handoff_sanitize import sanitize_output_value_field

    value = sanitize_output_value_field(value)
    # Nested JSON-ish blob inside value → extract clean path/label/key.
    if parse_output_kv_blob(value) or "}, {" in value or '"}, {"' in value:
        repaired = coerce_outputs_from_messy_text(value)
        if repaired:
            first = dict(repaired[0])
            # Keep outer key/label when inner blob didn't supply them.
            outer_key = str(item.get("key") or item.get("name") or "").strip()
            outer_label = str(item.get("label") or item.get("title") or "").strip()
            if outer_key and (
                not first.get("key")
                or str(first.get("key") or "").startswith("artifact")
            ):
                first["key"] = outer_key[:_KEY_MAX]
            if outer_label and not first.get("label"):
                first["label"] = outer_label[:_LABEL_MAX]
            first["type"] = normalize_output_type(item.get("type") or first.get("type"))
            return first
    key = str(item.get("key") or item.get("name") or default_key).strip() or default_key
    label = str(item.get("label") or item.get("title") or "").strip()
    path, suffix_label, suffix_key = extract_output_path_fields(value)
    if path:
        value = path
    if not label and suffix_label:
        label = suffix_label
    if suffix_key and key.startswith("artifact"):
        key = suffix_key
    out = {
        "type": normalize_output_type(item.get("type")),
        "key": key[:_KEY_MAX],
        "value": value[:_VALUE_MAX],
    }
    if label:
        out["label"] = label[:_LABEL_MAX]
    return out


def normalize_task_outputs(raw: Any) -> list[dict[str, str]]:
    """Normalize a list/JSON string of outputs; drops invalids; caps length."""
    if raw is None:
        return []
    items = raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            items = json.loads(text)
        except Exception:
            # Coerce agent pseudo-JSON / kv blobs / label typos.
            if (
                "[" in text
                or "]" in text
                or _LABEL_SUFFIX_RE.search(text)
                or parse_output_kv_blob(text)
                or _PATH_LABEL_RE.search(text)
            ):
                repaired = coerce_outputs_from_messy_text(text)
                if repaired:
                    return normalize_task_outputs(repaired)
            one = normalize_task_output(text)
            return [one] if one else []
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        return []
    out: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for i, item in enumerate(items):
        if len(out) >= _OUTPUT_MAX_ITEMS:
            break
        # One dict whose value concatenates several blobs → expand.
        if isinstance(item, dict):
            value = str(item.get("value") or "").strip()
            if value and (
                "}, {" in value
                or '"}, {"' in value
                or value.count('"value"') > 1
                or value.count("value:") > 1
            ):
                repaired = coerce_outputs_from_messy_text(value)
                if len(repaired) > 1:
                    for j, rep in enumerate(repaired):
                        if len(out) >= _OUTPUT_MAX_ITEMS:
                            break
                        normalized = normalize_task_output(
                            rep, default_key=f"artifact_{i + 1}_{j + 1}"
                        )
                        if not normalized:
                            continue
                        sig = (normalized["type"], normalized["key"], normalized["value"])
                        if sig in seen:
                            continue
                        seen.add(sig)
                        out.append(normalized)
                    continue
        normalized = normalize_task_output(item, default_key=f"artifact_{i + 1}")
        if not normalized:
            continue
        sig = (normalized["type"], normalized["key"], normalized["value"])
        if sig in seen:
            continue
        seen.add(sig)
        out.append(normalized)
    return out


def outputs_from_evidence_paths(paths: Any) -> list[dict[str, str]]:
    """Map legacy ``evidence_paths`` string list → ``type=file`` outputs."""
    if not isinstance(paths, list):
        return []
    items = []
    for i, p in enumerate(paths):
        path = str(p or "").strip()
        if not path:
            continue
        items.append({"type": "file", "key": f"file_{i + 1}", "value": path})
    return normalize_task_outputs(items)


def evidence_paths_from_outputs(outputs: Any) -> list[str]:
    """Derive legacy path list from file-typed outputs (backward compat)."""
    paths: list[str] = []
    for item in normalize_task_outputs(outputs):
        if item.get("type") == "file":
            v = str(item.get("value") or "").strip()
            if v and v not in paths:
                paths.append(v)
    return paths


def merge_task_outputs(*parts: Any) -> list[dict[str, str]]:
    """Concatenate and re-normalize several output sources."""
    merged: list[Any] = []
    for part in parts:
        if part is None:
            continue
        if isinstance(part, list):
            merged.extend(part)
        else:
            merged.append(part)
    return normalize_task_outputs(merged)


def is_absolute_output_path(value: str) -> bool:
    """True for OS absolute paths (POSIX / Windows) or URL-like values."""
    s = str(value or "").strip().strip("'\"")
    if not s:
        return False
    low = s.lower()
    if low.startswith(("http://", "https://", "file:", "data:")):
        return True
    try:
        return Path(s).is_absolute()
    except Exception:
        return False


def _has_dir_component(path: str) -> bool:
    s = str(path or "").replace("\\", "/")
    return "/" in s.strip("/")


def _unique_rglob_file(base: Path, name: str, *, max_hits: int = 8) -> Path | None:
    """Return a single file match under ``base`` named ``name``, if unambiguous."""
    if not name or not base.is_dir():
        return None
    hits: list[Path] = []
    try:
        for p in base.rglob(name):
            if not p.is_file():
                continue
            hits.append(p)
            if len(hits) > max_hits:
                return None
    except OSError:
        return None
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        # Prefer shorter path (usually the intended docs/roles/… hit).
        hits.sort(key=lambda p: (len(p.parts), str(p)))
        return hits[0]
    return None


def _path_as_str(path: Path) -> str:
    """Stringify a path without ``Path.resolve()``.

    On Windows, ``resolve()`` walks reparse points via ``_readlink_deep`` and can
    stall the Gateway thread pool (hang dumps show ``tasks`` list stuck there),
    which starves the asyncio loop and looks like a system-wide deadlock.
    """
    try:
        return os.path.normpath(os.path.abspath(str(path)))
    except OSError:
        return str(path)


def absolutize_file_path(
    value: str,
    workspace_root: str | None,
    *,
    agent_code: str | None = None,
) -> str:
    """Join a relative file path onto ``workspace_root``; leave abs/URLs alone.

    Bare basenames that are missing at ``<workspace>/<name>`` are resolved under
    ``docs/roles/<agent_code>`` (then ``docs/roles``) when a unique match exists.
    When ``workspace_root`` is empty, still try common local roots (cwd/outputs…).
    """
    raw = str(value or "").strip().strip("'\"")
    root = str(workspace_root or "").strip().strip("'\"")
    if not raw:
        return raw
    if is_absolute_output_path(raw):
        return raw

    rel = raw.replace("\\", "/")
    candidates: list[Path] = []
    if root:
        try:
            candidates.append(Path(root).joinpath(rel))
        except Exception:
            candidates.append(Path(os.path.normpath(os.path.join(root, rel.replace("/", os.sep)))))
    # Fallback roots for unattended app runs (no role workspace bound).
    cwd = Path.cwd()
    candidates.extend(
        [
            cwd / rel,
            cwd / "outputs" / Path(rel).name,
            cwd.parent / "demos" / "ops-copy-workflows" / "runs" / "workspace" / rel,
            cwd / "demos" / "ops-copy-workflows" / "runs" / "workspace" / rel,
        ]
    )
    for cand in candidates:
        try:
            if cand.exists():
                return _path_as_str(cand)
        except OSError:
            continue

    if root:
        try:
            joined = Path(root).joinpath(rel)
        except Exception:
            joined = Path(os.path.normpath(os.path.join(root, rel.replace("/", os.sep))))

        # Basename-only + missing at workspace root → locate under role docs.
        name = Path(rel).name
        code = str(agent_code or "").strip()
        search_bases: list[Path] = []
        root_p = Path(root)
        if code:
            search_bases.append(root_p / "docs" / "roles" / code)
        search_bases.append(root_p / "docs" / "roles")
        for base in search_bases:
            hit = _unique_rglob_file(base, name)
            if hit is not None:
                return _path_as_str(hit)
        # Prefer an existing candidate even when a workspace root was provided
        # (wrong/stale root must not win over a real file under demos/cwd).
        try:
            if joined.exists():
                return _path_as_str(joined)
        except OSError:
            pass
        return _path_as_str(joined)

    # No workspace — return first candidate path (even if missing) for UI display.
    return _path_as_str(candidates[0]) if candidates else raw


def absolutize_task_outputs(
    raw: Any,
    workspace_root: str | None,
    *,
    types: frozenset[str] | None = None,
    agent_code: str | None = None,
) -> list[dict[str, str]]:
    """Return normalized outputs with ``file`` (default) paths made absolute."""
    items = normalize_task_outputs(raw)
    if not items:
        return items
    want = types or frozenset({"file", "other"})
    out: list[dict[str, str]] = []
    for item in items:
        row = dict(item)
        typ = normalize_output_type(row.get("type"))
        if typ in want:
            row["value"] = absolutize_file_path(
                str(row.get("value") or ""),
                workspace_root,
                agent_code=agent_code,
            )[:_VALUE_MAX]
        out.append(row)
    return out


def absolutize_handlers_paths(
    handlers: list[dict[str, Any]] | None,
    workspace_root: str | None,
    *,
    agent_code: str | None = None,
) -> list[dict[str, Any]]:
    """Absolutize each handler's ``read_outputs`` file paths."""
    if not handlers:
        return []
    root = str(workspace_root or "").strip()
    out: list[dict[str, Any]] = []
    for h in handlers:
        if not isinstance(h, dict):
            continue
        row = dict(h)
        if root:
            row["read_outputs"] = absolutize_task_outputs(
                row.get("read_outputs"),
                root,
                agent_code=agent_code,
            )
        else:
            row["read_outputs"] = normalize_task_outputs(row.get("read_outputs"))
        out.append(row)
    return out


def workspace_root_for_agent(agent_code: str | None) -> str:
    """Look up proactive role ``workspace_path`` for an agent_code."""
    code = str(agent_code or "").strip()
    if not code or code.lower() in {"user", "system"}:
        return ""
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
    except Exception:
        return ""
    if role is None:
        return ""
    return str(getattr(role.config, "workspace_path", None) or "").strip()


def workspace_root_for_task_row(row: dict[str, Any] | None) -> str:
    """Prefer explicit task workspace; then assignee / raised_by role workspace."""
    if not isinstance(row, dict):
        return ""
    explicit = str(row.get("workspace_root") or row.get("local_workspace_root") or "").strip()
    if explicit:
        return explicit
    for key in ("assigned_to", "raised_by"):
        ws = workspace_root_for_agent(str(row.get(key) or "").strip())
        if ws:
            return ws
    return ""


def agent_code_for_task_row(row: dict[str, Any] | None) -> str:
    """Assignee preferred for path search under docs/roles/<code>."""
    if not isinstance(row, dict):
        return ""
    for key in ("assigned_to", "raised_by"):
        code = str(row.get(key) or "").strip()
        if code and code.lower() not in {"user", "system"}:
            return code
    return ""


def task_outputs_of(
    row: dict[str, Any] | None,
    *,
    absolutize: bool = True,
) -> list[dict[str, str]]:
    """Prefer ``outputs``; fall back to ``evidence_paths`` / worker_profile paths.

    File paths are absolutized against the role workspace when possible so UIs
    can open them without guessing a root. Pass ``absolutize=False`` for bulk
    list paths (agent ``tasks`` tool / CLI) to avoid filesystem walks.
    """
    if not isinstance(row, dict):
        return []
    direct = normalize_task_outputs(row.get("outputs"))
    if not direct:
        paths = row.get("evidence_paths")
        if isinstance(paths, list) and paths:
            direct = outputs_from_evidence_paths(paths)
        else:
            wp = row.get("worker_profile")
            if isinstance(wp, dict):
                wp_paths = wp.get("evidence_paths")
                if isinstance(wp_paths, list) and wp_paths:
                    direct = outputs_from_evidence_paths(wp_paths)
    if not direct:
        return []
    if not absolutize:
        return direct
    return absolutize_task_outputs(
        direct,
        workspace_root_for_task_row(row),
        agent_code=agent_code_for_task_row(row),
    )


def normalize_task_input_refs(raw: Any) -> list[dict[str, str]]:
    """Normalize upstream read-refs (same item schema as ``outputs``)."""
    return normalize_task_outputs(raw)


def task_input_refs_of(
    row: dict[str, Any] | None,
    *,
    absolutize: bool = True,
) -> list[dict[str, str]]:
    """Upstream artifacts this task should read (not this task's own deliverables)."""
    if not isinstance(row, dict):
        return []
    refs = normalize_task_input_refs(row.get("input_refs"))
    if not refs:
        return []
    if not absolutize:
        return refs
    return absolutize_task_outputs(
        refs,
        workspace_root_for_task_row(row),
        agent_code=agent_code_for_task_row(row),
    )

# Source / binary code — never push these on Feishu approval cards.
_CODE_EXTS = frozenset(
    {
        ".py",
        ".pyi",
        ".pyw",
        ".rs",
        ".go",
        ".java",
        ".kt",
        ".kts",
        ".c",
        ".cc",
        ".cpp",
        ".cxx",
        ".h",
        ".hpp",
        ".hxx",
        ".cs",
        ".swift",
        ".m",
        ".mm",
        ".rb",
        ".php",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".vue",
        ".svelte",
        ".scala",
        ".clj",
        ".ex",
        ".exs",
        ".erl",
        ".hs",
        ".lua",
        ".r",
        ".pl",
        ".pm",
        ".sh",
        ".bash",
        ".zsh",
        ".ps1",
        ".bat",
        ".cmd",
        ".sql",
        ".wasm",
        ".so",
        ".dll",
        ".dylib",
        ".o",
        ".a",
        ".class",
        ".jar",
        ".lock",
    }
)

_SHAREABLE_FILE_EXTS = frozenset(
    {
        ".md",
        ".markdown",
        ".txt",
        ".pdf",
        ".html",
        ".htm",
        ".csv",
        ".tsv",
        ".json",
        ".yaml",
        ".yml",
        ".docx",
        ".doc",
        ".xlsx",
        ".xls",
        ".pptx",
        ".ppt",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".svg",
        ".mp4",
        ".webm",
        ".mp3",
        ".wav",
    }
)


def is_code_output_path(value: str) -> bool:
    """True if path looks like source/binary code (do not push to Feishu)."""
    from pathlib import PurePosixPath

    name = str(value or "").strip().replace("\\", "/").split("?")[0]
    if not name:
        return False
    ext = PurePosixPath(name).suffix.lower()
    return bool(ext) and ext in _CODE_EXTS


def shareable_approval_outputs(raw: Any, *, max_items: int = 12) -> list[dict[str, str]]:
    """Filter task ``outputs`` for Feishu approval: docs/media/urls, never code."""
    out: list[dict[str, str]] = []
    for item in normalize_task_outputs(raw):
        typ = normalize_output_type(item.get("type"))
        value = str(item.get("value") or "").strip()
        if not value or is_code_output_path(value):
            continue
        if typ == "file":
            from pathlib import PurePosixPath

            ext = PurePosixPath(value.replace("\\", "/").split("?")[0]).suffix.lower()
            if ext and ext not in _SHAREABLE_FILE_EXTS:
                continue
        elif typ not in {"url", "text", "other", "file"}:
            continue
        out.append(item)
        if len(out) >= max(1, int(max_items or 12)):
            break
    return out


__all__ = [
    "OUTPUT_TYPES",
    "normalize_output_type",
    "split_path_label_suffix",
    "parse_output_kv_blob",
    "extract_output_path_fields",
    "coerce_outputs_from_messy_text",
    "normalize_task_output",
    "normalize_task_outputs",
    "normalize_task_input_refs",
    "outputs_from_evidence_paths",
    "evidence_paths_from_outputs",
    "merge_task_outputs",
    "is_absolute_output_path",
    "absolutize_file_path",
    "absolutize_task_outputs",
    "absolutize_handlers_paths",
    "workspace_root_for_agent",
    "workspace_root_for_task_row",
    "agent_code_for_task_row",
    "task_outputs_of",
    "task_input_refs_of",
    "is_code_output_path",
    "shareable_approval_outputs",
]
