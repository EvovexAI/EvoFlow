# 资产库契约

> evoflow-admin 资产库章节。细则读本文；布局见 [assets-layout.md](assets-layout.md)。

对话统一用工具 **`assets`**（`search` / `read` / `list` / `note` / `write` / `profile` / `affect`）。

运行时注入里已有 `entity_root` / catalog / 长期记忆 standing。`assets note` 用显式 **`kind`** 落盘；检索词只用 **`query`**；追加/覆盖用 **`mode`**。

---

## 1. 资产根

| 主体 | 根 | 用途 |
|------|-----|------|
| 登录用户 | `assets/users/<id>/` | 用户记忆、画像、主智能体情感 |
| 本地共享用户 | `assets/user/` | 单机默认 |
| employee | `assets/employees/<code>/` | 员工长期记忆 / 过程 / 经验 / 反思 / 情感 |
| lead/main agent | `assets/agents/main/profile/` | SOUL 等；**无独立记忆树** |

用户偏好写用户根；员工会话写员工根。同一事实只存一处。

### 1.1 注入分层

| 层 | 每轮 | 内容 |
|----|------|------|
| L0 岗位 | 是 | system_prompt / soul 职责骨架 |
| L1 长期记忆 | 是 | `memory/standing.md` 整页 |
| L2 catalog | 是 | craft / episodic / journal 文件名 |
| L3 正文 | 按需 | `assets` read / search |

---

## 2. 布局与写入

| 路径 | 用途 | 写入 |
|------|------|------|
| `profile/USER.md` | 用户画像 | `action=profile` + `mode=append\|replace` |
| `profile/affect.md` | 情感（用户侧=主智能体；员工侧=该员工） | `action=affect` + `mode=append\|replace` |
| `memory/standing.md` | **长期记忆** | `note` `kind=preference` |
| `memory/episodic/` | **过程** | `note` `kind=process` |
| `craft/<name>.md` | 经验 | `note` `kind=experience` |
| `memory/journal/<topic>.md` | 反思 | `note` `kind=reflection` |
| `memory/MEMORY.md` | 手册索引 | 对话勿手改 |

---

## 3. 写盘

```text
assets(action="note", kind="preference|process|experience|reflection", content="标题\n\n正文…")
assets(action="profile", mode="append|replace", content="…")
assets(action="affect", mode="append|replace", content="…")
```

| kind / action | 落点 |
|---------------|------|
| `kind=preference` | `memory/standing.md`（`mode=replace` 整页覆盖） |
| `kind=process` | `memory/episodic/` |
| `kind=experience` | `craft/` |
| `kind=reflection` | `memory/journal/` |
| `profile` | `profile/USER.md` |
| `affect` | `profile/affect.md` |

`query` **只用于 search**。不要用 `query=replace`。

---

## 4. 何时记

| 触发 | 写法 |
|------|------|
| 稳定偏好 / 硬约束 | `kind=preference` 或 `profile` |
| 本轮结论 / 过程 | `kind=process` |
| 可复用做法 | `kind=experience` |
| 短反思 | `kind=reflection` |
| 心境变化（主智能体或员工） | `affect` |
| 用户说「记住」 | 立刻写 |

默认同轮写。同主题 / 过时：先 `read`，再 `note`+`path` 或 `write`；是否更新由模型判断。

---

## 5. 读法

1. 先看已注入的长期记忆 + catalog。
2. `assets(action="read", path="文件名.md")` 或 `search`（关键词放 `query`）。
3. 不要整目录盲读。
4. 过期/矛盾：`read` 后用 `note`+`path` 或 `write` 覆盖。

---

## 6. 用户画像 / 情感

- 画像真源：`profile/USER.md` — `assets profile`（用户根）
- 情感真源：`profile/affect.md` — `assets affect`（用户根=主智能体；员工根=该员工；模型主动写，无后台改）
- `mode=append` 默认；`mode=replace` 整份重写

---

## 7. 示例

```
用户：我习惯结论先行，常用 Python + LangChain
→ assets(action="profile", content="- 结论先行；工具栈 Python + LangChain")
```

```
排查完登录失败是 token 过期
→ assets(action="note", kind="experience", content="登录失败·token 过期\n\n…")
```

---

## 8. 边界

- 用 `assets note` / `profile` / `affect` 更新；勿把经验全文塞进 `system_prompt`。
- 敏感凭据走配置中心。
- 引用资产时加 `<evo-asset-citation>`。
