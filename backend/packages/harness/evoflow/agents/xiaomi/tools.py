"""小V工具挂载：系统 ``platform``（名册/看板/简报/派活/催办/知识库/行政/ui.show 同源）
+ ``bash``（终端）+ ``read``（只读文件）+ ``assets``（记忆/用户画像/经验读写，
仍受会话记忆开关门控）。

旧专用工具已迁入 ``platform``：
``employees.org_status`` / ``employees.board_overview`` / ``employees.brief`` /
``employees.dispatch`` / ``employees.wake`` / ``tasks.get`` / ``knowledge.search``。
"""

from __future__ import annotations


def get_xiaomi_tools() -> list:
    from evoflow.sandbox.tools import read_file_tool
    from evoflow.tools.builtins.assets_tool import assets_tool
    from evoflow.tools.builtins.platform_tool import platform_tool

    return [platform_tool, read_file_tool, assets_tool]
