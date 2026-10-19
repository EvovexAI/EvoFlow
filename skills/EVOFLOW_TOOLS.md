# EvoFlow：技能目录与工具路径约定

技能文件安装在 **EvoFlow 程序目录**（如 `…/evoflow-gateway/skills/`），与用户选中的 **工作区** 不是同一棵树。请按下列写法，避免 `Path escapes the bound workspace`。

## 读文件 / 列目录

| 目的 | 工具 | 路径写法 |
|------|------|----------|
| 读本技能 `SKILL.md` | `read` | `skill:<frontmatter name>`，例如 `skill:pptx` |
| 读技能内其它文档 | `read` | `skill:<name>/editing.md`（正斜杠） |
| 浏览技能目录 | `bash` | `ls skill:<name>` 或 `ls skill:<name>/scripts`（宿主会解析） |

**不要**对技能文件使用安装目录绝对路径（`D:\app\EvoFlow\...\SKILL.md`）；`<available_skills>` 里的 `<location>` 也是 `skill:<name>`。

## 执行技能内脚本

使用 **`bash`**（前台或 `run_in_background=true`）。长任务用 **`taskoutput`** / **`taskstop`** 查看或停止。

- **命令**里写 `skill:<name>/scripts/...`，或相对 `scripts/...`（宿主会改写到技能安装目录）。
- 省略时 cwd = **用户工作区**，不是技能目录。
- 已废弃：~~`terminal`~~、~~`process`~~ / ~~`process_start`~~、~~`execute_command`~~。

示例：

```text
read("skill:pptx")
read("skill:pptx/editing.md")
bash(command="python skill:pptx/scripts/thumbnail.py demo.pptx", timeout=60000)
bash(command="python -m pytest skill:pptx/scripts/tests -q", run_in_background=true)
taskoutput(task_id="<backgroundTaskId>")
```

产物要落在用户项目时，输出路径指向 **工作区**（如 `outputs/result.pptx`），不要只写在技能安装目录。

## 写技能 `SKILL.md` 时

- 命令示例保持 **相对路径或 `skill:<本技能 name>/...`**。
- 在文首或「Resources / scripts」节可加一句：*EvoFlow 执行见 `skills/EVOFLOW_TOOLS.md`。*
