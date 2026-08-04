# 内容类插件：完全独立（无共享底座）

> **铁律**：用户只装「视频拆解」，打开就能拆——**不需要** ContentOS 平台、不需要运营中台、不需要其它插件、不需要先装「runtime」。

相关：[`ui-extension-standard-v1.md`](./ui-extension-standard-v1.md)。  
范例包：[`extensions/contentos-decompose`](../../../extensions/contentos-decompose/)（含 `standalone/`）。

---

## 1. 为什么不能共享底座

共享 `:3001` / 同一 ContentOS 进程时：

- 装「视频拆解」仍要拉起整站（热点、运营、素材…）
- 用户心智是「装了个平台」，不是「装了个工具」
- 卸载/停用一个插件容易误伤其它能力的数据与进程

因此：**每个插件是完整产品**，不是同一平台上的多个入口。

---

## 2. 正确模型

```text
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ 视频拆解 插件 zip      │  │ 素材中心 插件 zip      │  │ 今日热点 插件 zip      │
│ · 自己的 UI           │  │ · 自己的 UI           │  │ · 自己的 UI           │
│ · 自己的本地服务:3011  │  │ · 自己的本地服务:3012  │  │ · 自己的本地服务:3013  │
│ · 自己的 SQLite/媒资   │  │ · 自己的 SQLite/媒资   │  │ · 自己的 SQLite       │
│ · 自己的 MCP          │  │ · 自己的 MCP          │  │ · 自己的 MCP          │
│   id: contentos-      │  │   id: contentos-      │  │   id: contentos-      │
│   decompose           │  │   materials           │  │   trending            │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
         │                          │                          │
         └──────────────────────────┴──────────────────────────┘
                    互不依赖；可选以后做「导入/导出」互通
```

| 维度 | 约定 |
|------|------|
| 安装 | 一个目录 / 一个 zip = 一个插件 |
| 进程 | **各自** `service.start` + **各自**端口 |
| 数据 | **各自**数据目录（默认 `~/.evoflow/plugin-data/<id>/`） |
| MCP | **各自** server id；工具名可沿用旧名（如 `video_*`）方便技能迁移 |
| 源码 | 开发时可复用 `@acs/video-decompose` 等**库**；交付物不要求本机有 ContentOS 仓 |

**禁止**：`service.sharedKey`、共用一个 `contentos-runtime`、多个插件 healthcheck 指向同一端口。

---

## 3. MCP / 技能 / 旧数据（保留能力，不共享进程）

### 3.1 工具名尽量兼容

拆解插件 MCP 仍暴露 `video_decompose`、`video_list_decompositions` 等**工具名**，技能正文少改。  
变的是 **MCP server id**：从全局 `contentos` → 插件自己的 `contentos-decompose`（安装插件时写入 EvoFlow MCP 配置）。

### 3.2 旧 ContentOS 数据

不「挂到旧库上共用」，而是**迁移进本插件数据目录**：

1. 用户只装拆解插件  
2. 运行插件自带的 `migrate-from-contentos`（或设置页「从 ContentOS 导入」）  
3. 拷贝/导入 `VideoDecomposition` 及相关媒资到本插件 DB  

详见各插件 `standalone/MIGRATION.md`。

### 3.3 源码复用 ≠ 运行时共享

| | 可以 | 不可以 |
|--|------|--------|
| 开发 | 多个插件 import 同一 npm 包 | 多个插件必须启动同一 `@acs/web :3001` |
| 发布 | 把库打进各自 zip | 要求用户先装 ContentOS 仓 |
| 数据 | 导出 JSON/SQLite 给另一个插件 | 默认读写同一 `dev.db` |

---

## 4. Manifest 形态（独立）

```json
{
  "id": "contentos-decompose",
  "ui": { "entry": "http://127.0.0.1:3011/" },
  "service": {
    "mode": "managed",
    "cwd": "./standalone",
    "start": { "default": ["node", "server.mjs"] },
    "healthcheck": { "url": "http://127.0.0.1:3011/health", "timeout_ms": 120000 },
    "ports": [3011],
    "stop": "port"
  }
}
```

- **无** `runtime`、**无** `sharedKey`
- `suite: content-creator` 仅表示「也可被套件批量安装多个**彼此独立**的包」，不是共用底座

### 端口规划（避免冲突）

| 插件 | 默认端口 |
|------|----------|
| 视频拆解 | 3011 |
| 素材中心 | 3012 |
| 今日热点 | 3013 |
| 账号洞察 | 3014 |
| 运营中台 | 3015 |
| 日更选题台 | 3016 | **独立插件** `rigeng-topics`（不进 content-creator 套件） |
| 创作画布 | 3000（已有） |

---

## 5. 套件怎么理解

`content-creator` = **购物车**：一次装多个独立插件。  
装完后仍是多进程、多数据目录；**不是**装出一个 ContentOS。

---

## 6. 落地顺序

- [x] 视频拆解独立包：自有 HTTP :3011、SQLite、vendored Python、MCP `video_*`
- [x] 日更选题台独立包 `rigeng-topics`：自有 HTTP :3016、SQLite、工作台 UI、MCP；**不进内容创作套件**
- [ ] 素材 / 热点 / 洞察 / 运营中台按同一模板迁入业务
- [ ] 安装扩展时一键注册该插件自己的 MCP
