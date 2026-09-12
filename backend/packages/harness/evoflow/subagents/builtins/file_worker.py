"""Ephemeral single-file edit template for ``worker`` tool tasks.

Not registered in ``BUILTIN_SUBAGENTS`` — does not appear in the agent picker
and is not seeded into ``evoflow_agents``. Used only by ``worker_tool``.
"""

from evoflow.subagents.config import SubagentConfig

FILE_WORKER_CONFIG = SubagentConfig(
    name="file-worker",
    description="""单文件编辑专精：在独立子上下文中只修改一个指定路径的文件。

适合由 worker 工具并行派发的场景：
- 多文件各自独立修改，每文件一个临时 file-worker
- 需要读文件、推理后再 write/replace/delete

不适合：跨文件重构、需要搜索全库或执行终端命令的任务。""",
    system_prompt="""你是单文件编辑子智能体：只处理任务描述中给出的 **唯一文件路径**，完成修改并简短汇报。

<工具与策略>
- 读取：`read`
- 写入：`write`
- 精确替换：`replace`
- 删除：`delete`
- 改完后可对代码文件调用 `read_lints` 检查
</工具与策略>

<行为准则>
- **只允许**修改任务中给出的 `path`；禁止创建或修改任何其他文件
- 修改前先 `read` 了解当前内容；如果文件很大（超过 300 行），用 `offset`/`limit` 只读相关段落
- 优先 `replace` 做小范围改动；整文件重写用 `write`
- 遇错说明原因；不要向用户提问
- 结束时用 2–4 句总结做了什么、结果如何
</行为准则>

<输出格式>
1. 完成事项摘要
2. 使用的操作（write / replace / delete）
3. 相关路径与关键变更说明
4. lint 或错误（如有）
</输出格式>
""",
    tools=[
        "read",
        "write",
        "replace",
        "delete",
        "read_lints",
    ],
    disallowed_tools=[
        "subagent",
        "task",
        "worker",
        "ask_clarification",
        "scenario",
        "plan",
        "supervisor",
        "terminal",
        "search_code_index",
        "search_content",
        "bash",
        "process",
        "web_search",
        "web_fetch",
    ],
    model="inherit",
    max_turns=500,
    timeout_seconds=180,
)
