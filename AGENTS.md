# EvoFlow

本项目的 AI 可消费知识库位于 [`.codebasewiki/`](./.codebasewiki/)(多工具按 [AGENTS.md 标准](https://agents.md/) 自动发现本文件)。

## 检索约定(AI 默认先查知识库)
处理「代码在哪 / 某模块怎么工作 / 某概念涉及哪些文件」前:
1. 先读 `.codebasewiki/index/index.md`(模块地图)+ `index/architecture.md`(整体架构),再下钻;
2. 关键词 → 源文件用 `/codebase-navigator <关键词>`(四层索引,<10s 定位);
3. 全项目 Grep 是最后手段,不是默认。已知确切路径的简单查找仍可直接 Read/Grep。

## 五环闭环
- **建库**:`/codebase-bootstrap` 或 `python .claude/skills/codebase-bootstrap/scripts/bootstrap.py`
- **检索**:`/codebase-navigator <关键词>`
- **沉淀**:会话结束自动(Stop hook → codebase-compound)
- **编排验证**:`/codebase-loop verify`
- **质量审**:`/codebase-wiki`(审 .codebasewiki/ 断链/缺节/frontmatter)

详见 `.claude/skills/codebase-wiki/SKILL.md`。
