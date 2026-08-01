# 将自己的项目安装为 EvoFlow UI 扩展

> 本文档面向**项目开发者**：你想把自研的 Web 应用（React/Vue/静态页/任何 http 服务）嵌入 EvoPanel，让它在侧栏「扩展」分组里出现，点击就能打开。

---

## 目录

1. [快速起步：三步完成](#1-快速起步三步完成)
2. [场景一：纯远程页面（无本地服务）](#2-场景一纯远程页面无本地服务)
3. [场景二：带本地服务的项目（managed）](#3-场景二带本地服务的项目managed)
4. [场景三：外部已有服务（external）](#4-场景三外部已有服务external)
5. [Manifest 字段速查](#5-manifest-字段速查)
6. [Bridge 协议：让页面与 EvoFlow 通信](#6-bridge-协议让页面与-evoflow-通信)
7. [常见问题](#7-常见问题)

---

## 1. 快速起步：三步完成

### 第 1 步：写 `evoflow.extension.json`

在你的项目根目录创建一个 `evoflow.extension.json`，这是 EvoFlow 识别扩展的唯一依据。

**最小示例（纯远程页面）：**

```json
{
  "schema": 1,
  "id": "my-ops-dashboard",
  "name": "运营看板",
  "version": "1.0.0",
  "nav": {
    "title": "运营看板",
    "group": "extensions",
    "order": 100
  },
  "ui": {
    "kind": "webview",
    "entry": "http://localhost:5173"
  },
  "permissions": ["embed"],
  "service": {
    "mode": "none"
  },
  "bridge": {
    "origin_allowlist": [
      "http://localhost:5173",
      "http://127.0.0.1:5173"
    ]
  }
}
```

### 第 2 步：安装到 EvoFlow

打开 EvoPanel → **设置 → 扩展**，根据你的场景选择：

| 按钮 | 适用场景 |
|------|----------|
| **选择本地文件夹** | 项目在本地硬盘上，含 `evoflow.extension.json` |
| **导入 zip** | 打包成 zip 分发 |
| **添加远程入口** | 项目已部署到外网服务器 |

最简单的：点 **「选择本地文件夹」**，选你的项目目录（含 `evoflow.extension.json` 的那一层），点确定。

### 第 3 步：打开

安装后侧栏「扩展」分组里就会出现你的入口，点击即可在右侧 iframe 中打开你的页面。

---

## 2. 场景一：纯远程页面（无本地服务）

> 你的项目已经部署到线上（或本地 `npm run dev` 启动后你能访问），EvoFlow 不需要帮你启动任何东西。

### 适用

- 已有的生产环境页面
- 纯静态页面（HTML 文件）
- 你手动 `npm run dev` 启动的开发服务器

### Manifest

```json
{
  "schema": 1,
  "id": "my-dashboard",
  "name": "我的仪表盘",
  "version": "1.0.0",
  "description": "一个简单的远程页面",
  "nav": {
    "title": "仪表盘",
    "group": "extensions",
    "order": 80
  },
  "ui": {
    "kind": "webview",
    "entry": "http://localhost:5173",
    "sandbox": [
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-popups"
    ]
  },
  "permissions": ["embed"],
  "service": {
    "mode": "none"
  },
  "bridge": {
    "origin_allowlist": [
      "http://localhost:5173",
      "http://127.0.0.1:5173"
    ]
  }
}
```

### 安装方式

1. 点 **「选择本地文件夹」** → 选项目根目录
2. 或点 **「添加远程入口」** → 填 `id`、`名称`、`入口 URL`

> 注意：`service.mode=none` 时，EvoFlow 不会帮你启动任何进程。你需要自己提前启动服务。

---

## 3. 场景二：带本地服务的项目（managed）

> 你的项目需要在**本地跑一个进程**（Node.js / Python / Go 等），且你想让 EvoFlow 自动帮你管理这个进程的生命周期（启动、健康检查、停止）。

### 适用

- 前后端一体项目，需要 `npm run dev` 或 `python main.py` 启动
- 不希望用户手动敲命令，想让 EvoFlow 一键启动
- 多个扩展共享同一个后端服务（如 ContentOS `:3001`）

### 示例：React 项目（Vite）

```json
{
  "schema": 1,
  "id": "my-react-app",
  "name": "我的 React 应用",
  "version": "1.0.0",
  "description": "一个用 Vite 构建的 React 应用",
  "icon": "./icon.svg",
  "nav": {
    "title": "React 应用",
    "group": "extensions",
    "order": 50
  },
  "ui": {
    "kind": "webview",
    "entry": "http://127.0.0.1:5173",
    "sandbox": [
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-popups"
    ]
  },
  "permissions": [
    "embed",
    "context.read"
  ],
  "service": {
    "mode": "managed",
    "cwd": ".",
    "hint": "启动 Vite 开发服务器，端口 5173",
    "start": {
      "windows": ["npm.cmd", "run", "dev"],
      "default": ["npm", "run", "dev"]
    },
    "healthcheck": {
      "url": "http://127.0.0.1:5173",
      "timeout_ms": 60000
    },
    "stop": "port",
    "ports": [5173]
  },
  "bridge": {
    "origin_allowlist": [
      "http://127.0.0.1:5173",
      "http://localhost:5173"
    ]
  }
}
```

### 示例：Python FastAPI 项目

```json
{
  "schema": 1,
  "id": "my-python-api",
  "name": "Python 服务",
  "version": "1.0.0",
  "description": "FastAPI 后端服务",
  "nav": {
    "title": "Python 服务",
    "group": "extensions",
    "order": 55
  },
  "ui": {
    "kind": "webview",
    "entry": "http://127.0.0.1:8000",
    "sandbox": [
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-popups"
    ]
  },
  "permissions": ["embed"],
  "service": {
    "mode": "managed",
    "cwd": ".",
    "hint": "启动 FastAPI 服务，端口 8000",
    "start": {
      "windows": ["python\\python.exe", "main.py"],
      "default": ["python", "main.py"]
    },
    "healthcheck": {
      "url": "http://127.0.0.1:8000",
      "timeout_ms": 30000
    },
    "stop": "port",
    "ports": [8000]
  },
  "bridge": {
    "origin_allowlist": [
      "http://127.0.0.1:8000",
      "http://localhost:8000"
    ]
  }
}
```

### `service.start` 字段说明

```json
"start": {
  "windows": ["npm.cmd", "run", "dev"],   // Windows 专用的命令
  "macos":   ["npm", "run", "dev"],       // macOS 专用
  "linux":   ["npm", "run", "dev"],       // Linux 专用
  "default": ["npm", "run", "dev"]        // 兜底（任意平台）
}
```

- 数组第一个元素是可执行文件，后面是参数
- 当前平台有专用命令就用专用，没有就用 `default`
- Windows 上推荐用 `.cmd` 后缀（`npm.cmd`、`pnpm.cmd`），EvoFlow 会自动查 PATH

### `service.link` 字段

```json
"service": {
  "mode": "managed",
  "link": true,
  "cwd": ".."
}
```

- `link: true`：安装时**不复制**目录，只记录路径。适合 monorepo 场景。
- `link: false` 或不写：安装时会把整个目录复制到 `~/.evoflow/ui-extensions/<id>/`。

### 安装方式

点 **「选择本地文件夹」** → 选你项目根目录 → 安装后 EvoPanel 会自动读 `evoflow.extension.json`。

打开扩展时，EvoFlow 会：
1. 检测 `healthcheck.url` 是否已通 → 已通则直接打开（复用已有进程）
2. 不通则执行 `start` 命令启动进程
3. 等待健康检查通过（超时 `timeout_ms` 毫秒）
4. 通过后加载 iframe 显示页面

---

## 4. 场景三：外部已有服务（external）

> 服务已经由用户自己启动了（比如通过系统服务、Docker、手动启动），EvoFlow 不需要帮你启动，但需要知道它是否在运行。

### 适用

- Docker 容器服务
- 系统服务 / systemd
- 用户手动启动，你想给个提示

### Manifest

```json
{
  "schema": 1,
  "id": "my-docker-app",
  "name": "Docker 应用",
  "version": "1.0.0",
  "description": "运行在 Docker 中的服务",
  "nav": {
    "title": "Docker 应用",
    "group": "extensions",
    "order": 90
  },
  "ui": {
    "kind": "webview",
    "entry": "http://localhost:8080"
  },
  "permissions": ["embed"],
  "service": {
    "mode": "external",
    "hint": "请先执行 docker-compose up -d 启动服务",
    "healthcheck": {
      "url": "http://localhost:8080/health",
      "timeout_ms": 5000
    }
  },
  "bridge": {
    "origin_allowlist": [
      "http://localhost:8080",
      "http://127.0.0.1:8080"
    ]
  }
}
```

---

## 5. Manifest 字段速查

### 必填字段

| 字段 | 说明 | 示例 |
|------|------|------|
| `schema` | 固定为 `1` | `1` |
| `id` | 扩展唯一标识，小写 kebab-case，1-64 字符 | `"my-ops"` |
| `name` | 显示名称，1-80 字符 | `"我的运营页"` |
| `version` | 版本号 | `"1.0.0"` |
| `ui.kind` | 固定 `"webview"` | `"webview"` |
| `ui.entry` | 入口 URL（绝对 URL 或包内相对路径） | `"http://localhost:5173"` 或 `"./ui/index.html"` |

### 可选字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `description` | `""` | 简短描述，最多 500 字符 |
| `icon` | 自动生成 emoji | 图标路径或 URL，建议 `./icon.svg` |
| `nav.title` | `name` | 侧栏显示标题，最多 40 字符 |
| `nav.group` | `"extensions"` | 侧栏分组（固定值） |
| `nav.order` | `100` | 排序权重，越小越靠前 |
| `ui.path_prefix` | `"/"` | URL 路径前缀，用于路由匹配 |
| `ui.sandbox` | 默认值 | iframe sandbox 属性 |
| `permissions` | `["embed"]` | 权限声明（见下方） |
| `service.mode` | `"none"` | `"none"` / `"managed"` / `"external"` |
| `service.cwd` | `"."` | 启动命令的工作目录，相对 `install_path` |
| `service.link` | `false` | 是否软链接（不复制目录） |
| `service.hint` | `""` | 启动失败时的提示文字 |
| `service.start` | 无 | 各平台启动命令 |
| `service.healthcheck.url` | `""` | 健康检查 URL |
| `service.healthcheck.timeout_ms` | `90000` | 健康检查超时（毫秒） |
| `service.stop` | `"process"` | 停止方式：`"process"`（杀进程）或 `"port"`（释放端口） |
| `service.ports` | `[]` | 声明占用的端口号 |
| `bridge.origin_allowlist` | `[]` | 允许通信的 origin 白名单 |

### 权限列表

| 权限 | 对应 Bridge 方法 | 说明 |
|------|-----------------|------|
| `embed` | `ready` | 基础嵌入权限（默认） |
| `context.read` | `context.get` | 读取当前对话上下文 |
| `tasks.dispatch` | `tasks.dispatch` | 向 EvoFlow 派发任务 |
| `tasks.open` | `tasks.open` | 打开任务中心 |

> 含 `tasks.dispatch` 时，首次启用会弹出确认对话框，让用户确认。

---

## 6. Bridge 协议：让页面与 EvoFlow 通信

你的扩展页面可以通过 `postMessage` 与 EvoPanel 宿主通信。

### 调用方式

```javascript
// 在你的页面中调用 EvoFlow Bridge API
function callEvoFlow(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const handler = (event) => {
      if (event.data?.channel !== 'evoflow-extension') return
      if (event.data?.requestId !== requestId) return
      window.removeEventListener('message', handler)
      if (event.data.ok) {
        resolve(event.data.result)
      } else {
        reject(new Error(event.data.error || 'Bridge 调用失败'))
      }
    }
    window.addEventListener('message', handler)
    window.parent.postMessage({
      channel: 'evoflow-extension',
      v: 1,
      extensionId: 'my-ops-dashboard',  // 替换为你的扩展 id
      requestId: requestId,
      method: method,
      params: params
    }, '*')
  })
}

// 通知宿主页面已就绪
callEvoFlow('ready')

// 获取当前对话上下文
const ctx = await callEvoFlow('context.get')
console.log('当前对话上下文:', ctx)

// 派发任务给智能体员工
await callEvoFlow('tasks.dispatch', {
  agent_code: 'code-agent',
  content: '分析这个视频'
})

// 打开另一个扩展
await callEvoFlow('extensions.open', {
  id: 'contentos-trending'
})
```

### 必须：先调用 `ready`

iframe 加载后，宿主需要知道你的页面已就绪才能管理 Bridge 通信。建议在页面加载完成后立即调用 `callEvoFlow('ready')`。

### origin_allowlist（安全限制）

`bridge.origin_allowlist` 限制了哪些 origin 的页面可以通过 Bridge 通信。不在白名单里的 origin 发来的 `postMessage` 会被宿主演略。

示例：

```json
"bridge": {
  "origin_allowlist": [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "https://my-production.example.com"
  ]
}
```

---

## 7. 常见问题

### Q: 安装后侧栏没出现入口？

检查：
- 扩展是否已启用（设置 → 扩展 → 查看开关状态）
- `evoflow.extension.json` 的 `nav.title` 和 `nav.group` 是否正确
- 在设置页「扩展」列表里点「刷新」

### Q: 提示「suite.members 为空」？

这说明你选了 `evoflow.suite.json`（套件文件）而不是 `evoflow.extension.json`（扩展文件）。

- 安装单个扩展 → 选含 `evoflow.extension.json` 的目录
- 安装套件 → 点「安装套件文件夹」按钮，选含 `evoflow.suite.json` 的目录

### Q: 服务启动失败「健康检查超时」？

- 确认 `service.start` 命令在终端能正常启动
- 确认 `healthcheck.url` 端口和路径正确
- 适当增大 `timeout_ms`（开发环境首次启动可能需要较长时间安装依赖）
- 检查 `service.cwd` 工作目录是否正确

### Q: 页面加载后白屏？

- 确认 `ui.entry` 的 URL 可以正常访问（在浏览器里打开试试）
- 检查 `sandbox` 是否限制了必要的权限（至少 `allow-scripts` 和 `allow-same-origin`）
- 查看页面控制台是否有跨域错误

### Q: 如何在单个项目里搞多个扩展（monorepo）？

在 `evoflow.extension.json` 中设置 `service.link: true`，让多个扩展指向同一个共享目录：

```json
{
  "id": "my-app-part-a",
  "service": {
    "mode": "managed",
    "link": true,
    "cwd": "..",
    "start": {
      "windows": ["npm.cmd", "run", "dev"]
    },
    "healthcheck": {
      "url": "http://127.0.0.1:3000"
    },
    "ports": [3000]
  }
}
```

这样多个扩展共享同一个端口和进程，`healthcheck` 已通就不会重复启动，能实现「多入口、单服务」的效果。

### Q: 安装后目录被复制到哪了？

默认复制到 `~/.evoflow/ui-extensions/<id>/`。点设置页扩展卡片上的「目录」按钮可以打开文件夹查看。

### Q: 如何卸载？

设置 → 扩展 → 目标扩展卡片 → 点「卸载」按钮。

---

## 附录：完整示例对比

| 场景 | 示例文件 | 说明 |
|------|---------|------|
| 纯远程页面 | [extensions/contentos-trending/evoflow.extension.json](/extensions/contentos-trending/evoflow.extension.json) | 无本地服务 |
| 带本地服务（Python） | [extensions/ai-canvas/evoflow.extension.json](/extensions/ai-canvas/evoflow.extension.json) | `python main.py` |
| 带本地服务（Node.js） | [extensions/contentos/evoflow.extension.json](/extensions/contentos/evoflow.extension.json) | `pnpm dev`，共享端口 |
| 套件（多扩展打包） | [extensions/content-creator/evoflow.suite.json](/extensions/content-creator/evoflow.suite.json) | 一次安装 6 个扩展 |
---

## 相关阅读

- [[guides/configuration/evopanel-guide|EvoFlow 桌面端使用指南]] — 侧栏与扩展入口
- [[guides/configuration/tools-mcp|工具与 MCP]] — 扩展可用的 Bridge 协议
- [[guides/configuration/settings|面板设置]] — 扩展管理与配置
- [[tutorials/create-agent|创建智能体教程]] — 扩展与角色协作
