# docs/roles — 智能体员工产出知识库

智能体员工（proactive 值班岗位）写入的**方案 / 报告 / 纪要 / 分析**等交付文档根目录。可单独挂载为产出库 Vault，与用户指南、系统文档隔离。

**操作指南（怎么雇佣、值班、审批）：** [`docs/user/guides/configuration/smart-employees.md`](../user/guides/configuration/smart-employees.md)

## 路径约定（运行时 SSOT）

```text
docs/roles/<agent_code>/<YYYYMMDD-HH>/…
```

- `<agent_code>`：岗位绑定的智能体代码（文件系统安全化后的目录名），不是展示用角色名
- `<YYYYMMDD-HH>`：UTC 小时桶，避免同主题互相覆盖
- 实现见 `backend/packages/harness/evoflow/proactive/artifacts.py`

## 规则

- **只写本岗当前小时目录**；不要写到仓库根、`docs/` 根、`docs/user/`、`docs/system/`、别人的 `docs/roles/<其他code>/`
- 业务源码仍按管辖范围落盘；**文档类交付**才走本目录
- 本目录是运行时产物，**不是**产品文档 SSOT；稳定说明应沉淀进 `user/` 或 `system/`
