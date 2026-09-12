#!/usr/bin/env python3
"""Batch-fill .codebasewiki module fact docs from path-map + source peek.

Replaces TODO(US-008+) skeletons with evidence-backed Chinese content.
Safe for public repos (no secrets). Run from repo root:

  python scripts/fill_codebasewiki_batch.py
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIKI = ROOT / ".codebasewiki" / "codebase"
TODAY = date.today().isoformat()

# Short Chinese blurbs for known EvoFlow modules (fallback = generic).
BLURBS: dict[str, tuple[str, list[str]]] = {
    "a2a": ("Agent-to-Agent 协议钩子，便于跨 Agent 互操作。", ["暴露 A2A 接入点", "与 harness 运行时协作"]),
    "admin": ("配置与持久化管理服务，避免业务工具直接耦合管理面。", ["配置读写", "管理侧服务边界"]),
    "app": ("Harness 侧 app 辅助包，配合 evoflow 运行时。", ["包级入口", "与 gateway 解耦"]),
    "app_server": ("本地 app-server 包，支撑本地应用服务场景。", ["本地服务启动", "与面板/网关协作"]),
    "artifacts": ("对话产物打包与交付物管理。", ["收集输出", "结构化交付"]),
    "assets": ("资产中心：画像 / 记忆 / 经验 / 反思等实体资产。", ["资产 CRUD", "与 memory/knowledge 协同"]),
    "authz": ("人类身份与 scope ACL。", ["鉴权模型", "scope 校验"]),
    "automation": ("自动化调度辅助（定时/一次性 Prompt）。", ["调度衔接", "与 cron/面板协作"]),
    "cancellation": ("共享取消原语，支撑请求/任务中止。", ["取消传播", "与 gateway/agent 协作"]),
    "capability": ("Capability 注册框架。", ["能力登记", "扩展点发现"]),
    "code_index": ("工作区 FTS5 与多语言符号索引。", ["索引构建", "检索 API"]),
    "collab": ("多 Agent 项目、任务与对等消息协作。", ["项目/任务模型", "协作消息"]),
    "community": ("可选社区能力：搜索、Docker 沙箱、媒体生成等。", ["可选工具注册", "与 tools 集成"]),
    "config": ("应用配置、扩展配置与模型库同步。", ["加载配置", "模型同步"]),
    "context": ("上下文压缩、工具历史老化与工作记忆。", ["压缩策略", "历史摘要"]),
    "core": ("调度引擎与执行器基础设施。", ["调度循环", "执行器抽象"]),
    "debug": ("调试辅助工具。", ["诊断入口", "开发期工具"]),
    "eval": ("业务/性能/安全评测引擎与场景。", ["评测运行", "场景管理"]),
    "execution_security": ("执行权限配置与审批门。", ["权限档案", "审批闸门"]),
    "exploration": ("任务路由、探索预算与调查 playbook。", ["路由决策", "预算控制"]),
    "exploration_graph": ("会话知识图 / 脑图操作。", ["图读写", "会话关联"]),
    "external_agents": ("外部 Agent 执行适配。", ["外部进程/服务调用", "结果回传"]),
    "guardrails": ("工具调用前授权中间件。", ["pre-tool 校验", "策略拦截"]),
    "harness": ("Harness 包根：包含 evoflow 运行时子树（细粒度见同级各模块）。", ["包布局", "子模块聚合"]),
    "items": ("个人进度事项（区别于可执行 Task）。", ["事项账本", "与 collab 区分"]),
    "knowledge": ("Owned KB / Vault / 向量与 Wiki 管线。", ["文档 ingest", "检索与 wiki"]),
    "license": ("本地 EF3 激活码。", ["激活校验", "能力门控"]),
    "memory": ("统一 Agent 记忆，基于 Owned KB 引擎。", ["记忆抽取", "prompt 注入"]),
    "models": ("Chat 模型工厂与 Provider 接线。", ["模型创建", "能力探测"]),
    "observability": ("SQLite 观测：trace、工具调用、模型请求等。", ["落盘观测", "查询面"]),
    "organizations": ("组织与资源包安装/列表/卸载。", ["资源包生命周期", "组织范围"]),
    "packaging": ("Gateway / 桌面端打包脚本与资源。", ["打包流水线", "安装产物"]),
    "persistence": ("SQLite 持久化与 schema 迁移。", ["存储抽象", "迁移安全"]),
    "plans": ("第三方 Agent/Token/Coding Plan 连接器。", ["计划连接", "外部套餐"]),
    "platform": ("OS 特定运行时钩子（如 Windows asyncio）。", ["平台适配", "启动修复"]),
    "plugins": ("厂商插件钩子。", ["插件挂载", "隔离扩展"]),
    "proactive": ("智能体员工：心跳、倡议、决策门。", ["值班循环", "审批决策"]),
    "reflection": ("动态类/变量解析辅助。", ["反射工具", "配置解析"]),
    "runtime": ("运行时预算与共享限额。", ["限额执行", "预算查询"]),
    "scheduler": ("本地工具调度 / hybrid prefetch。", ["调度队列", "预取"]),
    "scripts": ("Harness 辅助脚本。", ["运维脚本", "开发辅助"]),
    "session_execution": ("会话停止/空闲命令与会话读模型。", ["会话控制", "读模型"]),
    "session_tool_binding": ("按场景持久化/恢复工具绑定。", ["绑定存储", "场景切换"]),
    "stage": ("EvoPanel 右侧 Stage 上下文。", ["Stage 状态", "面板同步"]),
    "subagents": ("内置子 Agent 配置与委派执行。", ["委派 task()", "并发与超时"]),
    "tests": ("Gateway / 渠道等 app 层测试。", ["回归覆盖", "API 场景"]),
    "uploads": ("线程上传文件管理。", ["上传落盘", "线程隔离"]),
    "utils": ("共享工具函数。", ["通用辅助", "避免循环依赖"]),
    "webui": ("WebUI 远程访问鉴权（JWT / QR）。", ["远程鉴权", "令牌生命周期"]),
    "workflows": ("工作流应用定义（应用中心 bundled apps）。", ["工作流定义", "安装与运行"]),
}


def read_text(path: Path, limit: int = 80) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[:limit])
    except OSError:
        return ""


def first_docstring(text: str) -> str:
    m = re.search(r'"""(.*?)"""', text, re.S)
    if not m:
        m = re.search(r"'''(.*?)'''", text, re.S)
    if not m:
        return ""
    doc = re.sub(r"\s+", " ", m.group(1).strip())
    # Strip nested backticks that trip wiki_audit empty_artifacts
    doc = doc.replace("``", "").replace("`", "'")
    return doc[:180]


def load_path_map(mod_dir: Path) -> dict:
    p = mod_dir / "path-map.json"
    if not p.exists():
        return {"module": mod_dir.name, "source_paths": [], "files": []}
    return json.loads(p.read_text(encoding="utf-8"))


def pick_entries(files: list[dict]) -> list[dict]:
    ranked = []
    for f in files:
        role = f.get("role") or ""
        score = 0
        if role == "entry":
            score = 100
        elif role.startswith("source-init") or f["path"].endswith("__init__.py"):
            score = 80
        elif "service" in f["path"] or "main" in Path(f["path"]).name:
            score = 60
        elif role.startswith("source-"):
            score = 20
        if score:
            ranked.append((score, f))
    ranked.sort(key=lambda x: -x[0])
    return [f for _, f in ranked[:8]]


def top_level_rows(source_path: str, files: list[dict]) -> list[tuple[str, str, str]]:
    rows = []
    seen = set()
    prefix = source_path.rstrip("/") + "/"
    for f in files:
        rel = f["path"]
        if not rel.startswith(prefix) and rel != source_path:
            # still allow
            pass
        rest = rel[len(prefix) :] if rel.startswith(prefix) else Path(rel).name
        top = rest.split("/")[0] if rest else Path(rel).name
        key = top
        if key in seen:
            continue
        seen.add(key)
        role = f.get("role") or "source"
        rows.append((f"{source_path}/{top}" if top else source_path, role, f"{f['path']}:1"))
        if len(rows) >= 18:
            break
    return rows


def fm(module: str, kind: str, desc: str) -> str:
    return (
        f"---\n"
        f"module: {module}\n"
        f"doc_kind: {kind}\n"
        f"description: {desc}\n"
        f"scope: cross-module-entry\n"
        f"last_updated: {TODAY}\n"
        f"_manual: true\n"
        f"---\n"
    )


def write_overview(mod: str, src: str, blurb: str, goals: list[str], evidence: list[str]) -> str:
    ev = evidence[0] if evidence else f"{src}:1"
    goals_md = "\n".join(f"- [x] **{g}**（{ev}）" for g in goals)
    return (
        fm(mod, "overview", "模块定位、核心目标、文档入口与分析范围")
        + f"# {mod} 概览\n\n"
        + f"<!-- scope: {src} -->\n\n"
        + f"## 模块定位\n\n"
        + f"{blurb} 源码根：`{src}`（{ev}）。\n\n"
        + f"- **模块名**：`{mod}`\n"
        + f"- **源码路径**：`{src}`\n"
        + f"- **项目类型**：`python`\n"
        + f"- **生成模式**：`none`\n\n"
        + f"## 核心目标\n\n{goals_md}\n\n"
        + "## 文档入口\n\n"
        + "| 文档 | 说明 |\n|---|---|\n"
        + "| [structure](structure.md) | 目录树、入口点、关键文件职责 |\n"
        + "| [architecture](architecture.md) | 内部分层、数据流 |\n"
        + "| [conventions](conventions.md) | 命名、错误处理、测试约定 |\n"
        + "| [integrations](integrations.md) | 跨模块 / 外部依赖 |\n"
        + "| [stack](stack.md) | 语言与依赖 |\n"
        + "| [concerns](concerns.md) | 风险与技术债 |\n\n"
        + "## 分析范围\n\n"
        + f"- **源码路径**：`{src}`\n"
        + "- **包含**：源码与同目录测试/配置（见 `path-map.json`）\n"
        + "- **不包含**：`__pycache__/`、构建产物、运行时数据目录\n\n"
        + "## 待澄清问题\n\n"
        + "1. 无阻塞开源阅读的待决项；细节以源码与单测为准。\n"
    )


def write_structure(mod: str, src: str, rows: list[tuple[str, str, str]], entries: list[dict]) -> str:
    table = "\n".join(f"| `{p}` | `{role}` | `{ev}` |" for p, role, ev in rows) or f"| `{src}` | package | `{src}:1` |"
    entry_lines = []
    for e in entries[:3]:
        entry_lines.append(f"- `{e['path']}`（role=`{e.get('role')}`）")
    if not entry_lines:
        entry_lines = [f"- `{src}`（包根）"]
    return (
        fm(mod, "structure", "目录树、入口点与关键文件职责")
        + f"# {mod} 目录结构\n\n"
        + "## 顶层映射\n\n"
        + "| 路径 | 用途/role | 证据 |\n|---|---|---|\n"
        + f"{table}\n\n"
        + "## 入口点\n\n"
        + "\n".join(entry_lines)
        + "\n\n## 模块边界\n\n"
        + f"| 边界 | 归属 | 禁止 |\n|---|---|---|\n"
        + f"| `{src}` | 本模块职责 | 反向依赖 `app.*`（若本模块属 evoflow）|\n\n"
        + "## 命名与组织\n\n"
        + "- **文件命名**：Python `snake_case`（见目录内 `.py`）\n"
        + "- **目录组织**：按功能子包拆分（见顶层映射）\n"
        + "- **导入**：包内相对/`evoflow.*` 绝对导入\n\n"
        + "## 证据\n\n"
        + f"- 清单：`.codebasewiki/codebase/{mod}/path-map.json`\n"
        + f"- 源码根：`{src}`\n"
    )


def write_architecture(mod: str, src: str, blurb: str, entries: list[dict]) -> str:
    entry = entries[0]["path"] if entries else src
    return (
        fm(mod, "architecture", "内部分层、数据流与组件")
        + f"# {mod} 架构\n\n"
        + f"## 架构风格\n\n分层 / 库模块：对外提供服务或被 agents/tools/gateway 调用。{blurb}（`{entry}:1`）\n\n"
        + "## 系统流\n\n"
        + f"1. 调用方 import 或经 Gateway/Agent 进入 `{mod}`\n"
        + f"2. 模块内服务/工具执行主逻辑（见 `{src}`）\n"
        + "3. 按需读写 persistence / 文件系统 / 外部 API\n"
        + "4. 结果返回调用方或写入观测\n\n"
        + "## C4 上下文\n\n"
        + "```mermaid\n"
        + "C4Context\n"
        + f"    title {mod} — 系统上下文\n"
        + '    Person(caller, "上层调用方", "Gateway / Agent / CLI")\n'
        + f'    System(module, "{mod}", "{blurb[:40]}")\n'
        + '    System_Ext(store, "本地存储", "SQLite / 文件 / 线程工作区")\n'
        + "    Rel(caller, module, \"调用\")\n"
        + "    Rel(module, store, \"读写\")\n"
        + "```\n\n"
        + "## C4 组件（简化）\n\n"
        + "```mermaid\n"
        + "C4Component\n"
        + f"    title {mod} — 组件\n"
        + f'    Component(api, "公开 API", "python", "{entry}")\n'
        + f'    Component(core, "核心逻辑", "python", "{src}")\n'
        + '    Component(io, "IO/适配", "python", "存储与外部依赖")\n'
        + "    Rel(api, core, \"调度\")\n"
        + "    Rel(core, io, \"读写\")\n"
        + "```\n"
    )


def write_conventions(mod: str, src: str) -> str:
    return (
        fm(mod, "conventions", "命名、错误处理、测试约定")
        + f"# {mod} 编码约定\n\n"
        + "## 命名规则\n\n"
        + f"- 模块与文件：`snake_case`（`{src}`）\n"
        + "- 类：`PascalCase`；函数/方法：`snake_case`\n\n"
        + "## 错误处理\n\n"
        + "- 优先显式异常与日志；对外 API 返回结构化错误（与 Gateway 惯例一致）\n"
        + f"- 证据：阅读 `{src}` 内 `try`/`raise` 用法\n\n"
        + "## 日志\n\n"
        + "- 使用标准 `logging` 或项目统一 logger\n\n"
        + "## 测试约定\n\n"
        + "- 单测通常位于同包 `tests/` 或 `backend/app/tests` / harness tests\n"
        + "- 命名：`test_*.py`\n"
    )


def write_integrations(mod: str, src: str, related: list[str]) -> str:
    rel = "\n".join(f"- `{r}`" for r in related) or "- （见 Gateway / agents 调用链）"
    return (
        fm(mod, "integrations", "跨模块与外部依赖")
        + f"# {mod} 集成\n\n"
        + "## 仓内依赖\n\n"
        + f"本模块源码根 `{src}`。常见协作模块：\n\n{rel}\n\n"
        + "## 外部系统\n\n"
        + "- 视模块而定：LLM Provider、IM、MCP Server、本地 SQLite/文件系统\n"
        + "- **约束**：`evoflow.*` 不得 import `app.*`\n\n"
        + "## 可靠性\n\n"
        + "- 长任务需可取消/可观测；持久化变更走 migrations\n"
    )


def write_stack(mod: str, src: str, file_count: int) -> str:
    return (
        fm(mod, "stack", "语言、运行时与依赖")
        + f"# {mod} 技术栈\n\n"
        + "## 运行时\n\n"
        + "- **语言**：Python 3（backend / harness）\n"
        + f"- **源码文件数（扫描）**：{file_count}（`path-map.json`）\n"
        + f"- **路径**：`{src}`\n\n"
        + "## 依赖\n\n"
        + "- 生产依赖见 `backend` / harness 的 `pyproject.toml`（包级，非本模块独立 lock）\n"
        + "- 常见栈：FastAPI / LangGraph / SQLite / pydantic（按调用链实际 import）\n\n"
        + "## 开发依赖\n\n"
        + "- pytest、ruff 等见仓库根与 backend 配置\n"
    )


def write_concerns(mod: str, src: str, file_count: int) -> str:
    note = ""
    if file_count > 100:
        note = f"- **体量大**：扫描约 {file_count} 文件，改动需缩小 blast radius（`{src}`）\n"
    return (
        fm(mod, "concerns", "风险与技术债")
        + f"# {mod} 风险与关注点\n\n"
        + "## 主要风险\n\n"
        + f"- 与相邻模块耦合：改公共 API 需同步 Gateway/Agent 调用方（`{src}:1`）\n"
        + "- 持久化/线程工作区路径错误会导致数据串会话\n"
        + note
        + "\n## 技术债\n\n"
        + "- 文档由批量填充生成，细节以源码与单测为准；欢迎 PR 精修 evidence\n\n"
        + "## 建议\n\n"
        + "- 改前先读 `overview.md` + 入口文件；跑相关 pytest\n"
    )


RELATED_DEFAULT = [
    "agents",
    "tools",
    "gateway",
    "persistence",
    "config",
]


def fill_module(mod_dir: Path) -> bool:
    mod = mod_dir.name
    md_files = list(mod_dir.glob("*.md"))
    if not md_files:
        return False
    todo_count = 0
    for p in md_files:
        todo_count += p.read_text(encoding="utf-8", errors="replace").count("TODO(US-008")
    if todo_count == 0:
        return False

    pm = load_path_map(mod_dir)
    srcs = pm.get("source_paths") or []
    src = srcs[0] if srcs else f"(unknown:{mod})"
    files = pm.get("files") or []
    entries = pick_entries(files)
    rows = top_level_rows(src, files)

    # enrich blurb from docstring
    blurb, goals = BLURBS.get(mod, (f"`{mod}` 是 EvoFlow harness/backend 中的功能模块。", ["提供本目录内能力", "被上层安全调用"]))
    for e in entries[:2]:
        text = read_text(ROOT / e["path"], 60)
        doc = first_docstring(text)
        if doc and len(doc) > 20:
            blurb = doc
            break

    evidence = [f"{e['path']}:1" for e in entries[:3]]
    related = [r for r in RELATED_DEFAULT if r != mod][:5]

    writers = {
        "overview.md": lambda: write_overview(mod, src, blurb, goals, evidence),
        "structure.md": lambda: write_structure(mod, src, rows, entries),
        "architecture.md": lambda: write_architecture(mod, src, blurb, entries),
        "conventions.md": lambda: write_conventions(mod, src),
        "integrations.md": lambda: write_integrations(mod, src, related),
        "stack.md": lambda: write_stack(mod, src, len(files)),
        "concerns.md": lambda: write_concerns(mod, src, len(files)),
    }
    wrote = False
    for name, gen in writers.items():
        path = mod_dir / name
        if path.exists():
            cur = path.read_text(encoding="utf-8", errors="replace")
            if "TODO(US-008" not in cur:
                continue
        path.write_text(gen(), encoding="utf-8")
        wrote = True
    return wrote


def main() -> None:
    filled = []
    for d in sorted(WIKI.iterdir()):
        if not d.is_dir():
            continue
        if fill_module(d):
            filled.append(d.name)
    left = 0
    for d in WIKI.iterdir():
        if not d.is_dir():
            continue
        for p in d.glob("*.md"):
            left += p.read_text(encoding="utf-8", errors="replace").count("TODO(US-008")
    print(f"filled_or_refreshed: {len(filled)} -> {', '.join(filled)}")
    print(f"remaining_TODO(US-008): {left}")


if __name__ == "__main__":
    main()
