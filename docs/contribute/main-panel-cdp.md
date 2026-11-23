# 主窗口 CDP（`/main-cdp/*`）

控制 **EvoFlow 主窗口**（聊天壳 / 产品 chrome），不是侧栏 embed 浏览器（那条是 `/browser-cdp/*`）。

## 入口

| 层 | 用法 |
|----|------|
| Gateway | `platform` → `action=ui.panel` + `op=…` |
| HTTP | `http://127.0.0.1:<port>/main-cdp/<route>` |
| Playwright | `GET /main-cdp/ws` → `connect_over_cdp(wsUrl)`，路径 `/devtools/browser/main` |

端口文件：`~/.evoflow/browser-cdp-http-port`（debug 构建可能是 `~/.evoflow-dev/…`）。  
主窗 **不会**开 `--remote-debugging-port`；原生 CDP 走 WebView2 `CallDevToolsProtocolMethod`，Playwright 走本机 WS broker。

## `ui.panel` ops

**排查页面看见了什么**（优先）：

```text
platform action=ui.panel args_json={"op":"page_dump"}
platform action=ui.panel args_json={"op":"snapshot","mode":"debug"}
```

`page_dump` 返回当前视口内 `[data-turn-id]` 轮次正文（`result.transcript` / `text`），适合对「界面上到底有没有回」做肉眼级核对；`snapshot` 默认仍是可点控件 refs。


`snapshot` → 用 refs `e1,e2,…` → `click` / `fill` / `type` / `scroll`。  
`state` 读路由/会话/右栏，并带 **`focus`（当前模块/实体）+ `recentActivity`（点击/路由留痕）**。  
`focus` 是上述焦点字段的精简入口（小V / 其它 Agent 问「用户在哪」优先用它）：

```text
platform action=ui.panel args_json={"op":"focus"}
```

`action` 走产品动作：

- `name=navigate` + `path`/`hash`
- `name=openXiaomi`
- `name=sendMessage` + `text`
- `name=selectSession` + `sessionKey`
- `name=setComposerText` / `focusComposer` / `openRightStage`

另有 `ax` / `screenshot` / `cdp` / `ws`。

示例：

```text
platform action=ui.panel args_json={"op":"snapshot"}
platform action=ui.panel args_json={"op":"click","ref":"e3"}
platform action=ui.panel args_json={"op":"action","name":"openXiaomi"}
```

## 安全

- 默认只绑 loopback（`127.0.0.1`）。
- 可选 token：环境变量 `EVOFLOW_PANEL_CDP_TOKEN`，或文件 `~/.evoflow/panel-cdp-token`；请求头 `X-EvoFlow-Panel-Token`（或 `Authorization: Bearer …`）。
- 跨机请用 **SSH 本地转发**，不要把 CDP HTTP/WS 直接暴露公网。

```bash
ssh -L 19222:127.0.0.1:<port> user@desktop-host
# 远端 Agent 访问 http://127.0.0.1:19222/main-cdp/…
```

## 与 browser 的区别

| | 主窗口 `ui.panel` | 侧栏 browser |
|--|------------------|--------------|
| 目标 | 产品 UI | embed WebView 网页 |
| HTTP 前缀 | `/main-cdp/` | `/browser-cdp/` |
| 工具 | `platform`（`ui.panel`） | 技能 / 未注册的 `browser` 工具 |

前端契约：`window.__evoflowPanel`（`evopanel/src/lib/panel-cdp/`）。
