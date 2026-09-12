"""Background Knowledge Vault reindex jobs with CLI progress parsing.

OHS MCP ``reindex`` blocks until finished and only prints progress on stderr of
the MCP child — the HTTP client sees nothing for minutes. We run the OHS CLI
as a subprocess (when packaged), parse ``12/161 (7%)`` lines, and expose a job
the panel can poll.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

from evoflow.knowledge.vault.errors import map_exception
from evoflow.knowledge.vault.sanitize import sanitize_text
from evoflow.knowledge.vault.runtime_resolve import (
    find_ready_kb_package_root,
    ohs_cli_js,
    ohs_node_import_args,
    preferred_install_root,
    resolve_node_binary,
)

logger = logging.getLogger(__name__)

_PROGRESS_RE = re.compile(r"(\d+)\s*/\s*(\d+)\s*\((\d+)%\)")
_DONE_RE = re.compile(
    r"Done in ([^\s—\-]+).*?(\d+)\s+indexed.*?(\d+)\s+skipped",
    re.IGNORECASE,
)
_JOBS: dict[str, "ReindexJob"] = {}
_LOCK = asyncio.Lock()


@dataclass
class ReindexJob:
    job_id: str
    vault_id: str
    state: str = "queued"  # queued | running | done | error
    phase: str = "queued"
    message: str = "等待开始"
    force: bool = True
    path: str | None = None
    run_install: bool = False  # True: npm install kb-mcp before reindex (first-time setup)
    processed: int | None = None
    total: int | None = None
    percent: int | None = None
    indexed: int | None = None
    skipped: int | None = None
    error_count: int = 0
    error: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    elapsed_sec: float = 0.0
    result_status: dict[str, Any] | None = None
    engine: str = "unknown"  # cli | mcp | setup
    log_tail: list[str] = field(default_factory=list)

    def touch(self) -> None:
        if self.started_at is not None and self.finished_at is None:
            self.elapsed_sec = round(time.time() - self.started_at, 1)
        elif self.started_at is not None and self.finished_at is not None:
            self.elapsed_sec = round(self.finished_at - self.started_at, 1)

    def to_dict(self) -> dict[str, Any]:
        self.touch()
        data = asdict(self)
        data["jobId"] = data.pop("job_id")
        data["vaultId"] = data.pop("vault_id")
        data["runInstall"] = data.pop("run_install")
        data["startedAt"] = (
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started_at))
            if self.started_at
            else None
        )
        data["finishedAt"] = (
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.finished_at))
            if self.finished_at
            else None
        )
        data["elapsedSec"] = data.pop("elapsed_sec")
        data["errorCount"] = data.pop("error_count")
        data["resultStatus"] = data.pop("result_status")
        data["logTail"] = data.pop("log_tail")[-12:]
        data.pop("started_at", None)
        data.pop("finished_at", None)
        return data


def get_job(vault_id: str) -> ReindexJob | None:
    return _JOBS.get(str(vault_id))


def get_job_dict(vault_id: str) -> dict[str, Any] | None:
    job = get_job(vault_id)
    return job.to_dict() if job else None


def _append_log(job: ReindexJob, line: str) -> None:
    text = str(line or "").strip()
    if not text:
        return
    job.log_tail.append(text[:240])
    if len(job.log_tail) > 40:
        job.log_tail = job.log_tail[-40:]


def _apply_progress_line(job: ReindexJob, line: str) -> None:
    _append_log(job, line)
    m = _PROGRESS_RE.search(line)
    if m:
        job.processed = int(m.group(1))
        job.total = int(m.group(2))
        job.percent = int(m.group(3))
        job.phase = "indexing"
        job.message = f"正在索引 {job.processed}/{job.total}（{job.percent}%）"
        return
    done = _DONE_RE.search(line)
    if done:
        job.indexed = int(done.group(2))
        job.skipped = int(done.group(3))
        job.phase = "finalizing"
        job.message = f"索引完成：已写入 {job.indexed}，跳过 {job.skipped}"
        if job.total:
            job.processed = job.total
            job.percent = 100
        return
    lower = line.lower()
    if "recreating database" in lower or "indexing vault" in lower:
        job.phase = "indexing"
        job.message = line.strip()[:160]


async def _release_vault_db_lock(vault_id: str, job: ReindexJob) -> None:
    """Stop the managed MCP child so Windows can unlink ``.obsidian-hybrid-search.db``."""
    from evoflow.knowledge.vault.mcp_runtime import drop_session, get_session

    if get_session(vault_id) is None:
        return
    job.phase = "releasing"
    job.message = "释放索引库文件锁（关闭检索进程）…"
    _append_log(job, f"drop_session {vault_id}")
    try:
        await drop_session(vault_id)
    except BaseException as exc:
        # drop_session should not raise; keep reindex moving if it does.
        _append_log(job, f"drop_session failed: {exc}")
        logger.debug("drop_session during reindex failed vault=%s", vault_id, exc_info=True)
    # Windows often keeps the handle briefly after process exit.
    for i in range(6):
        await asyncio.sleep(0.35 + i * 0.1)


def _cli_child_env(vault_path: str, cfg: Any) -> dict[str, str]:
    """Build env for OHS CLI.

    Important: do **not** inherit the gateway's chat ``OPENAI_BASE_URL`` when the
    vault is in local embedding mode — OHS treats any ``OPENAI_BASE_URL`` as
    "use remote embeddings" and then logs ``fetch failed``.
    """
    from evoflow.knowledge.vault import secrets as vault_secrets
    from evoflow.knowledge.vault.models import EmbeddingMode
    from evoflow.knowledge.vault.runtime_resolve import resolve_kb_runtime_root

    env = {str(k): str(v) for k, v in os.environ.items() if v is not None}
    env["OBSIDIAN_VAULT_PATH"] = vault_path
    env.setdefault("OBSIDIAN_RESPECT_GITIGNORE", "true")
    if getattr(cfg, "ignore_patterns", None):
        env["OBSIDIAN_IGNORE_PATTERNS"] = str(cfg.ignore_patterns)

    hf_cache = str(resolve_kb_runtime_root() / "hf-cache")
    env.setdefault("TRANSFORMERS_CACHE", hf_cache)
    env.setdefault("HF_HOME", hf_cache)
    if not env.get("HF_ENDPOINT"):
        env["HF_ENDPOINT"] = "https://hf-mirror.com"

    mode = getattr(cfg, "embedding_mode", None)
    if mode == EmbeddingMode.openai_compatible:
        if getattr(cfg, "embedding_base_url", None):
            env["OPENAI_BASE_URL"] = str(cfg.embedding_base_url)
        if getattr(cfg, "embedding_model", None):
            env["OPENAI_EMBEDDING_MODEL"] = str(cfg.embedding_model)
        key = vault_secrets.get_secret(getattr(cfg, "embedding_api_key_secret_ref", None)) or ""
        if key:
            env["OPENAI_API_KEY"] = key
        elif env.get("OPENAI_BASE_URL"):
            env["OPENAI_API_KEY"] = "local-no-key"
    else:
        # Local Xenova — strip chat/LLM OpenAI vars so OHS does not call a remote API.
        for k in (
            "OPENAI_BASE_URL",
            "OPENAI_API_KEY",
            "OPENAI_EMBEDDING_MODEL",
            "OPENAI_API_BASE",
        ):
            env.pop(k, None)

    return env


def _is_benign_embedding_warning(line: str) -> bool:
    lower = str(line or "").lower()
    return "embedding api unavailable" in lower or (
        "semantic search and indexing disabled" in lower and "fulltext" in lower
    )


async def _run_cli_reindex(
    job: ReindexJob,
    vault_id: str,
    vault_path: str,
    *,
    force: bool,
    path: str | None,
) -> dict[str, Any]:
    from evoflow.knowledge.vault import store as vault_store

    root, _ = find_ready_kb_package_root()
    if root is None:
        root = preferred_install_root()
    cli = ohs_cli_js(root)
    node = resolve_node_binary()
    if not node or not cli.is_file():
        raise FileNotFoundError(f"OHS CLI unavailable (node={node!r}, cli={cli})")

    # Force recreate needs to unlink the vault DB; MCP stdio holds it open → EBUSY.
    await _release_vault_db_lock(vault_id, job)

    cfg = vault_store.require_vault_config(vault_id)
    cmd = [node, *ohs_node_import_args(root), str(cli), "reindex"]
    if path:
        cmd.append(path)
    if force and not path:
        cmd.append("--force")

    env = _cli_child_env(vault_path, cfg)
    mode = str(getattr(getattr(cfg, "embedding_mode", None), "value", cfg.embedding_mode) or "local")
    _append_log(job, f"embeddingMode={mode} (local strips inherited OPENAI_*; HF preload for mirror)")

    job.engine = "cli"
    job.phase = "starting"
    job.message = "启动本地索引引擎…"
    _append_log(job, " ".join(cmd))

    from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(root),
        env=env,
        **subprocess_hide_window_kwargs(),
    )

    async def _consume(stream: asyncio.StreamReader | None, *, is_err: bool) -> str:
        buf: list[str] = []
        if stream is None:
            return ""
        while True:
            line_b = await stream.readline()
            if not line_b:
                break
            line = line_b.decode("utf-8", errors="replace").rstrip()
            buf.append(line)
            if _is_benign_embedding_warning(line):
                _append_log(job, line)
                job.message = "语义 embedding 暂不可用，继续建全文索引…"
            elif is_err or _PROGRESS_RE.search(line) or _DONE_RE.search(line):
                _apply_progress_line(job, line)
            elif line:
                _append_log(job, line)
            job.touch()
        return "\n".join(buf)

    stdout_s, stderr_s = await asyncio.gather(
        _consume(proc.stdout, is_err=False),
        _consume(proc.stderr, is_err=True),
    )
    code = await proc.wait()
    combined = (stdout_s + "\n" + stderr_s).strip()
    if code != 0:
        raise RuntimeError(sanitize_text(combined[-1500:] or f"reindex exit={code}"))

    # Prefer structured JSON on stdout if present
    result: dict[str, Any] = {"ok": True, "engine": "cli", "log": sanitize_text(combined[-1500:])}
    for chunk in reversed(stdout_s.splitlines()):
        text = chunk.strip()
        if text.startswith("{") and "indexed" in text:
            try:
                import json

                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    result.update(parsed)
                    job.indexed = int(parsed.get("indexed") or job.indexed or 0)
                    job.skipped = int(parsed.get("skipped") or job.skipped or 0)
                    errs = parsed.get("errors") or []
                    job.error_count = len(errs) if isinstance(errs, list) else job.error_count
            except Exception:
                pass
            break
    return result


async def _run_mcp_reindex(job: ReindexJob, vault_id: str, *, force: bool, path: str | None) -> dict[str, Any]:
    from evoflow.knowledge.vault.provider import get_knowledge_provider

    job.engine = "mcp"
    job.phase = "mcp_reindex"
    job.message = "通过 MCP 重建索引（无细粒度进度，请等待）…"
    provider = get_knowledge_provider()
    from evoflow.knowledge.vault import store as vault_store
    from evoflow.knowledge.vault.mcp_runtime import call_tool, ensure_session
    from evoflow.knowledge.vault.paths import normalize_vault_relative_path

    cfg = vault_store.require_vault_config(vault_id)
    sess = await ensure_session(cfg)
    tool_name = "evo_kb_reindex" if "evo_kb_reindex" in sess.search_tools else "reindex"
    if tool_name not in sess.search_tools:
        for k in sess.search_tools:
            if k.endswith("reindex") or k == "reindex":
                tool_name = k
                break
    args: dict[str, Any] = {}
    if path:
        args["path"] = normalize_vault_relative_path(path)
    if force:
        args["force"] = True
    raw = await call_tool(sess.search_tools, tool_name, args, timeout_sec=600.0)
    status = await provider.status(vault_id)
    return {
        "ok": True,
        "engine": "mcp",
        "raw": str(raw)[:500],
        "status": status.model_dump(by_alias=True, mode="json"),
    }


async def _job_runner(job: ReindexJob, vault_path: str) -> None:
    from evoflow.knowledge.vault.provider import get_knowledge_provider

    job.state = "running"
    job.started_at = time.time()
    job.phase = "starting"
    job.message = "准备重建索引…"
    try:
        if job.run_install:
            from evoflow.knowledge.vault.mcp_runtime import install_packages

            job.engine = "setup"
            job.phase = "installing_packages"
            job.message = "正在安装检索组件（obsidian-hybrid-search，不是 Obsidian 应用）…"
            job.percent = 2

            def _progress(stage: Any) -> None:
                text = str(stage or "").strip()
                if text == "packages_already_ready":
                    job.message = "检索组件已就绪，跳过下载…"
                    job.percent = 8
                elif text == "ensuring_private_node":
                    job.message = "正在准备 Node 运行时（首次需下载，请稍候）…"
                    job.percent = 3
                elif text.startswith("downloading_node:"):
                    job.message = "正在下载 Node 运行时…"
                    job.percent = 4
                elif text == "installing_private_node":
                    job.message = "正在安装 Node 运行时…"
                    job.percent = 5
                elif text == "installing_private_packages":
                    job.message = "正在下载/安装检索组件（首次可能需几分钟，请稍候）…"
                    job.percent = 8
                elif text:
                    job.message = text
                job.touch()

            try:
                install_result = await install_packages(progress_cb=_progress)
                skipped = bool(install_result.get("skipped"))
                _append_log(
                    job,
                    "install skipped (already ready)"
                    if skipped
                    else f"install ok root={install_result.get('installRoot') or install_result.get('runtimeRoot')}",
                )
                job.message = "检索组件已就绪，开始建立索引…"
                job.percent = 10
            except Exception as install_exc:
                mapped = map_exception(install_exc)
                job.state = "error"
                job.phase = "error"
                job.error = sanitize_text(getattr(mapped, "message", str(mapped)))
                job.message = f"检索组件安装失败：{job.error}"
                logger.warning("setup install failed vault=%s: %s", job.vault_id, job.error)
                return

        try:
            result = await _run_cli_reindex(
                job,
                job.vault_id,
                vault_path,
                force=job.force,
                path=job.path,
            )
        except Exception as cli_exc:
            logger.warning("CLI reindex failed for %s, falling back to MCP: %s", job.vault_id, cli_exc)
            _append_log(job, f"CLI failed: {cli_exc}; fallback MCP")
            # Clear lock-related false positives from the failed CLI attempt.
            if "ebusy" in str(cli_exc).lower() or "resource busy" in str(cli_exc).lower():
                job.error_count = 0
            job.message = "本地 CLI 被文件锁挡住，改走 MCP 重建（进度较粗）…"
            result = await _run_mcp_reindex(job, job.vault_id, force=job.force, path=job.path)

        job.phase = "verifying"
        job.message = "核对索引状态…"
        status = await get_knowledge_provider().status(job.vault_id)
        job.result_status = status.model_dump(by_alias=True, mode="json")
        job.state = "done"
        job.phase = "done"
        job.percent = 100 if job.percent is None else job.percent
        idx_ok = job.result_status.get("indexInitialized")
        sem = job.result_status.get("semanticReady")
        notes = job.result_status.get("noteCount")
        # Status probe can lag (null) right after CLI rebuild; infer from job evidence.
        if sem is None and (job.indexed or 0) > 0:
            had_embed_fail = any(
                _is_benign_embedding_warning(x) or "fetch failed" in str(x).lower()
                for x in job.log_tail
            )
            if not had_embed_fail:
                sem = True
        parts = []
        if job.indexed is not None:
            parts.append(f"写入 {job.indexed}")
        if notes is not None:
            parts.append(f"笔记 {notes}")
        parts.append("全文已就绪" if idx_ok else "全文未确认就绪")
        parts.append("语义可用" if sem else "语义暂不可用（仍可全文搜索）")
        prefix = "初始化完成：" if job.run_install else "重建完成："
        job.message = prefix + " · ".join(parts)
        if isinstance(result, dict) and result.get("errors"):
            job.error_count = max(job.error_count, len(result.get("errors") or []))
    except Exception as exc:
        mapped = map_exception(exc)
        job.state = "error"
        job.phase = "error"
        job.error = sanitize_text(getattr(mapped, "message", str(mapped)))
        job.message = f"{'初始化' if job.run_install else '重建'}失败：{job.error}"
        logger.warning("reindex job failed vault=%s: %s", job.vault_id, job.error)
    finally:
        job.finished_at = time.time()
        job.touch()


async def start_reindex_job(
    vault_id: str,
    *,
    vault_path: str,
    path: str | None = None,
    force: bool = True,
    run_install: bool = False,
) -> ReindexJob:
    # Desktop installer does not ship ~700MB kb-mcp; first rebuild after clean
    # install / uninstall must npm-install into ~/.evoflow/runtime/kb-mcp.
    if not run_install:
        from evoflow.knowledge.vault.runtime_resolve import find_ready_kb_package_root

        ready_root, _ = find_ready_kb_package_root()
        if ready_root is None:
            run_install = True
            logger.info(
                "kb-mcp packages not ready; enabling install before reindex vault=%s",
                vault_id,
            )

    async with _LOCK:
        existing = _JOBS.get(vault_id)
        if existing and existing.state in ("queued", "running"):
            return existing
        job = ReindexJob(
            job_id=uuid.uuid4().hex[:12],
            vault_id=vault_id,
            force=force,
            path=path,
            run_install=bool(run_install),
            phase="installing_packages" if run_install else "queued",
            message=(
                "已排队：将安装检索组件并建索引"
                if run_install
                else "已排队"
            ),
        )
        _JOBS[vault_id] = job

    asyncio.create_task(_job_runner(job, vault_path), name=f"kb-reindex-{vault_id}")
    return job
