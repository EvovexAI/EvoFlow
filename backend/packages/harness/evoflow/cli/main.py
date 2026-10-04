"""EvoFlow CLI — manage models, skills, agents, MCP, memory, experience, and more."""

from __future__ import annotations

import argparse
import importlib
import sys

from evoflow.cli.common import run_handler


# 子命令名 → commands 模块名。
# 修复依据：此前 main.py 模块级全量 import 20 个 commands 模块，agents.py 等的
# 模块级 `from evoflow.admin import ...` 链条一路拉起 langchain → torch →
# transformers（实测 importtime：torch ≈0.92s、transformers ≈0.67s），导致仅跑
# `evoflow models list` 这类轻命令也要付 ~2.7s 冷启动。改为按需 import 单个
# command 模块后，多数命令不再加载 torch/transformers。
# commands/__init__.py 为空包，无转发依赖，可安全绕过。
_COMMAND_MODULES: dict[str, str] = {
    "app-server": "app_server",
    "models": "models",
    "skills": "skills",
    "agents": "agents",
    "employees": "employees",
    "org": "org",
    "approvals": "approvals",
    "mcp": "mcp",
    "memory": "memory",
    "assets": "assets",
    "experience": "experience",
    "knowledge": "knowledge",
    "automation": "automation",
    "sessions": "sessions",
    "tasks": "tasks",
    "workflow": "workflow",
    "items": "items",
    "workspace": "workspace",
    "eval": "eval_cmd",
    "logs": "logs",
}


def _peek_command(argv: list[str]) -> str | None:
    """预扫描首个子命令名（跳过 --config PATH 与其他选项），用于按需 import。"""
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == "--config":
            i += 2  # 跳过 PATH 值
            continue
        if token.startswith("-"):
            i += 1
            continue
        return token
    return None


def build_parser(commands: list[str] | None = None) -> argparse.ArgumentParser:
    """构建 CLI parser。

    commands 为 None 时注册全部子命令（库内复用场景）；
    传入目标子命令列表时仅按需 import 对应模块，其余不加载。
    """
    parser = argparse.ArgumentParser(
        prog="evoflow",
        description=("EvoFlow admin CLI — models, skills, agents, employees, workflow, items, knowledge, experience, automation, memory, eval, …"),
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="Path to config.yaml (sets EVOFLOW_CONFIG_PATH for this process)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    targets = commands if commands is not None else list(_COMMAND_MODULES)
    for command in targets:
        module_name = _COMMAND_MODULES.get(command)
        if module_name is None:
            continue
        module = importlib.import_module(f"evoflow.cli.commands.{module_name}")
        module.register(subparsers)
    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    command = _peek_command(argv)
    # 仅注册目标子命令；help/无参/未知命令时不注册任何模块，避免全量 import 拉起 torch。
    args = build_parser([command] if command in _COMMAND_MODULES else []).parse_args(argv)
    if args.config:
        import os

        os.environ["EVOFLOW_CONFIG_PATH"] = args.config
        from evoflow.config.app_config import reload_app_config

        reload_app_config(args.config)
    handler = getattr(args, "handler", None)
    if handler is None:
        build_parser([]).print_help()
        return 2
    return run_handler(handler, args)


if __name__ == "__main__":
    sys.exit(main())
