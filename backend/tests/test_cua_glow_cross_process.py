"""CUA glow state 必须**跨进程**可见（2026-11-19 · 第73轮）。

## 这个测试守的是什么缺陷

用户原话：「工具已经在操作的时候，为什么我没有看到蓝光呢 因为我已经看到有 Word 在打开了」

现网取证（今日 `logs/plugin-control.log`）：

- 面板同时拉起**两个 python 进程**：
  - `--mode langgraph --langgraph-port 8384` ← agent 真在这里跑，CUA cell 也在这里
    执行 ⇒ `pulse_cua_glow_start()` 写的是**这个进程的内存**
  - `--mode gateway --port 8382` ← 前端轮询 `GET /api/cua/glow-status` 打到这里
    ⇒ 读的是**另一个进程的内存**
- 而 `cua_glow_state` 原来是一组纯进程内全局变量，两边各一份、互不可见。

数字对照（同一天、同一份日志）：

- 后端 `[py] emit request_active=True`：**186 次**（真实 CUA，`tool_call_id=call_xxx`）
- 前端 `[web] poll active=true`：**只有 7 次**，且 `keys` 全是我 curl 打的探针
  （`verify-71` / `PROBE-FWD-9001`）——**一次都没读到真实的 `call_xxx`**。

结论：不是接口坏了（curl POST 8382 再 GET 8382 能读到），是**写方与读方不在同一进程**。

## 反向验证（两次，都做过）

1. `rm` 掉共享文件 → 子进程读到 `active=False`；
2. `_sync_locked = lambda: None` → 子进程读到 `active=False`。
   两次都证明「文件同步」是唯一通路，不是内存态巧合。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from evoflow.collab import cua_glow_state as cgs


@pytest.fixture()
def shared_file(tmp_path, monkeypatch):
    """每个用例一个独立共享文件 —— 绝不能碰用户正在跑的真实状态。"""
    path = tmp_path / "cua_glow_state.json"
    monkeypatch.setenv("EVOFLOW_CUA_GLOW_STATE_FILE", str(path))
    # 模块级缓存要跟着换文件，否则沿用上一个用例的 key/文本。
    cgs._LAST_LOAD["key"] = None
    cgs._LAST_SAVED["text"] = None
    cgs.clear_cua_glow()
    yield path


def _run_in_fresh_process(code: str, shared: Path) -> dict:
    """在**真正的新进程**里执行代码并回传 JSON。

    必须用子进程：同进程调两次函数无法暴露「两个进程各有一份内存」这个缺陷 ——
    这正是我上一轮自测假绿的原因（函数层全绿，接线层根本不通）。
    """
    harness = Path(__file__).resolve().parents[1] / "packages" / "harness"
    env = dict(os.environ)
    env["PYTHONPATH"] = str(harness) + os.pathsep + env.get("PYTHONPATH", "")
    env["EVOFLOW_CUA_GLOW_STATE_FILE"] = str(shared)
    env.pop("PYTEST_CURRENT_TEST", None)  # 子进程要当"正式运行"，别走测试临时文件分支
    proc = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    assert proc.returncode == 0, f"child failed:\n{proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.strip().splitlines()[-1])


def test_write_in_one_process_visible_in_another(shared_file):
    """A 进程写 CUA 活动 → B 进程（全新解释器）必须读到同样的 active/step。"""
    cgs.pulse_cua_glow_start(key="call_WORD_001")
    cgs.set_cua_glow_step("打开 Word 文档")
    cgs.set_cua_glow_thread("tid-aaa", "agent:main:word")

    other = _run_in_fresh_process(
        """
        import json
        from evoflow.collab.cua_glow_state import get_cua_glow_status
        print(json.dumps(get_cua_glow_status(), ensure_ascii=False))
        """,
        shared_file,
    )

    assert other["active"] is True, "另一进程读不到 active —— 跨进程同步失效（用户看不到蓝光）"
    assert other["running"] == 1
    assert other["step"] == "打开 Word 文档"
    assert other["steps_done"] == 1
    assert other["session_key"] == "agent:main:word"


def test_clear_in_one_process_hides_in_another(shared_file):
    """A 进程收工 → B 进程必须立刻看到 active=False（否则蓝光环永远不灭）。

    【self-evolution-bot · 2026-11-19 · 第73轮】第一版写错了：只断言「清完之后
    子进程 active 是 False」。反向验证时把 `_sync_locked()` 整个禁掉，这条**照样绿**
    —— 因为子进程内存本来就是空的，默认就 False。这是典型的「断言了默认值」，
    等于没测。修法：先让子进程读一次**确认它是 True**（证明它真在同步），
    再清掉、再读一次确认变 False。两次读数才算证明「同步这条通路在工作」。
    """
    cgs.pulse_cua_glow_start(key="call_X")
    assert cgs.get_cua_glow_status()["active"] is True

    read = (
        """
        import json
        from evoflow.collab.cua_glow_state import get_cua_glow_status
        print(json.dumps(get_cua_glow_status(), ensure_ascii=False))
        """
    )
    before = _run_in_fresh_process(read, shared_file)
    assert before["active"] is True, "清场前子进程就该读到 active —— 否则下面那条 False 是默认值假绿"

    cgs.clear_cua_glow()

    after = _run_in_fresh_process(read, shared_file)
    assert after["active"] is False
    assert after["running"] == 0


def test_revoke_in_gateway_blocks_cua_in_runtime_process(shared_file):
    """「解除控制」由网关进程写、由运行时进程拦 —— 两者必须共享这一位。

    真实链路：前端点按钮 → `POST /api/cua/control/revoke`（**gateway 进程**）
    → `node_repl_tool._run` 里 `_cua_control_revoked()`（**langgraph 进程**）。
    不走文件同步的话，用户点了按钮 AI 照样继续动鼠标。
    """
    cgs.revoke_cua_control(session_key="agent:main:revoketest", reason="user_revoked")

    other = _run_in_fresh_process(
        """
        import json
        from evoflow.collab.cua_glow_state import get_cua_glow_status, is_cua_control_revoked
        print(json.dumps({
            "status": get_cua_glow_status(),
            "blocked": is_cua_control_revoked(session_key="agent:main:revoketest"),
        }, ensure_ascii=False))
        """,
        shared_file,
    )

    assert other["status"]["control_revoked"] is True
    assert other["blocked"] is True, "另一进程没看到收回标记 —— 解除控制会失效"


def test_tests_never_touch_real_state_file():
    """用例必须走临时文件，不能清掉用户正在跑的 CUA 提示条。

    现有 5 个 CUA 测试文件都以 `clear_cua_glow()` 开头，若落到真实路径，
    跑一次单测就会把用户屏幕上的提示条/蓝光环清掉。
    """
    real = Path.home() / ".evoflow" / "profiles" / "default" / "data" / "app" / "cua_glow_state.json"
    assert cgs._state_file().resolve() != real.resolve()
