# 小云雀网页版 · UI / 节点 / 布局完整分析

> 来源：离线包 `小云雀网页版.html` + `main.*.js` / `100391.*.js`（约 12MB×2）  
> 原始提取：`temp/xiaoyunque-ui-extract/`  
> **本文只做拆解与对照，不实现。**

---

## 0. 一句话结论

小云雀不是「通用 Prompt→生成→Output 电路图」。它是：

**短剧流水线（剧本→资产→分镜→Seedance）** 叠在 **语义化节点画布（role/scene/image/video…）** 上；  
连线只是一致性手段之一，**资产引用 / @标签 / 分镜卡 / 时间线** 才是主路径。

对标我们时：学**对象模型与壳层布局**，不要抄整站，也不要只抄边。

---

## 1. 产品双轨（必须分清）

| 轨道 | 入口文案 | 主 UI | 目标 |
|------|----------|-------|------|
| **短剧流水线** | 上传/AI 剧本 → 资产提取 → 分镜编辑 → 出片 | 步骤条 + 资产 Tab + 分镜编辑器 + 时间线 | 整集/整剧一致性出片 |
| **自由画布** | 「跳过剧本，可直接进入画布」「自由画布」 | React Flow 工作区 + 左轨 + 侧栏 Agent | 节点级拼装与试验 |

离线快照项目（丧尸清道夫）同时露出：全局比例、角色/场景节点、资产库左轨、「进入分镜脚本生成」下一步入口——说明**画布是资产车间，分镜是出片车间**。

---

## 2. 整体壳层布局

从 CSS module（`page / workspace / canvasStage / sidePanelArea…`）与 aria 文案还原：

```
┌─────────────────────────────────────────────────────────────┐
│ 顶栏：导航 · 项目名 · 全局比例 · 只读/会员 ·「下一步」入口     │
├────┬──────────────────────────────────────────┬─────────────┤
│左轨│              画布舞台 (React Flow)         │  侧栏面板   │
│    │  · 节点卡片 / 边 / 小地图 / 空态快创        │  · Agent    │
│ +节点│  · 选中浮动条 selectionToolbar            │  · 资产详情 │
│ 资产库│  · 生成面板 generationPanel（贴节点）     │  · 可 resize │
│ 帮助 │                                            │             │
├────┴──────────────────────────────────────────┴─────────────┤
│ （分镜模式）底部/全屏：storyboardEditor + timeline           │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 左轨 `leftRail`（默认三项）

代码默认：`["add-node", "asset-library", "help"]`  
快照 aria：`画布左侧菜单` / `资产库` / `帮助`；另有重置、隐藏边、展示角色和场景、小地图、缩放。

### 2.2 侧栏 `sidePanels`

可注册、可拖拽改宽（`sidePanelResizeHandle` / `sidePanelRestoreButton`）。  
Agent 对话、资源详情等多挂这里；画布节点可「添加到对话」。

### 2.3 视口工具条 `viewportToolbar` + 侧栏工具条 `sidebarToolbar`

缩放、吸附、布局策略入口；与「选中工具条」分离。

### 2.4 全局叠层 `globalOverlays`

空态快创、加载/错误/同步失败遮罩、各类 Modal。

---

## 3. 节点类型与职责（画布一等公民）

### 3.1 官方节点 kind（模块常量）

完整集合：

| kind | 中文标签 | 职责 |
|------|----------|------|
| `text` | 文本 | 设定、台词、剧情说明 |
| `image` | 图片 | 分镜图、角色/场景设定图 |
| `panorama` | 全景 | 720° 全景 / 场景扩展 |
| `video` | 视频 | 片段、参考运镜、成片 |
| `audio` | 音频 | 音效、旁白 |
| `role` | 角色 | 角色资产节点（多形象/表情） |
| `scene` | 场景 | 场景资产节点（多机位图） |
| `scene3d` | 3D 导演台 | 镜头预演、构图与走位（可回灌画布） |

默认可新建（creatable）：

```text
role · scene · text · image · video · audio
（小说详情等场景可再挂 scene3d）
```

左轨「加节点」与**连线菜单可创建 kind**共用同一列表。

### 3.2 节点不是「API 生成器」

每个 kind 自带媒体/资产语义；**生成是节点上的动作/底部生成面板**，不是单独的 Generator/Output 节点类型。

角色节点能力（文案证据）：

- 基础形象 / 主设定形象 / 默认形象  
- 表情九宫格、角色三视图、角色特写  
- 形象音色、出现集数、主角标记  
- 批量「生成所有形象图」

场景节点能力：

- 场景图 / 设定图批量生成  
- 多机位（全景·中景·特写）叙事  
- 可进 3D 导演台 / 全景历史  

媒体节点能力：

- 图片：局部编辑、引用到输入框、素材保存  
- 视频：截帧注释、智能切割分镜、提升画质、字幕擦除、重拍/续接片段  
- 音频：裁剪后「保存成新节点」

### 3.3 画幅枚举

`CanvasRatio16To9 / 9To16 / 1To1 / 4To3 / 3To4 / 2To1 / 21To9 / 2_35To1 / 1_85To1 / Original / Custom…`  
支持**全局比例**一键应用。

---

## 4. 连线规则（完整矩阵，非启发式）

源码 `G6` 默认邻接（`allowedEdgeTargets`）：

| 源 → | 可连目标 |
|------|----------|
| **text** | text, image, panorama, video, audio, role, scene |
| **image** | image, panorama, video, audio, role, scene, scene3d |
| **panorama** | image, panorama, video, role, scene, scene3d |
| **video** | video（仅同类） |
| **audio** | audio, video |
| **role** | image, panorama, video, audio, **role** |
| **scene** | image, panorama, video, scene, scene3d |
| **scene3d** | （无出边） |

补充语义：

- 边类型常见为 `reference`（引用边），不是「数据流管道」心智。  
- UI 文案：**连线素材** / **连线图片** / **连接入口**。  
- 连出时弹出 `connectedNodeMenu`：可选已有节点或**现场创建** creatable kind。  
- `enableRoleReferenceSelection`：角色引用有特化提交流程。  
- 拒绝连线有 `xyqConnectionRejectionMessage`。  
- 边工具条：删除、编辑边标签。

**含义**：连线 =「把 A 当作 B 的参考/依赖」，不是 Comfy 式强制数据流。

---

## 5. 节点卡片与生成 UI 解剖

### 5.1 选中工具条 `selectionToolbar`（功能簇）

从 CSS module 键可见分组：

| 分组 | 能力 |
|------|------|
| Main / Utility | 主操作 + 次要工具 |
| Arrangement | 水平/垂直/宫格/导图排列；打组/解组 |
| Group execute | 组级批量执行 |
| Group background | 组背景色 |
| Role appearance | 绑定角色形象、头像、错误态 |
| Image operation | 图片操作菜单 |
| Material save | 保存到素材库 |
| Frame annotation | 视频截帧注释状态条 |
| More / VIP / 限免 | 扩展与权益标记 |

另有：`edgeToolbar`、`canvasFloatingMenu`（含 shortcut 展示）。

### 5.2 贴节点生成面板 `generationPanel`

结构键：

- `generationReferences` + `referenceChip`（参考芯片，可来自连线/资产/@）  
- `generationPrompt`（内联提示词；占位：「描述你想要生成的画面内容，@引用素材」）  
- `generationMeta`（模型、比例、积分、更多设置）

→ **Prompt 住在生成面板里，不单独占节点。**

### 5.3 右键 / 空态

画布菜单默认项：`upload-local-file · add-node · paste · undo · redo`  
另有「优化工作流布局」、复制/副本/删除。  
空态：`canvasEmptyQuickCreate` 快创按钮。

### 5.4 插件贡献点（扩展架构）

```
nodes.registerCreatable / registerTypes
edges.allow
connectionMenu.registerCreatable
leftRail.register
sidePanels.register
toolbar / viewportToolbar / selectionToolbar.register
nodeCoverActions / nodeContextMenu
canvasContextMenu (+ ActionProvider)
globalOverlays.register
```

画布是**可插拔工作台**，短剧/3D/Agent 都是插件贡献，而不是写死在一张 HTML 里。

---

## 6. 资产库（左轨核心）

### 6.1 Tab 模型（短剧画布）

`角色 | 场景 | 道具 | 素材`（另有全部）

创建路径三角：

1. 本地上传  
2. 从小云雀资产库选择  
3. 去画布创建 / 在画布中创建  

### 6.2 资产库 Picker（全局）

- Tab：角色库、商品库、最近使用、历史上传、作品…  
- 角色：真人 / 非真人  
- 排序：最新/最早；视图大小；搜索；批量下载  
- 状态：上传中、不可用、排队、生成中、失败、待补充  

### 6.3 资产 ↔ 节点

- 角色/场景**首先是画布节点**；库是索引与批量操作面。  
- 空态文案：「暂无角色节点 → 去画布创建角色节点」。  
- 子对象：角色→形象；场景→场景图；可挂表情变体。  

### 6.4 剧本资产拆解（流水线特有）

卖点文案：

- 整部剧角色/妆造/场景一次拆成可用资产  
- 镜头级资产引用  
- 同一角色全程一张脸  
- 场景多机位拆解  

---

## 7. 分镜台 / 时间线（出片主路径）

### 7.1 分镜编辑器结构

CSS：`storyboardEditorWrapper / Content / Fallback`  
镜头卡：`shotCard`（header / title / duration / description / voiceovers…）  
时间线：`timelineContainer / timelineLine / storyboardCard / unifiedCard`  
智能预演：`smartStoryboard*`（VIP 标签、片段选择）

### 7.2 Shot 卡能力（功能清单）

| 能力 | 证据 |
|------|------|
| 镜头时长（秒） | aria / placeholder |
| 子分镜描述 + @引用角色/素材/场景 | placeholder |
| Prompt XML 标签：`role` / `location` / `product` | `storyboardXmlTag*` |
| 镜头运动关键词 | 固定/摇/移/推/穿越…（与 3D 机位共用词表） |
| 截取当前帧 / 首帧 / 尾帧 → 素材库 | 一组 toast/loading |
| 提升画质、下载视频 | tooltip |
| 删除分镜、切换集数、历史版本 | aria / title |
| 智能预演 / 智能切割分镜 | 按钮与片段选择 |
| 片段重拍、续接片段、循环/连播 | sandbox hover tip |

### 7.3 脚本时长策略

- 15s 上限：适配全系 Seedance，灵活抽卡  
- 30s 上限：发挥 Seedance 2.5，长短镜头 + 高一致性  

### 7.4 与画布的衔接

顶栏「确认角色和场景后，进入分镜脚本生成」——资产车间验收后才进分镜。

---

## 8. Agent 侧栏

| 能力 | 说明 |
|------|------|
| 创意助手对话 | 消息详情可展开 |
| 生成参数回显 | 图/视频模型、分辨率、画幅、模式、seed、原始提示词 |
| 技能 Skill | 输入区「技能」按钮；对话创建 Skill |
| 画布→对话 | 「添加到对话」；需先打开对话面板 |
| 局部编辑 | Image Agent：框选区域 + 描述 → 插入输入框 |
| 短剧 Agent | 流水线专用线程；缺配置则无法提交生成 |
| 营销 Agent | 首页侧栏入口（另一产品面） |

Agent **不是替代画布**，而是驱动创建/改节点与提交生成任务的编排层。

---

## 9. 生成与 Seedance（产品层）

模型族（文案）：Seedance 2.0 Mini / Fast VIP / VIP / 2.5…  
能力差异文案：轻量 480/720；极速/全模态「音视文图均可参考」。

生成态：排队中 / 生成中 / 失败重试 / 限免 / 积分预估。  
完成通知：可回画布继续编辑。  
视频后处理：提升画质、字幕擦除、扩展视频、智能长视频等。

---

## 10. 3D 导演台（scene3d）

独立全屏工作台，能力簇：

- 镜头调节 / 机位预设（过肩等）  
- 镜头运动词表（固定、上摇/下摇、左右摇、升降、左右移、前推后移、穿越）  
- AI 识图导入、摄像机素材回灌画布  
- 图片历史 / 720° 全景历史  
- 保存为素材  

出边为空：它是**沉浸编辑器**，结果以素材/节点形式回到画布，而不是继续拉线。

---

## 11. 短剧流水线步骤（壳层叙事）

还原主路径：

```
创意/上传剧本
  → 剧本解析 / 摘要 / 分集
  → 资产提取（角色·妆造·场景）
  → 画布确认资产（形象/场景图生成）
  → 分镜脚本生成
  → 分镜编辑（时长·运动·@引用）
  → Seedance 出片
  → 预览 / 重拍 / 下载（含剪映）
```

可旁路：跳过剧本 → 自由画布；跳过剧本生成 → 直接资产拆解。

---

## 12. 与 Infinite-Canvas（我们）对照

| 维度 | 小云雀 | Infinite-Canvas 现状 | 差距性质 |
|------|--------|----------------------|----------|
| 节点语义 | role/scene/image/video/audio/text/scene3d | image / generator / output / seedance / prompt(曾) | **对象模型** |
| Prompt | 生成面板内联 + `@` / XML 标签 | 已改内联；无资产标签 | 交互细节 |
| 参考 | 引用边 + Ref 芯片 + 资产库 | 多图画线到 generator | 易乱线 |
| 资产库 | 一等左轨 + 四 Tab | 弱/无 | **布局** |
| 分镜 | Shot 卡 + 时间线 + 智能预演 | 无 | **主路径缺失** |
| 出片 | Shot 动作 / 批量 | 独立 Seedance 节点 | 耦合方式 |
| Agent | 侧栏驱动建点与生成 | 弱耦合 | 编排 |
| 壳层 | 顶栏步骤 + 左轨 + 侧栏 + 选中条 | 偏单页画布 | 信息架构 |
| 插件化 | 贡献点齐全 | 单体 canvas.html | 架构 |

---

## 13. 对齐优先级（分析结论 · 仍不实现）

按「学语义、不 fork」排序：

1. **节点语义重构**  
   至少：`role` / `scene` / `image` / `video`（+ 内联生成），淘汰「Generator/Output 电路」作为主叙事。  
2. **资产库左轨**  
   角色/场景/道具/素材 Tab；创建=上传|库选|画布落点。  
3. **生成面板 = Prompt + 参考芯片 + 模型/比例**  
   参考来自连线或 `@`，不单独 Prompt 节点。  
4. **引用边规则简化版**  
   先实现：`role/scene/image → image/video`；边类型=reference。  
5. **Shot 节点（分镜最小闭环）**  
   主画面 + 时长 + 内联 prompt + Seedance；refs 挂卡上。  
6. **轻量时间线**  
   多 Shot 排序与批量出片（不必先上智能预演）。  
7. **Agent 侧栏**  
   自然语言建角色/场景/Shot 并提交生成。  

明确不做（现阶段）：3D 导演台、表情九宫格、会员通道文案、剪映导出、整站短剧步骤条 1:1 复刻。

---

## 14. 证据索引

| 产物 | 路径 |
|------|------|
| 本分析 | `docs/system/design/xiaoyunque-ui-analysis.md` |
| 早期笔记 | `temp/xiaoyunque-canvas-model.md` |
| CSS 壳层/工具条/分镜模块 | `temp/xiaoyunque-ui-extract/css-module-groups.md` |
| i18n 分主题 | `temp/xiaoyunque-ui-extract/i18n-themes.md` |
| 节点邻接矩阵源 | `temp/xiaoyunque-ui-extract/module-308942.txt`（`G6`） |
| 功能中文桶 | `temp/xiaoyunque-ui-extract/feature-buckets.md` |
| 快照 aria | `temp/xiaoyunque-ui-extract/html-aria-cn.txt` |

---

## 15. 下一步（等你拍板）

分析已齐。实现前建议先定一条产品轨：

- **A. 自由画布轨**：先做语义节点 + 资产库 + 生成面板（最贴近小猫 E2E）。  
- **B. 分镜轨**：先做 Shot 卡 + 时间线 + Seedance（最贴近小云雀出片）。  
- **C. 双轨最小集**：role/scene/image + Shot，时间线可后置。

你选轨之后，再落到 Infinite-Canvas 的具体改造清单。
