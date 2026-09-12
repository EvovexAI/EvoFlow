"""Local tool scheduler engine."""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from evoflow.config.agent_orchestration_config import get_agent_orchestration_config
from evoflow.scheduler.rules import classify_ops
from evoflow.scheduler.task_plan import TaskOp, TaskPlan
from evoflow.scheduler.tool_executor import execute_op, log_scheduler_invocation

logger = logging.getLogger(__name__)

_write_lock = asyncio.Lock()
_PREFETCH_SYNC_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="evoflow-prefetch-sync")


@dataclass
class ExecutionReport:
    status: str = "ok"
    results: list[dict] = field(default_factory=list)


def format_execution_report_xml(report: ExecutionReport) -> str:
    lines = ["<execution_report>"]
    lines.append(f"status: {report.status}")
    for row in report.results:
        lines.append(f"--- op={row.get('op')} ok={row.get('ok')}")
        preview = str(row.get("output_preview") or row.get("error") or "")[:800]
        if preview:
            lines.append(preview)
    lines.append("</execution_report>")
    return "\n".join(lines)


def format_prefetch_context_xml(paths: list[str], snippets: list[tuple[str, str]]) -> str:
    from evoflow.tools.tool_result_shaper import format_prefetch_snippet

    lines = ["<prefetch_context>", f"prefetched_files: {len(paths)}", ""]
    for path, body in snippets:
        preview = format_prefetch_snippet(path, body)
        lines.append(preview)
        lines.append("")
    lines.append("</prefetch_context>")
    return "\n".join(lines).strip()


class LocalToolScheduler:
    def __init__(self, *, workspace_root: str | None = None, thread_id: str | None = None) -> None:
        self.workspace_root = workspace_root
        self.thread_id = thread_id
        cfg = get_agent_orchestration_config().local_scheduler
        self._io_sem = asyncio.Semaphore(cfg.max_io_concurrency)

    async def _run_io(self, op: TaskOp) -> dict:
        async with self._io_sem:
            return await asyncio.to_thread(
                execute_op,
                op,
                workspace_root=self.workspace_root,
                thread_id=self.thread_id,
            )

    async def _run_serial(self, ops: list[TaskOp], *, use_write_lock: bool) -> list[dict]:
        out: list[dict] = []
        for op in ops:
            if use_write_lock:
                async with _write_lock:
                    row = await asyncio.to_thread(
                        execute_op,
                        op,
                        workspace_root=self.workspace_root,
                        thread_id=self.thread_id,
                    )
            else:
                row = await self._run_io(op)
            out.append(row)
            log_scheduler_invocation(
                self.thread_id,
                str(row.get("op") or op.op),
                status="success" if row.get("ok") else "error",
                output_preview=str(row.get("output_preview") or row.get("error") or ""),
            )
        return out

    async def run_async(self, plan: TaskPlan) -> ExecutionReport:
        tier0, tier1, tier2 = classify_ops(plan.ops)
        results: list[dict] = []

        if tier0:
            results.extend(await self._run_serial(tier0, use_write_lock=False))
        if tier1:
            rows = await asyncio.gather(*[self._run_io(op) for op in tier1])
            for row in rows:
                results.append(row)
                log_scheduler_invocation(
                    self.thread_id,
                    str(row.get("op")),
                    status="success" if row.get("ok") else "error",
                    output_preview=str(row.get("output_preview") or row.get("error") or ""),
                )
        if tier2:
            results.extend(await self._run_serial(tier2, use_write_lock=True))

        status = "ok" if all(r.get("ok") for r in results) else "partial"
        return ExecutionReport(status=status, results=results)

    def run(self, plan: TaskPlan) -> ExecutionReport:
        return asyncio.run(self.run_async(plan))

    async def _expand_prefetch_paths(self, root: str, paths: list[str], cap: int) -> list[str]:
        from evoflow.config.code_index_config import get_code_index_config

        ci = get_code_index_config()
        dep_hops = getattr(ci, "prefetch_dependency_hops", 0) or 0
        if dep_hops <= 0 or not ci.dependency_graph_enabled or not paths:
            return paths
        try:
            from evoflow.code_index.deps import dependency_neighbors
            from evoflow.code_index.store import _connect, _ensure_schema

            conn = _connect(root)
            _ensure_schema(conn)
            rel_seeds = [str(Path(p).relative_to(Path(root))).as_posix() for p in paths]
            extra = dependency_neighbors(conn, rel_seeds, hops=dep_hops, limit=cap)
            conn.close()
            seen = {str(Path(p).relative_to(Path(root))).as_posix() for p in paths}
            out = list(paths)
            for rel in extra:
                if rel in seen:
                    continue
                seen.add(rel)
                out.append(str(Path(root) / rel))
                if len(out) >= cap:
                    break
            return out
        except Exception as e:
            logger.debug("prefetch dependency expansion skipped: %s", e)
            return paths

    async def run_prefetch_async(self, query: str, *, max_files: int | None = None) -> str:
        """Search index then parallel-read top paths."""
        from evoflow.code_index.store import search_index

        hybrid = get_agent_orchestration_config().hybrid
        cap = max_files or hybrid.prefetch_max_files
        root = self.workspace_root
        if not root:
            return ""

        data = search_index(root, query, thread_id=self.thread_id, limit=cap * 2)
        from evoflow.scheduler.search_follow_read import (
            parallel_read_paths_for_ui_async,
            read_targets_from_search_data,
        )

        targets = read_targets_from_search_data(data, root, max_files=cap)
        paths = [t.abs_path for t in targets]
        paths = await self._expand_prefetch_paths(root, paths, cap)
        if not paths:
            logger.debug("prefetch: no paths for query=%r", query[:80])
            return ""

        target_by_abs = {t.abs_path: t for t in targets}
        prefetch_targets = [target_by_abs[p] for p in paths if p in target_by_abs]
        snippets = await parallel_read_paths_for_ui_async(
            paths,
            workspace_root=root,
            thread_id=self.thread_id,
            stream_prefix="prefetch-read",
            invocation_source="prefetch",
            emit_stream_events=False,
            log_to_observability=False,
            read_targets=prefetch_targets or None,
        )
        logger.info("prefetch: read %d files for workspace %s", len(snippets), root)
        return format_prefetch_context_xml(paths, list(snippets))

    def run_prefetch(self, query: str, *, max_files: int | None = None) -> str:
        async def _run() -> str:
            return await self.run_prefetch_async(query, max_files=max_files)

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(_run())

        fut = _PREFETCH_SYNC_POOL.submit(asyncio.run, _run())
        return fut.result(timeout=120)
