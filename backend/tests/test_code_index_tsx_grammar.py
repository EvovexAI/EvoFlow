"""【self-evolution-bot · 2026-11-17 · 第31轮】TSX 语法映射的回归锁。

为什么要有这组测试：`.tsx` 曾被映射到 `typescript` grammar，而 typescript grammar
不认识 JSX —— 它不会报错，而是走错误恢复，在普通组件文件上进入近乎死循环的解析。
实证（2026-11-17，`evopanel/src/zcode-ui/ToolCallBlocks/ToolCallBody.tsx`，
8826 字节 / 257 行）：

    tsx grammar        -> 0.010s，root=program，has_error=False，symbols=5
    typescript grammar -> 60s+ 未返回（探针被外层杀掉）

线上后果不是「这个文件少几个符号」，而是**整个 build_index 中途死掉**：
Gateway 日志 2026-11-17 07:32:25 记 `event-loop-lag lag=267.5s` 之后紧接
`ERROR background code_index build failed` + `RecursionError`（_walk_symbols 递归 987 层），
库停在 6454/9033 个文件、code_vec 只有 14 行，且三轮重建全部死在同一文件
（同一 walk 序必然复现）。

修好后全仓 3417 个 ts/tsx 文件解析总耗时 7.6s、0 异常、0 个 >1s 的慢文件。

这三条断言锁住三件事，任何一条被改回去都意味着上面的事故会重演：
1. `.tsx` 必须进 `tsx` profile，且该 profile 的 parser 是 `tsx`；
2. `.ts` 仍走 `typescript`（不要为了省事把两者合并）；
3. 真实 TSX 里能取到符号，且统计标签仍是 `tree_sitter_typescript`（口径不变）。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
HARNESS = BACKEND / "packages" / "harness"
if str(HARNESS) not in sys.path:
    sys.path.insert(0, str(HARNESS))

from evoflow.code_index import tree_sitter_core as T  # noqa: E402

TSX_SNIPPET = """
import { useState } from "react";

interface Props {
  title: string;
}

export function Panel({ title }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="panel">
      <span>{title}</span>
      <button onClick={() => setOpen(!open)}>toggle</button>
    </div>
  );
}

export class Store {
  load() {
    return 1;
  }
}
"""


def test_tsx_maps_to_tsx_grammar_not_typescript() -> None:
    """`.tsx` 必须走 tsx profile —— 这是本轮事故的根因所在。"""
    assert T.language_for_path(Path("a.tsx")) == "tsx"
    profile = T._LANG_PROFILES["tsx"]
    assert profile["parser"] == "tsx", "tsx profile 必须用 tsx grammar，不能用 typescript"
    assert profile["parser"] != T._LANG_PROFILES["typescript"]["parser"]


def test_ts_still_uses_typescript_grammar() -> None:
    """`.ts` 不应被顺手改成 tsx —— 两者语法不同，合并会带来另一批解析差异。"""
    assert T.language_for_path(Path("a.ts")) == "typescript"
    assert T._LANG_PROFILES["typescript"]["parser"] == "typescript"


def test_tsx_symbols_extracted_with_stable_parser_tag() -> None:
    """真实 TSX 要能取到符号，且统计标签保持 tree_sitter_typescript（口径不变）。"""
    pytest.importorskip("tree_sitter_languages")
    out = T.extract_symbols_tree_sitter(Path("panel.tsx"), TSX_SNIPPET)
    assert out, "TSX 文件应当能抽到符号"
    names = {s["name"] for s in out}
    assert "Panel" in names and "Store" in names
    tags = {s["parser"] for s in out}
    assert tags == {"tree_sitter_typescript"}, f"标签口径变了：{tags}"


def test_tsx_parse_is_fast_not_hanging() -> None:
    """回归锁重点：TSX 解析必须秒级返回，不能卡住索引线程。

    阈值取 5 秒：实测修复后 10ms 级，而缺陷态是 60s+ 不返回。
    """
    pytest.importorskip("tree_sitter_languages")
    t0 = time.time()
    parsed = T.parse_tree(Path("panel.tsx"), TSX_SNIPPET * 30)
    elapsed = time.time() - t0
    assert parsed is not None
    assert elapsed < 5.0, f"TSX 解析耗时 {elapsed:.2f}s，疑似又用错 grammar 陷入死循环"
