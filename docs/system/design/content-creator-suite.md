# 内容创作完整方案：套件化，而不是一堆插件

> 目标：别人装 EvoFlow 后，**一次安装 / 甚至开箱即用**，就能走完「拆爆款 → 复刻 → 出片 → 存档 → 发布」；不要让用户自己装 4 个扩展。

## 1. 用户痛点（必须先解决）

当前开发态是 4 个扩展登记：

| id | 侧栏 |
|----|------|
| `contentos` | 运营中台 |
| `contentos-materials` | 素材中心 |
| `contentos-trending` | 爆款洞察 |
| `ai-canvas` | 创作画布 |

对**开发者**合理（边界清、端口可共享）；对**终端用户**不合理：

- 装 4 次、开 4 次权限确认 → 劝退  
- 不知道哪个先用、哪个依赖哪个  
- 画布还要单独起 `:3000`，ContentOS 起 `:3001`，心智负担大  

**结论：对内可以多模块；对外必须是「一个套件」。**

---

## 2. 对外产品形态（推荐）

### 2.1 一个套件包：`content-creator`（内容创作）

| 对用户说的 | 实际包含 |
|------------|----------|
| **内容创作**（一个安装项） | 运营中台 + 素材中心 + 爆款洞察 + 创作画布 |

安装体验只有三种（按优先级）：

1. **EvoFlow 桌面版预装（默认）**  
   安装客户端即带「内容创作」套件，侧栏直接有入口；适合你们自己发版给客户。  
2. **应用市场一键装套件（后续）**  
   点「安装内容创作」→ 一次下载、一次权限确认、一次启用。  
3. **高级用户拆装模块（可选）**  
   设置里仍可单独禁用「创作画布」等重模块，但**默认不要拆成四个安装按钮**。

侧栏建议固定为 **4 个入口（同一套件）**，不要再碎：

```
扩展
  ├ 爆款洞察     ← 找灵感 / 拆片 / 复刻方案
  ├ 创作画布     ← 摆镜 / 出图 / Seedance 有声片
  ├ 素材中心     ← 关键帧、成片、可复用媒资
  └ 运营中台     ← 账号、发布、复盘
```

顺序按「创作主路径」排，不是按开发先后排。

### 2.2 技术上怎么实现「一次安装」

标准演进（v1.1 建议）：

```json
{
  "schema": 1,
  "kind": "suite",
  "id": "content-creator",
  "name": "内容创作",
  "version": "1.0.0",
  "members": [
    { "id": "contentos-trending", "manifest": "./members/trending/evoflow.extension.json" },
    { "id": "ai-canvas", "manifest": "./members/ai-canvas/evoflow.extension.json" },
    { "id": "contentos-materials", "manifest": "./members/materials/evoflow.extension.json" },
    { "id": "contentos", "manifest": "./members/ops/evoflow.extension.json" }
  ]
}
```

安装器行为：

1. 用户只选 / 只下 **一个 suite 包**  
2. 客户端展开 `members[]`，注册多个 nav，但 **suite 维度统一启用/卸载**  
3. 权限合并一次确认（`embed` + `tasks.dispatch` + …）  
4. 侧车：ContentOS 共享 `:3001`；画布 `:3000`；首次打开对应入口才懒启动  

在 suite 落地前的过渡：设置页提供 **「一键安装内容创作套件」** 按钮，内部循环安装 4 个 member（对用户仍是一次操作）。

---

## 3. 端到端业务流（别人真正要用的路径）

```text
① 爆款洞察
   粘贴抖音链接 → 拆解
   产出：关键帧[] + 口播/分镜结构 +（可选）复刻方案

② 「生成成片 / 打开创作画布」按钮
   把蓝图打包成 CanvasImportPayload
   → bridge 或 deep-link 打开 ai-canvas
   → 画布按镜铺：参考图节点 + 口播 prompt + Seedance 节点

③ 创作画布
   用户改 prompt / 换参考图 → Agent Plan 生图 / 有声短镜
   （多镜拼接、烧字幕：第二期接 media-post）

④ 回写素材中心
   成片 + 关键帧入库，带来源（remixPlanId / decomposeId）

⑤ 运营中台
   从素材选成片 → 选账号发布 → 复盘
```

### 3.1 跨模块数据契约（最小）

```ts
// 爆款洞察 → 创作画布
type CanvasImportPayload = {
  source: 'contentos-trending';
  decomposeId?: string;
  remixPlanId?: string;
  title?: string;
  shots: Array<{
    index: number;
    transcript?: string;      // 该镜口播
    keyframeUrl?: string;     // 参考/首帧
    promptHint?: string;      // 复刻后的画面提示
    durationSec?: number;
  }>;
};
```

传递方式（按落地难度）：

| 阶段 | 方式 |
|------|------|
| 先做通 | `http://127.0.0.1:3000/static/canvas.html?import=<jobId>` + ContentOS/画布共读本地 job 文件 |
| 正规化 | EvoFlow Bridge：`tasks.dispatch` 不合适时用 `context.set` / 专用 `canvas.import`（标准 v1.1） |
| 以后 | 云端 jobId，两边都拉同一份蓝图 |

### 3.2 什么继续留在 EvoFlow 内核（用户无感）

- Agent Plan Key（设置 → 模型 / 媒体）  
- 媒体工种 / media-production（重活、字幕、拼接）  
- 任务中心、员工值班  

扩展里只放 **看得见的台面**；用户不必再装「生视频插件」。

---

## 4. 安装与运行：别人要装什么？

### 4.1 理想态（发版给客户）

| 用户动作 | 得到 |
|----------|------|
| 安装 **EvoFlow 桌面版** | 内容创作套件已预装；侧栏 4 入口 |
| 在设置里填 **方舟 Agent Plan Key**（或登录账号下发） | 能生图 / 生有声视频 |
| （可选）装 FFmpeg / Whisper 依赖若拆解要本地 | 安装向导里检测，而不是第四个「插件」 |

**不要**：再让用户去 GitHub clone Infinite-Canvas、再装三个 ContentOS 扩展。

### 4.2 现在开发态 → 怎么收敛

| 现在 | 下一步 |
|------|--------|
| 手工登记 4 个扩展 | 「一键装套件」脚本 / 设置页按钮 |
| 画布在 `_refs` 独立仓 | 发布物打进 suite zip 或随安装包 |
| ContentOS monorepo link | 正式包用 managed 复制或内嵌服务 |

### 4.3 重模块可裁剪（仍算一个套件）

| 模块 | 默认 | 说明 |
|------|------|------|
| 爆款洞察 + 运营 + 素材 | 开 | 轻，共享 `:3001` |
| 创作画布 | 开（可关） | 重，`:3000`；关掉则「生成成片」改派 EvoFlow 媒体任务（无画布 UI） |

用户感知仍是「内容创作」，不是「少装了一个插件」。

---

## 5. 分阶段落地（完整但不一次做完）

### P0 — 体验与打包（先解决「麻烦」）

1. ~~设置 → 扩展：**一键安装内容创作套件**~~（`extensions/content-creator` + `ui_extension_install_content_creator`）
2. ~~侧栏排序：洞察 → 画布 → 素材 → 运营~~（nav.order 50 / 52 / 55 / 60）
3. EvoFlow 发版清单：预装 suite 或首次启动引导安装
4. ~~画布产品仓独立：`evolvear/CanvasOS`；套件成员在 `extensions/content-creator/members/ai-canvas`~~

### P1 — 主路径打通（拆解 ↔ 画布）

1. ~~拆解 / 复刻结果页：**打开创作画布**~~（`ContentOS` → `POST /api/import/decompose` + bridge `extensions.open`）
2. ~~实现 `CanvasImportPayload` + 画布按镜铺节点~~（关键帧图节点 + Seedance）
3. Seedance 默认 Agent Plan（已有协议适配）
4. 成片下载按钮 + 提示「可保存到素材中心」
5. ~~**短剧导演台**：分镜工坊 Step5 出片 + Step1 创意生剧本~~（对标小云雀；对照 LocalMiniDrama/Toonflow，不 fork——见 [`short-drama-oss-refs.md`](./short-drama-oss-refs.md)）

**双主路径（勿混）：**

| 路径 | 入口 | 说明 |
|------|------|------|
| 爆款复刻 | 爆款洞察 → 拆解 → 打开画布 | ContentOS 找灵感 / 复刻 |
| 原创短剧 | 创作画布 → 分镜工坊 1→5 | 创意→剧本→资产→分镜→Seedance 出片 |

### P2 — 闭环

1. 成片 / 关键帧自动入库素材中心  
2. 运营中台发布选素材  
3. 多镜拼接 + 字幕（EvoFlow media-post，画布只触发）  
4. Manifest `kind: suite` 写入标准，商店按套件上架
### P3 — 减本地负担（可选）

1. ContentOS / 画布改为可选云端托管入口（`service.mode=none` + 远程 URL）  
2. 拆解重活上云；本地只留轻 UI  
3. 这样「别人」甚至不用起两个本地端口

---

## 6. 原则（写进产品决策）

1. **对外一个套件，对内可多模块** — 用户装的次数 ≈ 1，不是 4。  
2. **侧栏入口 ≤ 4（本业务）** — 再细的能力进页内 Tab，不要新插件。  
3. **拆解出蓝图，画布出片，EvoFlow 出算力** — 不在 ContentOS 里再造一套 Seedance。  
4. **预装优先于市场** — 你们的主线能力应随客户端带走；市场留给第三方。  
5. **可裁剪 ≠ 多安装项** — 高级开关放设置，不放「再装一个扩展」。

---

## 7. 一句话答复「别人是不是要装很多插件？」

**不应该。**  
正确形态是：装 **EvoFlow**（或再点一次 **内容创作套件**）→ 侧栏四个入口都是同一套件展开的 → 填一把 Agent Plan Key → 就能拆爆款并在画布出片。  

今天开发机上的「四个扩展」只是实现细节；产品交付必须收成 **一个套件 + 一条主路径**。
