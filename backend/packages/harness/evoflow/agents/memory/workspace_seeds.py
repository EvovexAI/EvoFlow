"""Curated workspace memory seeds (no LLM) for known project layouts."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _evoflow_seed() -> dict[str, Any]:
    return {
        "standing": (
            "EvoFlow 是自主 Agent 运行时与控制平面：LangGraph 主智能体 + 中间件链 + 工具/MCP/沙箱。"
            "Python 后端在 backend/packages/harness，桌面面板 evopanel（Tauri+React）。"
            "对话记忆归 user/，项目知识归 workspace/，Agent 仅保留 SOUL/profile。"
            "配置根目录 config.yaml；用户数据 ~/.evoflow。"
        ),
        "facts": [
            {
                "slug": "backend-harness",
                "title": "backend harness 核心包",
                "summary": "Python 运行时与 Gateway",
                "category": "module",
                "content": (
                    "backend/packages/harness/evoflow/ 是核心 Python 包：主智能体（agents/lead_agent）、"
                    "工具 builtins、记忆 pipeline（assets/ + agents/memory/）、Gateway、CLI。"
                    "测试在 backend/packages/harness/tests/。"
                ),
            },
            {
                "slug": "evopanel",
                "title": "EvoPanel 桌面控制面",
                "summary": "Tauri v2 + React 面板",
                "category": "module",
                "content": (
                    "evopanel/ 为桌面应用：任务中心、智能体管理、资产中心、模型/MCP/技能配置。"
                    "前端通过 Gateway API 与 harness 通信。"
                ),
            },
            {
                "slug": "entity-hub",
                "title": "资产中心 Entity Hub",
                "summary": "user/agent/employee/workspace",
                "category": "architecture",
                "content": (
                    "资产存放在 ~/.evoflow/assets/：user/（用户画像+对话记忆）、agents/{code}/profile（SOUL）、"
                    "employees/{code}/（员工记忆+画像）、workspaces/{ws-hash}/（绑定项目的 module/logic 等事实）。"
                    "Tier-0 注入 standing + catalog；正文用 assets(read) 按需拉取。"
                ),
            },
            {
                "slug": "memory-phase2",
                "title": "记忆写入与 Phase2",
                "summary": "note → inbox → Phase2 合并",
                "category": "logic",
                "content": (
                    "对话后 MemoryMiddleware 入队 Phase1/2；ad-hoc 用 assets(note)。"
                    "项目事实 scope=workspace 或 [project] 标签；用户偏好写 user profile。"
                    "workspace 只存 module/logic/architecture/convention/gotcha/entrypoint，过滤测试与会话流水。"
                ),
            },
            {
                "slug": "dev-entrypoint",
                "title": "启动与开发入口",
                "summary": "config.yaml + Makefile",
                "category": "entrypoint",
                "content": (
                    "仓库根 config.yaml 为 EvoFlow 配置；backend/ 下 pip install -e . 安装 harness。"
                    "CLI：evoflow（models/agents/memory/assets/workspace …）。"
                    "Gateway 启动后 EvoPanel 连接本地服务。"
                ),
            },
            {
                "slug": "workspace-bind-convention",
                "title": "工作区绑定约定",
                "summary": "按项目根目录绑定",
                "category": "convention",
                "content": (
                    "会话绑定 local_workspace_root 后启用 workspace 记忆注入与写入。"
                    "应绑定具体项目根（如 EvoFlow/），不要绑定上层 monorepo 根目录，"
                    "避免把兄弟仓库误记为本项目模块。"
                ),
            },
        ],
    }


def resolve_workspace_seed(workspace_path: str) -> dict[str, Any] | None:
    """Return curated seed payload when the repo matches a known layout."""
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return None
    harness = root / "backend" / "packages" / "harness" / "evoflow"
    panel = root / "evopanel"
    if harness.is_dir() and panel.is_dir():
        return _evoflow_seed()
    return None
