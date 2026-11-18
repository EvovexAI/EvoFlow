"""Format ``search_index`` payloads for tool output (shared by search tools)."""

from __future__ import annotations

from typing import Any


def format_search_index_body(
    data: dict[str, Any],
    *,
    label: str,
    limit: int,
    rebuild_in_progress: bool = False,
    verbose: bool = False,
) -> str:
    """Format search_index payloads. When verbose=False (default), low-signal sections
    (imports, type hierarchy, etc.) with >3 entries are collapsed to count + 2-line preview."""
    hits = data.get("hits") or []
    symbols = data.get("symbols") or []
    # Boost exact-name and partial-name matches to the top of the Symbols list.
    # Within each name-match tier, definitions (function/class/method) rank above
    # usage references so the model sees *where* a symbol is defined before seeing
    # *where* it is merely referenced.
    _DEFINITION_KINDS = frozenset(
        {
            "function",
            "class",
            "method",
            "def",
            "class_definition",
            "function_definition",
            "method_definition",
            "constructor",
            "async_function",
            "async_function_definition",
        }
    )
    if symbols and label:
        _label_terms = [t.strip().lower() for t in str(label).lower().split("|") if t.strip()]
        if _label_terms:

            def _symbol_rank(s):
                sname = str(s.get("name") or "").lower()
                skind = str(s.get("kind") or "").lower().strip()
                is_def = 0 if skind in _DEFINITION_KINDS else 1
                # 【self-evolution-bot · 2026-11-17 · 第32轮】检索层的 match_rank 必须最优先。
                # 原实现只按「符号名里是否字面包含查询串」重排，把检索层算好的相关性整个推翻：
                # 实测查 "read persisted build progress"，
                #   _search_symbols 正确给出 _read_persisted_build_progress（match_rank=4）排第一，
                #   这里却因为 Progress 的名字含 "progress"（字面包含，判 1）
                #   判定它排在 _read_persisted_build_progress（不含完整查询串，判 2）之前。
                # 结果就是用户看到的第一条是无关的 Progress 组件。
                # 现在：match_rank 降序 → 字面匹配档 → 是否定义。
                # 【self-evolution-bot · 2026-11-17 · 第34轮】加第 5 档（整句全等）。
                # 原实现 mr>=4 一律进 tier 0，于是 `resolve`（单词全等，mr=4）与
                # `resolve_data_paths`（整句全等，mr=5）同档，再由「字面包含」判胜负 ——
                # 短名又赢了。改成单调分档，整句命中独占最前。
                mr = int(s.get("match_rank") or 0)
                tier = (
                    0
                    if mr >= 5
                    else (1 if mr >= 4 else (2 if mr == 3 else (3 if mr == 2 else 4)))
                )
                for t in _label_terms:
                    if sname == t:
                        return (tier, 0, is_def)
                for t in _label_terms:
                    if t and t in sname:
                        return (tier, 1, is_def)
                return (tier, 2, is_def)

            symbols = sorted(symbols, key=_symbol_rank)
    related = data.get("related_files") or []
    imported_by = data.get("imported_by") or []
    imports = data.get("imports") or []
    ref_users = data.get("internal_ref_users") or []
    type_supers = data.get("type_supertypes") or []
    type_subs = data.get("type_subtypes") or []

    lines: list[str] = []
    # 【self-evolution-bot · 2026-11-17 · 第33轮】把索引年龄打出来（用户问「时效性你能看到吗」，
    # 实测原本看不到：只有「正在构建」时才提示 stale，构建完成后的索引是 5 分钟还是 5 天，
    # 调用方无从判断）。分档只用于给一句人话，秒数照样保留，便于核对。
    age = data.get("index_age_seconds")
    if isinstance(age, int) and age >= 0:
        if age < 60:
            age_txt = f"{age}s"
        elif age < 3600:
            age_txt = f"{age // 60}m"
        elif age < 86400:
            age_txt = f"{age // 3600}h"
        else:
            age_txt = f"{age // 86400}d"
        stale_note = " — you may be editing newer content; re-run after the index rebuilds" if age >= 900 else ""
        lines.append(f"[index] last updated {age_txt} ago (age={age}s){stale_note}")
        lines.append("")
    # 【self-evolution-bot · 2026-11-17 · 第38轮】光报年龄不够 —— 实测一个 22:39 新建的文件
    # 在库里 0 行，而上面那行照样打印 age=475s（看着很新）。索引是否漏了当前代码，
    # 必须由「源码漂移」这一栏说话，否则调用方会以为「刚构建完，肯定全在」。
    # 阈值取 1：只要有 1 个文件比索引新，结果就可能缺东西，宁可提示也不装作完整。
    drift = data.get("index_source_drift")
    if isinstance(drift, dict):
        n_chg = int(drift.get("changed") or 0)
        n_add = int(drift.get("added") or 0)
        n_del = int(drift.get("deleted") or 0)
        if n_chg or n_add or n_del:
            parts = []
            if n_add:
                parts.append(f"{n_add} new file(s) not indexed")
            if n_chg:
                parts.append(f"{n_chg} changed")
            if n_del:
                parts.append(f"{n_del} deleted")
            lines.append(
                f"[index] stale: {', '.join(parts)} since the index was built"
                f" (disk now has {int(drift.get('total') or 0)} indexable files) —"
                " files not listed as indexed may be missing from the results below"
            )
            lines.append("")
    if rebuild_in_progress:
        lines.append("[index] rebuild in progress — results may be stale")
        lines.append("")
    # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    # 语义召回掉线时字面匹配照样能给出结果，输出看上去完全正常 —— 我上一轮就是在
    # 翻日志时才撞见「每次查询都在报 Pooling 加载失败」。既然用户看的是这段文本，
    # 降级就必须出现在这里，而不是只在 logger 里。
    # 只在非空时打，正常路径零噪声。
    degraded_detail = str(data.get("semantic_degraded_detail") or "").strip()
    if degraded_detail:
        lines.append(f"[index] {degraded_detail}")
        lines.append("")
    path_prefix = str(data.get("path_prefix") or "").strip()
    if path_prefix:
        lines.append(f"[path scope] {path_prefix}")
        if data.get("path_scope_relaxed"):
            lines.append("[hint] no hits under path scope — showing best matches elsewhere in the repo")
        elif data.get("path_scope_empty_hint"):
            lines.append(f"[hint] {data.get('path_scope_empty_hint')}")
        lines.append("")
    lines.extend([f"Code index results for '{label}':", ""])
    # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
    # 查询整句是个标识符、而库里字面没有 → 必须明说，别拿拆词凑数。
    # 实测依据（大池评测 224 条）：5 条随机不存在标识符，5 条都没有说「没有」，
    # 其中 4 条照常吐 10 条符号（查一个纯随机串，首条返回的符号是 `note`）。
    # 这种输出比空结果更坏：调用方会以为「符号存在，只是名字不同」，然后照着改错地方。
    # 注意：这里刻意不写具体的那几个随机串 —— 注释会被索引，
    # 写进来就等于让那些串在库里"真实存在"，反向污染本判据（本轮实测踩到）。
    if data.get("literal_query_missing"):
        lines.append(
            f"[not found] no symbol, path, or text in the index contains the exact"
            f" identifier '{label}'."
            " The hits below are partial-token matches — treat them as weak hints,"
            " not as the definition you asked for."
        )
        lines.append("")
    if symbols:
        lines.append("Symbols:")
        for s in symbols[:limit]:
            lines.append(f"  - {s['kind']} {s['name']} @ {s['path']}:{s['line']}")
        lines.append("")
    if hits:
        lines.append("Content:")
        for h in hits[:limit]:
            snip = str(h.get("snippet") or "").replace("\n", " ")
            lines.append(f"  - {h['path']}: {snip[:200]}")
        lines.append("")

    _COLLAPSE_THRESHOLD = 3

    def _emit_section(title: str, entries: list, formatter) -> None:
        if not entries:
            return
        shown = entries[:limit]
        if not verbose and len(entries) > _COLLAPSE_THRESHOLD:
            preview = entries[:2]
            lines.append(f"{title} ({len(entries)} entries — showing first 2; pass verbose=True to expand):")
            for r in preview:
                lines.append(f"  - {formatter(r)}")
        else:
            lines.append(f"{title}:")
            for r in shown:
                lines.append(f"  - {formatter(r)}")
        lines.append("")

    _emit_section(
        "Imports (internal)",
        imports,
        lambda r: f"{r.get('from_path')} -> {r.get('to_path')} ({r.get('spec', '')[:60]})",
    )
    _emit_section(
        "Imported by (internal)",
        imported_by,
        lambda r: f"{r.get('from_path')} imports {r.get('to_path')}",
    )
    _emit_section(
        "Related (import graph neighbors)",
        related,
        lambda r: f"{r.get('path')}",
    )
    _emit_section(
        "Internal symbol uses",
        ref_users,
        lambda r: f"{r.get('from_path')}:{r.get('line')} uses {r.get('symbol') or '?'} from {r.get('to_path')}",
    )
    _emit_section(
        "Type hierarchy (supertypes / parents)",
        type_supers,
        lambda r: f"{r.get('from_type')} @ {r.get('from_path')} {r.get('rel_kind')} {r.get('to_type')} ({r.get('to_path') or '?'})",
    )
    _emit_section(
        "Type hierarchy (subtypes / implementers)",
        type_subs,
        lambda r: f"{r.get('from_type')} @ {r.get('from_path')} {r.get('rel_kind')} {r.get('to_type')} ({r.get('to_path') or '?'})",
    )
    return "\n".join(lines).rstrip()
