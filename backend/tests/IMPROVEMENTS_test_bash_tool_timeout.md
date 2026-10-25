# `tests/test_bash_tool_timeout.py` 改进建议（按优先级）

> 基线：`backend/tests/test_bash_tool_timeout.py`（102 行 / 8 个 `test_` 函数 / 13 个用例实例）
> 被测：`backend/packages/harness/evoflow/tools/zcode_port/bash_tool.py`
> 本文件仅为建议，**未修改任何测试代码**。

## 0. 事实校正（相对上游 Step 1 摘要）

| 项 | 上游摘要 | 核对结果 |
|---|---|---|
| 用例计数 | “7 个 `test_` 函数，其中 1 个 parametrize(6 组) → 12 个实例” | 实为 **8 个 `test_` 函数 → 13 个实例**。除 `test_probe_command_detection`(6) 外，`test_stale_read_hint_after_mtime_change`(L58) 与 `test_small_stdout_stays_inline`(L81) 未进入断言强弱清单，补评：前者中/强（子串 + `resolve()` 绝对路径），后者最强（`truncated is False` + `shown == "git status ok"` 精确等值）。 |
| 常量 | 多处“自引用” | 核对真值：`PROBE_TIMEOUT_MS=30000`（可被 env `EVOFLOW_BASH_PROBE_TIMEOUT_MS` 覆盖，L32）、`ASSISTANT_BLOCKING_BUDGET_MS=15000`、`MAX_INLINE_BYTES=30000`、`MODEL_PREVIEW_CHARS=2000`、`MAX_BASH_TIMEOUT_MS=600000`、`DEFAULT_TIMEOUT_MS=120000`。**这确认了“自引用 = 弱断言”的判断成立**：右侧引用被测常量时，常量被改坏也照样通过。 |

---

## 优先级总览

| 级别 | 项 | 类型 |
|---|---|---|
| **P0-1** | 软上限/阻塞预算常量自引用 → 恒真 | 加强断言 |
| **P0-2** | `len(shown) < MAX_INLINE_BYTES` 在落盘分支恒真 | 加强断言 |
| **P0-3** | tree-kill 兜底 `os.kill` 分支零覆盖 | 新增用例 + 加强断言 |
| **P1-1** | `bash_shell()` WindowsApps 假 shell 分支 | 新增用例 |
| **P1-2** | `_semantic_timeout` 钳位/默认值 | 新增用例（参数化） |
| **P1-3** | `_stale_hint_for` 写命令门控 | 新增用例（参数化） |
| **P1-4** | `_format_finished` 输出信封格式 | 新增用例 |
| **P1-5** | UTF-8 字节 vs 字符阈值 | 新增用例 |
| **P2-1** | probe 正则表 + 超时链路共用一张契约表 | 参数化/去重 |
| **P2-2** | `_timeout_was_explicit` 参数化补边界 | 参数化/去重 |
| **P2-3** | 模块级 fixture 收敛重复 import/monkeypatch | 参数化/去重 |
| **P2-4** | 全局读状态泄漏守卫 | 加强断言 |
| **P2-5** | parametrize `ids` 可读性 | 可维护性 |

---

## P0（本轮必做：三处断言在当前实现下恒真，等于没测）

### P0-1 软上限 / 阻塞预算：常量自引用使契约失效

**位置**：L32-37、L40-43。
**理由**：`min(120_000, bt.PROBE_TIMEOUT_MS)` 与 `== bt.ASSISTANT_BLOCKING_BUDGET_MS` 的右侧就是被测常量本身。若有人把 `PROBE_TIMEOUT_MS` 调成 `600_000`（等于取消 probe 软上限），或把 `ASSISTANT_BLOCKING_BUDGET_MS` 调成 `120_000`（等于取消 15s 不阻塞助手回合的预算），这两个用例**依然全绿**。这两个数值本身是对外契约（源码注释分别对位 ZCode 的 `bash.ts resultBudget` 与 `bash-model-content.ts`），应硬编码锁定，并额外锁定与 `DEFAULT_TIMEOUT_MS` 的相对关系。

**写法示例（替换 L32-43）**：

```python
def test_probe_soft_cap_contract() -> None:
    # 契约值硬编码：常量被改坏（例如改成 600s）时用例必须红
    assert bt.PROBE_TIMEOUT_MS == 30_000
    assert bt.PROBE_TIMEOUT_MS < bt.DEFAULT_TIMEOUT_MS == 120_000

    assert bt._effective_timeout_ms("git status", 120_000, explicit=False) == 30_000
    assert bt._effective_timeout_ms("git status", 120_000, explicit=True) == 120_000
    assert bt._effective_timeout_ms("npm install", 120_000, explicit=False) == 120_000


def test_blocking_budget_contract() -> None:
    assert bt.ASSISTANT_BLOCKING_BUDGET_MS == 15_000

    assert bt._blocking_budget_ms(120_000, explicit=False) == 15_000
    assert bt._blocking_budget_ms(120_000, explicit=True) == 120_000
    assert bt._blocking_budget_ms(5_000, explicit=False) == 5_000
    assert bt._blocking_budget_ms(5_000, explicit=True) == 5_000  # 显式短超时原样保留
```

### P0-2 “短预览”断言在落盘分支恒真

**位置**：L53 `assert len(shown) < bt.MAX_INLINE_BYTES`。
**理由**：落盘时 `shown` 是 `<persisted-output>` 信封（固定 header + 至多 `MODEL_PREVIEW_CHARS=2000` 预览 + `...` + 闭合标签）。即便预览逻辑退化成“把 30KB 全文塞进信封”，虽然会超过 30KB —— 但当前断言真正的问题在于它**没有约束预览长度这一维度**：任何 ≤30KB 的信封都通过，包括 29KB 的信封。应改为相对 `MODEL_PREVIEW_CHARS` 断言，并补上内联阈值边界（`_utf8_len(raw) <= MAX_INLINE_BYTES` 用的是 `<=`，L137，边界行为必须锁死）。

**写法示例（替换 L46-55 并新增边界用例）**：

```python
def test_large_stdout_is_persisted_with_short_preview(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(bt, "_output_file", lambda task_id: tmp_path / f"{task_id}.output")
    text = "x" * (bt.MAX_INLINE_BYTES + 50)
    shown, truncated = bt._model_stream(text)

    assert truncated is True
    assert shown.startswith("<persisted-output>")
    assert shown.rstrip().endswith("</persisted-output>")
    assert "Full output saved to:" in shown
    # header 报的是 _format_byte_size 结果（≥1KB 走 KB 分支），实测 30050 → "29.3KB"
    assert f"Output too large ({bt._format_byte_size(bt.MAX_INLINE_BYTES + 50)})." in shown
    assert bt._format_byte_size(bt.MAX_INLINE_BYTES + 50) == "29.3KB"
    assert f"Preview (first {bt._format_byte_size(bt.MODEL_PREVIEW_CHARS)}):" in shown
    # 预览预算：信封整体只能比 2000 字符预览多出固定 header，绝不能接近内联上限
    assert len(shown) < bt.MODEL_PREVIEW_CHARS * 3
    assert len(shown) < bt.MAX_INLINE_BYTES / 10
    assert "x" * (bt.MODEL_PREVIEW_CHARS - 10) in shown           # 预览确实取自正文前段

    saved = list(tmp_path.glob("*.output"))
    assert len(saved) == 1
    assert saved[0].read_text(encoding="utf-8") == text


@pytest.mark.parametrize(
    ("size", "expect_truncated"),
    [(bt.MAX_INLINE_BYTES, False), (bt.MAX_INLINE_BYTES + 1, True)],
    ids=["at-limit-inline", "one-byte-over-persisted"],
)
def test_inline_threshold_boundary(tmp_path, monkeypatch, size: int, expect_truncated: bool) -> None:
    monkeypatch.setattr(bt, "_output_file", lambda task_id: tmp_path / f"{task_id}.output")
    raw = "y" * size
    shown, truncated = bt._model_stream(raw)
    assert truncated is expect_truncated
    assert (shown != raw) is expect_truncated
    assert bool(list(tmp_path.glob("*.output"))) is expect_truncated
```

### P0-3 tree-kill 的兜底路径与“不许再挂死”约定零覆盖

**位置**：L94-102。
**理由**：`subprocess.run` 被 mock 成成功返回，因此 L176-180 的 `except Exception: os.kill(pid, 9)` 从未执行 —— 而它就是“taskkill 不可用”时唯一的止损点（源码注释：Windows 上 `Popen.kill()` 不杀子进程会让 `communicate()` 挂死数分钟）。另外 `capture_output=True, timeout=8` 是“kill 路径自身不许再死锁”的约定，无人守。现有 `assert "/T" in args` 与 `args[:4] == [...]` 语义重叠，可收敛成完整列表等值。`pid <= 0` 的 early return 也应覆盖。

**写法示例（替换 L94-102）**：

```python
@pytest.mark.skipif(sys.platform != "win32", reason="Windows tree-kill path")
def test_kill_process_tree_invokes_taskkill() -> None:
    with patch("evoflow.tools.zcode_port.bash_tool.subprocess.run") as run:
        run.return_value = None
        bt._kill_process_tree(4242)
    args, kwargs = run.call_args
    assert args[0] == ["taskkill", "/PID", "4242", "/F", "/T"]
    assert kwargs.get("capture_output") is True
    assert kwargs.get("timeout") == 8        # kill 路径自身有超时，不许再死锁


@pytest.mark.skipif(sys.platform != "win32", reason="Windows tree-kill path")
def test_kill_process_tree_falls_back_to_os_kill() -> None:
    with patch(
        "evoflow.tools.zcode_port.bash_tool.subprocess.run",
        side_effect=OSError("taskkill not found"),
    ), patch("evoflow.tools.zcode_port.bash_tool.os.kill") as kill:
        bt._kill_process_tree(4242)
    kill.assert_called_once_with(4242, 9)


@pytest.mark.parametrize("pid", [0, -1, -4242])
def test_kill_process_tree_ignores_non_positive_pid(pid: int) -> None:
    with patch("evoflow.tools.zcode_port.bash_tool.subprocess.run") as run:
        bt._kill_process_tree(pid)
    run.assert_not_called()
```

> `OSError` 是 `Exception` 子类，可命中 `except Exception`；`bash_tool.py` 为 `import os` 后属性访问，`patch("...bash_tool.os.kill")` 与 `patch("os.kill")` 等价。

---

## P1（高价值新增覆盖：当前完全无对应用例）

| # | 建议新增用例 | 理由（对应源码位置 / 行为） |
|---|---|---|
| P1-1 | `test_bash_shell_prefers_real_bash_over_windowsapps_stub` | `bash_shell()`（约 L193 起）显式注释“WindowsApps `bash.exe` 是假 shell，要 Git 的 `bin/bash.exe`”，平台陷阱且零覆盖 |
| P1-2 | `test_semantic_timeout_clamps_and_defaults`（参数化） | `_semantic_timeout` 的 `max(1, min(parsed, MAX_BASH_TIMEOUT_MS))` 钳位与 `None/""/非数字 → DEFAULT_TIMEOUT_MS`，是超时链路入口 |
| P1-3 | `test_stale_hint_only_after_write_command`（参数化） | `_stale_hint_for`（L488-493）用 `_WRITE_COMMAND_RE` 门控：`git status` 必须不提示，`ruff format`/`black`/`sed -i` 必须提示。现用例只测了 `read_file_state` 本体 |
| P1-4 | `test_format_finished_envelope` | `_format_finished`（L496-517）产出模型直接读到的字符串：`status: timed_out` / `stdoutTruncated: true`（小写）/ `interrupted:` 无测试，格式漂移会污染模型输入 |
| P1-5 | `test_model_stream_uses_utf8_byte_budget` | `_model_stream` 用 `_utf8_len`；中文 10000 字 = 30000 字节，恰好触达上限而字符数远小于 30000 |
| P1-6 | `test_effective_timeout_tolerates_non_str_command` | `str(command or "").strip()`：`None`/`0` 命令走隐式分支不得抛异常 |
| P1-7 | `test_preview_first_prefers_newline_boundary` | `_preview_first`（L111-116）在 `newline > max_chars * 0.5` 时回退到换行，避免截断半个 token；分支多无测试 |

**写法示例（P1-1 / P1-2 / P1-3 / P1-4）**：

```python
def test_bash_shell_prefers_real_bash_over_windowsapps_stub(monkeypatch, tmp_path) -> None:
    stub = tmp_path / "WindowsApps" / "bash.exe"
    real = tmp_path / "Git" / "bin" / "bash.exe"
    for path in (stub, real):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")

    monkeypatch.setattr(bt.shutil, "which", lambda name: str(stub))
    monkeypatch.setattr(bt, "_BASH_CANDIDATES", [stub, real], raising=False)  # 若实现暴露候选列表
    shell = bt.bash_shell()
    # 黑盒兜底断言：任何情况下都不得把 WindowsApps stub 当作 shell
    assert shell is None or "WindowsApps" not in " ".join(shell)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, 120_000),
        ("", 120_000),
        ("abc", 120_000),
        ("0", 1),
        ("-5", 1),
        ("15000", 15_000),
        ("15000.7", 15_000),
        (600_001, 600_000),
    ],
    ids=["none", "empty", "nan-str", "zero", "negative", "int-str", "float-str", "over-max"],
)
def test_semantic_timeout_clamps_and_defaults(value: object, expected: int) -> None:
    assert bt.DEFAULT_TIMEOUT_MS == 120_000
    assert bt.MAX_BASH_TIMEOUT_MS == 600_000
    assert bt._semantic_timeout(value) == expected


@pytest.mark.parametrize(
    ("command", "expect_hint"),
    [
        ("git status --short", False),
        ("ls -la", False),
        ("npm install", False),                 # 非只读但不命中写命令白名单
        ("ruff format .", True),
        ("black pkg/", True),
        ("sed -i 's/a/b/' f.py", True),
        ("cargo fmt", True),
    ],
    ids=["status", "ls", "npm", "ruff-format", "black", "sed-i", "cargo-fmt"],
)
def test_stale_hint_only_after_write_command(
    isolated_read_state, tmp_path, command: str, expect_hint: bool
) -> None:
    target = tmp_path / "watched.txt"
    target.write_text("a", encoding="utf-8")
    isolated_read_state.note_read(str(target))
    later = target.stat().st_mtime + 5
    os.utime(target, (later, later))

    hint = bt._stale_hint_for(command)
    if expect_hint:
        assert "changed on disk" in hint
        assert str(target.resolve()) in hint
    else:
        assert hint == ""


def test_format_finished_envelope(tmp_path, persisted_output_dir) -> None:
    ok = bt._format_finished(command="ls", stdout="a\n", stderr="", exit_code=0, timed_out=False)
    assert ok.startswith("status: completed\nexitCode: 0\ninterrupted: false\n")
    assert "stdoutTruncated: false" in ok and "stderrTruncated: false" in ok
    assert "stdout:\na\n" in ok

    failed = bt._format_finished(command="ls", stdout="", stderr="boom", exit_code=2, timed_out=False)
    assert failed.startswith("status: failed\nexitCode: 2")

    timed_out = bt._format_finished(command="sleep 1", stdout="p", stderr="", exit_code=-1, timed_out=True)
    assert timed_out.startswith("status: timed_out\ninterrupted: true\n")
    assert "stdoutTruncated" not in timed_out     # 超时分支不报 truncated 字段

    big = bt._format_finished(
        command="ls",
        stdout="z" * (bt.MAX_INLINE_BYTES + 1),
        stderr="",
        exit_code=0,
        timed_out=False,
    )
    assert "stdoutTruncated: true" in big
    assert "stderrTruncated: false" in big
```

> P1-1 依赖 `bash_shell` 的候选列表实现；若内部不可注入，退化为“只断言返回值不含 `WindowsApps`、且 `Path(shell[-1]).name == 'bash.exe'`”的黑盒断言即可，关键是让这条平台陷阱进入回归。

---

## P2（参数化 / 去重 / 可维护性）

### P2-1 probe 正则表 + 超时链路共用一张“契约表”

**理由**：`test_probe_command_detection` 的表格是现状快照（上游判断正确），且 `_PROBE_COMMAND_RE` 与 `_effective_timeout_ms` 的 probe 分支是同一事实的两处测试、各自维护。源码正则里存在但**完全无覆盖**的成员：`git diff|branch|rev-parse|show|remote|tag`、`Set-Location`、`dir/pwd/echo/true/false/whoami/uname`、多段 `cd a && cd b`、`;` 分隔、大写 `GIT STATUS`（`(?is)`）；反例缺口：`lsblk`、`directory`（`\b` 边界）、`npm test -- --grep login`。合并成一张表后，P0-1 的 30s 硬编码也有了唯一来源。

```python
PROBE_CASES = [
    ("git status --short", True),
    ("git -C 'D:/repo' log --oneline -5", True),
    ("git diff --stat", True),
    ("git rev-parse HEAD", True),
    ("git remote -v", True),
    ("cd D:/dev/github/EvoFlow && ls -la", True),
    ("cd a && cd b && git branch", True),
    ("Set-Location D:/repo; git status", True),
    ("cd D:/repo && git status --short | head -30", True),
    ("GIT STATUS", True),
    ("lsblk", False),
    ("directory", False),
    ("npm install", False),
    ("pytest -q", False),
    ("npm test -- --grep login", False),
]


@pytest.mark.parametrize(("command", "is_probe"), PROBE_CASES,
                         ids=[f"{i:02d}-{c}" for i, (c, _) in enumerate(PROBE_CASES)])
def test_probe_command_detection(command: str, is_probe: bool) -> None:
    assert (bt._PROBE_COMMAND_RE.search(command) is not None) is is_probe


@pytest.mark.parametrize(("command", "is_probe"), PROBE_CASES, ids=lambda v: None)
def test_effective_timeout_follows_probe_table(command: str, is_probe: bool) -> None:
    assert bt._effective_timeout_ms(command, 120_000, explicit=False) == (30_000 if is_probe else 120_000)
    assert bt._effective_timeout_ms(command, 120_000, explicit=True) == 120_000
```

### P2-2 `_timeout_was_explicit` 参数化并补边界

**理由**：L87-91 四条断言是同一函数的输入输出，重复度高；缺 `"abc"`、`" 15000 "`（`str.strip()` 后可解析）、`15000.0`、`0` 等边界。

```python
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, False),
        ("", False),
        ("abc", False),
        (15000, True),
        ("15000", True),
        (" 15000 ", True),
        (15000.0, True),
        (0, True),
    ],
)
def test_timeout_was_explicit(value: object, expected: bool) -> None:
    assert bt._timeout_was_explicit(value) is expected
```

### P2-3 模块级 fixture 收敛样板代码

**理由**：`read_file_state` 的三次函数内 import（L59-63）、`os`/`time` 函数内 import（L68-69）是重复样板；`_output_file` monkeypatch 在 P0-2 新增用例里还会再出现。

```python
@pytest.fixture
def isolated_read_state():
    from evoflow.tools.zcode_port import read_file_state

    read_file_state.reset_read_state()
    yield read_file_state
    read_file_state.reset_read_state()      # teardown 同样关键，避免污染其它用例


@pytest.fixture
def persisted_output_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(bt, "_output_file", lambda task_id: tmp_path / f"{task_id}.output")
    return tmp_path
```

同时把 `import os` / `import time` 提到文件头（PEP8），`sys`/`patch`/`pytest` 保持现状。

### P2-4 全局读状态泄漏守卫

**理由**：L65-66 的注释已承认全局注册表会被其它测试污染；`tests/test_bash_readonly_policy.py::test_read_state_stale_hint_still_works`（L133）同样 `note_read` 同一张表 —— 两文件任意执行顺序都应有确定结果。用 P2-3 的 fixture 统一，并补一条“重置后为空”的断言，锁住污染方向。

```python
def test_stale_hint_empty_after_reset(isolated_read_state) -> None:
    assert isolated_read_state.stale_read_hint() == ""
```

### P2-5 parametrize `ids` 可读性

**理由**：命令字符串含引号/管道/空格时，`-k` 过滤与失败报告可读性差。建议统一 `ids=` 或 `pytest.param(..., id="cd-and-git-status-pipe-head")`，平台用例（P0-3）同样适用。

---

## 落地顺序与自检

1. P0-1 / P0-2 / P0-3（3 处小改，预计 < 60 行 diff）；
2. P1-2 / P1-4 / P1-5（纯新增，无外部依赖，可先跑通）；
3. P2-1 合并 probe 表（一次性替换 L16-37 与 L32-37）；
4. P2-3 / P2-4 fixture 收敛 + P2-2 参数化。

验证（只运行测试，不改源码）：

```bash
cd backend && python -m pytest tests/test_bash_tool_timeout.py -q
```

**变异抽查**（确认新断言真的会红，验证后立即还原）：

- 把 `PROBE_TIMEOUT_MS` 默认值改成 `600000` → P0-1 必须失败；
- 把 `ASSISTANT_BLOCKING_BUDGET_MS` 改成 `120000` → P0-1 必须失败；
- 把 `_model_stream` 的 `<=` 改成 `<` → P0-2 的 `at-limit-inline` 必须失败；
- 把 `_preview_first` 的 `max_chars` 换成 `_utf8_len(raw)` → P0-2 的预览预算断言必须失败；
- 删掉 `_kill_process_tree` 里的 `except Exception: os.kill` → P0-3 兜底用例必须失败。

覆盖度预估：现文件 13 个实例集中在 5 个纯函数；按上述建议可增至约 40 个实例，并首次覆盖 `_semantic_timeout`、`_stale_hint_for`、`_format_finished`、`_preview_first`、`bash_shell`、`_kill_process_tree` 兜底分支。
