# 最佳实践案例

本系列文档通过真实场景案例，展示 EvoFlow 各项功能的最佳实践。每个案例都包含分步操作指南、用户视角的提示词示例和截图占位，方便你快速上手。

若要通过**与 EvoPanel 相同的流式对话接口**模拟用户、观测输出，并在**各案例文档中记录每轮输入/输出**以便回溯，请使用：[流式对话验收方法说明](manual-acceptance-test-playbook.md)。（文档中含本机 **Gateway 8070 / LangGraph 2070** 示例；子集与参数以各脚本 **`--help`** 为准，**用户消息原文**见 [流式验收案例目录（能力向）](stream-acceptance-catalog.md) §1.3。）  
代理或 CI 跑 `e2e_scenarios_api_test.py` 后，可将**汇总登记**写入 [流式 E2E 运行登记](e2e-stream-run-registry.md)（轻量）；**正式验收**请按 [验收报告模板](templates/scenario-acceptance-report.template.md) **每场景单独成文**。  
若要将流式结果**按模板写入上表各案例 Markdown 末尾**（`<!-- ACCEPTANCE_RECORD_BEGIN -->` 块内，可重复运行替换），在 `backend` 目录执行：`uv run python scripts/case_doc_acceptance_append.py --gateway http://127.0.0.1:8070 --all`（或 `--case N` 仅跑第 N 条；参数见 `python scripts/case_doc_acceptance_append.py --help`）。

若你的验收清单按**能力**组织（创建/管理智能体与技能、自动化、Plan、联网出稿等），与下表「故事线」编号不完全一致时，请以 **[流式验收案例目录（能力向）](stream-acceptance-catalog.md)** 为主索引，再回链本页对应文档作补充阅读。

## 案例列表

| 序号 | 案例 | 说明 |
|------|------|------|
| 1 | [在对话中使用主智能体](use-main-agent.md) | 与默认主智能体进行对话的完整流程 |
| 2 | [创建智能体](create-agent.md) | 从零创建具有专属身份和能力的自定义智能体 |
| 3 | [创建技能](create-skill.md) | 为智能体编写技能扩展专业能力 |
| 4 | [安装技能](install-skill.md) | 从技能市场安装预置技能 |
| 5 | [自动化](scheduled-tasks.md) | 设置自动执行的自动化和消息推送 |
| 6 | [搜索汇总并输出分析 HTML](search-html-report.md) | 深度搜索 + 结构化报告生成的全流程 |
| 7 | [Claude Code 持续对话](claude-code-continuous.md) | 调用 Claude Code 实现 AI 辅助编码 |
| 8 | [Supervisor 模式（超级总控智能体）](supervisor-mode.md) | 多智能体协作完成复杂任务 |

## 推荐阅读顺序

如果你是第一次使用 EvoFlow，建议按以下顺序阅读：

1. **在对话中使用主智能体** → 先了解基本交互方式
2. **安装技能** → 快速扩展能力
3. **创建智能体** → 打造专属助手
4. **创建技能** → 进一步定制能力
5. **自动化** → 让智能体自动工作
6. **搜索汇总并输出分析 HTML** → 进阶：研究分析场景
7. **Claude Code 持续对话** → 进阶：AI 辅助开发
8. **Supervisor 模式（超级总控智能体）** → 进阶：多智能体协同

## 截图说明

每个案例文档中都预留了截图位置（格式如 `<!-- 截图占位：xxx.png — 说明 -->`）。你可以按照文档中的操作步骤实际操作，将截图替换到对应位置。

建议截图包含：
- 完整的应用窗口
- 关键操作区域的高亮标注
- 敏感信息（如 API Key）的打码处理
