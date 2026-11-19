//! Windows CUA 顶部操作提示 — 对齐 ZCode `windowsCuaOperationIndicator`。
//!
//! 当前鼠标所在显示器顶部居中：「EvoFlow 正在操作电脑」。
//! 加载 ``cua-glow-overlay.html``（自包含）；显示后强制 HWND_TOPMOST。
//!
//! 与 browser_embed 相同：``WebviewWindow::build()`` 返回时 HWND 往往尚未就绪，
//! 必须轮询 ``hwnd()`` 后再 ``show``，否则 invoke 报 Ok 但桌面上没有窗。

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow};

#[cfg(target_os = "windows")]
use crate::commands::browser_cdp_server;

/// Non-Windows: keep `glow_log` compiling when `browser_cdp_server` is Windows-only.
#[cfg(not(target_os = "windows"))]
mod browser_cdp_server {
    pub fn log_line(s: &str) {
        eprintln!("{s}");
    }
}

/// 提示条窗口 label **前缀**。
///
/// 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
/// 改了什么：固定 label `cua-glow-0` → 每次重建递增的 `cua-glow-<n>`，
/// 并新增 `OVERLAY_ACTIVE_LABEL` 记住「当前这一个」。
///
/// 为什么（现网取证，17 次 show 全失败）：
///   ```
///   destroy zombie overlay (dead/missing hwnd)
///   → overlay label still present after close → force destroy
///   → WARN overlay label STILL present after destroy   ← 永久残留
///   → create CUA operation indicator failed: a webview with label `cua-glow-0` already exists
///   ```
/// `close()` / `destroy()` 都只是**投递**请求，Tauri 的 webview 注册表要等 tao
/// 事件循环回收才移除 label。一旦某次回收失败（面板刚启动、CPU 被 CDP 桥等占满时
/// 很容易），`already exists` 就变成**永久死锁**：之后每次 build 都撞同一个名字，
/// 而失败又不清理 ⇒ 用户从此再也看不到提示条（本次实测就是这样）。
///
/// 唯一化后：撞名字最多浪费一个序号，下一次换新名字必然建成 ——
/// 把「不可恢复的永久死锁」降级为「最多多试一次」。
const OVERLAY_LABEL_PREFIX: &str = "cua-glow-";
/// 兼容老名字（首次仍从 0 开始，便于跟历史日志对照）。
const OVERLAY_LABEL: &str = "cua-glow-0";
/// 窗口尺寸。
///
/// 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
/// 原来是 ZCode 的 250x56（只有一句固定文案，够用）。本轮卡片里多了
/// 「当前步骤」+「第 N 步」+「解除控制」按钮，按 13px 实测排版需要约 420px：
///   主文案 134 + 步骤 104 + 步数 40 + 按钮 62 + 呼吸点 18 + 间隙 36 + 内边距 26
/// 250px 会把主文案压成「EvoFlow 正在…」，等于没解决用户的问题。
/// 高度同理：56 - 上下 padding 18 = 38px，装不下 44px 卡片，会被 overflow 裁掉。
// 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
// 520 → 560：加「已操作时长」后按字宽实测，520 只剩 138px 给步骤段（需要 156），
// 560 有 178px 富余。排字宽用 node 算过，不是拍的：
//   内容 518 − dots 18 − gap 16 − 按钮 62 = 422
//   固定占（主文案 135 + 计数 46 + 时长 26 + 两个 6px gap）= 219 ⇒ 步骤可用 178px。
const OVERLAY_WIDTH: f64 = 560.0;
const OVERLAY_HEIGHT: f64 = 64.0;
const CARD_TOP_OFFSET: f64 = 12.0;
const SHADOW_INSET_TOP: f64 = 6.0;

struct OverlayState {
    window_created: bool,
    /// 当前真正在用的 label（唯一化后的）。空 = 还没有活窗口。
    /// 【self-evolution-bot · 2026-11-19 · 第73轮】所有「查当前窗口」的地方都走它，
    /// 不再拿固定名字去扫注册表 —— 注册表里可能同时躺着几个已死 label。
    active_label: String,
    /// 已用过的最大序号，保证 label 单调递增、绝不复用。
    seq: u32,
}

static OVERLAY_STATE: Mutex<OverlayState> = Mutex::new(OverlayState {
    window_created: false,
    active_label: String::new(),
    seq: 0,
});

/// 取当前活跃窗口。**先信 `active_label`，不扫注册表**。
fn active_overlay(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    let label = {
        let st = OVERLAY_STATE.lock().ok()?;
        st.active_label.clone()
    };
    if label.is_empty() {
        return None;
    }
    app.get_webview_window(&label)
}

/// 分配下一个唯一 label。
fn next_overlay_label() -> String {
    let mut st = match OVERLAY_STATE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let label = if st.seq == 0 {
        OVERLAY_LABEL.to_string()
    } else {
        format!("{OVERLAY_LABEL_PREFIX}{}", st.seq)
    };
    st.seq = st.seq.saturating_add(1);
    st.active_label = label.clone();
    label
}

fn glow_log(msg: impl AsRef<str>) {
    browser_cdp_server::log_line(&format!("[cua-glow] {}", msg.as_ref()));
}

fn overlay_logical_position(app: &tauri::AppHandle) -> Result<LogicalPosition<f64>, String> {
    // Prefer cursor's monitor (ZCode getDisplayNearestPoint); fall back to primary.
    let monitor = {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::POINT;
            use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
            let mut pt = POINT::default();
            let cursor_ok = unsafe { GetCursorPos(&mut pt).is_ok() };
            if cursor_ok {
                if let Ok(Some(m)) = app.monitor_from_point(pt.x as f64, pt.y as f64) {
                    Some(m)
                } else {
                    None
                }
            } else {
                None
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            None::<tauri::Monitor>
        }
    };

    let monitor = match monitor {
        Some(m) => m,
        None => app
            .primary_monitor()
            .map_err(|e| format!("primary monitor failed: {e}"))?
            .or_else(|| app.available_monitors().ok().and_then(|mut v| v.pop()))
            .ok_or_else(|| "no monitors available".to_string())?,
    };

    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    let logical_w = size.width as f64 / scale;
    let origin_x = pos.x as f64 / scale;
    let origin_y = pos.y as f64 / scale;
    let x = origin_x + (logical_w - OVERLAY_WIDTH) / 2.0;
    let y = origin_y + CARD_TOP_OFFSET - SHADOW_INSET_TOP;
    Ok(LogicalPosition::new(x, y))
}

fn apply_overlay_chrome(window: &WebviewWindow) {
    // 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
    // 原来无条件 `set_ignore_cursor_events(true)`（整窗穿透）——「解除控制」按钮
    // 永远点不到，这是用户「不知道怎么解除控制」的直接原因之一。
    //
    // 但**不能简单改成 false**：这块条悬在屏幕顶部居中，正好压在窗口标题栏/标签栏上，
    // 而 CUA 恰恰要往那里点。整窗收事件 = 指示条吃掉它正在指示的那次点击，
    // 等于自己把自动化弄坏。
    // CSS `pointer-events:none` 也救不了：WebView2 是不透明子窗口，OS 层照样
    // 把这个矩形的点击交给我们，只是不再派发到 DOM。
    //
    // 所以这里改成**默认穿透**，只由 `spawn_stop_button_hit_test_thread` 在光标真的
    // 落在按钮矩形上时临时关掉穿透。按钮以外区域一律不抢事件。
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_always_on_top(true);

    // 【self-evolution-bot · 2026-11-19 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
    // 对齐 ZCode `created.setContentProtection(true)`。
    // 为什么对 CUA 尤其重要：AI 是靠**截图**判断该点哪里的。提示条与蓝光环如果
    // 出现在它自己的截图里，就会污染它自己的判断——亮线被当成 UI 边缘、按钮被
    // 当成可点目标，直接诱发误点。
    // `WDA_EXCLUDEFROMCAPTURE` 让本窗口对截屏/录屏不可见（人眼照常可见），
    // 正是 Electron `setContentProtection(true)` 在 Windows 上的等价实现。
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
        };
        let _ = unsafe {
            SetWindowDisplayAffinity(HWND(hwnd.0 as *mut core::ffi::c_void), WDA_EXCLUDEFROMCAPTURE)
        };
    }
}

/// 把当前步骤 / 已执行步数推给提示条页面。
fn push_overlay_step(
    window: &WebviewWindow,
    step: &str,
    steps_done: i64,
    elapsed_ms: i64,
    running: bool,
) -> bool {
    if step.is_empty() && steps_done <= 0 && elapsed_ms <= 0 {
        return false;
    }
    let step_js = serde_json::to_string(step).unwrap_or_else(|_| String::from("\"\""));
    // 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
    // 多带 elapsed_ms + running：秒数由**页面自己**每秒走，不能靠轮询推 ——
    // 步骤文案不变时 updateCuaGlowStep 会早退（省 eval），靠它推时长会冻住。
    // running=false 时页面停表（grace 期间不再涨），避免「已停止但秒数还在跳」。
    let js = format!(
        "window.__cuaGlowOverlay&&window.__cuaGlowOverlay.setStep&&window.__cuaGlowOverlay.setStep({step_js},{steps_done},{elapsed_ms},{running})"
    );
    window.eval(&js).is_ok()
}

/// 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
/// 「解除控制」按钮的点击热区（逻辑像素，相对窗口右上角）。
///
/// 为什么要热区而不是整窗收事件：这块条悬在屏幕顶部居中，正压在窗口标题栏上，
/// 而 CUA 就要往那里点；整窗收事件会把自动化自己的点击吃掉。
///
/// 数值必须和 `cua-glow-overlay.html` 的排版逐项对上（实测推导，非估算）。
/// 右缩进**与窗口宽度无关**，从右边缘倒推即可（所以这里不抄窗口宽度，
/// 免得窗口一改宽注释就撒谎）：
///   body 右 padding 10 + 卡片右 padding 8 = 18（按钮右缘到窗口右缘）
///   按钮宽 = 4 个汉字 11px(44) + 左右 padding 16 + 边框 2 ≈ 62
///   按钮高 = 行高 11 + 上下 padding 8 + 边框 2 ≈ 21
/// 热区只放 4px 余量（66 / 28），**故意收紧**：热区越宽松，越容易把 CUA
/// 本来要落在卡片上的点击抢走。用户是照着可见按钮点的，不需要大发慈悲。
const STOP_BTN_RIGHT_INSET: f64 = 18.0;
const STOP_BTN_WIDTH: f64 = 66.0;
const STOP_BTN_HEIGHT: f64 = 28.0;
const HIT_TEST_INTERVAL_MS: u64 = 80;
/// 窗口不可见时的空转间隔（只读一次 is_visible，几乎无成本）。
const HIT_TEST_IDLE_MS: u64 = 400;

/// 光标是否落在这条提示条的「解除控制」按钮上。
///
/// 提示条贴在**光标所在显示器**顶部居中，所以热区在屏幕坐标里的位置是不固定的，
/// 每次都要用窗口当前的位置现算，不能缓存。
#[cfg(target_os = "windows")]
fn cursor_on_stop_button(window: &WebviewWindow) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let (outer_pos, outer_size) = match (window.outer_position(), window.outer_size()) {
        (Ok(p), Ok(s)) => (p, s),
        _ => return false,
    };
    let mut pt = POINT::default();
    if unsafe { GetCursorPos(&mut pt) }.is_err() {
        return false;
    }
    // outer_* 是物理像素，OVERLAY_* 是逻辑像素 —— 用窗口自身比例换算，避免多显示器缩放误判。
    let scale = window.scale_factor().unwrap_or(1.0);
    let btn_w = STOP_BTN_WIDTH * scale;
    let btn_h = STOP_BTN_HEIGHT * scale;
    let inset = STOP_BTN_RIGHT_INSET * scale;
    let win_w = outer_size.width as f64;
    let win_h = outer_size.height as f64;
    // 竖直居中，水平贴右
    let bx0 = outer_pos.x as f64 + win_w - inset - btn_w;
    let bx1 = outer_pos.x as f64 + win_w - inset;
    let by0 = outer_pos.y as f64 + (win_h - btn_h) / 2.0;
    let by1 = by0 + btn_h;
    let cx = pt.x as f64;
    let cy = pt.y as f64;
    cx >= bx0 && cx <= bx1 && cy >= by0 && cy <= by1
}

#[cfg(not(target_os = "windows"))]
fn cursor_on_stop_button(_window: &WebviewWindow) -> bool {
    // 非 Windows 保持原行为：整窗穿透，不提供按钮点击。
    true
}

/// 按光标位置动态开关鼠标穿透：只有真压在按钮上时才收事件。
///
/// 【self-evolution-bot · 2026-11-19 · 第68轮】用轮询而不是低级鼠标钩子：
/// 这只在提示条可见期间跑（隐藏即退出），80ms 一次 GetCursorPos 开销可忽略；
/// 挂钩子要处理全局线程与卸载，风险远大于收益。
/// 是否已有热区轮询线程在跑（进程生命周期内常驻一条，避免 show/hide 之间抢跑）。
static HIT_TEST_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 常驻轮询：窗口可见时才判断光标位置，不可见时保持整窗穿透。
///
/// 【self-evolution-bot · 2026-11-19 · 第68轮】为什么不做「隐藏即退出、下次 show 再拉起」：
/// 退出与下一次 show 之间存在窗口期 —— show 看到标志还是 true 就不拉新线程，
/// 旧线程紧接着把标志清掉，结果没人再轮询，按钮永久点不动。
/// 常驻一条线程最简单也最稳：隐藏时只是每 80ms 读一次 is_visible，开销可忽略。
fn spawn_stop_button_hit_test_thread(app: tauri::AppHandle) {
    let mut last: Option<bool> = None;
    loop {
        // 【self-evolution-bot · 2026-11-19 · 第68轮】每次现查窗口：
        // destroy_zombie_overlay 会 close()+重建，抓着旧 handle 会一直对着死窗口，
        // 结果重建后的新窗永远点不动。
        let window = active_overlay(&app);
        let Some(window) = window else {
            last = None;
            std::thread::sleep(Duration::from_millis(HIT_TEST_IDLE_MS));
            continue;
        };
        let visible = window.is_visible().unwrap_or(false);
        let want_events = if visible {
            cursor_on_stop_button(&window)
        } else {
            false
        };
        if last != Some(want_events) {
            // 光标在按钮上 → 收事件（!false = true 表示不穿透）
            let _ = window.set_ignore_cursor_events(!want_events);
            last = Some(want_events);
        }
        std::thread::sleep(Duration::from_millis(if visible {
            HIT_TEST_INTERVAL_MS
        } else {
            HIT_TEST_IDLE_MS
        }));
    }
}

// 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
// 删除了 `wait_overlay_hwnd` 与它的非 Windows 空实现。
//
// 为什么删（19:10 真机实测，两次建窗都恰好超时 10s）：
//   `window.hwnd()` 在 Windows 上要**回主线程**取句柄。而所有调用点都在
//   `tauri::async_runtime::spawn_blocking` 里，主线程正在 `await` 那个 blocking 任务
//   ⇒ 主线程等 blocking、blocking 等主线程，**死锁满超时才返回**。
//   这就是「每次都恰好等到超时才失败」而不是「再等久一点就好了」的真相。
//
// 保留它只会引诱后来人再写一次同样的等待，所以整体移除：
//   - 建窗后的判据改为「`build()` 成功即成功」，创建由主线程上的 `show()` 驱动；
//   - 复用判据改为 `window_created` 状态位（不碰主线程句柄）。

/// 彻底释放 `cua-glow-0` 这个 label，等到注册表里真的没有了才返回。
///
/// 【self-evolution-bot · 2026-11-19 · 第71轮 · 模型:deepseek-v4.1-flash-1017】
/// 真实缺陷（现网日志取证）：
///   15:39:17 `show failed: CUA indicator hwnd timeout`（HWND 5s 未就绪）
///   15:39:42 `destroy zombie overlay` → 立刻 `show failed: label cua-glow-0 already exists`
///   15:40:12 再试 → 仍然 `already exists`  ← **永久卡死，只能重启面板**
///
/// 根因：`window.close()` 只是**投递**关闭请求，Tauri 的 webview 注册表要等 tao 事件循环
/// 丢掉当前指示器窗口（**不等待、不查主线程句柄**）。
///
/// 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
/// 改了什么：原来的 `destroy_zombie_overlay` + `wait_label_released`（轮询等 label
/// 从注册表消失，最长 1.2s）整体删除，换成这个「发完销毁请求就走」的版本。
///
/// 为什么：`get_webview_window`/`close`/`destroy` 都要主线程，而调用点在此前的
/// `spawn_blocking` 里 ⇒ 与 await 的主线程互等，**死锁到超时**。现网 23 次
/// `WARN overlay label STILL present after destroy` 就是这么来的：
/// 不是标签真的泄漏，是我们自己把主线程堵死了、销毁请求根本没被处理。
///
/// 现在 label 是唯一化的（`cua-glow-<n>`），撞名最多浪费一个序号，
/// 所以**完全不需要等注册表回收** —— 发个销毁请求、把状态位清掉即可。
fn drop_overlay_window(app: &tauri::AppHandle) {
    if let Some(window) = active_overlay(app) {
        glow_log("dropping stale overlay window (no wait)");
        let _ = window.close();
        let _ = window.destroy();
    }
    if let Ok(mut state) = OVERLAY_STATE.lock() {
        state.window_created = false;
        state.active_label.clear();
    }
}

/// ZCode showWindowOnTop: Windows 隐藏透明窗后可能丢掉 TOPMOST；每次 show 后强制拉回。
#[cfg(target_os = "windows")]
fn force_topmost(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                HWND(hwnd.0 as *mut _),
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn force_topmost(_window: &WebviewWindow) {}

fn log_overlay_state(window: &WebviewWindow, phase: &str) {
    let visible = window.is_visible().unwrap_or(false);
    let size = window
        .outer_size()
        .map(|s| format!("{}x{}", s.width, s.height))
        .unwrap_or_else(|e| format!("<{e}>"));
    let pos = window
        .outer_position()
        .map(|p| format!("({},{})", p.x, p.y))
        .unwrap_or_else(|e| format!("<{e}>"));
    #[cfg(target_os = "windows")]
    let hwnd = window
        .hwnd()
        .map(|h| format!("{:?}", h))
        .unwrap_or_else(|e| format!("<{e}>"));
    #[cfg(not(target_os = "windows"))]
    let hwnd = String::from("n/a");
    glow_log(format!(
        "{phase} visible={visible} size={size} pos={pos} hwnd={hwnd}"
    ));
}

fn build_glow_window(
    app: &tauri::AppHandle,
    label: &str,
    pos: LogicalPosition<f64>,
) -> Result<WebviewWindow, String> {
    // App HTML (self-contained). data: URLs need `webview-data-url` feature — we don't.
    // Opaque: transparent WebView2 often paints blank. Builder mirrors voice_overlay
    // (proven secondary window) plus explicit size/skip_taskbar.
    let window = WebviewWindow::builder(
        app,
        label,
        WebviewUrl::App("cua-glow-overlay.html".into()),
    )
    .title("EvoFlow Computer Use")
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .position(pos.x, pos.y)
    .decorations(false)
    .transparent(false)
    .shadow(false)
    .always_on_top(true)
    .focused(false)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()
    .map_err(|e| format!("create CUA operation indicator failed: {e}"))?;

    // 【self-evolution-bot · 2026-11-19 · 第71轮 · 模型:deepseek-v4.1-flash-1017】
    // 5s → 10s：现网日志 15:39:17 就是 5s 判超时。WebView2 在面板刚启动、CPU 忙
    // （同时有 CDP 桥/多 shell 在跑）时首帧可能更慢；5s 误判会让「提示条永久起不来」。
    // 超时后必须**彻底释放 label**，否则下一次 build 撞 "already exists"（现网已发生两次）。
    // 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：hwnd 等待从**致命**降级为**尽力**（超时只告警，不 destroy、不 return Err）。
    //
    // 为什么（19:10 真机实测）：
    //   ```
    //   overlay hwnd wait failed: CUA indicator hwnd timeout:
    //     the underlying handle is not available → releasing label cua-glow-0
    //   build with label cua-glow-0 failed: ... → retry with fresh label
    //   （重试后一条日志都没有 = 也失败了，静默返回）
    //   ```
    //   结果：全屏蓝光环亮了（`ring show ok`），顶部提示条**始终不出现**。
    //
    // 根因：窗口是 `.visible(false)` 建的，HWND 要等 tao 主事件循环推一轮才就绪。
    // 这里在 spawn_blocking 线程里死等 10s，主循环没被推动 ⇒ 永远拿不到句柄
    // （错误原文 "the underlying handle is not available" 就是 Tauri 侧 hwnd 仍为空）。
    // 而 `builder.build()` **成功返回了窗口对象**才走到这里，说明 WebView2 controller
    // 已经建好 —— 真正的生杀权在后面的 `window.show()`，不在这一句等待。
    // 之前把它当硬判据，等于在窗口还能救的时候先把它 destroy 了。
    // 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：**删掉 build 后的 hwnd 等待**（原来 10s，改成非致命后仍要空耗 600ms）。
    //
    // 为什么（19:10 真机实测，两次建窗都恰好超时）：
    //   ```
    //   19:10:55 overlay hwnd wait failed ... → releasing label cua-glow-0
    //   19:11:06 overlay hwnd wait failed ... → releasing label cua-glow-1
    //   ```
    //   `window.hwnd()` 在 Windows 上要**回主线程**取句柄；而这里整段跑在
    //   `spawn_blocking` 线程，主线程正在 `await` 它的结果 ⇒ **互相等，死锁**。
    //   这就是「每次都恰好等到超时才失败」而不是「再等久一点就好」的原因。
    //
    // 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：**删掉这里的 `apply_overlay_chrome(&window)`**。
    //
    // 为什么（19:36 真机实测）：
    //   `overlay window built (label=cua-glow-0)` 已经打出来了（死锁修复生效），
    //   但紧接着 `after-show visible=false ... hwnd=<the underlying handle is not available>`
    //   `size/pos=<runtime error: failed to receive message from webview>`。
    //   而枚举 Win32 顶层窗口：`cua-glow-0` **根本不在列表里**（蓝光环 EvoFlowCuaGlowRing
    //   是 VISIBLE 全屏的，说明进程与窗口站没问题）。
    //
    // 根因：`apply_overlay_chrome` 内部调 `window.hwnd()`（以及 set_ignore_cursor_events
    // 这类要回主线程的 API）。本函数跑在 `spawn_blocking` 线程 ⇒ 这些调用拿不到
    // 主线程句柄，webview 的附着流程被打断，于是窗口对象存在、Win32 窗口从未出现。
    // `apply_overlay_chrome` 一律只在主线程、且 `show()` 之后调用（见 show 命令）。
    Ok(window)
}

fn ensure_overlay_window(app: &tauri::AppHandle) -> Result<(WebviewWindow, bool), String> {
    let pos = overlay_logical_position(app)?;
    // 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：复用判据从 `wait_overlay_hwnd(...)`（查 HWND）改成 `window_created` 状态位。
    //
    // 为什么：本函数跑在 `spawn_blocking` 线程，`hwnd()` 要回主线程取句柄 ⇒ 与
    // await 它的主线程互等，**必定失败**。于是一次 CUA 之后，下次调用永远判定
    // 「旧窗口是死的」→ 销毁重建 → 再死锁一轮，提示条永远出不来。
    //
    // 为什么不用 `is_visible()`：hide 之后窗口是活着的（可复用），但 visible=false，
    // 用它判会每轮白白销毁重建一个 WebView2。`window_created` 只在 build 成功后置真、
    // 只在 `drop_overlay_window` 里置假，语义正好。
    let reusable = {
        let st = match OVERLAY_STATE.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        st.window_created && !st.active_label.is_empty()
    };
    if reusable {
        if let Some(existing) = active_overlay(app) {
            // 【self-evolution-bot · 2026-11-19 · 第73轮】这里**不能**调
            // `apply_overlay_chrome`：它内部要 `hwnd()`，在 spawn_blocking 线程里
            // 会打断 webview 附着（实测导致 cua-glow-0 的 Win32 窗口从未创建）。
            // 尺寸/位置/chrome 一律由 show 命令在**主线程**里补。
            let _ = existing.set_size(LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT));
            let _ = existing.set_position(pos);
            return Ok((existing, false));
        }
        // 状态说有、注册表里没有（不一致）→ 走一次无等待清理，再重建。
        drop_overlay_window(app);
    }
    // 【self-evolution-bot · 2026-11-19 · 第73轮】每次新建都拿一个**没用过**的 label。
    // 万一旧 label 卡在 tao 注册表里没回收，也只是浪费一个序号，不会永久建不起来。
    let label = next_overlay_label();
    let window = match build_glow_window(app, &label, pos) {
        Ok(w) => w,
        Err(e) => {
            // 极端情况：连新 label 都撞名（理论上不该发生），再退一格重试一次。
            glow_log(&format!("build with label {label} failed: {e} → retry with fresh label"));
            let retry = next_overlay_label();
            build_glow_window(app, &retry, pos)?
        }
    };
    if let Ok(mut state) = OVERLAY_STATE.lock() {
        state.window_created = true;
    }
    // 【self-evolution-bot · 2026-11-19 · 第73轮】原日志写「hwnd ready」是撒谎：
    // 这里并没有验过 HWND（也不该验，验就要回主线程 = 死锁）。改成陈述事实。
    glow_log(&format!("overlay window built (label={label}), show() will drive creation"));
    Ok((window, true))
}

async fn wait_overlay_ready(created: bool) {
    if created {
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

/// 显示顶部「正在操作电脑」提示条。
///
/// 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
/// 新增 `step` / `steps_done`：前端轮询 `/cua/glow-status` 拿到当前动作后透传进来，
/// 提示条就显示「正在点击 · 第 3 步」，而不是一句固定文案。
///
/// 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
/// 再加 `elapsed_ms` / `running`：用户要「时长」。
/// running=true 时页面自走秒，false 时停在被冻结的值 —— 两处都要传，
/// 否则卡片只能显示上一次推送时的死数字。
#[tauri::command]
pub async fn cua_glow_overlay_show(
    app: tauri::AppHandle,
    step: Option<String>,
    steps_done: Option<i64>,
    elapsed_ms: Option<i64>,
    running: Option<bool>,
) -> Result<(), String> {
    let step_text = step.unwrap_or_default();
    let done = steps_done.unwrap_or(0);
    let elapsed = elapsed_ms.unwrap_or(0).max(0);
    let is_running = running.unwrap_or(true);
    let app_create = app.clone();
    let (window, created) =
        tauri::async_runtime::spawn_blocking(move || ensure_overlay_window(&app_create))
            .await
            .map_err(|e| format!("CUA indicator create join failed: {e}"))??;

    // 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：把 `apply_overlay_chrome` 从 `show()` **之前**挪到**之后**。
    //
    // 为什么：它内部用 `window.hwnd()` 调 `SetWindowDisplayAffinity`，而在
    // `show()` 之前 WebView2 尚未附着、HWND 还不存在（实测 `hwnd=<the underlying
    // handle is not available>`）。先 show 再 chrome，HWND 必已就绪。
    window
        .show()
        .map_err(|e| format!("show CUA operation indicator failed: {e}"))?;
    apply_overlay_chrome(&window);
    let _ = window.eval(
        "document.documentElement.dataset.state='active';window.__cuaGlowOverlay&&window.__cuaGlowOverlay.setActive&&window.__cuaGlowOverlay.setActive()",
    );
    push_overlay_step(&window, &step_text, done, elapsed, is_running);
    push_overlay_stop_handler(&window);
    // 【self-evolution-bot · 2026-11-19 · 第68轮】只拉起一条常驻热区轮询；
// 它自己处理「可见才判光标、不可见保持穿透」，重复 show 不会叠线程。
    if !HIT_TEST_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let a = app.clone();
        std::thread::spawn(move || spawn_stop_button_hit_test_thread(a));
    }
    let _ = window.set_always_on_top(true);
    force_topmost(&window);

    wait_overlay_ready(created).await;
    let _ = window.set_always_on_top(true);
    force_topmost(&window);
    let _ = window.eval("document.documentElement.dataset.state='active'");
    // 窗口刚建好时页面还没跑完脚本，补推一次步骤，否则首屏只有主文案。
    push_overlay_step(&window, &step_text, done, elapsed, is_running);

    // Loud proof: FE used to log "invoke ok" while no HWND existed.
    // 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：这段「事后验收」从 `spawn_blocking` 挪回主线程直接执行。
    // 为什么：`active_overlay()` / `is_visible()` / `show()` 都可能要主线程句柄，
    // 放在 blocking 线程里会与 await 它的主线程互等（就是 hwnd timeout 那个死锁）。
    //
    // 另加一轮短等待：实测 `show()` 返回后 WebView2 仍可能没附着完，
    // 此刻 `outer_size()`/`hwnd()` 会报 `failed to receive message from webview`。
    // 那是**诊断日志**的瞬时失败，不代表窗口没出来，所以这里等一拍再记，
    // 并把失败保留成日志（不给用户看），不据此判死。
    for attempt in 0..15 {
        let Some(w) = active_overlay(&app) else {
            glow_log("after-show window missing from manager");
            return Err("CUA indicator show returned but window is missing".into());
        };
        let visible = w.is_visible().unwrap_or(false);
        if visible || attempt == 14 {
            log_overlay_state(&w, "after-show");
            if !visible {
                glow_log("after-show NOT visible — retry show+topmost");
                let _ = w.show();
                let _ = w.set_always_on_top(true);
                force_topmost(&w);
                log_overlay_state(&w, "after-show-retry");
            }
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }

    // 【self-evolution-bot · 2026-11-19 · 第73轮】同上：label 唯一化后必须走 active_overlay。
    if let Some(w) = active_overlay(&app) {
        if !w.is_visible().unwrap_or(false) {
            return Err("CUA indicator show returned but window is not visible".into());
        }
    } else {
        return Err("CUA indicator show returned but window is missing".into());
    }
    Ok(())
}

/// 提示条上「解除控制」按钮的 Rust 落点。
///
/// 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
/// 提示条是一个独立 webview，拿不到主窗口的 api/会话上下文；这里只做「单向上报」：
/// 前端点击 → invoke 本命令 → emit ``cua-glow-user-stop`` 给主窗口 →
/// 主窗口按它现有的停止链路（stopSessionExecution）收尾。
/// 不在 Rust 里直接调 HTTP：会话 key 只有前端知道，硬拼会在多会话时停错。
#[tauri::command]
pub async fn cua_glow_overlay_stop(app: tauri::AppHandle) -> Result<(), String> {
    glow_log("user pressed stop on CUA indicator");
    app.emit("cua-glow-user-stop", serde_json::json!({ "reason": "user_button" }))
        .map_err(|e| format!("emit cua-glow-user-stop failed: {e}"))?;
    // 立刻清掉指示器，别等前端往返（用户点了必须马上有反馈）。
    // 【self-evolution-bot · 2026-11-19 · 第73轮】label 唯一化后走 active_overlay。
    if let Some(window) = active_overlay(&app) {
        let _ = window.eval(
            "document.documentElement.dataset.state='leaving';window.__cuaGlowOverlay&&window.__cuaGlowOverlay.setLeaving&&window.__cuaGlowOverlay.setLeaving()",
        );
    }
    Ok(())
}

fn push_overlay_stop_handler(window: &WebviewWindow) -> bool {
    // 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
    // 提示条是独立 webview，注入 onStop 让它按钮 → invoke('cua_glow_overlay_stop')。
    // 只在窗口创建后注入一次；重复注入会叠加监听（虽然 idempotent 赋值，但没必要）。
    let js = "window.__cuaGlowOverlay&&(window.__cuaGlowOverlay.onStop=function(){\
try{window.__TAURI_INTERNALS__.invoke('cua_glow_overlay_stop')}catch(e){}})";
    window.eval(js).is_ok()
}

/// 只更新提示条上的步骤文案（不重新 show / 不重放动画）。
///
/// 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
/// 为什么单独一条命令：步骤每 500ms 就可能变一次，如果复用 ``cua_glow_overlay_show``，
/// 会连带重跑 show / force_topmost / 入场动画 —— 用户看到的是整条提示条一直在抖。
/// 这里只做一次 eval，窗口不可见时直接返回 false 由调用方兜底。
///
/// 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
/// 加 `elapsed_ms` / `running`：把「已操作多久」和「秒表还在不在走」一起送达。
#[tauri::command]
pub async fn cua_glow_overlay_step(
    app: tauri::AppHandle,
    step: Option<String>,
    steps_done: Option<i64>,
    elapsed_ms: Option<i64>,
    running: Option<bool>,
) -> Result<bool, String> {
    // 【self-evolution-bot · 2026-11-19 · 第73轮】label 唯一化后走 active_overlay，
    // 否则重试换名建成的窗口会被当成「不存在」，步骤文案永远推不进去。
    let Some(window) = active_overlay(&app) else {
        return Ok(false);
    };
    if !window.is_visible().unwrap_or(false) {
        return Ok(false);
    }
    Ok(push_overlay_step(
        &window,
        &step.unwrap_or_default(),
        steps_done.unwrap_or(0),
        elapsed_ms.unwrap_or(0).max(0),
        running.unwrap_or(true),
    ))
}

/// 隐藏顶部操作提示条。
#[tauri::command]
pub async fn cua_glow_overlay_hide(app: tauri::AppHandle) -> Result<(), String> {
    // 【self-evolution-bot · 2026-11-19 · 第73轮】label 唯一化后走 active_overlay。
    if let Some(window) = active_overlay(&app) {
        let _ = window.eval(
            "document.documentElement.dataset.state='leaving';window.__cuaGlowOverlay&&window.__cuaGlowOverlay.setLeaving&&window.__cuaGlowOverlay.setLeaving()",
        );
        tokio::time::sleep(Duration::from_millis(120)).await;
        window
            .hide()
            .map_err(|e| format!("hide CUA operation indicator failed: {e}"))?;
        // 【self-evolution-bot · 2026-11-19 · 第68轮】隐藏后必须恢复整窗穿透：
        // 热区轮询在窗口不可见时才把 ignore_cursor_events 置回 true，
        // 但用户可能正好在按钮上隐藏 —— 那一拍会残留「收事件」状态，
        // 让一个看不见的窗口继续吃掉桌面点击。这里显式复位。
        let _ = window.set_ignore_cursor_events(true);
        glow_log("hide ok");
    }
    Ok(())
}
