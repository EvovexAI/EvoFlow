# EvoFlow 文档

本仓库文档分为三个知识库根：

| 库 | 入口 |
|----|------|
| **用户指南** `user/` | [文档中心](user/index.md) · [**产品总览**](user/getting-started/product-overview.md) · [快速上手](user/getting-started/quick-start.md) · [操作指南](user/guides/README.md) |
| **系统内部** `system/` | [API 参考](system/reference/api-reference.md) · [架构](system/reference/architecture.md) · [贡献指南](system/developer/contributing.md) |
| **智能体产出** `roles/` | 路径约定 `docs/roles/<agent_code>/<YYYYMMDD-HH>/`（运行时产物，不进本站导航） |

### 三知识库约定（摘要）

| 知识库根 | 读者 | 内容 |
|----------|------|------|
| `user/` | 终端用户 | 产品总览、操作指南、教程、上手、FAQ、概念说明、用法案例 |
| `system/` | 开发 / 运维 / 系统 Agent | 技术设计、需求、API/配置参考、接口与内部约定 |
| `roles/` | 智能体员工产出 | 值班岗位按小时写入的方案/报告/纪要 |

判定：用户跟着面板点一遍 → `user/`；接口/表结构/中间件/需求 → `system/`；值班写出的方案报告 → `roles/`。

## 本地构建 MkDocs

```bash
pip install -r requirements-docs.txt
mkdocs serve
```

生产构建（断链即失败）：`make docs-build`
