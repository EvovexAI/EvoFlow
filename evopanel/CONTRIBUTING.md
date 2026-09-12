# EvoPanel 贡献指南

EvoPanel 是 EvoFlow 的桌面/Web 管理面板（`evopanel/`）。  
仓库级流程（分支、CLA、PR、全仓 CI）以根目录 [CONTRIBUTING.md](../CONTRIBUTING.md) 为准；本文只写**面板相关**约定。

> 官网：[www.evovexai.com](https://www.evovexai.com/) · 仓库：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow) · 许可：[PolyForm Noncommercial 1.0.0](../LICENSE)

---

## 环境

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+（建议 22 LTS） | 前端 |
| Rust | stable | Tauri v2 后端 |
| 平台工具 | 见下 | 桌面构建 |

- **Windows**：Visual Studio Build Tools（C++ 桌面开发）+ WebView2  
- **macOS / Linux**：`./scripts/dev.sh` 或 `npm run dev:tauri`

```bash
git clone https://github.com/EvovexAI/EvoFlow.git
cd EvoFlow/evopanel
npm install
```

---

## 怎么跑

| 模式 | 命令 | 后端 | 用途 |
|------|------|------|------|
| Tauri 桌面 | `npm run dev:tauri`（或 `./scripts/dev.sh`） | Rust IPC + Gateway | 日常桌面开发 |
| 仅前端 | `npm run dev` / `npm run dev:web` | `scripts/dev-api.js`（`/__api/*`） | 浏览器调试 UI |

### 桌面壳（Tauri）与 Gateway sidecar

克隆后的 `src-tauri/binaries/evoflow-gateway/` **只有占位**（真实 PyInstaller 产物不进 Git）。  
`tauri.conf.json` 需要该目录存在；正式安装包请走仓库打包脚本 / 公开仓 Release Actions。

本地 `npm run dev:tauri` 推荐二选一（不要指望空目录里的 sidecar）：

1. 先起 backend（如 `make dev`，常见 `:8012`），再设 `EVOFLOW_GATEWAY_URL=http://127.0.0.1:8012`
2. 或设 `EVOFLOW_BACKEND_DIR=<仓库>/backend`（含 `.venv`），由壳进程拉起可编辑 Gateway

详见上文环境变量即可。

前端通过 `src/lib/tauri-api.js` 统一调 API：Tauri 走 `invoke`，Web 走 `fetch('/__api/…')`。页面里尽量不要直接 `fetch`。

常用检查：

```bash
npm run typecheck
npm test
```

---

## 目录速览

```
evopanel/
├── src/
│   ├── pages/          # 路由页面（多数为 Vanilla JS，导 export render）
│   ├── react/          # React 岛屿（聊天、可观测等）
│   ├── components/     # 共用组件
│   ├── lib/            # tauri-api、登录、配置等
│   ├── style/          # CSS
│   └── main.js         # 入口与路由注册
├── src-tauri/          # Tauri v2 + commands/*.rs
├── scripts/            # dev-api、dev.sh、打包与版本同步
├── public/             # 静态资源
├── tests/              # Vitest
└── package.json        # 版本号唯一真相源
```

Rust 命令在 `src-tauri/src/commands/`（如 `config`、`gateway`、`backend`、`ui_extensions`、`mcp_market` 等），在 `lib.rs` 的 `invoke_handler` 里注册。

---

## 前端约定

1. **页面**：`src/pages/xxx.js` 导出 `render()`，先返回 DOM，再异步加载数据（不要在 `render` 里阻塞式 `await` 整页数据）。
2. **路由**：`src/main.js` 里 `registerRoute('/xxx', () => import('./pages/xxx.js'))`，并改侧栏导航。
3. **API**：`import { api } from '../lib/tauri-api.js'`，例如 `api.readPanelConfig()` / `api.writePanelConfig(config)`。
4. **双模式**：需要区分时用 `!!window.__TAURI_INTERNALS__`（或复用 `panel-login.js` 里的 `isTauri`）。
5. **风格**：新增代码注释用中文；变量 camelCase；CSS kebab-case；静态资源本地化，不要挂远程 CDN。

新增 Tauri 命令时同步四步：`commands/*.rs` → `lib.rs` 注册 → `tauri-api.js` 包装 →（如有）Web `dev-api.js` handler。

---

## 配置与安全

面板配置路径：**`~/.evoflow/evopanel.json`**（不是 `~/.evopanel/`）。

常见字段：`accessPassword`、`mustChangePassword`、`nodePath`、`developer.*` 等。

安全注意：

- 不要把访问密码回传给前端或预填到登录框。
- Web 模式靠 session；桌面模式靠本地配置比对 + `sessionStorage`。
- `dev-api.js` 的公开命令集合要克制，避免未鉴权暴露敏感操作。

---

## 版本与发版（面板）

版本以 `package.json` 为准，同步到 Tauri / Cargo：

```bash
npm run version:set 1.0.0   # 写入并同步
npm run version:sync        # 仅按当前 package.json 同步
```

发版前更新 `CHANGELOG.md`。打 tag、多平台安装包等流程跟仓库根文档与 GitHub Actions（`release-desktop-public.yml` 等）走；不要在本文件重复维护过时的 workflow 清单。

---

## 提交与 PR

- 分支 / Conventional Commits / CLA：见根 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [CLA.md](../CLA.md)。
- PR 尽量只改面板相关文件；说明如何本地验证（`dev:tauri` 或 `npm run dev` + 相关页面）。
- 许可与品牌：勿再引入第三方产品名残留；文案里不要写「完全开源」（本项目为源码可见 · 非商业许可）。

---

## 问题反馈

Bug / 需求：[GitHub Issues](https://github.com/EvovexAI/EvoFlow/issues)  
安全问题：见仓库 [SECURITY.md](../SECURITY.md)（若面板侧有 `evopanel/SECURITY.md` 也可对照）。
