"""方言路由回归测试（self-evolution-bot · 2026-11-15 · 第17轮）。

锁住的缺陷：bash 工具在 Windows 上用**原始命令文本**匹配 PowerShell cmdlet 名来选解释器，
于是「引号内的 cmdlet 字样」和「POSIX 专属的 ``&&``」都会把一条纯 bash 命令整条交给
PowerShell 5.1 执行，报出「'&&' 不是此版本中的有效运算符」这类与用户意图无关的 GBK 乱码错。
2026-11-15 一天内命中 4 次（含用 grep 查 cmdlet 名、用 heredoc 跑含 cmdlet 字样的 python）。

判据（改完之后）：
1. cmdlet 判据只看 **shell 层**文本 —— 引号内的是数据不是语法（``_strip_quoted_text``）；
2. 含 ``&&`` / ``||`` / ``/dev/null`` 的一律走 bash —— 这些在 PS 5.1 里是解析期硬错误，
   路由过去必然失败，没有任何理由优先给 PS。

反证同样重要：不带 ``&&`` 的真 PowerShell 命令必须**仍然**走 PS，否则这条修复就成了误伤。
"""

from __future__ import annotations

import importlib

import pytest

# ``zcode_port.__init__`` 把 bash_tool 重导出成 StructuredTool，会遮蔽模块本身（仓内既有做法）。
bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")

CWD = r"D:\work"


def _routes_to_ps(command: str) -> bool:
    return bt._powershell_argv(command, CWD) is not None


# 今天真炸过的 5 条形态：都是 POSIX 命令，绝不该被交给 PowerShell
BASH_CASES = [
    # grep 的模式串里有 "\|ConvertTo-Json"，竖线紧贴 cmdlet 名 → 旧判据命中
    'cd /d/repo && grep -n "watchdog-result\\|ConvertTo-Json" a.ps1',
    # cmdlet 出现在传给 powershell.exe 的**字符串参数**里，且整条带 &&
    'powershell -NoProfile -Command "$j=Get-Content a | Set-Content a" && echo done',
    "echo hi && cat f > /dev/null",
    "cd /d/x && grep -rn 'Write-Output' x.py | head",
    # cmdlet 开头但带 &&：PS 5.1 根本解析不动，给 PS 必炸
    "Get-Content a && echo done",
    # heredoc 里出现 cmdlet 字样（本轮实测被咬的那条就是这个形状）
    "python - <<'PY'\nprint(Get-Content)\nPY",
    "ls -la",
    "git status --short",
]

# 反证：真 PowerShell（cmdlet 在 shell 层、无 && / 无 /dev/null）必须仍走 PS
PS_CASES = [
    "Get-Content state.json | ConvertFrom-Json",
    'Test-Path a; Write-Output "done"',
    "$j = Get-Content a; $j | ConvertTo-Json",
    "Select-String -Pattern x -Path y",
]


@pytest.mark.parametrize("command", BASH_CASES)
def test_posix_commands_are_not_hijacked_by_powershell(command: str) -> None:
    assert not _routes_to_ps(command), f"该走 bash 却被路由到 PowerShell: {command!r}"


@pytest.mark.parametrize("command", PS_CASES)
def test_real_powershell_still_routes_to_powershell(command: str) -> None:
    assert _routes_to_ps(command), f"真 PowerShell 命令被误降级: {command!r}"


def _invariants(src: str, *, preserve_quote_count: bool = True) -> str:
    """抹掉引号内容后的共同不变量：长度不变、内容不再可见（引号仅在无转义时数量守恒）。

    注：`preserve_quote_count=False` 用于**含转义引号**的输入 —— 被转义的那个 `"` 属于字符串
    内容、本来就该被抹掉，要求数量守恒反而是错的断言（本轮先写错过一次，故显式区分）。
    """
    out = bt._strip_quoted_text(src)
    assert len(out) == len(src), (src, out)  # 只抹字符不删字符，列位置才对得上
    if preserve_quote_count:
        assert out.count('"') == src.count('"') and out.count("'") == src.count("'")
    return out


def test_strip_quoted_text_keeps_quotes_and_blanks_content() -> None:
    src = '"Get-Content x" ls'
    out = _invariants(src)
    assert "Get-Content" not in out, out
    assert out.startswith('"') and out.endswith('" ls'), out
    # shell 层的 && 必须留下，引号内的必须消失
    assert _invariants("echo 'a && b' && ls").count("&&") == 1


def test_strip_quoted_text_handles_escapes_and_unclosed_quote() -> None:
    out = _invariants(r'echo "a \" Get-Content b" ls', preserve_quote_count=False)  # 转义引号不应提前闭合
    assert "Get-Content" not in out, out
    assert out.endswith('" ls'), out
    # 未闭合引号：余下内容按引号内处理，不得抛异常
    assert "unclosed" not in _invariants('echo "unclosed Get-Content')
