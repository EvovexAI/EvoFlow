# 文档单一事实来源（SSOT）

为避免多份文档互相矛盾，每个主题只保留**一处主文档**；其他位置仅保留摘要与链接。

三知识库根：[`docs/user/`](../../user/)（用户指南）、[`docs/system/`](../../system/)（系统内部）、[`docs/roles/`](../../roles/)（智能体产出）。

| 主题 | 主文档 | 备注 |
|------|--------|------|
| Gateway HTTP API | [reference/api-reference.md](../reference/api-reference.md) + [generated/openapi-gateway.json](../reference/generated/openapi-gateway.json) | OpenAPI 由脚本导出，CI 校验 |
| `config.yaml` 键参考 | [reference/config-reference.md](../reference/config-reference.md) | 与 `config.example.yaml` 交叉核对 |
| 环境变量 | [reference/env-reference.md](../reference/env-reference.md) | 以代码读取点为准 |
| 用户安装与上手 | [getting-started/installation.md](../../user/getting-started/installation.md) | 与根 `README.md` 摘要一致 |
| 下载与 Release | [getting-started/downloads.md](../../user/getting-started/downloads.md) | 链向 GitHub Releases |
| EvoPanel | [guides/configuration/evopanel-guide.md](../../user/guides/configuration/evopanel-guide.md) + 仓库 [`evopanel/README.md`](https://github.com/EvovexAI/EvoFlow/blob/main/evopanel/README.md) | 桌面端以本仓库 `evopanel/` 为准 |
| 生产与运维 | [guides/deployment/operations-handbook.md](../../user/guides/deployment/operations-handbook.md) | 日志、升级、备份、安全 |
| 智能体岗位产出 | [`docs/roles/<agent_code>/<YYYYMMDD-HH>/`](../../roles/README.md) | 运行时产物，非产品文档 SSOT |
| 后端实现细节（英文历史文档） | 仓库 [`backend/docs/`](https://github.com/EvovexAI/EvoFlow/tree/main/backend/docs) 内 **stub** 指向本仓库 `docs/` 下页面 | 保留旧链接不中断 |

## `backend/docs/` 与根 `docs/` 的关系

历史上有部分英文文档位于 `backend/docs/`。重复主题已在对应文件中改为**短说明 + 指向本仓库 `docs/` 的链接**，避免两处长期漂移。
