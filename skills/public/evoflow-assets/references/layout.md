# 资产库布局详解

> 本文件由 `evoflow-assets` skill 引用；如要修改契约，请同步更新 SKILL.md。
>
> 路径都按相对 entity root 列出。**绝对路径以运行时 entity block 注入的 `base_dir` / `entity_root_abs` 为准**,不要从相对路径拼绝对路径。

## 用户根:`<base_dir>/assets/users/<id>/`

```
profile/
  basic-info.md       # 称呼、职业、语言、时区
  preferences.md      # 沟通风格、技术偏好、工具栈
  persona.md          # 沟通习惯画像（结论先行 / 先诊后改）
  README.md           # 用户画像索引（自动生成）

memory/
  _inbox/
    notes/                     # 写入入口：YYYY-MM-DDTHH-MM-SS-<slug>.md
      YYYY-MM-DDTHH-MM-SS-<slug>.md
    _done/                     # Phase2 合并后归档（从不销毁）
      <UTC>-raw_<thread>.md
      notes/<UTC>-YYYY-MM-DDTHH-MM-SS-<slug>.md
    phase2_workspace_diff.md   # Phase2 diff 清单（自动生成）
    raw_memories.md            # Phase2 合并前原始材料合集（自动生成）
  archive/
    completed-goals/           # goal 系统归档
  audit/                       # 自审报告（human-readable Markdown + JSON）
    YYYY-MM-DD-HHMMSSZ-audit.md
  standing.md                 # 启动摘要（≥2 字符摘要，机器写）
  MEMORY.md                   # 索引：指针 + 标签 + 日期
  facts/
    <category>-<slug>.md   # 稳定事实
  episodic/
    <task-slug>-<YYYY-MM-DD>.md   # 流程复盘
  journal/
    reflection-<YYYY-MM-DD>.md    # 反思

craft/
  <name>/SKILL.md     # 可复用做法（小型 skill）
```

## 共享用户:`<base_dir>/assets/user/`

与登录用户根布局一致；未登录或本地默认走这里。

## Agent / Employee 根:`<base_dir>/assets/agents/{code}/` 或 `<base_dir>/assets/employees/{code}/`

```
profile/
  SOUL.md             # 人格 / 价值观
  system.md           # 系统提示覆盖
  identity.md
  soul-summary.md     # 自动生成摘要
```

**注意**：agent 自身**没有独立记忆树**——它的对话记忆走用户根。

## 工作区根:`<local_workspace>/.evoflow/`

```
module/<name>.md      # 模块与职责
logic/<flow>.md       # 业务流程
architecture/<layer>.md
convention/<rule>.md
gotcha/<pitfall>.md
entrypoint/<cmd>.md
memory/standing.md    # 项目启动摘要
```

## 写入路径速查

> 表中路径是相对 entity root 的简写。**写入时**用 `read('<absolute_path>')` / `write('<absolute_path>', ...)`(绝对路径以 entity block 注入的 `entity_root_abs` / `inbox_path_abs` 为准)。

| 写什么 | 写到哪里(相对 entity root) | 格式 |
|--------|---------|------|
| 用户身份信息 | `profile/basic-info.md` | 直接写 |
| 用户偏好 | `profile/preferences.md` | 直接写 |
| 流程复盘 | `memory/episodic/<slug>-YYYY-MM-DD.md` | Phase2 或手动 |
| 反思 | `memory/journal/reflection-YYYY-MM-DD.md` | Phase2 或手动 |
| 可复用做法 | `craft/<name>/SKILL.md` | Phase2 或手动 |
| 任何新记忆(先入) | `memory/_inbox/notes/YYYY-MM-DDTHH-MM-SS-<slug>.md` | 首行 `[experience]` 等 |
| 项目模块 | `<workspace>/.evoflow/module/<name>.md` | 直接写 |
| 项目踩坑 | `<workspace>/.evoflow/gotcha/<pitfall>.md` | 直接写 |
