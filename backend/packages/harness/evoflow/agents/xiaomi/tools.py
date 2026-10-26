"""小V工具挂载：只挂系统 ``platform``（名册/看板/简报/派活/催办/知识库/行政同源）。

旧专用工具已迁入 ``platform``：
``employees.org_status`` / ``employees.board_overview`` / ``employees.brief`` /
``employees.dispatch`` / ``employees.wake`` / ``tasks.get`` / ``knowledge.search``。
"""

from __future__ import annotations


def get_xiaomi_tools() -> list:
    from evoflow.tools.builtins.platform_tool import platform_tool

    return [platform_tool]
