# EvoFlow：技能目录与工具路径约定

技能文件安装在 **EvoFlow 程序目录**（如 `…/evoflow-gateway/skills/`），与用户选中的 **工作区** 不是同一棵树。请按下列写法，避免 `Path escapes the bound workspace`。

## 读文件 / 列目录

| 目的 | 工具 | 路径写法 |
|------|------|----------|
| 读本技能 `SKILL.md` | `read_file` | `skill:<frontmatter name>`，例如 `skill:pptx` |
| 读技能内其它文档 | `read_file` | `skill:<name>/editing.md`（正斜杠） |
| 浏览技能目录 | `list_dir` | `skill:<name>` 或 `skill:<name>/scripts` |

**不要**对技能文件使用安装目录绝对路径（`D:\app\EvoFlow\...\SKILL.md`）；`<available_skills>` 里的 `<location>` 也是 `skill:<name>`。

## 执行技能内脚本

使用 **`terminal`**（短命令、立刻要看输出）或 **`process_start`**（脚本、测试、构建、服务；配合 `process_poll` / `process_log` / `process_wait`）。

- **`workdir`** 设为 `skill:<name>`（仅技能根，不要 `skill:pptx/scripts`）。
- **命令** 写相对路径，与 `SKILL.md` 示例一致，例如：`python scripts/thumbnail.py …`
- 省略 `workdir` 时 cwd = **用户工作区**，不是技能目录。
- 已废弃：~~`execute_command`~~、~~`bash`~~（沙箱别名）。

示例：

```text
read_file("skill:pptx")
read_file("skill:pptx/editing.md")
terminal(command="python scripts/thumbnail.py demo.pptx", workdir="skill:pptx", timeout=60)
process_start(command="python -m pytest scripts/tests -q", workdir="skill:pptx", background=True)
```

产物要落在用户项目时，输出路径指向 **工作区**（如 `outputs/result.pptx`），不要只写在技能安装目录。

## 写技能 `SKILL.md` 时

- 命令示例保持 **相对路径**（假定 `workdir="skill:<本技能 name>"`）。
- 在文首或「Resources / scripts」节可加一句：*EvoFlow 执行见 `skills/EVOFLOW_TOOLS.md`。*
