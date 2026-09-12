"""Parallel per-task workers: file edits and read-only code search via lightweight subagents."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass, replace
from typing import Annotated, Any, Literal

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from pydantic import BaseModel, Field, ValidationError

from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping
from evoflow.agents.thread_state import ThreadDataState, ThreadState
from evoflow.collab.id_format import make_trace_id
from evoflow.config.agent_orchestration_config import get_agent_orchestration_config
from evoflow.scheduler.engine import ExecutionReport, format_execution_report_xml
from evoflow.scheduler.prefetch_stream import (
    capture_stream_writer,
    emit_prefetch_tool_calls_batch,
    emit_prefetch_tool_result,
    emit_worker_file_completed,
)
from evoflow.subagents.builtins.file_worker import FILE_WORKER_CONFIG
from evoflow.subagents.builtins.search_worker import SEARCH_WORKER_CONFIG
from evoflow.subagents.config import SubagentConfig
from evoflow.subagents.executor import (
    MAX_CONCURRENT_SUBAGENTS,
    SubagentExecutor,
    SubagentStatus,
    cleanup_background_task,
    get_background_task_result,
)
from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path

logger = logging.getLogger(__name__)

# Worker real-time stream output to the frontend.
# When True, emit_prefetch_tool_calls_batch / emit_worker_file_completed push child tool
# rows (search_code_index / write / replace …) via SSE so the frontend can display them
# independently. Without this, the parent "worker" row is hidden by CHAT_PANEL_HIDDEN_TOOL_NAMES
# and no child rows arrive to replace it → nothing shows.
WORKER_STREAM_ENABLED = True

WorkerAction = Literal["write", "replace", "delete", "edit", "search", "locate"]
WorkerBatchKind = Literal["file", "search", "locate", "discover"]
_WORKER_DISCOVER_ACTIONS = frozenset({"search", "locate"})


class WorkerTaskSpec(BaseModel):
    action: WorkerAction = Field(description="write | replace | delete | edit | search | locate")
    path: str | None = Field(default=None, description="Workspace-relative path (file actions).")
    query: str | None = Field(default=None, description="Search query (search action).")
    instruction: str | None = Field(default=None, description="Natural-language guidance.")
    content: str | None = Field(default=None, description="Full file content for write.")
    old_string: str | None = Field(default=None, description="Exact substring for replace.")
    new_string: str | None = Field(default=None, description="Replacement text for replace.")
    queries: list[str] | str | None = Field(default=None, description="Extra synonyms for search.")
    read_limit: int | None = Field(default=None, description="Catalog paths to read after search.")
    limit: int | None = Field(default=None, description="Max hits per search category.")


def worker_task_key(spec: WorkerTaskSpec) -> str:
    if spec.action in ("search", "locate"):
        return str(spec.query or "").strip()
    return str(spec.path or "").strip()


def _worker_search_term_set(query: str) -> tuple[str | None, frozenset[str]]:
    """Normalize search query into (path_prefix, keyword terms) for dedup checks."""
    from evoflow.tools.arg_coerce import parse_search_path_prefix, split_pipe_terms

    raw = str(query or "").strip()
    path_prefix, body = parse_search_path_prefix(raw)
    terms: set[str] = set()
    if body:
        parts = split_pipe_terms(body)
        if parts:
            terms.update(p.casefold() for p in parts if p.strip())
        else:
            terms.add(body.casefold())
    path_key = None
    if path_prefix:
        path_key = str(path_prefix).strip().replace("\\", "/").strip("/").casefold() or None
    return path_key, frozenset(terms)


def _worker_search_queries_redundant(left: str, right: str) -> bool:
    """True when two parallel search tasks repeat the same focus (exact, reorder, or subset)."""
    a = str(left or "").strip()
    b = str(right or "").strip()
    if not a or not b:
        return False
    if a.casefold() == b.casefold():
        return True
    path_a, terms_a = _worker_search_term_set(a)
    path_b, terms_b = _worker_search_term_set(b)
    if not terms_a or not terms_b:
        return False
    if terms_a == terms_b:
        return True
    if path_a == path_b and (terms_a <= terms_b or terms_b <= terms_a):
        return True
    return False


def worker_task_display_label(spec: WorkerTaskSpec) -> str:
    key = worker_task_key(spec)
    if spec.action == "search" and len(key) > 120:
        return key[:117] + "..."
    return key


def _worker_task_category(action: WorkerAction) -> Literal["discover", "file"]:
    if action in _WORKER_DISCOVER_ACTIONS:
        return "discover"
    return "file"


def worker_batch_kind(specs: list[WorkerTaskSpec]) -> WorkerBatchKind:
    if not specs:
        return "file"
    actions = {s.action for s in specs}
    if actions <= {"search"}:
        return "search"
    if actions <= {"locate"}:
        return "locate"
    if actions <= _WORKER_DISCOVER_ACTIONS:
        return "discover"
    return "file"


def worker_tool_call_id(index: int, task_key: str) -> str:
    digest = hashlib.sha256(f"worker:{index}:{task_key}".encode()).hexdigest()[:10]
    return f"worker-{index}-{digest}"


def action_display_tool_name(action: str) -> str:
    mapping = {
        "write": "write",
        "replace": "replace",
        "delete": "delete",
        "edit": "worker",
        "search": "search_code_index",
        "locate": "find",
    }
    return mapping.get(str(action or "").strip().lower(), "worker")


def _config_for_spec(spec: WorkerTaskSpec, *, max_turns: int) -> SubagentConfig:
    if spec.action == "search":
        return replace(SEARCH_WORKER_CONFIG, max_turns=max_turns)
    return replace(FILE_WORKER_CONFIG, max_turns=max_turns)


def build_file_worker_prompt(spec: WorkerTaskSpec, *, skip_lint: bool = False) -> str:
    lines = [
        "Modify exactly one file in the workspace.",
        f"path: {spec.path}",
        f"action: {spec.action}",
    ]
    if spec.instruction:
        lines.append(f"instruction: {spec.instruction}")
    if spec.content is not None:
        lines.append("content:")
        lines.append(spec.content)
    if spec.old_string is not None:
        lines.append("old_string:")
        lines.append(spec.old_string)
    if spec.new_string is not None:
        lines.append("new_string:")
        lines.append(spec.new_string)
    lines.append("")
    if skip_lint:
        lines.append(
            "Constraints: only modify the path above; do not touch other files. "
            "Read the file first, apply the action, then summarize. "
            "Do NOT run read_lints — a unified lint will run after all same-file edits complete."
        )
    else:
        lines.append(
            "Constraints: only modify the path above; do not touch other files. "
            "Read the file first, apply the action, optionally run read_lints, then summarize."
        )
    return "\n".join(lines)


def build_search_worker_prompt(spec: WorkerTaskSpec) -> str:
    lines = [
        "Search the workspace index for exactly one query (read-only).",
        f"query: {spec.query}",
        "action: search",
    ]
    if spec.instruction:
        lines.append(f"instruction: {spec.instruction}")
    if spec.queries is not None:
        lines.append(f"queries: {spec.queries}")
    lines.append(f"read_limit: {spec.read_limit if spec.read_limit is not None else 0}")
    if spec.limit is not None:
        lines.append(f"limit: {spec.limit}")
    lines.append("")
    lines.append(
        "Constraints: read-only — call search_code_index **once** with the read_limit above (no second search in this task). "
        "Use read_file only for extra catalog paths. "
        "Query tips: use `path:dir/subdir Symbol|alias` to scope a folder; use `|` for synonyms (not regex). "
        "Do not use natural-language sentences or bare filenames — use locate/find_file for filenames. "
        "Do not write, delete, or run shell commands. Summarize findings in 3–6 sentences."
    )
    return "\n".join(lines)


def build_locate_worker_prompt(spec: WorkerTaskSpec) -> str:
    root = str(spec.path or ".").strip() or "."
    lines = [
        "Locate files by glob pattern (read-only).",
        f"pattern: {spec.query}",
        f"root: {root}",
        "action: locate",
    ]
    if spec.instruction:
        lines.append(f"instruction: {spec.instruction}")
    lines.append("")
    lines.append(
        "Constraints: call find_file once with pattern and root; then read_file on the top 1-2 hits. "
        "Do not run unbounded shell find/Get-ChildItem -Recurse. Summarize paths in 3–6 sentences."
    )
    return "\n".join(lines)


def build_worker_prompt(spec: WorkerTaskSpec, *, skip_lint: bool = False) -> str:
    if spec.action == "search":
        return build_search_worker_prompt(spec)
    if spec.action == "locate":
        return build_locate_worker_prompt(spec)
    return build_file_worker_prompt(spec, skip_lint=skip_lint)


def validate_worker_tasks(
    raw_tasks: list[dict[str, Any]],
    *,
    runtime: Any = None,
) -> tuple[list[WorkerTaskSpec] | None, str | None]:
    from evoflow.exploration.exploration_budget import check_tool_budget
    from evoflow.exploration.task_router import looks_like_filename_query, suggest_find_file_message

    if not raw_tasks:
        return None, "Error: worker requires at least one task in tasks[]."

    specs: list[WorkerTaskSpec] = []
    seen_keys: set[str] = set()
    search_queries: list[str] = []
    batch_category: Literal["discover", "file"] | None = None

    for idx, row in enumerate(raw_tasks):
        if not isinstance(row, dict):
            return None, f"Error: tasks[{idx}] must be an object."
        try:
            spec = WorkerTaskSpec.model_validate(row)
        except ValidationError as exc:
            return None, f"Error: tasks[{idx}] invalid: {exc}"

        action = spec.action
        category = _worker_task_category(action)
        if batch_category is None:
            batch_category = category
        elif batch_category != category:
            return None, (
                "Error: worker cannot mix read-only discovery (search/locate) and file tasks in one call."
            )

        thread_id = None
        if runtime is not None and getattr(runtime, "context", None):
            thread_id = str(runtime.context.get("thread_id") or "").strip() or None

        if action == "search":
            norm_query = str(spec.query or "").strip()
            if not norm_query:
                return None, f"Error: tasks[{idx}] search requires query."

            if looks_like_filename_query(norm_query):
                return None, suggest_find_file_message(norm_query)
            if thread_id:
                budget_err = check_tool_budget(thread_id, "search_code_index", {"query": norm_query})
                if budget_err:
                    return None, budget_err
            if norm_query in seen_keys:
                return None, f"Error: duplicate query in tasks: {norm_query}"
            for prev in search_queries:
                if _worker_search_queries_redundant(norm_query, prev):
                    return (
                        None,
                        "Error: redundant search query in tasks — each parallel search must use "
                        f"distinct keywords/symbols (overlap: {norm_query!r} vs {prev!r}). "
                        "Merge synonyms with `|` in one query instead of multiple tasks.",
                    )
            seen_keys.add(norm_query)
            search_queries.append(norm_query)
            if spec.read_limit is None:
                default_rl = get_agent_orchestration_config().worker.worker_search_default_read_limit
                spec = spec.model_copy(update={"read_limit": int(default_rl)})
            specs.append(spec)
            continue

        if action == "locate":
            pattern = str(spec.query or "").strip()
            if not pattern:
                return None, f"Error: tasks[{idx}] locate requires query (glob pattern)."
            locate_root = str(spec.path or ".").strip() or "."
            # Validate the search root through the same workspace guard used by
            # file actions so locate cannot escape the workspace via ``../``.
            resolved_root = resolve_tool_path(locate_root, runtime=runtime, must_exist=False)
            if isinstance(resolved_root, str):
                return None, f"Error: tasks[{idx}] locate root invalid: {resolved_root}"
            if thread_id:
                budget_err = check_tool_budget(
                    thread_id,
                    "find",
                    {"pattern": pattern, "root": locate_root},
                )
                if budget_err:
                    return None, budget_err
            if pattern in seen_keys:
                return None, f"Error: duplicate locate pattern in tasks: {pattern}"
            seen_keys.add(pattern)
            specs.append(spec)
            continue

        norm_path = str(spec.path or "").strip()
        if not norm_path:
            return None, f"Error: tasks[{idx}] path is required."
        resolved = resolve_tool_path(norm_path, runtime=runtime)
        if isinstance(resolved, str):
            return None, f"Error: tasks[{idx}] path invalid: {resolved}"
        # Same path may appear in multiple file tasks (e.g. chained edits);
        # the execution layer serializes same-path tasks to avoid write races.

        if action == "write" and not (spec.content or spec.instruction):
            return None, f"Error: tasks[{idx}] write requires content or instruction."
        if action == "replace" and not (spec.instruction or spec.old_string):
            return None, f"Error: tasks[{idx}] replace requires instruction or old_string."
        if action == "delete" and not spec.instruction:
            spec = spec.model_copy(update={"instruction": "Delete this file."})
        if action == "edit" and not spec.instruction:
            return None, f"Error: tasks[{idx}] edit requires instruction."

        specs.append(spec)

    return specs, None


_POST_SEARCH_READS_BLOCK_RE = re.compile(
    r"<post_search_reads\b[\s\S]*?</post_search_reads>",
    re.IGNORECASE,
)
_READ_FILE_SUMMARY_SPLIT_RE = re.compile(r"(?=\[tool:summary\]\s+tool=(?:read|read_file)\b)", re.IGNORECASE)
_READ_SUMMARY_PATH_RE = re.compile(r"^\s*path:\s*(.+?)\s*$", re.MULTILINE | re.IGNORECASE)


def _normalize_dedupe_path(path: str) -> str:
    p = str(path or "").strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return p.lower()


def _read_summary_path_key(block: str) -> str | None:
    m = _READ_SUMMARY_PATH_RE.search(str(block or ""))
    if not m:
        return None
    return _normalize_dedupe_path(m.group(1))


def _dedupe_read_file_summaries(text: str, seen_paths: set[str]) -> str:
    """Drop duplicate ``read_file`` summary blocks (same path) keeping the first."""
    body = str(text or "")
    parts = _READ_FILE_SUMMARY_SPLIT_RE.split(body)
    if len(parts) <= 1:
        return body
    prefix = parts[0].rstrip()
    kept: list[str] = []
    for block in parts[1:]:
        chunk = block.strip()
        if not chunk:
            continue
        if not chunk.lower().startswith("[tool:summary]"):
            chunk = f"[tool:summary] {chunk}"
        key = _read_summary_path_key(chunk)
        if key:
            if key in seen_paths:
                continue
            seen_paths.add(key)
        kept.append(chunk)
    if not kept:
        return prefix
    merged = "\n\n".join(kept)
    return f"{prefix}\n\n{merged}".strip() if prefix.strip() else merged


def _dedupe_worker_search_text(text: str, seen_paths: set[str]) -> str:
    """Remove duplicate read excerpts inside ``post_search_reads`` blocks and loose summaries."""
    out = str(text or "")
    if not _POST_SEARCH_READS_BLOCK_RE.search(out):
        return _dedupe_read_file_summaries(out, seen_paths)

    def _repl(match: re.Match[str]) -> str:
        block = match.group(0)
        m_open = re.match(r"(<post_search_reads\b[^>]*>)", block, re.IGNORECASE)
        if not m_open:
            return block
        open_tag = m_open.group(1)
        close_tag = "</post_search_reads>"
        inner = block[len(open_tag) :]
        if inner.lower().endswith(close_tag.lower()):
            inner = inner[: -len(close_tag)]
        deduped = _dedupe_read_file_summaries(inner, seen_paths).strip()
        if not deduped:
            return ""
        return f"{open_tag}\n{deduped}\n{close_tag}"

    return _POST_SEARCH_READS_BLOCK_RE.sub(_repl, out)


def _search_deliverable_preview(inner_tools: list[dict[str, Any]] | None) -> str:
    """Short status line for execution_report (full excerpts live in worker_code_reads)."""
    outputs = [str((t or {}).get("output") or "") for t in (inner_tools or [])]
    if not outputs:
        return "Search completed."
    n_summaries = sum(out.count("[tool:summary]") for out in outputs)
    if n_summaries:
        return (
            f"Search completed; {n_summaries} file excerpt(s) in <worker_code_reads>. "
            "If the user asked to fix/implement code, follow <worker_search_next_step> — do not stop at search."
        )
    return "Search completed; see <worker_code_reads>. Follow <worker_search_next_step> when edits are required."


def _format_worker_search_deliverable(result_rows: list[dict[str, Any]]) -> str:
    """Hoist path + code excerpts so the lead model can use them without parsing JSON."""
    sections: list[str] = []
    seen_paths: set[str] = set()
    for row in sorted(result_rows, key=lambda r: int(r.get("index") or 0)):
        if not row.get("ok"):
            continue
        query = str(row.get("query") or "").strip()
        parts: list[str] = []
        if query:
            parts.append(f"### query: {query}")
        for inner in row.get("inner_tools") or []:
            out = str(inner.get("output") or "").strip()
            if not out:
                continue
            m = _POST_SEARCH_READS_BLOCK_RE.search(out)
            if m:
                block = _dedupe_worker_search_text(m.group(0).strip(), seen_paths)
                if block:
                    parts.append(block)
                continue
            head = out.split("<post_search_reads", 1)[0].strip()
            if head:
                head = _dedupe_worker_search_text(head[:6000], seen_paths)
                if head:
                    parts.append(head)
        if parts:
            sections.append("\n\n".join(parts))
    if not sections:
        return ""
    body = "\n\n---\n\n".join(sections)
    return f"<worker_code_reads>\n{body}\n</worker_code_reads>"


_CATALOG_LINE_RE = re.compile(r"^\s*\[\d+\]\s+(.+?)\s*$", re.MULTILINE)


def _collect_search_hit_paths(result_rows: list[dict[str, Any]], *, max_paths: int = 8) -> list[str]:
    """Paths surfaced by search worker rows (catalog + read summaries), deduped in order."""
    paths: list[str] = []
    seen: set[str] = set()

    def _add(raw: str) -> None:
        rel = str(raw or "").strip().split(":")[0].strip()
        if not rel:
            return
        key = _normalize_dedupe_path(rel)
        if key in seen:
            return
        seen.add(key)
        paths.append(rel)

    for row in sorted(result_rows, key=lambda r: int(r.get("index") or 0)):
        if not row.get("ok"):
            continue
        for inner in row.get("inner_tools") or []:
            out = str(inner.get("output") or "")
            for m in _CATALOG_LINE_RE.finditer(out):
                _add(m.group(1))
            for block in _READ_FILE_SUMMARY_SPLIT_RE.split(out)[1:]:
                key = _read_summary_path_key(block)
                if not key or key in seen:
                    continue
                pm = _READ_SUMMARY_PATH_RE.search(block)
                if pm:
                    _add(pm.group(1))
        if len(paths) >= max_paths:
            break
    return paths[:max_paths]


def _format_worker_search_next_step(result_rows: list[dict[str, Any]]) -> str:
    """Tell the lead model to proceed to file edits after search (search alone is not done)."""
    paths = _collect_search_hit_paths(result_rows)
    path_hint = ", ".join(paths[:6]) if paths else "(see Read catalog / worker_code_reads paths)"
    if len(paths) > 6:
        path_hint += f", … (+{len(paths) - 6} more)"
    return f"""<worker_search_next_step>
Search finished — NOT done if the user asked to fix, implement, add, or change code.
Next (same or next turn): `worker` with **edit tasks only** (never mix search + file in one call), e.g.
  worker(tasks=[{{"action":"edit|replace","path":"<path>","instruction":"..."}}])
Rules:
- If catalog-only (no <post_search_reads>): read_file the top 1-2 candidate paths to confirm before editing.
- Use paths from <worker_code_reads> / Read catalog — do NOT search again unless a path is truly missing.
- Do not reply with analysis only; apply the change, then verify (read_lints / terminal) when appropriate.
- Skip edits only when the user explicitly wanted explanation/research with no code change.
Candidate paths: {path_hint}
</worker_search_next_step>"""


def _format_worker_execution_report(
    report: ExecutionReport,
    result_rows: list[dict[str, Any]],
    *,
    batch_kind: WorkerBatchKind,
) -> str:
    """Readable code excerpts first, then status report, then JSON for UI hydration."""
    parts: list[str] = []
    if batch_kind in ("search", "discover"):
        deliverable = _format_worker_search_deliverable(result_rows)
        if deliverable:
            parts.append(deliverable)
        parts.append(_format_worker_search_next_step(result_rows))
    parts.append(format_execution_report_xml(report))
    if not result_rows:
        return "\n".join(parts)
    tag = (
        "worker_search_results"
        if batch_kind in ("search", "locate", "discover")
        else "worker_file_results"
    )
    payload = json.dumps(result_rows, ensure_ascii=False)
    parts.append(f"<{tag}>\n{payload}\n</{tag}>")
    return "\n".join(parts)


def _subagent_ok(status: SubagentStatus) -> bool:
    return status == SubagentStatus.COMPLETED


def _result_preview(result: Any) -> str:
    if result is None:
        return ""
    if result.error:
        return str(result.error)
    return str(result.result or "").strip()


def _enhance_failed_file_preview(
    spec: WorkerTaskSpec,
    sub_result: Any,
    *,
    local_workspace_root: str | None,
    thread_id: str | None,
) -> str:
    """When a file task fails, read the actual file content and include a snippet
    around the old_string region so the lead model can diagnose mismatches without
    a separate read_file call."""
    base = _result_preview(sub_result)
    if spec.action not in ("replace", "edit") or not spec.old_string:
        return base
    file_text = _read_worker_file_text(
        str(spec.path or ""),
        local_workspace_root=local_workspace_root,
        thread_id=thread_id,
    )
    if not file_text:
        return base
    old = spec.old_string
    idx = file_text.find(old)
    if idx >= 0:
        return base  # old_string exists — failure is something else; don't add noise
    # Find closest line match for the first line of old_string
    first_old = old.splitlines()[0].strip() if old.splitlines() else ""
    if not first_old or len(first_old) < 3:
        return base
    import difflib
    lines = file_text.splitlines()
    best_ratio = 0.0
    best_line = -1
    for i, line in enumerate(lines):
        ratio = difflib.SequenceMatcher(None, line.strip(), first_old).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_line = i
    if best_ratio < 0.3 or best_line < 0:
        return base
    start = max(0, best_line - 3)
    end = min(len(lines), best_line + 5)
    context = "\n".join(f"{start + j + 1}: {lines[start + j]}" for j in range(end - start))
    return f"{base}\n\nClosest match at line {best_line + 1} (similarity {best_ratio:.0%}):\n{context}"


def _tool_message_text(msg: dict[str, Any]) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts).strip()
    return str(content or "").strip()


def _read_file_path_from_output(text: str) -> str | None:
    import re

    m = re.search(r"^\s*path:\s*(.+?)(?:\r?\n|$)", text, re.MULTILINE | re.IGNORECASE)
    if not m:
        return None
    path = str(m.group(1) or "").strip()
    return path or None


def _resolve_worker_search_root(
    *,
    local_workspace_root: str | None,
    thread_id: str | None,
) -> str:
    root = str(local_workspace_root or "").strip()
    if not root and thread_id:
        try:
            from evoflow.code_index.store import resolve_index_root

            root = str(resolve_index_root(workspace_root=None, thread_id=thread_id))
        except ValueError:
            root = ""
    return root


def _search_preview_from_output(text: str, *, max_len: int = 2000) -> str:
    body = str(text or "").strip()
    if not body:
        return "Search completed."
    if len(body) <= max_len:
        return body
    return body[:max_len] + "…"


def _build_search_inner_tools(
    spec: WorkerTaskSpec,
    search_output: str,
    *,
    parent_worker_tc_id: str,
    index: int,
) -> list[dict[str, Any]]:
    """Build UI rows from a direct search_code_index result (same shape as main-thread search)."""
    child_tc = worker_tool_call_id(index, worker_task_key(spec))
    ok = not str(search_output or "").strip().startswith("Error:")
    input_obj: dict[str, Any] = {
        "query": spec.query,
        "read_limit": int(spec.read_limit or 0),
        "invocation_source": "worker",
        "parent_worker_tool_call_id": parent_worker_tc_id,
    }
    if spec.queries is not None:
        input_obj["queries"] = spec.queries
    if spec.limit is not None:
        input_obj["limit"] = spec.limit
    return [
        {
            "id": f"{child_tc}:search:0",
            "tool_call_id": f"{child_tc}:search:0",
            "name": "search_code_index",
            "input": input_obj,
            "output": search_output,
            "status": "completed" if ok else "error",
        },
    ]


def _inner_tools_from_subagent(
    spec: WorkerTaskSpec,
    stream_messages: list[dict[str, Any]] | None,
    *,
    parent_worker_tc_id: str,
    index: int,
) -> list[dict[str, Any]]:
    """Surface search-worker tool messages for UI (search hits + read_file rows)."""
    if spec.action != "search":
        return []
    rows: list[dict[str, Any]] = []
    child_tc = worker_tool_call_id(index, worker_task_key(spec))
    search_idx = 0
    read_idx = 0
    for msg in stream_messages or []:
        if not isinstance(msg, dict):
            continue
        name = str(msg.get("name") or msg.get("tool_name") or "").strip()
        if name not in ("search_code_index", "read", "read_file"):
            continue
        text = _tool_message_text(msg)
        if name == "search_code_index":
            tc_id = f"{child_tc}:search:{search_idx}"
            search_idx += 1
            input_obj: dict[str, Any] = {"query": spec.query, "invocation_source": "worker"}
            if spec.queries is not None:
                input_obj["queries"] = spec.queries
            if spec.read_limit is not None:
                input_obj["read_limit"] = spec.read_limit
            if spec.limit is not None:
                input_obj["limit"] = spec.limit
            rows.append(
                {
                    "id": tc_id,
                    "tool_call_id": tc_id,
                    "name": "search_code_index",
                    "input": input_obj,
                    "output": text,
                    "status": "completed",
                },
            )
            continue
        path = _read_file_path_from_output(text)
        tc_id = f"{child_tc}:read:{read_idx}"
        read_idx += 1
        rows.append(
            {
                "id": tc_id,
                "tool_call_id": tc_id,
                "name": name,
                "input": {
                    "path": path or "",
                    "invocation_source": "worker",
                    "parent_worker_tool_call_id": parent_worker_tc_id,
                },
                "output": text,
                "status": "completed",
            },
        )
    if not rows and spec.query:
        rows.append(
            {
                "id": f"{child_tc}:search:0",
                "tool_call_id": f"{child_tc}:search:0",
                "name": "search_code_index",
                "input": {
                    "query": spec.query,
                    "read_limit": spec.read_limit or 0,
                    "invocation_source": "worker",
                    "parent_worker_tool_call_id": parent_worker_tc_id,
                },
                "output": "",
                "status": "completed",
            },
        )
    return rows


_WORKER_DIFF_MAX_CHARS = 96_000
_WORKER_PERSIST_SNAPSHOT_MAX = 8_192


def _truncate_worker_snapshot(text: str | None, *, max_chars: int = _WORKER_PERSIST_SNAPSHOT_MAX) -> str | None:
    if text is None:
        return None
    s = str(text)
    if len(s) <= max_chars:
        return s
    return s[:max_chars] + "\n… [truncated for worker_file_results]"


def _snapshots_for_worker_file_results(
    spec: WorkerTaskSpec,
    before_content: str | None,
    after_content: str | None,
) -> tuple[str | None, str | None]:
    """Drop full-file bodies from persisted JSON when fragment diff fields are enough."""
    action = str(spec.action or "").strip().lower()
    if action == "delete":
        return None, None
    if action in {"replace", "edit"} and (spec.old_string or spec.new_string):
        return None, None
    if action == "write":
        # spec.content already stored in the row; only keep before_content for overwrite diff
        return _truncate_worker_snapshot(before_content), None
    return (
        _truncate_worker_snapshot(before_content),
        _truncate_worker_snapshot(after_content),
    )


def _read_worker_file_text(
    path: str,
    *,
    local_workspace_root: str | None,
    thread_id: str | None,
) -> str | None:
    if not str(path or "").strip() or not local_workspace_root:
        return None
    try:
        from evoflow.tools.host_direct.read_logic import read_file_content
        from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path, runtime_with_workspace

        rt = runtime_with_workspace(local_workspace_root, thread_id)
        resolved = resolve_tool_path(path, runtime=rt, must_exist=True, must_be_file=True)
        if isinstance(resolved, str):
            return None
        text = read_file_content(str(resolved), use_cache=False)
        if str(text).startswith("Error:"):
            return None
        if len(text) > _WORKER_DIFF_MAX_CHARS:
            return text[:_WORKER_DIFF_MAX_CHARS] + "\n… [truncated for diff UI]"
        return text
    except Exception:
        return None


def _emit_worker_stream_updates(
    *,
    parent_tool_call_id: str,
    index: int,
    spec: WorkerTaskSpec,
    sub_result: Any,
    total: int,
    stream_writer: Any,
    before_content: str | None = None,
    after_content: str | None = None,
    inner_tools: list[dict[str, Any]] | None = None,
) -> None:
    if not WORKER_STREAM_ENABLED:
        return
    task_key = worker_task_key(spec)
    tc_id = worker_tool_call_id(index, task_key)
    display_label = worker_task_display_label(spec)
    ok = _subagent_ok(sub_result.status)
    preview = _result_preview(sub_result)
    if spec.action == "search" and inner_tools:
        first_out = str((inner_tools[0] or {}).get("output") or "").strip()
        if first_out:
            preview = _search_preview_from_output(first_out)
            ok = not first_out.startswith("Error:")
    tool_name = action_display_tool_name(spec.action)
    emit_prefetch_tool_result(
        tool_call_id=tc_id,
        path=display_label,
        ok=ok,
        output_preview=preview,
        index=index,
        total=total,
        tool_name=tool_name,
        stream_writer=stream_writer,
        action=spec.action,
        instruction=spec.instruction,
        content=spec.content,
        old_string=spec.old_string,
        new_string=spec.new_string,
        slim_preview=True,
    )
    payload_inner = inner_tools if inner_tools else None
    emit_worker_file_completed(
        parent_tool_call_id=parent_tool_call_id,
        tool_call_id=tc_id,
        path=display_label,
        ok=ok,
        output_preview=preview,
        index=index,
        total=total,
        tool_name=tool_name,
        stream_writer=stream_writer,
        action=spec.action,
        instruction=spec.instruction,
        content=spec.content,
        old_string=spec.old_string,
        new_string=spec.new_string,
        query=spec.query if spec.action == "search" else None,
        inner_tools=payload_inner,
    )


async def _execute_search_task_direct(
    index: int,
    spec: WorkerTaskSpec,
    *,
    parent_tool_call_id: str,
    total: int,
    thread_id: str | None,
    local_workspace_root: str | None,
    stream_writer: Any,
) -> tuple[int, WorkerTaskSpec, Any, None, None, list[dict[str, Any]]]:
    """Run search_code_index directly (same path as main agent) for reliable UI inner_tools."""
    from evoflow.tools.host_direct.search_code_index import _search_code_index_wallclock

    root = _resolve_worker_search_root(local_workspace_root=local_workspace_root, thread_id=thread_id)
    search_output = await asyncio.to_thread(
        _search_code_index_wallclock,
        root=root,
        thread_id=thread_id,
        query=str(spec.query or ""),
        queries=spec.queries,
        read_offset=0,
        read_limit=int(spec.read_limit or 0),
        limit=int(spec.limit or 15),
    )
    inner_tools = _build_search_inner_tools(
        spec,
        search_output,
        parent_worker_tc_id=parent_tool_call_id,
        index=index,
    )
    ok = not str(search_output).strip().startswith("Error:")

    @dataclass
    class _DirectSearchResult:
        status: SubagentStatus
        result: str
        error: str | None
        stream_messages: list[dict[str, Any]]

    sub_result = _DirectSearchResult(
        status=SubagentStatus.COMPLETED if ok else SubagentStatus.FAILED,
        result=_search_preview_from_output(search_output),
        error=search_output if not ok else None,
        stream_messages=[],
    )
    _emit_worker_stream_updates(
        parent_tool_call_id=parent_tool_call_id,
        index=index,
        spec=spec,
        sub_result=sub_result,
        total=total,
        stream_writer=stream_writer,
        inner_tools=inner_tools,
    )
    return (index, spec, sub_result, None, None, inner_tools)


async def _execute_locate_task_direct(
    index: int,
    spec: WorkerTaskSpec,
    *,
    parent_tool_call_id: str,
    total: int,
    thread_id: str | None,
    local_workspace_root: str | None,
    stream_writer: Any,
    runtime: Any,
) -> tuple[int, WorkerTaskSpec, Any, None, None, list[dict[str, Any]]]:
    from evoflow.tools.host_direct.find_file import find_file_wallclock
    from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace

    rt = runtime_with_workspace(local_workspace_root or ".", thread_id) if local_workspace_root or thread_id else runtime
    output = await asyncio.to_thread(
        find_file_wallclock,
        pattern=str(spec.query or ""),
        root=str(spec.path or ".").strip() or ".",
        runtime=rt,
    )
    child_tc = worker_tool_call_id(index, worker_task_key(spec))
    ok = not str(output or "").strip().startswith("Error:")
    inner_tools = [
        {
            "id": f"{child_tc}:locate:0",
            "tool_call_id": f"{child_tc}:locate:0",
            "name": "find",
            "input": {
                "pattern": spec.query,
                "root": str(spec.path or ".").strip() or ".",
                "invocation_source": "worker",
                "parent_worker_tool_call_id": parent_tool_call_id,
            },
            "output": output,
            "status": "completed" if ok else "error",
        }
    ]

    @dataclass
    class _DirectLocateResult:
        status: SubagentStatus
        result: str
        error: str | None
        stream_messages: list[dict[str, Any]]

    sub_result = _DirectLocateResult(
        status=SubagentStatus.COMPLETED if ok else SubagentStatus.FAILED,
        result=_search_preview_from_output(output),
        error=output if not ok else None,
        stream_messages=[],
    )
    _emit_worker_stream_updates(
        parent_tool_call_id=parent_tool_call_id,
        index=index,
        spec=spec,
        sub_result=sub_result,
        total=total,
        stream_writer=stream_writer,
        inner_tools=inner_tools,
    )
    return (index, spec, sub_result, None, None, inner_tools)


async def _run_discover_workers_async(
    specs: list[WorkerTaskSpec],
    *,
    parent_tool_call_id: str,
    max_concurrency: int,
    thread_id: str | None,
    local_workspace_root: str | None,
    stream_writer: Any,
    runtime: Any,
) -> list[tuple[int, WorkerTaskSpec, Any, str | None, str | None, list[dict[str, Any]] | None]]:
    """Parallel read-only discovery: search and locate tasks may run in one batch."""
    total = len(specs)
    sem = asyncio.Semaphore(max_concurrency)

    async def _one(index: int, spec: WorkerTaskSpec):
        async with sem:
            if spec.action == "search":
                return await _execute_search_task_direct(
                    index,
                    spec,
                    parent_tool_call_id=parent_tool_call_id,
                    total=total,
                    thread_id=thread_id,
                    local_workspace_root=local_workspace_root,
                    stream_writer=stream_writer,
                )
            return await _execute_locate_task_direct(
                index,
                spec,
                parent_tool_call_id=parent_tool_call_id,
                total=total,
                thread_id=thread_id,
                local_workspace_root=local_workspace_root,
                stream_writer=stream_writer,
                runtime=runtime,
            )

    rows = await asyncio.gather(*[_one(i, s) for i, s in enumerate(specs)])
    return sorted(rows, key=lambda row: row[0])


async def _run_locate_workers_async(
    specs: list[WorkerTaskSpec],
    *,
    parent_tool_call_id: str,
    max_concurrency: int,
    thread_id: str | None,
    local_workspace_root: str | None,
    stream_writer: Any,
    runtime: Any,
) -> list[tuple[int, WorkerTaskSpec, Any, str | None, str | None, list[dict[str, Any]] | None]]:
    total = len(specs)
    sem = asyncio.Semaphore(max_concurrency)

    async def _one(index: int, spec: WorkerTaskSpec):
        async with sem:
            return await _execute_locate_task_direct(
                index,
                spec,
                parent_tool_call_id=parent_tool_call_id,
                total=total,
                thread_id=thread_id,
                local_workspace_root=local_workspace_root,
                stream_writer=stream_writer,
                runtime=runtime,
            )

    rows = await asyncio.gather(*[_one(i, s) for i, s in enumerate(specs)])
    return sorted(rows, key=lambda row: row[0])


async def _run_search_workers_async(
    specs: list[WorkerTaskSpec],
    *,
    parent_tool_call_id: str,
    max_concurrency: int,
    thread_id: str | None,
    local_workspace_root: str | None,
    stream_writer: Any,
) -> list[tuple[int, WorkerTaskSpec, Any, str | None, str | None, list[dict[str, Any]] | None]]:
    total = len(specs)
    sem = asyncio.Semaphore(max_concurrency)

    async def _one(index: int, spec: WorkerTaskSpec):
        async with sem:
            return await _execute_search_task_direct(
                index,
                spec,
                parent_tool_call_id=parent_tool_call_id,
                total=total,
                thread_id=thread_id,
                local_workspace_root=local_workspace_root,
                stream_writer=stream_writer,
            )

    rows = await asyncio.gather(*[_one(i, s) for i, s in enumerate(specs)])
    return sorted(rows, key=lambda row: row[0])


@dataclass
class _SyntheticWorkerFailure:
    """Stand-in result when background task vanished or polling itself raised.

    Mirrors the subset of ``SubagentResult`` that ``_emit_worker_stream_updates`` /
    ``_format_worker_execution_report`` read; lets the batch finish gracefully so
    ``results`` and ``execution_report`` stay aligned with ``specs``.
    """

    status: SubagentStatus
    result: str
    error: str | None
    stream_messages: list[dict[str, Any]]


def _make_synthetic_failure(bg_id: str, message: str) -> _SyntheticWorkerFailure:
    return _SyntheticWorkerFailure(
        status=SubagentStatus.FAILED,
        result="",
        error=f"{message} (bg_id={bg_id})",
        stream_messages=[],
    )


def _run_post_batch_lint(
    paths: list[str],
    *,
    local_workspace_root: str | None,
    thread_id: str | None,
) -> dict[str, str]:
    """Run read_lints on each path after all same-file edits complete. Returns {path: lint_output}."""
    from evoflow.tools.code_lint import lint_path
    from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path, runtime_with_workspace

    rt = runtime_with_workspace(local_workspace_root, thread_id) if (local_workspace_root or thread_id) else None
    results: dict[str, str] = {}
    for path in paths:
        if not path:
            continue
        try:
            if rt is not None:
                resolved = resolve_tool_path(path, runtime=rt, must_exist=True, must_be_file=True)
                if isinstance(resolved, str):
                    continue
            else:
                from pathlib import Path

                resolved = Path(path)
                if not resolved.is_file():
                    continue
            lint_result = lint_path(resolved)
            if lint_result and "No issues found" not in lint_result:
                results[path] = lint_result
        except Exception:
            pass
    return results


async def _run_workers_async(
    specs: list[WorkerTaskSpec],
    *,
    parent_tool_call_id: str,
    max_concurrency: int,
    max_turns: int,
    tools: list[Any],
    parent_model: str | None,
    sandbox_state: Any,
    thread_data: ThreadDataState | None,
    thread_id: str | None,
    local_workspace_root: str | None,
    trace_id: str,
    stream_writer: Any,
    runtime: Any = None,
    multi_task_paths: set[str] | None = None,
) -> list[tuple[int, WorkerTaskSpec, Any, str | None, str | None, list[dict[str, Any]] | None]]:
    """Run workers in background threads; poll on the lead-agent loop for live UI updates."""
    total = len(specs)
    batch_kind = worker_batch_kind(specs)
    if batch_kind == "search":
        return await _run_search_workers_async(
            specs,
            parent_tool_call_id=parent_tool_call_id,
            max_concurrency=max_concurrency,
            thread_id=thread_id,
            local_workspace_root=local_workspace_root,
            stream_writer=stream_writer,
        )
    if batch_kind == "discover":
        return await _run_discover_workers_async(
            specs,
            parent_tool_call_id=parent_tool_call_id,
            max_concurrency=max_concurrency,
            thread_id=thread_id,
            local_workspace_root=local_workspace_root,
            stream_writer=stream_writer,
            runtime=runtime,
        )
    if batch_kind == "locate":
        return await _run_locate_workers_async(
            specs,
            parent_tool_call_id=parent_tool_call_id,
            max_concurrency=max_concurrency,
            thread_id=thread_id,
            local_workspace_root=local_workspace_root,
            stream_writer=stream_writer,
            runtime=runtime,
        )
    pending: dict[str, tuple[int, WorkerTaskSpec, str | None]] = {}
    results: list[tuple[int, WorkerTaskSpec, Any, str | None, str | None, list[dict[str, Any]] | None]] = []
    next_index = 0
    running_paths: set[str] = set()
    not_started: list[int] = []
    poll_interval_s = 0.5

    def _make_executor(index: int, spec: WorkerTaskSpec, tc_id: str) -> SubagentExecutor:
        worker_trace = f"{trace_id}-w{index}"
        config = _config_for_spec(spec, max_turns=max_turns)
        from evoflow.collab.thread_ids import collab_subtask_executor_thread_id, normalize_lead_thread_id

        lead = normalize_lead_thread_id(thread_id) or str(thread_id or "").strip()
        worker_thread_id = (
            collab_subtask_executor_thread_id(lead, tc_id)
            if tc_id
            else f"worker_{uuid.uuid4().hex[:16]}"
        )
        extra_context = {"parent_thread_id": lead} if lead else None
        return SubagentExecutor(
            config=config,
            tools=tools,
            parent_model=parent_model,
            sandbox_state=sandbox_state,
            thread_data=thread_data,
            thread_id=worker_thread_id,
            local_workspace_root=local_workspace_root,
            trace_id=worker_trace,
            extra_context=extra_context,
            parent_chat_stream_writer=stream_writer,
        )

    def _start_worker(index: int, spec: WorkerTaskSpec) -> None:
        task_key = worker_task_key(spec)
        tc_id = worker_tool_call_id(index, task_key)
        before_content: str | None = None
        if batch_kind == "file":
            before_content = _read_worker_file_text(
                str(spec.path or ""),
                local_workspace_root=local_workspace_root,
                thread_id=thread_id,
            )
        executor = _make_executor(index, spec, tc_id)
        skip_lint = multi_task_paths is not None and str(spec.path or "").strip() in multi_task_paths
        bg_id = executor.execute_async(build_worker_prompt(spec, skip_lint=skip_lint), task_id=tc_id)
        pending[bg_id] = (index, spec, before_content)
        running_paths.add(str(spec.path or "").strip())

    from evoflow.observability.poll_loop_log import log_poll_loop_end, log_poll_loop_start, log_poll_tick

    def _try_start_more() -> None:
        """Start pending tasks respecting concurrency limit and same-path serialization."""
        nonlocal next_index
        # Retry tasks previously skipped due to a same-path conflict.
        still_blocked: list[int] = []
        for idx in not_started:
            if len(pending) >= max_concurrency:
                still_blocked.append(idx)
                continue
            spec = specs[idx]
            path = str(spec.path or "").strip()
            if path in running_paths:
                still_blocked.append(idx)
                continue
            _start_worker(idx, spec)
        not_started[:] = still_blocked
        # Start new tasks from next_index, skipping same-path conflicts.
        while next_index < len(specs) and len(pending) < max_concurrency:
            spec = specs[next_index]
            path = str(spec.path or "").strip()
            if path in running_paths:
                not_started.append(next_index)
                next_index += 1
                continue
            _start_worker(next_index, spec)
            next_index += 1

    log_poll_loop_start("worker_batch_poll", pending=len(specs), thread_id=thread_id or None)
    try:
        _try_start_more()

        while pending:
            log_poll_tick("worker_batch_poll", key=thread_id or trace_id, interval_s=15.0, pending=len(pending))
            finished: list[str] = []
            for bg_id, (index, spec, before_content) in list(pending.items()):
                try:
                    sub_result = get_background_task_result(bg_id)
                except Exception as exc:
                    logger.exception(
                        "[trace=%s] worker get_background_task_result failed for bg_id=%s",
                        trace_id,
                        bg_id,
                    )
                    sub_result = _make_synthetic_failure(
                        bg_id,
                        f"worker poll failure: {exc!s}",
                    )
                if sub_result is None:
                    logger.warning("[trace=%s] worker background task %s disappeared", trace_id, bg_id)
                    sub_result = _make_synthetic_failure(
                        bg_id,
                        "worker background task disappeared before completion",
                    )
                if sub_result.status in (SubagentStatus.PENDING, SubagentStatus.RUNNING):
                    continue
                ok = _subagent_ok(sub_result.status)
                after_content: str | None = None
                if ok and batch_kind == "file":
                    if spec.action == "delete":
                        after_content = ""
                    else:
                        after_content = _read_worker_file_text(
                            str(spec.path or ""),
                            local_workspace_root=local_workspace_root,
                            thread_id=thread_id,
                        )
                        if after_content is None and spec.action == "write" and spec.content is not None:
                            after_content = spec.content
                inner_tools: list[dict[str, Any]] | None = None
                _emit_worker_stream_updates(
                    parent_tool_call_id=parent_tool_call_id,
                    index=index,
                    spec=spec,
                    sub_result=sub_result,
                    total=total,
                    stream_writer=stream_writer,
                    before_content=before_content,
                    after_content=after_content,
                    inner_tools=inner_tools,
                )
                await asyncio.sleep(0)
                results.append((index, spec, sub_result, before_content, after_content, inner_tools))
                cleanup_background_task(bg_id)
                running_paths.discard(str(spec.path or "").strip())
                finished.append(bg_id)

            for bg_id in finished:
                pending.pop(bg_id, None)

            _try_start_more()

            if pending:
                await asyncio.sleep(poll_interval_s)
    finally:
        # Drain any still-pending background tasks (cancel / exception path).
        # Without this, in-flight workers leak after the lead-agent cancels
        # the tool call, and the batch report would show fewer results than specs.
        if pending:
            covered_indices = {row[0] for row in results}
            for bg_id, (index, spec, before_content) in list(pending.items()):
                try:
                    cleanup_background_task(bg_id)
                except Exception:
                    logger.debug(
                        "[trace=%s] cleanup_background_task failed for bg_id=%s",
                        trace_id,
                        bg_id,
                        exc_info=True,
                    )
                if index not in covered_indices:
                    results.append(
                        (
                            index,
                            spec,
                            _make_synthetic_failure(bg_id, "worker batch cancelled before completion"),
                            before_content,
                            None,
                            None,
                        ),
                    )
                    covered_indices.add(index)
            pending.clear()
        log_poll_loop_end("worker_batch_poll", thread_id=thread_id or None)

    results.sort(key=lambda row: row[0])
    return results


_WORKER_DESCRIPTION = (
    "Parallel workers for search/locate/write/replace/delete (prefer over long main-thread chains). "
    "Each task needs action; search/locate are read-only; file tasks need path. "
    "Distinct search foci per parallel task; after search, edit with paths from the catalog."
)


@tool("worker", description=_WORKER_DESCRIPTION, parse_docstring=False)
async def worker_tool(
    runtime: ToolRuntime[ThreadState, Any],
    tasks: list[dict[str, Any]],
    tool_call_id: Annotated[str, InjectedToolCallId],
    max_concurrency: int | None = None,
    max_turns: int | None = None,
) -> str:
    """Run parallel worker subagents for independent file edits or code searches.

    **Default for workspace code search and file edits (prefer often).**
    When you need to find code, edit/replace/delete files, or locate files by glob,
    use this tool instead of calling `read` / `search_code_index` / `write` / `replace`
    one-by-one on the main thread. It dispatches lightweight subagents in parallel,
    preserving your context and returning a structured report.

    Use this tool when:
    - You need to **search code** by symbol/keyword (action=search) — prefer over `search_code_index` on main thread
    - You need to **locate files** by glob pattern (action=locate) — prefer over `find` on main thread
    - You need to **write/replace/delete/edit** one or more files (action=write|replace|delete|edit)
    - You have **2+ independent file operations** that can run in parallel
    - You want to keep exploration/implementation separate from the main conversation context
    - Instead of long main-thread chains of read/search/replace for the same sub-problem

    When NOT to use this tool:
    - Reading a single known path → use `read` directly (faster, no subagent overhead)
    - A single precise one-line patch when you already have the full content in context → use `replace` directly
    - Running git/npm/tests/builds → use `terminal` (workers are for file ops and search, not shell commands)
    - Complex multi-step reasoning that needs back-and-forth exploration → use `subagent` instead
    - Tasks requiring user interaction or clarification → use `ask_clarification` in main thread first

    **Task types:**
    - `search` / `locate`: Read-only discovery — may mix in one call
    - `write` / `replace` / `delete` / `edit`: File mutations — one batch type only (no search/locate in same call)

    **Rules:**
    - Do NOT mix file actions (write/replace/delete/edit) with search/locate in the same call.
    - Each search task calls `search_code_index` **once**; use `read_limit` to prefetch catalog paths.
    - Use `|` for synonym search terms (e.g. `FeishuChannel|feishu|lark`), not regex.
    - Use `path:dir/subdir` prefix to scope a search to a folder.
    - For filenames, use `locate` (glob), not `search` (symbol/keyword index).

    Args:
        tasks: List of per-task specs (path+file action, or query+search).
        max_concurrency: Parallel workers (default 5, max 5).
        max_turns: Max model rounds per worker (default from config).
    """
    cfg = get_agent_orchestration_config().worker
    specs, err = validate_worker_tasks(
        tasks,
        runtime=runtime,
    )
    if err:
        return err
    assert specs is not None

    concurrency = max(1, min(int(max_concurrency or cfg.worker_max_concurrency), MAX_CONCURRENT_SUBAGENTS))
    turns = max(1, min(int(max_turns or cfg.worker_default_max_turns), 500))
    batch_kind = worker_batch_kind(specs)

    sandbox_state = runtime.state.get("sandbox")
    thread_data = runtime.state.get("thread_data")
    thread_id = None
    parent_model = None
    trace_id = make_trace_id()
    local_workspace_root: str | None = None

    if runtime.context:
        thread_id = runtime.context.get("thread_id")
    configurable = runtime.config.get("configurable", {}) if runtime.config else {}
    if thread_id is None and isinstance(configurable, dict):
        thread_id = configurable.get("thread_id")
    ctx_map = runtime_context_mapping(runtime)
    local_workspace_root = (
        str(ctx_map.get("local_workspace_root") or "").strip()
        or str(configurable.get("local_workspace_root") or "").strip()
        or None
    )
    if not local_workspace_root and thread_id:
        from evoflow.tools.host_direct.workspace_context import load_local_workspace_root_for_thread

        local_workspace_root = load_local_workspace_root_for_thread(thread_id) or None

    metadata = runtime.config.get("metadata", {}) if runtime.config else {}
    from evoflow.agents.lead_agent.runtime_context import (
        resolve_session_model_name_from_runtime,
        runtime_context_mapping,
    )

    _ctx = runtime_context_mapping(runtime)
    parent_model = resolve_session_model_name_from_runtime(
        runtime,
        lead_thread_id=thread_id,
        session_key=str(_ctx.get("session_key") or "").strip() or None,
    )
    trace_id = metadata.get("trace_id") or trace_id

    from evoflow.tools import get_available_tools

    parent_tools = get_available_tools(model_name=parent_model, subagent_enabled=False)

    stream_writer = capture_stream_writer() if WORKER_STREAM_ENABLED else None
    total = len(specs)
    batch_calls: list[dict[str, str | int | dict]] = []
    for index, spec in enumerate(specs):
        task_key = worker_task_key(spec)
        tc_id = worker_tool_call_id(index, task_key)
        tool_name = action_display_tool_name(spec.action)
        display_label = worker_task_display_label(spec)
        task_args: dict[str, Any] = {
            "action": spec.action,
            "invocation_source": "worker",
            "parent_worker_tool_call_id": tool_call_id,
        }
        if spec.action == "search":
            task_args["query"] = spec.query
        elif spec.action == "locate":
            task_args["query"] = spec.query
            task_args["path"] = str(spec.path or ".").strip() or "."
        else:
            task_args["path"] = spec.path
        if spec.instruction:
            task_args["instruction"] = spec.instruction
        if spec.content is not None:
            task_args["content"] = spec.content
        if spec.old_string is not None:
            task_args["old_string"] = spec.old_string
        if spec.new_string is not None:
            task_args["new_string"] = spec.new_string
        if spec.queries is not None:
            task_args["queries"] = spec.queries
        if spec.read_limit is not None:
            task_args["read_limit"] = spec.read_limit
        if spec.limit is not None:
            task_args["limit"] = spec.limit
        batch_calls.append(
            {
                "tool_call_id": tc_id,
                "tool_name": tool_name,
                "path": display_label,
                "index": index,
                "total": total,
                "invocation_source": "worker",
                "parent_tool_call_id": tool_call_id,
                "args": task_args,
            },
        )
    if WORKER_STREAM_ENABLED:
        emit_prefetch_tool_calls_batch(batch_calls, stream_writer=stream_writer)

    # Detect same-path multi-task groups for unified post-batch lint
    _path_counts: dict[str, int] = {}
    for _spec in specs:
        _p = str(_spec.path or "").strip()
        if _p:
            _path_counts[_p] = _path_counts.get(_p, 0) + 1
    multi_task_paths = {p for p, c in _path_counts.items() if c > 1}

    results = await _run_workers_async(
        specs,
        parent_tool_call_id=tool_call_id,
        max_concurrency=concurrency,
        max_turns=turns,
        tools=parent_tools,
        parent_model=parent_model,
        sandbox_state=sandbox_state,
        thread_data=thread_data,
        thread_id=thread_id,
        local_workspace_root=local_workspace_root,
        trace_id=trace_id,
        stream_writer=stream_writer,
        runtime=runtime,
        multi_task_paths=multi_task_paths,
    )

    report_rows: list[dict[str, Any]] = []
    result_rows: list[dict[str, Any]] = []
    for index, spec, sub_result, before_content, after_content, inner_tools in results:
        ok = _subagent_ok(sub_result.status)
        preview = _result_preview(sub_result)
        if spec.action == "search":
            preview = _search_deliverable_preview(inner_tools)
            op = f"worker={index} query={spec.query} action=search"
        elif spec.action == "locate":
            preview = _search_deliverable_preview(inner_tools) or preview
            op = f"worker={index} query={spec.query} path={spec.path or '.'} action=locate"
        else:
            op = f"worker={index} path={spec.path} action={spec.action}"
            if not ok:
                preview = _enhance_failed_file_preview(
                    spec,
                    sub_result,
                    local_workspace_root=local_workspace_root,
                    thread_id=thread_id,
                )
        report_rows.append(
            {
                "op": op,
                "ok": ok,
                "output_preview": preview,
                "error": sub_result.error if not ok else None,
            },
        )
        row: dict[str, Any] = {
            "index": index,
            "action": spec.action,
            "ok": ok,
            "instruction": spec.instruction,
            "preview": preview,
        }
        if spec.action == "search":
            row["query"] = spec.query
            row["queries"] = spec.queries
            row["read_limit"] = spec.read_limit
            row["limit"] = spec.limit
            row["inner_tools"] = inner_tools or []
        elif spec.action == "locate":
            row["query"] = spec.query
            row["path"] = spec.path
            row["inner_tools"] = inner_tools or []
        else:
            row["path"] = spec.path
            row["content"] = spec.content
            row["old_string"] = spec.old_string
            row["new_string"] = spec.new_string
            snap_before, snap_after = _snapshots_for_worker_file_results(
                spec, before_content, after_content
            )
            row["before_content"] = snap_before
            row["after_content"] = snap_after
        result_rows.append(row)

    # Post-batch unified lint for same-path multi-task groups
    if multi_task_paths:
        lint_map = await asyncio.to_thread(
            _run_post_batch_lint,
            list(multi_task_paths),
            local_workspace_root=local_workspace_root,
            thread_id=thread_id,
        )
        if lint_map:
            _path_last_ri: dict[str, int] = {}
            for _i, (_idx, _spec, *_rest) in enumerate(results):
                _p = str(_spec.path or "").strip()
                if _p in multi_task_paths:
                    _path_last_ri[_p] = _i
            for _path, _lint_out in lint_map.items():
                _ri = _path_last_ri.get(_path)
                if _ri is not None and _ri < len(report_rows):
                    report_rows[_ri]["output_preview"] = (
                        str(report_rows[_ri].get("output_preview", ""))
                        + f"\n\n[post-batch lint for {_path}]\n{_lint_out}"
                    )

    status = "ok" if all(r.get("ok") for r in report_rows) else "partial"
    report = ExecutionReport(status=status, results=report_rows)
    return _format_worker_execution_report(report, result_rows, batch_kind=batch_kind)
