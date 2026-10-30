# 资产库布局详解

> 本文件由 **evoflow-admin** 引用（`references/assets-contract.md`）；改布局请同步更新契约正文。
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
    notes/                     # 写入入口：<slug>.md（时间在 frontmatter）
      <slug>.md
    _done/                     # Phase2 合并后归档（从不销毁）
      <UTC>-raw_<thread>.md
      notes/<UTC>-<slug>.md
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
    <topic-slug>.md               # 反思（文件名=内容主题，不带年月日；日期只在 frontmatter）

craft/
  <name>.md           # 可复用做法（扁平文件；成熟后可 promote 成技能包）
```

## 共享用户:`<base_dir>/assets/user/`

与登录用户根布局一致；未登录或本地默认走这里。

## Agent 根:`<base_dir>/assets/agents/{code}/`

```
profile/
  SOUL.md             # 人格 / 价值观
  system.md           # 系统提示覆盖（薄；勿塞经验全文）
  identity.md
  soul-summary.md     # 自动生成摘要
  affect.md           # 情感镜像（DB evoflow_person_affect 为真源；统一激素心境）
```

**注意**：普通 agent（含 main）**没有独立记忆树**——对话记忆走用户根。情感状态按 `agent_code` 存在 DB，全员统一框架。

## Employee 根:`<base_dir>/assets/employees/{code}/`

与用户根同构的记忆树（standing / MEMORY / facts / episodic / journal / craft / _inbox）。  
资产中心 IA：**画像只属于用户**；员工共享用户画像，不设画像 Tab。  
员工 `profile/affect.md` 是**每人独立**的情感镜像（真源 `evoflow_person_affect`）；SOUL/system 仍落盘供运行时，但不在资产中心「画像」里编辑。  
运行时注入：L1 standing + L2 catalog 短标题 + **此刻心境**自然语言摘要；正文 L3 按需 `assets` read。  
`agents.system_prompt` = L0 岗位骨架，**不是**经验库。

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

> 表中路径是相对 entity root 的简写。**对话沉淀**一律 `assets(action="note")`（落 inbox）；读用 `assets(action="read|search|list")`。资产中心 / Gateway 可对正式目录直写；Agent 不要绕过 inbox 手改 `episodic`/`journal`/`craft`/`standing`/`MEMORY`。

| 写什么 | 写到哪里(相对 entity root) | 格式 |
|--------|---------|------|
| 用户身份信息 | `profile/basic-info.md` | 直接写 |
| 用户偏好 | `profile/preferences.md` | 直接写 |
| 流程复盘 | `memory/episodic/<slug>.md` | Phase2 合并后；对话勿直写 |
| 反思 | `memory/journal/<topic-slug>.md` | Phase2 或 hub 直写；文件名用主题，不带年月日；对话勿直写 |
| 可复用做法 | `craft/<name>.md` | Phase2 合并后；对话勿直写 |
| 任何新记忆(先入) | `memory/_inbox/notes/<slug>.md` | `assets action=note`；首行 `[experience]`/`[process]`/`[reflection]`/`[preference]`；`created` 在 frontmatter |
| 项目模块 | `<workspace>/.evoflow/module/<name>.md` | 直接写 |
| 项目踩坑 | `<workspace>/.evoflow/gotcha/<pitfall>.md` | 直接写 |
