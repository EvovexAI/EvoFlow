# Deep Research HTML 模板库

本目录用于把 `deep-research` 的研究结果，快速转换成可展示的 HTML 页面。

## 模板清单

- `T01-general-summary.html`：通用主题分析（技术、行业、方案）
- `T02-company-overview.html`：公司研究展示（概况、增长、风险、结论）
- `T03-competitor-compare.html`：多方案对比和选型建议
- `T04-event-timeline.html`：事件演进与影响洞察
- `T05-strategy-insight.html`：高冲击视觉的战略级展示页

## 快速使用

1. 复制模板并重命名。**对用户交付的 HTML 文件名优先中文**，须体现用户要分析的主题、对象或意图（从用户问题与界定书提炼），例如 `2026年5月-AI日报-方向确认-洞察页.html`、`宁德时代-供应链风险-洞察页.html`。**禁止**保留 `T01-general-summary.html` 等模板原名；文件名中勿含 `\\ / : * ? " < > |`。
2. 替换 `{{...}}` 占位符字段。
3. 修改图表数据（Chart.js 的 `labels` 和 `data`）。
4. 将成品写入线程 **`outputs/`** 后，由 **主会话在回复中用 `@@outputs/<文件名>.html@@` 交付**；勿仅本地写好文件却不在回复中交付。  
5. 浏览器打开即展示。

## 推荐输出字段

- 基础：`{{TITLE}}` `{{SUBTITLE}}` `{{REPORT_DATE}}`
- 指标：`{{KPI_1_LABEL}}` `{{KPI_1_VALUE}}`（可扩展）
- 摘要：`{{EXEC_SUMMARY}}`
- 结论：`{{FINAL_RECOMMENDATION}}`
- 来源：`{{SOURCE_1}}` `{{SOURCE_2}}` `{{SOURCE_3}}`
