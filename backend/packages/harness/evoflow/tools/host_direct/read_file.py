"""Read file contents — direct filesystem access, no sandbox overhead."""

import os
from pathlib import Path

from langchain_core.tools import tool
from langgraph.types import Command

from evoflow.core.tool_runtime_type import ToolRuntime
from evoflow.tools.host_direct.read_logic import apply_whole_file_read_gate, read_file_content
from evoflow.tools.host_direct.workspace_context import resolve_tool_workspace_root
from evoflow.tools.host_direct.workspace_path_guard import (
    _is_absolute_path,
    _resolve_relative_under_root,
    resolve_tool_path,
)
from evoflow.tools.minimal_schema import READ_TOOL_DESCRIPTION
from evoflow.utils.bundled_tools import from_bash_posix_path
from evoflow.utils.workspace_browse import flatten_bound_workspace_absolute

# Image refs (local paths / http(s) URLs / browser-snapshot refs) dispatch to the
# shared view_image pipeline instead of returning text (ZCode-style Read dispatch).
_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")

_SYMBOL_MAX_LINES = 200

_PYTHON_EXTS = {".py", ".pyi"}
_JS_TS_EXTS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}
_JAVA_EXTS = {".java"}


def _detect_language(path: Path) -> str:
    """Detect language from file extension for symbol matching."""
    ext = path.suffix.lower()
    if ext in _PYTHON_EXTS:
        return "python"
    if ext in _JS_TS_EXTS:
        return "jsts"
    if ext in _JAVA_EXTS:
        return "java"
    return "python"  # default: indentation-based matching works for many languages


def _find_symbol_range(content: str, symbol: str, language: str = "python") -> tuple[int, int] | None:
    """Find the line range (1-based start, exclusive end) of a function/class by name.

    Supports Python (indentation-based body), JS/TS/Java (brace-matched body).
    """
    lines = content.splitlines()
    if language == "python":
        return _find_symbol_python(lines, symbol)
    return _find_symbol_brace(lines, symbol, language)


def _find_symbol_python(lines: list[str], symbol: str) -> tuple[int, int] | None:
    """Python: match def/class, use indentation to find body end."""
    import re

    pattern = re.compile(
        r"^(\s*)(?:async\s+)?(?:def|class)\s+" + re.escape(symbol) + r"\b",
    )
    for i, line in enumerate(lines):
        m = pattern.match(line)
        if not m:
            continue
        indent = len(m.group(1))
        start = i
        end = len(lines)
        for j in range(i + 1, len(lines)):
            line_j = lines[j]
            if line_j.strip() == "":
                continue
            current_indent = len(line_j) - len(line_j.lstrip())
            if current_indent <= indent and line_j.strip():
                end = j
                break
        return (start + 1, end)
    return None


def _find_symbol_brace(lines: list[str], symbol: str, language: str) -> tuple[int, int] | None:
    """JS/TS/Java: match function/class/method, use brace matching for body end."""
    import re

    sym = re.escape(symbol)
    if language == "jsts":
        patterns = [
            re.compile(rf"^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+{sym}\b"),
            re.compile(rf"^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+{sym}\b"),
            re.compile(rf"^(\s*)(?:export\s+)?(?:const|let|var)\s+{sym}\s*=?\s*(?:\(|function|async|=>|\[)"),
        ]
    else:  # java
        patterns = [
            re.compile(rf"^(\s*)(?:\w+\s+)*(?:class|interface|enum)\s+{sym}\b"),
            re.compile(rf"^(\s*)(?:\w+\s+)*\w+(?:\s*<[^>]+>)?\s+{sym}\s*\("),
        ]

    for i, line in enumerate(lines):
        if not any(pat.match(line) for pat in patterns):
            continue
        # Find first opening brace within next 20 lines (handles multi-line params)
        brace_line = -1
        for j in range(i, min(i + 20, len(lines))):
            if "{" in lines[j]:
                brace_line = j
                break
        if brace_line < 0:
            # No brace — abstract method, interface method, or one-liner ending with ;
            end = i + 1
            for j in range(i + 1, min(i + 5, len(lines))):
                if lines[j].rstrip().endswith(";"):
                    end = j + 1
                    break
            return (i + 1, end)
        # Brace matching from brace_line
        depth = 0
        for k in range(brace_line, len(lines)):
            for ch in lines[k]:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        return (i + 1, k + 1)
        return (i + 1, len(lines))
    return None


def _list_symbols_in_file(content: str, language: str = "python", limit: int = 15) -> list[str]:
    """Extract top-level symbol names for 'did you mean' suggestions."""
    import re

    lines = content.splitlines()
    names: list[str] = []
    if language == "python":
        pat = re.compile(r"^(\s*)(?:async\s+)?(?:def|class)\s+(\w+)")
        grp = 2
    elif language == "jsts":
        pat = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+|class\s+)(\w+)")
        grp = 1
    else:
        pat = re.compile(r"^\s*(?:\w+\s+)*(?:class|interface|enum)\s+(\w+)")
        grp = 1
    for line in lines:
        m = pat.match(line)
        if m:
            name = m.group(grp)
            if name and name not in names:
                names.append(name)
        if len(names) >= limit:
            break
    return names


def _background_task_output_hint(target: Path) -> str:
    """后台 bash 任务输出路径的专属提示 —— 这种「找不到」的正确动作不是换个路径。

    【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    实证：近 7 天 obs 里 `read` 的 file-not-found 后半期 12 次（前半期 1 次），
    抽样 5 条有 4 条读的是 `…/evoflow-bash-tasks/<id>.output`。这类文件由后台任务
    写出，刚被后台化时是空文件甚至尚未创建；正确的下一步是等任务完成再读
    （或直接看任务结果的 outputFile），不是换措辞再试一次路径。
    """
    try:
        parts = {p.lower() for p in target.parts}
    except Exception:  # noqa: BLE001
        return ""
    if "evoflow-bash-tasks" not in parts:
        return ""
    return (
        "；这看起来是**后台 bash 任务的输出文件**：它在任务还没产出时可能为空或尚未创建。"
        "请等任务完成后重读该路径，或用 taskoutput/task 通知里的 outputFile，"
        "不要换措辞重试同一个路径。"
    )


def _resolve_read_target(path: str, *, runtime: ToolRuntime) -> Path | str:
    """Resolve *path* to a host file without workspace confinement (IDE-like)."""
    raw = str(path or "").strip()
    if not raw:
        return "Error: path is required"

    if raw.startswith("skill:"):
        resolved = resolve_tool_path(
            raw,
            runtime=runtime,
            must_exist=True,
            must_be_file=True,
            allow_skills_install=True,
        )
        return resolved

    # Git Bash ``/d/foo`` and WSL ``/mnt/d/foo`` must become ``D:/foo`` before
    # Path.resolve() on Windows; otherwise read looks for a ghost ``D:\d\foo``
    # tree and reports "File not found" while ``bash`` reads the same path fine.
    expanded = from_bash_posix_path(os.path.expanduser(os.path.expandvars(raw)))
    if _is_absolute_path(expanded, expanded):
        target = Path(expanded).resolve()
        root_s, _tid = resolve_tool_workspace_root(runtime=runtime)
        if root_s:
            root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
            target = flatten_bound_workspace_absolute(target, root)
        if not target.is_file():
            if target.is_dir():
                return f"Error: Path is a directory, not a file: {path}. Use terminal (e.g. dir / ls) to browse, or read with a concrete file path."
            # 【self-evolution-bot · 2026-11-16 · 第20轮】绝对路径入参通常 target==入参，
            # 报入参就等于报查找位置；但 flatten_bound_workspace_absolute 可能把它重映射到
            # 绑定工作区下的另一条路径，此时只报入参就是在误导。仅在两者不同时补一句。
            if str(target) != str(Path(expanded).resolve()):
                return f"Error: File not found: {path}（实际查找的绝对路径：{target}）"
            # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
            # 后台任务输出文件是个高频特例：文件由 bash 后台任务写出，**还没写完**或
            # 已被清理时读它就是 File not found，而正确动作是去等任务完成，不是换路径重试。
            # 实证（近7天 obs）：read::file 错误后半期 12 次 / 前半期 1 次，抽样 5 条里
            # 4 条都是 evoflow-bash-tasks 下的 *.output。只报「找不到」等于逼我自己再绕一步。
            hint = _background_task_output_hint(target)
            if hint:
                return f"Error: File not found: {path}（实际查找的绝对路径：{target}）{hint}"
            return f"Error: File not found: {path}"
        return target

    root_s, _tid = resolve_tool_workspace_root(runtime=runtime)

    # 【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】
    # read 是调用量最高的文件工具（近7天 1549 次），但它**没走** `resolve_tool_path`：
    # 普通相对路径在这里按「会话工作区根 / 进程 cwd」自己拼，于是第 89 轮给
    # `resolve_tool_path` 加的「复用 bash 学到的 cwd」对它完全没生效——
    # 上一笔提交 message 写「read 也生效」是不准确的，这里补上真接线。
    # 语义取最保守形态：只在 bash cwd 下**真实存在**时采用，否则一律回落旧逻辑。
    from evoflow.tools.host_direct.workspace_path_guard import _bash_cwd_for_thread

    _bcwd = _bash_cwd_for_thread(_tid, root_s)
    if _bcwd is not None:
        _cand = (_bcwd / expanded).resolve()
        if _cand.is_file():
            return _cand

    if root_s:
        root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
        if not root.is_dir():
            return f"Error: Workspace root is not a directory: {root}"
        target = _resolve_relative_under_root(root, raw.replace("\\", "/"))
        _base_dir, _base_kind = root, "会话工作区根"
    else:
        target = (Path.cwd() / expanded).resolve()
        _base_dir, _base_kind = Path.cwd(), "进程当前目录"

    if not target.is_file():
        if target.is_dir():
            return f"Error: Path is a directory, not a file: {path}. Use terminal (e.g. dir / ls) to browse, or read with a concrete file path."
        # 【self-evolution-bot · 2026-11-16 · 第20轮】报错只说入参不报「实际找的是哪」，
        # 于是相对路径被解析到工作区根（C:\Users\admin\.evoflow\profiles\default）而不是
        # 仓库根时，调用方只能靠猜再绕一步 —— 现网 obs 实测 1 次（memory/standing.md、
        # backend/packages/.../craft.py 这类仓库相对路径）。这里把试过的绝对路径 + 工作区根
        # 一起回显，且当工作区根下确实存在同名但不同根的候选时，把「你可能想用仓库绝对路径」
        # 这句也说出来；纯绝对路径入参不重复啰嗦工作区根。
        tried = target
        # 【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】
        # 相对路径找不到时，先沿父目录向上找真实存在的同名文件，别直接报死。
        # 为什么：网关进程 cwd 是 ``backend/``，而 agent 习惯写**仓库相对**路径
        # （``backend/packages/.../installer.py``），拼出来就是 ``backend/backend/...``，
        # 文件明明在却报找不到——现网 obs 实测这类占 read::file 错误的绝大多数。
        # 往上找是安全的：read 本就是 IDE-like、docstring 明写 without workspace
        # confinement，不引入新的越权面。命中就当场说清是用哪条路径读到的。
        if not _is_absolute_path(expanded, expanded):
            up = _resolve_upward_fallback(target)
            if up is not None:
                return up
        detail = f"Error: File not found: {path}（实际查找的绝对路径：{tried}）"
        root_s_hint, _tid2 = resolve_tool_workspace_root(runtime=runtime)
        if root_s_hint and not _is_absolute_path(expanded, expanded):
            root_hint = Path(os.path.expanduser(os.path.expandvars(root_s_hint))).resolve()
            detail += (
                f"；相对路径是按工作区根 {root_hint} 拼接的，"
                "仓库内文件请传 D:/... 绝对路径"
            )
        elif not _is_absolute_path(expanded, expanded):
            # 未绑定工作区时走 ``Path.cwd()`` 分支，旧代码在这条路上一句提示都不给，
            # 于是 ``backend/backend/...`` 这种重复前缀没人解释得清。补上。
            detail += (
                f"；相对路径是按进程当前目录 {Path.cwd()} 拼接的"
                "（已向上查找同名文件，未命中）；仓库内文件请传 D:/... 绝对路径"
            )
        # 【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】
        # 第 89 轮起相对路径会**先**按 bash 学到的 cwd 试一次。若上面报的是工作区根
        # 或进程 cwd，不再补这一句会让调用方以为没试过 bash 的当前目录。
        if _bcwd is not None and not _is_absolute_path(expanded, expanded):
            detail += f"（bash 当前目录 {_bcwd} 下也未命中）"
        return detail

    # 【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】
    # 补上成功分支的 return。这里原本**漏了这一行**：`if not target.is_file():` 块内
    # 每条路径都 return 了错误串，块外却没有 `return target`，于是「相对路径 + 文件确实
    # 存在」这个最常见的**成功**路径会一路掉到函数末尾，隐式返回 None；上游把它当成
    # 解析失败，报出 ``could not resolve path 'AGENTS.md' to a file (resolver returned
    # NoneType)``——文件明明存在（5242B），调用方却只能换写法重试。
    # 取证：trace 捕获 return 行号 = 231（正是 `if not target.is_file():` 那行，块后无返回），
    # 入参/expanded/target 全部正常且 target.is_file() 为 True。
    # 现网后果：read::file 错误后半期 11 次 / 前半期 2 次，绝大多数是这种「存在却报解析失败」。
    # 第52轮我只在这里补了「拿到非 Path 就报错」的防线，没找到根因，所以 bug 一直在。
    return target


def _resolve_upward_fallback(target: Path) -> Path | None:
    """【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

    相对路径拼出的 ``target`` 不存在时，沿父目录向上找**真实存在的同名文件**。

    为什么需要：网关进程 cwd 是 ``backend/``，而 agent 习惯写仓库相对路径
    （``backend/packages/.../installer.py``），拼出来是 ``backend/backend/...``；
    文件本身就在，却被报「找不到」。现网 obs 实证：``read::file`` 错误
    后半期 11 次 / 前半期 2 次，抽样全是这种重复前缀形态。

    安全性：``read`` 的 docstring 明写 IDE-like、``without workspace confinement``，
    本函数只是把「已经写对的相对路径」认回来，不扩大可读范围——最终返回的路径
    仍必须是 ``is_file()`` 的真实文件。

    判据：只在**命中真实文件**时返回 Path；找不到返回 ``None``，由调用方照旧报错。
    不做模糊匹配（同名多份时取最近的一层并保证唯一），避免读错文件。
    """
    try:
        orig = Path(target)
        name = orig.name
        # ① 先修「重复前缀」这个真形态：`backend/backend/packages/x.py` 里
        # ``backend`` 连着出现两次，合并相邻重复段即得真实路径。这比盲目上溯精准，
        # 也不会把某个无关目录下的同名文件蒙进来。
        parts = list(orig.parts)
        dedup: list[str] = []
        for p in parts:
            if dedup and p == dedup[-1] and p not in ("\\", "/"):
                continue
            dedup.append(p)
        if len(dedup) != len(parts):
            cand0 = Path(*dedup)
            if cand0.is_file():
                return cand0.resolve()

        # ② 兜底：沿父目录向上，整段相对路径重试（最多 12 层，覆盖
        # ``backend/backend/`` 这类出一整段重复前缀的场景）。
        cur = orig.parent
        for _ in range(12):
            if cur == cur.parent:
                break
            cur = cur.parent
            if (cur / name).is_file():
                return (cur / name).resolve()
            try:
                rel = orig.relative_to(cur)
            except ValueError:
                continue
            if (cur / rel).is_file():
                return (cur / rel).resolve()
    except (OSError, ValueError):
        return None
    return None


def _note_model_read(
    path: Path,
    *,
    full_read: bool = True,
    content_hash: str | None = None,
    thread_id: str = "",
) -> None:
    try:
        from evoflow.tools.zcode_port.read_file_state import note_read

        note_read(
            str(path),
            full_read=full_read,
            content_hash=content_hash,
            thread_id=thread_id or None,
        )
    except Exception:
        return


def _is_image_ref(ref: str) -> bool:
    """True for refs the view_image pipeline can handle: image path / http(s) URL / browser-snapshot."""
    s = str(ref or "").strip().replace("\\", "/")
    if not s:
        return False
    lower = s.lower()
    if lower.startswith(("http://", "https://")) or "/browser-snapshots/" in lower:
        return True
    # Strip URL query/fragment before the extension check.
    return os.path.splitext(lower.split("?", 1)[0].split("#", 1)[0])[1] in _IMAGE_EXTENSIONS


def _resolve_image_ref(ref: str, *, runtime: ToolRuntime) -> str:
    """Resolve a local image ref to an absolute path; URL / snapshot refs pass through.

    Reuses the read tool's own path resolution (workspace-relative paths,
    ``skill:`` paths, env expansion) so image reads behave like text reads.
    """
    lowered = ref.lower()
    if lowered.startswith(("http://", "https://")) or "/browser-snapshots/" in lowered:
        return ref
    resolved = _resolve_read_target(ref, runtime=runtime)
    if isinstance(resolved, str):
        return resolved  # read-style error string, returned verbatim
    # 【self-evolution-bot · 2026-11-18 · 第52轮 · 模型:deepseek-v4.1-flash-1017】
    # 同 read_file_hd 的 Text path：`str(None)` 会变成字符串 "None"，下游再拿它
    # 当路径去猜后缀，报出来的错和真实原因毫无关系。这里当场戳穿。
    if not isinstance(resolved, Path):
        return (
            f"Error: could not resolve image ref {ref!r} "
            f"(resolver returned {type(resolved).__name__})."
        )
    return str(resolved)


@tool("read", description=READ_TOOL_DESCRIPTION, parse_docstring=False)
def read_file_hd(
    path: str | list[str],
    *,
    offset: int | None = None,
    limit: int | None = None,
    symbol: str | None = None,
    pages: str | None = None,
    runtime: ToolRuntime,
) -> str | Command:
    """Read one file (text) or load/analyze image(s) from the local filesystem or URLs."""
    from evoflow.tools.builtins.view_image_tool import (
        normalize_image_path_args,
        run_view_image_refs,
    )

    # 【self-evolution-bot · 2026-11-19 · 第83轮 · 模型:deepseek-v4.1-flash-1017】
    # 本会话 id：读回执按线程记账，否则别的岗位/别的线程读过的文件会让我这边
    # 收到「Wasted call，去翻你之前那条 tool_result」——而那条根本不在我上下文里。
    # 现网 70 次 Wasted call 里 41 次（58.6%）就是这么来的（详见 read_file_state.py）。
    from evoflow.tools.zcode_port.read_file_state import runtime_thread_id

    _tid = runtime_thread_id(runtime)

    # Staged-image Commands must carry the originating tool call id; the real
    # graph always provides it via ToolRuntime (node_repl_tool uses the same
    # pattern — no InjectedToolCallId param, so direct ``.invoke()`` keeps working).
    tool_call_id = str(getattr(runtime, "tool_call_id", "") or "").strip()

    # ── Image dispatch ──
    # ``path`` may be a single ref or a list of image refs (batch, view_image semantics).
    # A JSON-array string is accepted and expanded for older callers.
    image_refs = normalize_image_path_args(path)
    if len(image_refs) > 1:
        if not all(_is_image_ref(ref) for ref in image_refs):
            return (
                "Error: read accepts a list only for image paths/URLs "
                "(jpg/jpeg/png/webp, http(s) URLs, browser-snapshot refs); "
                "read text files one at a time."
            )
        resolved_refs: list[str] = []
        for ref in image_refs:
            resolved_ref = _resolve_image_ref(ref, runtime=runtime)
            if resolved_ref.startswith("Error"):
                return resolved_ref
            resolved_refs.append(resolved_ref)
        return run_view_image_refs(runtime=runtime, tool_call_id=tool_call_id, refs=resolved_refs)
    if image_refs and _is_image_ref(image_refs[0]):
        resolved_ref = _resolve_image_ref(image_refs[0], runtime=runtime)
        if resolved_ref.startswith("Error"):
            return resolved_ref
        return run_view_image_refs(runtime=runtime, tool_call_id=tool_call_id, refs=[resolved_ref])

    # ── Text path ──
    resolved = _resolve_read_target(path, runtime=runtime)
    if isinstance(resolved, str):
        return resolved
    # 【self-evolution-bot · 2026-11-18 · 第52轮 · 模型:deepseek-v4.1-flash-1017】
    # 上一行只挡了 str，于是 None（或任何非 Path 意外值）会一路裸奔到下面的
    # ``resolved.suffix``，在现网炸成「Tool 'read' failed with AttributeError:
    # 'NoneType' object has no attribute 'suffix'」——调用方只看到一句没有路径、
    # 没有下一步的崩溃，只能换个写法重试（今天 obs 实测 6 次，09:57~16:03）。
    # 这里用**正向断言**而不是 ``if resolved is None``：判据是「必须拿到 Path」，
    # 任何意外类型都该被这条挡住并说清是哪条入参，而不是由下游某行代为崩溃。
    if not isinstance(resolved, Path):
        return (
            f"Error: could not resolve path {path!r} to a file "
            f"(resolver returned {type(resolved).__name__}). "
            "Check the path spelling, or pass an absolute D:/... path."
        )
    # ── PDF path (zcode Read PDF alignment) ──
    # Dispatched before symbol/offset/limit: those are line-oriented and
    # meaningless for PDFs; ``pages`` is the PDF-native page range parameter.
    if resolved.suffix.lower() == ".pdf":
        from evoflow.tools.host_direct.read_pdf import read_pdf_file

        text = read_pdf_file(resolved, pages=pages)
        if not str(text).startswith("Error:"):
            _note_model_read(resolved, full_read=False, thread_id=_tid)
        return text
    if symbol:
        content = resolved.read_text(encoding="utf-8", errors="replace")
        language = _detect_language(resolved)
        result = _find_symbol_range(content, symbol, language=language)
        if result is None:
            available = _list_symbols_in_file(content, language=language)
            hint = ""
            if available:
                hint = f"\n\nAvailable symbols: {', '.join(available[:10])}"
            return f"Error: Symbol '{symbol}' not found in {path}.{hint}\n\nTip: Use offset + limit to read by line range."
        start, end = result
        lines = content.splitlines()
        body_lines = lines[start - 1 : end]
        total = len(body_lines)
        if total > _SYMBOL_MAX_LINES:
            shown = body_lines[:_SYMBOL_MAX_LINES]
            text = "\n".join(f"{start + i}: {line}" for i, line in enumerate(shown))
            remaining = total - _SYMBOL_MAX_LINES
            text += f"\n\n… [symbol '{symbol}' body is {total} lines; showing first {_SYMBOL_MAX_LINES}. Read the rest with offset={start + _SYMBOL_MAX_LINES}, limit={min(_SYMBOL_MAX_LINES, remaining)}]"
            return text
        text = "\n".join(f"{start + i}: {line}" for i, line in enumerate(body_lines))
        _note_model_read(resolved, full_read=False, thread_id=_tid)
        return text
    # ZCode-style file_unchanged short-circuit: a full-text re-read of an
    # unchanged file returns a one-line marker instead of resending content.
    if offset is None and limit is None:
        try:
            from evoflow.tools.zcode_port.read_file_state import unchanged_since_last_read

            if unchanged_since_last_read(resolved, thread_id=_tid):
                return (
                    "Wasted call — file unchanged since your last Read. "
                    "Refer to that earlier tool_result instead. "
                    "If you intentionally want the content again, use offset=1."
                )
        except Exception:
            pass
    text = read_file_content(str(resolved), offset=offset, limit=limit, use_cache=True)
    if not str(text).startswith("Error:"):
        full_read = offset is None and limit is None
        if full_read:
            # zcode-style whole-file gate: cap big reads to a paginated partial
            # view so one large file does not ride on every later request.
            gated = apply_whole_file_read_gate(text, path=str(resolved))
            if gated is not text:
                text = gated
                full_read = False
        # Hash only meaningful for full views; partial views never qualify for edit.
        # 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
        # 必须按**磁盘原文**算，不能用上面（已 CRLF 归一化/加行号/可能被门禁截断的）
        # 渲染文本。守卫 edit_guard_failure 比对时读的是磁盘原文，两边口径不一致时
        # CRLF 文件永远比不平 —— 「内容没变」也会被判 stale，逼我重读一遍。
        content_hash = None
        if full_read:
            from evoflow.tools.zcode_port.read_file_state import file_content_hash

            content_hash = file_content_hash(resolved)
        _note_model_read(resolved, full_read=full_read, content_hash=content_hash, thread_id=_tid)
    return text
