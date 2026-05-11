# 🤖React 聊天前端 UI 风格参考（布局/配色/渐变/交互）

> 目标：保证 React 聊天页（`ChatApp.tsx` 及其子组件）整体风格一致，避免出现“黑白原生控件 / 单独边框隔离 / 下拉方向不统一 / 弹窗风格不一致”等问题。

***

## 1. 全局配色与渐变（淡紫/淡蓝，高级感优先）

建议统一使用如下“蓝紫渐变”区间（与当前实现对齐）：

- 主强调色（文字/hover/选中态）：`var(--accent, #2563eb)`
- 浅蓝/淡紫背景与阴影：使用 `rgba(37, 99, 235, 0.XX)` 与 `rgba(165, 180, 252, 0.XX)` 的组合
- 例如常用渐变：
  - 底部 hover：`linear-gradient(180deg, rgba(0, 0, 0, 0.03), rgba(0, 0, 0, 0.01))`
  - 托管/模态卡片底：`linear-gradient(180deg, rgba(165, 180, 252, 0.26), rgba(255, 255, 255, 0.96))`

圆角建议统一在：

- 卡片/弹窗：`12px ~ 14px`
- 按钮 pill：`999px`

阴影建议优先用“蓝色轻阴影”而不是纯黑硬阴影：

- `box-shadow: 0 14px 40px rgba(37, 99, 235, 0.16)`
- 或更轻：`0 10px 28px rgba(37, 99, 235, 0.12)`

***

## 2. 底部面板（输入框下方整体区域）

### 2.1 整体不隔离

- 底部容器：`.react-chat-bottom-area`
- 规则：底部容器是“一个整体面板”，不要给每个控件套一个额外大框。
- 交互：进入底部区域或 focus-within 时，底部整体出现淡蓝渐变阴影。

当前关键样式（已实现）：

- `.react-chat-bottom-area`
- `.react-chat-bottom-area:hover, .react-chat-bottom-area:focus-within`

### 2.2 选择控件（pill + 统一 hover）

- pill 容器：`.react-chat-bottom-pill`
- 选择控件：模型/智能体/托管/创意/等均应尽量复用同一类体系
- 下拉内容：`.react-chat-bottom-dropdown`

统一规则：

1. 默认态尽量透明/低存在感（不要“每个选项一个黑白框”）
2. hover/打开时才出现明显渐变区域
3. disabled 态不出现彩色阴影（只保持灰度和 cursor）

### 2.3 下拉方向：向上弹出

底部下拉（模型/智能体/创意等）：

- `position: absolute`
- `bottom: calc(100% + 10px)`（向上展示）

下拉项：

- `.react-chat-bottom-dropdown-item`
- hover 态：非 active 为灰色背景（避免所有项都变“彩色”）
- active/选中项：使用 `rgba(37, 99, 235, 0.12)` + 强化文字色

***

## 3. Token 顶部显示（与旧版对齐）

建议将 token 显示做成窄条 mono 字体 + 可 hover 的高级质感：

- JSX：`↑input ↓output · Σtotal`
- CSS：`.react-chat-tokens`
  - mono：`font-family: var(--font-mono, ui-monospace, ...)`
  - hover：出现蓝色轻阴影

***

## 4. 新建智能体弹窗（与托管弹窗保持同一套 UI）

### 4.1 不要使用 `window.prompt / window.confirm`

统一使用 React Modal 组件样式：

- overlay：`.react-chat-modal-overlay`
- 卡片：`.react-chat-modal-card`
- header：`.react-chat-modal-header`
- input：`.react-chat-modal-input`
- 按钮容器：`.react-chat-modal-actions`
- 按钮：
  - `.react-chat-modal-btn`
  - `.react-chat-modal-btn--ghost`
  - `.react-chat-modal-btn--primary`

模态弹窗结构示例：

```tsx
{newAgentModalOpen ? (
  <div className="react-chat-modal-overlay" role="dialog" aria-modal="true">
    <div className="react-chat-modal-card">
      <div className="react-chat-modal-header">
        <strong>新建智能体</strong>
        <button className="react-chat-modal-close">×</button>
      </div>
      <div className="react-chat-modal-body">
        <label className="react-chat-modal-label">Agent 名称</label>
        <input className="react-chat-modal-input" />
        <div className="react-chat-modal-hint">提示说明</div>
      </div>
      <div className="react-chat-modal-actions">
        <button className="react-chat-modal-btn react-chat-modal-btn--ghost">取消</button>
        <button className="react-chat-modal-btn react-chat-modal-btn--primary">创建</button>
      </div>
    </div>
  </div>
) : null}
```

### 4.2 风格要求

- 卡片背景通常保持纯白（`#fff`），顶部可只保留非常淡的蓝紫线性渐变
- 输入框：圆角 + 淡蓝边框，focus 时出现蓝色 focus-ring
- primary 按钮：淡蓝紫渐变填充
- ghost 按钮：浅底 + 蓝色边框，hover 时出现轻阴影

***

## 4.3 托管弹窗头部淡化（避免过重）

- 托管弹窗顶部 header 的蓝紫渐变与底部分割线需要保持“很淡”的强度（透明度约 `0.06 ~ 0.08` 区间），不要让顶部显得抢眼。

## 5. 开发落地 Checklist（防止风格再次“跑偏”）

1. 底部所有交互控件优先使用 `.react-chat-bottom-*` 体系
2. 下拉统一向上弹出（`bottom: calc(100% + ...)`）
3. active 才走彩色渐变；非 active hover 保持灰色（除非产品明确要求）
4. 不在页面里混用 `window.prompt` 这种原生弹窗
5. 新弹窗优先参照 `.react-chat-modal-*` 类名体系

