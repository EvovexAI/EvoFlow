"""Track files the Read tool has shown the model (ZCode readFileState).

Consumers:
- ``stale_read_hint`` — paths whose mtime moved since Read (edit-before-read guard).
- ``unchanged_since_last_read`` — ZCode-style ``file_unchanged`` short-circuit:
  a re-read of an unchanged full-text file returns a one-line marker instead of
  resending the content (token saving). Partial views (offset/limit/symbol)
  never qualify, matching ZCode's ``isPartialView`` rule.
- ``edit_guard_failure`` — ZCode Edit guard (EDIT_NOT_READ / EDIT_STALE):
  str_replace/write must have a full Read on record, and the file must not
  have changed on disk since that Read; ``note_write`` refreshes the state
  after a successful edit so consecutive edits need no re-Read.
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from pathlib import Path

_LOCK = threading.Lock()
_MAX_HINT_PATHS = 5

# 【self-evolution-bot · 2026-11-19 · 第61轮 · 模型:deepseek-v4.1-flash-1017】
# STALE 放行条件里 old_string 的最小长度。太短的串（`}`、`return`、`print(`）
# 「唯一命中」不携带定位信息，据它放行等于把守卫判宽，所以必须设下限。
_STALE_ALLOW_MIN_OLD = 12

# zcode edit.ts EDIT_NOT_READ_MESSAGE / EDIT_STALE_MESSAGE (verbatim alignment).
EDIT_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it."
EDIT_STALE_MESSAGE = (
    "File has been modified since read, either by the user or by a linter. "
    "Read it again before attempting to write it."
)


@dataclass(frozen=True)
class _ReadEntry:
    mtime: float
    size: int
    full_read: bool
    content_hash: str | None = None


# resolved path -> last model-visible read
_SEEN: dict[str, _ReadEntry] = {}

# 【self-evolution-bot · 2026-11-19 · 第83轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增「按线程」的已读登记 ``_SEEN_BY_THREAD[(thread_id, resolved_path)]``，
# 专门回答「**这个会话**有没有看到过这份内容」，供 ``unchanged_since_last_read``
# 的短路径（Wasted call）判据使用。
# 为什么：``_SEEN`` 是进程级全局字典，键只有路径。于是 A 岗位读过的文件，
# B 岗位/别的线程再读时被判成「你刚读过、别浪费」，直接返回一句
# "Wasted call — refer to that earlier tool_result instead"——**而那条 tool_result
# 根本不在 B 的上下文里**，B 只能换个写法重试或直接卡死。
# 现网实证（obs，agent 全岗，2026-11-12~19，70 次 Wasted call）：
#   同线程有登记 28（其中一部分是压缩后内容已被移出上下文）
#   同岗别的线程 10、别的岗位 31 —— **41/70 = 58.6% 是跨线程误判**
#   （如 release-engineer 读 fullstack-dev 刚读过的文档被拦、atmosphere-vote-bot 读
#    atmosphere-director 的 craft 被拦）
# 修复后两种「本线程没看见」都不会再被拦：跨线程靠线程键分开，压缩靠
# ``forget_thread_reads`` 在 fold 真正丢掉工具结果时清账。
# 边界：``_SEEN`` 保持全局不动——``edit_guard_failure`` / ``stale_read_hint``
# 语义是「磁盘上这份内容有没有人读过 + 有没有被改」，与本缺口无关，改它会扩大影响面。
_SEEN_BY_THREAD: dict[tuple[str, str], _ReadEntry] = {}


def reset_read_state() -> None:
    """清空已读状态（测试隔离 / 诊断用；进程内全局注册表）。"""
    with _LOCK:
        _SEEN.clear()
        _SEEN_BY_THREAD.clear()


def forget_thread_reads(thread_id: str | None) -> int:
    """Drop this thread's read receipts (e.g. after compaction removed their tool results).

    Returns the number of entries dropped.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    with _LOCK:
        stale = [k for k in _SEEN_BY_THREAD if k[0] == tid]
        for k in stale:
            _SEEN_BY_THREAD.pop(k, None)
    return len(stale)


def _content_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8", errors="replace")).hexdigest()


def file_content_hash(path: str | Path) -> str | None:
    """磁盘原文的哈希 —— **登记侧与校验侧必须都用这一个**。

    【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本函数，作为「读到的内容」的唯一哈希口径。
    为什么：``edit_guard_failure`` 判 STALE 时是拿 ``Path.read_text()``（磁盘原文）
    算哈希，而 ``read_file.py`` 登记时拿的是**渲染后**文本算哈希。两者在 CRLF 文件上
    必然不同（渲染把 ``\\r\\n`` 变成 ``\\n``），于是「内容一个字都没变、只是 mtime 被
    linter 摸了一下」也会判成 stale。
    现网 obs 实证：self-evolution-bot 近 7 天 ``replace`` 的 8 次
    ``File has been modified since read`` 里，**7 个受害文件是 CRLF**
    （ps1-gate.ps1 / tree_sitter_core.py / assets_tool.py / catalog.py / …），
    每次都要重读一遍再改，纯白烧一轮。
    实测（同内容 + 仅 touch mtime）：修复前必报 STALE，修复后返回 None。
    """
    try:
        return _content_hash(Path(path).read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return None


def note_read(
    path: str,
    *,
    full_read: bool = True,
    content_hash: str | None = None,
    thread_id: str | None = None,
) -> None:
    """Record a model-visible read.

    【self-evolution-bot · 2026-11-19 · 第83轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：加 ``thread_id`` 入参，同时写进程级 ``_SEEN`` 与线程级
    ``_SEEN_BY_THREAD``。为什么见 ``_SEEN_BY_THREAD`` 上方注释。
    """
    raw = str(path or "").strip()
    if not raw:
        return
    file_path = Path(raw)
    try:
        resolved = str(file_path.resolve())
        stat = file_path.stat()
    except OSError:
        return
    with _LOCK:
        entry = _ReadEntry(
            mtime=stat.st_mtime,
            size=stat.st_size,
            full_read=full_read,
            content_hash=content_hash,
        )
        _SEEN[resolved] = entry
        if thread_id:
            _SEEN_BY_THREAD[(str(thread_id).strip(), resolved)] = entry


def runtime_thread_id(runtime: object) -> str:
    """Best-effort ``thread_id`` from a ToolRuntime (dict-like ``.context``)."""
    ctx = getattr(runtime, "context", None)
    if ctx is not None and hasattr(ctx, "get"):
        return str(ctx.get("thread_id") or "").strip()
    return ""


def note_write(path: str, *, content: str | None = None, thread_id: str | None = None) -> None:
    """Refresh state after a successful edit/write (zcode recordEditedReadState).

    Records the new mtime as a full view so consecutive edits need no re-Read.
    """
    raw = str(path or "").strip()
    if not raw:
        return
    file_path = Path(raw)
    try:
        resolved = str(file_path.resolve())
        stat = file_path.stat()
    except OSError:
        return
    with _LOCK:
        entry = _ReadEntry(
            mtime=stat.st_mtime,
            size=stat.st_size,
            full_read=True,
            content_hash=_content_hash(content) if content is not None else None,
        )
        _SEEN[resolved] = entry
        if thread_id:
            _SEEN_BY_THREAD[(str(thread_id).strip(), resolved)] = entry


def _stat_same(entry: _ReadEntry, stat: object) -> bool:
    return abs(stat.st_mtime - entry.mtime) <= 1e-6 and stat.st_size == entry.size


def unchanged_since_last_read(path: str | Path, *, thread_id: str | None = None) -> bool:
    """True when *this session* already showed this file and mtime + size are unchanged.

    【self-evolution-bot · 2026-11-19 · 第83轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：判据从进程级 ``_SEEN`` 换成线程级 ``_SEEN_BY_THREAD``（传了 thread_id 时）。
    为什么：短路径的语义是「**你**刚看到过，别重复要」。进程级账本会把别的会话看到的
    内容算到本会话头上，返回一句指向**不存在的** tool_result 的提示，调用方只能重试。
    现网 70 次里 41 次（58.6%）是这种跨线程误判。
    边界：拿不到 thread_id（裸调 / 老调用点）时回退旧的全局判据，保持行为不变。
    """
    try:
        resolved = str(Path(path).resolve())
        stat = Path(path).stat()
    except OSError:
        return False
    tid = str(thread_id or "").strip()
    with _LOCK:
        if tid:
            entry = _SEEN_BY_THREAD.get((tid, resolved))
        else:
            entry = _SEEN.get(resolved)
    if entry is None or not entry.full_read:
        return False
    return _stat_same(entry, stat)


def edit_guard_failure(
    path: str | Path,
    *,
    old_string: str | None = None,
    regex: bool = False,
) -> str | None:
    """ZCode ``getEditableReadStateFailure`` alignment for str_replace/write.

    Returns an error message when the edit must be refused, or ``None`` when
    it may proceed:

    - no full Read on record → EDIT_NOT_READ (partial views never qualify);
    - mtime/size moved since that Read → EDIT_STALE, except when the content
      hash still matches (mtime-only touches don't force a re-Read);
    - content really changed, but the literal *old_string* still occurs
      **exactly once** in the current bytes → proceed.

    【self-evolution-bot · 2026-11-19 · 第61轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增最后一条放行条件（literal `old_string` 在当前磁盘内容里唯一命中）。
    为什么：守住的语义是「别对着你没看过的版本改」。当 `old_string` 在当前内容里
    唯一命中时，替换结果是**确定的**，与「先重读一遍再改」得到的结果完全一致——
    这种情况下拒掉只会白烧一整轮往返。第54轮只修了 CRLF 那支（mtime 被摸但内容没变），
    真正内容变过的那支仍然一律拒。
    现网实证（obs，agent 全岗，2026-11-12~19）：`File has been modified since read`
    共 35 次，其中 **32 次是 replace(old_string)**，横跨 5 个岗位；最近一次
    2026-11-19 00:36:17 就是我自己（改 assets_tool.py，old_string 当时就在最新内容里）。
    判据与边界：
      · 只在**字面替换**（`regex=False`）时生效；正则模式下「唯一命中」无法用于安全判定，
        正则分支保持原样拒绝。
      · `old_string` 去掉首尾空白后至少 12 字符，避免 `}`、`return` 这类短串
        「唯一命中」把语义判宽。
      · 放行后 `str_replace` 仍会**重新从磁盘读内容**再替换，因此改的永远是最新字节，
        不会把旧版本写回去。
      · `write`（整篇覆盖、没有 old_string）不受影响：那种情况确实需要重读。
    """
    file_path = Path(path)
    try:
        resolved = str(file_path.resolve())
    except OSError:
        return None
    with _LOCK:
        entry = _SEEN.get(resolved)
    if entry is None or not entry.full_read:
        return f"Error: {EDIT_NOT_READ_MESSAGE}"
    try:
        stat = file_path.stat()
    except OSError:
        return None  # vanished → let the write path produce its own error
    if _stat_same(entry, stat):
        return None
    current: str | None = None
    if entry.content_hash is not None:
        try:
            current = file_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            current = None
        if current is not None and _content_hash(current) == entry.content_hash:
            return None
    # 【self-evolution-bot · 2026-11-19 · 第61轮 · 模型:deepseek-v4.1-flash-1017】
    # 字面 old_string 在当前内容里唯一命中 → 本次替换结果确定，放行（详见本函数 docstring）。
    if old_string is not None and not regex:
        needle = str(old_string)
        if len(needle.strip()) >= _STALE_ALLOW_MIN_OLD:
            if current is None:
                try:
                    current = file_path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    current = None
            if current is not None and current.count(needle) == 1:
                return None
    return f"Error: {EDIT_STALE_MESSAGE}"


def auto_register_full_read_for_edit(path: str | Path) -> bool:
    """Register a full Read from disk so EDIT_NOT_READ can heal without a wasted turn.

    Used by replace/write when the model edits without a prior Read: we still load
    current bytes for the edit, so recording that view preserves the guard's intent
    (edit against current content) while dropping a Scenario-style retry loop.

    Returns True when state was refreshed; False when the file could not be read.
    """
    file_path = Path(path)
    try:
        text = file_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    note_read(str(file_path), full_read=True, content_hash=_content_hash(text))
    return True


def stale_read_hint() -> str:
    """Paths whose mtime moved since Read. Empty when nothing changed."""
    with _LOCK:
        snapshot = list(_SEEN.items())
    changed: list[str] = []
    for path, entry in snapshot:
        try:
            current = Path(path).stat().st_mtime
        except OSError:
            continue
        if abs(current - entry.mtime) > 1e-6:
            changed.append(path)
    if not changed:
        return ""
    shown = changed[:_MAX_HINT_PATHS]
    extra = len(changed) - len(shown)
    more = f"\n(+{extra} more)" if extra else ""
    body = "\n".join(shown)
    return (
        "<system-reminder>Files you previously read changed on disk. "
        "Re-read them with the Read tool before editing:\n"
        f"{body}{more}</system-reminder>"
    )
