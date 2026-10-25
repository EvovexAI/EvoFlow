# Agent 应用挂载（extensions / UI Extension Standard v1）

> 什么时候读本文：用户说「挂载一个应用 / 把网页加到侧栏 / 装个 Agent 应用 / 应用中心里加一个入口」。
>
> **完整官方文档**：`docs/user/guides/configuration/install-own-project-as-extension.md`
> （含三步起步、远程/managed/external 三场景、Bridge 协议、FAQ。写 manifest 前优先看它，不要靠读源码反推。）

---

## 0. 先分清三个「应用」（最常见的误解）

| 说法 | 实际是什么 | 用什么 |
|------|-----------|--------|
| **Agent 应用** / 侧栏应用 / 应用中心 | UI Extension，常驻侧栏 `#/extensions`，有 manifest、可启停 | **`extensions.*`** |
| 工作流 App | App 定义（goal + steps + DAG），能 run | **`workflow.*`** |
| 「帮我在右边打开个网页看看」 | 临时预览，不落盘、不进应用中心 | **`ui.show` (web-embed)** |

**典型误判**：用户说「挂载应用」，不要用 `ui.show` 打开 iframe 交差——那只是临时预览，应用中心里看不到。
反过来，用户说「打开这个网页我看下」，不要给人家装一个扩展。

`platform catalog` 里没有 `apps` 域（会报 `unknown domain: apps`）；Agent 应用在 **`extensions`**，工作流在 **`workflow`**。

---

## 1. 最小可用流程

### 步骤一：建目录 + 写 `evoflow.extension.json`

目录里必须有 `evoflow.extension.json`（这是 EvoFlow 识别应用的**唯一**依据）。
页面可以是任何 http 服务（静态页 / dev server / 已在跑的外部服务）。

```json
{
  "schema": 1,
  "id": "demo-hello",
  "name": "挂载测试",
  "version": "1.0.0",
  "description": "一句话说明这个应用做什么",
  "icon": "🧪",
  "nav": { "title": "挂载测试", "group": "extensions", "order": 10 },
  "ui": {
    "kind": "webview",
    "entry": "http://127.0.0.1:8899/index.html"
  },
  "permissions": ["embed"],
  "service": { "mode": "none" }
}
```

### 步骤二：选 `service.mode`（**最容易选错的地方**）

| mode | 含义 | 何时用 |
|------|------|--------|
| `none` | 纯远程页面，EvoFlow 不管进程 | 已部署的远程站、公网 URL |
| `managed` | **EvoFlow 负责启动 + 健康检查** | 本地项目（`npm run dev`、`python -m http.server`）← **本地示例应该用这个** |
| `external` | 服务由外部自己跑，EvoFlow 只连不管 | 服务已在别处常驻 |

> **踩坑**：给本地页面演示时图快用 `external`，页面依赖你手工起的后台进程——进程一停应用就白屏，
> 用户装完得到一个「关机即坏」的应用。本地一律优先 `managed`。

`managed` 示例：

```json
"service": {
  "mode": "managed",
  "cwd": ".",
  "start": { "windows": ["python", "-m", "http.server", "8899"], "default": ["python3", "-m", "http.server", "8899"] },
  "healthcheck": { "url": "http://127.0.0.1:8899/index.html", "timeout_ms": 60000 },
  "ports": [8899]
}
```

`mode: none` 也要求 `ui.entry` 可访问；否则如果rame 白屏。

### 步骤三：安装

```text
platform action=extensions.install confirm=true
  args_json={"path":"<含 evoflow.extension.json 的绝对目录>"}
```

- `path` 指向**目录**，不是文件
- `link=true`：只登记路径不复制（仓库内开发用）；缺省会复制到 `~/.evoflow/ui-extensions/<id>/`
- 也可 `id` + `url` 直接装远程入口，或 `manifest` + `install_path` 直登

### 步骤四：验证（三处都要看，别只看一处）

```text
platform action=extensions.list          # 注册表读得到吗
```

```bash
curl -sS http://127.0.0.1:8382/api/ui-extensions | head -c 400   # 应用中心走这条
cat ~/.evoflow/ui-extensions/registry.json                       # 真的落盘了吗
```

页面本身还要能访问：`curl -sS -o /dev/null -w "%{http_code}" <ui.entry>`
（吐 200 才算页面活了；吐超时/4xx 装上也是白屏）

---

## 2. Manifest 必填项速查

| 字段 | 约束 |
|------|------|
| `schema` | 必须 `1` |
| `id` | 小写 kebab-case，字母开头，≤64 字符 |
| `name` | 非空 |
| `version` | 非空（如 `1.0.0`） |
| `ui.kind` | 只能 `webview` |
| `ui.entry` | 非空；http(s)/file URL 或相对路径 |
| `permissions` | 缺省 `["embed"]`；未知值直接报错 |
| `service.mode` | `none` / `managed` / `external` |

常用可选：`nav.title`、`nav.order`（同组内排序）、`icon`（emoji 或图片）、
`ui.sandbox`（缺省 `allow-scripts, allow-same-origin, allow-forms, allow-popups`）、
`service.link=true`（多入口共享一个服务/monorepo）。

---

## 3. 常见故障对照

| 现象 | 原因 |
|------|------|
| 安装成功但侧栏没入口 | `nav.group` 不是 `extensions`；或扩展被禁用（`extensions.enable enabled=true`） |
| 点开白屏 | `ui.entry` 打不开（服务没起 / 端口错 / 域名不通）；先用 curl 探活 |
| 白屏但 URL 正常 | 目标站 `X-Frame-Options` / CSP 拒绝被 iframe 嵌入（Google/GitHub 等），**换个能嵌的站点或自建页面** |
| 页面显示但按钮无反应 | `ui.sandbox` 缺 `allow-scripts` |
| 疑似装错文件 | 提示 `suite.members 为空` ＝ 选了 `evoflow.suite.json`（套件），不是 `evoflow.extension.json` |
| 服务起不来 / 健康检查超时 | `service.start` 命令在终端跑不通；或 `cwd` 不对；或 `healthcheck.url` 端口/路径错 |

---

## 4. 操作纪律

1. **先探活再用 URL**。填 manifest 前 `curl -o /dev/null -w "%{http_code}"`；
   连不上的域名（如不存在的官网）白耗多轮，还给用户留个转圈的 iframe。
2. **不要猜 manifest 字段**。字段约束见上文速查，完整语义见 `docs/user/guides/.../install-own-project-as-extension.md`；
   读源码（`ui-extension-manifest.js`）是最后手段。
3. **演示产物别留在业务仓库里**。临时扩展放 `~/.evoflow/ui-extensions/` 或 `/tmp`，
   别提交进 git；`link=true` 指向仓库内目录时尤其注意 `.gitignore`。
4. **卸载要干净**：`extensions.uninstall`（`folder-link` 只摘登记、不删源目录）+ 停掉手工起的服务。
5. **给用户验收要点**：装完告诉用户「去哪看」（侧栏 `#/extensions` / 应用中心），
   并说明页面依赖什么（`managed` 由系统托管、`external` 依赖外部进程）。
