# ContentOS × EvoFlow：内容创作套件产品边界

> 页面拆成多个 UI 扩展入口；执行统一走 EvoFlow 工作流 / 智能体员工。

## 1. 套件成员（内容创作）

| 扩展 id | 侧栏名 | 页面范围 | 职责 |
|---------|--------|----------|------|
| `contentos-trending` | 今日热点 | `/trending` | 找热点 / 灵感 |
| `contentos-decompose` | 视频拆解 | `/video-decompose` | **单条拆解**（一等公民） |
| `contentos-account-insights` | 账号洞察 | `/account-insights` | **按账号**看风格、数据、已拆作品墙 |
| `contentos-materials` | 素材中心 | `/materials` | 可复用媒资 |
| `contentos` | 运营中台 | 工作台、内容、发布、复盘、账号、知识库… | 选题 → 成稿 → 发布 → 复盘 |
| `ai-canvas` | 创作画布 | `:3000` | 分镜出片 |

链路：**热点 → 拆解 → 账号沉淀 → 复刻/出片**。  
原「爆款洞察」已拆成「今日热点 + 视频拆解 + 账号洞察」，共享 ContentOS `:3001`，不要求用户装四个互不相干的服务。

## 2. 和 EvoFlow 怎么联动

| 层 | 放什么 |
|----|--------|
| UI 扩展 | 看板、结果、素材、账号配置；点按钮派活 |
| 应用 / 工作流 | 可复用流水线（采热点、拆解、脚本、匹配、生成） |
| 智能体员工 | 盯热点、拆片、出稿、养号等长期职责 |
| Bridge | `tasks.dispatch` / `tasks.open` / `context.get` |

约定：扩展里「跑一轮分析 / 生成 / 发布」→ 派 EvoFlow 任务或跑应用；结果回写 ContentOS 或任务中心。业务数据可留在 ContentOS，**调度与 Agent 执行在 EvoFlow**。

## 3. 账号洞察 vs 平台账号

| | 平台账号 `/accounts` | 账号洞察 `/account-insights` |
|--|---------------------|------------------------------|
| 用途 | 绑定 OAuth、同步作品/指标、填人设 | 看**拆解聚合**后的风格/钩子/作品墙 |
| 数据 | `PlatformAccount` + `AccountProfile` | 同上 + `VideoDecomposition.platformAccountId` |

运营知识库 `08-账号风格` 可与洞察摘要互参；MVP 先落产品页，回写 Markdown 可选。

## 4. 安装

见 [`extensions/contentos/README.md`](../../../extensions/contentos/README.md) 与 ContentOS `evoflow-extensions/`。套件：[`content-creator`](../../../extensions/content-creator/)。

## 5. 创作画布（选型）

无线分镜/出片画布采用 **Infinite-Canvas** 派生仓，以 UI 扩展 `ai-canvas`（侧栏「创作画布」，`:3000`）接入。见 [`ai-canvas-refs.md`](./ai-canvas-refs.md)。

## 6. 对外交付（重要）

**不要让终端用户分别安装一堆扩展。**  
完整产品方案见 [`content-creator-suite.md`](./content-creator-suite.md)：对外一个「内容创作」套件，对内多入口。
