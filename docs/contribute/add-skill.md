# 添加 Skill

Skills 是扩展 EvoFlow 能力的首选方式：一份 `SKILL.md` + 可选脚本/资源，不必改 Runtime 核心。

用户侧教程：[添加技能](../user/tutorials/add-skill.md) · [技能管理](../user/guides/configuration/skill-management.md) · [技能系统说明](../user/explanation/skill-system.md)

## 何时写 Skill，何时改核心

| 场景 | 做法 |
|------|------|
| 教 Agent 完成一类业务流程（发布、对账、写周报…） | **Skill** |
| 需要新的一等工具原语、沙箱行为、规划语义 | 先 Discussion / Issue，再改 `evoflow`（门槛高） |
| 对接外部系统 API | Skill + 文档化环境变量；或 MCP（见 [工具与 MCP](../user/guides/configuration/tools-mcp.md)） |

## 目录约定

```text
skills/public/<skill-name>/
├── SKILL.md          # 必需：名称、描述、步骤
├── scripts/          # 可选
├── references/       # 可选
└── assets/           # 可选
```

- 名称用小写短横线：`my-workflow`。  
- **禁止**写入真实 API Key、Token、客户数据。在文档里写「需要哪些环境变量」。  
- 描述写清楚：Agent 何时应加载此技能（触发条件）。

## PR 检查清单

- [ ] `SKILL.md` 可被面板识别（名称 / 描述完整）  
- [ ] 无密钥；示例使用占位符  
- [ ] 若依赖本机工具，写明平台与安装方式  
- [ ] 需要时补一句用户文档或案例链接  
- [ ] 分支 `feat/skill-<name>`，走常规 [分支与检查](branching-and-checks.md)

## 本地验证建议

1. `make docker-start` 或桌面开发栈起来。  
2. 在 EvoPanel 技能管理中确认技能出现在列表。  
3. 用一条会触发该技能的真实提示跑一轮，确认步骤可执行。

维护者会按「是否通用、是否可安全默认加载」决定是否合入 `skills/public/`。
