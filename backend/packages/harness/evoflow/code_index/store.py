"""SQLite FTS5 workspace index.

When indexing runs
------------------
- **Full rebuild (blocking API)**: ``POST /api/workspaces/index-build`` — runs in a worker thread on the gateway (HTTP waits until done).
- **Background rebuild (preferred for UI)**: ``POST /api/workspaces/index-warm`` — returns immediately; poll ``GET /api/workspaces/index-status``.
  Default implementation spawns a **subprocess** (``python -m evoflow.code_index.build_worker``)
  so sentence-transformers / sklearn imports cannot GIL-stall the Gateway event loop.
  Set ``EVOFLOW_CODE_INDEX_BUILD_INPROCESS=1`` only for tests that monkeypatch ``build_index``.
- **Incremental**: ``POST /api/workspaces/index-file`` or the background watcher after file changes.
- **Watcher**: ``POST /api/workspaces/index-watch`` (EvoPanel starts after initial build).
- **Lazy**: first search if no DB exists.
- **Throttle**: full rebuild skipped if indexed within ``reindex_min_interval_seconds``.

Where data is stored
--------------------
- Directory: ``<workspace>/.evoflow/code_index/`` (gitignored with the rest of ``.evoflow/``).
- One SQLite file per workspace: ``index.db`` (+ WAL sidecars).
- Tables: ``fts_content`` (FTS5), ``symbols``, ``file_deps``, ``internal_refs``, ``type_relations``, ``meta``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import uuid
from collections import defaultdict
from collections.abc import Callable, Sequence
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Protocol, TypeVar

from evoflow.code_index.deps import (
    dependency_neighbors,
    extract_file_deps,
    list_importers,
    list_outgoing_imports,
)
from evoflow.code_index.symbols import extract_symbols
from evoflow.code_index.tokenize import build_fts_aux_text, index_tokenizer_version, tokens_from_text
from evoflow.config.code_index_config import CodeIndexConfig, get_code_index_config
from evoflow.utils.workspace_browse import resolve_under_workspace

logger = logging.getLogger(__name__)

# 【self-evolution-bot · 2026-11-18 · 第50轮 · 模型:deepseek-v4.1-flash-1017】
# 嵌入冷启闸门。为什么需要：Windows 上网关**默认跳过**嵌入暖机
# （background_startup: `win32 default (set EVOFLOW_EMBEDDING_WARMUP=1 to enable)`），
# 于是 torch / sentence_transformers 的冷导入与权重加载全部落在**第一次检索**的调用栈里。
# 本机实测：`import local_provider` 3030ms + 首次 `embed_sync` 1669ms，之后每次 3~4ms；
# 叠加 torch 惰性子模块的首次 encode 初始化，首次检索 9~13s，网关并发时撞满
# `_MAX_WALL_SECONDS=45` 直接超时（2026-11-18 17:50 现网复现 45021ms error）。
# 修法：门未开时**不 import、不加载**，本次直接返回纯词法结果（几百 ms），
# 后台单飞线程暖机；暖成功后自动开门，下一次检索就用上语义召回。
# 为什么不改成「启动就暖」：那是平台侧行为（改所有 agent 重启后的 GIL 占用），
# 且 win32 跳过暖机是修另一事故留下的决定，不在本岗单方面推翻。
_embed_gate_lock = threading.Lock()
_embed_gate_open = False        # False=本进程尚未确认嵌入可用，走纯词法
_embed_warm_last_try = 0.0      # 上次暖机尝试的时间戳（0=从未）
_EMBED_WARM_RETRY_S = 300.0     # 暖机失败后的重试冷却，避免每次检索都起线程重试
# 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
# 本次调用「语义为何没参与」的旁路记录。用 thread-local：检索是同步调用、
# 同线程内 start→collect 成对；且不必给 _embed_query_sync 加参数（那会破坏
# 既有 monkeypatch 契约，实测 3 个测试当场红）。
_DEGRADE_STATE = threading.local()


def _embed_ready_without_import() -> bool:
    """不 import 嵌入栈，只看模型是否**已经**在本进程里加载好。

    为什么这么绕：判定「能不能语义检索」最便宜的办法是查 `_model_cache`，
    但拿到它得先 import local_provider = 3030ms（实测），等于为了省一次冷启
    再付一次冷启。模块已在 sys.modules 时直接查，已加载就开门。
    """
    mod = sys.modules.get("evoflow.knowledge.embedding.local_provider")
    if mod is None:
        return False
    return bool(getattr(mod, "_model_cache", None))


def _start_embed_warmup() -> None:
    """后台单飞暖机：只起一个线程，失败只在冷却后重试，绝不阻塞检索。"""
    global _embed_warm_last_try
    now = time.time()
    with _embed_gate_lock:
        if _embed_warm_last_try and now - _embed_warm_last_try < _EMBED_WARM_RETRY_S:
            return
        _embed_warm_last_try = now

    def _run() -> None:
        global _embed_gate_open
        try:
            from evoflow.knowledge.embedding.local_provider import (
                LocalEmbeddingProvider,
                warmup_local_model,
            )
            from evoflow.knowledge.embedding.registry import (
                _resolve_provider,
                get_embedding_config,
            )

            provider = _resolve_provider(get_embedding_config())
            if not isinstance(provider, LocalEmbeddingProvider):
                return  # 远端 provider：不在这里暖，保持原行为
            warmup_local_model(provider.model_name)
            _embed_gate_open = True
        except Exception as exc:  # noqa: BLE001 - 暖机失败只降召回质量，不该打断检索
            logger.warning(
                "code_index: 嵌入暖机失败，检索暂时退回纯词法：%s: %s",
                type(exc).__name__,
                exc,
            )

    threading.Thread(
        target=_run,
        name="evoflow-code-index-embed-warmup",
        daemon=True,
    ).start()



T = TypeVar("T")

# Porter stemmer hurts code identifiers (CredentialPool, assistant_chunk). unicode61 keeps them.
_FTS_TOKENIZE = "unicode61 remove_diacritics 0 tokenchars '_-./'"
_FTS_SCHEMA_VERSION = "unicode61_v2"
_BUILD_BATCH_SIZE = 50

# Relative to the bound workspace root (same layout as project memory under ``.evoflow/``).
CODE_INDEX_REL_DIR = Path(".evoflow") / "code_index"
CODE_INDEX_DB_NAME = "index.db"

_SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    "_next",  # Next.js export (out/_next/static/chunks) — minified bundles, not source
    "target",
    "binaries",
    "_internal",
    # 【self-evolution-bot · 2026-11-17 · 第32轮】删掉 "code_index" 条目。
    # 原注释意图是「不索引索引库自身」，但索引库在 <root>/.evoflow/code_index/，
    # 那个 "code_index" 片段的上层是 ".evoflow"，早已被下面的 p.startswith(".") 挡掉；
    # 这一条真正拦掉的是**索引器自己的源码目录** backend/packages/harness/evoflow/code_index/，
    # 导致 15 个源文件（store.py / symbols.py / tree_sitter_core.py …）0 行入库，
    # 实测搜 "_read_persisted_build_progress" 搜不到它自己的定义。
    # 索引库不会被误收：_TEXT_SUFFIXES 不含 .db，且 .evoflow/ 仍被点目录规则排除。
}
_TEXT_SUFFIXES = {
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".java",
    ".go",
    ".kt",
    ".rs",
    ".md",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".sql",
    ".html",
    ".css",
    ".scss",
    ".sh",
    ".ps1",
    ".vue",
    ".cs",
    ".cpp",
    ".h",
    ".hpp",
    ".c",
}


def resolve_index_root(
    *,
    workspace_root: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Resolve absolute workspace directory for indexing (local root or thread sandbox)."""
    root_s = str(workspace_root or "").strip()
    if root_s:
        return str(resolve_under_workspace(root_s, "."))
    tid = str(thread_id or "").strip()
    if tid:
        from evoflow.tools.host_direct.workspace_context import resolve_host_workspace_root_for_files

        host = resolve_host_workspace_root_for_files(thread_id=tid)
        if host:
            return str(resolve_under_workspace(host, "."))
        from evoflow.config.paths import get_paths

        sandbox = get_paths().sandbox_work_dir(tid)
        sandbox.mkdir(parents=True, exist_ok=True)
        return str(sandbox.resolve())
    raise ValueError("workspace_root or thread_id is required")


def _workspace_hash(root: str) -> str:
    return hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:16]


def index_db_path(workspace_root: str) -> Path:
    """SQLite index file for a resolved workspace root: ``<root>/.evoflow/code_index/index.db``."""
    root = Path(workspace_root).resolve()
    base = root / CODE_INDEX_REL_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base / CODE_INDEX_DB_NAME


def _db_path(root: str) -> Path:
    return index_db_path(root)


def index_freshness(root: str) -> dict:
    """索引库最后写入时刻与年龄（秒）。

    【self-evolution-bot · 2026-11-17 · 第33轮】用户问「搜索的时效性你能看到吗」——
    实测**看不到**：`search_index` 的返回里只有 `rebuild_in_progress`，
    而 `format_results` 只在「正在构建」时打一行 stale 提示；
    `index_status` 虽有 `updated_at`/`stale_reasons`，但那是 /index-status 接口用的，
    不随工具结果返回。于是判断「这份结果可不可信」只能额外跑一次 sqlite 手查
    （实测查一次要 index_age≈5 分钟），等于每次多绕一步，多数时候就不绕了。
    现在把新鲜度直接挂进搜索结果，让调用方一眼看到「这份索引几岁」。
    """
    dbp = _db_path(root)
    try:
        mtime = dbp.stat().st_mtime
    except OSError:
        return {
            "index_updated_at": None,
            "index_age_seconds": None,
            "index_source_drift": None,
        }
    age = max(0, int(time.time() - mtime))
    return {
        "index_updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)),
        "index_age_seconds": age,
        # 【self-evolution-bot · 2026-11-17 · 第38轮】index_age 只说明「库多久前被写过」，
        # 不说明「库里的代码是不是当前的」：用户刚新建的文件照样 0 行在库里，
        # 而上面这个 age 还是 481s 看着很新。源码漂移必须单独测（见 source_drift）。
        "index_source_drift": _source_drift_cached(root, mtime),
    }


# ---- 源码漂移检测（代码改了但索引没跟上）------------------------------------
# 【self-evolution-bot · 2026-11-17 · 第38轮】为什么需要它：
# 实测（本轮探针）——22:39 新建 `outputs/probe_freshness_zzq.py`，带唯一符号
# `zzq_freshness_probe_marker_2026`，查它：fts_content 0 行、symbols 0 行，
# 工具却照样返回 24 条拆词凑出来的结果，头一行还写 `age=475s`（看着很新）。
# 根因链有三层，缺一层都不至于这么静默：
#   1) `watcher_enabled=False`（默认）→ 没人监听文件改动，`watching: false`；
#   2) `schedule_build_index` / `build_index` 见 `ready=True` 直接
#      `skipped: index_ready` 返回 → 永远不重建；
#   3) `stale_reasons` 只查 `max_files` 上限与 `code_vec` 行数，
#      **从不看源码内容是否变过** → 源文件改了也报 ready=True/[]。
# 于是「索引过期」在工具输出里完全不可见，只能靠人想起来手查 sqlite。
_DRIFT_CACHE: dict[str, tuple[float, dict]] = {}
_DRIFT_CACHE_TTL_SECONDS = 30.0
# 【self-evolution-bot · 2026-11-18 · 第46轮 · 模型:qwen3.8-flash】漂移自愈的两条闸：
# 一次补录最多吃多少个文件、同一根目录多久才允许再补一轮。
# 判据（本轮现网实测，别拿"单文件 2~10ms"的老数字定预算）：
# 本机 semantic_search_enabled=true，index_file 单文件要切块 + 嵌入，实测 **2.5s/个**
# （11 个 28.1s，含首次载入嵌入权重）。而增量通道 _HOOK_POOL 只有 1 个 worker，
# 预算给到 80 = 一次独占后台池 ~200s，会把 write/edit 工具的增量入库排在队尾。
# 给 24：单轮最坏 ~1 分钟，与 120s 冷却配合，常态漂移（几~十几个文件）一轮清完。
_DRIFT_PATH_CAP = 400
_CATCHUP_BUDGET_FILES = 24
_CATCHUP_COOLDOWN_SECONDS = 120.0
_drift_catchup_cooldown: dict[str, float] = {}


def _rel_path_prefix(root_path: Path) -> str:
    """相对路径比较用的根前缀（统一分隔符、去掉尾斜杠）。"""
    return str(root_path).replace(os.sep, "/").rstrip("/")


def _relative_source_path(p: Path, root_prefix: str) -> str | None:
    """把磁盘文件路径转成索引里存的那种相对路径（``a/b.py``）。

    【self-evolution-bot · 2026-11-17 · 第39轮 · 模型:deepseek-v4.1-flash-1017】
    为什么不用 ``Path.relative_to(...).as_posix()``：这段循环对本仓 8.4k 个文件
    逐个调用，实测 relative_to + as_posix 合计 **167~231ms**，是 source_drift 里
    第二大的开销（仅次于遍历磁盘 ~290ms），而它做的事只是「砍掉一个已知前缀」。
    改成前缀比较 + 切片后实测 **2~4ms（-98%）**，两法输出的相对路径集合
    逐条比对 8429/8429 完全一致。这个结果由
    ``tests/test_code_index_search_open_cheap.py`` 直接调本函数与 pathlib 对拍守住。

    语义与改造前严格一致：
      · 路径以 ``root_prefix/`` 开头 → 去掉该前缀；
      · 路径正好等于 root 本身 → 返回 None（原实现 relative_to 得 ``"."``，会被
        ``as_posix()`` 变成 ``"."`` 当作一个文件记进 seen，属噪声；这里返回 None 由
        调用方 continue，行为差异仅在「根目录自身」这种不可能是文件的输入上）；
      · 其它（不在根下）→ 返回原串，与原实现 ``except ValueError: continue`` 相比
        是**更保守**的选择：宁可用绝对路径参与集合比较，也不静默丢掉一个真实文件。
    """
    sp = str(p).replace(os.sep, "/")
    if sp.startswith(root_prefix + "/"):
        return sp[len(root_prefix) + 1 :]
    if sp == root_prefix:
        return None
    return sp


def source_drift(root: str, *, since_ts: float | None = None) -> dict:
    """相对索引构建时刻，有多少文件被改动 / 新增 / 删除。

    【self-evolution-bot · 2026-11-17 · 第38轮】第一版只遍历「库内已有 path」逐条 stat，
    实测对本轮探针直接失效：探针文件是**新建**的，压根不在库里，于是 modified=0 deleted=0
    —— 用户最常遇到的「我刚写的文件搜不到」恰好被这个盲区放过了。
    所以必须走全仓 `_iter_source_files` 拿磁盘现状，再与库内 path 做双向差集：
      · 磁盘有 + 库里有 + mtime 比库新 → changed
      · 磁盘有 + 库里没有            → added
      · 库里有 + 磁盘没有            → deleted
    代价实测：walk 333ms + 取 path 84ms ≈ 420ms，所以外面必须套缓存。
    """
    dbp = _db_path(root)
    if since_ts is None:
        try:
            since_ts = dbp.stat().st_mtime
        except OSError:
            return {"changed": 0, "added": 0, "deleted": 0, "total": 0,
                    "added_paths": [], "changed_paths": [], "deleted_paths": []}
    root_path = Path(root)
    cfg = get_code_index_config()
    try:
        conn = _connect(root)
    except Exception:
        return {"changed": 0, "added": 0, "deleted": 0, "total": 0,
                "added_paths": [], "changed_paths": [], "deleted_paths": []}
    try:
        rows = conn.execute("SELECT path FROM fts_content").fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()
    indexed = {str(rel).replace(os.sep, "/") for (rel,) in rows}
    try:
        disk_files = _iter_source_files(root_path, cfg.max_files)
    except Exception:  # noqa: BLE001
        disk_files = []
    changed = 0
    added = 0
    seen: set[str] = set()
    # 【self-evolution-bot · 2026-11-18 · 第46轮 · 模型:qwen3.8-flash】
    # 第38轮只做了「让漂移可见」，明写没做自愈。本轮补自愈时必须知道**具体是哪些文件**，
    # 光有计数没法增量补录。路径清单封顶 _DRIFT_PATH_CAP：补录每轮只吃这些，
    # 剩余留给下一轮（避免一次检索被几千个文件拖死），且内存有界。
    path_cap = _DRIFT_PATH_CAP
    added_paths: list[str] = []
    changed_paths: list[str] = []
    root_prefix = _rel_path_prefix(root_path)
    for p in disk_files:
        rel = _relative_source_path(p, root_prefix)
        if rel is None:
            continue
        seen.add(rel)
        if rel not in indexed:
            added += 1
            if len(added_paths) < path_cap:
                added_paths.append(rel)
            continue
        try:
            if p.stat().st_mtime > since_ts + 1.0:
                changed += 1
                if len(changed_paths) < path_cap:
                    changed_paths.append(rel)
        except OSError:
            continue
    gone = indexed - seen
    deleted = len(gone)
    return {
        "changed": changed,
        "added": added,
        "deleted": deleted,
        "total": len(seen),
        "added_paths": added_paths,
        "changed_paths": changed_paths,
        "deleted_paths": sorted(gone)[:path_cap],
    }


def _spawn_drift_refresh(root: str, key: str, db_mtime: float) -> None:
    """后台重算漂移结论，**绝不占检索线程**。

    【self-evolution-bot · 2026-11-19 · 第62轮 · 模型:deepseek-v4.1-flash-1017】
    同一 root 同时只跑一个刷新；用函数自身属性做 inflight 集合，不新增模块级状态
    （模块级状态要额外的重置路径，本仓已因此踩过坑）。

    失败一律吞掉：漂移是尽力而为的旁路信息，后台刷新挂了就继续用旧值，
    绝不能因为「算漂移」把检索搞挂。
    """
    lock = getattr(_source_drift_cached, "_lock", None)
    if lock is None:
        lock = threading.Lock()
        _source_drift_cached._lock = lock
    inflight = getattr(_source_drift_cached, "_inflight", None)
    if inflight is None:
        inflight = set()
        _source_drift_cached._inflight = inflight
    with lock:
        if root in inflight:
            return
        inflight.add(root)

    def _run() -> None:
        try:
            drift = source_drift(root, since_ts=db_mtime)
            _DRIFT_CACHE[key] = (time.time(), drift)
            if len(_DRIFT_CACHE) > 8:
                oldest = min(_DRIFT_CACHE, key=lambda k: _DRIFT_CACHE[k][0])
                _DRIFT_CACHE.pop(oldest, None)
        except Exception:  # noqa: BLE001 - 后台刷新失败就沿用旧值
            pass
        finally:
            with lock:
                inflight.discard(root)

    threading.Thread(
        target=_run, name="code-index-drift-refresh", daemon=True
    ).start()


def _source_drift_cached(
    root: str, db_mtime: float, *, allow_stale: bool = True
) -> dict | None:
    """`source_drift` 的进程内缓存（默认 30s），避免每次检索白花 ~230ms。

    缓存键含库 mtime：一旦有增量写库（`index_file`）mtime 变化即自动失效，
    不会出现「刚补完索引仍报漂移」的假警报。

    【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    但 mtime 必须**粗化**，原来带的是秒级精度 —— 而建库每批（约 1s）就 commit 一次，
    于是构建期间 mtime 每秒都变，缓存 100% 不命中，等于没有缓存。
    实测（同一进程连续 3 次 search_index）：`index_freshness` 分别
    290ms / 513ms / 297ms，全部是重新 walk 7839 个文件；
    构建期它占检索总耗时的 10%+，而这份漂移信息这 30 秒内根本没变。
    粗化到 60s 桶：真正的增量写库最多晚 60s 才让缓存失效（TTL 30s 本来也在这量级），
    构建期间则稳定命中，省掉每次 290~500ms。

    【self-evolution-bot · 2026-11-19 · 第62轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：缓存未命中时**不再同步 walk 全树**，改为「先返回本 root 上一次的结论
    （哪怕是旧桶），同时起一个后台线程重算」。`allow_stale=False` 才同步算。

    为什么：缓存 TTL 30s、桶 60s，意味着**每 30~60 秒必有一次检索要付全树 stat**。
    本机实测（7894 个可索引文件）：
      · `_iter_source_files` 单次 398ms，其中 17558 次 `nt.stat`
      · 冷缓存 `index_freshness` 322ms，更早一次量到 2251ms（磁盘冷）
      · 热缓存 0ms
    而现网 `search_code_index` 的 P50 是 **6.5s**、P90 13.9s（近 1 天 77 次），
    用户体感就是「搜个代码要转六秒」。把 0.3~2.2s 的同步 walk 挪出主路，
    直接砍掉这一段。

    代价（必须明写，不能只说好处）：漂移信息最多晚一次刷新才更新，即
    「刚改的文件，页脚要下一次检索才提示未索引」。这本来只影响**提示文字**，
    不影响命中结果——真正的增量入库走 `notify_file_changed` / hooks 那条通道，
    与漂移检测互不相干；而且第 46 轮已把补录投到后台池，本来就不会当次完成。
    所以这里牺牲的只是「提示的即时性」，换来的是确定可省的同步阻塞。

    为什么用**函数属性**存 inflight 集合而不是模块级变量：模块级状态要额外的
    重置路径（测试里已多次因为「模块级缓存没清」造成跨用例污染），
    函数属性跟着函数走，`delattr` 即可复位。
    """
    key = f"{root}\u0000{int(db_mtime // 60)}"
    now = time.time()
    hit = _DRIFT_CACHE.get(key)
    if hit is not None and now - hit[0] < _DRIFT_CACHE_TTL_SECONDS:
        return hit[1]

    if allow_stale:
        # 本 root 任意桶的旧结论都可用：漂移是「旁路提示」，旧值远好过阻塞。
        prefix = f"{root}\u0000"
        prev = None
        for k, v in _DRIFT_CACHE.items():
            if k.startswith(prefix) and (prev is None or v[0] > prev[0]):
                prev = v
        if prev is not None:
            _spawn_drift_refresh(root, key, db_mtime)
            return prev[1]
        # 本 root 一次都没算过（进程刚起）：同步算这一次，否则首次检索会
        # 丢掉全部漂移提示，等于用「信息静默消失」换速度——那是另一种降级。
        # 之后每次过期都走「旧值 + 后台刷新」，不再阻塞检索。先算出结果再往下走。

    try:
        drift = source_drift(root, since_ts=db_mtime)
    except Exception:  # noqa: BLE001 - 漂移检测是尽力而为，绝不能拖垮检索
        return None
    _DRIFT_CACHE[key] = (now, drift)
    if len(_DRIFT_CACHE) > 8:
        oldest = min(_DRIFT_CACHE, key=lambda k: _DRIFT_CACHE[k][0])
        _DRIFT_CACHE.pop(oldest, None)
    return drift


def _purge_drift_cache(root: str) -> None:
    """丢掉本 root 的全部漂移缓存（补录后必须重测，不做「计数减法」骗过页脚）。"""
    prefix = f"{root}\u0000"
    for k in [k for k in _DRIFT_CACHE if k.startswith(prefix)]:
        _DRIFT_CACHE.pop(k, None)


def _schedule_drift_catchup(root: str, *, st: dict) -> dict:
    """源码漂移自愈：把「磁盘有、库里没有/不新」的文件增量补录。

    【self-evolution-bot · 2026-11-18 · 第46轮 · 模型:qwen3.8-flash】为什么必须存在：
    第38轮只做了一半 —— 漂移**可见**（工具首行报 `N new file(s) not indexed`），
    但 `search_index` 的自愈触发条件是 `not st["ready"]`，而 ready 判定
    （`stale_reasons`：只看 max_files 上限与向量覆盖率）**从不看源码内容**，
    于是稳态下每次检索都跳过重建 → 报出来的 stale 永远修不掉。
    实测坐实（本机 2026-11-18）：config.yaml 里 `auto_index_on_search`/
    `watcher_enabled` 都是 true，但 `start_index_watch` 只有面板接口会调，
    进程重启后没人拉起；17:05 之后没有任何 build_worker 存活，
    新建文件连续两次检索（间隔 100s）都搜不到，页脚 stale 从 7 涨到 8。

    为什么走**单文件增量**而不是重建：`index_file` 与 watcher 同一条入口
    （含 .gitignore / skipped-segment 过滤），代价 2~10ms/文件；全量重建要 30 分钟
    且会重烧向量段，为几个新文件烧全仓是把用户当矿工。

    判据与护栏：
    · 构建中让路（`st["building"]`）—— 不跟 build_worker 抢 sqlite 写锁；
    · 单轮最多 `_CATCHUP_BUDGET_FILES` 个，剩余留给下一轮（冷却 120s）；
    · **补录动作不在本函数里跑**，投递到 hooks 的增量线程池。
      为什么（本轮现网实测，差点把修好的东西变成新的坑）：
      本机 `semantic_search_enabled=true`，`index_file` 每补一个文件要切块 + 嵌入，
      11 个文件实测 **28.1s**（含首次载入嵌入模型权重）。挂在检索主路上
      等于「为了自愈，让这一下搜索卡半分钟」，比原来搜不到更糟。
      走后台池的代价是「刚写的文件下一次（通常几秒后）才搜得到」，
      而 write/edit 工具本身已接 `notify_file_changed`（同一条增量通道）当场入库，
      漂移主要来自 git 检出/外部改动，这类不需要当次就能搜到。
    · 补完必须 `_purge_drift_cache`，否则页脚会在 30s TTL 内继续报已消失的漂移。
    """
    if st.get("building"):
        return {"ok": True, "status": "skipped", "reason": "building"}
    now = time.time()
    last = _drift_catchup_cooldown.get(root)
    if last is not None and now - last < _CATCHUP_COOLDOWN_SECONDS:
        return {"ok": True, "status": "skipped", "reason": "cooldown"}
    dbp = _db_path(root)
    try:
        mtime = dbp.stat().st_mtime
    except OSError:
        return {"ok": True, "status": "skipped", "reason": "no_db"}
    drift = _source_drift_cached(root, mtime)
    if not drift:
        return {"ok": True, "status": "skipped", "reason": "no_drift_data"}
    added = list(drift.get("added_paths") or [])
    changed = list(drift.get("changed_paths") or [])
    deleted_n = int(drift.get("deleted") or 0)
    if not (added or changed):
        # deleted 故意不自动清库：source_drift 的 deleted = 「库里有、磁盘遍历没看见」。
        # 一旦 root 解析口径与建库时不一致（thread 映射 / 符号链接 / 部分目录不可读），
        # 整库都会被算成已删除，自愈就会变成自毁。删除交给 watcher 与下次全量重建。
        return {"ok": True, "status": "skipped", "reason": "no_add_change",
                "deleted_seen": deleted_n}
    _drift_catchup_cooldown[root] = now

    queue = (added + changed)[:_CATCHUP_BUDGET_FILES]
    # 延迟 import：hooks 顶层就 import 了本模块，放模块顶会成环。
    from evoflow.code_index import hooks as _hooks

    _hooks._HOOK_POOL.submit(_run_drift_catchup, root, queue)
    return {
        "ok": True,
        "status": "queued",
        "queued": len(queue),
        "remaining_added": max(0, len(added) - len(queue)),
        "deleted_seen": deleted_n,
    }


def _run_drift_catchup(root: str, queue: list[str]) -> int:
    """后台池里真正跑补录的循环（与 watcher 同一条增量通道、同一判据）。"""
    done = 0
    for rel in queue:
        try:
            r = index_file(root, relative_path=rel)
            if r.get("ok") and str(r.get("action") or "") != "skipped":
                done += 1
        except Exception:  # noqa: BLE001 - 单个文件失败不能带走整轮补录
            logger.debug("drift catch-up failed for %s", rel, exc_info=True)
    # 补录写了库 → 缓存必须作废重测。不 purge 的话：写入落在同一个 60s
    # mtime 桶里时缓存键不变，页脚会继续报已经消失的漂移（假警报）。
    _purge_drift_cache(root)
    if done:
        logger.info(
            "code_index: 漂移自愈补录 %d 个文件，root=%s",
            done,
            root,
        )
    return done


def _configure_sqlite_connection(conn: sqlite3.Connection) -> None:
    """Match main app DB pragmas so searches survive background index builds."""
    conn.execute("PRAGMA busy_timeout=60000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    # 【self-evolution-bot · 2026-11-17 · 第39轮 · 模型:deepseek-v4.1-flash-1017】
    # 为什么加：本仓索引库已到 1.0GB（code_vec 向量段 644MB），而 vec0 的 KNN
    # 在 Windows 上对 mmap 极敏感。同一进程同一批 query 交替 A/B 实测：
    #   search_index 整体   无 mmap 427ms → mmap 353ms（-21%，4 组交替取中位）
    #   vec0 KNN 单段       embed 6.4ms 不变，KNN 374ms → 66ms（-82%）
    # 语义召回那段几乎全是它，所以不映射就每次白等 0.3s。
    # 与 persistence/db.py 的同名 pragma 写法一致（那边 256MB，因主库更小），
    # 失败一律吞掉——映射是纯优化，绝不能让它挡住检索。
    #
    # 【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：上限从写死 1GiB 改成「按库实际大小取整 + 512MiB 余量」。
    # 为什么：写死 1GiB 的前提是「库当前 999MB 刚好整库可映射」，而这条前提早在
    # 库长到 1.72GB 时就失效了——**超上限不报错，只是静默退化成部分映射**，
    # 于是向量段有 42% 读不到映射，没人会发现。
    # 同一进程同一份向量、同一台机，只改 mmap 大小的 A/B（k=75）：
    #   1GiB(现状) 300ms / 2GiB 91ms / 3GiB 89ms / 关掉 646ms
    # → 现状比整库可映射慢 3.3 倍，且这不是某次调用，是**每次检索都付**。
    _target = 1073741824
    try:
        _page = int(conn.execute("PRAGMA page_size").fetchone()[0] or 4096)
        _pages = int(conn.execute("PRAGMA page_count").fetchone()[0] or 0)
        _db_bytes = _page * _pages
        if _db_bytes > 0:
            _target = max(_target, _db_bytes + (512 << 20))
    except Exception:  # noqa: BLE001 - 纯优化，任何失败都退回固定值
        pass
    try:
        conn.execute(f"PRAGMA mmap_size={int(_target)}")
    except Exception:  # noqa: BLE001 - 纯优化，任何失败都退回普通读
        pass
    _load_sqlite_vec_extension(conn)


def _load_sqlite_vec_extension(conn: sqlite3.Connection) -> None:
    """Best-effort load of the ``sqlite-vec`` extension for vec0 vector table."""
    global _SQLITE_VEC_LOAD_WARNED, _SQLITE_VEC_AVAILABLE  # noqa: PLW0603
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        conn.load_extension(sqlite_vec.loadable_path())
        _SQLITE_VEC_AVAILABLE = True
    except Exception as exc:  # noqa: BLE001 - optional, must never block
        _SQLITE_VEC_AVAILABLE = False
        logger.debug("code_index: sqlite-vec extension not loaded: %s", exc)
        # 【self-evolution-bot · 2026-11-16 · 第23轮】P2 可见性（判定单 §四）：
        # 为什么：静默降级曾导致「code_vec 建好却 0 行」类问题无人察觉；
        # 首次失败升级 WARNING 一次（进程内），index_status 暴露 vector_available。
        if not _SQLITE_VEC_LOAD_WARNED:
            _SQLITE_VEC_LOAD_WARNED = True
            logger.warning(
                "code_index: sqlite-vec extension failed to load (semantic vector recall disabled): %s",
                exc,
            )


_SQLITE_VEC_LOAD_WARNED = False
_SQLITE_VEC_AVAILABLE: bool | None = None


def _sqlite_vec_available(conn: sqlite3.Connection) -> bool:
    """Whether vec0 module is actually usable on this connection (probe once, cache)."""
    global _SQLITE_VEC_AVAILABLE  # noqa: PLW0603
    if _SQLITE_VEC_AVAILABLE is not None:
        return _SQLITE_VEC_AVAILABLE
    try:
        row = conn.execute("SELECT COUNT(*) FROM pragma_module_list WHERE name='vec0'").fetchone()
        _SQLITE_VEC_AVAILABLE = bool(row and int(row[0]) > 0)
    except Exception:  # noqa: BLE001 - health probe must never break status
        _SQLITE_VEC_AVAILABLE = False
    return _SQLITE_VEC_AVAILABLE


_SEARCH_CONN_POOL: dict[str, list[sqlite3.Connection]] = {}
_SEARCH_CONN_POOL_LOCK = threading.Lock()
_SEARCH_CONN_POOL_MAX = 8


class _search_conn_scope:
    """Reuse one sqlite connection across consecutive ``search_index`` calls.

    【self-evolution-bot · 2026-11-19 · 第64轮 · 模型:deepseek-v4.1-flash-1017】

    改了什么：``search_index`` 每次调用都 ``_connect()`` 新建连接、用完 ``close()``。
    现在按 workspace 从进程内池里借/还同一条连接。

    为什么（本轮同进程实测，2026-11-19，库 1.84GB / code_vec 119153 行）：
      · **同一个新连接**的首次 vec0 KNN = **362.9ms**，第二次起 **90.2ms**（4 倍）；
        用一条已用过的连接直接跑，P50 **91.7ms**。
      · 逐段打点 ``search_index``（751.6ms 里）：``semantic_recall`` 570.6ms
        + ``final_close`` 172.5ms = **99%**，而语义召回单独量只要 112ms。
      · 差额全部来自「新连接的页缓存还没被 KNN 摸热」——不是 KNN 算法、不是 k 值
        （k=15/30/75 实测 91/93/91ms，几乎一样）。
      · ``final_close`` 那 172ms 是关闭带 WAL 的连接时回写/解映射。

    边界（重要）：
    · 只**复用**连接，不缓存任何查询结果——语义、排序、命中数一律照旧重算；
    · 连接池按 workspace root 分键，不同仓库绝不共用一个连接；
    · 池里的连接在归还时**不 close**，进程退出时由 GC 兜底（sqlite3 连接析构即关）；
    · 借出的连接若处于事务中（``in_transaction``）则不归还入池，直接 close，
      避免半截事务被下一个调用继承；
    · 任何异常都退回「新建连接」，池只是加速，不能成为新的失败点。
    """

    __slots__ = ("root", "conn", "_from_pool")

    def __init__(self, root: str) -> None:
        self.root = root
        self.conn: sqlite3.Connection | None = None
        self._from_pool = False

    def __enter__(self) -> sqlite3.Connection:
        key = str(self.root or "")
        pooled: sqlite3.Connection | None = None
        try:
            with _SEARCH_CONN_POOL_LOCK:
                bucket = _SEARCH_CONN_POOL.get(key)
                while bucket:
                    cand = bucket.pop()
                    try:
                        cand.execute("SELECT 1").fetchone()
                        pooled = cand
                        break
                    except Exception:  # noqa: BLE001 - 坏连接直接丢弃
                        try:
                            cand.close()
                        except Exception:  # noqa: BLE001
                            pass
        except Exception:  # noqa: BLE001
            pooled = None
        if pooled is not None:
            self.conn = pooled
            self._from_pool = True
            return pooled
        self.conn = _connect(self.root)
        self._from_pool = False
        return self.conn

    def __exit__(self, *_exc: object) -> bool:
        conn = self.conn
        self.conn = None
        if conn is None:
            return False
        reusable = True
        try:
            if conn.in_transaction:
                reusable = False
        except Exception:  # noqa: BLE001
            reusable = False
        if reusable:
            try:
                with _SEARCH_CONN_POOL_LOCK:
                    bucket = _SEARCH_CONN_POOL.setdefault(str(self.root or ""), [])
                    if len(bucket) < _SEARCH_CONN_POOL_MAX:
                        bucket.append(conn)
                        return False
            except Exception:  # noqa: BLE001 - 入池失败就走关闭
                pass
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
        return False


def _connect(root: str) -> sqlite3.Connection:
    dbp = _db_path(root)
    dbp.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(dbp), timeout=60.0)
    conn.row_factory = sqlite3.Row
    _configure_sqlite_connection(conn)
    return conn


_workspace_locks_guard = threading.Lock()
_workspace_locks: dict[str, threading.RLock] = {}


def _workspace_db_lock(root: str) -> threading.RLock:
    key = _workspace_hash(root)
    with _workspace_locks_guard:
        lock = _workspace_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _workspace_locks[key] = lock
        return lock


def _is_sqlite_busy(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "locked" in msg or "busy" in msg


def run_index_db[T](root: str, fn: Callable[[], T], *, max_attempts: int = 10) -> T:
    """Serialize index DB access per workspace + retry on sqlite busy/locked."""
    lock = _workspace_db_lock(root)
    last: BaseException | None = None
    for attempt in range(max(1, int(max_attempts))):
        with lock:
            try:
                return fn()
            except sqlite3.OperationalError as exc:
                last = exc
                if not _is_sqlite_busy(exc):
                    raise
        if attempt >= max_attempts - 1:
            break
        time.sleep(min(0.05 * (2**attempt), 1.0))
    if last:
        raise last
    raise RuntimeError("run_index_db failed without exception")


# 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
# 跨进程建库租约 —— 修「索引永不收敛」的活锁。
#
# 现象（本机实测）：`search_code_index` 每次 11~15s，10 个
# `build_worker` 子进程同时在跑，每个占 800~900s CPU，`meta` 里
# `build_progress.phase=embedding`、`vectors_done` 缓慢爬又反复归零。
#
# 三层原因，缺一层都不会活锁：
#  1) `_build_jobs` 是**进程内** dict。本机同时跑着两个 Gateway 进程
#     （pid 34300/94272 与 79744/79960），各自 `schedule_build_index`
#     都看到「本地没有 job」，于是各起一个子进程。`_jobs_lock` 只锁本进程，
#     拦不住跨进程，等于没有互斥。
#  2) `build_index` 第一步 `_clear_tables()` 里有 `DELETE FROM meta` ——
#     **整张 meta 表**被清掉，连着 `root` / `indexed_max_files` /
#     `index_tokenizer_version` 一起消失。于是并发进程 B 一边在写文件段，
#     进程 A 一边把 B 的 meta 删掉；下一次 `index_status` 读到 `root=None`
#     → `ready=False` → `schedule_build_index` 判定「索引残缺」→ 再起一个。
#  3) 向量段（本仓 11.4 万块、约 30 分钟）必然被下一轮重建的 `_clear_tables`
#     打断，`vectors_done` 永远是几千/11 万，`stale_reasons` 永远有
#     `vectors_incomplete` —— 判据永远为「未就绪」，重建永远不会停。
#
# 修法（本条）：建库前用一个 **SQLite 独占租约**做跨进程互斥。为什么用 SQLite
# 而不是文件锁：index.db 本来就要打开，`BEGIN EXCLUSIVE` 在 WAL 下由 SQLite
# 自己保证跨进程、跨平台一致，且进程被 kill 时锁由 OS 自动释放（不需要
# 陈旧锁清理逻辑、不需要判断 pid 是否还活）。租约只要持有到本进程建库结束，
# 期间每次 `_update_build_progress` 刷 `build_progress.updated_at`
# 就是天然心跳，读侧据此判断「还在跑 / 已经死了」。
_LEASE_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS build_lease (
    workspace TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
)
"""

# 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
# 当前线程持有租约的 owner 串。用 ContextVar 而不是全局变量：
# 同进程里可能并发多个 workspace 构建，全局变量会让心跳刷错行；
# 而 `_persist_build_progress` 在建库线程/协程里被调用，上下文天然对齐。
_build_lease_owner: ContextVar[str | None] = ContextVar("_build_lease_owner", default=None)

# 心跳超过这个秒数就认为持有者已死，别人可以接管。
# 建库每批（_BUILD_BATCH_SIZE 文件 / 64 块向量）都会刷一次进度，
# 实测最慢的一批（本地 bge 64 块）不超过 3s，300s 是极宽松的上限。
_BUILD_LEASE_TTL_S = 300


def _read_build_lease(conn: sqlite3.Connection, workspace_key: str) -> dict | None:
    """读当前租约行（不存在/表不存在都返回 None）。"""
    try:
        row = conn.execute(
            "SELECT owner, pid, started_at, heartbeat_at FROM build_lease WHERE workspace = ?",
            (workspace_key,),
        ).fetchone()
    except sqlite3.Error:
        return None
    if row is None:
        return None
    return {
        "owner": str(row[0]),
        "pid": int(row[1] or 0),
        "started_at": int(row[2] or 0),
        "heartbeat_at": int(row[3] or 0),
    }


def _pid_alive(pid: int) -> bool:
    """本机 pid 是否还活着（只用于把「同 pid 死锁」的陈旧租约判死）。

    【self-evolution-bot · 2026-11-18 · 第43轮】为什么不能只看心跳年龄：
    进程被 kill -9 / 断电重启后 heartbeat_at 会停在死亡那一刻，
    在 TTL 内后进来的进程仍会认为「有人在跑」而放弃建库 —— 那是**空转**
    （索引一直残缺却没人修），比活锁更难发现。所以同机时优先问 OS。
    """
    if pid <= 0:
        return False
    if os.name == "nt":
        # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
        # Windows 上 `os.kill(pid, 0)` **不可用于存活判定**：它对不存在的 pid
        # 抛的是通用 `OSError [WinError 87] 参数错误`，与其它 OSError 无法区分，
        # 我第一版就靠 except OSError → return True 把它当成"还活着"，
        # 于是死进程的租约永远不被接管（测试当场抓出来）。
        # 改用 OpenProcess：拿不到句柄时用 last_error 区分
        # 87(ERROR_INVALID_PARAMETER)=pid 不存在、5(ACCESS_DENIED)=进程存在但无权限。
        try:
            import ctypes
            from ctypes import wintypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            handle = k32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                err = ctypes.get_last_error()
                if err == 5:  # ACCESS_DENIED：进程在，只是不归我管
                    return True
                return False  # 87 及其它：pid 不存在
            try:
                code = wintypes.DWORD()
                if not k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return True  # 查不到退出码时保守认为活着
                return code.value == 259  # STILL_ACTIVE
            finally:
                k32.CloseHandle(handle)
        except Exception:  # noqa: BLE001 - 存活判定失败时保守认为活着
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def _lease_is_live(cur: dict, *, now: int, ttl_s: int) -> bool:
    """租约是否仍有活人持有。

    判据两条（任一成立即死）：
      · 同机 pid 已不存在 → 立刻判死。这是 `kill -9` / 断电后的唯一可靠信号；
        只靠心跳 TTL 的话要白等 300s，那段时间索引残缺却没人修。
      · 心跳超过 TTL → 判死（跨机 / pid 被复用等拿不准的情况兜底）。
    """
    age = now - int(cur.get("heartbeat_at") or 0)
    pid = int(cur.get("pid") or 0)
    if pid != os.getpid() and not _pid_alive(pid):
        return False
    return age <= ttl_s


def peek_build_lease(root: str, *, ttl_s: int = _BUILD_LEASE_TTL_S) -> dict | None:
    """只看一眼有没有活人持有租约，**不写任何东西**。返回活着的持有者或 None。

    【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    为什么需要"只看不占"：schedule_build_index 只是要决定「要不要起子进程」，
    如果它也去 acquire，就会在 acquire→release 之间制造一个几毫秒的窗口，
    真正的 build_worker 恰好在这期间抢租约就会误判「已有构建在跑」而放弃，
    结果索引谁都不建 —— 比原来的活锁更难查。
    """
    try:
        conn = _connect(root)
    except sqlite3.Error:
        return None
    try:
        cur = _read_build_lease(conn, _workspace_hash(root))
    finally:
        conn.close()
    if cur is None:
        return None
    if not _lease_is_live(cur, now=int(time.time()), ttl_s=ttl_s):
        return None
    return cur


def try_acquire_build_lease(
    conn: sqlite3.Connection,
    workspace_key: str,
    *,
    owner: str,
    ttl_s: int = _BUILD_LEASE_TTL_S,
) -> tuple[bool, dict | None]:
    """尝试拿建库租约。返回 ``(是否拿到, 当前持有者信息)``。

    拿到时会在同一个事务里写入本进程的 owner/pid/heartbeat。
    拿不到时返回持有者信息，调用方据此说「已有构建在跑」而不是再起一个。
    """
    try:
        conn.execute(_LEASE_TABLE_DDL)
        conn.commit()
    except sqlite3.Error:
        # 建表失败不阻塞建库（老库/只读盘）：退化为「不互斥」，行为与改造前一致。
        return True, None
    now = int(time.time())
    cur = _read_build_lease(conn, workspace_key)
    if cur is not None and _lease_is_live(cur, now=now, ttl_s=ttl_s):
        return False, cur

    # 【self-evolution-bot · 2026-11-18 · 第44轮 · 模型:deepseek-v4.1-flash-1017】
    # 「读→判→写」三步必须压成**一条**语句，否则就是 TOCTOU 竞态。
    # 为什么原来的实现等于没有互斥（本机 2026-11-18 复现实证）：
    #   4 个线程同时 `try_acquire_build_lease`，全部返回 (True, None)——
    #   因为每个都先 `_read_build_lease` 读到「没人持有」，再各自 INSERT OR REPLACE，
    #   最后一个覆盖了前三个，**四个进程都以为自己拿到了租约**。
    #   于是 4 个 build_worker 并发写同一个库 → fts_content 1200 条重复行 →
    #   向量判据分母虚涨 → ready 永远 False → 每次检索都重烧一遍全仓。
    # 修法用两条 SQLite 语义保证：
    #   · 单条语句本身是原子的（不存在「读和写之间被别人插进来」）；
    #   · `ON CONFLICT ... WHERE <条件不满足>` 让它在「对方还活着」时**不更新任何行**，
    #     `cur.rowcount == 0` 就是「没抢到」——这个返回值只可能有一个进程拿到 1。
    # 旧租约判死走同一个原子 UPDATE：把严格限制为「行里的 heartbeat 仍是刚才读到的那个
    # 旧值」才允许接管，避免两个进程同时判死同一个租约又同时接管。
    stale_hb = int(cur.get("heartbeat_at") or 0) if cur is not None else -1
    if cur is not None:
        logger.warning(
            "code_index: 尝试接管陈旧建库租约（owner=%s pid=%s 心跳 %ss 前）",
            cur.get("owner"),
            cur.get("pid"),
            now - int(cur.get("heartbeat_at") or 0),
        )
    try:
        res = conn.execute(
            "INSERT INTO build_lease(workspace, owner, pid, started_at, heartbeat_at)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(workspace) DO UPDATE SET"
            "   owner = excluded.owner,"
            "   pid = excluded.pid,"
            "   started_at = excluded.started_at,"
            "   heartbeat_at = excluded.heartbeat_at"
            " WHERE build_lease.heartbeat_at = ? AND build_lease.pid = ?",
            (
                workspace_key,
                owner,
                os.getpid(),
                now,
                now,
                stale_hb,
                int(cur.get("pid") or 0) if cur is not None else -1,
            ),
        )
        conn.commit()
    except sqlite3.Error:
        return True, None
    if int(res.rowcount or 0) <= 0:
        # 没抢到：重读一次，把真正的持有者带回去给调用方说清楚。
        return False, _read_build_lease(conn, workspace_key)
    return True, None


def refresh_build_lease(conn: sqlite3.Connection, workspace_key: str, *, owner: str) -> None:
    """刷新心跳（每批进度一次）。失败静默——心跳不该打断建库。"""
    try:
        conn.execute(
            "UPDATE build_lease SET heartbeat_at = ? WHERE workspace = ? AND owner = ?",
            (int(time.time()), workspace_key, owner),
        )
        conn.commit()
    except sqlite3.Error:
        pass


def release_build_lease(root: str, *, owner: str) -> None:
    """释放租约（正常结束或被中断都要调）。"""
    try:
        # 用独立连接：调用点可能正处在异常路径上，不能指望已有连接还活着。
        conn = sqlite3.connect(str(_db_path(root)), timeout=10.0)
    except sqlite3.Error:
        return
    try:
        conn.execute(
            "DELETE FROM build_lease WHERE workspace = ? AND owner = ?",
            (_workspace_hash(root), owner),
        )
        conn.commit()
    except sqlite3.Error:
        pass
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            pass


def _migrate_fts_if_needed(conn: sqlite3.Connection) -> None:
    """Recreate FTS when legacy porter / path-unindexed schema is detected."""
    row = conn.execute("SELECT value FROM meta WHERE key='fts_schema_version'").fetchone()
    if row and str(row[0]) == _FTS_SCHEMA_VERSION:
        return
    sql_row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_content'").fetchone()
    ddl = str(sql_row[0] if sql_row else "")
    if not ddl:
        return
    ddl_lc = ddl.lower()
    legacy = "porter" in ddl_lc or "path unindexed" in ddl_lc.replace("\n", " ")
    if not legacy:
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
            (_FTS_SCHEMA_VERSION,),
        )
        conn.commit()
        return
    logger.info("code_index: migrating fts_content from legacy schema (%s…)", ddl[:80])
    conn.execute("DROP TABLE IF EXISTS fts_content")
    fts_tokenize_sql = f'"{_FTS_TOKENIZE}"'
    conn.execute(
        f"""
        CREATE VIRTUAL TABLE fts_content USING fts5(
            path,
            content,
            tokenize={fts_tokenize_sql}
        )
        """
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
        (_FTS_SCHEMA_VERSION,),
    )
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_needs_rebuild', '1')")
    conn.commit()


def _ensure_schema(conn: sqlite3.Connection) -> None:
    fts_tokenize_sql = f'"{_FTS_TOKENIZE}"'
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
            path,
            content,
            tokenize={fts_tokenize_sql}
        );
        CREATE TABLE IF NOT EXISTS symbols (
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            line INTEGER NOT NULL,
            PRIMARY KEY (path, name, line)
        );
        CREATE TABLE IF NOT EXISTS file_deps (
            from_path TEXT NOT NULL,
            spec TEXT NOT NULL,
            line INTEGER NOT NULL DEFAULT 0,
            to_path TEXT,
            dep_kind TEXT NOT NULL DEFAULT 'import',
            PRIMARY KEY (from_path, spec, line)
        );
        CREATE INDEX IF NOT EXISTS idx_file_deps_from ON file_deps(from_path);
        CREATE INDEX IF NOT EXISTS idx_file_deps_to ON file_deps(to_path);
        CREATE TABLE IF NOT EXISTS internal_refs (
            from_path TEXT NOT NULL,
            to_path TEXT NOT NULL,
            line INTEGER NOT NULL DEFAULT 0,
            ref_kind TEXT NOT NULL DEFAULT 'import_use',
            symbol TEXT,
            PRIMARY KEY (from_path, to_path, line, ref_kind, symbol)
        );
        CREATE INDEX IF NOT EXISTS idx_internal_refs_to ON internal_refs(to_path);
        CREATE INDEX IF NOT EXISTS idx_internal_refs_from ON internal_refs(from_path);
        CREATE TABLE IF NOT EXISTS type_relations (
            from_path TEXT NOT NULL,
            from_type TEXT NOT NULL,
            to_path TEXT,
            to_type TEXT NOT NULL,
            rel_kind TEXT NOT NULL DEFAULT 'extends',
            line INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (from_path, from_type, to_type, rel_kind, line)
        );
        CREATE INDEX IF NOT EXISTS idx_type_relations_from ON type_relations(from_path);
        CREATE INDEX IF NOT EXISTS idx_type_relations_to ON type_relations(to_path);
        CREATE INDEX IF NOT EXISTS idx_type_relations_from_type ON type_relations(from_type);
        CREATE INDEX IF NOT EXISTS idx_type_relations_to_type ON type_relations(to_type);
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name COLLATE NOCASE);
        """
    )
    conn.commit()
    _migrate_fts_if_needed(conn)
    _ensure_vec_table(conn)
    row = conn.execute("SELECT value FROM meta WHERE key='fts_schema_version'").fetchone()
    if not row:
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
            (_FTS_SCHEMA_VERSION,),
        )
        conn.commit()


def _vec_table_exists(conn: sqlite3.Connection) -> bool:
    """``code_vec`` 是否已建好。

    【self-evolution-bot · 2026-11-17 · 第33轮】新增。仅查 sqlite_master，不做任何
    embedding 栈 import —— 用来把「表已存在」的稳态路径压到微秒级。
    """
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_vec' LIMIT 1"
        ).fetchone()
        return row is not None
    except sqlite3.Error:
        return False


def _ensure_vec_table(conn: sqlite3.Connection) -> None:
    """Create the ``code_vec`` vec0 virtual table for semantic search.

    Best-effort: if sqlite-vec is not loaded, the table is skipped and
    semantic search degrades to FTS5-only.
    """
    cfg = get_code_index_config()
    if not cfg.semantic_search_enabled:
        return
    # 【self-evolution-bot · 2026-11-17 · 第33轮】表已存在就**不解析维度**。
    # 为什么：CREATE VIRTUAL TABLE IF NOT EXISTS 对已存在的表本就是空操作，
    # 但 _resolved_embedding_dim() 要 import evoflow.knowledge.embedding.registry，
    # 连带拖进 base -> transformers/numpy/PIL（实测 2426 模块 / 4340ms）。
    # 而 _ensure_vec_table 由 _ensure_schema 调用，_ensure_schema 又在**每次检索**
    # 里被调两次（index_status + search_index），于是「打开索引库」稳定花 3~4s，
    # 用户感知就是搜索类工具莫名其妙很慢。稳态下这里应当接近 0 成本。
    if _vec_table_exists(conn):
        return
    # 【self-evolution-bot · 2026-11-16 · 第24轮】维度不再照抄配置里的静态 512。
    # 为什么：512 是本地 bge-small-zh 的维度，而当前生效的向量模型是云端 2048 维，
    # 于是每条向量插入都被拒（Dimension mismatch Expected 512 but received 2048），
    # 且只落 debug 日志——code_vec 建好了却 0 行，语义召回等于不存在。
    # 同时显式声明 distance_metric=cosine：_score() 的注释本来就是按
    # 「1.0 - cosine_distance，范围 0~1」写的，但建表没写度量 → vec0 默认 L2，
    # 2048 维未归一化向量 L2 ≈1.0~1.35，score 全成负数，语义命中反被沉到最底。
    dim = _resolved_embedding_dim(cfg)
    try:
        conn.execute(_vec_create_sql(dim, if_not_exists=True))
        conn.commit()
    except sqlite3.OperationalError as exc:
        if "vec0" in str(exc).lower() or "no such module" in str(exc).lower():
            logger.debug("code_index: vec0 module not available, semantic search disabled")
        else:
            raise


def _resolved_embedding_dim(cfg: CodeIndexConfig | None = None) -> int:
    """【self-evolution-bot · 2026-11-16 · 第24轮】按「当前生效的向量模型」解析维度。

    配置里的 ``semantic_embedding_dim`` 只是本地 bge-small-zh 的旧默认值（512）。
    换成云端模型（doubao-embedding-vision = 2048）后它不会自动跟着变，
    于是每条向量插入都被 vec0 拒绝，code_vec 建好了却 0 行。
    这里优先按模型 id 查已知维度表，查不到才退回配置值；
    真正的兜底在 :func:`_ensure_vec_table_dim`——以实际产出的向量长度为准。
    """
    base = cfg or get_code_index_config()
    configured = int(getattr(base, "semantic_embedding_dim", 0) or 0) or 512
    try:
        from evoflow.knowledge.embedding.registry import (
            get_embedding_config,
            known_embedding_dim,
        )

        mc = get_embedding_config()
        model_id = str(getattr(mc, "model", "") or "").strip()
        known = known_embedding_dim(model_id)
        if known:
            return int(known)
    except Exception as exc:  # noqa: BLE001 - 维度解析失败不能挡住索引
        logger.debug("code_index: resolve embedding dim failed: %s", exc)
    return configured


def _vec_create_sql(dim: int, *, if_not_exists: bool = True) -> str:
    """【self-evolution-bot · 2026-11-16 · 第24轮】code_vec 建表语句统一出口。

    显式写 ``distance_metric=cosine``，与实际使用方式对齐：
    ``_score()`` 按 ``score = 1.0 - cosine_distance``（0~1）计分并 ×100 加重排。
    不写度量时 vec0 默认 L2，2048 维未归一化向量的 L2 距离 ≈1.0~1.35，
    score 全为负数，语义命中反而被排到最底。

    【self-evolution-bot · 2026-11-16 · 第26轮】主键从 ``path`` 改成 ``chunk_id``，
    ``path`` 降为辅助列（vec0 支持带辅助列的 KNN，实测可用）。
    为什么必须一文件多向量：本地 bge-small-zh ``max_seq_length=512`` token，
    而仓库文件按 ``chars/token`` P50=2.5 折算，**55/60 个文件超长**，
    整文件嵌入平均只看到 31.8% 的内容——本地 top1 只有 2/8（云端整文件 4/8）。
    切块后同一批查询本地 top1 升到 5/8、MRR 0.752 > 云端 0.713。
    也就是说：不切块，本地模型是「省钱但更差」；切块之后才「又省钱又更好」。
    """
    ine = "IF NOT EXISTS " if if_not_exists else ""
    return (
        f"CREATE VIRTUAL TABLE {ine}code_vec USING vec0("
        f"chunk_id TEXT PRIMARY KEY, path TEXT, "
        f"embedding FLOAT[{int(dim)}] distance_metric=cosine)"
    )


# 【self-evolution-bot · 2026-11-16 · 第26轮】切块参数。
# 依据是实测而非直觉：在 150 个真实仓库文件上量「切出来的块有多少超过 512 token」，
#   chunk=600  overlap=75  -> 超限 0.21%   (块数 141,994 / 全量 ≈37.9 分钟)
#   chunk=900  overlap=112 -> 超限 5.00%
#   chunk=1200 overlap=150 -> 超限 22.49%
#   chunk=1500 overlap=187 -> 超限 70.80%
# 取 600/75 是唯一「几乎零截断」档；再大一档就有 5% 的块被模型静默截尾。
# 重叠取 chunk/8：跨块边界的函数签名与实现都能落在同一块里，避免切丢上下文。
_CHUNK_CHARS = 600
_CHUNK_OVERLAP = 75

# 【self-evolution-bot · 2026-11-16 · 第26轮】每批嵌入多少块。
# 实测本地 bge 在 batch=64 时 16.1 ms/块、batch=128 时 16.0 ms/块、batch=32 时 27.9 ms/块，
# 64 与 128 基本同速，取 64：单批 encode 约 1 秒，远低于 30s 看门狗，
# 且中途失败只损失 64 块而不是整仓。
_EMBED_CHUNK_BATCH = 64

# 【self-evolution-bot · 2026-11-16 · 第26轮】语义召回的块→文件放大倍数。
# 一文件多块后，KNN 取 top_k 个块可能全落在同一文件里，必须放大候选再按文件聚合。
# 取 5：按 600 字符/块计，一个命中文件平均贡献远小于 5 个高分块，
# 放大 5 倍足以让 top_k 个不同文件填满，又不会把 KNN 成本放大太多。
_SEMANTIC_CHUNK_FANOUT = 5

# 【self-evolution-bot · 2026-11-17 · 第41轮】向量覆盖率的最低可接受比例。
# 判据：`count(distinct path from code_vec) / 索引文件数 >= 0.98` 才算向量完整。
# 留 2% 容差是因为纯空白文件（本仓实测 8 个，如空的 __init__.py）不送嵌入，
# 这是合法缺口；而「1394/7839=18%」这种真残缺必须被抓出来。
# 上一版判据是「块数 < 文件数」，因一文件多块而永远为假，等于没判。
_VECTORS_COVERAGE_MIN = 0.98


def _write_code_vec_row(
    conn: sqlite3.Connection,
    chunk_id: str,
    rel: str,
    vec: list[float],
) -> None:
    """【self-evolution-bot · 2026-11-17 · 第41轮】往 ``code_vec`` 写一条块向量。

    为什么必须走这个出口、且**不能**写 `INSERT OR REPLACE`：
    vec0 是虚拟表，`INSERT OR REPLACE` 在撞已有 `chunk_id` 时**不做替换**，
    直接抛 `UNIQUE constraint failed on code_vec primary key`（sqlite-vec 0.1.6 实测）。
    向量段与增量段原来都写了 `OR REPLACE`，后果分两种：
      · 全量重建（先清表）：第一块就撞不上，能跑，但重跑时撞；
      · `vectors_only` 续跑（**不清表**，见 build_index 里那条分流）：
        第一块就撞上上次留下的同名块 → 抛异常 → 外层函数级
        `except sqlite3.OperationalError` 吞掉并 `return 0` →
        **续跑永远补不上任何向量**，`code_vec` 长期停在 18% 覆盖。
    所以正确写法只有「先 DELETE 同名块、再 INSERT」，vec0 支持 DELETE（实测
    按 chunk_id / path / IN 均可）。
    """
    conn.execute("DELETE FROM code_vec WHERE chunk_id = ?", (chunk_id,))
    conn.execute(
        "INSERT INTO code_vec (chunk_id, path, embedding) VALUES (?, ?, ?)",
        (chunk_id, rel, _pack_vec(vec)),
    )


def _chunk_text(text: str) -> list[str]:
    """【self-evolution-bot · 2026-11-16 · 第26轮】把文件正文切成定长重叠块。

    纯字符切分，不引入 tokenizer 依赖——索引路径上多跑一遍分词没必要，
    且 ``bge`` 的 tokenizer 与模型绑定，放在这里会让 code_index 反依赖
    sentence-transformers（云端模型时本地根本没装）。
    600/75 这组参数是按实测截断率选的（见 ``_CHUNK_CHARS`` 上方数据）。
    """
    step = _CHUNK_CHARS - _CHUNK_OVERLAP
    if step <= 0:  # 防御：参数写坏时退化成不重叠，别死循环
        step = _CHUNK_CHARS
    out: list[str] = []
    n = len(text)
    i = 0
    while i < n:
        piece = text[i : i + _CHUNK_CHARS]
        if piece.strip():
            out.append(piece)
        if i + _CHUNK_CHARS >= n:
            break
        i += step
    return out


def _table_vec_metric(conn: sqlite3.Connection) -> str | None:
    """code_vec 声明的距离度量（``cosine`` / ``l2`` / None=vec0 默认 L2）。"""
    try:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE name='code_vec'").fetchone()
    except sqlite3.OperationalError:
        return None
    if not row or not row[0]:
        return None
    m = re.search(r"distance_metric\s*=\s*(\w+)", str(row[0]), re.IGNORECASE)
    return m.group(1).lower() if m else None


def _table_vec_is_chunked(conn: sqlite3.Connection) -> bool:
    """【self-evolution-bot · 2026-11-16 · 第26轮】code_vec 是否已是「一文件多块」结构。

    判据是主键名：旧表 ``path TEXT PRIMARY KEY``（一文件一向量），
    新表 ``chunk_id TEXT PRIMARY KEY, path TEXT``（辅助列）。
    只看维度会漏掉「维度已对但还是一文件一向量」的存量表，
    那种表即使维度对了，本地模型仍然只能看到每个文件的前 512 token。
    """
    try:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE name='code_vec'").fetchone()
    except sqlite3.OperationalError:
        return False
    if not row or not row[0]:
        return False
    return "chunk_id" in str(row[0])


def _table_vec_dim(conn: sqlite3.Connection) -> int | None:
    """code_vec 声明的向量维度（从建表 SQL 的 ``FLOAT[n]`` 读）；表不存在返回 None。"""
    try:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE name='code_vec'").fetchone()
    except sqlite3.OperationalError:
        return None
    if not row or not row[0]:
        return None
    m = re.search(r"FLOAT\[(\d+)\]", str(row[0]), re.IGNORECASE)
    return int(m.group(1)) if m else None


def _ensure_vec_table_dim(conn: sqlite3.Connection, dim: int) -> bool:
    """确保 code_vec 的声明维度与实际向量维度一致、且距离度量为 cosine；不符就整表重建。

    vec0 的维度与度量都写死在建表语句里、改不了，只能 DROP 重建。
    重建后向量要等下一轮索引重跑才补得回来，所以这里必须用 warning，
    不能再像原来那样静默 continue——0 行向量等于语义召回根本不存在。

    【self-evolution-bot · 2026-11-16 · 第24轮】补上度量校验：
    只看维度会漏掉「维度已对、但度量还是 vec0 默认 L2」的现网存量表
    （本机那张就是 2048 + L2），负分排序问题会一直留着。

    【self-evolution-bot · 2026-11-16 · 第26轮】再加结构校验：
    一文件一向量（主键 ``path``）的旧表必须重建为块级表（主键 ``chunk_id``），
    否则本地模型仍只能看到每个文件开头 600 字符，切块收益等于没生效。
    """
    if not dim or dim <= 0:
        return False
    current = _table_vec_dim(conn)
    metric = _table_vec_metric(conn)
    chunked = _table_vec_is_chunked(conn)
    if current == dim and metric == "cosine" and chunked:
        return True
    if current is not None:
        if not chunked:
            logger.warning(
                "code_index: code_vec 重建（一文件一向量 → 一文件多块，dim=%d）；"
                "重建后需重新索引补齐向量",
                dim,
            )
        else:
            logger.warning(
                "code_index: code_vec 重建（维度 %s→%d，度量 %s→cosine）；重建后需重新索引补齐向量",
                current,
                dim,
                metric or "l2(默认)",
            )
        try:
            conn.execute("DROP TABLE IF EXISTS code_vec")
            conn.commit()
        except sqlite3.OperationalError as exc:
            logger.warning("code_index: 重建 code_vec 失败: %s", exc)
            return False
    try:
        conn.execute(_vec_create_sql(dim, if_not_exists=True))
        conn.commit()
        return True
    except sqlite3.OperationalError as exc:
        logger.warning("code_index: code_vec 建表失败（vec0 不可用？）: %s", exc)
        return False


def _path_has_skipped_segment(rel: str) -> bool:
    parts = Path(rel).as_posix().split("/")
    return any(p in _SKIP_DIRS or p.startswith(".") for p in parts if p)


def _dir_escapes_workspace(child: Path, root_resolved: Path) -> bool:
    """True if *child* is a symlink/junction or otherwise resolves outside *root_resolved*.

    Windows directory junctions report ``is_symlink() is False`` / ``os.path.islink`` False,
    so ``os.walk(..., followlinks=False)`` still descends into them and indexes foreign
    repos (e.g. EvoFlow/clawdevoflow → ../evo/clawdevoflow). Skip those.

    【self-evolution-bot · 2026-11-17 · 第39轮 · 模型:deepseek-v4.1-flash-1017】
    为什么去掉末尾的 ``child.resolve().relative_to(root_resolved)``：
    它对**每个**被保留下来的候选目录都做一次 ``nt._getfinalpathname`` 系统调用，
    实测本仓 22k 个目录累计 **148ms**（带 resolve 303ms → 去掉 156ms），
    而它拦下的东西**全是已经拦过的**：两处调用点都在 os.walk 里对 dirnames 逐个判、
    判完 false 就 ``dirnames[:] = kept`` 剪枝，所以任何逃逸目录的子目录根本不会被访问。
    实测核对（probe_escape_diff）：old-only 的 16097 个目录 100% 是
    ``EvoFlow/clawdevoflow`` 这个 junction 的子目录，它们 resolve 后全在 ``D:\\dev\\github\\evo`` 下。
    判据非「看着多余」，而是文件集：去掉后 ``_iter_source_files`` 产出的 8426 个文件
    与去掉前**逐条完全相同**（集合相等，0 差集）。
    兜底保留：万一运行在拿不到 ``is_junction`` 的平台/Python 上（3.12 之前没有该属性），
    退回原来的 resolve 比较，行为与改造前一致。
    """
    try:
        if child.is_symlink():
            return True
        is_junc = getattr(child, "is_junction", None)
        if callable(is_junc):
            return bool(is_junc())
        # 无 is_junction（老 Python / 非 Windows）：退回逐条 resolve 比较
        child.resolve().relative_to(root_resolved)
        return False
    except (ValueError, OSError):
        return True


def _normalize_path_prefix(prefix: str | None) -> str | None:
    p = str(prefix or "").strip().replace("\\", "/").strip("/")
    return p or None


def _path_under_prefix(rel_path: str, prefix: str | None) -> bool:
    pref = _normalize_path_prefix(prefix)
    if not pref:
        return True
    rel = str(rel_path or "").replace("\\", "/").strip("/")
    # Exact prefix match (fast path)
    if rel == pref or rel.startswith(pref + "/"):
        return True
    # Fuzzy match: if the prefix is a single directory name (no /), match it
    # as any path segment. e.g. path:react matches evopanel/src/react/ChatApp.tsx
    if "/" not in pref:
        segments = rel.split("/")
        # Check if any directory segment matches the prefix
        # (exclude the filename — last segment)
        return any(seg == pref for seg in segments[:-1])
    # Multi-segment prefix: try matching the last segment as a directory name
    # e.g. path:src/react matches evopanel/src/react/... even if user omitted evopanel/
    last_seg = pref.rsplit("/", 1)[-1]
    if last_seg and len(last_seg) >= 2:
        segments = rel.split("/")
        if any(seg == last_seg for seg in segments[:-1]):
            # Verify the full prefix tail matches the path tail
            pref_segs = pref.split("/")
            for i in range(len(segments) - len(pref_segs) + 1):
                if segments[i : i + len(pref_segs)] == pref_segs:
                    return True
    return False


def _looks_like_identifier_token(tok: str) -> bool:
    t = str(tok or "").strip()
    if len(t) < 2:
        return False
    if t.casefold() in _SEARCH_STOPWORDS:
        return False
    if re.fullmatch(r"[A-Za-z_]\w*", t):
        if "_" in t or "-" in t:
            return True
        if re.search(r"[A-Z]", t) and re.search(r"[a-z]", t):
            return True
        if t[0].isupper():
            return True
        return len(t) >= 6
    return False


def _strip_seps(text: str) -> str:
    """去掉下划线/连字符/空格并小写 —— 用于分隔符不敏感的符号比对。

    【self-evolution-bot · 2026-11-17 · 第32轮】见 _search_symbols 里的用法。
    """
    return re.sub(r"[_\-\s]+", "", str(text or "")).lower()


def _name_tokens(name: str) -> list[str]:
    """把符号名切成小写词元：camelCase / snake_case / kebab-case 都拆开。

    【self-evolution-bot · 2026-11-17 · 第36轮】整句比对需要「按词」而不是「按字符」
    比较，否则 `plugin uninstall` 与 `plugins_uninstall` 差一个 s 就判不等。
    """
    s = str(name or "")
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    return [t.lower() for t in re.split(r"[^A-Za-z0-9]+", s) if t]


def _sing_tok(word: str) -> str:
    """词尾单数化（只动词尾，不做词干提取，避免误伤 progress/series 这类词）。"""
    w = str(word or "").lower()
    if len(w) > 3 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("ses"):
        return w[:-2]
    if len(w) > 2 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def _whole_name_matches(whole_query: str, name: str) -> bool:
    """整句匹配：查询词元序列与符号名词元序列**逐位相等**（单复数视为相等）。

    实测收益（见第36轮）：`plugin uninstall` 曾完全查不到 `plugins_uninstall`
    （去分隔符后 'pluginuninstall' vs 'pluginsuninstall'，严格全等失败），
    首条给的是短泛名 `uninstall`。按词元比对后两侧都是
    ['plugin','uninstall'] vs ['plugins','uninstall']，单数化后一致 → 命中。
    """
    # 判据一（主）：去分隔符后全等。覆盖绝大多数情况，且不会误伤
    # ZCodeBackgroundTaskControlItem 这类「大写缩写连写」—— 词元方案会把
    # ZCode 拆成 z/code，反而对不上（第36轮我先漏掉这条，一次退化了 4 条）。
    if _strip_seps(whole_query) == _strip_seps(name):
        return True
    # 判据二（补）：逐词元相等，单复数归一。专治 plugin↔plugins 这种差一个 s、
    # 全等判据够不着的情况。
    q = _name_tokens(whole_query)
    n = _name_tokens(name)
    if not q or len(q) != len(n):
        return False
    return all(_sing_tok(a) == _sing_tok(b) for a, b in zip(q, n))


def _hyphen_variants(term: str) -> list[str]:
    """Expand hyphen spellings (``dall-e`` ↔ ``dalle``) for symbol + FTS lookup."""
    t = str(term or "").strip()
    if not t or len(t) < 3 or not re.fullmatch(r"[\w-]+", t):
        return []
    out: list[str] = []
    if "-" in t:
        collapsed = re.sub(r"-+", "", t)
        if collapsed != t and len(collapsed) >= 3:
            out.append(collapsed)
        underscored = t.replace("-", "_")
        if underscored != t:
            out.append(underscored)
    # 【self-evolution-bot · 2026-11-17 · 第32轮】删掉原来的 elif 反向分支：
    #   它把任何「纯小写 ASCII 词」机械拆成 t[:-1] + "-" + t[-1]，
    #   于是 read/progress/build 被扩展出 persiste-d / progres-s / buil-d 这类
    #   任何源码里都不存在的词项，全部并进 FTS 的 OR 查询里稀释相关性。
    #   实测（query=_read_persisted_build_progress）：12 个词项里 6 个是这样的垃圾，
    #   候选池被 "build"/"progress" 之类泛词占满，真命中被挤出前 10。
    #   原意图 dall-e → dalle 那类「用户输入带连字符」的情况，上面的 if 分支已覆盖；
    #   反向（dalle → dall-e）没有证据表明有用，且无法验证哪个位置该插连字符。
    return out


def _boost_filename_path_matches(
    hits: list[dict],
    symbols: list[dict],
    *,
    query: str,
    query_body: str | None = None,
) -> tuple[list[dict], list[dict]]:
    """Move rows whose path matches a filename-like query to the front."""
    q = str(query_body if query_body is not None else query or "").strip()
    if q.startswith("path:"):
        q = q.split(" ", 1)[1] if " " in q else ""
    if not q:
        return hits, symbols
    base = q.replace("\\", "/").split("/")[-1].casefold()
    if not base:
        return hits, symbols

    def _tier(row: dict) -> int:
        p = str(row.get("path") or "").replace("\\", "/").casefold()
        fname = p.split("/")[-1]
        stem = fname.rsplit(".", 1)[0] if "." in fname else fname
        if fname == base or stem == base or p.endswith(f"/{base}"):
            return 0
        if base in fname or base in stem:
            return 1
        if base in p:
            return 2
        return 3

    # Stable sort: same-tier rows preserve their input order (which comes
    # from _rerank_index_rows and includes semantic similarity scores).
    # Using just the tier (not (tier, path)) as the key ensures semantic
    # hits are not re-sorted alphabetically and sunk below FTS5 noise.
    return (
        sorted(hits, key=_tier),
        sorted(symbols, key=_tier),
    )


_KIND_BONUS: dict[str, float] = {
    "function": 10.0,
    "def": 10.0,
    "method": 10.0,
    "async_function": 10.0,
    "class": 8.0,
    "class_definition": 8.0,
    "interface": 9.0,
    "constructor": 8.0,
    "enum": 5.0,
    "type": 6.0,
    "type_alias": 6.0,
    "variable": 2.0,
    "constant": 3.0,
    "property": 3.0,
    "field": 3.0,
    "import": 1.0,
    "module": 4.0,
}


def _rerank_index_rows(
    hits: list[dict],
    symbols: list[dict],
    *,
    terms: list[str],
    path_prefix: str | None,
    query_body: str,
) -> tuple[list[dict], list[dict]]:
    """Unified relevance sort for content hits and symbol rows."""

    def _score(row: dict) -> float:
        score = 0.0
        path = str(row.get("path") or "")
        name = str(row.get("name") or "")
        match_rank = int(row.get("match_rank") or 0)

        # Semantic vector similarity: use the score from _semantic_recall_sync
        # (score = 1.0 - cosine_distance, range ~0..1). Scale ×100 so a strong
        # semantic match (≈0.8) gets ~80 pts — competitive with keyword exact
        # name match (+100) but below it, and well above FTS5 noise (+4).
        # Without this, semantic hits have _score ≈ 0 and sink to the bottom.
        if str(row.get("kind") or "") == "semantic":
            sem = float(row.get("score") or 0.0)
            score += sem * 100.0

        # 【self-evolution-bot · 2026-11-17 · 第34轮】整句全等（match_rank=5）必须压过
        # 「某个短词恰好等于符号名」（match_rank=4）。原实现所有 >=3 一律 +120，
        # 于是查 `resolve data paths` 时，符号 `resolve()` 靠下面 terms 的
        # `n == t` 再加 100 分，比真目标 resolve_data_paths 还高 —— 检索层排对了，
        # 这里又给推翻。分档必须单调。
        if match_rank >= 5:
            score += 260.0
        elif match_rank >= 3:
            score += 120.0
        elif match_rank == 2:
            score += 70.0
        elif match_rank == 1:
            score += 30.0
        for term in terms:
            t = term.casefold()
            if name:
                n = name.casefold()
                # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
                # 前导下划线是「私有」约定，不是语义内容，不能因为它吃掉前缀加分。
                # 实测偏置（冻结池 8 条失分里有 5 条同源）：查 `normalize reasoning effort`，
                # 真目标 `_normalize_reasoning_effort` 因首字符是 `_` 而 `startswith("normalize")`
                # 失败，只拿到子串分 +22；跨语言变体 `normalizeReasoningEffort` 拿前缀分 +55，
                # 于是**变体压过完全匹配**、目标掉到第 2 位。
                # 修法只影响「前缀/子串」这类模糊档，完全相等仍按字面比（`_foo` ≠ `foo`）。
                n_bare = n.lstrip("_")
                if n == t:
                    score += 100.0
                elif n_bare == t:
                    # 只差前导下划线的同名符号，给足分但不高于字面全等
                    score += 92.0
                elif (n.startswith(t) or n_bare.startswith(t)) and len(t) >= 2:
                    score += 55.0
                elif len(term) >= 5 and t in n:
                    score += 22.0
            if t in path.casefold():
                score += 10.0
        if path_prefix and _path_under_prefix(path, path_prefix):
            score += 45.0
        qb = str(query_body or "").strip().casefold()
        if qb:
            fname = path.replace("\\", "/").split("/")[-1].casefold()
            stem = fname.rsplit(".", 1)[0] if "." in fname else fname
            qb_base = qb.split("/")[-1]
            if fname == qb_base or stem == qb_base:
                score += 85.0
        kind = str(row.get("kind") or "").lower().strip()
        score += _KIND_BONUS.get(kind, 0)
        if kind == "content":
            score += 4.0
        return score

    # 【self-evolution-bot · 2026-11-18 · 第46轮 · 模型:deepseek-v4.1-flash-1017】
    # 同分并列时的 tie-break 必须用 casefold 后的名字，不能用原始 name。
    # 实测（`build overlay`，冻结池残留的唯一一条 miss@1）：`_build_overlay`
    # （逐字全等）与 `_buildOverlays`（靠单复数容错才相等）都拿 mr=5、_score 同为 337，
    # 只能靠名字排序分胜负；而 'O'(79) < 'o'(111)，于是全是小写下划线的**真目标
    # 反倒排在后面**，首条给的是另一个文件里的 `_buildOverlays`。
    # 检索层的 _exact/_fuzzy 分档本来是排对的（_build_overlay 在前），
    # 被这一行 tie-break 又推翻 —— 与第34轮「分档必须单调」是同一类错。
    hits_out = sorted(hits, key=lambda r: (-_score(r), str(r.get("path") or "")))
    symbols_out = sorted(
        symbols,
        key=lambda r: (
            -_score(r),
            str(r.get("name") or "").casefold(),
            str(r.get("path") or ""),
        ),
    )
    return hits_out, symbols_out


def _filter_index_rows(rows: list[dict], *, path_prefix: str | None, limit: int) -> list[dict]:
    """Drop polluted paths (bundled deps) and apply optional path scope.

    [self-evolution-bot 2026-11-17 第32轮] 签名一度放宽成 limit: int | None
    （想支持「不在 rerank 前截断」），但两个调用点都传具体值、None 分支无人走，
    且该改动复算不出差别 —— 已撤回，签名与调用实际保持一致。
    """
    out: list[dict] = []
    for row in rows:
        p = str(row.get("path") or "")
        if not p or _path_has_skipped_segment(p):
            continue
        if not _path_under_prefix(p, path_prefix):
            continue
        out.append(row)
        if len(out) >= limit:
            break
    return out


def _normalize_relative_path(root: Path, relative_path: str) -> str:
    rel = str(relative_path or "").strip().replace("\\", "/")
    if not rel or rel in {".", "/"}:
        raise ValueError("relative_path is required")
    resolved = resolve_under_workspace(str(root), rel)
    return resolved.relative_to(root.resolve()).as_posix()


def _should_index_file(path: Path) -> bool:
    if path.suffix.lower() not in _TEXT_SUFFIXES:
        return False
    try:
        if path.stat().st_size > 512_000:
            return False
    except OSError:
        return False
    return True


# ---------------------------------------------------------------------------
# Semantic search helpers (embedding + vec0 recall)
# ---------------------------------------------------------------------------


def _pack_vec(values: Sequence[float]) -> bytes:
    """Pack floats into little-endian float32 blob for vec0."""
    return struct.pack(f"{len(values)}f", *values)


async def _embed_texts_batch(texts: list[str]) -> list[list[float]] | None:
    """Batch embed texts via the active embedding model.

    Returns ``None`` on failure so callers can gracefully degrade to FTS5-only.
    """
    try:
        from evoflow.knowledge.embedding import get_embeddings

        return await get_embeddings(texts, purpose="index")
    except Exception as exc:
        logger.warning("code_index: batch embedding failed: %s: %s", type(exc).__name__, exc)
        return None


async def _embed_query(text: str) -> list[float] | None:
    """Embed a search query. Returns ``None`` on failure."""
    try:
        from evoflow.knowledge.embedding import get_embedding

        return await get_embedding(text, purpose="query")
    except Exception as exc:
        logger.warning("code_index: query embedding failed: %s: %s", type(exc).__name__, exc)
        return None


def _embed_texts_sync(texts: list[str]) -> list[list[float]] | None:
    """Synchronous batch embedding — bypasses ``asyncio.to_thread``.

    Used by :func:`_index_embeddings_sync` which already runs in a
    background thread.  Calling the async :func:`get_embeddings` from
    there would invoke ``asyncio.to_thread`` inside a fresh event loop
    created by :func:`_run_async_in_thread`, which can fail with
    *cannot schedule new futures after interpreter shutdown* when the
    global ThreadPoolExecutor is in a bad state.

    For local providers we call ``model.encode()`` directly via the
    provider's ``embed_batch_sync``; for cloud providers we fall back
    to the async path.
    """
    try:
        from evoflow.knowledge.embedding.local_provider import LocalEmbeddingProvider
        from evoflow.knowledge.embedding.registry import (
            _resolve_provider,
            get_embedding_config,
        )

        try:
            asyncio.get_running_loop()
            loop_running = True
        except RuntimeError:
            loop_running = False

        mc = get_embedding_config()
        provider = _resolve_provider(mc)
        if isinstance(provider, LocalEmbeddingProvider):
            from evoflow.knowledge.embedding.usage_meter import embedding_usage_scope

            with embedding_usage_scope(purpose="index"):
                return provider.embed_batch_sync(texts)
        if loop_running:
            logger.debug(
                "code_index: skip sync remote batch embed while event loop is running"
            )
            return None
        # 【self-evolution-bot · 2026-11-16 · 第26轮】超时不再写死 30 秒，按批大小给预算。
        # 为什么：云端 doubao 实测 770~794 ms/文件，一批 100 条要 77~79 秒，
        # 而这里原来硬编码 30.0s —— 每一批都必然 TimeoutError，
        # 网关日志实证：「sync batch embedding failed: TimeoutError: _run_async_in_thread
        # timed out after 30.0s (daemon still running)」，于是 3000 个文件走完整索引后
        # code_vec 仍是 0 行。批量嵌入是「一个都不能少」的路径，超时预算必须跟着批量走。
        budget = _embed_timeout_seconds(len(texts))
        return _run_async_in_thread(lambda: _embed_texts_batch(texts), timeout=budget)
    except Exception as exc:
        logger.warning(
            "code_index: sync batch embedding failed: %s: %s (%d 条)",
            type(exc).__name__,
            exc,
            len(texts),
        )
        return None


def _embed_timeout_seconds(n_texts: int) -> float:
    """【self-evolution-bot · 2026-11-16 · 第26轮】按批量给嵌入超时预算。

    云端实测 770~794 ms/文件（100 条 ≈ 77~79 s），本地 bge 约 20~26 ms/文件。
    取 1.2 s/文件 + 60 s 底，既是云端 1.5 倍余量，也不会让本地小批量空等。
    """
    return max(60.0, 1.2 * max(1, int(n_texts or 1)))


def _embed_texts_with_bisect(pairs: list[tuple[str, str]]) -> list[list[float]]:
    """【self-evolution-bot · 2026-11-16 · 第26轮】整批失败时二分拆批重试。

    保持与 ``pairs`` 一一对齐（失败的位放空列表占位），
    这样调用方 ``zip(pairs, embeddings, strict=True)`` 不会错位。
    单条仍失败就放弃该条——一条坏数据不该拖垮整库。
    """
    if not pairs:
        return []
    got = _embed_texts_sync([t for _, t in pairs])
    if got and len(got) == len(pairs):
        return got
    if len(pairs) == 1:
        return [[]]
    mid = len(pairs) // 2
    return _embed_texts_with_bisect(pairs[:mid]) + _embed_texts_with_bisect(pairs[mid:])


def _mark_degraded(diag: dict | None, code: str, detail: str) -> None:
    """把「本次检索只有词法」这件事记到调用方能看见的地方。

    【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    只在 logger 里说等于没说：语义召回掉线时字面匹配照样能给出结果，
    返回值看上去完全正常 —— 用户/调用方没有任何线索。
    code 是稳定标识（便于断言与去重），detail 是给人看的一句话。

    为什么是线程本地而不是加 `diag` 关键字参数：`_embed_query_sync` 的签名
    被多处测试/调用方 monkeypatch 成单参函数，加 kwarg 会让它们全部 TypeError
    （本轮实测 3 个测试直接红）。降级原因本来就是「本次调用的旁路信息」，
    放 thread-local 不用改任何既有签名。
    """
    if diag is not None:
        diag["semantic_degraded"] = code
        diag["semantic_degraded_detail"] = detail
    _DEGRADE_STATE.code = code
    _DEGRADE_STATE.detail = detail


def _reset_degraded() -> None:
    _DEGRADE_STATE.code = ""
    _DEGRADE_STATE.detail = ""


def _collect_degraded() -> dict:
    return {
        "semantic_degraded": getattr(_DEGRADE_STATE, "code", "") or "",
        "semantic_degraded_detail": getattr(_DEGRADE_STATE, "detail", "") or "",
    }


def _embed_query_sync(text: str) -> list[float] | None:
    """Synchronous query embedding — bypasses ``asyncio.to_thread``.

    Must not be called from the gateway asyncio thread with a remote provider:
    that path used to ``Thread.join`` for tens of seconds (429 retries) and
    froze the whole UI. Local providers stay sync; remote embeds from a
    running loop are skipped (callers fall back to FTS / overlap).

    【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    返回 None 的**原因**写进 thread-local（见 :func:`_mark_degraded`），
    由 :func:`_collect_degraded` 取走并随检索结果返回。为什么：这条路径此前只在 `logger.warning` 里说话，而语义召回静默掉线时
    字面匹配能撑住结果，**工具返回值看起来完全正常**——我是在翻日志时才撞见的。
    调用方（也是用户）必须能从返回值里看出「这次只有词法」。
    """
    # 【self-evolution-bot · 2026-11-18 · 第50轮 · 模型:deepseek-v4.1-flash-1017】
    # 门未开 = 本进程还没把嵌入栈/权重拉起来。此时**不要**在这里同步 import + load：
    # 那是 4.7s 起的冷导入（实测 import local_provider 3030ms + 首次 embed 1669ms），
    # 会把调用方线程按在池里、顶着 45s 天花板超时。先给词法结果，后台暖机。
    global _embed_gate_open
    if not _embed_gate_open:
        if _embed_ready_without_import():
            # 本进程之前已把模型加载好（比如建库路径暖过），不必降级。
            _embed_gate_open = True
        else:
            _start_embed_warmup()
            _mark_degraded(
                None,
                "warming_up",
                "embedding model is warming up in the background"
                " (first search after start uses lexical matching only)",
            )
            return None
    try:
        try:
            asyncio.get_running_loop()
            loop_running = True
        except RuntimeError:
            loop_running = False

        from evoflow.knowledge.embedding.local_provider import LocalEmbeddingProvider
        from evoflow.knowledge.embedding.registry import (
            _resolve_provider,
            get_embedding_config,
        )

        mc = get_embedding_config()
        provider = _resolve_provider(mc)
        if isinstance(provider, LocalEmbeddingProvider):
            from evoflow.knowledge.embedding.usage_meter import embedding_usage_scope

            with embedding_usage_scope(purpose="query"):
                return provider.embed_sync(text)
        if loop_running:
            logger.debug(
                "code_index: skip sync remote embed while event loop is running"
            )
            _mark_degraded(
                None,
                "remote_blocked_on_loop",
                "remote embedding provider is skipped inside a running event loop"
                " (sync path cannot block); lexical matching only",
            )
            return None
        return _run_async_in_thread(lambda: _embed_query(text), timeout=8.0)
    except Exception as exc:
        logger.warning(
            "code_index: sync query embedding failed: %s: %s",
            type(exc).__name__,
            exc,
        )
        _mark_degraded(
            None,
            "embed_error",
            f"query embedding failed ({type(exc).__name__}: {exc}); lexical matching only",
        )
        return None


def _run_async_in_thread(
    coro_factory: Callable[[], Any],
    *,
    timeout: float | None = 15.0,
) -> Any:
    """Run an async coroutine in a separate thread with its own event loop.

    This avoids ``Cannot run the event loop while another loop is running``
    when :func:`build_index` / :func:`search_index` are called from within an
    async context (e.g. tests using ``asyncio.run``).

    Never call this from the *same* thread that owns a running loop and then
    join forever — that stalls the gateway. If a loop is already running on
    this thread, refuse immediately. ``timeout`` caps ``join`` for worker-thread
    callers (remote embed 429 retries can otherwise hang for minutes).
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError(
            "refusing _run_async_in_thread while an event loop is running on this thread"
        )

    result: list[Any] = [None]
    exception: list[BaseException | None] = [None]

    def _runner() -> None:
        try:
            loop = asyncio.new_event_loop()
            try:
                result[0] = loop.run_until_complete(coro_factory())
            finally:
                loop.close()
        except BaseException as exc:  # noqa: BLE001
            exception[0] = exc

    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    t.join(timeout=timeout)

    if t.is_alive():
        raise TimeoutError(
            f"_run_async_in_thread timed out after {timeout}s (daemon still running)"
        )

    if exception[0] is not None:
        raise exception[0]
    return result[0]


def _index_embeddings_sync(
    root: str,
    root_path: Path,
    files: list[Path],
    cfg: CodeIndexConfig,
) -> int:
    """Batch-embed files and store vectors in ``code_vec``.

    Called after the FTS/symbols batch loop in :func:`build_index`.
    Runs embedding in a fresh event loop because the build path is
    synchronous (background thread). Returns the number of files embedded.
    """
    if not cfg.semantic_search_enabled:
        return 0

    # Collect (rel_path, text) pairs
    # 【self-evolution-bot · 2026-11-16 · 第24轮】跳过空/纯空白文本。
    # 为什么：云端向量接口遇到空 input 直接整单 400（实测
    # "The parameter `input` ... input could not be empty"），
    # 而本仓有 8 个 len=0 的 __init__.py 之类文件，只要有一个混进批次，
    # 整批嵌入全部失败 → code_vec 长期 0 行，语义召回根本不存在。
    pairs: list[tuple[str, str]] = []
    skipped_empty = 0
    for fp in files:
        try:
            rel = fp.relative_to(root_path).as_posix()
            text = fp.read_text(encoding="utf-8", errors="replace")[: cfg.max_chars_per_file]
        except OSError:
            continue
        if not text.strip():
            skipped_empty += 1
            continue
        # 【self-evolution-bot · 2026-11-16 · 第26轮】一文件切成多块再嵌入。
        # 为什么：本地 bge-small-zh 的 max_seq_length 只有 512 token，
        # 而仓库文件 chars/token P50=2.5 → 600 字符≈240 token、48k 字符≈19k token。
        # 整文件嵌入时模型只看前 512 token（≈1280 字符），一个 2 万字符的文件
        # 平均只有 31.8% 的内容进入向量——这是本地 top1 只有 2/8 的真因，不是模型差。
        # pairs 的元素改成 (rel, chunk_text)，下面按块写入 code_vec。
        for idx, piece in enumerate(_chunk_text(text)):
            pairs.append((rel, piece))

    if skipped_empty:
        logger.info("code_index: 跳过 %d 个空文件（不送嵌入）", skipped_empty)

    if not pairs:
        return 0

    # Batch embed (sync path avoids asyncio.to_thread issues in background threads)
    # 【self-evolution-bot · 2026-11-16 · 第26轮】按批嵌入并按批落库，不再一次性喂全部。
    # 为什么：切块后全仓约 14.2 万块（实测 600/75 口径 141,994 块），
    # 一次 embed 全部 + 全部向量驻留内存 = 141994 × 512 × 4B ≈ 290 MB，
    # 且本地 encode 单次跨度过大会把 GIL 线程占满几十秒（现有 30s 看门狗会直接超时）。
    # 分批后峰值内存降到单批量级，且每批成功即落库，中途失败不会全丢。
    dim = 0
    conn = _connect(root)
    try:
        _ensure_schema(conn)
        count = 0
        failed_chunks = 0
        batch_size = _EMBED_CHUNK_BATCH
        for start in range(0, len(pairs), batch_size):
            batch = pairs[start : start + batch_size]
            try:
                embeddings = _embed_texts_sync([t for _, t in batch])
            except Exception as exc:
                logger.warning("code_index: embedding failed: %s: %s", type(exc).__name__, exc)
                embeddings = None

            # 【self-evolution-bot · 2026-11-16 · 第24轮】整批失败不能连坐。
            # 一把梭失败（超长文件、单条被接口拒）时退回二分拆批，能救多少算多少，
            # 而不是整库 0 行。
            # 【第26轮】二分拆批保住 O(log n) 次调用，别退化成逐块重试。
            if not embeddings or len(embeddings) != len(batch):
                embeddings = _embed_texts_with_bisect(batch)

            if not embeddings or len(embeddings) != len(batch):
                logger.warning(
                    "code_index: embedding count mismatch (%d vs %d), skipping batch at %d",
                    len(embeddings or []),
                    len(batch),
                    start,
                )
                failed_chunks += len(batch)
                continue

            # 【self-evolution-bot · 2026-11-16 · 第24轮】以「实际向量长度」为权威维度，
            # 不再拿配置里的静态 512 卡。首条非空向量的长度即权威维度。
            if not dim:
                dim = next((len(v) for v in embeddings if v), 0)
                if not dim:
                    logger.warning("code_index: 本轮没有任何可用向量，跳过写入")
                    return 0
                if not _ensure_vec_table_dim(conn, dim):
                    logger.warning(
                        "code_index: code_vec 维度对齐失败，本轮 %d 块向量未写入", len(pairs)
                    )
                    return 0

            # 【self-evolution-bot · 2026-11-17 · 第41轮】vec0 **不支持** `INSERT OR REPLACE`。
            # 为什么这行必须改：实测 `INSERT OR REPLACE INTO code_vec(...)` 撞已有 chunk_id
            # 直接抛 `UNIQUE constraint failed`（vec0 0.1.6），而原来的兜底是
            # **函数级** `except sqlite3.OperationalError` → 第一块撞键就跳出整个向量段、
            # `return 0`，前面写好的也一起作废。
            # 实证后果：重建跑完 7839 文件 / 51746 符号后 `code_vec` 只有 20389 块、
            # distinct path 仅 1394 → **6446 个文件（82%）没有向量**，
            # 而 stale 判据还按「块数<文件数」算完整，于是语义召回长期只覆盖 18% 无人察觉。
            # 修法：改走 `_write_code_vec_row`（先 DELETE 同名块再 INSERT，vec0 支持 DELETE），
            # 且**逐块 try/except**，单块写失败只丢它自己，不毁整批、更不毁整段。
            for offset, ((rel, _), vec) in enumerate(zip(batch, embeddings, strict=True)):
                if not vec or len(vec) != dim:
                    failed_chunks += 1
                    continue
                try:
                    _write_code_vec_row(conn, f"{rel}::{start + offset}", rel, vec)
                except sqlite3.Error:
                    # 单块失败不连坐：这一块没向量，别的照写。
                    failed_chunks += 1
                    continue
                count += 1
            conn.commit()
            # 【self-evolution-bot · 2026-11-17 · 第31轮】向量段逐批上报进度。
            # 为什么：这个阶段占整个建库的大头（本仓约 14 万块、20~40 分钟），
            # 而原来只在进入/退出各报一次，中间几十分钟界面上完全静止，
            # 用户没法判断是「正在跑」还是「卡死了」——这正是「哪里能看到进度」的由来。
            # 累计值写进 meta，Gateway 跨进程可读。
            _update_build_progress(
                root,
                phase="embedding",
                indexed_files=len(files),
                vectors_total=len(pairs),
                vectors_done=count,
            )

        logger.info(
            "code_index: embedded %d/%d 块 into code_vec (dim=%d, %d 个文件)",
            count,
            len(pairs),
            dim,
            len(files),
        )
        if failed_chunks:
            logger.warning("code_index: %d 块未能写入向量（维度不符或嵌入失败）", failed_chunks)
        return count
    except sqlite3.OperationalError as exc:
        logger.warning("code_index: code_vec insert failed: %s", exc)
        return 0
    finally:
        conn.close()


def _semantic_recall_sync(
    conn: sqlite3.Connection,
    query_text: str,
    top_k: int,
    cfg: CodeIndexConfig,
) -> list[dict]:
    """Embed query and recall top-k files by vector similarity.

    Returns list of ``{path, score, distance, kind: 'semantic'}``.
    Returns empty list if embedding or vec0 is unavailable — and in that case
    records the reason via :func:`_mark_degraded` so callers can surface
    "lexical only" instead of silently pretending the hybrid path ran;
    read it back with :func:`_collect_degraded`.
    """
    if not cfg.semantic_search_enabled:
        return []

    # Embed query (sync path bypasses asyncio.to_thread — see _embed_query_sync)
    try:
        query_vec = _embed_query_sync(query_text)
    except Exception as exc:
        logger.warning("code_index: query embedding failed: %s: %s", type(exc).__name__, exc)
        _mark_degraded(
            None,
            "embed_error",
            f"query embedding failed ({type(exc).__name__}: {exc}); lexical matching only",
        )
        return []

    if not query_vec:
        # 具体原因已由 _embed_query_sync 写进 thread-local；**不能无条件覆盖**——
        # 之前这里硬写 no_vector，把更准确的 warming_up 盖掉了（实测：冷启动首查
        # 明明在暖机，输出却说「返回空向量」，等于把用户往错误方向引）。
        if not getattr(_DEGRADE_STATE, "code", ""):
            _mark_degraded(
                None,
                "no_vector",
                "query embedding returned no vector; lexical matching only",
            )
        return []

    # 【self-evolution-bot · 2026-11-16 · 第24轮】召回侧同样以表里声明的维度为准，
    # 不再拿配置的静态 512 去比；不一致时给 warning，别再 debug 静默返回空列表。
    table_dim = _table_vec_dim(conn)
    if table_dim and len(query_vec) != table_dim:
        logger.warning(
            "code_index: 查询向量维度 %d 与 code_vec 声明维度 %d 不一致，语义召回跳过（需重建索引）",
            len(query_vec),
            table_dim,
        )
        _mark_degraded(
            None,
            "dim_mismatch",
            f"query vector is {len(query_vec)}-dim but the index stores {table_dim}-dim;"
            " semantic recall skipped until the index is rebuilt",
        )
        return []

    blob = _pack_vec(query_vec)
    try:
        # 【self-evolution-bot · 2026-11-16 · 第26轮】一文件多块 → k 要放大，再按文件去重。
        # 为什么：表里每个文件有几十个块，直接取 top_k 个块可能全落在同一个文件里，
        # 文件级召回数会严重不足（原来 top_k=20 时实际可能只有 1~2 个文件）。
        # 这里取 top_k 的 _SEMANTIC_CHUNK_FANOUT 倍块数，按 path 聚合取最高分，
        # 最后截回 top_k 个文件——与改造前的「top_k 个文件」语义保持一致。
        rows = conn.execute(
            "SELECT path, chunk_id, distance FROM code_vec WHERE embedding MATCH ? AND k = ? "
            "ORDER BY distance",
            (blob, max(top_k, top_k * _SEMANTIC_CHUNK_FANOUT)),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        # vec0 模块缺失 / 表不存在 —— 这是「语义本来就不是这台机器能提供的」，
        # 不是临时故障，但调用方仍要知道结果只有词法。
        _mark_degraded(
            None,
            "vec_unavailable",
            f"vector table unusable ({exc}); lexical matching only",
        )
        return []

    # 按文件聚合：同一文件多个块命中时只保留最相似的那块（距离最小）。
    best: dict[str, dict] = {}
    for r in rows:
        path = str(r["path"] or "")
        if not path:
            continue
        dist = float(r["distance"])
        prev = best.get(path)
        if prev is None or dist < prev["distance"]:
            best[path] = {
                "path": path,
                "chunk_id": str(r["chunk_id"] or ""),
                "distance": dist,
            }
    ranked = sorted(best.values(), key=lambda d: d["distance"])[:top_k]
    return [
        {
            "path": d["path"],
            "chunk_id": d["chunk_id"],
            "distance": round(d["distance"], 4),
            "score": round(1.0 - d["distance"], 4),
            "kind": "semantic",
        }
        for d in ranked
    ]


def _fts_document(rel: str, snippet: str, symbol_names: list[str] | None = None) -> str:
    aux = build_fts_aux_text(rel, snippet, symbol_names)
    return f"{rel}\n{snippet}\n{aux}" if aux else f"{rel}\n{snippet}"


def _mark_reindex_if_tokenizer_changed(conn: sqlite3.Connection) -> None:
    ver = index_tokenizer_version()
    row = conn.execute("SELECT value FROM meta WHERE key='index_tokenizer_version'").fetchone()
    if row and str(row[0]) == ver:
        return
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('index_tokenizer_version', ?)",
        (ver,),
    )
    # Missing key = legacy DB built before versioning; differing value = tokenizer changed.
    # Either way the FTS corpus must be rebuilt. Fresh builds stamp the version in
    # ``_touch_index_meta`` so this path is not hit right after a successful index.
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_needs_rebuild', '1')")
    conn.commit()


def _delete_file_vectors(conn: sqlite3.Connection, rel: str) -> int:
    """按主键删掉某文件的所有向量块，**不做全表扫**。

    【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：从「`DELETE FROM code_vec WHERE path = ?`（辅助列过滤）」
    改成「先按 id 前缀从 code_vec_rowids 查出 chunk_id，再按主键逐个删」。

    为什么：`code_vec` 是 vec0 虚表，声明成
    `vec0(chunk_id TEXT PRIMARY KEY, path TEXT, embedding FLOAT[512])` ——
    `path` 只是**辅助列**，vec0 不为它建索引。于是按 path 删要扫全表。
    本机实测（119136 行、库 1.84GB）：
      A 按 path 删           311.4ms  删 12 行   ← 现状，O(全表)
      B 前缀查 id（走索引）    0.0ms   拿到 12 个
      C 按 chunk_id 主键删     0.4ms   删 12 行   ← 改后，O(本文件块数)
      D LIKE 前缀查          129.0ms  拿到 12 个  ← 会走全扫，故不用 LIKE
    快约 780 倍，且代价与「库里有多少其它文件」无关。

    这段为什么值得修（不只是数字好看）：单文件增量 `index_file` 的删除段
    原本要 311ms/文件，漂移自愈一轮 24 个文件就是 7.5 秒的写事务；
    WAL checkpoint 与写锁持有时长同步放大，用户这时搜索就被挡在门外
    （2026-11-18 20:48 现网实测：重建窗口内一次检索 10245ms）。

    为什么用 `>=` / `<` 半开区间而不是 `LIKE 'rel||::%'`：
    `id` 上有 UNIQUE 索引，半开区间是纯 B-tree seek（0.0ms）；
    LIKE 前缀在 sqlite 里无法保证走索引（实测 129ms，等于没优化）。
    区间上界用 `rel + ":;"`：`;` 是 `:` 的下一个字符，能覆盖所有
    `rel::序号` 而不会误伤 `rel2::` 这类前缀相同的邻居文件。
    """
    lo = f"{rel}::"
    hi = f"{rel}:;"  # ';' 紧接 ':'，闭开区间覆盖 rel::* 且不碰 rel2::
    ids = [
        r[0]
        for r in conn.execute(
            "SELECT id FROM code_vec_rowids WHERE id >= ? AND id < ?", (lo, hi)
        )
    ]
    for chunk_id in ids:
        conn.execute("DELETE FROM code_vec WHERE chunk_id = ?", (chunk_id,))
    return len(ids)


def _delete_path_from_index(conn: sqlite3.Connection, rel: str) -> None:
    conn.execute("DELETE FROM fts_content WHERE path = ?", (rel,))
    conn.execute("DELETE FROM symbols WHERE path = ?", (rel,))
    conn.execute("DELETE FROM file_deps WHERE from_path = ? OR to_path = ?", (rel, rel))
    conn.execute("DELETE FROM internal_refs WHERE from_path = ? OR to_path = ?", (rel, rel))
    conn.execute("DELETE FROM type_relations WHERE from_path = ? OR to_path = ?", (rel, rel))
    try:
        _delete_file_vectors(conn, rel)
    except sqlite3.OperationalError:
        pass  # vec0 table may not exist if sqlite-vec is unavailable


def _index_file_deps(conn: sqlite3.Connection, root: Path, rel: str, text: str, cfg: CodeIndexConfig) -> int:
    if not cfg.dependency_graph_enabled:
        return 0
    conn.execute("DELETE FROM file_deps WHERE from_path = ?", (rel,))
    abs_path = root / rel
    deps = extract_file_deps(abs_path, text, root)
    count = 0
    for d in deps:
        conn.execute(
            """
            INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind)
            VALUES (?, ?, ?, ?, ?)
            """,
            (rel, d["spec"], int(d.get("line") or 0), d.get("to_path"), d.get("dep_kind") or "import"),
        )
        count += 1
    return count


def _index_internal_refs(conn: sqlite3.Connection, root: Path, rel: str, text: str, cfg: CodeIndexConfig) -> int:
    if not cfg.internal_refs_enabled:
        return 0
    abs_path = root / rel
    from evoflow.code_index.internal_refs import extract_internal_refs, supports_internal_refs

    if not supports_internal_refs(abs_path):
        return 0

    conn.execute("DELETE FROM internal_refs WHERE from_path = ?", (rel,))
    refs = extract_internal_refs(abs_path, text, root)
    for r in refs:
        conn.execute(
            """
            INSERT OR REPLACE INTO internal_refs(from_path, to_path, line, ref_kind, symbol)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                r["from_path"],
                r["to_path"],
                int(r.get("line") or 0),
                r.get("ref_kind") or "import_use",
                str(r.get("symbol") or ""),
            ),
        )
    return len(refs)


def _index_type_relations(conn: sqlite3.Connection, root: Path, rel: str, text: str, cfg: CodeIndexConfig) -> int:
    if not cfg.type_relations_enabled:
        return 0
    abs_path = root / rel
    from evoflow.code_index.type_relations import extract_type_relations, supports_type_relations

    if not supports_type_relations(abs_path):
        return 0

    conn.execute("DELETE FROM type_relations WHERE from_path = ?", (rel,))
    try:
        from_rel = abs_path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        from_rel = rel
    rows = extract_type_relations(abs_path, text, root, conn=conn)
    from evoflow.code_index.type_relations import enrich_type_relations

    enrich_type_relations(conn, rows, from_rel=from_rel)
    for r in rows:
        conn.execute(
            """
            INSERT OR REPLACE INTO type_relations(from_path, from_type, to_path, to_type, rel_kind, line)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                r["from_path"],
                r["from_type"],
                r.get("to_path"),
                r["to_type"],
                r.get("rel_kind") or "extends",
                int(r.get("line") or 0),
            ),
        )
    return len(rows)


def _index_one_file(
    conn: sqlite3.Connection,
    root: Path,
    rel: str,
    cfg: CodeIndexConfig,
    *,
    for_full_build: bool = False,
) -> int:
    """Insert FTS + symbols for one relative path; return symbol count."""
    abs_path = root / rel
    if not abs_path.is_file() or not _should_index_file(abs_path):
        return 0
    text = abs_path.read_text(encoding="utf-8", errors="replace")
    snippet = text[: cfg.max_chars_per_file]
    _delete_path_from_index(conn, rel)
    sym_names: list[str] = []
    sym_count = 0
    for sym in extract_symbols(abs_path, text, workspace_root=str(root), for_full_build=for_full_build):
        sym_names.append(str(sym["name"]))
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            (rel, sym["name"], sym["kind"], sym["line"]),
        )
        sym_count += 1
    conn.execute(
        "INSERT INTO fts_content(path, content) VALUES (?, ?)",
        (rel, _fts_document(rel, snippet, sym_names)),
    )
    _index_file_deps(conn, root, rel, text, cfg)
    _index_internal_refs(conn, root, rel, text, cfg)
    _index_type_relations(conn, root, rel, text, cfg)
    return sym_count


def _touch_index_meta(conn: sqlite3.Connection, root: str, dbp: Path) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('root', ?)", (root,))
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('indexed_at', ?)",
        (str(int(time.time())),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('index_db_path', ?)",
        (str(dbp),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('index_tokenizer_version', ?)",
        (index_tokenizer_version(),),
    )
    # 【self-evolution-bot · 2026-11-16 · 第26轮】记下本次建库用的 max_files 上限。
    # 为什么必须记：状态判定要能区分「索引完整」与「被截断」。
    # 本机那张表 3001 个文件、上限正好 3000——不记上限的话，
    # 下次把上限调大也判断不出这张表是残缺的，重建永远不会触发。
    try:
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('indexed_max_files', ?)",
            (str(int(get_code_index_config().max_files)),),
        )
    except Exception:  # noqa: BLE001 - 记录失败不能挡住建库收尾
        logger.debug("code_index: write indexed_max_files failed", exc_info=True)


def index_file(
    workspace_root: str | None = None,
    *,
    relative_path: str,
    thread_id: str | None = None,
    deleted: bool = False,
) -> dict:
    """Incrementally update or remove one file from the workspace index."""
    cfg = get_code_index_config()
    if not cfg.enabled:
        return {"ok": False, "reason": "disabled"}
    if not cfg.incremental_enabled:
        return {"ok": False, "reason": "incremental_disabled"}
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    root_path = Path(root)
    try:
        rel = _normalize_relative_path(root_path, relative_path)
    except (ValueError, FileNotFoundError) as e:
        return {"ok": False, "reason": str(e)}
    if _path_has_skipped_segment(rel):
        return {"ok": True, "action": "skipped", "path": rel, "reason": "ignored_path"}
    # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
    # 全量建库已尊重 .gitignore（`_iter_source_files`），单文件增量入口也必须一致，
    # 否则 watcher 一旦开启就会把 outputs/ 里的探针重新塞回库里，
    # 等于「刚扫干净又被自己污染」。判据同全量：目录级 ignore 命中即拒。
    if _path_is_git_ignored(root_path, rel):
        return {"ok": True, "action": "skipped", "path": rel, "reason": "git_ignored"}

    dbp = _db_path(root)

    def _update() -> dict:
        conn = _connect(root)
        try:
            _ensure_schema(conn)
            _mark_reindex_if_tokenizer_changed(conn)

            abs_path = root_path / rel
            if deleted or not abs_path.exists():
                _delete_path_from_index(conn, rel)
                _touch_index_meta(conn, root, dbp)
                conn.commit()
                return {"ok": True, "action": "removed", "path": rel, "root": root, "db_path": str(dbp)}

            if not _should_index_file(abs_path):
                _delete_path_from_index(conn, rel)
                _touch_index_meta(conn, root, dbp)
                conn.commit()
                return {
                    "ok": True,
                    "action": "removed",
                    "path": rel,
                    "reason": "not_indexable",
                    "root": root,
                }

            sym_count = _index_one_file(conn, root_path, rel, cfg)

            # Incremental embedding for this file
            if cfg.semantic_search_enabled:
                try:
                    inc_text = abs_path.read_text(encoding="utf-8", errors="replace")[
                        : cfg.max_chars_per_file
                    ]
                    # 【self-evolution-bot · 2026-11-16 · 第26轮】增量也要切块，与全量口径一致。
                    # 原来这里只嵌入整文件一条（且用的是 query role），改块级之后
                    # 两个路径必须同口径，否则增量更新的文件永远只有 1 个向量、
                    # 而全量建的文件有几十个——召回会系统性偏向刚改过的文件。
                    pieces = _chunk_text(inc_text)
                    if pieces:
                        vecs = _embed_texts_sync(pieces)
                        tdim = _table_vec_dim(conn)
                        if not vecs or len(vecs) != len(pieces):
                            logger.warning(
                                "code_index: 增量嵌入返回 %d 条（应为 %d），跳过 %s",
                                len(vecs or []),
                                len(pieces),
                                rel,
                            )
                        elif tdim and any(v and len(v) != tdim for v in vecs):
                            logger.warning(
                                "code_index: 增量向量维度与 code_vec 声明 %d 不一致，跳过 %s（需重建索引）",
                                tdim,
                                rel,
                            )
                        else:
                            # 先清掉该文件的旧块，再写新块——否则文件变短后尾块会残留。
                            conn.execute("DELETE FROM code_vec WHERE path = ?", (rel,))
                            for idx, vec in enumerate(vecs):
                                if not vec:
                                    continue
                                # 【self-evolution-bot · 2026-11-17 · 第41轮】改走统一出口。
                                # 上一行已按 path 全删，本可直接 INSERT；但统一走
                                # `_write_code_vec_row` 是为了让「vec0 必须先删后插」
                                # 这条事实只有一个落点，避免两处再次分叉。
                                _write_code_vec_row(conn, f"{rel}::{idx}", rel, vec)
                except Exception as exc:
                    logger.warning("code_index: incremental embedding failed for %s: %s", rel, exc)

            _touch_index_meta(conn, root, dbp)
            conn.commit()
            return {
                "ok": True,
                "action": "updated",
                "path": rel,
                "symbols": sym_count,
                "root": root,
                "db_path": str(dbp),
            }
        finally:
            conn.close()

    return run_index_db(root, _update)


_GENERATED_DIR_NAMES = frozenset(
    {
        # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
        # 这些是「东西被生成出来放的地方」，不是人写的源码或文档。
        # 只有同时满足「在 .gitignore 里」才排除（见 _git_ignored_dirs）。
        "outputs",
        "site",
        "tmp",
        "temp",
        "reports",
        "logs",
        "wallpaper",
        "videos",
        "uploads",
        "web",
        "test-results",
        "build-temp",
        "vite-cache",
        "node_modules",
        "dist",
        "target",
        "binaries",
        "_internal",
        "agent-browser-bundle",
    }
)


def _git_ignored_dirs(root: Path) -> set[str]:
    """返回被项目 `.gitignore` 忽略的**目录**相对路径集合（如 ``{"outputs", "site"}``）。

    【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】

    为什么必须让索引器尊重 `.gitignore`：仓库里存在大量「生成物目录」，
    它们是产物/探针落点，不是产品源码，却会污染检索结果。本轮实测三条后果：
      1) 负例查询失效：`outputs/eval_search_tool.py`（我自己的评测脚本）里
         写了一个纯随机字符串常量，于是用户问一个根本不存在的符号时，
         索引"命中"了 1 个文件并返回 10 条无关结果 —— **索引把测试夹具当成了答案**。
      2) 排序位被挤占：探针脚本里的临时符号名与真实业务符号竞争前排。
      3) 磁盘 8425 个可索引文件里 982 个（12%）落在被忽略目录内，白解析白占库。

    为什么用 ``--directory`` 而不是逐文件 ``--stdin``：实测这两条路差距巨大——
      · ``git check-ignore --stdin``（逐个喂 8150 个路径）：**3077ms**
      · ``git ls-files --others --ignored --exclude-standard --directory``：**101ms**
    目录级忽略（``outputs/`` 这种）是 .gitignore 里的绝对多数，目录级拿到就够了；
    文件级忽略（如 ``*.log``）本就多数被 ``_TEXT_SUFFIXES`` 或大小限制挡掉。

    失败一律返回空集：这不是索引正确性的前提，拿不到就当没有，绝不能让
    「git 不在 PATH / 不是 git 仓库」把建库搞崩。
    """
    try:
        proc = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
            ],
            capture_output=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    if proc.returncode != 0:
        return set()
    try:
        out = proc.stdout.decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return set()
    dirs: set[str] = set()
    for line in out.splitlines():
        rel = line.strip().strip('"')
        if not rel.endswith("/"):
            continue
        rel = rel.rstrip("/")
        if not rel:
            continue
        rel = rel.replace("\\", "/")
        # 只排除**生成物语义**的目录名。判据来自轮内实测的库内分布：
        #   outputs 19 / site 128 / tmp 53 / web 39 / reports 14 / temp 9+26 / logs 6
        #   —— 全是产物或临时落点。
        # 而下面这些虽也被 .gitignore（本地个人数据不入库），
        # **内容是真实文本、值得被检索**，必须保留，否则等于把 agent 记忆与
        # 角色文档从索引里删掉：
        #   backend/docs/roles 339 行、docs/roles 105 行、backend/assets 23 行、
        #   skills/custom 14 行、memory 2 行。
        # 所以判据不是「git 有没有忽略它」，而是「它是不是生成物落点」。
        leaf = rel.rsplit("/", 1)[-1].casefold()
        if leaf in _GENERATED_DIR_NAMES:
            dirs.add(rel)
    return dirs


_GIT_IGNORED_DIRS_CACHE: dict[str, tuple[float, set[str]]] = {}
_GIT_IGNORED_TTL_SECONDS = 60.0


def _path_is_git_ignored(root: Path, rel: str) -> bool:
    """单文件路径是否落在被 `.gitignore` 忽略的目录里（增量入口用）。

    复用 `_git_ignored_dirs` 的 60 秒缓存：watcher 每来一个文件都跑一次 git 太贵
    （97ms/次），而 .gitignore 本身极少改。
    """
    dirs = _git_ignored_dirs_cached(root)
    if not dirs:
        return False
    r = str(rel).replace("\\", "/").lstrip("./")
    return any(r == d or r.startswith(d + "/") for d in dirs)


def _git_ignored_dirs_cached(root: Path) -> set[str]:
    key = str(root).replace(os.sep, "/")
    now = time.time()
    hit = _GIT_IGNORED_DIRS_CACHE.get(key)
    if hit is not None and now - hit[0] < _GIT_IGNORED_TTL_SECONDS:
        return hit[1]
    dirs = _git_ignored_dirs(root)
    _GIT_IGNORED_DIRS_CACHE[key] = (now, dirs)
    if len(_GIT_IGNORED_DIRS_CACHE) > 8:
        oldest = min(_GIT_IGNORED_DIRS_CACHE, key=lambda k: _GIT_IGNORED_DIRS_CACHE[k][0])
        _GIT_IGNORED_DIRS_CACHE.pop(oldest, None)
    return dirs


def _iter_source_files(root: Path, max_files: int) -> list[Path]:
    found: list[Path] = []
    try:
        root_resolved = root.resolve()
    except OSError:
        root_resolved = root
    # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
    # 尊重项目自己的 .gitignore：只跳过「目录级」被忽略的目录（outputs/ / site/ …），
    # 这些是生成物与一次性探针的落点。取一次 101ms，且只在遍历开始时取一次。
    # 不跳过时的实测后果见 `_git_ignored_dirs` 的 docstring（负例查询被自己的
    # 评测脚本伪装成"命中"，返回 10 条无关结果）。
    ignored = _git_ignored_dirs(root)
    ignored_abs: set[str] = set()
    if ignored:
        rp = str(root_resolved).replace(os.sep, "/").rstrip("/")
        for rel in ignored:
            ignored_abs.add(f"{rp}/{rel}")
    for dirpath, dirnames, filenames in os.walk(root):
        kept: list[str] = []
        for d in dirnames:
            if d in _SKIP_DIRS or d.startswith("."):
                continue
            child = Path(dirpath) / d
            if _dir_escapes_workspace(child, root_resolved):
                continue
            if ignored_abs and str(child).replace(os.sep, "/") in ignored_abs:
                continue
            kept.append(d)
        dirnames[:] = kept
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() not in _TEXT_SUFFIXES:
                continue
            try:
                if p.stat().st_size > 512_000:
                    continue
            except OSError:
                continue
            found.append(p)
            if len(found) >= max_files:
                return found
    return found


_COVERAGE_CACHE: dict[str, tuple[tuple[float, int], tuple[int, int, int]]] = {}
_COVERAGE_CACHE_MAX = 8


def _vector_coverage_counts(
    conn: sqlite3.Connection, root: str, dbp: Path
) -> tuple[int, int, int]:
    """``(vec_n, vec_paths, denom)`` —— 向量覆盖率判据要的三个数。

    【self-evolution-bot · 2026-11-18 · 第45轮 · 模型:deepseek-v4.1-flash-1017】

    为什么单独抽出来并缓存：这两条 ``COUNT(DISTINCT path)`` 是 `index_status` 里
    唯一的重活，而 `index_status` 一次 `search_index` 会调 3 次。逐条 SQL 归因实测
    （1.84GB 库、118605 块、7841 文件）：

    - ``SELECT COUNT(DISTINCT path) FROM code_vec``  **548ms**
    - ``SELECT COUNT(DISTINCT path) FROM fts_content``  **51ms**
    - 对照 ``SELECT COUNT(*) FROM code_vec`` 只要 **32ms**（走覆盖索引）

    即 600ms 全部花在「数有多少个不同文件」上，占稳态 1.36s 检索的 44%。
    这三条数只在**索引被写过**时才可能变，而索引被写必然会改 ``index.db`` 的 mtime，
    所以判据取 ``(st_mtime, st_size)``——与 catalog / search 的行缓存同一手法，
    也覆盖「同一秒内重写、mtime 秒级不变」的情况。
    命中缓存时 0 次 SQL；未命中才回原路径，语义完全不变。
    """
    try:
        db_stat = dbp.stat()
        key_stat = (db_stat.st_mtime, db_stat.st_size)
    except OSError:
        key_stat = (0.0, 0)
    hit = _COVERAGE_CACHE.get(root)
    if hit is not None and hit[0] == key_stat:
        return hit[1]
    # 【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：`vec_paths` 不再对 vec0 虚表做 `COUNT(DISTINCT path)`，改为在
    # `code_vec_rowids` 上数 `substr(id,1,instr(id,'::')-1)`；`denom` 改走
    # fts5 影子表 `fts_content_docsize`（每文档一行）。
    # 为什么：`path` 在 vec0 里只是**辅助列**，vec0 不为它建索引，于是
    # `COUNT(DISTINCT path)` 要扫整张 1.84GB 虚表。本轮本机三次取中位实测：
    #   现值 COUNT(DISTINCT path) FROM code_vec        334.7ms
    #   改后 rowids 上数 id 前缀（走 UNIQUE 索引）      13.7ms  (-96%)
    #   fts_content 上 COUNT(DISTINCT path)             13.8ms
    #   fts_content_docsize 行数                         0.0ms  (改用影子表)
    # 等价性**全表对拍**（不是抽样）：vec 侧 7893 / rowids 侧 7893 完全相等，
    # 且 `instr(id,'::')=0` 的行数实测 0（切前缀不会漏行）。fts 两个数都 7907。
    # 这段每次检索都要跑，而 `_COVERAGE_CACHE` 判据是 index.db 的 mtime+size——
    # 后台补录每写一次就整段失效，所以稳态下它并不是「一次性的」开销。
    vec_n = int(conn.execute("SELECT COUNT(*) FROM code_vec").fetchone()[0])
    vec_paths = int(
        conn.execute(
            # 【self-evolution-bot · 2026-11-19 · 第63轮】`instr` 找不到 '::' 时返回 0，
            # `substr(id, 1, -1)` 是空串 —— 所有这种行会塌成同一个值，计数悄悄变小
            # 且不报错（既有测试 tests/test_code_index_coverage_count_cache.py 的
            # 种子就用无 '::' 的 chunk_id，当场把这条抓出来）。所以没有分隔符时
            # 退回整串 id，宁可少去重一次也不能静默并成一行。
            "SELECT COUNT(DISTINCT CASE WHEN instr(id, '::') > 0"
            " THEN substr(id, 1, instr(id, '::') - 1) ELSE id END)"
            " FROM code_vec_rowids"
        ).fetchone()[0]
    )
    denom = _fts_doc_count(conn)
    if len(_COVERAGE_CACHE) >= _COVERAGE_CACHE_MAX:
        _COVERAGE_CACHE.pop(next(iter(_COVERAGE_CACHE)), None)
    _COVERAGE_CACHE[root] = (key_stat, (vec_n, vec_paths, denom))
    return vec_n, vec_paths, denom


def _fts_doc_count(conn: sqlite3.Connection) -> int:
    """FTS5 里「有多少条文档」，优先走影子表，别每次全表数。

    【self-evolution-bot · 2026-11-17 · 第34轮】原来这里是
    ``SELECT COUNT(*) FROM fts_content``：FTS5 对虚拟表做 COUNT(*) 要走整棵
    内容表，实测 80ms（8177 条文档、库 1.0GB），而 index_status 每次检索至少调一次。
    ``fts_content_docsize`` 是 fts5 自带影子表，每篇文档一行（默认 columnsize=1），
    实测同样的库 0ms。取数语义不变，只是换了个等价且更省的位置数。
    找不到影子表（老库 columnsize=0）就退回全表 COUNT，不改变正确性。
    """
    try:
        row = conn.execute("SELECT COUNT(*) FROM fts_content_docsize").fetchone()
        if row is not None:
            return int(row[0] or 0)
    except sqlite3.Error:
        pass
    try:
        return int(conn.execute("SELECT COUNT(*) FROM fts_content").fetchone()[0])
    except sqlite3.Error:
        return 0


def _read_index_status_unlocked(root: str, dbp: Path, *, building: bool) -> dict:
    """Lock-free read of index readiness (WAL allows concurrent reads during rebuild)."""
    try:
        conn = _connect(root)
        try:
            _ensure_schema(conn)
            row = conn.execute("SELECT value FROM meta WHERE key='root'").fetchone()
            n = _fts_doc_count(conn)
            sym_n = int(conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0])
            # 【self-evolution-bot · 2026-11-16 · 第26轮】两处修正：
            # (1) vector_available 原来是 conn.close() 之后才算的——use-after-close，
            #     异常被 except 吞掉后 _SQLITE_VEC_AVAILABLE 会被永久缓存成 False，
            #     于是整个进程生命周期都不再报告向量健康度。必须在关连接前算。
            # (2) ready 原来只判「根路径对 + 有文件」，不看索引是否残缺：
            #     本机那张表 3001 个文件（上限 3000 截断）也被判 ready，
            #     于是 schedule_build_index 直接 index_ready 跳过重建，
            #     9000 个文件里 6000 个永远进不了库——这是「搜不到东西」的第一原因。
            vec_ok = _sqlite_vec_available(conn)
            stale_reasons: list[str] = []
            cfg = get_code_index_config()
            built_max = conn.execute(
                "SELECT value FROM meta WHERE key='indexed_max_files'"
            ).fetchone()
            built_max_n = int(built_max[0]) if built_max and str(built_max[0]).isdigit() else 0
            if built_max_n and int(cfg.max_files) > built_max_n:
                stale_reasons.append(
                    f"max_files_upgraded:{built_max_n}->{int(cfg.max_files)}"
                )
            elif not built_max_n and n > 0 and n >= 3000:
                # 旧库没记录上限、且文件数顶到旧默认值 → 几乎必然是截断产物
                stale_reasons.append("max_files_unrecorded_at_old_cap")
            if cfg.semantic_search_enabled and vec_ok:
                vec_n = 0
                vec_paths = 0
                # 【self-evolution-bot · 2026-11-18 · 第44轮 · 模型:deepseek-v4.1-flash-1017】
                # 判据的分母必须与分子**同口径**，否则会造出一个永远达不到的阈值。
                # 分子 `vec_paths` 是 `COUNT(DISTINCT path)`（按文件数），原来分母 `n`
                # 直接取 `_fts_doc_count()` 的**行数**——正常情况两者相等，看不出来；
                # 一旦 fts 出现同 path 多行（并发构建交错写，本机实测 9040 行 / 7840 path
                # = 1200 条重复），分母虚涨而分子天花板不变：
                #   阈值 = 9040 × 0.98 = 8859，分子上限 = 7840 → **永远 False**。
                # 后果不是「少一条提示」，而是 `ready=False` 恒定 → `schedule_build_index`
                # 每次都判「索引残缺」→ 每次检索都重烧一遍全仓，用户只感觉「越用越慢」。
                # 修法：分母单独取 distinct path，与分子同口径；行数仍然用于 `files` 展示
                # （那才是「库里有多少篇文档」的语义）。顺带花 99ms，只在残缺判定路径上跑一次。
                denom = 0
                try:
                    # 【self-evolution-bot · 2026-11-18 · 第45轮 · 模型:deepseek-v4.1-flash-1017】
                    # 三条计数改走 `_vector_coverage_counts`（带「索引库没被写过就复用」缓存）。
                    # 原来这里直接跑两条 COUNT(DISTINCT path)，实测合计 599ms，
                    # 而 `index_status` 一次检索要被调 3 次、本函数在每个调用里都跑一遍。
                    vec_n, vec_paths, denom = _vector_coverage_counts(conn, root, dbp)
                except sqlite3.OperationalError:
                    vec_n = 0
                    vec_paths = 0
                    denom = 0
                if denom <= 0:
                    denom = n
                if n > 0 and vec_n == 0:
                    stale_reasons.append("vectors_missing")
                elif denom > 0 and vec_paths < denom * _VECTORS_COVERAGE_MIN:
                    # 容差 2%：本仓实测 8/7839 个空文件（纯空白，不送嵌入）合法无向量，
                    # 占 0.1%；留 2% 既不会因空文件天天误报重建，
                    # 又能把「只有 18% 覆盖」这类真残缺抓出来。
                    stale_reasons.append(f"vectors_incomplete:{vec_paths}<{denom}")
        finally:
            conn.close()
        updated_at = None
        try:
            updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(dbp.stat().st_mtime))
        except OSError:
            pass
        ready = bool(row and str(row[0]) == root and n > 0 and not stale_reasons)
        return {
            "ok": True,
            "ready": ready,
            "building": building,
            "root": root,
            "db_path": str(dbp),
            "files": n,
            "symbols": sym_n,
            "updated_at": updated_at,
            # 【self-evolution-bot · 2026-11-16 · 第23轮】P2 向量健康度（判定单 §四）
            "vector_available": vec_ok,
            # 【self-evolution-bot · 2026-11-16 · 第26轮】索引为何「不完整」，
            # 空列表 = 完整。外部（面板/重建入口）据此决定要不要自动重建，
            # 而不是靠人记得手动点。
            "stale_reasons": stale_reasons,
            # 【self-evolution-bot · 2026-11-17 · 第31轮】子进程构建时，进度只能从库里读。
            # 由 _merge_build_progress 消费后从对外字段里剔除，不外泄这个内部键。
            "_persisted_progress": _read_persisted_build_progress(conn),
        }
    except Exception:
        return {
            "ok": True,
            "ready": False,
            "building": building,
            "root": root,
            "db_path": str(dbp),
            "files": 0,
            "symbols": 0,
            "updated_at": None,
            "stale_reasons": ["status_read_failed"],
        }


def index_status(
    workspace_root: str | None = None,
    *,
    thread_id: str | None = None,
) -> dict:
    """Fast check whether a usable index exists for this workspace root (shared across sessions)."""
    cfg = get_code_index_config()
    if not cfg.enabled:
        return {"ok": False, "reason": "disabled", "ready": False}
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    dbp = _db_path(root)
    key = _workspace_hash(root)
    with _jobs_lock:
        building = key in _build_jobs and _build_jobs[key].is_alive()
    if not dbp.exists():
        return _merge_build_progress(
            {
                "ok": True,
                "ready": False,
                "building": building,
                "root": root,
                "db_path": str(dbp),
                "files": 0,
                "symbols": 0,
            },
            root,
        )
    return _merge_build_progress(_read_index_status_unlocked(root, dbp, building=building), root)


class _BuildJob(Protocol):
    def is_alive(self) -> bool: ...


class _ThreadBuildJob:
    __slots__ = ("_thread",)

    def __init__(self, thread: threading.Thread) -> None:
        self._thread = thread

    def is_alive(self) -> bool:
        return self._thread.is_alive()


class _SubprocessBuildJob:
    """Track a child-process build without holding ML imports in Gateway."""

    __slots__ = ("_proc",)

    def __init__(self, proc: subprocess.Popen[Any]) -> None:
        self._proc = proc

    def is_alive(self) -> bool:
        return self._proc.poll() is None


_build_jobs: dict[str, _BuildJob] = {}


def _code_index_build_inprocess() -> bool:
    """Tests monkeypatch ``build_index`` in-process; production must use a subprocess."""
    return (os.environ.get("EVOFLOW_CODE_INDEX_BUILD_INPROCESS") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _spawn_build_subprocess(
    *,
    workspace_root: str | None,
    thread_id: str | None,
    force: bool,
    job_key: str,
) -> _SubprocessBuildJob:
    from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

    cmd = [sys.executable, "-m", "evoflow.code_index.build_worker"]
    if workspace_root:
        cmd.extend(["--workspace-root", str(workspace_root)])
    if thread_id:
        cmd.extend(["--thread-id", str(thread_id)])
    if force:
        cmd.append("--force")
    # Inherit env so the child sees the same profile / DB roots as Gateway.
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **subprocess_hide_window_kwargs(),
    )
    job = _SubprocessBuildJob(proc)

    def _reap() -> None:
        try:
            proc.wait()
        except Exception:
            logger.debug("code_index: reap wait failed key=%s", job_key, exc_info=True)
        finally:
            with _jobs_lock:
                cur = _build_jobs.get(job_key)
                if cur is job:
                    _build_jobs.pop(job_key, None)

    threading.Thread(
        target=_reap,
        name=f"code-index-reap-{job_key[:8]}",
        daemon=True,
    ).start()
    logger.info(
        "code_index: scheduled subprocess build pid=%s key=%s force=%s",
        proc.pid,
        job_key[:8],
        force,
    )
    return job


# 【self-evolution-bot · 2026-11-17 · 第31轮】进度跨进程可见性。
# 生产默认 `build_worker` 子进程建库，`_build_progress` 是进程内 dict，
# 所以 Gateway 读 /index-status 时 build_phase / build_progress_pct 永远为空，
# 界面上看不到「跑到哪了」。改为同时写进 index.db 的 meta 表（build_progress.* 前缀），
# 子进程构建时 Gateway 也能读到，进程被打断也留痕。
_PROGRESS_META_PREFIX = "build_progress."

_build_progress: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _update_build_progress(root: str, **fields: object) -> None:
    key = _workspace_hash(root)
    with _jobs_lock:
        cur = dict(_build_progress.get(key) or {})
        cur.update(fields)
        _build_progress[key] = cur
    # 【self-evolution-bot · 2026-11-17 · 第31轮】同时落进 index.db 的 meta 表。
    # 为什么：生产默认把构建丢进**子进程**（`build_worker`），而 `_build_progress` 是
    # 进程内 dict —— 于是 Gateway 读 /index-status 拿到 `build_phase=None`、
    # `build_progress_pct=None`，界面上只有「已索引 N 文件」这种事后数字。
    # 向量段是全流程最慢的一段（本仓约 14 万块、20~40 分钟），这段时间界面完全静止，
    # 看起来就像卡死。写进库后 Gateway 能跨进程读，进程被打断也留痕可查。
    _persist_build_progress(root, {k: v for k, v in fields.items() if v is not None})


def _get_build_progress(root: str) -> dict:
    key = _workspace_hash(root)
    with _jobs_lock:
        return dict(_build_progress.get(key) or {})


def _persist_build_progress(root: str, fields: dict) -> None:
    """把构建进度写进 index.db 的 meta 表（失败静默，进度不在关键路径上）。"""
    if not fields:
        return
    try:
        conn = _connect(root)
    except Exception:  # noqa: BLE001
        return
    try:
        for k, v in fields.items():
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                (_PROGRESS_META_PREFIX + str(k), str(v)),
            )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            (_PROGRESS_META_PREFIX + "updated_at", str(int(time.time()))),
        )
        # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
        # 进度落盘就是建库租约的天然心跳 —— 建库每批（_BUILD_BATCH_SIZE 文件 /
        # 64 块向量）都会走一次本函数，实测最慢的一批也远小于 300s TTL。
        # 复用这一处而不是另开线程，是为了不新增任何后台线程（少一个要收尸的东西）。
        _owner = _build_lease_owner.get()
        if _owner:
            refresh_build_lease(conn, _workspace_hash(root), owner=_owner)
        conn.commit()
    except Exception:  # noqa: BLE001 - 进度落盘失败绝不能打断建库
        logger.debug("code_index: persist build progress failed", exc_info=True)
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _clear_build_progress(root: str) -> None:
    key = _workspace_hash(root)
    with _jobs_lock:
        _build_progress.pop(key, None)
    _clear_persisted_build_progress(root)


def _read_persisted_build_progress(conn: sqlite3.Connection) -> dict:
    """从已打开的 index.db 连接读回 build_progress.* 进度（跨进程可见）。

    【self-evolution-bot · 2026-11-17 · 第31轮】补上这个被我漏定义的读侧。
    为什么必须补：`_update_build_progress` 每轮都往 meta 表写 `build_progress.*`，
    `_merge_build_progress` 也早就调用了本函数 —— 但函数体从来没被写出来过。
    调用点抛 NameError，被 `_read_index_status_unlocked` 外层的
    `except Exception` 吞掉，于是整个函数退化到兜底分支：
    `files=0 / symbols=0 / stale_reasons=["status_read_failed"]`。
    实测代价：/index-status 对着一库 9044 文件报 `files=0`，
    而 `ready` 因此恒为 False —— 面板永远认为索引没建好，反复触发重建。
    """
    raw: dict[str, str] = {}
    try:
        rows = conn.execute(
            "SELECT key, value FROM meta WHERE key LIKE ?", (_PROGRESS_META_PREFIX + "%",)
        ).fetchall()
    except sqlite3.Error:
        return {}
    for row in rows:
        try:
            k, v = str(row[0]), str(row[1])
        except (IndexError, TypeError):
            continue
        raw[k[len(_PROGRESS_META_PREFIX) :]] = v
    if not raw:
        return {}
    out: dict[str, object] = {}
    for k, v in raw.items():
        if k == "phase":
            out[k] = v
            continue
        # 数值字段按整数回读；读不出就跳过这个键，而不是塞个 0 假数进去。
        try:
            out[k] = int(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _clear_persisted_build_progress(root: str) -> None:
    try:
        conn = _connect(root)
    except Exception:  # noqa: BLE001
        return
    try:
        conn.execute("DELETE FROM meta WHERE key LIKE ?", (_PROGRESS_META_PREFIX + "%",))
        conn.commit()
    except Exception:  # noqa: BLE001
        logger.debug("code_index: clear persisted progress failed", exc_info=True)
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _merge_build_progress(status: dict, root: str) -> dict:
    prog = _get_build_progress(root)
    if not prog and not status.get("building"):
        # 【self-evolution-bot · 2026-11-17 · 第31轮】进程内没有进度时回退读库里的。
        # 子进程构建的情况下 `_build_progress` 永远是空的，只有落库那份能反映真实进度。
        prog = dict(status.get("_persisted_progress") or {})
    if not prog and not status.get("building"):
        return status
    out = dict(status)
    out.pop("_persisted_progress", None)
    total = int(prog.get("total_files") or status.get("build_total_files") or 0)
    done = int(prog.get("indexed_files") or status.get("build_indexed_files") or 0)
    # 向量段用块数计进度：vectors_done / vectors_total 比「文件数」更能反映真实推进，
    # 这个阶段文件数早已跑满 100%，只看文件数会以为卡住不动。
    v_total = int(prog.get("vectors_total") or 0)
    v_done = int(prog.get("vectors_done") or 0)
    phase = prog.get("phase") or status.get("build_phase")
    if phase in {"embedding", "embedding_done"} and v_total > 0:
        done, total = v_done, v_total
    pct = round(100.0 * done / total, 1) if total > 0 else None
    if prog or status.get("building"):
        out.update(
            {
                "build_total_files": total or None,
                "build_indexed_files": done or None,
                "build_progress_pct": pct,
                "build_phase": phase,
            }
        )
        if prog.get("symbols") is not None:
            out["symbols"] = int(prog.get("symbols") or 0)
    return out


def schedule_build_index(
    workspace_root: str | None = None,
    *,
    thread_id: str | None = None,
    force: bool = False,
    status: dict | None = None,
) -> dict:
    """Enqueue a full index build (one job per workspace root).

    Production default: **subprocess** so embedding-model imports cannot
    stall the Gateway event loop (GIL / import lock are process-wide —
    a background thread does not protect HTTP).

    【self-evolution-bot · 2026-11-18 · 第44轮 · 模型:deepseek-v4.1-flash-1017】
    *status*：调用方已经算过一次 `index_status` 时可传进来复用，别再算一遍。
    实测（2026-11-18 本机，sqlite execute 逐条归因）：一次 `search_index` 里
    `index_status` 被算了 **3 次**，每次含 `SELECT COUNT(DISTINCT path) FROM code_vec`
    约 418ms（1.48GB 库、4.5 万块）→ 合计约 1.56s，占稳态 2.5s 的 61%。
    其中后两次纯属重复：调度前后只可能变 `building`，而 `ready`/`stale_reasons`/`files`
    在没有任何构建完成的情况下不会变，读同一个库算三遍得同一答案。
    """
    cfg = get_code_index_config()
    if not cfg.enabled:
        return {"ok": False, "reason": "disabled"}
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    dbp = _db_path(root)
    if not force:
        st = (
            status
            if status is not None
            else index_status(workspace_root=workspace_root, thread_id=thread_id)
        )
        # 【self-evolution-bot · 2026-11-16 · 第26轮】索引残缺要自动重建，不能算「已就绪」。
        # 原来的判据是 st["ready"] —— 而 ready 只看「根路径对 + 有文件」，
        # 于是被 max_files 截断的索引、以及向量 0 行的索引全部被判为就绪，
        # 之后每次调用都返回 index_ready 直接跳过，没人会去重建它们。
        # 实测后果：本机 9000 个文件只有 3001 个在库里、code_vec 只有 3 行，
        # 而系统一直认为「索引是好的」——用户问「为什么搜不到」的根就在这里。
        if st.get("ready"):
            return {
                "ok": True,
                "skipped": True,
                "reason": "index_ready",
                "status": "ready",
                "root": root,
                "db_path": str(dbp),
                "files": st.get("files"),
            }
        stale = list(st.get("stale_reasons") or [])
        if stale and st.get("files"):
            # 库里有数据但被判残缺 → 无需人工介入，直接升级为强制重建。
            # 【self-evolution-bot · 2026-11-17 · 第31轮】注意「只缺向量」这种残缺
            # 不能在 build_index 里从头清表重来（会把 9044 个文件的 FTS/符号全删掉），
            # 那条分流在 build_index 内部按同一批 stale_reasons 判定，
            # 这样 subprocess / in-process 两条启动路径都能自动生效，不靠传参。
            force = True
            logger.warning(
                "code_index: 索引残缺（%s），自动触发重建（root=%s, 现有 %s 文件）",
                ", ".join(stale),
                root,
                st.get("files"),
            )
    key = _workspace_hash(root)
    with _jobs_lock:
        existing = _build_jobs.get(key)
        if existing is not None and existing.is_alive():
            return {
                "ok": True,
                "status": "building",
                "root": root,
                "db_path": str(dbp),
            }

        # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
        # 起子进程前先问一次**跨进程**租约，`_build_jobs` 只看得见自己这个进程。
        # 实测本机同时跑着两个 Gateway 进程，各自 `_build_jobs` 都是空的，
        # 于是各起一个 build_worker，两个 worker 互相 `DELETE FROM meta` 清表，
        # 索引永远建不完、检索永远 11~15s。必须在起进程前挡住第二个。
        _probe_holder = peek_build_lease(root)
        if _probe_holder is not None:
            logger.info(
                "code_index: 已有跨进程构建在跑（owner=%s pid=%s），不再起新进程 root=%s",
                _probe_holder.get("owner"),
                _probe_holder.get("pid"),
                root,
            )
            return {
                "ok": True,
                "status": "building",
                "reason": "build_in_progress",
                "busy_owner": _probe_holder.get("owner"),
                "root": root,
                "db_path": str(dbp),
            }

        if not _code_index_build_inprocess():
            try:
                job = _spawn_build_subprocess(
                    workspace_root=workspace_root,
                    thread_id=thread_id,
                    force=force,
                    job_key=key,
                )
                _build_jobs[key] = job
                return {
                    "ok": True,
                    "status": "scheduled",
                    "mode": "subprocess",
                    "root": root,
                    "db_path": str(dbp),
                }
            except Exception:
                logger.exception(
                    "code_index: subprocess schedule failed for %s; falling back to in-process thread",
                    root,
                )

        def _run() -> None:
            try:
                build_index(workspace_root=workspace_root, thread_id=thread_id, force=force)
            except Exception:
                logger.exception("background code_index build failed for %s", root)
            finally:
                with _jobs_lock:
                    _build_jobs.pop(key, None)

        t = threading.Thread(target=_run, name=f"code-index-build-{key[:8]}", daemon=True)
        _build_jobs[key] = _ThreadBuildJob(t)
        t.start()
    return {
        "ok": True,
        "status": "scheduled",
        "mode": "inprocess",
        "root": root,
        "db_path": str(dbp),
    }


def build_index(
    workspace_root: str | None = None,
    *,
    thread_id: str | None = None,
    force: bool = False,
) -> dict:
    """Index text files under a workspace (local path or LangGraph thread sandbox)."""
    cfg = get_code_index_config()
    if not cfg.enabled:
        return {"ok": False, "reason": "disabled"}
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    dbp = _db_path(root)
    if not force:
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
        if st.get("ready"):
            return {
                "ok": True,
                "skipped": True,
                "reason": "index_ready",
                "root": root,
                "db_path": str(dbp),
                "files": st.get("files"),
            }
        if dbp.exists():
            try:
                mtime = dbp.stat().st_mtime
                if st.get("ready") and time.time() - mtime < cfg.reindex_min_interval_seconds:
                    return {
                        "ok": True,
                        "skipped": True,
                        "reason": "recent_index",
                        "root": root,
                        "db_path": str(dbp),
                    }
            except OSError:
                pass

    from evoflow.code_index.lsp_pool import reset_build_budget

    # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    # 建库前先抢跨进程租约。抢不到 = 已经有别的进程（另一个 Gateway / 上一个
    # build_worker）在同一个 workspace 建库，直接返回「正在构建」，不要再烧一遍全仓。
    # 为什么必须在这里而不是 schedule_build_index：build_worker 是**独立进程**，
    # 它直接调 build_index()，根本不经过 schedule_build_index 的进程内 _build_jobs 判断。
    _lease_owner = f"{os.getpid()}:{uuid.uuid4().hex[:8]}"
    _lease_root = root
    _lease_token = None
    _lease_conn = _connect(root)
    try:
        _ensure_schema(_lease_conn)
        _got_lease, _holder = try_acquire_build_lease(
            _lease_conn, _workspace_hash(root), owner=_lease_owner
        )
    finally:
        _lease_conn.close()
    if not _got_lease:
        logger.warning(
            "code_index: 已有构建在跑（owner=%s pid=%s 心跳 %ss 前），本进程放弃重建 root=%s",
            (_holder or {}).get("owner"),
            (_holder or {}).get("pid"),
            int(time.time()) - int((_holder or {}).get("heartbeat_at") or 0),
            root,
        )
        return {
            "ok": True,
            "skipped": True,
            "reason": "build_in_progress",
            "busy_owner": (_holder or {}).get("owner"),
            "root": root,
            "db_path": str(dbp),
        }
    # 拿到租约 → 让本次构建的所有进度落盘都带上心跳。
    _lease_token = _build_lease_owner.set(_lease_owner)

    reset_build_budget(root)

    root_path = Path(root)
    source_files = _iter_source_files(root_path, cfg.max_files)
    total_files = len(source_files)

    # 【self-evolution-bot · 2026-11-17 · 第31轮】「只缺向量」时跳过清表与文件段。
    # 为什么：全量重建第一步 _clear_tables() 会把已建好的 FTS/符号/deps 全删掉，
    # 而向量段（本仓约 14.2 万块、本地 bge 约 16ms/块 ≈ 38 分钟）是最容易被重启或超时
    # 打断的一段。实测踩到：09:07 文件段 9044/9044 完成、进 embedding；
    # 09:29 重启打断 → 库里「文件全在、code_vec 只有 7 行」；
    # 而 ready=False 会驱动下一次调用再做一遍完整 9044 文件重建，
    # 等于每被打断一次就白烧一遍全仓解析。
    # 判据只看 stale_reasons 是否**全部**属于向量类，文件类残缺仍走全量重建。
    vectors_only = False
    try:
        _st = _read_index_status_unlocked(root, dbp, building=False) if dbp.exists() else {}
    except Exception:
        _st = {}
    _stale = list(_st.get("stale_reasons") or [])
    if _stale and _st.get("files") and all(
        s.startswith("vectors_missing") or s.startswith("vectors_incomplete") for s in _stale
    ):
        vectors_only = True
        logger.warning(
            "code_index: 仅向量段残缺（%s），跳过清表与文件段，只补向量（root=%s, %s 文件）",
            ", ".join(_stale),
            root,
            _st.get("files"),
        )

    _update_build_progress(
        root,
        phase="embedding" if vectors_only else "indexing",
        total_files=total_files,
        indexed_files=0,
        symbols=0,
    )
    parser_stats: dict[str, int] = defaultdict(int)
    dep_count = 0
    ref_count = 0
    type_rel_count = 0
    indexed = 0
    sym_count = 0
    skipped_files = 0

    try:

        if vectors_only:
            # 只补向量：保留既有 fts/symbols/deps，不清表也不跑文件段。
            indexed = int(_st.get("files") or 0)
            sym_count = int(_st.get("symbols") or 0)
            logger.info(
                "code_index: vectors-only 重建，沿用已建好的 %d 个文件索引（跳过解析）",
                indexed,
            )

        def _clear_tables() -> None:
            conn = _connect(root)
            try:
                _ensure_schema(conn)
                _mark_reindex_if_tokenizer_changed(conn)
                conn.execute("DELETE FROM fts_content")
                conn.execute("DELETE FROM symbols")
                conn.execute("DELETE FROM file_deps")
                conn.execute("DELETE FROM internal_refs")
                conn.execute("DELETE FROM type_relations")
                try:
                    conn.execute("DELETE FROM code_vec")
                except sqlite3.OperationalError:
                    pass  # vec0 may not exist
                # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
                # 原来这里是 `DELETE FROM meta` —— **整张 meta 表**清空，包含
                # `root` / `indexed_max_files` / `index_tokenizer_version` /
                # `fts_schema_version` / `build_lease`（本轮新加的那张进度外的表）。
                # 后果是活锁的另一半：清表后的 `index_status` 读到 `meta['root']` 为 None，
                # `ready` 必定 False、`stale_reasons` 必定含 `max_files_unrecorded_at_old_cap`，
                # 于是**每一个后续检索**都判定「索引残缺」→ `schedule_build_index(force=True)`
                # → 又清一次表。建库永远跑不完，检索永远慢。
                # 修法：只删「本次清表真正该失效」的产物键，保留身份/版本/租约。
                conn.execute(
                    "DELETE FROM meta WHERE key IN ("
                    "'indexed_at', 'index_db_path', 'symbol_parsers',"
                    "'build_progress.phase', 'build_progress.updated_at'"
                    ")"
                )
                # build_progress 的计数类键留着会被下一次 index_status 当成"已有进度"，
                # 但它们的值已随清表失效，必须一起清掉（前缀删）。
                conn.execute("DELETE FROM meta WHERE key LIKE 'build_progress.%'")
                conn.execute("DELETE FROM meta WHERE key = 'fts_needs_rebuild'")
                conn.commit()
            finally:
                conn.close()

        if not vectors_only:
            run_index_db(root, _clear_tables)

            for batch_start in range(0, len(source_files), _BUILD_BATCH_SIZE):
                batch = source_files[batch_start : batch_start + _BUILD_BATCH_SIZE]

                def _index_batch(files: list[Path] = batch) -> None:
                    nonlocal indexed, sym_count, dep_count, ref_count, type_rel_count, skipped_files
                    conn = _connect(root)
                    try:
                        _ensure_schema(conn)
                        for fp in files:
                            try:
                                rel = fp.relative_to(root_path).as_posix()
                                text = fp.read_text(encoding="utf-8", errors="replace")
                            except OSError:
                                continue
                            # 【self-evolution-bot · 2026-11-17 · 第31轮】单文件失败必须隔离。
                            # 为什么：原来只有 read 被 try 包住，extract_symbols 等环节抛任何异常
                            # 都会冒到 _run 的 except → **整个 build_index 中途退出**，留下半截库。
                            # 实证：2026-11-17 07:32:25 Gateway 日志
                            #   ERROR background code_index build failed / RecursionError
                            #   （tree_sitter_core._walk_symbols 递归 987 层爆栈）
                            # 结果库里 6454/9033 个文件、code_vec 只 14 行，且三轮重建死在同一处。
                            # 递归已改迭代（根因），这里再兜一层：坏文件只丢它自己，不毁整库。
                            try:
                                snippet = text[: cfg.max_chars_per_file]
                                sym_names: list[str] = []
                                for sym in extract_symbols(fp, text, workspace_root=root, for_full_build=True):
                                    sym_names.append(str(sym["name"]))
                                    conn.execute(
                                        "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                                        (rel, sym["name"], sym["kind"], sym["line"]),
                                    )
                                    sym_count += 1
                                    parser_stats[str(sym.get("parser") or "unknown")] += 1
                                # 【self-evolution-bot · 2026-11-18 · 第44轮 · 模型:deepseek-v4.1-flash-1017】
                                # 写前必须先删同 path 的行。fts_content 是 FTS5 虚拟表，**没有
                                # UNIQUE 约束**，`INSERT` 不报错也不会覆盖，只会再加一行。
                                # 全量建库时这一步被 `_clear_tables()` 的整表 DELETE 兜住了，
                                # 所以单进程跑永远看不出问题；但只要有第二个构建进程（第二个
                                # Gateway / 上一个 build_worker 还没退出）在**同一批 path** 上
                                # 交错写，就会出现「一个文件两行」。
                                # 实测（2026-11-18 07:24 本机）：4 个 build_worker 进程并存，
                                # 库内 fts 9040 行 / 7840 个不同 path → **1200 条重复**，
                                # 且重复行 content 完全一致（40/40 抽查），即纯重复不是新旧版本。
                                # 后果链：向量判据分母用行数（9040）、分子用 distinct path（7840），
                                # 分子天花板被重复行压在 7840 → 阈值 8859 永远达不到 →
                                # `ready=False` → **每一次检索都打印「索引残缺，自动触发重建」**
                                # 并真去重建一遍全仓。这就是「检索越用越慢」的真因。
                                # 这一行与 `_index_one_file`（单文件增量入口）口径对齐：那里
                                # 第 1622 行已经先 `DELETE FROM fts_content WHERE path = ?`。
                                conn.execute("DELETE FROM fts_content WHERE path = ?", (rel,))
                                conn.execute(
                                    "INSERT INTO fts_content(path, content) VALUES (?, ?)",
                                    (rel, _fts_document(rel, snippet, sym_names)),
                                )
                                dep_count += _index_file_deps(conn, root_path, rel, text, cfg)
                                ref_count += _index_internal_refs(conn, root_path, rel, text, cfg)
                                type_rel_count += _index_type_relations(conn, root_path, rel, text, cfg)
                                indexed += 1
                            except Exception:
                                skipped_files += 1
                                logger.warning(
                                    "code_index: 单文件索引失败已跳过 path=%s（不中断整库构建）",
                                    rel,
                                    exc_info=True,
                                )
                                continue
                        conn.commit()
                    finally:
                        conn.close()

                run_index_db(root, _index_batch)
                _update_build_progress(
                    root,
                    phase="indexing",
                    total_files=total_files,
                    indexed_files=indexed,
                    symbols=sym_count,
                )
                time.sleep(0)

        # --- Semantic embedding pass ---
        # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
        # 文件段一结束就先把 meta 落盘，**不要等向量段跑完**。
        # 为什么：`_touch_index_meta` 只在 `_finalize_meta`（向量段之后）被调用，
        # 而向量段是全量重建里最容易被打断的一段（本轮实测 114s 文件段正常，
        # 向量段跑了 9 分钟仍未完成，被我 590s 超时掐断）。
        # 中断后果实测（就在本机）：
        #   · meta 里既没有 `indexed_max_files` 也没有 `indexed_at`；
        #   · `stale_reasons` 立刻报 `max_files_unrecorded_at_old_cap` → `ready=False`；
        #   · 于是**每一次检索**都 `schedule_build_index(force=True)` 再烧一遍全仓，
        #     用户感觉「检索越来越慢」，而日志里全是「索引残缺，自动触发重建」。
        # 先落盘后：文件段完成即拥有合法 meta，中断只表现为「向量不全」，
        # 由 `vectors_only` 分支单独补向量，不再触发全量重建。
        def _commit_file_phase_meta() -> None:
            conn = _connect(root)
            try:
                _ensure_schema(conn)
                _touch_index_meta(conn, root, dbp)
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES ('symbol_parsers', ?)",
                    (json.dumps(dict(parser_stats)),),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
                    (_FTS_SCHEMA_VERSION,),
                )
                conn.execute("DELETE FROM meta WHERE key='fts_needs_rebuild'")
                conn.commit()
            except Exception:  # noqa: BLE001 - 落盘失败不能让整个构建失败
                logger.warning("code_index: 文件段 meta 落盘失败（不中断构建）", exc_info=True)
            finally:
                conn.close()

        if not vectors_only:
            run_index_db(root, _commit_file_phase_meta)

        # --- Semantic embedding pass ---
        # 【self-evolution-bot · 2026-11-16 · 第26轮】向量阶段单独上报进度。
        # 为什么：切块后这个阶段是全量重建里最耗时的一段（14.2 万块、约 38 分钟），
        # 而原来只上报 indexing 阶段，于是「文件都索引完了」后进度条停在 100%
        # 却还要再等半小时——用户会以为卡死了，只能干等，没有任何可见性。
        _update_build_progress(
            root,
            phase="embedding",
            total_files=total_files,
            indexed_files=indexed,
            symbols=sym_count,
            vectors_total=int(getattr(cfg, "max_files", 0) or 0) or None,
            vectors_done=0,
        )
        # 【self-evolution-bot · 2026-11-18 · 第44轮 · 模型:deepseek-v4.1-flash-1017】
        # `vectors_only` 的语义是「**只补缺的**向量」，原来却把全部文件重嵌一遍，
        # 已有向量的文件整段白算。实测（本机 2026-11-18）：7842 个可索引文件里
        # 2580 个已有向量、5262 个缺 → 33% 的算力纯粹浪费；而这段是建库里最慢的
        # 一段（本地 bge 实测约 96 块/秒，全仓 11.4 万块 ≈ 20 分钟），
        # 浪费的 33% 就是每被打断一次都多烧 6~7 分钟。
        # 判据：只有在 vectors_only 且读得到 code_vec 时，才把文件列表过滤成
        # 「库里没有该 path 任何向量」的那些；全量重建（vectors_only=False）不受影响，
        # 因为那时表刚被清空、全部文件都该重嵌。
        embed_files = source_files
        if vectors_only:
            try:
                _vc = _connect(root)
                try:
                    _have = {r[0] for r in _vc.execute("SELECT DISTINCT path FROM code_vec")}
                finally:
                    _vc.close()
            except sqlite3.Error:
                _have = set()
            if _have:
                embed_files = [
                    p
                    for p in source_files
                    if p.relative_to(root_path).as_posix() not in _have
                ]
                logger.info(
                    "code_index: vectors-only 只补缺向量的 %d 个文件（已有 %d 个跳过）",
                    len(embed_files),
                    len(source_files) - len(embed_files),
                )
        vec_count = _index_embeddings_sync(root, root_path, embed_files, cfg)
        _update_build_progress(
            root,
            phase="embedding_done",
            total_files=total_files,
            indexed_files=indexed,
            symbols=sym_count,
            vectors_done=int(vec_count or 0),
        )

        def _finalize_meta() -> None:
            conn = _connect(root)
            try:
                _ensure_schema(conn)
                _touch_index_meta(conn, root, dbp)
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES ('symbol_parsers', ?)",
                    (json.dumps(dict(parser_stats)),),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
                    (_FTS_SCHEMA_VERSION,),
                )
                conn.execute("DELETE FROM meta WHERE key='fts_needs_rebuild'")
                conn.commit()
            finally:
                conn.close()

        run_index_db(root, _finalize_meta)
    finally:
        _clear_build_progress(root)
        # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
        # 无论正常结束、抛异常还是被打断，都必须把租约还回去。
        # 否则下一个进程要等 300s TTL（或等自己发现 pid 已死）才能接管，
        # 那段时间用户看到的就是「索引残缺但没人修」。
        release_build_lease(_lease_root, owner=_lease_owner)
        if _lease_token is not None:
            _build_lease_owner.reset(_lease_token)

    logger.info(
        "code_index: indexed %d files (%d symbols, %d deps, %d refs, %d type_rels, %d vecs, %d skipped) under %s -> %s parsers=%s",
        indexed,
        sym_count,
        dep_count,
        ref_count,
        type_rel_count,
        vec_count,
        skipped_files,
        root,
        dbp,
        dict(parser_stats),
    )
    return {
        "ok": True,
        "files": indexed,
        "skipped_files": skipped_files,
        "symbols": sym_count,
        "dependencies": dep_count,
        "internal_refs": ref_count,
        "type_relations": type_rel_count,
        "vectors": vec_count,
        "root": root,
        "db_path": str(dbp),
        "symbol_parsers": dict(parser_stats),
    }


# English fluff models often append to code-search queries (stripped for symbol/FTS terms).
_SEARCH_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "and",
        "or",
        "for",
        "to",
        "in",
        "on",
        "of",
        "is",
        "are",
        "usage",
        "use",
        "using",
        "used",
        "channel",
        "how",
        "what",
        "where",
        "when",
        "help",
        "about",
        "find",
        "search",
        "explain",
        "show",
        "code",
        "file",
        "files",
        "function",
        "class",
        "method",
        "module",
        "implementation",
    }
)


def merge_search_queries(query: str = "", *, queries: list[str] | None = None) -> tuple[str, list[str]]:
    """Merge primary ``query`` and optional synonyms (supports ``a|b|c`` pipe syntax)."""
    from evoflow.tools.arg_coerce import normalize_search_query_inputs

    primary, rest = normalize_search_query_inputs(query, queries)
    if not primary and not rest:
        return "", []
    explicit = [primary, *rest][:12]
    label = " | ".join(explicit)
    return label, explicit


def _expand_search_terms(
    query: str,
    *,
    explicit_terms: list[str] | None = None,
    synonym_mode: bool = False,
) -> list[str]:
    """Split natural-language queries into symbol/FTS terms (CamelCase, snake_case, CJK)."""
    q = str(query or "").strip()
    terms: list[str] = []
    seen: set[str] = set()

    def add(raw: str, *, force: bool = False) -> None:
        t = raw.strip().strip("\"'")
        if not t or len(t) < 2:
            return
        key = t.casefold()
        if key in seen:
            return
        if not force and key in _SEARCH_STOPWORDS:
            return
        seen.add(key)
        terms.append(t)

    for tok in tokens_from_text(q, max_tokens=40):
        add(tok, force=synonym_mode or _looks_like_identifier_token(tok))

    for raw in explicit_terms or []:
        add(raw, force=True)
        for tok in tokens_from_text(raw, max_tokens=20):
            add(tok, force=True)

    for t in list(terms):
        for variant in _hyphen_variants(t):
            add(variant, force=True)

    if not terms and q:
        terms = [q]
    return terms[:20]


def _fts5_quote_term(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


def _build_fts_match_query(terms: list[str], *, original: str, combine_mode: str = "or") -> str:
    if not terms:
        return original
    if len(terms) == 1:
        return _fts5_quote_term(terms[0])
    joiner = " AND " if str(combine_mode or "").strip().lower() == "and" else " OR "
    return joiner.join(_fts5_quote_term(t) for t in terms)


def _nl_fts_terms(terms: list[str], *, primary: str = "") -> list[str]:
    """Drop generic NL noise; keep identifiers for AND-style content search."""
    primary_s = str(primary or "").strip()
    primary_cf = primary_s.casefold()
    kept: list[str] = []
    for t in terms:
        if primary_cf and t.casefold() == primary_cf:
            kept.append(t)
            continue
        if _looks_like_identifier_token(t):
            kept.append(t)
            continue
        if t.casefold() in _SEARCH_STOPWORDS:
            continue
        if len(t) >= 5:
            kept.append(t)
    if kept:
        return kept
    if primary_s:
        return [primary_s]
    return terms[:3]


def _looks_like_single_identifier(text: str) -> bool:
    """整句是否「就是一个标识符」—— 没有空格、无中文、含下划线或驼峰。

    【self-evolution-bot · 2026-11-17 · 第40轮】用来区分两类查询：
      · 形如 `some_missing_symbol_ab12` 的随机标识符 / `buildDiffSummary` → 用户问的是具体名字，
        查不到就是查不到，应当明说；
      · `resolve data paths` / `插件卸载` → 用户在描述功能，
        拆词命中是设计允许的，不能因为整句没字面出现就判死。
    """
    s = str(text or "").strip()
    if not s or " " in s or "\t" in s:
        return False
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", s):
        return False
    return "_" in s or bool(re.search(r"[a-z][A-Z]", s)) or len(s) >= 12


def _index_has_literal_hit(conn: sqlite3.Connection, whole: str) -> bool:
    """该字符串是否**字面**出现在索引里（文件名 / 符号名 / 正文任一处）。

    判定顺序按代价从低到高，命中即返回；三步全部未中才算「没有」：
      1. 符号名精确相等（`symbols.name`，B 树索引，最快）
      2. 路径包含（`fts_content.path`）
      3. 正文包含（FTS 短语查询）

    为什么不用语义向量：实测语义分数与真假无关（真查询 0.555 < 假查询 0.642），
    任何阈值都会误杀真实查询。字面命中在实测 5 真 / 5 假两组上完全可分。
    """
    w = str(whole or "").strip()
    if len(w) < 3:
        return True  # 太短无法判定，一律当作「可能有」，避免误杀
    try:
        row = conn.execute(
            "SELECT 1 FROM symbols WHERE name = ? LIMIT 1", (w,)
        ).fetchone()
        if row is not None:
            return True
    except sqlite3.Error:
        return True  # 查不了就别谎报「没有」
    # 大小写不敏感的符号名（FTS 之外的兜底）
    try:
        row = conn.execute(
            "SELECT 1 FROM symbols WHERE name = ? COLLATE NOCASE LIMIT 1", (w,)
        ).fetchone()
        if row is not None:
            return True
    except sqlite3.Error:
        pass
    try:
        row = conn.execute(
            "SELECT 1 FROM fts_content WHERE path LIKE ? LIMIT 1", (f"%{w}%",)
        ).fetchone()
        if row is not None:
            return True
    except sqlite3.Error:
        return True
    try:
        row = conn.execute(
            "SELECT 1 FROM fts_content WHERE fts_content MATCH ? LIMIT 1",
            (_fts5_quote_term(w),),
        ).fetchone()
        if row is not None:
            return True
    except sqlite3.Error:
        return True
    return False


def _search_symbols(
    conn: sqlite3.Connection,
    terms: list[str],
    lim: int,
    *,
    whole_query: str = "",
) -> list[dict]:
    """Symbol lookup: whole-query → exact → prefix → substring (substring only for terms ≥5 chars)."""
    symbols: list[dict] = []
    sym_keys: set[tuple[str, str, int]] = set()

    def _push(row: sqlite3.Row, *, match_rank: int) -> bool:
        key = (str(row["path"]), str(row["name"]), int(row["line"] or 0))
        if key in sym_keys:
            return len(symbols) >= lim
        sym_keys.add(key)
        symbols.append(
            {
                "path": key[0],
                "name": key[1],
                "kind": row["kind"],
                "line": key[2],
                "match_rank": match_rank,
            }
        )
        return len(symbols) >= lim

    # 【self-evolution-bot · 2026-11-17 · 第32轮】分隔符不敏感的整串符号匹配，必须走在最前。
    # 实测问题：查 "read persisted build progress"，库里明明有
    # `_read_persisted_build_progress`（去掉分隔符后与查询完全相同），
    # 但原实现只做「原样精确 / 前缀 / 子串」，一个都命不中；
    # 而 per-term 循环先轮到 'read' 这个泛名（库里有 20 个叫 read 的符号），
    # 名额被占满，整句根本没机会匹配。
    # 实测（冻结池 60 条拆词查询、K=10、关语义召回）：
    #   HEAD 原版 hit@1=4/60，只加本处整串匹配 29/60，再叠加输出层分档 44/60。
    # 关键顺序：按去分隔符长度降序试，长串（整句）优先，短泛词最后。
    # 只认**整串**：把整个查询的每个词拼起来再比对。
    # 若允许每个词单独参与（我第一版就是这么写的），progress / build / persisted
    # 这些泛词也会拿 match_rank=4，等于把「叫 Progress 的组件」提成最高档，
    # 反而压掉真正的 _read_persisted_build_progress —— 实测就是这么错的。
    # 只在「查询里存在一个够长的整体词项」时才启用：_expand_search_terms 会把
    # 整句原样保留为一个 term（见实测 terms 末尾的 'read persisted build progress'），
    # 拿它去做去分隔符比对；短泛词不参与。
    # 【self-evolution-bot · 2026-11-17 · 第34轮】整句比对必须排在所有拆词之前。
    # 实测（冻结池 60 条、K=10、关语义）：16 条 miss@1 里 14 条是同一个机制——
    # 查询被拆成单词后，短泛词（resolve / build / preview / status）先拿到 match_rank=4
    # 把名额占满，而「整句拼起来」这个候选**从没参与过比对**：
    #   resolve data paths → 库里真有 resolve_data_paths，答的是 resolve()
    #   build diff summary → 库里真有 buildDiffSummary，答的是 build()
    #   plugins uninstall  → 库里真有 plugins_uninstall，答的是 uninstall()
    # 判据：整句每个词拼起来去分隔符，与符号名去分隔符后**全等**才算整句命中。
    # 给 match_rank=5 而不是 4：整串全等必然强于「某个单词恰巧等于符号名」，必须压过它。
    _whole_norm = _strip_seps(whole_query) if whole_query else ""
    if len(_whole_norm) >= 6:
        # 【self-evolution-bot · 2026-11-17 · 第36轮】整句匹配必须容忍单复数差异。
        # 实测（工具出口评测，60 条查询）：`plugin uninstall` 查不到
        # `plugins_uninstall` —— 去分隔符后是 'pluginuninstall' vs 'pluginsuninstall'，
        # 差一个 s 就不全等，于是整句档（rank=5）完全没参与比对，答案排到 10 名外，
        # 首条给的是短泛名 `uninstall`。而 `resolve data paths` / `build diff summary`
        # 能进是因为它们恰好逐字相同 —— 这不是能力差异，只是一个字符的运气。
        # 做法：把「词尾单复数」在归一化阶段抹平（plugin↔plugins、index↔indexes）。
        # 只做尾部，不做词干提取：词干会把 progress/progresses 之外的东西也吃掉，
        # 引入不可控的误匹配。
        # 【self-evolution-bot · 2026-11-17 · 第36轮】SQL 只做粗筛：候选名必须
        # 含查询词元；精确判定交给 _whole_name_matches（逐词元比对 + 单复数归一）。
        # 粗筛用「子串」而不是「前缀」：前缀会漏掉带前导下划线的 `_build_overlay`，
        # 也会漏掉大写缩写连写的 `ZCodeBackgroundTaskControlItem`（实测这两类共退化 4 条）。
        #
        # 【self-evolution-bot · 2026-11-18 · 第46轮 · 模型:deepseek-v4.1-flash-1017】
        # 粗筛判据从「单锚点 LIKE」改为「每个词元都必须是去分隔符后名字的子串，AND 起来」。
        # 理由是实测（冻结池 59 可评、改前 hit@1 55/59）4 条 miss@1 里 2 条同一根因：
        #   ① 锚点归一化、SQL 却比对**原始** name —— `end session turn` 的锚点是
        #      `endsessi`（已去分隔符），而 `end_session_turn` 原始名里有下划线，
        #      `name LIKE '%endsessi%'` **命中 0 条**，目标永远进不了候选集；
        #   ② 锚点只取首词元 → 泛词烧光 LIMIT —— `build Diff Summary` / `build overlay` /
        #      `load Role Schedule Preview` 的首词元是 build/load，分别命中
        #      1212 / 1212 / 1168 个符号，`LIMIT 400` 直接截断，目标实测 pos=-1
        #      （压根不在前 400），整句档形同虚设，答案靠后面的短泛词档捞。
        # 同一库同一 8 条查询实测对比：AND 粗筛候选数 1~8 条，8/8 目标落在候选前 5 位
        # （改前 3/8 根本不在候选里），单次 13.6~15.7ms —— 相比整体 p50 ~600ms 可忽略。
        _q_tokens = [t for t in _name_tokens(whole_query) if len(t) >= 2]
        _norm_col = "replace(replace(lower(name),'_',''),'-','')"
        _cand_rows: list = []
        if _q_tokens:
            # 单复数归一后再当子串：`plugins uninstall` 用 'plugin' 也命中
            # `plugins_uninstall`，反之亦然。只做词尾单数化，不做词干提取。
            _pats = ["%" + _strip_seps(_sing_tok(t)) + "%" for t in _q_tokens]
            _cand_sql = (
                "SELECT path, name, kind, line FROM symbols"
                " WHERE " + " AND ".join([_norm_col + " LIKE ?"] * len(_pats)) +
                " ORDER BY CASE WHEN kind IN"
                " ('function','class','method','constructor','interface','type','struct')"
                " THEN 0 ELSE 1 END"
                " LIMIT ?"
            )
            _cand_rows = conn.execute(_cand_sql, (*_pats, lim * 40)).fetchall()
        elif _whole_norm[:8]:
            # 兜底：查询里没有任何 ≥2 字符的词元（极短/纯符号查询）时退回整串子串。
            _cand_rows = conn.execute(
                "SELECT path, name, kind, line FROM symbols"
                " WHERE name LIKE ?"
                " ORDER BY CASE WHEN kind IN"
                " ('function','class','method','constructor','interface','type','struct')"
                " THEN 0 ELSE 1 END"
                " LIMIT ?",
                ("%" + _whole_norm[:8] + "%", lim * 40),
            ).fetchall()
        # 【self-evolution-bot · 2026-11-17 · 第36轮】同一档（rank=5）内还要再排一次：
        # 去分隔符**全等**的必须排在「靠单复数容错才相等」的前面。
        # 实测教训：查 `build overlay` 时 `_buildOverlays`（复数容错命中）排在
        # `_build_overlay`（逐字全等）前面，用户看到的首条是错的那个 ——
        # 复数容错本是为了补召回，不该抢走逐字命中的首位。
        _exact: list = []
        _fuzzy: list = []
        for row in _cand_rows:
            name = str(row["name"] or "")
            if _strip_seps(whole_query) == _strip_seps(name):
                _exact.append(row)
            elif _whole_name_matches(whole_query, name):
                _fuzzy.append(row)
        for row in _exact + _fuzzy:
            if _push(row, match_rank=5):
                break

    _long_terms = [t for t in terms if len(_strip_seps(t)) >= 6]
    _norm_terms = sorted({_strip_seps(t) for t in _long_terms}, key=len, reverse=True)[:2]
    for _nt in _norm_terms:
        if len(symbols) >= lim:
            break
        for row in conn.execute(
            "SELECT path, name, kind, line FROM symbols"
            " WHERE replace(replace(lower(name),'_',''),'-','') = ?"
            " LIMIT ?",
            (_nt, lim),
        ).fetchall():
            if _push(row, match_rank=4):
                break

    for term in terms:
        if len(symbols) >= lim:
            break
        t = str(term or "").strip()
        if len(t) < 2:
            continue
        for row in conn.execute(
            "SELECT path, name, kind, line FROM symbols WHERE name = ? COLLATE NOCASE LIMIT ?",
            (t, lim),
        ).fetchall():
            if _push(row, match_rank=3):
                break
        if len(symbols) >= lim:
            break
        esc = t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        for row in conn.execute(
            "SELECT path, name, kind, line FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT ?",
            (esc + "%", lim),
        ).fetchall():
            if _push(row, match_rank=2):
                break
        if len(symbols) >= lim:
            break
        if len(t) < 5:
            continue
        like = f"%{esc}%"
        for row in conn.execute(
            "SELECT path, name, kind, line FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT ?",
            (like, lim),
        ).fetchall():
            if _push(row, match_rank=1):
                break
    return symbols[:lim]


def _fts_needs_rebuild(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT value FROM meta WHERE key='fts_needs_rebuild'").fetchone()
    return bool(row and str(row[0]).strip() in {"1", "true", "yes"})


def _wait_index_ready(
    workspace_root: str | None,
    *,
    thread_id: str | None,
    cfg: CodeIndexConfig,
    initial: dict | None = None,
) -> dict:
    """Poll until index is ready or timeout (only while a build job is active).

    【self-evolution-bot · 2026-11-17 · 第34轮】新增 *initial*：调用方可以把它刚算出来的
    状态传进来。为什么：稳态下 search_index 已经算过一次 index_status（实测 103ms/次，
    其中 80ms 是 fts_content 全表 COUNT），这里又原样再算一遍只为判「是否在构建」，
    等于每次检索白花约 100ms、占稳态 580ms 的 17%。传入初始状态后稳态只算一次。
    """
    wait_s = float(cfg.search_wait_seconds or 0)
    if wait_s <= 0:
        return initial if initial is not None else index_status(workspace_root=workspace_root, thread_id=thread_id)
    deadline = time.time() + wait_s
    st = initial if initial is not None else index_status(workspace_root=workspace_root, thread_id=thread_id)
    # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    # 等待条件原来是 `not ready and building` —— 而 `ready` 要求**完全没有** stale_reasons，
    # 其中 `vectors_incomplete` 要等整个向量段跑完（本仓 11.4 万块、约 30 分钟）。
    # 后果：只要向量还在补，每一次检索都无条件空等满 `search_wait_seconds`（默认 2.0s）。
    # 实测 8×250ms = 2000ms 全部白等，而库里明明有 7839 文件 / 51744 符号可搜。
    # 「等」的正当理由只有一个：库里还没东西可搜。有内容就立刻搜，别等全量建完。
    while (
        not st.get("ready")
        and st.get("building")
        and int(st.get("files") or 0) == 0
        and time.time() < deadline
    ):
        time.sleep(0.25)
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
    return st


def search_index(
    workspace_root: str | None = None,
    query: str = "",
    *,
    queries: list[str] | None = None,
    thread_id: str | None = None,
    limit: int | None = None,
) -> dict:
    cfg = get_code_index_config()
    lim = limit or cfg.search_limit
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    with _search_conn_scope(root) as conn:
        _ensure_schema(conn)
        _mark_reindex_if_tokenizer_changed(conn)
        needs_rebuild = _fts_needs_rebuild(conn)

    rebuild_in_progress = False
    if cfg.auto_index_on_search:
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
        rebuild_in_progress = bool(st.get("building"))
        if needs_rebuild or (not st.get("ready") and not st.get("building")):
            sched = schedule_build_index(
                workspace_root=workspace_root,
                thread_id=thread_id,
                force=bool(needs_rebuild),
                status=st,
            )
            # 【self-evolution-bot · 2026-11-18 · 第44轮 · 模型:deepseek-v4.1-flash-1017】
            # 原来这里重算一次 index_status 只为了拿新的 `building` —— 实测 418ms/次
            # （COUNT(DISTINCT path) FROM code_vec），换来的信息量却只有 1 个 bool：
            # `ready`/`stale_reasons`/`files` 在「刚把任务排进去」这个瞬间不可能变
            # （真要变也只能是构建真跑完了，那需要分钟级）。直接由调度结果推 building，
            # 语义等价且省掉一整次全表 COUNT。
            st = dict(st)
            st["building"] = bool(
                str(sched.get("status") or "") in ("scheduled", "building")
            )
            rebuild_in_progress = st["building"]
        # 【self-evolution-bot · 2026-11-17 · 第34轮】只有「正在构建」才需要等；
        # 稳态（已 ready 且无构建任务）直接把上面这份状态复用下去，
        # 不再为同一个判定重复算一次 index_status（每次约 100ms）。
        if st.get("building"):
            st = _wait_index_ready(workspace_root, thread_id=thread_id, cfg=cfg, initial=st)
            rebuild_in_progress = bool(st.get("building"))
        elif not rebuild_in_progress:
            # 【self-evolution-bot · 2026-11-18 · 第46轮 · 模型:qwen3.8-flash】
            # 稳态（ready 且不在构建）正是「可见但永不修」的那一支：上面调度只会在
            # `not ready` 时触发，而 ready 判定不看源码内容 → 第38轮报出来的
            # stale 每轮只会变大。这一支接上 `_schedule_drift_catchup`，
            # 让「刚写的文件下一次检索就能搜到」不需要人记得重启/手点重建。
            _schedule_drift_catchup(root, st=st)
        if st.get("building") and not st.get("ready") and int(st.get("files") or 0) == 0:
            return {
                "hits": [],
                "symbols": [],
                "related_files": [],
                "imported_by": [],
                "imports": [],
                "internal_ref_users": [],
                "type_supertypes": [],
                "type_subtypes": [],
                "query": query,
                "search_terms": [],
                "root": root,
                "db_path": str(_db_path(root)),
                "building": True,
                "ready": False,
            }

    conn_scope = _search_conn_scope(root)
    conn = conn_scope.__enter__()
    _ensure_schema(conn)
    from evoflow.tools.arg_coerce import normalize_search_query_inputs, parse_search_path_prefix

    path_prefix, query_body = parse_search_path_prefix(query)
    primary, extra = normalize_search_query_inputs(query_body, queries=queries)
    label, explicit = merge_search_queries(primary, queries=extra)
    if path_prefix and query_body != str(query or "").strip():
        scope = _normalize_path_prefix(path_prefix) or path_prefix
        label = f"path:{scope}" + (f" {label}" if label else "")
    if not label and path_prefix:
        label = f"path:{_normalize_path_prefix(path_prefix) or path_prefix}"
    if not label:
        conn_scope.__exit__()
        return {"hits": [], "symbols": [], "root": root, "db_path": str(_db_path(root))}

    q = label
    joined = " ".join(explicit)
    synonym_mode = len(explicit) > 1
    terms = _expand_search_terms(joined, explicit_terms=explicit, synonym_mode=synonym_mode)
    fts_mode = "or"
    if synonym_mode:
        fts_q = _build_fts_match_query(terms, original=joined, combine_mode="or")
    else:
        nl_terms = _nl_fts_terms(terms, primary=primary)
        nl_query = bool(re.search(r"\s", str(query_body or "").strip()))
        fts_mode = "and" if nl_query and len(nl_terms) >= 2 else "or"
        fts_q = _build_fts_match_query(nl_terms or terms, original=joined, combine_mode=fts_mode)
    fetch_lim = max(lim, lim * 8) if path_prefix else max(lim, lim * 2)

    hits: list[dict] = []
    hit_paths: set[str] = set()
    # 【self-evolution-bot · 2026-11-17 · 第32轮】必须 ORDER BY rank，否则候选池按 rowid
    # （入库先后）返回，等于随机抽样：先入库的 README / CONTRIBUTING / RELEASE 永远占前排。
    # 实证（同一份库，query="_read_persisted_build_progress"）：
    #   无 rank  → README.md / CONTRIBUTING.md / RELEASE.md  ← 全是仓库根早期文件
    #   有 rank  → 命中该符号的真实文件进前列
    # 代价实测 0~5ms（8849 文件库），可忽略。
    try:
        rows = conn.execute(
            "SELECT path, snippet(fts_content, 1, '<b>', '</b>', '…', 8) AS snip"
            " FROM fts_content WHERE fts_content MATCH ? ORDER BY rank LIMIT ?",
            (fts_q, fetch_lim),
        ).fetchall()
        for r in rows:
            p = str(r["path"])
            if p in hit_paths:
                continue
            hit_paths.add(p)
            hits.append({"path": p, "snippet": r["snip"], "kind": "content"})
    except sqlite3.OperationalError as e:
        logger.debug("FTS query failed (%r): %s", fts_q, e)
        for term in terms:
            if len(hits) >= fetch_lim:
                break
            try:
                rows = conn.execute(
                    "SELECT path, snippet(fts_content, 1, '<b>', '</b>', '…', 8) AS snip FROM fts_content WHERE fts_content MATCH ? LIMIT ?",
                    (_fts5_quote_term(term), max(1, fetch_lim - len(hits))),
                ).fetchall()
                for r in rows:
                    p = str(r["path"])
                    if p in hit_paths:
                        continue
                    hit_paths.add(p)
                    hits.append({"path": p, "snippet": r["snip"], "kind": "content"})
            except sqlite3.OperationalError:
                continue

    raw_hits = list(hits)

    # --- Semantic vector recall (hybrid merge) ---
    semantic_hits: list[dict] = []
    # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    # 语义召回失败的**原因**必须随结果出到工具出口，不能只在日志里。
    _reset_degraded()
    if cfg.semantic_search_enabled:
        semantic_hits = _semantic_recall_sync(
            conn,
            str(query_body or joined or label),
            cfg.semantic_top_k,
            cfg,
        )
        # Filter + merge semantic hits not already in FTS results
        for sh in semantic_hits:
            p = str(sh.get("path") or "")
            if not p or _path_has_skipped_segment(p):
                continue
            if path_prefix and not _path_under_prefix(p, path_prefix):
                continue
            if p not in hit_paths:
                hit_paths.add(p)
                raw_hits.append(sh)

    # 【self-evolution-bot · 2026-11-17 · 第34轮】把「整句」传进符号检索。
    # 不传的话新加的 match_rank=5 整句分支永远进不去（走不到），
    # 也就是经典的「改了函数、没接调用点」。
    # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
    # 「没查到就该说没查到」——本轮大池评测实测：5 条随机不存在标识符，
    # 5 条全都**没说没有**，其中 4 条照常吐出 10 条符号（如查一个纯随机串，
    # 首条返回的符号是 `note`），1 条吐出 10 条内容命中。
    # 调用方拿到这种输出会以为「有这个符号，只是名字不太一样」，比空结果更误导。
    # 判据必须用**字面命中**，不能用语义分数：实测真查询 `prune empty dirs`
    # 语义 top1=0.555，而纯随机串是 0.642 —— 分数反向，
    # 任何阈值都会把真查询判死。字面命中则能干净分离（实测：真标识符
    # resolve_data_paths 整串命中 5 个文件，5 条假标识符全部 0）。
    # 只在「查询本身看起来就是一个标识符」时判定，避免把自然语言查询误判成没查到。
    literal_missing = False
    whole = str(query_body or label or "").strip()
    if whole and _looks_like_single_identifier(whole):
        try:
            literal_missing = not _index_has_literal_hit(conn, whole)
        except sqlite3.Error:
            literal_missing = False

    raw_symbols = _search_symbols(
        conn, terms, fetch_lim, whole_query=str(query_body or label or "")
    )

    # [self-evolution-bot 2026-11-17 第32轮] 「把 rerank 前的 limit 截断延后」这个改动
    # 已撤销：回退后测试全绿、同池评测零差别 → 拿不出「改动前后有差别」的证据，
    # 就不留没被证实的代码。这里维持原样（在 rerank 之前按 lim 截断）。
    hits = _filter_index_rows(raw_hits, path_prefix=path_prefix, limit=lim)
    symbols = _filter_index_rows(raw_symbols, path_prefix=path_prefix, limit=lim)
    hits, symbols = _rerank_index_rows(
        hits,
        symbols,
        terms=terms,
        path_prefix=path_prefix,
        query_body=str(query_body or joined or label),
    )
    hits, symbols = _boost_filename_path_matches(
        hits,
        symbols,
        query=label,
        query_body=str(query_body or joined),
    )
    path_scope_relaxed = False
    path_scope_empty_hint = ""

    if path_prefix and not hits and not symbols and (raw_hits or raw_symbols):
        path_scope_empty_hint = f"No matches under path:{_normalize_path_prefix(path_prefix)} ({len(raw_hits)} content / {len(raw_symbols)} symbol hits elsewhere). Drop path: prefix or use a broader subdirectory."

    related: list[dict] = []
    imported_by: list[dict] = []
    imports: list[dict] = []
    seeds = list({h["path"] for h in hits} | {s["path"] for s in symbols})

    if cfg.dependency_graph_enabled and cfg.dependency_search_hops > 0 and seeds:
        extra = dependency_neighbors(
            conn,
            seeds,
            hops=cfg.dependency_search_hops,
            limit=lim,
        )
        for p in extra:
            if _path_has_skipped_segment(str(p)):
                continue
            if path_prefix and not _path_under_prefix(str(p), path_prefix):
                continue
            related.append({"path": p, "kind": "dependency_neighbor"})

    if cfg.dependency_graph_enabled and seeds:
        imported_by = list_importers(conn, seeds, limit=lim)
        imports = list_outgoing_imports(conn, seeds, limit=lim)
        if path_prefix:
            imported_by = [r for r in imported_by if _path_under_prefix(str(r.get("from_path") or ""), path_prefix) or _path_under_prefix(str(r.get("to_path") or ""), path_prefix)]
            imports = [r for r in imports if _path_under_prefix(str(r.get("from_path") or ""), path_prefix) or _path_under_prefix(str(r.get("to_path") or ""), path_prefix)]

    ref_users: list[dict] = []
    if cfg.internal_refs_enabled and seeds:
        placeholders = ",".join("?" for _ in seeds)
        rows = conn.execute(
            f"""
            SELECT DISTINCT from_path, to_path, symbol, line FROM internal_refs
            WHERE to_path IN ({placeholders})
            LIMIT ?
            """,
            (*seeds, lim),
        ).fetchall()
        for r in rows:
            ref_users.append(
                {
                    "from_path": str(r[0]),
                    "to_path": str(r[1]),
                    "symbol": str(r[2] or ""),
                    "line": int(r[3] or 0),
                    "kind": "internal_ref",
                }
            )
        if path_prefix:
            ref_users = [r for r in ref_users if _path_under_prefix(str(r.get("from_path") or ""), path_prefix)]

    type_supertypes: list[dict] = []
    type_subtypes: list[dict] = []
    type_names: list[str] = list({str(s["name"]) for s in symbols if s.get("name")})
    for term in terms:
        if re.fullmatch(r"[A-Za-z_]\w*", term):
            type_names.append(term)
    type_names = list(dict.fromkeys(type_names))

    if cfg.type_relations_enabled and (seeds or type_names):
        from evoflow.code_index.type_relations import list_type_relations_for_search

        type_supertypes, type_subtypes = list_type_relations_for_search(
            conn,
            seed_paths=seeds,
            type_names=type_names,
            limit=lim,
        )

    conn_scope.__exit__()
    return {
        "hits": hits,
        "symbols": symbols,
        "related_files": related,
        "imported_by": imported_by,
        "imports": imports,
        "internal_ref_users": ref_users,
        "type_supertypes": type_supertypes,
        "type_subtypes": type_subtypes,
        "semantic_hits": semantic_hits,
        "query": q,
        "search_terms": terms,
        "path_prefix": _normalize_path_prefix(path_prefix),
        "path_scope_relaxed": path_scope_relaxed,
        "path_scope_empty_hint": path_scope_empty_hint,
        "fts_combine_mode": "or" if synonym_mode else fts_mode,
        "semantic_enabled": cfg.semantic_search_enabled,
        # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
        # 非空 = 本次检索**只有词法**（语义召回被跳过/失败），值是稳定原因码；
        # 空 = 语义正常参与。输出层据此打一行提示，调用方不必去翻日志。
        **_collect_degraded(),
        "root": root,
        "db_path": str(_db_path(root)),
        "rebuild_in_progress": rebuild_in_progress,
        # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
        # 「整句标识符在库里字面不存在」→ 输出层据此明说没有，而不是拿拆词凑数。
        "literal_query_missing": literal_missing,
        # 【self-evolution-bot · 2026-11-17 · 第33轮】索引新鲜度随结果返回（见 index_freshness）
        **index_freshness(root),
    }
