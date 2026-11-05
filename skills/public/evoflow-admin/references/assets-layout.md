# 资产库布局详解

> 由 **evoflow-admin** 引用；改布局请同步 [assets-contract.md](assets-contract.md)。
>
> 相对 entity root；绝对路径以运行时注入为准。

## 用户根:`<base_dir>/assets/users/<id>/`

```
profile/
  USER.md             # 用户画像真源（单文件）

memory/
  standing.md         # 长期记忆（每轮注入）
  MEMORY.md           # 手册索引
  episodic/
    <slug>.md         # 过程
  journal/
    <topic>.md        # 反思

craft/
  <name>.md           # 经验 / 做法
```

## 共享用户:`<base_dir>/assets/user/`

与登录用户根布局一致。

## Agent 根:`<base_dir>/assets/agents/{code}/`

```
profile/
  SOUL.md
  system.md
  identity.md
  affect.md
```

普通 agent（含 main）**无独立记忆树**——对话记忆走用户根。

## Employee 根:`<base_dir>/assets/employees/{code}/`

```
profile/
  affect.md           # 心境真源；模型 assets affect 主动改
memory/
  standing.md
  episodic/
  journal/
craft/
```

运行时共享**用户**画像；员工有独立情感。注入：L1 standing + L2 catalog + 情感摘要；正文按需 `assets` read。

## 工作区根:`<local_workspace>/.evoflow/`

```
module/<name>.md
logic/<flow>.md
architecture/<layer>.md
convention/<rule>.md
gotcha/<pitfall>.md
entrypoint/<cmd>.md
memory/standing.md
```

## 写入速查

对话用 `assets note` / `profile`，标签直达正式路径：

| 写什么 | 路径 | 工具 |
|--------|------|------|
| 用户画像 | `profile/USER.md` | `assets profile` |
| 长期记忆 | `memory/standing.md` | `[preference]` note |
| 过程 | `memory/episodic/<slug>.md` | `[process]` note |
| 反思 | `memory/journal/<topic>.md` | `[reflection]` note |
| 经验 | `craft/<name>.md` | `[experience]` note |
| 项目踩坑等 | `<workspace>/.evoflow/…` | 直接写对应目录 |
