# EvoFlow Design System

Portable design system for AI-assisted UI work in this repository.
Heavily inspired by ZCode's DESIGN.md with adaptations for EvoFlow's product character.

This file is meant for coding agents. When generating or editing UI in this repo, follow this file before inventing new visual rules.

---

## 最高优先级 UI 约束：字号令牌

EvoFlow 当前处于**字号体系迁移期**，两套刻度并存：

### [新] `--ef-text-*`（推荐，新代码一律用这套）

单一派生基座，改 `--ef-font-size` 整套联动：

| 令牌 | 公式 | 默认 | 用途 |
| --- | --- | --- | --- |
| `--ef-text-2xs` | `--ef-font-size - 5px` | 9px | 仅限图表轴标签/通道码 |
| `--ef-text-xs` | `--ef-font-size - 4px` | 10px | tooltip快捷键、徽章、弱元数据 |
| `--ef-text-sm` | `--ef-font-size - 2px` | 12px | 次级说明、tooltip正文、markdown行内代码 |
| `--ef-text-base` | `--ef-font-size` | 14px | 界面正文、按钮、workspace标题 |
| `--ef-text-lg` | `--ef-font-size + 2px` | 16px | h2/二级阅读标题 |
| `--ef-text-xl` | `--ef-font-size + 4px` | 18px | h1/一级阅读标题 |
| `--ef-text-mobile-input-safe` | 固定 | 16px | iOS input 防聚焦缩放 |

### [旧] `--font-size-*` / `--chat-font-size-*` / `--chat-tier-*`（历史值，勿改）

`11 / 12 / 13 / 14 / 16 / 20px` 六档，另有 chat 专用四档。**这些值与新刻度不重合**（例如旧 `--font-size-lg` 是 14px，新 `--ef-text-lg` 是 16px），因此**不可用 alias 互相映射**——那会造成全局字号偏移。

**规则：**
- 新增代码 / 改动到的代码 → 改用 `--ef-text-*`
- 未触及的旧代码 → 保留旧 token，**不要顺手改值**
- 禁止内联 `font-size: 13px` 等任意值
- 禁止 Tailwind 裸值 `text-sm`、`text-[13px]`
- 图标/间距/圆角**不**跟随字号缩放
- 内容层（代码、终端、Diff）保持独立 font-size，不受此约束

### 用户字号缩放：两套刻度都挂在同一个 `fontScale` 上

设置页「字体大小」滑块（`general.js`，范围 0.85–1.5，默认 0.9）写入
`evopanel/src/lib/font-size.js` 的 `applyFontSizePreference()`，它同时设置两批变量：

```
--font-size-* / --chat-font-size-*   ← 旧刻度直接乘 scale
--ef-font-size = 14px × scale        ← 新刻度基座，--ef-text-* 由它 calc 派生
```

**因此新增 `--ef-text-*` 引用会自动响应用户字号设置，不需要额外接线。**
反过来说，若新增一个不挂在 `--ef-font-size` 上的字号变量，用户调滑块时它不会动。

> ⚠️ 别把 `--ef-font-size` 写成 `var(--ef-text-base)`：`--ef-text-base`
> 本身就是 `var(--ef-font-size)`，会形成循环引用导致整条刻度失效。
> 它必须保持字面量。

存量硬编码用 `npm run lint:font-size` 查看分布（当前约 1522 处，迁移期只报告不失败）；
清完后改用 `npm run lint:font-size:strict` 接入 CI 阻断新增。

---

## 产品性格

EvoFlow 是智能体驱动的企业工作空间。界面应当感觉**冷静、密集、可操作**，而非装饰性。

设计面向：
- 长会话、高信息密度
- 可读的聊天与工具输出
- 键盘驱动工作流
- 桌面端与 Web 端对等体验
- 多语言文本长度容错

避免：
- 过度营销风格的间距
- 默认 UI 语言里的活泼渐变
- 大面积品牌色填充
- 背景/卡片/popover 之间模糊的层次

---

## 圆角层级（按容器嵌套递减）

规则同 ZCode DESIGN.md：不要因尺寸大或重要性而擅自升到 `2xl`。

| 层级 | 半径 | 适用场景 |
| --- | --- | --- |
| 首层容器 | `xl` (12px) | 对话气泡、卡片、工具块 |
| 嵌套内容 | `lg` (10px) | 菜单项hover、输入框内嵌按钮 |
| 深层控件 | `md` (8px) | Select触发器、Tab控件 |
| 最小控件 | `sm` (6px) | Checkbox、Radio、小型Badge |
| 完整圆 | `full` | 仅限Pill形状或头像圆 |

**仅限 2xl (14px) 的例外：**
- 主聊天输入壳
- 通知浮层
- Dialog 壳
- 品牌图标背板

**禁止：**
- 裸 `rounded`（无尺寸指定）
- 卡片 14px 里面再套 14px
- 不按层级随意加 `rounded-2xl`

---

## 语义色系统

### 轨迹角色色（固定色相，不可混用）

| 角色 | 色值 | 用途 |
| --- | --- | --- |
| `user` | `--ef-color-trajectory-user` (#2563eb) | 用户消息 |
| `assistant` | `--ef-color-trajectory-assistant` (#0f766e) | AI 回复 |
| `reasoning` | `--ef-color-trajectory-reasoning` (#7c3aed) | 推理过程 |
| `tool-call` | `--ef-color-trajectory-tool-call` (#d97706) | 工具调用 |
| `tool-result` | `--ef-color-trajectory-tool-result` (#0284c7) | 工具结果 |

### 语义状态色

| 状态 | 浅色 | 深色 |
| --- | --- | --- |
| success | `#26875a` | `#3d9b6c` |
| warning | `#b7791f` | `#d4a017` |
| error/danger | `#c94a4a` | `#d46464` |
| info | `#635bff` | `#7b74ff` |

**规则：**
- 仅用于实际语义状态。禁止用 `success` 冒充等待确认
- 等待徽章（AskUserQuestion / 权限 / ExitPlanMode）统一用 `--ef-color-confirmation` 绿色确认态

### Diff 语义色

| 类型 | 浅色 | 深色 |
| --- | --- | --- |
| added | `#16a34a` | `#4ade80` |
| removed | `#dc2626` | `#f87171` |

---

## 间距节奏

基准单元：`4px`

| 级别 | 值 | 用途 |
| --- | --- | --- |
| `--space-xs` | 4px | 紧密图标/文字间距 |
| `--space-sm` | 8px | 紧凑控件内边距、行内gap |
| `--space-md` | 12px | 紧凑列表项、菜单行 |
| `--space-lg` | 16px | 标准卡片、面板内边距 |
| `--space-xl` | 20px | 较大区块或对话框内部 |
| `--space-2xl` | 24px | 大区块间距 |
| `--space-3xl` | 32px | 页面级间距 |

---

## 组件规范

### 按钮

- Primary: `bg-primary text-primary-foreground`
- Outline: 边框+中性底+悬停
- Ghost: 透明底+悬停填充
- Destructive: 语义 destructive 填充

禁止把每个操作都升为 primary。保持操作层次清晰。

### 输入框

- 默认: `bg-input border-input-border text-foreground`
- 悬停: `border-input-border-hover`
- 聚焦: `border-input-border-focused` + `bg-input-focused`
- 默认 `rounded-lg`，按嵌套层级递减

### 卡片

- 标准: `bg-card border-card-border rounded-xl`
- 低强调容器: `bg-surface`
- 选中: `bg-card-selected`

卡片应当明显高于页面背景，但低于浮层。保持卡片表面安静。

### 菜单 / Popover / Dialog

- 菜单: `bg-menu rounded-lg shadow-md`，行高 `30px` 左右
- Popover: `bg-popover rounded-xl`
- Dialog: `bg-popover rounded-2xl`

禁止把菜单做得像卡片。菜单行应紧凑、高可扫描。

### Toast

`bg-toast rounded-2xl`，紧凑内边距，strong shadow。

---

## 阴影 / Elevation

主要靠背景对比和边框创建层次，避免大软阴影。

| 层级 | 阴影 | 用途 |
| --- | --- | --- |
| Base | 无 | 结构来自背景对比 |
| Surface | 微边框 | 低强调容器 |
| Overlay | `shadow-md` | 菜单、Popover、Dialog |
| Attention | `shadow-lg` | Toast、重要浮动卡片 |

---

## 流式交互规范

### 运行态图标策略

流式期间 toolcall 数量多且持续更新，**旋转 loading 图标**会长期占用渲染资源。改用：

- kind 文案扫光（`animated-gradient-text`）表达进行中
- 图标保持静态

### 失败态展开逻辑

错误详情挂到**状态词 tooltip**，带一键复制按钮。

好处：edit 卡成功/失败态的展开逻辑保持一致；用户 hover 时可获取报错原因。

### 折叠内容卸载时序

收起工具详情时**不能立刻卸载 children**。

Radix Collapsible 动画期间会读取 `--radix-collapsible-content-height`。如果子内容先卸载，内层高度变量消失并继承外层历史消息高度，导致详情区域短暂撑成超高空白块，下面内容看起来像全部闪没了。

解决：延迟 300ms 再卸载。

```typescript
// 示例逻辑（见 ToolLayout.tsx）
contentUnmountDelayRef.current = window.setTimeout(() => {
  setShouldRenderContent(false);
}, TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS); // 300ms
```

### 完成自动收起

子智能体执行完成后，如果继续保持展开，会把一长串子工具明细永久摊开。

在 `running → completed` 边沿自动收起一次，不影响用户后续手动再次展开查看细节。

---

## 禁止事项

- 在普通 UI 中使用原始单次颜色（如 `text-white/60`）
- 大面积填充品牌色
- 随意加半径/阴影/宽度/高度而不按稳定系统
- 把菜单做得松散（它们应当密集）
- 用语义 error/success 色做非语义装饰
- 在单一主题中创建组件外观（需支持亮/暗双主题）
- 为视觉新颖而牺牲工具密集屏幕的清晰度
