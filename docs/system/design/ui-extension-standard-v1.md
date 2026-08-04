# EvoFlow UI 扩展标准 v1

> 与「应用中心」（工作流 DAG）、「MCP/Skills」（智能体工具）并列。  
> 本标准只解决：**嵌别人自己的页面 + 可选本地侧车服务**。  
> Schema 附录见同目录 [`ui-extension.schema.json`](./ui-extension.schema.json)。

## 1. 名词

| 词 | 含义 |
|----|------|
| **扩展包** | 含 `evoflow.extension.json` 的目录或 zip |
| **扩展** | 安装后的注册记录（id + 版本 + 启用状态） |
| **入口页** | iframe / WebView 打开的 UI（本地静态或 URL） |
| **侧车服务** | 扩展可选本地进程，由桌面客户端按声明启停 |

v1 **不做**：扩展商店、代码签名、自动更新。

内容类能力按**独立插件**交付（各进程、各数据目录），见 [`contentos-plugin-modules.md`](./contentos-plugin-modules.md)。同一本机**可以**有多个扩展共享端口（healthcheck 复用），但内容类产品**刻意不这么做**。

## 2. Manifest

包根目录固定文件名：`evoflow.extension.json`。

最小示例（远程页、无本地进程）：

```json
{
  "schema": 1,
  "id": "hello-ops",
  "name": "示例运营页",
  "version": "1.0.0",
  "nav": { "title": "示例", "group": "extensions", "order": 100 },
  "ui": { "kind": "webview", "entry": "https://example.com/ops" },
  "permissions": ["embed"],
  "service": { "mode": "none" },
  "bridge": { "origin_allowlist": ["https://example.com"] }
}
```

带本地服务示例见仓库 [`extensions/contentos/evoflow.extension.json`](../../../extensions/contentos/evoflow.extension.json)。

### 字段要点

- **`ui.entry`**：绝对 URL，或包内相对路径（如 `./ui/index.html`）。
- **`service.mode`**：`none` | `managed` | `external`。
- **`service.link`**：`true` 时安装**不复制**目录，`install_path` 即所选文件夹；配合 `service.cwd` 指向 monorepo 根。
- **`service.sharedKey`**：相同 key 的扩展共享侧车（healthcheck 已通则复用）。
- **`runtime`**：可选；声明共享后端模块 id / MCP server 名（如 `contentos-runtime`）。
- **`suite`**：可选；表示也可被某套件一并安装，**不强制**走套件。
- **`service.cwd`**：相对 `install_path` 的启动工作目录（默认 `.`）。
- **`permissions`**：未声明的 Bridge API 一律拒绝。
- **`bridge.origin_allowlist`**：仅这些 origin 可 `postMessage`。

官方多产品示例：[`extensions/contentos*`](../../../extensions/contentos/README.md)（各自可独立安装，共享 [`contentos-runtime`](../../../extensions/contentos-runtime/)）。产品边界见 [`contentos-plugin-modules.md`](./contentos-plugin-modules.md)。

## 3. 用户如何添加

入口：**设置 → 扩展**（`#/settings?tab=extensions`）。

| 方式 | 说明 |
|------|------|
| 本地文件夹 | 选含 Manifest 的目录 → 校验；默认复制到 `~/.evoflow/ui-extensions/<id>/`；`service.link=true` 则只登记路径 |
| 导入 zip | 解压后同文件夹安装 |
| 远程入口 | 填 id / name / entry URL，隐式 `service.mode=none` |

安装后：启用 / 禁用 / 卸载 / 打开目录 / 查看服务日志。  
含 `tasks.dispatch` 等敏感权限时，首次启用需确认。

## 4. 加完后显示在哪

| 位置 | 行为 |
|------|------|
| 主侧栏「扩展」分组 | 已启用扩展；打开 `#/extensions/<id>` 全页嵌套壳 |
| 设置 → 扩展 | 管理列表与服务状态 |
| 对话顶栏「扩展」 | 可快捷打开已安装扩展到右侧 Stage（绑定扩展 id） |

## 5. 服务启停与管控

- **懒启动**：首次打开扩展或点「启动」才拉起 `managed` 进程。
- **单实例**：同一 `id` 全局一个进程。
- **共享端口**：`healthcheck` 已通则直接复用，不再 spawn；停止时仅杀「本扩展拉起的」进程，避免误停共享侧车。
- **健康检查**：通过后再加载 iframe。
- **停止**：禁用 / 卸载 / 客户端退出时停进程；自有进程且 `stop: port` 时按 `ports` 释放端口。
- **崩溃**：进入失败态，需用户手动重启（不自动无限重启）。

纯 Web 客户端：仅支持 `none` / `external`（不托管本地进程）。

## 6. Bridge 协议（页面 → 宿主）

页面 `postMessage` 到 `parent`，形状：

```json
{
  "channel": "evoflow-extension",
  "v": 1,
  "extensionId": "contentos",
  "requestId": "uuid",
  "method": "context.get",
  "params": {}
}
```

宿主回复：

```json
{
  "channel": "evoflow-extension",
  "v": 1,
  "requestId": "uuid",
  "ok": true,
  "result": {}
}
```

| method | 所需 permission |
|--------|-----------------|
| `ready` | `embed` |
| `context.get` | `context.read` |
| `tasks.dispatch` | `tasks.dispatch` |
| `tasks.open` | `tasks.open` |
| `extensions.open` | `embed`（打开其它扩展；可选 `entry` 覆盖 iframe URL） |

开发者交付扩展包即可，**不必**修改 EvoFlow 源码。
