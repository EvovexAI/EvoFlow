# ContentOS × EvoFlow：三套件产品边界

> 页面拆成三个 UI 扩展；执行统一走 EvoFlow 工作流 / 智能体员工。

## 1. 三套件（少扩展、大套件）

| 扩展 id | 侧栏名 | 页面范围 | 职责 |
|---------|--------|----------|------|
| `contentos` | 运营中台 | 工作台、内容、发布、复盘、账号、知识库… | 选题 → 成稿 → 发布 → 复盘；口播号/矩阵账号先挂「平台账号」 |
| `contentos-materials` | 素材中心 | `/materials`（后续视频生成等） | 可复用媒资；多业务共用，不绑死运营中台 |
| `contentos-trending` | 爆款洞察 | `/trending`、`/video-decompose`、`/viral-remix` | 找热点 → 拆视频 → 爆款复刻，辅助创作 |

**不拆成更碎的扩展**（如单独「视频拆解」「爆款分析」）：同一条灵感链路，共享员工与工作流。

## 2. 和 EvoFlow 怎么联动

| 层 | 放什么 |
|----|--------|
| UI 扩展 | 看板、结果、素材、账号配置；点按钮派活 |
| 应用 / 工作流 | 可复用流水线（采热点、拆解、脚本、匹配、生成） |
| 智能体员工 | 盯热点、拆片、出稿、养号等长期职责 |
| Bridge | `tasks.dispatch` / `tasks.open` / `context.get` |

约定：扩展里「跑一轮分析 / 生成 / 发布」→ 派 EvoFlow 任务或跑应用；结果回写 ContentOS 或任务中心。业务数据可留在 ContentOS，**调度与 Agent 执行在 EvoFlow**。

## 3. 安装

见 [`extensions/contentos/README.md`](../../../extensions/contentos/README.md) 与 ContentOS `evoflow-extensions/`。

## 4. 创作画布（选型）

无线分镜/出片画布采用 **Infinite-Canvas** 派生仓，以 UI 扩展 `ai-canvas`（侧栏「创作画布」，`:3000`）接入。见 [`ai-canvas-refs.md`](./ai-canvas-refs.md)。

## 5. 对外交付（重要）

**不要让终端用户分别安装 4 个扩展。**  
完整产品方案（套件化、主路径、分阶段）见 [`content-creator-suite.md`](./content-creator-suite.md)：对外一个「内容创作」套件，对内仍是多模块。
