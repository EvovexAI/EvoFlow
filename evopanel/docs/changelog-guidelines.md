# CHANGELOG 编写规范

本文档约束版本变更日志的编写方式，确保记录内容对外部用户清晰、有用。

发版时除本文件外，还必须同步写：

- `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-x.y.z.md`（CI / GitHub Release 硬依赖）
- `scripts/maintainer/update/latest.json`（发版草稿；装包后才推公仓 `update/latest.json`）

若本版包含**用户可感知的新模块**（新侧栏入口、新主流程），还必须补齐用户文档，避免「只有发版说明、产品内无帮助」：

- `docs/user/explanation/<topic>.md`（概念，用户视角）
- `docs/user/guides/...`（操作；可与 explanation 合并时至少保留一篇）
- `evopanel/src/lib/page-help.js` 对应路由的帮助词条
- 在 `docs/user/guides/README.md`（及必要时 `docs/user/README.md`）挂上链接

清单与操作步骤见 `scripts/maintainer/windows/README.md` §1.1c；升版 Agent 技能在私有文档仓 `$EVOFLOW_PRIVATE_DOCS/scripts/skills/evoflow-version-bump/SKILL.md`。

---

## 基本原则

CHANGELOG 是**给最终用户看的**，不是给开发者看的。

### 应该写的
- 新增功能：用户能用到的新功能
- 修复问题：用户会遇到并已修复的问题
- 重要变更：影响用户使用方式的改变

### 不应该写的
- 内部重构、代码清理
- CI/CD 工作流变更
- 依赖版本升级（除非用户需要感知）
- 许可证变更、品牌更名等内部事务
- "同步到公开仓库"等技术性操作

---

## 格式规范

```markdown
## [x.y.z] - YYYY-MM-DD

### Added
- 一句话描述新增功能（用户视角）

### Fixed
- 一句话描述修复的问题

### Changed
- 一句话描述变更内容（仅写影响用户使用的）

### Removed
- 一句话描述移除的内容
```

### 分类说明
- **Added**：新增用户可使用的功能
- **Fixed**：修复了用户会遇到的问题
- **Changed**：现有功能的行为改变（影响用户体验的）
- **Removed**：移除的功能（用户需要知道的）

### 不使用的分类
- **Deprecated** — 不需要，直接说 Removed
- **Security** — 安全修复合并到 Fixed 即可

---

## 写作要求

1. **简洁**：每条一句话，不要展开技术细节
2. **用户视角**：写"能做什么"，不写"怎么实现的"
3. **中文**：使用简体中文
4. **按重要性排序**：最重要的变更放在每个分类的最前面

## 示例

**好**：
```markdown
### Added
- 新增自动化功能，可设置自动执行时间并推送到飞书/Slack
- 关于页面新增版本信息展示与在线更新检查
```

**不好**：
```markdown
### Added
- 集成 cron 定时执行逻辑，支持多渠道推送（飞书/Lark、Slack、Telegram、Discord 等）
- 设置面板新增 about Tab，调用 Rust 后端 check_frontend_update 命令从 GitHub Releases 拉取最新版本
```
