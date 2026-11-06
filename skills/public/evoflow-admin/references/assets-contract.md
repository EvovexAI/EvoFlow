# 资产库契约

> evoflow-admin 资产库章节。细则读本文；布局见 [assets-layout.md](assets-layout.md)。

对话统一用工具 **`assets`**。  
**落点 / 何时记 / 何时更新**：与运行时注入同文，唯一口径  
`backend/packages/harness/evoflow/assets/prompts/memories/read_path.md`（系统提示 `## Entity assets`）。  
本文只保留根路径与 kind→文件映射；勿在工具 schema 或别处再写一套规则。

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
| L1 长期记忆 | 是 | `standing.md`：仅偏好/Tips（软顶；不含 What's in Memory） |
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

过程 / 经验 / 反思：文件名取正文**第一行标题**，须短且能看出主题（细则只在 `read_path.md`）。

---

## 4. 何时记 / 落哪 / 读法

见 **`read_path.md`**（上引路径）。此处不重复。

---

## 5. 用户画像 / 情感

- 画像真源：`profile/USER.md` — `assets profile`（用户根）
- 情感真源：`profile/affect.md` — `assets affect`（用户根=主智能体；员工/小微=各自根；模型主动写，无后台改）
- 注入：`memory_enabled` / 资产开关开 → 系统提示追加 `<affect>`；关则不注入（主智能体 / 员工 / 小微同一套）
- `mode=append` 默认；`mode=replace` 整份重写

---

## 6. 示例

```
用户：我习惯结论先行
→ assets(action="note", kind="preference", content="- 结论先行")
```

```
用户：这次活动报名流程走完了，下次同类还能用
→ assets(action="note", kind="experience", content="活动报名流程\n\n…")
```

---

## 7. 边界

- 用 `assets note` / `profile` / `affect` 更新；勿把经验全文塞进 `system_prompt`。
- 敏感凭据走配置中心。
- 引用资产时加 `<evo-asset-citation>`。
- 落点规则只维护 `read_path.md` 一处。
