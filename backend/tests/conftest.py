"""Test configuration for the backend test suite.

Sets up sys.path and pre-mocks modules that would cause circular import
issues when unit-testing lightweight config/registry code in isolation.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

# Make 'app' and 'evoflow' importable from any working directory
_backend_root = Path(__file__).parent.parent
sys.path.insert(0, str(_backend_root))
# evoflow package lives in packages/harness (editable install also exposes it)
sys.path.insert(0, str(_backend_root / "packages" / "harness"))

# Break the circular import chain that exists in production code:
#   evoflow.subagents.__init__
#     -> .executor (SubagentExecutor, SubagentResult)
#       -> evoflow.agents.thread_state
#         -> evoflow.agents.__init__
#           -> lead_agent.agent
#             -> subagent_limit_middleware
#               -> evoflow.subagents.executor  <-- circular!
#
# By injecting a mock for evoflow.subagents.executor *before* any test module
# triggers the import, __init__.py's "from .executor import ..." succeeds
# immediately without running the real executor module.
_executor_mock = MagicMock()
_executor_mock.SubagentExecutor = MagicMock
_executor_mock.SubagentResult = MagicMock
_executor_mock.SubagentStatus = MagicMock
_executor_mock.MAX_CONCURRENT_SUBAGENTS = 5
_executor_mock.get_background_task_result = MagicMock()

sys.modules["evoflow.subagents.executor"] = _executor_mock

# ── 收集隔离：test_v4_bridge_e2e.py（orphaned，待其属主决策） ──────────────
# 该用例 import `app.gateway.v4.langgraph_v4_bridge`，但：
#   - 该模块在本仓库 git 历史中从不存在（git log 无记录）；
#   - 它引用的符号 HubProjectionWriter / feed_agui_events / feed_payloads_to_v4
#     在整个 app/ 下也无任何定义，只出现在该测试文件自身。
# 现存的等价模块是 app/gateway/v4/agui_to_v4_projector.py，但对外 API 不同
# （只有 _TranslatorState / translate_agui_events）。因此无法在不臆造契约的前提下
# 修复该 import——强行让收集通过只会得到一个"绿但无意义"的测试。
# 故先隔离其收集，使整体 collect 能通过；原文件原样保留，待属主确认该用例
# 所测的 v4 桥接契约（是被删了还是改名了）后再决定重写或删除。
collect_ignore = ["test_v4_bridge_e2e.py"]
# ── 全局隔离：测试绝不许写现网审计日志 ────────────────────────────────────────
# 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增 autouse fixture，把 right_stage_audit_log 的落盘目录整体指向 tmp。
# 为什么（本轮真机实测抓到的真污染）：跑完 pytest 后用户的现网
#   `~/.evoflow-dev/logs/right-stage-2026-11-21.log` 里出现 08:05:57 / 08:10:40 两批
#   `emit no-writer ... surface={"mainTaskId":"mt-ui-1"}`、`duty-ops`、`taskId":"mt-2"`
#   —— 全是测试夹具数据，不是用户的操作。成因：被测试直接调用的 apply_right_panel
#   在没有 langgraph runnable context 时走 `_emit` 的 no-writer 分支，而那条分支
#   会**照写审计日志**；而只有 4 个测试文件自己 monkeypatch 了 `_logs_dir`。
#   那份日志是排查右栏问题的核心证据，被测试灌脏就等于证据失效。
# 为什么放 conftest 而不是逐个文件补：这就是「同一规则写多处必然漂移」的现场版 ——
#   逐个文件补过一次（第101轮补了 4 个），新加的测试文件照样漏。凡属全局副作用的
#   隔离，只在收集期生效的这一处写，才没有下一次。
# 判据：任意后端测试跑完，现网 logs 目录的 mtime 与行数不得变化；
#   而 test_right_stage_audit_log.py 仍能读到自己那份（它再覆盖一次到自己的 tmp）。
import pytest as _pytest


@_pytest.fixture(autouse=True)
def _isolate_right_stage_audit_logs(tmp_path, monkeypatch):
    try:
        from evoflow.stage import right_stage_audit_log as _audit
    except Exception:  # noqa: BLE001 - 该模块不可导入时（极简环境）不影响测试
        yield
        return
    monkeypatch.setattr(_audit, "_logs_dir", lambda: tmp_path, raising=False)
    yield
