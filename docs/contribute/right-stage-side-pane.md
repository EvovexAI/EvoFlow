# 右栏（Right Stage）机制备忘

> 承接 P1–P3（归属 / LRU / reload-only 持久化）与后续收口。细节实现见
> `evopanel/src/lib/right-stage/` 与 `RightStagePanel.tsx`。

## 批次回顾

| 批次 | 内容 |
|---|---|
| P1 | 归属判定 + `show()` 创建即冻结 + workspace 级共享 + `panel_set` 前后台路由 |
| P2 | LRU 剥壳（40 重条目 / 120 壳）+ 边界 normalize + 诊断计数 |
| P3 | reload-only 持久化（`sessionStorage`，非 reload 冷启动清键） |
| P4 | `FORCE_MOUNT_KINDS` 收敛：移出 `news-dashboard` / `platform-feedback` |
| P5 | 统一 overlay commit 写入口（开合侧栏的 defer + flushSync + resume bump） |

## 附录：FORCE_MOUNT 白名单

入列标准是「**重建成本高或会丢状态**」，不是「它是右栏面板」。

**常驻**：browser / web-embed / terminal / write / file / codeViewer /
subagentTranscript / workspace-browse / collab-workflow / mind-map / summary。

**按需挂载**：

- `news-dashboard`：挂载即 fetch + 30 分钟定时器，失活常驻会持续联网；
- `platform-feedback`：纯展示，重建零成本。

守卫测试：`evopanel/tests/right-stage-force-mount.test.ts`。

## 附录：统一 commit 写入口

**问题本质**：EvoFlow 右栏开合处反复手写

1. `setChatOverlayDefer`（挡住流式 `scheduleBump`，避免布局抖动中被抢重绘）；
2. `flushSync`（布局相关 setState 同帧落地）；
3. 清 defer 后若无其它 overlay → `scheduleBump({ immediate: true })`。

这与 ZCode「高频 store canonical commit」不是同一件事——流式写右栏仍走
`rightStageStore` 自己的路径；发送消息 / 切会话等其它 `flushSync` **不归**此入口。

**落地**：`evopanel/src/lib/right-stage/right-stage-overlay-commit.ts`

- `commitRightStageOpen` / `commitRightStageClose`
- `clearAllRightStageOverlayDefer` / `resumeStreamBumpIfIdle`

已迁：workspace / knowledge-map / collab-workflow 开合、collapse/expand、
sync-remote-stage-set、open-stage-extension / open-ui-extension 的 defer 清理。

**未迁（有意）**：`handle-send`、`select-session-from-shell`、
`start-new-session-with-workspace`、controller 内其它 flushSync——语义是「用户气泡 /
草稿同帧」，不是 overlay defer。

## 附录：reload-only 持久化时序隐患

模块级 hydrate 先把缓存装进 Map；ChatApp effect 首次
`switchRightStageSession('', 选中会话)` 若误走 `importSessionMemory(null)`，
刚恢复的内容会被清空。当前实现 key 非空时读 Map，已有回归用例锁住。
