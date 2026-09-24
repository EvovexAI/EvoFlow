# 强调色色卡全局生效 —— 残余硬编码清单

> 维护日期：2026-09-24
> 分支：`fix/accent-theme-global-coverage`
> 本次提交**已修复**的：色卡默认色与 variables.css 不一致、ACCENT_VARS 覆盖不全、--brand-* 不跟随色卡、--shell-* 不覆盖、React 内联硬编码（avatar）。
> 本文件列出**剩余未处理**的硬编码位置，便于后续清理时一次性引用。

## 本次未动 · 列出仅供查阅

| 文件 | 行 | 内容 | 说明 | 建议 |
|------|----|------|------|------|
| `evopanel/src/pages/knowledge-owned-reader.jsx` | 112-172 | `#4f7cff` `#8b5cf6` `#22d3ee` SVG stopColor | 知识库 hero 装饰插画 | 装饰插画，非主题色，可保持 |
| `evopanel/src/pages/knowledge-owned.jsx` | 195, 200 | `#0064DB`（active 填充） | 知识库 nav active 态 | 建议后续抽 `--ko-active-fg` |
| `evopanel/src/pages/AssetCenterContent.tsx` | 1519 | `text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]` | Tailwind 类硬编码灰阶 | 改成 CSS 变量或 theme token |
| `evopanel/src/main.js` | 1301-1302 | `#18181b` `#71717a` 加载失败页 | 错误页 hardcoded | 改成 `var(--text-primary)` 等 |
| `evopanel/src/main.js` | 283, 294, 321, 326, 353 | `var(--error, #ef4444)` `var(--success, #22c55e)` | 错误/成功状态色 | **故意不动** —— 语义色必须独立 |
| `evopanel/src/components/shell-aside.js` | 562, 567 | `var(--warning, #f59e0b)` `var(--error, #ef4444)` | 服务健康指示点 | **故意不动** —— 语义色必须独立 |

## 本次修复对比（diff 摘要）

- `evopanel/src/lib/accent-theme.js`（重写）：
  - 取消 `--bg-*` 系列覆盖（避免背景染色）
  - ACCENT_VARS 新增 `--brand-primary` `--brand-blue` `--brand-purple` `--accent-secondary` `--info` `--info-muted` `--code-block-fg` `--code-inline-fg` `--hl-keyword` `--hl-func` `--shell-brand-softer` `--shell-active-bg` `--shell-active-fg` `--shell-aside-active-bg` `--shell-aside-active-fg`
  - 修复 default 色卡（旧 `#5b5fef` → 新 `#635bff`，与 variables.css 一致）
  - 修复 blue 色卡（旧 `#5b5fef` 与 default 重复 → 新 `#3b82f6` 真蓝）
  - 新增 `window.__evopanelDebugAccent` 调试入口
- `evopanel/src/style/react-chat.css:14223`：渐变 `var(--brand-blue, #4169f5) → var(--brand-purple, #9065f8)` 改为 `var(--accent) → color-mix(--accent 65%, white)`
- `evopanel/src/style/layout.css:618` `.update-banner`：渐变同步改为跟随 `--accent`
- `evopanel/src/style/layout.css:711` `.update-progress-bar-fill`：`var(--brand-blue)` → `var(--accent)`
- `evopanel/src/react/lib/agent-avatar.ts:30`：avatar palette 第一项 `#635bff` → `var(--accent, #635bff)`（React inline style 兼容 CSS 变量）

## 调试用法

```js
// 在 DevTools Console 打开后生效
window.__evopanelDebugAccent = true
// 切换色卡或自定义色时会打印所有被覆写的 CSS 变量当前值
```

## 验证步骤

1. 启动 evopanel dev server
2. 进入设置 → 外观 → 强调色
3. 依次切换 blue / violet / cyan / emerald / amber / rose / slate
4. 检查：
   - 主按钮、icon hover、复选框、tab 选中态 → 主色
   - 顶栏 / 侧栏 active 项底色 → 主色浅底
   - 代码块左侧高亮条、内联 code 底色 → 主色
   - 启动条、loading 进度条 → 主色
   - 错误 / 警告 / 成功指示色 → **保持不变**（语义色）
   - 头像 hash 出的第一个色 → 跟随主色
5. 切到自定义色 hex → 同样验证
6. 切深色 / 浅色 → 验证 dark 系列重算