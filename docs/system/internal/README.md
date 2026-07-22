# docs/system/internal

本目录存放需求、设计草案、验收说明、历史长文与第三方参考资料等，属于 **系统内部知识库**（`docs/system/`），**默认不进入 MkDocs 站点**（见仓库根目录 `mkdocs.yml` 的 `exclude_docs`）。

- 对外读者请使用 [用户指南](../../user/index.md)：[快速开始](../../user/getting-started/introduction.md)、[操作指南](../../user/guides/configuration/evopanel-guide.md)、以及本库 [参考手册](../reference/api-reference.md)。
- 智能体值班产出见 [`../../roles/`](../../roles/README.md)，不是本目录 SSOT。
- 若某篇文档与当前代码不一致，**以代码与 `config.example.yaml` 为准**。

子目录说明：

| 目录 / 文件 | 内容 |
|------|------|
| [public-private-push-guide.md](public-private-push-guide.md) | **私有仓 / 公共仓推送流程**（日常必读） |
| `requirements/` | 需求文档 |
| `technical/` | 技术设计长文 |
| `third-party-references/` | 第三方参考资料（非 EvoFlow 行为说明） |
